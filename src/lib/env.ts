import { z } from "zod";
import {sourceConnections} from "./source-connections";

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
  AZURE_MANAGED_IDENTITY_CLIENT_ID: z.string().uuid().optional(),
  AZURE_AI_FOUNDRY_ENDPOINT: optionalUrl,
  AZURE_AI_FOUNDRY_API_KEY: z.string().optional(),
  AZURE_AI_FOUNDRY_MODEL: z.string().default("gpt-6-astra"),
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  SOURCE_CONNECTIONS:z.string().optional(),
  HEALTH_CHECK_TOKEN: z.string().min(32).optional(),
  NEXT_PUBLIC_GITHUB_APP_SLUG: z.string().default("modernizeai-khaled"),
  KEY_VAULT_URL: optionalUrl,
  VERIFICATION_JOB_RESOURCE_ID: z.string().optional(),
  VERIFICATION_PUBLIC_ORIGIN: optionalUrl,
});

export function parseEnvironment(values:Record<string,string|undefined>){
  return schema.parse(Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value?.trim()===""?undefined:value])));
}
export const env = parseEnvironment(process.env);
export const demoEnabled = env.DEMO_MODE === "true";
export function serviceBusNamespaceFromConnectionString(connectionString?:string){return connectionString?.match(/Endpoint=sb:\/\/([^/;]+)/i)?.[1];}
export function serviceBusNamespace(configuration = env){return configuration.AZURE_SERVICE_BUS_NAMESPACE;}

export function assertProductionConfiguration(configuration = env) {
  if (configuration.NODE_ENV !== "production" || configuration.DEMO_MODE === "true") return;
  const required = [
    "DATABASE_URL", "AZURE_TENANT_ID", "AZURE_CLIENT_ID",
    "AZURE_AI_FOUNDRY_ENDPOINT", "AZURE_AI_FOUNDRY_API_KEY",
    "VERIFICATION_JOB_RESOURCE_ID", "VERIFICATION_PUBLIC_ORIGIN", "HEALTH_CHECK_TOKEN",
  ] as const;
  const missing: string[] = required.filter((key) => !configuration[key]);
  const connections=sourceConnections(configuration.SOURCE_CONNECTIONS);
  const githubConfigured=Boolean(configuration.GITHUB_APP_ID&&configuration.GITHUB_APP_PRIVATE_KEY);
  if(!githubConfigured&&!connections.length)throw new Error("Configure a GitHub App or administrator-managed SOURCE_CONNECTIONS before serving live traffic.");
  if(githubConfigured&&!configuration.GITHUB_WEBHOOK_SECRET)missing.push("GITHUB_WEBHOOK_SECRET");
  if (!configuration.AZURE_SERVICE_BUS_NAMESPACE && !configuration.AZURE_SERVICE_BUS_CONNECTION_STRING) missing.push("AZURE_SERVICE_BUS_NAMESPACE");
  if (missing.length) throw new Error(`Missing production configuration: ${missing.join(", ")}`);
  if (!configuration.AZURE_AI_FOUNDRY_ENDPOINT?.startsWith("https://") || !configuration.VERIFICATION_PUBLIC_ORIGIN?.startsWith("https://")) {
    throw new Error("Production Foundry and verification endpoints must use HTTPS.");
  }
}