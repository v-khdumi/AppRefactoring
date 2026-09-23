import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { demoEnabled, env } from "@/lib/env";
import { query } from "@/lib/db";
import { isDemoRequest } from "@/lib/demo-session";

const defaults = {
  policies: { behavior: true, approval: true, security: true, directPush: false },
  notifications: { failures: true, approvals: true, completed: true, digest: false },
};
const values = z.record(z.string(), z.boolean());
const schema = z.object({ section: z.enum(["policies", "notifications"]), values });

export async function GET(request: Request) {
  try {
    if (isDemoRequest(request)) return NextResponse.json(defaults);
    const user = await requireUser(request, ["Modernization.Reader", "Modernization.Admin"]);
    if (demoEnabled) return NextResponse.json(defaults);
    const result = await query<{ policies: Record<string, boolean>; notifications: Record<string, boolean> }>("SELECT policies,notifications FROM organization_settings WHERE tenant_id=$1", [user.tenantId]);
    return NextResponse.json({...(result.rows[0] || defaults),runtime:{model:env.AZURE_AI_FOUNDRY_MODEL}});
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    if (isDemoRequest(request)) return NextResponse.json({ saved: true, demo: true });
    const user = await requireUser(request, ["Modernization.Admin"]);
    const input = schema.parse(await request.json());
    if (input.section === "policies" && input.values.directPush) return NextResponse.json({ error: "Direct pushes to the default branch are prohibited by platform policy." }, { status: 409 });
    if (demoEnabled) return NextResponse.json({ saved: true, demo: true });
    const column = input.section === "policies" ? "policies" : "notifications";
    await query(`INSERT INTO organization_settings (tenant_id,${column},updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (tenant_id) DO UPDATE SET ${column}=EXCLUDED.${column},updated_by=EXCLUDED.updated_by,updated_at=now()`, [user.tenantId, JSON.stringify(input.values), user.id]);
    return NextResponse.json({ saved: true });
  } catch (error) { return failure(error); }
}

function failure(error: unknown) {
  if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid settings payload.", issues: error.issues }, { status: 400 });
  console.error("Settings operation failed", error);
  return NextResponse.json({ error: "Settings could not be saved." }, { status: 500 });
}