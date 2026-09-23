import type { AgentType } from "@/types/modernization";

type ChangeArea="frontend"|"backend"|"platform"|"tests";

const allowedAreas:Partial<Record<AgentType,ChangeArea[]>>={
  architect:["platform"],
  frontend:["frontend"],
  backend:["backend"],
  cloud:["platform"],
  testing:["tests","platform"],
};

export class AgentOwnershipError extends Error {}
export function assertModernizationScope(scope:string,changes:Array<{path:string;area:ChangeArea}>){
  const invalid=changes.find(change=>scope==="frontend"&&(change.area==="backend"||/^(backend|services\/backend)\//i.test(change.path))||scope==="backend"&&(change.area==="frontend"||/^(frontend|src\/components)\//i.test(change.path)));
  if(invalid)throw new AgentOwnershipError(`Selected scope ${scope} does not permit ${invalid.area} change: ${invalid.path}`);
}

export function agentGenerationPolicy(value: unknown) {
  if (typeof value !== "string" || !["architect","frontend","backend","cloud","testing","security"].includes(value)) throw new Error("A valid specialist agent is required for generation.");
  const agent = value as AgentType;
  const areas = allowedAreas[agent] || ["frontend","backend","platform","tests"];
  const testing = agent === "testing" ? "Generate characterization and contract test files against the final candidate, including cross-project integration. Every new npm or Python project needs a discoverable suite. Wire npm build and test scripts and test devDependencies; use area platform only for package.json, requirements-dev.txt, pyproject.toml, pytest.ini or vitest.config.* test configuration. Preserve all runtime dependencies and existing tests. Cover shared coordination contracts. Do not use dummy successful scripts, passWithNoTests, unconditional skips or weaken original assertions. Python uses unittest tests/test_*.py; test-only packages belong in per-project requirements-dev.txt with exact pins (httpx, pytest, hypothesis, coverage or pytest-cov). npm tests run with npm test -- --run. Prefer Vitest for new npm characterization tooling so the baseline sandbox can install it without rewriting runtime dependencies." : "Describe required tests in your public summary; do not generate test files owned by the Testing Agent.";
  return { agent, instruction: `You are the ${agent} specialist. Every change.area must be one of: ${areas.join(", ")}. ${testing} Service-local manifests and dependencies may use backend only when they belong exclusively to the backend service; frontend-local manifests may use frontend only when exclusively frontend. Shared workspace manifests, deployment, infrastructure and operations configuration belong to platform. Do not relabel shared platform changes to bypass ownership. Omit work outside your permitted areas and describe the required handoff in summary. Only propose files needed for your specialist objective.` };
}

export function assertAgentChangeAreas(agent:AgentType,changes:Array<{path:string;area:ChangeArea}>){
  if(agent==="testing"){
    const invalid=changes.find(change=>change.area==="platform"&&!/(^|\/)(package\.json|requirements-dev\.txt|pyproject\.toml|pytest\.ini|vitest\.config\.[^/]+)$/.test(change.path));
    if(invalid)throw new AgentOwnershipError(`Testing Agent cannot modify runtime platform file: ${invalid.path}`);
  }
  const allowed=allowedAreas[agent];
  if(!allowed)return;
  const invalid=changes.find(change=>!allowed.includes(change.area));
  if(invalid)throw new AgentOwnershipError(`${agent} agent cannot own ${invalid.area} change: ${invalid.path}`);
}

export function claimAgentPath(owners:Map<string,AgentType>,path:string,agent:AgentType){
  const existing=owners.get(path);
  if(existing)throw new Error(`Agent ownership conflict on ${path}: ${existing} and ${agent}`);
  owners.set(path,agent);
}
