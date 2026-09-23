import { NextResponse } from "next/server";
import { z } from "zod";
import { appendAudit } from "@/lib/audit";
import { AuthError, requireUser } from "@/lib/auth";
import { isDemoRequest } from "@/lib/demo-session";
import { demoEnabled } from "@/lib/env";
import { transaction } from "@/lib/db";
import { enforceRateLimit } from "@/lib/rate-limit";
import { currentChanges, verifiedChangeset } from "@/lib/verification-service";
import { changesetDigest } from "@/lib/verification-evidence";

const schema = z.object({ commitSha: z.string().regex(/^[a-f0-9]{40}$/i), changesetDigest:z.string().regex(/^[a-f0-9]{64}$/i).optional(), decision: z.enum(["approved", "rejected"]), comment: z.string().max(2000).optional() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    if (isDemoRequest(request)) { const { id } = await context.params; return NextResponse.json({ id, decision: "approved", recorded: true, demo: true }); }
    const user = await requireUser(request, ["Modernization.Approver", "Modernization.Admin"]);
    const { id } = await context.params;
    const rate=await enforceRateLimit(user.tenantId,`transformation.approve:${id}`,10,60);
    if(!rate.allowed)return NextResponse.json({error:"Too many approval attempts. Retry after the current window resets."},{status:429,headers:{"Retry-After":String(rate.retryAfterSeconds)}});
    const input = schema.parse(await request.json());
    if (demoEnabled) return NextResponse.json({ id, decision: input.decision, recorded: true, demo: true });
    await transaction(async (client) => {
      const run = await client.query<{ status: string; source_commit_sha: string | null }>("SELECT status,source_commit_sha FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [id, user.tenantId]);
      if (!run.rowCount) throw new MissingRunError();
      if (run.rows[0].status !== "awaiting-approval") throw new InvalidStateError();
      if (!run.rows[0].source_commit_sha || run.rows[0].source_commit_sha !== input.commitSha) throw new StaleApprovalError();
      if(input.decision === "approved" && !await verifiedChangeset(client,id,user.tenantId,input.commitSha))throw new ExecutionEvidenceError();
      if(input.decision === "approved" && input.changesetDigest!==changesetDigest(input.commitSha,await currentChanges(client,id)))throw new StaleApprovalError();
      const quality=await client.query("SELECT (SELECT status FROM agent_tasks WHERE run_id=$1 AND agent_type='testing' AND EXISTS(SELECT 1 FROM modernization_runs r WHERE r.id=$1 AND r.tenant_id=$2)) AS testing_status, EXISTS(SELECT 1 FROM transformation_changes c WHERE c.run_id=$1 AND EXISTS(SELECT 1 FROM modernization_runs r WHERE r.id=$1 AND r.tenant_id=$2) AND (c.validation='[]'::jsonb OR c.user_modified=true)) AS has_unvalidated",[id,user.tenantId]);
      if(quality.rows[0]?.testing_status!=="passed"||quality.rows[0]?.has_unvalidated)throw new QualityGateError();
      await client.query("INSERT INTO approvals (run_id,commit_sha,approved_by,decision,comment) VALUES ($1,$2,$3,$4,$5)", [id, input.commitSha, user.id, input.decision, input.comment]);
      await client.query("UPDATE modernization_runs SET status=$1,current_stage=$3,error_code=NULL,error_detail=NULL,updated_at=now(),version=version+1 WHERE id=$2", [input.decision === "approved" ? "approved" : "rejected", id,input.decision === "approved" ? "publication-queued" : "rejected"]);
      if (input.decision === "approved") await client.query(
        "INSERT INTO outbox_events (tenant_id,event_type,aggregate_id,payload) VALUES ($1,'pull-request.requested',$2,$3::jsonb)",
        [user.tenantId, id, JSON.stringify({ runId: id, commitSha: input.commitSha, changesetDigest:input.changesetDigest, requestedBy: user.id })],
      );
      await appendAudit(client, { tenantId: user.tenantId, actor: user, action: `transformation.${input.decision}`, resourceType: "run", resourceId: id, data: { commitSha: input.commitSha, comment: input.comment }, requestId: request.headers.get("x-request-id") || undefined });
    });
    return NextResponse.json({ id, decision: input.decision, recorded: true });
  } catch (error) {
    if(error instanceof ExecutionEvidenceError)return NextResponse.json({error:"Run isolated verification for the current changeset before approval.",code:"VerificationRequired"},{status:409});
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid approval payload.", issues: error.issues }, { status: 400 });
    if (error instanceof MissingRunError) return NextResponse.json({ error: "Transformation run not found." }, { status: 404 });
    if (error instanceof InvalidStateError) return NextResponse.json({ error: "The run is not awaiting approval." }, { status: 409 });
    if (error instanceof StaleApprovalError) return NextResponse.json({ error: "The reviewed source commit has changed. Refresh and review the changes again." }, { status: 409 });
    if (error instanceof QualityGateError) return NextResponse.json({ error: "Approval is blocked until the Testing Agent passes and every file has current validation evidence." }, { status: 409 });
    console.error("Approval failed", error);
    return NextResponse.json({ error: "The approval could not be recorded." }, { status: 500 });
  }
}

class MissingRunError extends Error {}
class InvalidStateError extends Error {}
class StaleApprovalError extends Error {}
class QualityGateError extends Error {}
class ExecutionEvidenceError extends Error {}