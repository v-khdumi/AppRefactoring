import { transaction } from "@/lib/db";

export async function enforceRateLimit(tenantId: string, endpoint: string, limit: number, windowSeconds: number) {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const result = await transaction(async (client) => {
    const counter = await client.query<{ request_count: number }>(
      `INSERT INTO rate_limit_windows(tenant_id,endpoint,window_start,request_count)
       VALUES($1,$2,$3,1)
       ON CONFLICT(tenant_id,endpoint,window_start) DO UPDATE SET request_count=rate_limit_windows.request_count+1
       RETURNING request_count`,
      [tenantId, endpoint, windowStart],
    );
    if (Math.random() < 0.02) await client.query("DELETE FROM rate_limit_windows WHERE window_start < now() - interval '2 days'");
    return counter.rows[0].request_count;
  });
  return {
    allowed: result <= limit,
    remaining: Math.max(0, limit - result),
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000)),
  };
}
