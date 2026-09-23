import type { AgentType, ModernizationAgent, TransformationFile, TransformationRun } from "../types/modernization";

export const agentNames: Record<AgentType,string> = {architect:"Architecture Agent",frontend:"Frontend Agent",backend:"Backend Agent",cloud:"Cloud Readiness Agent",testing:"Testing Agent",security:"Security Agent"};

export function filterChanges(files: TransformationFile[], area: string, agent: string, query: string) {
  return files.filter(file => (area === "all" || file.area === area) && (agent === "all" || (agent === "unassigned" ? !file.agentType : file.agentType === agent)) && file.path.toLowerCase().includes(query.toLowerCase()));
}

export function agentActivityLabel(run: TransformationRun, agent?: ModernizationAgent, stale = false) {
  if (stale) return "Status refresh unavailable";
  if (run.status !== "running") return run.status.replaceAll("-", " ");
  if (!agent) return "Waiting for agent status";
  if (agent.error || agent.status === "blocked" || agent.status === "failed") return "Agent blocked";
  if (agent.status === "queued") return "Queued for processing";
  if (agent.status === "retrying") return "Retry scheduled";
  if (agent.status === "passed") return "Plan generation completed";
  if (agent.status !== "running") return agent.status.replaceAll("-", " ");
  return agent.output ? "Generation in progress; output received" : "Generation requested; waiting for output";
}