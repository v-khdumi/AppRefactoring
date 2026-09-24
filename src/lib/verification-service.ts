import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ManagedIdentityCredential } from "@azure/identity";
import type { PoolClient } from "pg";
import { query, transaction } from "./db";
import { env } from "./env";
import { readVerificationSnapshot } from "./github-app";
import { changesetDigest, safeSnapshotPath, reportPassed, type VerificationChange, type VerificationReport } from "./verification-evidence";
import { verificationDescription } from "./verification-status";
import { applyBaselineTestHarness } from "./baseline-test-harness";
import { requiresWindowsVerifier } from "./verification-ecosystems";

export const windowsVerifierImage="mcr.microsoft.com/dotnet/framework/sdk@sha256:a78c7a33d5a6ec45c5c05dc78461f4c0797eef4ee44a71ec67f988fe91834b19";
const windowsBootstrap="$ProgressPreference='SilentlyContinue';[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;New-Item -ItemType Directory C:\\modernize -Force|Out-Null;Invoke-WebRequest -UseBasicParsing -Uri ($env:VERIFICATION_ENDPOINT+'?script=windows') -Headers @{Authorization='Bearer '+$env:VERIFICATION_TOKEN} -OutFile C:\\modernize\\supervisor.ps1;& C:\\modernize\\supervisor.ps1";
export function windowsContainerGroupId(jobId:string){
  const group=env.VERIFICATION_JOB_RESOURCE_ID?.match(/^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+)\//i)?.[1];
  if(!group)throw new Error("The verification resource group is not configured.");
  return `${group}/providers/Microsoft.ContainerInstance/containerGroups/mz-winverify-${jobId.replace(/-/g,"").slice(0,24)}`;
}
async function managementToken(){return (await new ManagedIdentityCredential().getToken("https://management.azure.com/.default")).token;}
async function dispatchWindowsVerification(prepared:{id:string;token:string}){
  const access=await managementToken();
  const job=await fetch(`https://management.azure.com${env.VERIFICATION_JOB_RESOURCE_ID}?api-version=2024-03-01`,{headers:{Authorization:`Bearer ${access}`},signal:AbortSignal.timeout(60000)});
  if(!job.ok)throw new Error(`Verification location lookup failed (${job.status}).`);
  const location=((await job.json()) as {location:string}).location;
  const response=await fetch(`https://management.azure.com${windowsContainerGroupId(prepared.id)}?api-version=2023-05-01`,{method:"PUT",headers:{Authorization:`Bearer ${access}`,"Content-Type":"application/json"},signal:AbortSignal.timeout(60000),body:JSON.stringify({location,tags:{"modernize-verification":prepared.id},properties:{osType:"Windows",restartPolicy:"Never",containers:[{name:"verifier",properties:{image:windowsVerifierImage,resources:{requests:{cpu:4,memoryInGB:8}},command:["powershell.exe","-NoProfile","-ExecutionPolicy","Bypass","-Command",windowsBootstrap],environmentVariables:[{name:"VERIFICATION_ENDPOINT",value:`${env.VERIFICATION_PUBLIC_ORIGIN}/api/verification-jobs/${prepared.id}`},{name:"VERIFICATION_TOKEN",secureValue:prepared.token}]}}]}})});
  if(!response.ok)throw new Error(`Windows verifier dispatch failed (${response.status}).`);
}
export async function deleteWindowsVerifier(jobId:string){
  const response=await fetch(`https://management.azure.com${windowsContainerGroupId(jobId)}?api-version=2023-05-01`,{method:"DELETE",headers:{Authorization:`Bearer ${await managementToken()}`},signal:AbortSignal.timeout(60000)});
  if(!response.ok&&response.status!==404&&response.status!==204)throw new Error(`Windows verifier cleanup failed (${response.status}).`);
}
export async function cleanupWindowsVerifiers(){
  const group=env.VERIFICATION_JOB_RESOURCE_ID?.match(/^(\/subscriptions\/[^/]+\/resourceGroups\/[^/]+)\//i)?.[1];
  if(!group)return;
  const response=await fetch(`https://management.azure.com${group}/providers/Microsoft.ContainerInstance/containerGroups?api-version=2023-05-01`,{headers:{Authorization:`Bearer ${await managementToken()}`},signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw new Error(`Windows verifier inventory failed (${response.status}).`);
  const groups=((await response.json()) as {value?:Array<{name:string;tags?:Record<string,string>}>}).value||[];
  for(const item of groups){
    const jobId=item.tags?.["modernize-verification"];
    if(!jobId||!/^[0-9a-f-]{36}$/i.test(jobId)||item.name!==windowsContainerGroupId(jobId).split("/").pop())continue;
    const active=await query("SELECT 1 FROM verification_jobs WHERE id=$1 AND status IN ('preparing','running') AND expires_at>now()",[jobId]);
    if(!active.rowCount)await deleteWindowsVerifier(jobId).catch(error=>console.error("Windows verifier cleanup failed",error instanceof Error?error.message:error));
  }
}

export async function currentChanges(client:Pick<PoolClient,"query">,runId:string) {
  const result=await client.query<{path:string;old_path:string|null;operation:string;after_content:string|null}>("SELECT path,old_path,operation,after_content FROM transformation_changes WHERE run_id=$1 ORDER BY path",[runId]);
  return result.rows.map(row=>({path:row.path,oldPath:row.old_path,operation:row.operation,content:row.after_content||""}));
}

export async function verifiedChangeset(client:Pick<PoolClient,"query">,runId:string,tenantId:string,sourceSha:string) {
  const changes=await currentChanges(client,runId);
  if(!changes.length)return false;
  const digest=changesetDigest(sourceSha,changes);
  const evidence=await client.query<{status:string;report:VerificationReport}>("SELECT status,report FROM verification_jobs WHERE run_id=$1 AND tenant_id=$2 AND source_sha=$3 AND changeset_digest=$4 ORDER BY created_at DESC LIMIT 1",[runId,tenantId,sourceSha,digest]);
  return Boolean(evidence.rows[0]?.status==="passed"&&evidence.rows[0]?.report&&reportPassed(evidence.rows[0].report));
}

export async function prepareVerification(runId:string,tenantId:string) {
  if(!env.VERIFICATION_JOB_RESOURCE_ID||!env.VERIFICATION_PUBLIC_ORIGIN)throw new Error("The isolated verification job is not configured.");
  const token=randomBytes(32).toString("hex");const id=randomUUID();
  const record=await transaction(async client=>{
    const runs=await client.query<{source_commit_sha:string;repository_url:string;status:string}>("SELECT source_commit_sha,repository_url,status FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[runId,tenantId]);
    const run=runs.rows[0];
    if(!run)throw new Error("Run not found.");
    if(!["blocked","awaiting-approval","failed"].includes(run.status))throw new Error("Generation must stop before verification can start.");
    const active=await client.query("SELECT 1 FROM agent_tasks WHERE run_id=$1 AND status IN ('running','retrying')",[runId]);
    if(active.rowCount)throw new Error("An agent is still running. Wait for generation to finish.");
    if(!run.source_commit_sha)throw new Error("No pinned source commit is recorded.");
    const changes=await currentChanges(client,runId);
    if(!changes.length)throw new Error("There are no generated changes to verify.");
    await client.query("UPDATE verification_jobs SET status='failed',error='Verification deadline exceeded',snapshot=NULL WHERE run_id=$1 AND status IN ('preparing','running') AND expires_at<now()",[runId]);
    const existing=await client.query("SELECT 1 FROM verification_jobs WHERE run_id=$1 AND status IN ('preparing','running')",[runId]);
    if(existing.rowCount)throw new Error("Verification is already in progress.");
    await client.query("INSERT INTO verification_jobs(id,run_id,tenant_id,source_sha,changeset_digest,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '75 minutes')",[id,runId,tenantId,run.source_commit_sha,changesetDigest(run.source_commit_sha,changes),createHash("sha256").update(token).digest("hex")]);
    return {...run,changes};
  });
  return {id,token,...record};
}

export function applyVerificationChanges(baseline:Array<{path:string;content:string;executable:boolean}>,changes:VerificationChange[]) {
  const files=new Map(baseline.map(file=>[file.path,{...file}]));
  for(const change of changes){
    if(!safeSnapshotPath(change.path))throw new Error("Unsafe generated path.");
    if(change.operation==="deleted"){if(!files.delete(change.path))throw new Error(`Deleted source missing: ${change.path}`);continue;}
    if(change.operation==="renamed"){
      if(!change.oldPath||!safeSnapshotPath(change.oldPath)||!files.delete(change.oldPath))throw new Error("Renamed source missing.");
    }
    if(change.operation==="modified"&&!files.has(change.path))throw new Error(`Modified source missing: ${change.path}`);
    if(change.operation==="added"&&files.has(change.path))throw new Error(`Added file already exists: ${change.path}`);
    files.set(change.path,{path:change.path,content:Buffer.from(change.content).toString("base64"),executable:files.get(change.path)?.executable||false});
  }
  return [...files.values()];
}

export async function dispatchVerification(prepared:Awaited<ReturnType<typeof prepareVerification>>) {
  const match=prepared.repository_url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i);
  if(!match)throw new Error("Invalid repository URL.");
  try{
    const source=await readVerificationSnapshot(match[1],match[2],prepared.source_commit_sha);
    const candidate=applyVerificationChanges(source,prepared.changes);
    const baseline=applyBaselineTestHarness(source,candidate);
    const baselinePreparationPaths=baseline.filter(file=>/(^|\/)package\.json$/.test(file.path)&&source.find(original=>original.path===file.path)?.content!==file.content).map(file=>file.path.replace(/package\.json$/,"package-lock.json"));
    const windows=requiresWindowsVerifier(baseline)||requiresWindowsVerifier(candidate);
    const claimed=await query("UPDATE verification_jobs SET snapshot=$2::jsonb,status='running',updated_at=now() WHERE id=$1 AND status='preparing' AND expires_at>now() RETURNING id",[prepared.id,JSON.stringify({baseline,candidate,baselinePreparationPaths,windows,sourceLockfiles:source.filter(file=>/(^|\/)(package-lock\.json|go\.mod|go\.sum|composer\.lock)$/.test(file.path))})]);
    if(!claimed.rowCount)return;
    if(windows){await dispatchWindowsVerification(prepared);return;}
    const credential=new ManagedIdentityCredential();
    const access=await credential.getToken("https://management.azure.com/.default");
    const response=await fetch(`https://management.azure.com${env.VERIFICATION_JOB_RESOURCE_ID}/start?api-version=2024-03-01`,{
      method:"POST",headers:{Authorization:`Bearer ${access.token}`,"Content-Type":"application/json"},signal:AbortSignal.timeout(60000),
      body:JSON.stringify({containers:[{name:"runner",image:"node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9",resources:{cpu:2,memory:"4Gi"},command:["node","-e",`(async()=>{const r=await fetch(process.env.VERIFICATION_ENDPOINT+'?script=1',{headers:{Authorization:'Bearer '+process.env.VERIFICATION_TOKEN}});if(!r.ok)throw Error('Supervisor download failed');require('fs').writeFileSync('/tmp/verification-runner.mjs',await r.text(),{mode:0o600});await import('file:///tmp/verification-runner.mjs')})().catch(e=>{console.error(e.message);process.exit(1)})`],env:[{name:"VERIFICATION_ENDPOINT",value:`${env.VERIFICATION_PUBLIC_ORIGIN}/api/verification-jobs/${prepared.id}`},{name:"VERIFICATION_TOKEN",value:prepared.token}]}]}),
    });
    if(!response.ok)throw new Error(`Azure job dispatch failed (${response.status}).`);
  }catch(error){await query("UPDATE verification_jobs SET status='failed',error=$2,snapshot=NULL,updated_at=now() WHERE id=$1 AND status IN ('preparing','running') AND report IS NULL",[prepared.id,error instanceof Error?error.message:"Verification dispatch failed"]);throw error;}
}

export async function recoverVerificationDispatches(){
  const stalled=await query<{id:string;run_id:string;tenant_id:string}>("SELECT v.id,v.run_id,v.tenant_id FROM verification_jobs v JOIN modernization_runs r ON r.id=v.run_id AND r.tenant_id=v.tenant_id WHERE r.status IN ('blocked','failed','awaiting-approval') AND v.status IN ('preparing','running') AND v.report IS NULL AND v.updated_at<now()-interval '10 minutes' AND (SELECT count(*) FROM verification_jobs recent WHERE recent.run_id=v.run_id AND recent.error='DispatchUnconfirmed' AND recent.created_at>now()-interval '1 hour')<3 ORDER BY v.created_at LIMIT 5");
  for(const job of stalled.rows){
    const recover=await transaction(async client=>{
      const run=await client.query("SELECT id FROM modernization_runs WHERE id=$1 AND tenant_id=$2 AND status IN ('blocked','failed','awaiting-approval') FOR UPDATE",[job.run_id,job.tenant_id]);
      if(!run.rowCount)return false;
      const expired=await client.query("UPDATE verification_jobs SET status='failed',error='DispatchUnconfirmed',snapshot=NULL,updated_at=now() WHERE id=$1 AND status IN ('preparing','running') AND report IS NULL AND updated_at<now()-interval '10 minutes' RETURNING id",[job.id]);
      if(!expired.rowCount)return false;
      await client.query("INSERT INTO audit_events(tenant_id,actor_id,actor_name,action,resource_type,resource_id,data) VALUES($1,'worker-recovery','Verification recovery','verification.dispatch.recovered','run',$2,$3::jsonb)",[job.tenant_id,job.run_id,JSON.stringify({previousJobId:job.id})]);
      return true;
    });
    if(recover)await dispatchVerification(await prepareVerification(job.run_id,job.tenant_id));
  }
}

export async function verificationState(runId:string,tenantId:string,sourceSha:string) {
  const result=await query<{id:string;status:string;report:VerificationReport|null;error:string|null;changeset_digest:string;source_sha:string;updated_at:string;expires_at:string}>("SELECT id,status,report,error,changeset_digest,source_sha,updated_at,expires_at FROM verification_jobs WHERE run_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 1",[runId,tenantId]);
  const job=result.rows[0];
  if(!job)return {status:"not-executed",reason:"No executed verification exists for this changeset.",steps:[]};
  const changes=await currentChanges({query} as Pick<PoolClient,"query">,runId);
  const matches=job.source_sha===sourceSha&&job.changeset_digest===changesetDigest(sourceSha,changes);
  const expired=["preparing","running"].includes(job.status)&&Date.parse(job.expires_at)<Date.now();
  const status=!matches?"stale":expired?"failed":job.status==="passed"&&(!job.report||!reportPassed(job.report))?"failed":job.status;
  return {id:job.id,status,changesetDigest:job.changeset_digest,reason:!matches?"Changes have changed since verification. Run verification again.":expired?"Verification exceeded its time limit.":verificationDescription(status,job.report?.reason,job.error),steps:job.report?.steps||[],updatedAt:job.updated_at};
}