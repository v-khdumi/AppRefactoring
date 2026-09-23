import { NextResponse } from "next/server";
import { z } from "zod";
import { appendAudit } from "@/lib/audit";
import { AuthError, requireUser } from "@/lib/auth";
import { isDemoRequest } from "@/lib/demo-session";
import { demoEnabled } from "@/lib/env";
import { transaction } from "@/lib/db";

const schema=z.object({reason:z.string().trim().max(500).optional()});

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    const user=await requireUser(request,["Modernization.Admin"]);const{id}=await context.params;const input=schema.parse(await request.json().catch(()=>({})));
    if(demoEnabled||isDemoRequest(request))return NextResponse.json({id,status:"cancelled",demo:true});
    await transaction(async client=>{const run=await client.query<{status:string}>("SELECT status FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[id,user.tenantId]);if(!run.rowCount)throw new MissingRunError();if(["pull-request-created","rejected","cancelled"].includes(run.rows[0].status))throw new InvalidStateError();await client.query("UPDATE modernization_runs SET status='cancelled',current_stage='cancelled',cancelled_at=now(),cancel_reason=$1,updated_at=now(),version=version+1 WHERE id=$2",[input.reason||null,id]);await appendAudit(client,{tenantId:user.tenantId,actor:user,action:"transformation.cancelled",resourceType:"run",resourceId:id,data:{reason:input.reason},requestId:request.headers.get("x-request-id")||undefined});});
    return NextResponse.json({id,status:"cancelled"});
  }catch(error){if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});if(error instanceof z.ZodError)return NextResponse.json({error:"Invalid cancellation request."},{status:400});if(error instanceof MissingRunError)return NextResponse.json({error:"Transformation run not found."},{status:404});if(error instanceof InvalidStateError)return NextResponse.json({error:"This run can no longer be cancelled."},{status:409});return NextResponse.json({error:"The run could not be cancelled."},{status:500});}
}
class MissingRunError extends Error{}
class InvalidStateError extends Error{}
