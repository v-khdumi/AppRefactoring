import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { appendAudit } from "@/lib/audit";
import { demoEnabled,env } from "@/lib/env";
import { createDemoTransformation } from "@/lib/demo-transformation";
import { database,query, transaction } from "@/lib/db";
import { enqueueTransformation } from "@/lib/queue";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isDemoRequest } from "@/lib/demo-session";
import { planningProgress } from "@/lib/run-progress";
import { requiresVerification } from "@/lib/validation-execution";
import { verificationState } from "@/lib/verification-service";
import {architectureSnapshotSchema} from "@/lib/architecture-snapshot";
import {readSourceRepository,sourceRepository} from "@/lib/source-provider";
import {readVerificationReadiness,VerificationReadinessError} from "@/lib/verification-readiness";
import {noteQueueDelay} from "@/lib/run-coordination";
import {scenarioForOptions,validateScenarioScope,ScenarioPolicyError} from "@/lib/modernization-scenarios";
import {assertNoCredentials,ContentPolicyError} from "@/lib/content-policy";
import {parseRunOptions} from "@/lib/modernization-options";

const createSchema = z.object({
  repositoryUrl: z.string().url(),
  sourceBranch: z.string().min(1).max(200).default("main"),
  targetBranch: z.string().min(1).max(200).regex(/^[\w./-]+$/),
  scope: z.enum(["frontend", "backend", "fullstack"]),
  options: z.record(z.string(), z.unknown()).default({}),
  analysisSnapshot:architectureSnapshotSchema.optional(),
}).refine(input=>input.sourceBranch!==input.targetBranch,{message:"The modernization branch must be different from the source branch.",path:["targetBranch"]})
  .refine(input=>input.scope==="fullstack"||!Array.isArray(input.options.customCapabilities)||input.options.customCapabilities.length===0,{message:"Custom AI capabilities require full-stack modernization.",path:["options","customCapabilities"]});

export async function GET(request: Request) {
  try {
    if (isDemoRequest(request)) return NextResponse.json({ items: [createDemoTransformation()] });
    const user = await requireUser(request, ["Modernization.Reader", "Modernization.Admin"]);
    if (demoEnabled) return NextResponse.json({ items: [createDemoTransformation()] });
    const result = await query(
      `SELECT id, repository_url, source_branch, target_branch, scope, status, progress, current_stage, created_at, updated_at,source_commit_sha,
       (SELECT COALESCE(json_agg(json_build_object('agent_type',a.agent_type,'status',a.status,'has_output',length(a.output_text)>0)), '[]'::json) FROM agent_tasks a WHERE a.run_id=modernization_runs.id) AS agent_evidence
       FROM modernization_runs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`, [user.tenantId],
    );
    const items=await Promise.all(result.rows.map(async({agent_evidence,...run})=>{
      if(requiresVerification(run.status)&&(await verificationState(run.id,user.tenantId,run.source_commit_sha||"")).status!=="passed")return {...run,status:"blocked",current_stage:"verification-required",progress:75};
      return {...run,progress:planningProgress(run.status,run.current_stage,Number(run.progress),run.scope,agent_evidence)};
    }));
    return NextResponse.json({items,permissions:{canCreate:user.roles.includes("Modernization.Admin")}});
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    if (isDemoRequest(request)) return NextResponse.json({ ...createDemoTransformation(), id: `DEMO-${randomUUID().slice(0, 8)}` }, { status: 202 });
    const user = await requireUser(request, ["Modernization.Admin"]);
    const rate=await enforceRateLimit(user.tenantId,"transformation.create",10,3600);
    if(!rate.allowed)return NextResponse.json({error:"The hourly modernization limit has been reached. Retry after the current window resets."},{status:429,headers:{"Retry-After":String(rate.retryAfterSeconds)}});
    const input = createSchema.parse(await request.json());
    assertNoCredentials([{path:"modernization request",content:JSON.stringify(input)}]);
    if(input.options.preserveBehavior===false)return NextResponse.json({error:"Preserving existing behavior is required. Document and review specific exceptions separately."},{status:422});
    const options=parseRunOptions(input.scope,input.options);
    const scenario=scenarioForOptions(options);
    validateScenarioScope(scenario,input.scope);
    const descriptor=sourceRepository(input.repositoryUrl);
    if(input.analysisSnapshot&&(input.analysisSnapshot.scope!==input.scope||input.analysisSnapshot.repository.branch!==input.sourceBranch||sourceRepository(input.analysisSnapshot.repository.url||`https://github.com/${input.analysisSnapshot.repository.name}`).url!==descriptor.url))return NextResponse.json({error:"Analysis does not match the selected repository, branch and scope."},{status:409});
    if(input.analysisSnapshot&&(input.analysisSnapshot.scenario||"refactor")!==scenario)return NextResponse.json({error:"The selected modernization scenario changed after analysis. Analyze the updated plan."},{status:409});
    if (demoEnabled) return NextResponse.json({ ...createDemoTransformation(), id: `DEMO-${randomUUID().slice(0, 8)}` }, { status: 202 });
    if(!env.VERIFICATION_JOB_RESOURCE_ID||!env.VERIFICATION_PUBLIC_ORIGIN)return NextResponse.json({error:"An isolated verification runtime must be configured before live generation can start."},{status:503});
    const repository=await readSourceRepository(input.repositoryUrl,input.sourceBranch);
    if(input.analysisSnapshot&&input.analysisSnapshot.sourceCommitSha!==repository.sourceSha)return NextResponse.json({error:"Source changed since analysis. Analyze the current source before starting generation."},{status:409});
    const readinessOptions={scope:input.scope,backendTarget:options.backendTarget,scenario};
    const readiness=await readVerificationReadiness(repository.files,repository.readFile,readinessOptions);
    const runOptions={...options,scenario,preserveBehavior:true,architectureAnalysis:input.analysisSnapshot,verificationReadiness:readiness,sourceCommitSha:repository.sourceSha,scope:input.scope,executionAttempts:0,workerToken:undefined,pendingRefinement:undefined,coordinationContract:undefined};
    const run = await transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO modernization_runs (tenant_id,repository_url,source_branch,target_branch,scope,options,created_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING id`,
        [user.tenantId, descriptor.url, input.sourceBranch, input.targetBranch, input.scope, JSON.stringify(runOptions), user.id],
      );
      const id = result.rows[0].id;
      const agentObjectives={architect:"Define target boundaries and architecture decisions.",frontend:"Modernize UI while preserving observable interactions.",backend:"Extract typed APIs and preserve domain and data contracts.",cloud:"Add cloud readiness, identity, observability, and CI/CD.",testing:"Independently generate and validate characterization, contract, regression, and security tests.",security:"Review every generated change for vulnerabilities and secret exposure."};
      for(const [agentType,objective] of Object.entries(agentObjectives)){
        if(input.scope==="frontend"&&agentType==="backend"||input.scope==="backend"&&agentType==="frontend")continue;
        if(agentType==="cloud"&&input.options.cloudReady!==true)continue;
        await client.query("INSERT INTO agent_tasks(run_id,agent_type,status,progress,objective) VALUES($1,$2,'queued',0,$3)",[id,agentType,objective]);
      }
      await appendAudit(client, { tenantId: user.tenantId, actor: user, action: "transformation.requested", resourceType: "run", resourceId: id, data: { repositoryUrl: input.repositoryUrl, targetBranch: input.targetBranch,scenario }, requestId: request.headers.get("x-request-id") || undefined });
      return { id };
    });
    try{await enqueueTransformation({ runId: run.id, tenantId: user.tenantId, requestedBy: user.id });}catch(error){console.error("Saved run delivery is unconfirmed; background recovery will retry",error);await noteQueueDelay(database(),run.id,user.tenantId);}
    return NextResponse.json({ id: run.id, status: "queued" }, { status: 202 });
  } catch (error) { return apiError(error); }
}

function apiError(error: unknown) {
  if(error instanceof VerificationReadinessError)return NextResponse.json({error:error.message,code:error.name,readiness:error.readiness},{status:422});
  if (error instanceof AuthError||error instanceof ContentPolicyError||error instanceof ScenarioPolicyError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid request.", issues: error.issues }, { status: 400 });
  console.error("Transformation API failure", error);
  return NextResponse.json({ error: "The operation could not be completed." }, { status: 500 });
}