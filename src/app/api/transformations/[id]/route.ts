import { NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { isDemoRequest } from "@/lib/demo-session";
import { demoEnabled, env } from "@/lib/env";
import { createDemoTransformation } from "@/lib/demo-transformation";
import { query, transaction } from "@/lib/db";
import { z } from "zod";
import { planningProgress } from "@/lib/run-progress";
import { deleteProject } from "@/lib/delete-project";
import { requiresVerification } from "@/lib/validation-execution";
import { verificationState } from "@/lib/verification-service";
import { verificationErrorCode } from "@/lib/verification-status";
import { pipelineStages } from "@/lib/pipeline-stages";
import type { TransformationStatus } from "@/types/modernization";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (isDemoRequest(request)) return NextResponse.json({ ...createDemoTransformation(), id });
    const user = await requireUser(request, ["Modernization.Reader", "Modernization.Admin"]);
    if (demoEnabled) return NextResponse.json({ ...createDemoTransformation(), id });
    const run = await query(
      `SELECT id,repository_url,source_branch,target_branch,scope,options,status,progress,current_stage,source_commit_sha,pull_request_url,error_code,error_detail,created_at,updated_at,version,started_at
       FROM modernization_runs WHERE id=$1 AND tenant_id=$2`, [id, user.tenantId],
    );
    if (!run.rowCount) return NextResponse.json({ error: "Transformation run not found." }, { status: 404 });
    const changes = await query(
      `SELECT path,old_path,operation,area,additions,deletions,rationale,before_content,after_content,validation,agent_type,user_modified
       FROM transformation_changes WHERE run_id=$1 ORDER BY path`, [id],
    );
    const agents=await query("SELECT id,agent_type,status,progress,objective,summary,files_owned,error,(length(output_text)>0) AS has_output FROM agent_tasks WHERE run_id=$1 ORDER BY agent_type",[id]);
    const persisted = run.rows[0] as Record<string, unknown>;
    const publication=await query("SELECT attempts,last_error,next_attempt_at FROM outbox_events WHERE aggregate_id=$1::text AND tenant_id=$2 AND event_type='pull-request.requested' ORDER BY created_at DESC LIMIT 1",[id,user.tenantId]);
    const execution = await verificationState(id,user.tenantId,String(persisted.source_commit_sha||""));
    const verificationRequired = (requiresVerification(String(persisted.status)) || ["verification-required","verification-failed"].includes(String(persisted.current_stage))) && execution.status !== "passed";
    const status = verificationRequired ? "blocked" : persisted.status;
    const currentStage = verificationRequired ? "verification-required" : String(persisted.current_stage || "queued");
    const progress = verificationRequired ? 75 : planningProgress(String(status), currentStage, Number(persisted.progress || 0), String(persisted.scope), agents.rows.map(agent => ({agent_type:String(agent.agent_type),status:String(agent.status),has_output:Boolean(agent.has_output)})));
    const testing = agents.rows.find(agent=>agent.agent_type==="testing");
    return NextResponse.json({
      id: persisted.id,
      name: `Modernize ${String(persisted.repository_url).split("/").pop() || "application"}`,
      mode: "live",
      repository: String(persisted.repository_url).replace("https://github.com/", ""),
      branch: persisted.source_branch,
      targetBranch: persisted.target_branch,
      status,
      reportedStatus: persisted.status,
      validationExecution: execution,
      progress,
      currentStage,
      sourceCommitSha: persisted.source_commit_sha,
      pullRequestUrl: persisted.pull_request_url,
      publication:publication.rows[0]?{attempts:publication.rows[0].attempts,lastError:publication.rows[0].last_error,nextAttemptAt:publication.rows[0].next_attempt_at}:undefined,
      aiModel:env.AZURE_AI_FOUNDRY_MODEL,
      errorCode:verificationRequired ? verificationErrorCode(execution.status) : persisted.error_code,
      errorDetail:verificationRequired ? (verificationErrorCode(execution.status) ? execution.reason : null) : persisted.error_detail || (persisted.status==="approved"?publication.rows[0]?.last_error:null),
      version: persisted.version,
      attemptStartedAt: persisted.started_at,
      agents:agents.rows.map(row=>({id:row.id,type:row.agent_type,name:`${String(row.agent_type).charAt(0).toUpperCase()+String(row.agent_type).slice(1)} Agent`,status:row.error?"blocked":row.status,reportedStatus:row.status,error:row.error,progress:row.error?0:row.progress,objective:row.objective,summary:row.summary,filesOwned:row.files_owned||[]})),
      stages: pipelineStages(status as TransformationStatus,currentStage,testing?.status as TransformationStatus,Number(testing?.progress||0)),
      files: changes.rows.map((change) => {
        const row = change as Record<string, unknown>;
        return { path: row.path, oldPath: row.old_path, status: row.operation, area: row.area, additions: row.additions, deletions: row.deletions, rationale: row.rationale, before: row.before_content || "", after: row.after_content || "", validation: execution.status === "passed" ? row.validation || [] : [], agentType:row.agent_type, userModified:row.user_modified };
      }),
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Transformation lookup failed", error);
    return NextResponse.json({ error: "The transformation could not be loaded." }, { status: 500 });
  }
}

const deletionSchema = z.object({ confirmed: z.literal(true), targetBranch: z.string().min(1).max(200) });

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request, ["Modernization.Admin"]);
    const { id } = await context.params;
    const input = deletionSchema.parse(await request.json());
    const outcome = await transaction(client => deleteProject(client,user,id,input.targetBranch,request.headers.get("x-request-id") || undefined));
    return NextResponse.json(outcome.error ? {error:outcome.error} : {deleted:true,id}, {status:outcome.status});
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({error:error.message},{status:error.status});
    if (error instanceof z.ZodError || error instanceof SyntaxError) return NextResponse.json({error:"Explicit confirmation and the exact target branch are required."},{status:400});
    console.error("Project deletion failed", error);
    return NextResponse.json({error:"The project could not be deleted."},{status:500});
  }
}