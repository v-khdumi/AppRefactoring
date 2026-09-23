import assert from "node:assert/strict";
import test from "node:test";
import { requestJson } from "../src/lib/request-json";

test("reports the observed stream timeout instead of a JSON parser error", async () => {
  for (const status of [200, 503, 504]) {
    await assert.rejects(requestJson(async () => new Response("stream timeout", { status }), "/api/analysis", {}, 1000, "Architecture analysis timed out. No run was queued."), /Architecture analysis timed out/);
  }
});

test("handles HTML gateway errors and empty responses without exposing parser errors", async () => {
  for (const body of ["<html>Bad Gateway</html>", ""]) {
    await assert.rejects(requestJson(async () => new Response(body, { status: 502 }), "/api/analysis", {}, 1000, "Timed out"), /unreadable response \(HTTP 502\)/);
  }
});

test("preserves API errors and parses successful JSON", async () => {
  await assert.rejects(requestJson(async () => Response.json({ error: "Repository access denied" }, { status: 403 }), "/api/analysis", {}, 1000, "Timed out"), /Repository access denied/);
  assert.deepEqual(await requestJson(async () => Response.json({ id: "run-123" }), "/api/transformations", {}, 1000, "Timed out"), { id: "run-123" });
});

test("does not retry a POST whose outcome is unknown", async () => {
  let calls = 0;
  await assert.rejects(requestJson(async (_input, init) => {
    calls += 1;
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal);
    return new Promise(() => {});
  }, "/api/transformations", { method: "POST" }, 20, "Check Modernizations before retrying."), /Check Modernizations/);
  assert.equal(calls, 1);
});