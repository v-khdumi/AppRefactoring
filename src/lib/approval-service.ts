import type {PoolClient} from "pg";
import type {UserContext} from "./auth";
import {appendAudit} from "./audit";
import {approvalAccess,contributorQuery,hasRequiredRole} from "./authorization-policy";
import {currentChanges,verifiedChangeset} from "./verification-record";
import {changesetDigest} from "./verification-evidence";
import {assertNoCredentials} from "./content-policy";

export class ApprovalFailure extends Error {
  constructor(message:string,public status:number,public code?:string){super(message);this.name="ApprovalFailure";}
}

export async function recordApproval(client:PoolClient,input:{id:string;actor:UserContext;commitSha:string;changesetDigest?:string;decision:"approved"|"rejected";comment?:string;requestId?:string}){
  const {id,actor}=input;
  if(!hasRequiredRole(actor.roles,["Modernization.Approver","Modernization.Admin"]))throw new ApprovalFailure("The requested operation is not permitted.",403);
  assertNoCredentials([{path:"approval comment",content:input.comment||""}]);
  const result=await client.query<{status:string;source_commit_sha:string|null;created_by:string}>("SELECT status,source_commit_sha,created_by FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[id,actor.tenantId]);
  const run=result.rows[0];
  if(!run)throw new ApprovalFailure("Transformation run not found.",404);
  if(run.status!=="awaiting-approval")throw new ApprovalFailure("The run is not awaiting approval.",409);
  if(!run.source_commit_sha||run.source_commit_sha!==input.commitSha)throw new ApprovalFailure("The reviewed source commit has changed. Refresh and review the changes again.",409);
  if(input.decision==="approved"){
    const contributions=await client.query<{contributed:boolean}>(contributorQuery,[id,actor.tenantId,actor.id]);
    const access=approvalAccess(actor.roles,actor.id,run.created_by,Boolean(contributions.rows[0]?.contributed));
    if(!access.canApprove)throw new ApprovalFailure(access.reason,403);
    if(!await verifiedChangeset(client,id,actor.tenantId,input.commitSha))throw new ApprovalFailure("Run isolated verification for the current changeset before approval.",409,"VerificationRequired");
    if(input.changesetDigest!==changesetDigest(input.commitSha,await currentChanges(client,id)))throw new ApprovalFailure("The reviewed changeset has changed. Refresh and review it again.",409);
  }
  const quality=await client.query<{testing_status:string;has_unvalidated:boolean}>("SELECT (SELECT status FROM agent_tasks WHERE run_id=$1 AND agent_type='testing') AS testing_status, EXISTS(SELECT 1 FROM transformation_changes WHERE run_id=$1 AND (validation='[]'::jsonb OR user_modified=true)) AS has_unvalidated",[id]);
  if(quality.rows[0]?.testing_status!=="passed"||quality.rows[0]?.has_unvalidated)throw new ApprovalFailure("Approval is blocked until the Testing Agent passes and every file has current validation evidence.",409);
  await client.query("INSERT INTO approvals(run_id,commit_sha,approved_by,decision,comment) VALUES($1,$2,$3,$4,$5)",[id,input.commitSha,actor.id,input.decision,input.comment]);
  await client.query("UPDATE modernization_runs SET status=$1,current_stage=$3,error_code=NULL,error_detail=NULL,updated_at=now(),version=version+1 WHERE id=$2",[input.decision==="approved"?"approved":"rejected",id,input.decision==="approved"?"publication-queued":"rejected"]);
  if(input.decision==="approved")await client.query("INSERT INTO outbox_events(tenant_id,event_type,aggregate_id,payload) VALUES($1,'pull-request.requested',$2,$3::jsonb)",[actor.tenantId,id,JSON.stringify({runId:id,commitSha:input.commitSha,changesetDigest:input.changesetDigest,requestedBy:actor.id})]);
  await appendAudit(client,{tenantId:actor.tenantId,actor,action:`transformation.${input.decision}`,resourceType:"run",resourceId:id,data:{commitSha:input.commitSha,comment:input.comment},requestId:input.requestId});
}
