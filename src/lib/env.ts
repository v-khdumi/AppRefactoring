import { z } from "zod";

const optionalUrl = z.string().url().optional().or(z.literal(""));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DEMO_MODE: z.enum(["true", "false"]).default("false"),
  DATABASE_URL: z.string().min(1).optional(),
  AZURE_SERVICE_BUS_CONNECTION_STRING: z.string().min(1).optional(),
  AZURE_SERVICE_BUS_NAMESPACE: z.string().min(1).optional(),
  AZURE_SERVICE_BUS_QUEUE: z.string().default("modernization-runs"),
  AZURE_TENANT_ID: z.string().uuid().optional(),
  AZURE_CLIENT_ID: z.string().uuid().optional(),
  AZURE_AI_FOUNDRY_ENDPOINT: optionalUrl,
  AZURE_AI_FOUNDRY_API_KEY: z.string().optional(),
  AZURE_AI_FOUNDRY_MODEL: z.string().default("gpt-6-astra"),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  HEALTH_CHECK_TOKEN: z.string().min(32).optional(),
  NEXT_PUBLIC_GITHUB_APP_SLUG: z.string().default("modernizeai-khaled"),
  KEY_VAULT_URL: optionalUrl,
  VERIFICATION_JOB_RESOURCE_ID: z.string().optional(),
  VERIFICATION_PUBLIC_ORIGIN: optionalUrl,
});

export const env = schema.parse(process.env);
export const demoEnabled = env.DEMO_MODE === "true";
export function serviceBusNamespaceFromConnectionString(connectionString?:string){return connectionString?.match(/Endpoint=sb:\/\/([^/;]+)/i)?.[1];}
export function serviceBusNamespace(){return env.AZURE_SERVICE_BUS_NAMESPACE||serviceBusNamespaceFromConnectionString(env.AZURE_SERVICE_BUS_CONNECTION_STRING);}

export function assertProductionConfiguration() {
  if (env.NODE_ENV !== "production" || demoEnabled) return;
  const required = [
    "DATABASE_URL", "AZURE_TENANT_ID", "AZURE_CLIENT_ID",
    "AZURE_AI_FOUNDRY_ENDPOINT", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY",
  ] as const;
  const missing = required.filter((key) => !env[key]);
  if(!serviceBusNamespace()&&!env.AZURE_SERVICE_BUS_CONNECTION_STRING)missing.push("AZURE_SERVICE_BUS_NAMESPACE" as typeof missing[number]);
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
}