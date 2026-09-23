import { ServiceBusClient, type ServiceBusReceivedMessage } from "@azure/service-bus";
import {randomUUID} from "node:crypto";
import { ManagedIdentityCredential } from "@azure/identity";
import { env, serviceBusNamespace } from "../src/lib/env";
import { database, transaction } from "../src/lib/db";
import { readInstalledRepository,readInstalledFile,readVerificationSnapshot } from "../src/lib/github-app";
import { generateTransformationPlan,InvalidGeneratedPlanError } from "../src/lib/transformation-engine";
import {repositoryEvidence,dependencyLock} from "../src/lib/repository-evidence";
import type {ModernizationScope} from "../src/types/modernization";
import type { AgentType } from "../src/types/modernization";
import { logEvent } from "../src/lib/structured-log";
import {AgentOwnershipError} from "../src/lib/agent-policy";
import {coordinatedGeneration,generationSequence,type GeneratedChange} from "../src/lib/generation-workflow";
import {readVerificationReadiness,VerificationReadinessError} from "../src/lib/verification-readiness";
import {withRunLock,requireActiveRun,RunInterruptedError} from "../src/lib/run-coordination";
import { processAndSettle } from "../src/lib/message-processing";
import { validationExecution } from "../src/lib/validation-execution";
import { prepareVerification, dispatchVerification,recoverVerificationDispatches } from "../src/lib/verification-service";

type Run={id:string;repository_url:string;source_branch:string;source_commit_sha:string|null;scope:ModernizationScope;options:Record<string,unknown>;status:string};
type RunIdentity={id:string;tenantId:string;token:string};
class RunPreconditionError extends Error{}
const objectives:Record<AgentType,string>={architect:"Define shared implementation contracts and architecture decisions before implementation.",backend:"Implement backend contracts while preserving domain and data behavior.",frontend:"Integrate the frontend with the actual accepted backend contract and implementation.",cloud:"Prepare scoped deployment artifacts for the implemented candidate; never deploy automatically.",security:"Review the assembled candidate and preserve behavior while fixing security defects.",testing:"Add executable baseline characterization and candidate integration tests for the assembled projects; wire their real build/test scripts."};

async function processRun(message: ServiceBusReceivedMessage) {
  const body = message.body as { runId?: string; tenantId?: string; agentType?:AgentType; instruction?:string;recovery?:boolean };
  if (!body.runId || !body.tenantId) throw new Error("Invalid modernization message.");
  const identity:RunIdentity={id:body.runId,tenantId:body.tenantId,token:randomUUID()};
  await withRunLock(database(),identity.id,identity.tenantId,async()=>{
    const timer=setInterval(()=>void database().query("UPDATE modernization_runs SET last_heartbeat_at=now() WHERE id=$1 AND tenant_id=$2 AND status='running' AND options->>'workerToken'=$3",[identity.id,identity.tenantId,identity.token]).catch(error=>logEvent("warn","run.heartbeat_failed",{runId:identity.id,error})),30000);timer.unref();
    try{await processLockedRun(body,identity,message);}
    catch(error){
      if(error instanceof RunInterruptedError){logEvent("info","transformation.interrupted",{runId:identity.id});return;}
      const permanent=error instanceof VerificationReadinessError||error instanceof AgentOwnershipError||error instanceof InvalidGeneratedPlanError||error instanceof RunPreconditionError;
      await transaction(async client=>{
        const failed=await client.query("UPDATE modernization_runs SET status=CASE WHEN $4 OR COALESCE((options->>'executionAttempts')::int,0)>=4 THEN 'failed' ELSE 'retrying' END,current_stage='generation-failed',error_code=$5,error_detail=$6,updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 AND status='running' AND options->>'workerToken'=$3 RETURNING id",[identity.id,identity.tenantId,identity.token,permanent,error instanceof Error?error.name:"GenerationError",error instanceof Error?error.message.slice(0,4000):"Generation failed"]);
        if(failed.rowCount)await client.query("UPDATE agent_tasks SET status='blocked',error=COALESCE(error,$2),completed_at=now() WHERE run_id=$1 AND status IN ('queued','running','retrying')",[identity.id,error instanceof Error?error.message.slice(0,4000):"Generation failed"]);
      });
      throw error;
    }finally{clearInterval(timer);}
  });
}

async function processLockedRun(body:{agentType?:AgentType;recovery?:boolean},identity:RunIdentity,message:ServiceBusReceivedMessage){
  const result=await transaction(async client => {
    if(body.recovery)await client.query("UPDATE modernization_runs SET status='retrying',current_stage='stale-run-recovery',updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 AND status='running' AND last_heartbeat_at<now()-interval '45 minutes'",[identity.id,identity.tenantId]);
    const claimed=await client.query<Run>(`UPDATE modernization_runs SET status='running',progress=5,current_stage='worker-claimed',started_at=now(),last_heartbeat_at=now(),error_code=NULL,error_detail=NULL,options=options || jsonb_build_object('workerToken',$3::text,'executionAttempts',COALESCE((options->>'executionAttempts')::int,0)+1),updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 AND status IN ('queued','retrying') AND ($4::boolean=false OR options ? 'pendingRefinement') RETURNING id,repository_url,source_branch,source_commit_sha,scope,options,status`,[identity.id,identity.tenantId,identity.token,Boolean(body.agentType)]);
    if (claimed.rowCount&&!claimed.rows[0].options.pendingRefinement) await client.query("UPDATE agent_tasks SET status='queued',progress=0,started_at=NULL,completed_at=NULL,error=NULL,summary=NULL,files_owned='[]'::jsonb,output_text='',output_updated_at=NULL,input_paths='[]'::jsonb WHERE run_id=$1",[identity.id]);
    return claimed;
  });
  if(!result.rowCount){logEvent("info","transformation.skipped",{runId:identity.id,reason:"already-claimed-or-terminal"});return;}
  const run = result.rows[0];
  logEvent("info","transformation.started",{runId:run.id,tenantId:identity.tenantId,correlationId:message.correlationId||message.messageId});
  const match = run.repository_url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i);
  if (!match) throw new RunPreconditionError("Invalid GitHub repository URL.");
  const [, owner, repo] = match;

  await updateRun(identity,10,"repository-inventory");
  const repository = await readInstalledRepository(owner, repo, run.source_branch);
  const analyzed=run.options.architectureAnalysis as {sourceCommitSha?:string}|undefined;
  const expected=run.source_commit_sha||run.options.sourceCommitSha||analyzed?.sourceCommitSha;
  if(expected&&expected!==repository.sourceSha)throw new RunPreconditionError("Source changed since analysis. A new analysis and review are required before generation.");
  await readVerificationReadiness(repository.files,path=>readInstalledFile(owner,repo,path,repository.sourceSha,repository.token),{scope:run.scope,backendTarget:typeof run.options.backendTarget==="string"?run.options.backendTarget:undefined});
  await database().query("UPDATE modernization_runs SET source_commit_sha=$1 WHERE id=$2 AND tenant_id=$3 AND status='running' AND options->>'workerToken'=$4",[repository.sourceSha,run.id,identity.tenantId,identity.token]);
  const snapshot=await readVerificationSnapshot(owner,repo,repository.sourceSha);
  const source=snapshot.filter(file=>!dependencyLock.test(file.path)).flatMap(file=>{
    const content=Buffer.from(file.content,"base64");
    if(content.includes(0))return [];
    try{return [{path:file.path,content:new TextDecoder("utf-8",{fatal:true}).decode(content)}];}catch{return [];}
  });
  if(source.reduce((bytes,file)=>bytes+Buffer.byteLength(file.content),0)>1_000_000)throw new RunPreconditionError("Complete text context exceeds the 1 MB generation limit. Select a smaller application boundary; no source files were silently omitted.");
  const dependencyEvidence=repositoryEvidence(repository.files.map(file=>file.path),source,run.scope);
  const pending=run.options.pendingRefinement as {agentType:AgentType;instruction:string}|undefined;
  const initialChanges:Array<{agent:AgentType;change:GeneratedChange}>=[];
  if(pending){
    const existing=await database().query("SELECT path,old_path,operation,area,rationale,before_content,after_content,agent_type FROM transformation_changes WHERE run_id=$1",[run.id]);
    for(const file of existing.rows){
      if(file.operation==="renamed")throw new RunPreconditionError("Refinement of a renamed source requires a new reviewed changeset.");
      initialChanges.push({agent:file.agent_type||"security",change:{path:file.path,oldPath:file.old_path||undefined,status:file.operation,area:file.area,rationale:file.rationale,before:file.before_content||"",after:file.after_content||"",validation:[]}});
    }
  }
  const stages=pending?[...new Set<AgentType>([pending.agentType,...(pending.agentType!=="testing"?["security" as const]:[]),"testing"])]:generationSequence(run.scope,run.options.cloudReady===true);
  await transaction(async client=>{
    await requireActiveRun(client,run.id,identity.tenantId,identity.token);
    for(const agent of stages)await client.query("INSERT INTO agent_tasks(run_id,agent_type,status,progress,objective) VALUES($1,$2,'queued',0,$3) ON CONFLICT(run_id,agent_type) DO UPDATE SET status='queued',progress=0,objective=EXCLUDED.objective,error=NULL",[run.id,agent,objectives[agent]]);
    if(!pending)await client.query("UPDATE agent_tasks SET status='cancelled',summary='Outside the selected scope or disabled cloud work.',progress=0 WHERE run_id=$1 AND NOT(agent_type=ANY($2::text[]))",[run.id,stages]);
  });
  let completed=0;
  const generated=await coordinatedGeneration({source,scope:run.scope,cloudReady:run.options.cloudReady===true,initialChanges,stages,
    assertActive:()=>requireActiveRun(database(),run.id,identity.tenantId,identity.token),
    generate:async context=>{
      await updateRun(identity,Math.min(70,30+completed*7),`coordinated-agent-${context.agent}`);
      await startAgentOutput(identity,context.agent,context.files.map(file=>file.path));
      return generateTransformationPlan({repository:`${owner}/${repo}`,scope:run.scope,files:context.files,options:{...run.options,architectureAnalysis:undefined,workerToken:undefined,pendingRefinement:undefined,agentType:context.agent,agentObjective:objectives[context.agent],instruction:pending?.agentType===context.agent?pending.instruction:undefined,dependencyEvidence,coordinationContract:context.contract,precedingAgents:context.preceding,requireCoordinationContract:context.agent==="architect"}},output=>saveAgentOutput(identity,context.agent,output));
    },
    onAccepted:async(agent,plan)=>{
      completed++;
      await database().query("UPDATE agent_tasks SET status='passed',error=NULL,progress=100,summary=$1,files_owned=$2::jsonb,completed_at=now() WHERE run_id=$3 AND agent_type=$4 AND EXISTS(SELECT 1 FROM modernization_runs r WHERE r.id=$3 AND r.tenant_id=$5 AND r.status='running' AND r.options->>'workerToken'=$6)",[plan.summary,JSON.stringify(plan.changes.map(change=>change.path)),run.id,agent,identity.tenantId,identity.token]);
    },
  });
  await updateRun(identity,75,"persisting-changes");

  await transaction(async (client) => {
    await client.query("SELECT id FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[run.id,identity.tenantId]);
    await requireActiveRun(client,run.id,identity.tenantId,identity.token);
    await client.query("DELETE FROM transformation_changes WHERE run_id=$1", [run.id]);
    for (const {agent,change} of generated.changes) {
      await client.query(
        `INSERT INTO transformation_changes (run_id,path,old_path,operation,area,additions,deletions,rationale,before_content,after_content,validation,agent_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
        [run.id, change.path, change.oldPath, change.status, change.area, countAdded(change.before, change.after), countAdded(change.after, change.before), change.rationale, change.before, change.after, "[]",agent],
      );
    }
    await client.query("UPDATE modernization_runs SET status='blocked',progress=75,current_stage='verification-required',error_code='VerificationNotExecuted',error_detail=$3,options=(options-'pendingRefinement') || $4::jsonb,updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2", [run.id,identity.tenantId,validationExecution.reason,JSON.stringify({coordinationContract:generated.contract,dependencyEvidence,executionAttempts:0})]);
    await client.query("INSERT INTO audit_events (tenant_id,actor_id,actor_name,action,resource_type,resource_id,data) VALUES ($1,'multi-agent-orchestrator','Multi-Agent Orchestrator','transformation.generated','run',$2,$3::jsonb)", [identity.tenantId, run.id, JSON.stringify({ agents:generated.agents.map(plan=>plan.agent), changes:generated.changes.length,contractVersion:generated.contract.version })]);
  });
  logEvent("info","transformation.verification_required",{runId:run.id,tenantId:identity.tenantId,agents:generated.agents.length,changes:generated.changes.length});
  await startVerification(run.id,identity.tenantId);
}

async function updateRun(run:RunIdentity,progress:number,stage:string){
  const result=await database().query("UPDATE modernization_runs SET progress=$1,current_stage=$2,last_heartbeat_at=now(),updated_at=now(),version=version+1 WHERE id=$3 AND tenant_id=$4 AND status='running' AND options->>'workerToken'=$5",[progress,stage,run.id,run.tenantId,run.token]);
  if(!result.rowCount)throw new RunInterruptedError();
}

async function startVerification(runId:string,tenantId:string){
  if(!env.VERIFICATION_JOB_RESOURCE_ID)return;
  try{await dispatchVerification(await prepareVerification(runId,tenantId));}
  catch(error){logEvent("error","verification.dispatch_failed",{runId,tenantId,error});}
}

async function startAgentOutput(run:RunIdentity,agentType:AgentType,paths:string[]){
  await transaction(async client=>{
    await client.query("SELECT id FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[run.id,run.tenantId]);
    await requireActiveRun(client,run.id,run.tenantId,run.token);
    await client.query("INSERT INTO agent_tasks(run_id,agent_type,status,progress,objective,input_paths,started_at) VALUES($1,$2,'running',25,$4,$3::jsonb,now()) ON CONFLICT(run_id,agent_type) DO UPDATE SET status='running',progress=25,started_at=now(),completed_at=NULL,error=NULL,summary=NULL,files_owned='[]'::jsonb,output_text='',output_updated_at=now(),input_paths=EXCLUDED.input_paths",[run.id,agentType,JSON.stringify(paths),objectives[agentType]]);
  });
}

async function saveAgentOutput(run:RunIdentity,agentType:AgentType,output:string){
  await requireActiveRun(database(),run.id,run.tenantId,run.token);
  await database().query("UPDATE agent_tasks SET output_text=$3,output_updated_at=now() WHERE run_id=$1 AND agent_type=$2 AND EXISTS(SELECT 1 FROM modernization_runs r WHERE r.id=$1 AND r.status='running' AND r.options->>'workerToken'=$4)",[run.id,agentType,output,run.token]);
}

function countAdded(before: string, after: string) {
  const existing = new Set(before.split("\n"));
  return after.split("\n").filter((line) => !existing.has(line)).length;
}

const namespace=serviceBusNamespace();
if (!namespace&&!env.AZURE_SERVICE_BUS_CONNECTION_STRING) throw new Error("Azure Service Bus configuration is required.");
const bus = namespace?new ServiceBusClient(namespace,new ManagedIdentityCredential()):new ServiceBusClient(env.AZURE_SERVICE_BUS_CONNECTION_STRING!);
const receiver = bus.createReceiver(env.AZURE_SERVICE_BUS_QUEUE, { receiveMode: "peekLock", maxAutoLockRenewalDurationInMs: 60 * 60 * 1000 });
const instanceId=process.env.HOSTNAME||`worker-${process.pid}`;
let stopping=false;
async function heartbeat(status:"starting"|"healthy"|"stopping"|"degraded"="healthy"){await database().query(`INSERT INTO worker_heartbeats(worker_name,instance_id,status,last_seen_at,metadata) VALUES('transformation',$1,$2,now(),$3::jsonb) ON CONFLICT(worker_name) DO UPDATE SET instance_id=EXCLUDED.instance_id,status=EXCLUDED.status,last_seen_at=now(),metadata=EXCLUDED.metadata`,[instanceId,status,JSON.stringify({queue:env.AZURE_SERVICE_BUS_QUEUE})]);}
const heartbeatTimer=setInterval(()=>void heartbeat().catch(error=>logEvent("error","worker.heartbeat_failed",{error})),15_000);heartbeatTimer.unref();

let recoveryRunning=false;
async function recoverOrphanedRuns(){if(recoveryRunning||stopping)return;recoveryRunning=true;try{const orphaned=await database().query<{id:string;tenant_id:string}>(`SELECT id,tenant_id FROM modernization_runs WHERE (status IN ('queued','retrying') AND updated_at < now()-interval '2 minutes') OR (status='running' AND last_heartbeat_at < now()-interval '45 minutes') ORDER BY updated_at LIMIT 5`);for(const run of orphaned.rows)try{await processRun({body:{runId:run.id,tenantId:run.tenant_id,recovery:true},messageId:`recovery-${run.id}`,correlationId:run.id} as ServiceBusReceivedMessage);}catch(error){logEvent("error","worker.run_recovery_failed",{runId:run.id,error});}}catch(error){logEvent("error","worker.recovery_failed",{error});}finally{recoveryRunning=false;}}
let verificationRecoveryRunning=false;
async function recoverVerification(){if(verificationRecoveryRunning||stopping)return;verificationRecoveryRunning=true;try{await recoverVerificationDispatches();}catch(error){logEvent('error','verification.recovery_failed',{error});}finally{verificationRecoveryRunning=false;}}
const recoveryTimer=setInterval(()=>{void recoverOrphanedRuns();void recoverVerification();},60_000);recoveryTimer.unref();
const subscription = receiver.subscribe({
  async processMessage(message) {
    const body = message.body as { runId?: string; tenantId?: string };
    await processAndSettle(() => processRun(message), () => receiver.completeMessage(message), async error => {
      logEvent("error","transformation.failed",{runId:body.runId,tenantId:body.tenantId,deliveryCount:message.deliveryCount,error});
      const deliveryCount = message.deliveryCount ?? 0;
      if (deliveryCount >= 4) await receiver.deadLetterMessage(message, { deadLetterReason: "TransformationFailed", deadLetterErrorDescription: error instanceof Error ? error.message.slice(0, 1000) : "Unknown error" });
      else await receiver.abandonMessage(message);
    }, error => logEvent("warn","service_bus.completion_failed",{runId:body.runId,messageId:message.messageId,error}));
  },
  async processError(args) { logEvent("error","service_bus.receiver_error",{error:args.error,errorSource:args.errorSource,entityPath:args.entityPath});await heartbeat("degraded").catch(()=>undefined); },
}, { autoCompleteMessages: false, maxConcurrentCalls: 1 });

logEvent("info","worker.ready",{worker:"transformation",instanceId,queue:env.AZURE_SERVICE_BUS_QUEUE});
async function shutdown() { if(stopping)return;stopping=true;clearInterval(heartbeatTimer);clearInterval(recoveryTimer);await heartbeat("stopping").catch(()=>undefined);await subscription.close(); await receiver.close(); await bus.close(); await database().end(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
async function start(){await heartbeat("starting");void recoverOrphanedRuns();void recoverVerification();}
void start().catch(error=>{logEvent("error","worker.start_failed",{error});process.exit(1);});
