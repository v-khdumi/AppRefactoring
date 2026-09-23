type AgentEvidence = { agent_type: string; status: string; has_output?: boolean };

export function planningProgress(status: string, stage: string, stored: number, scope: string, agents: AgentEvidence[]) {
  if (status !== "running" || stage !== "parallel-agent-planning") return stored;
  const relevant = agents.filter(agent => !(scope === "frontend" && agent.agent_type === "backend") && !(scope === "backend" && agent.agent_type === "frontend"));
  if (!relevant.length) return stored;
  const milestones = relevant.reduce((total, agent) => total + (agent.status === "passed" ? 1 : agent.has_output ? 0.5 : agent.status === "running" ? 0.1 : 0), 0);
  return Math.max(stored, Math.min(74, 35 + Math.floor(39 * milestones / relevant.length)));
}

export function canDeleteRun(status: string) {
  return ["failed", "cancelled", "rejected", "pull-request-created", "awaiting-approval", "blocked", "publication-failed"].includes(status);
}