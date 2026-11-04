import {timingSafeEqual} from "node:crypto";
import {NextResponse} from "next/server";
import {ServiceBusAdministrationClient} from "@azure/service-bus";
import type {QueryResultRow} from "pg";
import {managedIdentityCredential} from "@/lib/azure-identity";
import {isFoundryConfigured} from "@/lib/foundry";
import {assertProductionConfiguration,demoEnabled,env,serviceBusNamespace} from "@/lib/env";
import {database} from "@/lib/db";
import {operationallyReady,type QueueHealth,type WorkerHeartbeat} from "@/lib/health-status";
import {withRequestDeadline} from "@/lib/request-deadline";
import {verificationRuntimeHealth} from "@/lib/verification-service";

export const dynamic="force-dynamic";
const headers={"Cache-Control":"no-store"};
const requiredMigrations=["001_initial.sql","002_organization_settings.sql","003_multi_agent.sql","004_production_readiness.sql","005_enterprise_controls.sql","006_agent_output.sql","007_verification_jobs.sql"];

function authorizedForDeepHealth(request:Request){
  const expected=env.HEALTH_CHECK_TOKEN;
  if(!expected)return env.NODE_ENV!=="production";
  const supplied=request.headers.get("x-health-check-token")||request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")||"";
  const actualBuffer=Buffer.from(supplied),expectedBuffer=Buffer.from(expected);
  return actualBuffer.length===expectedBuffer.length&&timingSafeEqual(actualBuffer,expectedBuffer);
}

function readinessQuery<T extends QueryResultRow>(text:string){
  const configuration={text,query_timeout:2000};
  return database().query<T>(configuration);
}

export async function GET(request:Request){
  const deep=new URL(request.url).searchParams.get("deep")==="true";
  if(deep&&!authorizedForDeepHealth(request))return NextResponse.json({status:"not-found"},{status:404,headers});
  if(demoEnabled)return NextResponse.json({status:"healthy",mode:"demo",checks:{database:"not-probed",foundry:"demo",verification:"demo"}},{headers});
  try{
    return await withRequestDeadline(async signal=>{
      assertProductionConfiguration();
      let workers:WorkerHeartbeat[]|undefined;
      let queue:QueueHealth|undefined;
      let verification:{status:string}|undefined;
      if(env.DATABASE_URL){
        const migrations=await readinessQuery<{name:string}>("SELECT name FROM schema_migrations ORDER BY name");
        const applied=new Set(migrations.rows.map(row=>row.name));
        const missing=requiredMigrations.filter(name=>!applied.has(name));
        if(missing.length)throw new Error(`Pending database migrations: ${missing.join(", ")}`);
        const schema=await readinessQuery<{complete:boolean}>("SELECT to_regclass('public.agent_tasks') IS NOT NULL AND to_regclass('public.organization_settings') IS NOT NULL AND to_regclass('public.worker_heartbeats') IS NOT NULL AS complete");
        if(!schema.rows[0]?.complete)throw new Error("The production database schema is incomplete.");
        if(deep)workers=(await readinessQuery<WorkerHeartbeat>("SELECT worker_name,status,last_seen_at,(last_seen_at>now()-interval '45 seconds') AS fresh FROM worker_heartbeats ORDER BY worker_name")).rows;
      }
      const namespace=serviceBusNamespace();
      if(deep&&(namespace||env.AZURE_SERVICE_BUS_CONNECTION_STRING)){
        try{
          const options={retryOptions:{maxRetries:0,timeoutInMs:4000}};
          const admin=namespace?new ServiceBusAdministrationClient(namespace,managedIdentityCredential(),options):new ServiceBusAdministrationClient(env.AZURE_SERVICE_BUS_CONNECTION_STRING!,options);
          const properties=await admin.getQueueRuntimeProperties(env.AZURE_SERVICE_BUS_QUEUE,{abortSignal:signal});
          queue={status:"healthy",activeMessages:properties.activeMessageCount,deadLetterMessages:properties.deadLetterMessageCount,scheduledMessages:properties.scheduledMessageCount};
        }catch(error){console.error("Service Bus readiness check failed",error instanceof Error?error.message:error);queue={status:"unavailable"};}
      }
      if(deep){
        try{verification=await verificationRuntimeHealth(signal);}
        catch(error){console.error("Verification readiness failed",error instanceof Error?error.message:error);verification={status:"unavailable"};}
      }
      const configured=Boolean(env.DATABASE_URL&&isFoundryConfigured()&&(namespace||env.AZURE_SERVICE_BUS_CONNECTION_STRING)&&env.VERIFICATION_JOB_RESOURCE_ID&&env.VERIFICATION_PUBLIC_ORIGIN);
      const degraded=!configured||deep&&(!operationallyReady(workers,queue)||verification?.status!=="reachable");
      return NextResponse.json({
        status:degraded?"degraded":"healthy",mode:"live",deploymentTier:env.DEPLOYMENT_TIER,
        checks:{database:env.DATABASE_URL?"healthy":"not-configured",foundry:isFoundryConfigured()?"configured-not-probed":"not-configured",verification:env.VERIFICATION_JOB_RESOURCE_ID&&env.VERIFICATION_PUBLIC_ORIGIN?"configured":"not-configured",githubWebhook:env.GITHUB_WEBHOOK_ENABLED==="true"?"signature-required":"disabled"},
        ...(deep?{operations:{workers,queue,verification}}:{}),
      },{status:degraded?503:200,headers});
    },9000,"Dependency readiness exceeded its time budget.");
  }catch(error){
    console.error("Readiness check failed",error instanceof Error?error.message:error);
    return NextResponse.json({status:"unhealthy"},{status:503,headers});
  }
}
