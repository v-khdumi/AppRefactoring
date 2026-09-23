import {z} from "zod";
import type {PoolClient} from "pg";
import {changesetDigest,safeSnapshotPath} from "./verification-evidence";
import {currentChanges} from "./verification-service";

type File={path:string;content:string;executable?:boolean};
export interface ArtifactSnapshot {baseline:File[];candidate:File[];sourceLockfiles:File[];baselinePreparationPaths?:string[];preparationComplete?:boolean}
export const preparedFilesSchema=z.array(z.object({variant:z.enum(["baseline","candidate"]).default("candidate"),path:z.string().max(500).refine(safeSnapshotPath),content:z.string().min(1).max(2_000_000)}).strict()).min(1).max(16);
export type PreparedFile=z.infer<typeof preparedFilesSchema>[number];
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([first],[second])=>first.localeCompare(second))):item);

export function validatePreparedLocks(snapshot:ArtifactSnapshot,files:PreparedFile[]){
  preparedFilesSchema.parse(files);
  if(new Set(files.map(file=>`${file.variant}:${file.path}`)).size!==files.length)throw new Error("Duplicate prepared artifact paths.");
  for(const file of files){
    if(/(^|\/)(go\.sum|go\.mod|composer\.lock)$/.test(file.path)){
      if(file.variant==="baseline")throw new Error("Baseline dependency files cannot be replaced by prepared artifacts.");
      const manifestPath=file.path.replace(/(go\.sum|go\.mod)$/,"go.mod").replace(/composer\.lock$/,"composer.json");
      if(!snapshot.candidate.some(candidate=>candidate.path===manifestPath))throw new Error(`Prepared dependency file has no candidate manifest: ${file.path}`);
      if(file.path.endsWith("go.sum")&&!file.content.split("\n").every(line=>!line.trim()||/^\S+ \S+ h1:[A-Za-z0-9+/=]+$/.test(line.trim())))throw new Error("Prepared go.sum is not in checksum format.");
      if(file.path.endsWith("go.mod")&&!/^module\s+\S+/m.test(file.content))throw new Error("Prepared go.mod has no module declaration.");
      if(file.path.endsWith("composer.lock")){
        const lock=JSON.parse(file.content);
        if(typeof lock["content-hash"]!=="string"||!Array.isArray(lock.packages)||!Array.isArray(lock["packages-dev"]))throw new Error("A complete Composer lockfile is required.");
      }
      if(snapshot.preparationComplete&&snapshot.candidate.find(candidate=>candidate.path===file.path)?.content!==Buffer.from(file.content).toString("base64"))throw new Error("Artifact preparation already completed for this job.");
      continue;
    }
    if(!/(^|\/)package-lock\.json$/.test(file.path))throw new Error("Only package-manager-generated package-lock.json, go.mod, go.sum and composer.lock artifacts are permitted.");
    const manifestPath=file.path.replace(/package-lock\.json$/,"package.json");
    if(file.variant==="baseline"&&!snapshot.baselinePreparationPaths?.includes(file.path))throw new Error("Baseline runtime locks cannot be replaced by candidate artifacts.");
    const source=snapshot[file.variant||"candidate"].find(candidate=>candidate.path===manifestPath);
    if(!source)throw new Error(`Prepared lockfile has no candidate manifest: ${file.path}`);
    const manifest=JSON.parse(Buffer.from(source.content,"base64").toString("utf8"));
    const lock=JSON.parse(file.content);
    if(![2,3].includes(lock.lockfileVersion)||!lock.packages?.[""])throw new Error("A complete npm v2/v3 lockfile is required.");
    const root=lock.packages[""];
    for(const key of ["dependencies","devDependencies","optionalDependencies"]){
      if(canonical(root[key]||{})!==canonical(manifest[key]||{}))throw new Error(`Prepared lockfile does not match manifest ${key}: ${file.path}`);
    }
    if(manifest.name&&lock.name!==manifest.name)throw new Error("Lockfile package name mismatch.");
    if(file.variant==="baseline"){
      const original=snapshot.sourceLockfiles.find(source=>source.path===file.path);
      if(!original)throw new Error("Baseline lock preparation requires the original source lockfile.");
      const originalLock=JSON.parse(Buffer.from(original.content,"base64").toString("utf8"));
      if(!originalLock.packages)throw new Error("Automatic baseline tooling requires an npm v2/v3 lockfile.");
      for(const [packagePath,entry] of Object.entries(originalLock.packages)){
        if(!packagePath||!entry||typeof entry!=="object")continue;
        const previous=entry as Record<string,unknown>;
        if(previous.dev===true)continue;
        const next=lock.packages[packagePath];
        if(!next||["version","resolved","integrity","link"].some(key=>canonical(previous[key]??null)!==canonical(next[key]??null)))throw new Error(`Baseline test tooling must preserve locked runtime package: ${packagePath}`);
      }
    }
    if(snapshot.preparationComplete&&snapshot[file.variant||"candidate"].find(candidate=>candidate.path===file.path)?.content!==Buffer.from(file.content).toString("base64"))throw new Error("Artifact preparation already completed for this job.");
  }
}

export async function acceptPreparedLocks(client:Pick<PoolClient,"query">,job:{id:string;run_id:string;tenant_id:string},files:PreparedFile[]){
  const runResult=await client.query<{source_commit_sha:string;status:string}>("SELECT source_commit_sha,status FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[job.run_id,job.tenant_id]);
  const jobs=await client.query<{status:string;snapshot:ArtifactSnapshot;source_sha:string;changeset_digest:string;report?:{steps?:unknown[]}}>("SELECT status,snapshot,source_sha,changeset_digest,report FROM verification_jobs WHERE id=$1 AND run_id=$2 AND tenant_id=$3 AND expires_at>now() FOR UPDATE",[job.id,job.run_id,job.tenant_id]);
  const run=runResult.rows[0];const current=jobs.rows[0];
  if(!run||!current||!["blocked","failed","awaiting-approval"].includes(run.status)||!["preparing","running"].includes(current.status)||!current.snapshot?.sourceLockfiles)throw new Error("Artifact preparation is unavailable for this run or job.");
  if(current.report?.steps?.length)throw new Error("Dependency artifacts cannot change after verification commands have started.");
  const existing=await currentChanges(client,job.run_id);
  if(run.source_commit_sha!==current.source_sha||changesetDigest(current.source_sha,existing)!==current.changeset_digest)throw new Error("Changeset changed during dependency preparation.");
  validatePreparedLocks(current.snapshot,files);
  if(current.snapshot.preparationComplete)return {recorded:true,changesetDigest:current.changeset_digest};
  for(const file of files){
    const snapshotFile={path:file.path,content:Buffer.from(file.content).toString("base64"),executable:false};
    if(file.variant==="baseline"){
      current.snapshot.baseline=current.snapshot.baseline.filter(source=>source.path!==file.path).concat(snapshotFile);
      continue;
    }
    const before=current.snapshot.sourceLockfiles.find(source=>source.path===file.path);
    const content=before?Buffer.from(before.content,"base64").toString("utf8"):"";
    await client.query("INSERT INTO transformation_changes(run_id,path,operation,area,rationale,before_content,after_content,additions,deletions,validation,agent_type,user_modified) VALUES($1,$2,$3,'platform',$4,$5,$6,$7,$8,'[]'::jsonb,'testing',true) ON CONFLICT(run_id,path) DO UPDATE SET operation=EXCLUDED.operation,before_content=EXCLUDED.before_content,after_content=EXCLUDED.after_content,rationale=EXCLUDED.rationale,additions=EXCLUDED.additions,deletions=EXCLUDED.deletions,validation='[]'::jsonb,user_modified=true",[job.run_id,file.path,before?"modified":"added","Generated by the package manager (npm, Go or Composer) in the isolated preparation job. Included in the changeset for human review.",content,file.content,file.content.split("\n").length,content?content.split("\n").length:0]);
    current.snapshot.candidate=current.snapshot.candidate.filter(candidate=>candidate.path!==file.path).concat(snapshotFile);
  }
  current.snapshot.preparationComplete=true;
  const digest=changesetDigest(current.source_sha,await currentChanges(client,job.run_id));
  await client.query("UPDATE transformation_changes SET validation='[]'::jsonb WHERE run_id=$1",[job.run_id]);
  await client.query("UPDATE verification_jobs SET status='stale' WHERE run_id=$1 AND id<>$2 AND status='passed'",[job.run_id,job.id]);
  await client.query("UPDATE verification_jobs SET snapshot=$2::jsonb,changeset_digest=$3,updated_at=now() WHERE id=$1",[job.id,JSON.stringify(current.snapshot),digest]);
  await client.query("UPDATE modernization_runs SET status='blocked',current_stage='verification-required',version=version+1,updated_at=now() WHERE id=$1 AND tenant_id=$2",[job.run_id,job.tenant_id]);
  await client.query("INSERT INTO audit_events(tenant_id,actor_id,actor_name,action,resource_type,resource_id,data) VALUES($1,'verification-runner','Isolated dependency preparation','verification.dependencies.prepared','run',$2,$3::jsonb)",[job.tenant_id,job.run_id,JSON.stringify({jobId:job.id,digest,files:files.map(file=>({path:file.path,variant:file.variant}))})]);
  return {recorded:true,changesetDigest:digest};
}