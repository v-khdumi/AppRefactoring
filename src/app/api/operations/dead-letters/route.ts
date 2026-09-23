import { ManagedIdentityCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { NextResponse } from "next/server";
import { z } from "zod";
import { appendAudit } from "@/lib/audit";
import { AuthError, requireUser } from "@/lib/auth";
import { query, transaction } from "@/lib/db";
import { env, serviceBusNamespace } from "@/lib/env";

const replaySchema=z.object({messageIds:z.array(z.string().min(1).max(200)).min(1).max(20)});

function client(){const namespace=serviceBusNamespace();if(!namespace)throw new Error("Service Bus namespace is not configured.");return new ServiceBusClient(namespace,new ManagedIdentityCredential());}

export async function GET(request:Request){
  try{
    const user=await requireUser(request,["Modernization.Admin"]);
    const bus=client();
    const receiver=bus.createReceiver(env.AZURE_SERVICE_BUS_QUEUE,{subQueueType:"deadLetter",receiveMode:"peekLock"});
    try{
      const messages=await receiver.peekMessages(50);
      const runIds=messages.map(message=>message.body&&typeof message.body==="object"?String(message.body.runId||""):"").filter(Boolean);
      const owned=runIds.length?await query<{id:string}>("SELECT id::text FROM modernization_runs WHERE tenant_id=$1 AND id::text=ANY($2::text[])",[user.tenantId,runIds]):{rows:[]};
      const allowed=new Set(owned.rows.map(row=>row.id));
      return NextResponse.json({items:messages.filter(message=>message.body&&typeof message.body==="object"&&allowed.has(String(message.body.runId||""))).map(message=>({messageId:String(message.messageId||""),correlationId:String(message.correlationId||""),subject:message.subject,deliveryCount:message.deliveryCount,reason:message.deadLetterReason,description:message.deadLetterErrorDescription,enqueuedAt:message.enqueuedTimeUtc,runId:String(message.body.runId)}))});
    }finally{await receiver.close();await bus.close();}
  }
  catch(error){if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});console.error("Dead-letter inspection failed",error);return NextResponse.json({error:"Dead-letter messages could not be inspected."},{status:503});}
}

export async function POST(request:Request){
  try{
    const user=await requireUser(request,["Modernization.Admin"]);
    const input=replaySchema.parse(await request.json());
    const requested=new Set(input.messageIds);
    const bus=client();const receiver=bus.createReceiver(env.AZURE_SERVICE_BUS_QUEUE,{subQueueType:"deadLetter",receiveMode:"peekLock"});const sender=bus.createSender(env.AZURE_SERVICE_BUS_QUEUE);const replayed:string[]=[];
    try{
      for(let batch=0;batch<5&&requested.size;batch+=1){
        const messages=await receiver.receiveMessages(20,{maxWaitTimeInMs:2000});if(!messages.length)break;
        for(const message of messages){
          const id=String(message.messageId||"");const body=message.body&&typeof message.body==="object"?message.body as {runId?:string;tenantId?:string}:{};
          if(!requested.has(id)||body.tenantId!==user.tenantId||!body.runId){await receiver.abandonMessage(message);continue;}
          const owned=await query("SELECT 1 FROM modernization_runs WHERE id=$1 AND tenant_id=$2",[body.runId,user.tenantId]);
          if(!owned.rowCount){await receiver.abandonMessage(message);continue;}
          await sender.sendMessages({messageId:`${id}-replay-${Date.now()}`,correlationId:message.correlationId||id,subject:message.subject,contentType:message.contentType,body:message.body,applicationProperties:{...(message.applicationProperties||{}),replayedBy:user.id}});await receiver.completeMessage(message);requested.delete(id);replayed.push(id);
        }
      }
    }finally{await sender.close();await receiver.close();await bus.close();}
    await transaction(async database=>appendAudit(database,{tenantId:user.tenantId,actor:user,action:"servicebus.deadletter.replayed",resourceType:"service-bus",resourceId:env.AZURE_SERVICE_BUS_QUEUE,data:{messageIds:replayed},requestId:request.headers.get("x-request-id")||undefined}));return NextResponse.json({replayed,notFound:[...requested]},{status:replayed.length?202:404});
  }
  catch(error){if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});if(error instanceof z.ZodError)return NextResponse.json({error:"Select between 1 and 20 valid dead-letter messages."},{status:400});console.error("Dead-letter replay failed",error);return NextResponse.json({error:"Dead-letter messages could not be replayed."},{status:503});}
}
