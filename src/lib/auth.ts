import { createRemoteJWKSet, jwtVerify } from "jose";
import { env, demoEnabled } from "@/lib/env";

export interface UserContext {
  id: string;
  name: string;
  email?: string;
  roles: string[];
  tenantId: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export async function requireUser(request: Request, requiredRoles: string[] = []): Promise<UserContext> {
  if (demoEnabled) return { id: "demo-user", name: "Demo Administrator", roles: ["Modernization.Admin"], tenantId: "demo" };
  if (!env.AZURE_TENANT_ID || !env.AZURE_CLIENT_ID) throw new AuthError("Microsoft Entra authentication is not configured.", 503);
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new AuthError("Authentication is required.", 401);
  jwks ||= createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/discovery/v2.0/keys`));
  try {
    const { payload } = await jwtVerify(authorization.slice(7), jwks);
    const validIssuers = new Set([`https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/v2.0`, `https://sts.windows.net/${env.AZURE_TENANT_ID}/`]);
    const validAudiences = new Set([env.AZURE_CLIENT_ID, `api://${env.AZURE_CLIENT_ID}`]);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!payload.iss || !validIssuers.has(payload.iss) || !audiences.some((audience) => audience && validAudiences.has(audience))) {
      throw new AuthError("The access token was not issued for this ModernizeAI environment.", 401);
    }
    const roles = Array.isArray(payload.roles) ? payload.roles.filter((role): role is string => typeof role === "string") : [];
    if (requiredRoles.length && !requiredRoles.some((role) => roles.includes(role))) throw new AuthError("The requested operation is not permitted.", 403);
    return {
      id: String(payload.oid || payload.sub),
      name: String(payload.name || "Authenticated user"),
      email: typeof payload.preferred_username === "string" ? payload.preferred_username : undefined,
      roles,
      tenantId: String(payload.tid),
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("The access token is invalid or expired.", 401);
  }
}

export class AuthError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}