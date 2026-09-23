import { z } from "zod";
import { env } from "@/lib/env";
import { resilientFetch } from "@/lib/resilient-fetch";
import { foundryModelParameters } from "@/lib/foundry-model";
import { IncompleteGenerationError, readFoundryStream } from "@/lib/foundry-stream";
import { agentGenerationPolicy, AgentOwnershipError, assertAgentChangeAreas, assertModernizationScope } from "@/lib/agent-policy";
import {coordinationContractSchema,coordinationInstructions} from "./coordination-contract";

const changeSchema = z.object({
  path: z.string().min(1).max(500),
  oldPath: z.string().max(500).optional(),
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  area: z.enum(["frontend", "backend", "platform", "tests"]),
  rationale: z.string().min(20).max(4000),
  before: z.string().max(200_000).default(""),
  after: z.string().max(200_000).default(""),
  validation: z.array(z.string().max(500)).max(30),
});

const planSchema = z.object({
  summary: z.string().min(20).max(5000),
  changes: z.array(changeSchema).max(100),
  contract:coordinationContractSchema.optional(),
});

export type GeneratedPlan = z.infer<typeof planSchema>;

export class InvalidGeneratedPlanError extends Error {
  constructor(detail?:string) {
    super(`Microsoft Foundry returned invalid or incomplete plan JSON after one correction attempt. No changes from this proposal were accepted.${detail?` Validation: ${detail}`:" Retry the run to generate a new plan."}`);
    this.name = "InvalidGeneratedPlanError";
  }
}

export class FoundryRequestError extends Error {
  constructor(status: number) {
    super(status >= 500 || status === 429
      ? `Microsoft Foundry could not serve this generation request (HTTP ${status}) after bounded retries. No output from this request was accepted. Retry later if the service remains unavailable.`
      : `Microsoft Foundry rejected this generation request (HTTP ${status}). Check the deployment configuration and request permissions.`);
    this.name = "FoundryRequestError";
  }
}

export async function generateTransformationPlan(input: {
  repository: string; scope: string; options: Record<string, unknown>;
  files: Array<{ path: string; content: string }>;
}, onOutput?: (output: string) => Promise<void>, correctionFeedback?: string): Promise<GeneratedPlan> {
  if (!env.AZURE_AI_FOUNDRY_ENDPOINT || !env.AZURE_AI_FOUNDRY_API_KEY) throw new Error("Microsoft Foundry is not configured.");
  const basePolicy = agentGenerationPolicy(input.options.agentType);
  const policy={...basePolicy,instruction:`${basePolicy.instruction} The user scope is ${input.scope}. Never expand it. For frontend-only work preserve backend runtime and data; for backend-only work preserve frontend runtime. Shared manifest changes must be limited to dependencies of the selected layer. Read dependencyEvidence and manifests before selecting versions. Name lockfile, peer-dependency and runtime incompatibilities explicitly. Match existing cross-project API contracts; never invent an incompatible handoff as completed integration. Input files are the current candidate, including preceding agents' accepted work. Follow coordinationContract and precedingAgents; do not invent replacement endpoints or auth schemes. Return changes:[] with an explanation when no edit is needed. Never fabricate files to satisfy a minimum change count. ${input.options.requireCoordinationContract?coordinationInstructions:""}`};
  const system = `You are a principal modernization engineer. Generate a conservative, buildable vertical slice. Never remove existing behavior, credentials, licensing, tests, or security controls. Never create binaries, lock files, generated output, CI secrets, or direct deployment actions. Return strict JSON: {summary:string,changes:[{path:string,oldPath?:string,status:'added'|'modified'|'deleted'|'renamed',area:'frontend'|'backend'|'platform'|'tests',rationale:string,before:string,after:string,validation:string[]}]}. Include complete after content for every changed text file. Set before to an empty string; the application binds it to the authoritative source snapshot. Use valid JSON escaping for quotes, backslashes and newlines in code strings. Never truncate file content or omit closing JSON delimiters. Prefer additions and adapters over destructive rewrites. ${policy.instruction}${correctionFeedback ? ` Your previous proposal failed server validation: ${correctionFeedback}. Generate a new complete, concise proposal from the original source within your assigned areas. Reduce the number of changed files rather than truncating content. This is the final correction attempt.` : ""}`;
  const endpoint = env.AZURE_AI_FOUNDRY_ENDPOINT.replace(/\/$/, "");
  const response = await resilientFetch(`${endpoint}/chat/completions?api-version=${encodeURIComponent(process.env.AZURE_AI_FOUNDRY_API_VERSION || "2024-05-01-preview")}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": env.AZURE_AI_FOUNDRY_API_KEY },
    body: JSON.stringify({ model: env.AZURE_AI_FOUNDRY_MODEL, stream: Boolean(onOutput), ...foundryModelParameters(env.AZURE_AI_FOUNDRY_MODEL,0.05), response_format: { type: "json_object" }, messages: [{ role: "system", content: `${system} Write summary first as a concise public explanation of the proposed decisions, assumptions, and verification still required. Do not claim commands or tests were executed. Write each path and rationale before its after content.` }, { role: "user", content: JSON.stringify(input) }] }),
    attempts: 3,
    retryNetworkErrors: !onOutput,
    onRetry: onOutput ? async event => onOutput(JSON.stringify({summary:`Microsoft Foundry returned HTTP ${event.status}. Waiting ${Math.ceil(event.delayMs/1000)}s before request attempt ${event.attempt} of 3. No generated code received from this request.`,changes:[]})) : undefined,
    timeoutMs: onOutput ? 600_000 : 120_000,
    operation: "foundry.transformation",
  });
  if (!response.ok) { await response.body?.cancel(); throw new FoundryRequestError(response.status); }
  let plan: GeneratedPlan;
  try {
    let content: string | undefined;
    if (onOutput) content = await readFoundryStream(response, onOutput);
    else {
      const payload = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }> };
      const choice = payload.choices?.[0];
      if (choice?.finish_reason === "length") throw new IncompleteGenerationError();
      if (choice?.finish_reason && choice.finish_reason !== "stop") throw new Error(`Foundry generation stopped: ${choice.finish_reason}.`);
      content = choice?.message?.content;
    }
    if (!content) throw new IncompleteGenerationError();
    plan = planSchema.parse(JSON.parse(content));
    if(input.options.requireCoordinationContract)coordinationContractSchema.parse(plan.contract);
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof z.ZodError || error instanceof IncompleteGenerationError)) throw error;
    const detail=error instanceof z.ZodError?error.issues.slice(0,6).map(issue=>`${issue.path.join(".")||"response"}: ${issue.message}`).join("; ").slice(0,1200):error instanceof IncompleteGenerationError?"The model response was incomplete.":"The response was not syntactically valid JSON.";
    if (correctionFeedback) throw new InvalidGeneratedPlanError(detail);
    const feedback = `The response was not a complete valid JSON plan matching the required schema. ${detail} Regenerate complete files with correctly escaped JSON strings.${input.options.requireCoordinationContract?" The root JSON object MUST contain a contract property matching the coordination schema, alongside summary and changes.":""}`;
    if (onOutput) await onOutput(JSON.stringify({summary:"Invalid or incomplete model output rejected. Requesting one complete replacement proposal; no changes from this draft were accepted.",changes:[]}));
    return generateTransformationPlan(input, onOutput, feedback);
  }
  validateGeneratedPlan(plan, new Map(input.files.map((file) => [normalizeRepositoryPath(file.path), file.content])));
  try {
    assertModernizationScope(input.scope,plan.changes);
    assertAgentChangeAreas(policy.agent, plan.changes);
  } catch (error) {
    if (!(error instanceof AgentOwnershipError) || correctionFeedback) throw error;
    if (onOutput) await onOutput(JSON.stringify({summary:`Ownership validation rejected the draft: ${error.message}. Requesting one corrected proposal.`,changes:[]}));
    return generateTransformationPlan(input, onOutput, error.message);
  }
  return plan;
}

export function validateGeneratedPlan(plan: GeneratedPlan, source: Map<string, string>) {
  const paths = new Set<string>();
  for (const change of plan.changes) {
    change.path = normalizeRepositoryPath(change.path);
    if (paths.has(change.path)) throw new Error(`Duplicate generated path: ${change.path}`);
    paths.add(change.path);
    if (isForbiddenRepositoryPath(change.path)) throw new Error(`Generated path is blocked by policy: ${change.path}`);
    if(change.status==="added"&&source.has(change.path))throw new Error(`Added path already exists: ${change.path}`);
    if(change.status==="renamed"){
      if(!change.oldPath)throw new Error(`Rename requires original path: ${change.path}`);
      change.oldPath=normalizeRepositoryPath(change.oldPath);
      if(isForbiddenRepositoryPath(change.oldPath)||!source.has(change.oldPath)||source.has(change.path))throw new Error(`Invalid rename: ${change.oldPath} -> ${change.path}`);
      change.before=source.get(change.oldPath)!;
    }
    if (/\0/.test(change.after) || Buffer.byteLength(change.after, "utf8") > 200_000) throw new Error(`Generated content is unsafe or oversized: ${change.path}`);
    if (change.status === "modified" || change.status === "deleted") {
      const original = source.get(change.path);
      if (original === undefined) throw new Error(`Source consistency check failed: ${change.path}`);
      change.before = original;
    }
  }
}

export function normalizeRepositoryPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized||normalized.includes(":")||normalized.includes("\0")||normalized.startsWith("/") || normalized.split("/").some(part=>["..",".",""].includes(part))) throw new Error(`Unsafe repository path: ${path}`);
  return normalized;
}

export function isForbiddenRepositoryPath(path: string) {
  return /(^|\/)(\.git|node_modules|bin|obj|dist|build|\.next)(\/|$)|(^|\/)(\.env|.*\.(pfx|p12|key|pem|exe|dll|zip|jar))$/i.test(path);
}