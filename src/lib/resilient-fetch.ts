import { logEvent } from "@/lib/structured-log";

type ResilientFetchOptions = RequestInit & {
  attempts?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  operation?: string;
  correlationId?: string;
  retryNetworkErrors?: boolean;
  onRetry?: (event: {attempt:number;delayMs:number;status?:number}) => Promise<void>;
};

const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryDelay(response: Response | undefined, attempt: number, baseDelayMs: number) {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  return Math.min(baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250), 10_000);
}

export async function resilientFetch(url: string, options: ResilientFetchOptions = {}) {
  const { attempts = 3, timeoutMs = 30_000, baseDelayMs = 500, operation = "http.request", correlationId, retryNetworkErrors = true, onRetry, ...request } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response | undefined;
    try {
      request.signal?.throwIfAborted();
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;
      response = await fetch(url, { ...request, signal });
      if (!retryableStatuses.has(response.status) || attempt === attempts - 1) return response;
      lastError = new Error(`${operation} returned ${response.status}.`);
    } catch (error) {
      if (request.signal?.aborted) throw request.signal.reason;
      if (!retryNetworkErrors) throw error;
      lastError = error;
      if (attempt === attempts - 1) break;
    }
    const delayMs = retryDelay(response, attempt, baseDelayMs);
    await response?.body?.cancel();
    logEvent("warn", "http.retry", { operation, correlationId, attempt: attempt + 1, delayMs, status: response?.status, error: lastError });
    await onRetry?.({attempt:attempt+2,delayMs,status:response?.status});
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw lastError instanceof Error ? lastError : new Error(`${operation} failed after ${attempts} attempts.`);
}
