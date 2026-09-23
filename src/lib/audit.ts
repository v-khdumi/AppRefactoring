import type { PoolClient } from "pg";
import type { UserContext } from "@/lib/auth";

export async function appendAudit(client: PoolClient, input: {
  tenantId: string; actor: UserContext; action: string; resourceType: string; resourceId: string;
  data?: Record<string, unknown>; requestId?: string;
}) {
  await client.query(
    `INSERT INTO audit_events (tenant_id, actor_id, actor_name, action, resource_type, resource_id, data, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [input.tenantId, input.actor.id, input.actor.name, input.action, input.resourceType, input.resourceId, JSON.stringify(input.data || {}), input.requestId],
  );
}