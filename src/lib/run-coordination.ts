import type {Pool,PoolClient} from "pg";

export class RunInterruptedError extends Error {
  constructor(){super("Run is no longer active. Its generated result was not persisted.");this.name="RunInterruptedError";}
}
export function runLockKey(runId:string,tenantId:string){return `modernize-run:${tenantId}:${runId}`;}
export async function noteQueueDelay(client:Pick<PoolClient,"query">,runId:string,tenantId:string){
  await client.query("UPDATE modernization_runs SET current_stage='queue-dispatch-pending',error_code='QueueDeliveryUnconfirmed',error_detail='The request is saved. Delivery was not confirmed; the background worker will recover it. Do not create a duplicate run.',updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 AND status='queued'",[runId,tenantId]);
}

export async function withRunLock<Result>(pool:Pick<Pool,"connect">,runId:string,tenantId:string,operation:()=>Promise<Result>){
  const client=await pool.connect();let acquired=false;let destroy=false;
  try{
    acquired=Boolean((await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",[runLockKey(runId,tenantId)])).rows[0]?.acquired);
    if(!acquired)return {acquired:false as const};
    return {acquired:true as const,value:await operation()};
  }finally{
    if(acquired)try{await client.query("SELECT pg_advisory_unlock(hashtext($1))",[runLockKey(runId,tenantId)]);}catch{destroy=true;}
    client.release(destroy);
  }
}

export async function requireActiveRun(client:Pick<PoolClient,"query">,runId:string,tenantId:string,token?:string){
  const result=await client.query("SELECT 1 FROM modernization_runs WHERE id=$1 AND tenant_id=$2 AND status='running' AND ($3::text IS NULL OR options->>'workerToken'=$3)",[runId,tenantId,token||null]);
  if(!result.rowCount)throw new RunInterruptedError();
}

export async function reserveRefinement(client:Pick<PoolClient,"query">,input:{runId:string;tenantId:string;agentType:string;instruction:string;actorId:string}){
  const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",[runLockKey(input.runId,input.tenantId)]);
  if(!lock.rows[0]?.acquired)throw new Error("An agent is still processing this run. Wait for the current work to finish.");
  const result=await client.query<{status:string;options:Record<string,unknown>}>("SELECT status,options FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[input.runId,input.tenantId]);
  const run=result.rows[0];
  if(!run||!["blocked","failed","awaiting-approval"].includes(run.status))throw new Error("Refinement requires a stopped, unapproved run.");
  const active=await client.query("SELECT 1 FROM verification_jobs WHERE run_id=$1 AND status IN ('preparing','running') AND expires_at>now()",[input.runId]);
  if(active.rowCount)throw new Error("Verification is active. Wait before requesting another refinement.");
  const updated=await client.query("UPDATE agent_tasks SET status='queued',progress=0,objective=$1,error=NULL WHERE run_id=$2 AND agent_type=$3",[input.instruction,input.runId,input.agentType]);
  if(!updated.rowCount)throw new Error("This agent is outside the selected run scope.");
  await client.query("INSERT INTO agent_messages(run_id,agent_type,role,actor_id,content) VALUES($1,$2,'user',$3,$4)",[input.runId,input.agentType,input.actorId,input.instruction]);
  await client.query("UPDATE transformation_changes SET validation='[]'::jsonb WHERE run_id=$1",[input.runId]);
  await client.query("UPDATE verification_jobs SET status='stale' WHERE run_id=$1 AND status='passed'",[input.runId]);
  await client.query("UPDATE modernization_runs SET status='queued',current_stage='refinement-queued',error_code=NULL,error_detail=NULL,options=jsonb_set(options,'{pendingRefinement}',$3::jsonb),updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2",[input.runId,input.tenantId,JSON.stringify({agentType:input.agentType,instruction:input.instruction})]);
}