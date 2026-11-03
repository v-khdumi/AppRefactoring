export interface WorkerHeartbeat {
  worker_name: string;
  status: string;
  last_seen_at: string;
  fresh: boolean;
}

export interface QueueHealth {
  status: "healthy" | "unavailable";
  activeMessages?: number;
  deadLetterMessages?: number;
  scheduledMessages?: number;
}

export function operationallyReady(workers: WorkerHeartbeat[] | undefined, queue: QueueHealth | undefined) {
  return ["transformation", "outbox"].every(name =>
    workers?.some(worker => worker.worker_name === name && worker.fresh && worker.status === "healthy"),
  ) && queue?.status === "healthy" && queue.deadLetterMessages === 0;
}
