import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { transaction } from "@/lib/db";
import { enqueueAgentInstruction } from "@/lib/queue";
import {reserveRefinement} from "@/lib/run-coordination";

const schema=z.object({path:z.string().min(1).max(500),content:z.string().max(200000),baseVersion:z.number().int().positive()});
export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){
 try{const user=await requireUser(request,["Modernization.Admin"]);const{id}=await context.params;const input=schema.parse(await request.json());
    const instruction=`Independently validate the user edit to ${input.path}. Generate or update tests only; do not approve the change.`;
    await transaction(async(client)=>{
      const run=await client.query<{version:number;status:string}>("SELECT version,status FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[id,user.tenantId]);
      if(!run.rowCount)throw new Missing();if(run.rows[0].version!==input.baseVersion)throw new Conflict();if(!["awaiting-approval","blocked","failed"].includes(run.rows[0].status))throw new InvalidState();
      try{await reserveRefinement(client,{runId:id,tenantId:user.tenantId,agentType:"testing",instruction,actorId:user.id});}catch{throw new InvalidState();}
      const changed=await client.query("UPDATE transformation_changes SET after_content=$1,user_modified=true,validation='[]'::jsonb WHERE run_id=$2 AND path=$3 AND operation<>'deleted'",[input.content,id,input.path]);
      if(!changed.rowCount)throw new Missing();
      await client.query("INSERT INTO user_code_edits(run_id,path,content,edited_by,base_version) VALUES($1,$2,$3,$4,$5)",[id,input.path,input.content,user.id,input.baseVersion]);
    });
    try{await enqueueAgentInstruction({runId:id,tenantId:user.tenantId,requestedBy:user.id,agentType:"testing",instruction});}catch(error){console.error("Edit revalidation is persisted; queue dispatch will be recovered",error);}
  return NextResponse.json({saved:true,testingQueued:true});
 }catch(error){if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});if(error instanceof z.ZodError)return NextResponse.json({error:"Invalid code edit."},{status:400});if(error instanceof Conflict)return NextResponse.json({error:"The run changed. Refresh before editing again."},{status:409});if(error instanceof InvalidState)return NextResponse.json({error:"Code cannot be edited in the current run state."},{status:409});if(error instanceof Missing)return NextResponse.json({error:"Run or file not found."},{status:404});return NextResponse.json({error:"Code edit could not be saved."},{status:500})}
}
class Missing extends Error{} class Conflict extends Error{} class InvalidState extends Error{}