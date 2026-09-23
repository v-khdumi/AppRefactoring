import assert from "node:assert/strict";
import test from "node:test";
import { RequestDeadlineError, withRequestDeadline } from "../src/lib/request-deadline";

test("bounds an operation even when authentication ignores cancellation", async () => {
  let requestSignal: AbortSignal | undefined;
  await assert.rejects(withRequestDeadline(signal => {
    requestSignal = signal;
    return new Promise(() => {});
  }, 20, "Analysis timed out"), error => error instanceof RequestDeadlineError && error.message === "Analysis timed out");
  assert.equal(requestSignal?.aborted, true);
});

test("deadline includes reading a stalled response body", async () => {
  await assert.rejects(withRequestDeadline(async () => {
    const response = new Response(new ReadableStream({ start() {} }));
    return response.json();
  }, 20, "Response timed out"), RequestDeadlineError);
});

test("returns successful results and preserves upstream errors", async () => {
  assert.deepEqual(await withRequestDeadline(async () => ({ id: "run-123" }), 1000, "Timed out"), { id: "run-123" });
  const failure = new Error("Repository access denied");
  await assert.rejects(withRequestDeadline(async () => { throw failure; }, 1000, "Timed out"), error => error === failure);
});