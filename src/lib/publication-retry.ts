import type {PoolClient} from "pg";
export class PublicationBusyError extends Error{}
export async function retryPublication(client:Pick<PoolClient,"query">,id:string,tenantId:string,status:string){
 if(!["approved","publication-failed"].includes(status))return false;
 const lock=await client.query("SELECT pg_try_advisory_xact_lock(hashtext('modernize-publication-dispatch')) AS acquired");
 if(!lock.rows[0]?.acquired)throw new PublicationBusyError("A publisher is currently processing a run. Wait for its result before retrying.");
 const event=await client.query("SELECT id,last_error FROM outbox_events WHERE aggregate_id=$1::text AND tenant_id=$2 AND event_type='pull-request.requested' AND processed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE",[id,tenantId]);
 if(!event.rowCount||status==="approved"&&!event.rows[0].last_error)throw new PublicationBusyError("Publication is already queued or has no failed attempt to retry.");
 await client.query("UPDATE outbox_events SET attempts=0,last_error=NULL,next_attempt_at=now() WHERE id=$1",[event.rows[0].id]);
 await client.query("UPDATE modernization_runs SET status='approved',current_stage='publication-queued',error_code=NULL,error_detail=NULL,updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2",[id,tenantId]);
 return true;
}