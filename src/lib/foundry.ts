import type { AnalysisResult, ModernizationOptions } from "@/types/modernization";
import { estimateModernization } from "@/lib/estimation";
import { resilientFetch } from "@/lib/resilient-fetch";
import { foundryModelParameters } from "@/lib/foundry-model";

interface FoundryInput {
  repositoryName: string;
  branch: string;
  languages: Record<string, number>;
  files: string[];
  samples: Array<{ path: string; content: string }>;
  options: ModernizationOptions;
  evidence?:import("./repository-evidence").RepositoryEvidence;
}

export function isFoundryConfigured() {
  return Boolean(process.env.AZURE_AI_FOUNDRY_ENDPOINT && process.env.AZURE_AI_FOUNDRY_API_KEY);
}

export async function analyzeWithFoundry(input: FoundryInput, signal?: AbortSignal): Promise<AnalysisResult> {
  const endpoint = process.env.AZURE_AI_FOUNDRY_ENDPOINT?.replace(/\/$/, "");
  const apiKey = process.env.AZURE_AI_FOUNDRY_API_KEY;
  const model = process.env.AZURE_AI_FOUNDRY_MODEL || "gpt-6-astra";
  const apiVersion = process.env.AZURE_AI_FOUNDRY_API_VERSION || "2024-05-01-preview";
  if (!endpoint || !apiKey) throw new Error("Microsoft Foundry is not configured.");

  const system = `You are a principal software modernization architect. Analyze legacy code without inventing behavior. Return strict JSON matching this shape: {summary:string, confidence:number 0-100, currentArchitecture:Array<{id,label,detail,kind}>, targetArchitecture:Array<{id,label,detail,kind}>, findings:Array<{title,detail,severity,file?}>, recommendations:string[], migrationPhases:Array<{title,description,duration}>, behaviorContracts:string[]}. kind must be client|service|data|integration|cloud; severity must be critical|high|medium|low. Preserve existing behavior, flag uncertainty, recommend incremental strangler migrations and characterization tests. Do not include markdown.`;
  const response = await resilientFetch(`${endpoint}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      model,
      ...foundryModelParameters(model,0.1),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `${system} The selected scope is ${input.options.scope}. Do not propose rewriting layers outside this scope. Retain external layers as unchanged dependencies in the proposed architecture. Evaluate declared dependencies, runtime constraints, shared projects, lockfile coverage, API/schema contracts and compatibility risks from the evidence. Do not claim complete dependency analysis or executed compatibility checks. Explicitly list missing evidence and distinguish proposed components from existing ones.` },
        { role: "user", content: JSON.stringify(input) },
      ],
    }),
    attempts: 1,
    timeoutMs: 150_000,
    signal,
    operation: "foundry.analysis",
  });
  if (!response.ok) throw new Error(`Microsoft Foundry returned status ${response.status}.`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("The model did not return an analysis.");
  let parsed: Omit<AnalysisResult, "mode" | "repository">;
  try {
    parsed = JSON.parse(content) as Omit<AnalysisResult, "mode" | "repository">;
  } catch {
    throw new Error("Microsoft Foundry returned an invalid analysis. Retry the analysis.");
  }
  const result:AnalysisResult = {
    ...parsed,
    mode: "live",
    repository: {
      name: input.repositoryName,
      branch: input.branch,
      files: input.files.length,
      languages: input.languages,
    },
  };
  result.estimate=estimateModernization({files:input.files.length,findings:result.findings,options:input.options});
  return result;
}