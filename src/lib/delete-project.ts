import type { PoolClient } from "pg";
import type { UserContext } from "./auth";
import { appendAudit } from "./audit";
import { canDeleteRun } from "./run-progress";

export async function deleteProject(client: PoolClient, user: UserContext, id: string, targetBranch: string, requestId?: string) {
  const result = await client.query<{ status:string; target_branch:string; repository_url:string }>("SELECT status,target_branch,repository_url FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [id,user.tenantId]);
  if (!result.rowCount) return { status:404, error:"Transformation run not found." };
  const run = result.rows[0];
  if (targetBranch !== run.target_branch) return { status:400, error:"The confirmation branch does not match this project." };
  if (!canDeleteRun(run.status)) return { status:409, error:"Stop the active run before deleting it. A run being published cannot be deleted." };
  const active = await client.query("SELECT 1 FROM agent_tasks WHERE run_id=$1::uuid AND status='running' UNION ALL SELECT 1 FROM outbox_events WHERE aggregate_id=$1::text AND tenant_id=$2 AND processed_at IS NULL UNION ALL SELECT 1 FROM verification_jobs WHERE run_id=$1::uuid AND tenant_id=$2 AND status IN ('preparing','running') AND expires_at>now() LIMIT 1", [id,user.tenantId]);
  if (active.rowCount) return { status:409, error:"An agent or publication task is still active. Wait for it to stop before deleting this project." };
  await appendAudit(client,{tenantId:user.tenantId,actor:user,action:"transformation.deleted",resourceType:"run",resourceId:id,data:{repositoryUrl:run.repository_url,targetBranch:run.target_branch},requestId});
  await client.query("DELETE FROM modernization_runs WHERE id=$1 AND tenant_id=$2", [id,user.tenantId]);
  return { status:200 };
}