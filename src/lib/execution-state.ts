import type { TransformationRun } from "../types/modernization";

export function emptyLiveRun(id: string): TransformationRun {
  return { id, name: "Loading transformation", repository: "", branch: "", targetBranch: "", mode: "live", status: "queued", progress: 0, currentStage: "Waiting for server state", stages: [], files: [], agents: [] };
}

export function cleanWorkspaceUrl(value: string) {
  const url = new URL(value);
  url.searchParams.delete("demo-handshake-final");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function mergeRunSnapshot(current: TransformationRun, latest: TransformationRun): TransformationRun {
  if (current.id !== latest.id || current.mode !== latest.mode) return latest;
  if ((latest.version ?? 0) < (current.version ?? 0)) return current;
  if (latest.currentStage === "verification-required") return latest;
  const newAttempt = Boolean(latest.attemptStartedAt && latest.attemptStartedAt !== current.attemptStartedAt);
  const restarting = latest.status === "queued" || latest.status === "retrying";
  if (newAttempt || restarting) return latest;
  return {
    ...latest,
    progress: Math.max(current.progress, latest.progress),
    stages: latest.stages.map(stage => {
      const previous = current.stages.find(candidate => candidate.id === stage.id);
      return previous && stage.status === previous.status ? {...stage,progress:Math.max(previous.progress,stage.progress)} : stage;
    }),
  };
}