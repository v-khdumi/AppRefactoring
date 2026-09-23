import {z} from "zod";
export const architectureNodeSchema=z.object({id:z.string().min(1).max(100),label:z.string().min(1).max(200),detail:z.string().max(2000),kind:z.enum(["client","service","data","integration","cloud"])});
export const architectureSnapshotSchema=z.object({
  mode:z.literal("live"),scope:z.enum(["frontend","backend","fullstack"]),sourceCommitSha:z.string().regex(/^[a-f0-9]{40}$/i),
  summary:z.string().max(12000),confidence:z.number().min(0).max(100),
  repository:z.object({name:z.string().max(300),branch:z.string().max(200),files:z.number().nonnegative(),languages:z.record(z.string(),z.number())}),
  currentArchitecture:z.array(architectureNodeSchema).max(100),targetArchitecture:z.array(architectureNodeSchema).min(1).max(100),
  findings:z.array(z.object({title:z.string(),detail:z.string(),severity:z.enum(["critical","high","medium","low"]),file:z.string().optional()})).max(100),
  recommendations:z.array(z.string()).max(100),migrationPhases:z.array(z.object({title:z.string(),description:z.string(),duration:z.string()})).max(30),behaviorContracts:z.array(z.string()).max(100),
  evidence:z.object({scope:z.enum(["frontend","backend","fullstack"]),manifests:z.array(z.string()),lockfiles:z.array(z.string()),readManifests:z.array(z.string()),omittedManifests:z.array(z.string()),sampledPaths:z.array(z.string()),limits:z.array(z.string()),declaredPackages:z.array(z.unknown())}).optional(),
});