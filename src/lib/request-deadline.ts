export class RequestDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestDeadlineError";
  }
}

export async function withRequestDeadline<Result>(
  operation: (signal: AbortSignal) => Promise<Result>,
  timeoutMs: number,
  message: string,
): Promise<Result> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new RequestDeadlineError(message);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}