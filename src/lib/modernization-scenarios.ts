import {z} from "zod";
import {modernizationScenarios,type ModernizationScenario,type ModernizationScope} from "../types/modernization";
import {safeRepositoryPath} from "./repository-path";

export const scenarioIds=modernizationScenarios.map(scenario=>scenario.id);
export const scenarioSchema=z.enum(scenarioIds);
export const acceptanceManifestPath="tests/modernization-acceptance.json";
const variants=["baseline","candidate"] as const;
const kinds=["contract","integration","image-build","migration","rollback","data-parity","ai","authorization"] as const;
export const acceptanceManifestSchema=z.object({
  version:z.literal(1),
  scenario:scenarioSchema,
  checks:z.array(z.object({
    id:z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
    kind:z.enum(kinds),
    project:z.string().default(".").refine(value=>value==="."||safeRepositoryPath(value)),
    variants:z.array(z.enum(variants)).min(1).max(2),
    command:z.string().min(1).max(200).refine(value=>/^[a-zA-Z0-9_.-]+$/.test(value)||safeRepositoryPath(value)),
    args:z.array(z.string().max(2000)).max(100).default([]),
    report:z.object({path:z.string().refine(value=>safeRepositoryPath(value)&&value.startsWith(".modernize-reports/")),format:z.enum(["junit","tap","json"])}).strict(),
    timeoutSeconds:z.number().int().min(1).max(900).default(240),
  }).strict()).min(1).max(12),
}).strict().superRefine((manifest,context)=>{
  if(new Set(manifest.checks.map(check=>check.id)).size!==manifest.checks.length)context.addIssue({code:"custom",message:"Acceptance check IDs must be unique."});
  for(const check of manifest.checks)if(new Set(check.variants).size!==check.variants.length)context.addIssue({code:"custom",message:`Acceptance check ${check.id} contains duplicate variants.`});
});
export type AcceptanceManifest=z.infer<typeof acceptanceManifestSchema>;
export class ScenarioPolicyError extends Error {
  readonly status=422;
  constructor(message:string){super(message);this.name="ScenarioPolicyError";}
}

const required:Record<ModernizationScenario,Array<{kind:typeof kinds[number];variants:readonly typeof variants[number][]}>>={
  upgrade:[],refactor:[],
  replatform:[{kind:"image-build",variants:["candidate"]}],
  "extract-services":[{kind:"contract",variants},{kind:"integration",variants:["candidate"]}],
  rewrite:[{kind:"contract",variants}],
  "database-migration":[{kind:"migration",variants:["candidate"]},{kind:"rollback",variants:["candidate"]},{kind:"data-parity",variants}],
  "ai-capability":[{kind:"ai",variants:["candidate"]},{kind:"authorization",variants:["candidate"]}],
};

export function scenarioForOptions(options:Record<string,unknown>):ModernizationScenario{return scenarioSchema.parse(options.scenario??"refactor");}
export function scenarioRequirements(scenario:ModernizationScenario){return required[scenario];}
export function scenarioCommand(check:AcceptanceManifest["checks"][number]){return `modernization acceptance ${check.kind}: ${check.id}`;}

export function scenarioAcceptance(files:Array<{path:string;content:string}>,scenario:ModernizationScenario,base64=true){
  const file=files.find(file=>file.path===acceptanceManifestPath);
  if(!file){
    if(required[scenario].length)throw new ScenarioPolicyError(`${scenario} requires a reviewed ${acceptanceManifestPath} with executed ${required[scenario].map(check=>check.kind).join(", ")} checks. No acceptance check may be waived.`);
    return undefined;
  }
  let parsed:unknown;
  try{parsed=JSON.parse(base64?Buffer.from(file.content,"base64").toString("utf8"):file.content);}
  catch(error){if(error instanceof SyntaxError)throw new ScenarioPolicyError("The modernization acceptance manifest is not valid JSON.");throw error;}
  const result=acceptanceManifestSchema.safeParse(parsed);
  if(!result.success)throw new ScenarioPolicyError(`The modernization acceptance manifest is invalid: ${result.error.issues.map(issue=>issue.path.join(".")||"manifest").slice(0,6).join(", ")}.`);
  const manifest=result.data;
  if(manifest.scenario!==scenario)throw new ScenarioPolicyError("The acceptance manifest does not match the selected modernization scenario.");
  for(const requirement of required[scenario])for(const variant of requirement.variants)if(!manifest.checks.some(check=>check.kind===requirement.kind&&check.variants.includes(variant)))throw new ScenarioPolicyError(`${scenario} is missing the ${variant} ${requirement.kind} acceptance check.`);
  return manifest;
}

export function validateScenarioScope(scenario:ModernizationScenario,scope:ModernizationScope){
  if(modernizationScenarios.find(item=>item.id===scenario)?.requiresBackend&&scope==="frontend")throw new ScenarioPolicyError(`${scenario} requires backend or full-app scope.`);
}

export function scenarioInstructions(scenario:ModernizationScenario){
  return {
    upgrade:"Upgrade supported versions and dependencies conservatively; preserve public APIs and data formats. Record incompatibilities and migration steps.",
    refactor:"Improve internal structure without changing public behavior, runtime boundaries, data contracts or deployment topology.",
    replatform:"Preserve behavior while changing hosting/container packaging. Require a real isolated image build and container smoke-test acceptance harness; a Dockerfile is not build evidence.",
    "extract-services":"Use incremental strangler boundaries, adapters and explicit synchronization/transaction semantics. Require unchanged baseline/candidate contracts plus candidate integration tests; do not silently replace all consumers.",
    rewrite:"Use a reviewed, runtime-independent black-box contract harness on baseline and candidate. Preserve the original test sources. Do not equate unrelated unit suites with cross-runtime parity.",
    "database-migration":"Generate versioned schema/data migrations, compatibility sequencing and rollback. Require isolated fixture migration, rollback rehearsal and baseline/candidate data-parity checks. Never connect to or migrate a production database.",
    "ai-capability":"Preserve existing behavior and add authorized AI workflows with grounding/provenance, failure and uncertainty states, data lifecycle and observable costs. Require executed AI acceptance and authorization checks; distinguish mocks from live-service validation.",
  }[scenario];
}

export function applyScenarioHarness<T extends {path:string;content:string}>(baseline:T[],candidate:T[]){
  const files=new Map(baseline.map(file=>[file.path,file]));
  for(const file of candidate.filter(file=>file.path===acceptanceManifestPath||file.path.startsWith("tests/modernization/"))){
    if(!safeRepositoryPath(file.path))throw new Error("Unsafe modernization acceptance harness path.");
    const original=files.get(file.path);
    if(original&&original.content!==file.content)throw new Error(`The original modernization acceptance harness cannot be rewritten: ${file.path}`);
    files.set(file.path,file);
  }
  return [...files.values()];
}
