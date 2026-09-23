import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { query, transaction } from "@/lib/db";
import { enqueueAgentInstruction } from "@/lib/queue";
import {reserveRefinement} from "@/lib/run-coordination";
import {appendAudit} from "@/lib/audit";

const agentType=z.enum(["architect","frontend","backend","cloud","testing","security"]);
const messageSchema=z.object({agentType,content:z.string().trim().min(1).max(12000)});
const names:Record<string,string>={architect:"Architecture Agent",frontend:"Frontend Agent",backend:"Backend Agent",cloud:"Cloud Readiness Agent",testing:"Testing Agent",security:"Security Agent"};

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{const user=await requireUser(request,["Modernization.Reader","Modernization.Admin"]);const{id}=await context.params;
    const [tasks,messages]=await Promise.all([
      query("SELECT id,agent_type,status,progress,objective,summary,files_owned,output_text,output_updated_at,started_at,completed_at,error,input_paths FROM agent_tasks WHERE run_id=$1 AND EXISTS(SELECT 1 FROM modernization_runs r WHERE r.id=$1 AND r.tenant_id=$2) ORDER BY agent_type",[id,user.tenantId]),
      query("SELECT id,agent_type,role,content,created_at FROM agent_messages WHERE run_id=$1 AND EXISTS(SELECT 1 FROM modernization_runs r WHERE r.id=$1 AND r.tenant_id=$2) ORDER BY created_at",[id,user.tenantId]),
    ]);
    return NextResponse.json({agents:tasks.rows.map((row)=>({id:row.id,type:row.agent_type,name:names[String(row.agent_type)],status:row.error?"blocked":row.status,reportedStatus:row.status,progress:row.error?0:row.progress,objective:row.objective,summary:row.summary,filesOwned:row.files_owned||[],output:row.output_text,outputUpdatedAt:row.output_updated_at,startedAt:row.started_at,completedAt:row.completed_at,error:row.error,inputPaths:row.input_paths||[]})),messages:messages.rows.map((row)=>({id:row.id,agentType:row.agent_type,role:row.role,content:row.content,createdAt:row.created_at}))}, {headers:{"Cache-Control":"no-store"}});
  }catch(error){return failure(error)}
}

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{const user=await requireUser(request,["Modernization.Admin"]);const{id}=await context.params;const input=messageSchema.parse(await request.json());
    await transaction(async(client)=>{
      try{await reserveRefinement(client,{runId:id,tenantId:user.tenantId,agentType:input.agentType,instruction:input.content,actorId:user.id});}
      catch(error){throw new AgentRunStateError(error instanceof Error?error.message:"Refinement unavailable.",409);}
      await appendAudit(client,{tenantId:user.tenantId,actor:user,action:"agent.refinement.requested",resourceType:"run",resourceId:id,data:{agent:input.agentType}});
    });
    try{await enqueueAgentInstruction({runId:id,tenantId:user.tenantId,requestedBy:user.id,agentType:input.agentType,instruction:input.content});}
    catch(error){console.error("Refinement dispatch delayed; persisted request will be recovered",error);}
    return NextResponse.json({accepted:true,status:"queued"},{status:202});
  }catch(error){return failure(error)}
}
class AgentRunStateError extends Error{constructor(message:string,public status:number){super(message);}}
function failure(error:unknown){if(error instanceof AuthError||error instanceof AgentRunStateError)return NextResponse.json({error:error.message},{status:error.status});if(error instanceof z.ZodError)return NextResponse.json({error:"Invalid agent instruction.",issues:error.issues},{status:400});console.error("Agent API failed",error);return NextResponse.json({error:"Agent operation failed."},{status:500})}