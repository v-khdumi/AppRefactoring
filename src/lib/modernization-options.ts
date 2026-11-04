import {z} from "zod";
import {capabilitySnapshotSchema} from "./capability-design";
import {scenarioSchema,ScenarioPolicyError} from "./modernization-scenarios";
import {modernizationScenarios,type ModernizationScope} from "../types/modernization";

export const modernizationOptionsSchema=z.object({
  scope:z.enum(["frontend","backend","fullstack"]),
  scenario:scenarioSchema.default("refactor"),
  frontendTarget:z.string().max(120).optional(),
  backendTarget:z.string().max(120).optional(),
  cloudReady:z.boolean().default(false),
  cloudOptions:z.array(z.string().max(80)).max(20).default([]),
  aiFeatures:z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  customCapabilities:z.array(z.object({name:z.string().min(1).max(120),description:z.string().min(20).max(4000),design:capabilitySnapshotSchema}).strict()).max(10).default([]),
  preserveBehavior:z.literal(true).default(true),
}).strict().superRefine((options,context)=>{
  if(options.scope!=="fullstack"&&options.customCapabilities.length)context.addIssue({code:"custom",path:["customCapabilities"],message:"Custom AI capabilities require full-app modernization."});
  if(options.scope==="frontend"&&modernizationScenarios.find(scenario=>scenario.id===options.scenario)?.requiresBackend)context.addIssue({code:"custom",path:["scenario"],message:"This strategy requires backend or full-app scope."});
  if(options.scenario==="ai-capability"&&!options.aiFeatures.length&&!options.customCapabilities.length)context.addIssue({code:"custom",path:["aiFeatures"],message:"Select an AI capability or supply a reviewed custom capability design."});
});

export function parseRunOptions(scope:ModernizationScope,options:Record<string,unknown>){
  if(options.scope!==undefined&&options.scope!==scope)throw new ScenarioPolicyError("The options scope must match the selected modernization scope.");
  return modernizationOptionsSchema.parse({...options,scope});
}
