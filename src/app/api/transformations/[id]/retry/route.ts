import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { appendAudit } from "@/lib/audit";
import { AuthError, requireUser } from "@/lib/auth";
import { isDemoRequest } from "@/lib/demo-session";
import { demoEnabled } from "@/lib/env";
import { database,transaction } from "@/lib/db";
import { enqueueTransformation } from "@/lib/queue";
import { enforceRateLimit } from "@/lib/rate-limit";
import { PublicationBusyError, retryPublication } from "@/lib/publication-retry";
import {noteQueueDelay} from "@/lib/run-coordination";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    const user=await requireUser(request,["Modernization.Admin"]);const{id}=await context.params;
    if(demoEnabled||isDemoRequest(request))return NextResponse.json({id,status:"queued",demo:true});
    const rate=await enforceRateLimit(user.tenantId,"transformation.retry",10,3600);if(!rate.allowed)return NextResponse.json({error:"The hourly retry limit has been reached."},{status:429,headers:{"Retry-After":String(rate.retryAfterSeconds)}});
    const mode=await transaction(async client=>{const run=await client.query<{status:string}>("SELECT status FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[id,user.tenantId]);if(!run.rowCount)throw new MissingRunError();if(await retryPublication(client,id,user.tenantId,run.rows[0].status)){await appendAudit(client,{tenantId:user.tenantId,actor:user,action:"publication.retried",resourceType:"run",resourceId:id,requestId:request.headers.get("x-request-id")||undefined});return"publication";}if(!["failed","cancelled"].includes(run.rows[0].status))throw new InvalidStateError();await client.query("UPDATE modernization_runs SET status='queued',progress=0,current_stage='queued',error_code=NULL,error_detail=NULL,cancelled_at=NULL,cancel_reason=NULL,last_heartbeat_at=NULL,updated_at=now(),version=version+1 WHERE id=$1",[id]);await appendAudit(client,{tenantId:user.tenantId,actor:user,action:"transformation.retried",resourceType:"run",resourceId:id,requestId:request.headers.get("x-request-id")||undefined});return"transformation";});
    if(mode==="transformation")try{await enqueueTransformation({runId:id,tenantId:user.tenantId,requestedBy:user.id,dispatchId:`${id}-retry-${randomUUID()}`});}catch(error){console.error("Saved retry delivery is unconfirmed; background recovery will retry",error);await noteQueueDelay(database(),id,user.tenantId);}
    return NextResponse.json({id,status:mode==="publication"?"approved":"queued"},{status:202});
  }catch(error){if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});if(error instanceof MissingRunError)return NextResponse.json({error:"Transformation run not found."},{status:404});if(error instanceof PublicationBusyError)return NextResponse.json({error:error.message},{status:409});if(error instanceof InvalidStateError)return NextResponse.json({error:"Only failed, cancelled, or failed publication attempts can be retried."},{status:409});return NextResponse.json({error:"The run could not be retried."},{status:500});}
}
class MissingRunError extends Error{}
class InvalidStateError extends Error{}
