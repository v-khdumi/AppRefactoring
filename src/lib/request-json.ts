import { withRequestDeadline } from "./request-deadline";

export async function requestJson<Result>(
  authorizedFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<Result> {
  return withRequestDeadline(async signal => {
    const response = await authorizedFetch(url, { ...init, signal });
    const text = await response.text();
    if (response.status === 408 || response.status === 504 || text.trim().toLowerCase() === "stream timeout") {
      throw new Error(timeoutMessage);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`The server returned an unreadable response (HTTP ${response.status}). Please try again later.`);
    }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error : `The request failed (HTTP ${response.status}).`;
      throw new Error(message);
    }
    return payload as Result;
  }, timeoutMs, timeoutMessage);
}