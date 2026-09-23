import { database, transaction } from "../src/lib/db";
import { createModernizationPullRequest, publishChanges } from "../src/lib/github-app";
import { logEvent } from "../src/lib/structured-log";
import { currentChanges, verifiedChangeset } from "../src/lib/verification-service";
import { changesetDigest } from "../src/lib/verification-evidence";
import { permanentPublicationError } from "../src/lib/publication-policy";

interface OutboxEvent { id: string; tenant_id: string; aggregate_id: string; payload: { commitSha: string;changesetDigest?:string }; attempts:number }

async function processNext() {
  const lock=await database().connect();
  let acquired=false;
  try{
    acquired=Boolean((await lock.query("SELECT pg_try_advisory_lock(hashtext('modernize-publication-dispatch')) AS acquired")).rows[0].acquired);
    if(!acquired)return false;
    return await processLocked();
  }finally{
    if(acquired)await lock.query("SELECT pg_advisory_unlock(hashtext('modernize-publication-dispatch'))").catch(()=>undefined);
    lock.release();
  }
}

async function processLocked() {
  const event = await transaction(async (client) => {
    const result = await client.query<OutboxEvent>(
      "SELECT id,tenant_id,aggregate_id,payload,attempts FROM outbox_events WHERE processed_at IS NULL AND attempts < 10 AND next_attempt_at<=now() AND EXISTS(SELECT 1 FROM modernization_runs r WHERE r.id::text=outbox_events.aggregate_id AND r.tenant_id=outbox_events.tenant_id AND r.status='approved') AND EXISTS(SELECT 1 FROM verification_jobs v WHERE v.run_id::text=outbox_events.aggregate_id AND v.tenant_id=outbox_events.tenant_id AND v.status='passed') ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!result.rowCount) return undefined;
    await client.query("UPDATE outbox_events SET attempts=attempts+1 WHERE id=$1", [result.rows[0].id]);
    return result.rows[0];
  });
  if (!event) return false;
  logEvent("info","outbox.processing",{eventId:event.id,runId:event.aggregate_id,attempt:event.attempts+1});
  try {
    const runResult = await database().query<{
      repository_url: string; source_branch: string; target_branch: string; source_commit_sha: string; status: string;
    }>("SELECT repository_url,source_branch,target_branch,source_commit_sha,status FROM modernization_runs WHERE id=$1 AND tenant_id=$2", [event.aggregate_id, event.tenant_id]);
    if (!runResult.rowCount || runResult.rows[0].status !== "approved") throw new Error("Approved transformation run was not found.");
    const run = runResult.rows[0];
    if(!await verifiedChangeset(database(),event.aggregate_id,event.tenant_id,run.source_commit_sha))throw new Error("Executed verification is missing or stale. Publication was not attempted.");
    if(event.payload.changesetDigest!==changesetDigest(run.source_commit_sha,await currentChanges(database(),event.aggregate_id)))throw new Error("The approved changeset has changed. A new human approval is required.");
    if (event.payload.commitSha !== run.source_commit_sha) throw new Error("Approval SHA does not match the reviewed source commit.");
    const match = run.repository_url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i);
    if (!match) throw new Error("Invalid repository URL.");
    const [, owner, repo] = match;
    const changeResult = await database().query<{ path: string; operation: string; after_content: string | null }>(
      "SELECT path,operation,after_content FROM transformation_changes WHERE run_id=$1 ORDER BY path", [event.aggregate_id],
    );
    await database().query("UPDATE modernization_runs SET current_stage='publishing-branch',progress=92,error_code=NULL,error_detail=NULL,updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 AND status='approved'",[event.aggregate_id,event.tenant_id]);
    const commitSha = await publishChanges({
      owner, repo, sourceBranch: run.source_branch, targetBranch: run.target_branch, expectedCommitSha: run.source_commit_sha,
      message: `Modernize application (${event.aggregate_id})`,
      changes: changeResult.rows.map((change) => ({ path: change.path, content: change.operation === "deleted" ? null : change.after_content || "" })),
    });
    await database().query("UPDATE modernization_runs SET current_stage='publishing-pull-request',progress=97,generated_commit_sha=$3,updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2 AND status='approved'",[event.aggregate_id,event.tenant_id,commitSha]);
    const pullRequest = await createModernizationPullRequest({
      owner, repo, sourceBranch: run.source_branch, targetBranch: run.target_branch,
      title: "Modernize application with ModernizeAI",
      body: `## ModernizeAI transformation\n\nRun: ${event.aggregate_id}\n\nThis draft pull request was generated only after human approval bound to source commit \`${run.source_commit_sha}\`. Review all quality-gate evidence before marking it ready.`,
    });
    await transaction(async (client) => {
      await client.query("UPDATE modernization_runs SET status='pull-request-created',progress=100,current_stage='completed',generated_commit_sha=$1,pull_request_url=$2,error_code=NULL,error_detail=NULL,updated_at=now(),version=version+1 WHERE id=$3", [commitSha, pullRequest.html_url, event.aggregate_id]);
      await client.query("UPDATE outbox_events SET processed_at=now(),last_error=NULL WHERE id=$1", [event.id]);
      await client.query("INSERT INTO audit_events (tenant_id,actor_id,actor_name,action,resource_type,resource_id,data) VALUES ($1,'system-outbox','Outbox Publisher','pull-request.created','run',$2,$3::jsonb)", [event.tenant_id, event.aggregate_id, JSON.stringify({ commitSha, pullRequest: pullRequest.html_url })]);
    });
    logEvent("info","outbox.completed",{eventId:event.id,runId:event.aggregate_id,pullRequest:pullRequest.html_url});
  } catch (error) {
    const finalAttempt=permanentPublicationError(error)||event.attempts+1>=10;
    await transaction(async client=>{
      await client.query("UPDATE outbox_events SET last_error=$1,next_attempt_at=now()+(LEAST(900,POWER(2,attempts)::int*5)*interval '1 second') WHERE id=$2",[error instanceof Error?error.message.slice(0,2000):"Unknown error",event.id]);
      await client.query("UPDATE modernization_runs SET status=$1,current_stage=$2,error_code=$3,error_detail=$4,updated_at=now(),version=version+1 WHERE id=$5 AND tenant_id=$6 AND status='approved'",[finalAttempt?"publication-failed":"approved",finalAttempt?"pull-request-publication-failed":"publication-retry-scheduled",error instanceof Error?error.name:"PublicationError",error instanceof Error?error.message.slice(0,4000):"Publication failed",event.aggregate_id,event.tenant_id]);
    });
    logEvent("error","outbox.failed",{eventId:event.id,runId:event.aggregate_id,attempt:event.attempts+1,finalAttempt,error});
  }
  return true;
}

let stopping = false;
const instanceId=process.env.HOSTNAME||`outbox-${process.pid}`;
async function heartbeat(status:"starting"|"healthy"|"stopping"|"degraded"="healthy"){await database().query(`INSERT INTO worker_heartbeats(worker_name,instance_id,status,last_seen_at,metadata) VALUES('outbox',$1,$2,now(),'{}'::jsonb) ON CONFLICT(worker_name) DO UPDATE SET instance_id=EXCLUDED.instance_id,status=EXCLUDED.status,last_seen_at=now()`,[instanceId,status]);}
const heartbeatTimer=setInterval(()=>void heartbeat().catch(error=>logEvent("error","outbox.heartbeat_failed",{error})),15_000);heartbeatTimer.unref();
async function pump() {
  while (!stopping) {
    const processed = await processNext();
    if (!processed) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
process.on("SIGTERM", () => { stopping = true; clearInterval(heartbeatTimer); void heartbeat("stopping"); });
process.on("SIGINT", () => { stopping = true; clearInterval(heartbeatTimer); void heartbeat("stopping"); });
logEvent("info","worker.ready",{worker:"outbox",instanceId});
async function start(){await heartbeat("starting");await pump();await database().end();}
void start().catch(error=>{logEvent("error","outbox.start_failed",{error});process.exit(1);});