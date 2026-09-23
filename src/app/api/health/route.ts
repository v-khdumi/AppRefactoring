import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { isFoundryConfigured } from "@/lib/foundry";
import { assertProductionConfiguration, demoEnabled, env, serviceBusNamespace } from "@/lib/env";
import { query } from "@/lib/db";
import { ServiceBusAdministrationClient } from "@azure/service-bus";
import { ManagedIdentityCredential } from "@azure/identity";

const requiredMigrations=["001_initial.sql","002_organization_settings.sql","003_multi_agent.sql","004_production_readiness.sql","005_enterprise_controls.sql","006_agent_output.sql","007_verification_jobs.sql"];

function authorizedForDeepHealth(request:Request){const expected=env.HEALTH_CHECK_TOKEN;if(!expected)return env.NODE_ENV!=="production";const supplied=request.headers.get("x-health-check-token")||request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")||"";const actualBuffer=Buffer.from(supplied);const expectedBuffer=Buffer.from(expected);return actualBuffer.length===expectedBuffer.length&&timingSafeEqual(actualBuffer,expectedBuffer);}

export async function GET(request:Request) {
  try {
    assertProductionConfiguration();
    const deep=new URL(request.url).searchParams.get("deep")==="true";
    if(deep&&!authorizedForDeepHealth(request))return NextResponse.json({status:"not-found"},{status:404,headers:{"Cache-Control":"no-store"}});
    let operations:Record<string,unknown>|undefined;
    if (env.DATABASE_URL) {
      const schema=await query<{agent_tasks:string|null;organization_settings:string|null;worker_heartbeats:string|null}>("SELECT to_regclass('public.agent_tasks')::text AS agent_tasks,to_regclass('public.organization_settings')::text AS organization_settings,to_regclass('public.worker_heartbeats')::text AS worker_heartbeats");
      if(!schema.rows[0]?.agent_tasks||!schema.rows[0]?.organization_settings)throw new Error("The production database schema is incomplete.");
      const migrations=await query<{name:string}>("SELECT name FROM schema_migrations ORDER BY name");
      const applied=new Set(migrations.rows.map(row=>row.name));const missing=requiredMigrations.filter(name=>!applied.has(name));
      if(missing.length)throw new Error(`Pending database migrations: ${missing.join(", ")}`);
      if(deep&&schema.rows[0]?.worker_heartbeats){const workers=await query<{worker_name:string;status:string;last_seen_at:string;fresh:boolean}>("SELECT worker_name,status,last_seen_at,(last_seen_at>now()-interval '45 seconds') AS fresh FROM worker_heartbeats ORDER BY worker_name");operations={workers:workers.rows};}
    }
    const namespace=serviceBusNamespace();if(deep&&(namespace||env.AZURE_SERVICE_BUS_CONNECTION_STRING)){try{const admin=namespace?new ServiceBusAdministrationClient(namespace,new ManagedIdentityCredential()):new ServiceBusAdministrationClient(env.AZURE_SERVICE_BUS_CONNECTION_STRING!);const queue=await admin.getQueueRuntimeProperties(env.AZURE_SERVICE_BUS_QUEUE);operations={...operations,queue:{status:"healthy",activeMessages:queue.activeMessageCount,deadLetterMessages:queue.deadLetterMessageCount,scheduledMessages:queue.scheduledMessageCount}};}catch(error){console.error("Service Bus readiness check failed",error instanceof Error?error.message:error);operations={...operations,queue:{status:"unavailable"}};}
    }
    const workers=operations?.workers as Array<{fresh:boolean;status:string}>|undefined;
    const queue=operations?.queue as {status?:string}|undefined;
    const degraded=Boolean(deep&&((workers&&((workers.length<2)||workers.some(worker=>!worker.fresh||worker.status==="degraded")))||queue?.status==="unavailable"));
    return NextResponse.json({
      status: degraded ? "degraded" : "healthy",
      mode: demoEnabled ? "demo" : "live",
      checks: { database: env.DATABASE_URL ? "healthy" : "not-configured", foundry: isFoundryConfigured() ? "configured" : "not-configured" },
      ...(deep?{operations}:{}),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Readiness check failed", error instanceof Error ? error.message : error);
    return NextResponse.json({ status: "unhealthy" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}