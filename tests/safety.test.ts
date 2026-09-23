import assert from "node:assert/strict";
import test from "node:test";
import { isForbiddenRepositoryPath, normalizeRepositoryPath, validateGeneratedPlan, type GeneratedPlan } from "../src/lib/transformation-engine";
import { parseGitHubUrl } from "../src/lib/github";

test("parses canonical GitHub repository URLs", () => {
  assert.deepEqual(parseGitHubUrl("https://github.com/contoso/orders.git"), { owner: "contoso", repo: "orders" });
  assert.throws(() => parseGitHubUrl("https://example.com/contoso/orders"));
});

test("rejects traversal and protected paths", () => {
  assert.throws(() => normalizeRepositoryPath("../secrets.txt"));
  assert.equal(isForbiddenRepositoryPath(".env"), true);
  assert.equal(isForbiddenRepositoryPath("src/server.ts"), false);
  assert.equal(isForbiddenRepositoryPath("dist/app.js"), true);
});

test("binds modifications to the authoritative source snapshot", () => {
  const plan: GeneratedPlan = { summary: "A sufficiently detailed safe transformation plan.", changes: [{ path: "src/app.ts", status: "modified", area: "backend", rationale: "Preserve the route while extracting business logic safely.", before: "wrong", after: "new", validation: ["contract test"] }] };
  assert.doesNotThrow(() => validateGeneratedPlan(plan, new Map([["src/app.ts", "original"]])));
  assert.equal(plan.changes[0].before,"original");
  assert.throws(() => validateGeneratedPlan(plan, new Map()), /consistency/);
});