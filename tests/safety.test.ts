import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("verification dispatch and infrastructure use the same immutable image", () => {
  const service = readFileSync(new URL("../src/lib/verification-service.ts", import.meta.url), "utf8");
  const infrastructure = readFileSync(new URL("../infra/verification.bicep", import.meta.url), "utf8");
  const imagePattern = /node:22-bookworm-slim@sha256:[a-f0-9]{64}/;
  const serviceImage = service.match(imagePattern)?.[0];
  assert.ok(serviceImage);
  assert.equal(infrastructure.match(imagePattern)?.[0], serviceImage);
});

test("application runtime images are immutable and omit installation tooling", () => {
  for (const filename of ["Dockerfile", "Dockerfile.worker", "Dockerfile.outbox"]) {
    const dockerfile = readFileSync(new URL(`../${filename}`, import.meta.url), "utf8");
    const stages = dockerfile.split(/\r?\n/).filter(line => line.startsWith("FROM "));
    assert.ok(stages.length);
    for (const stage of stages) assert.match(stage, /@sha256:[a-f0-9]{64}(?: AS \w+)?$/);
    assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules\/npm/);
    if (filename !== "Dockerfile") assert.match(dockerfile, /npm ci --omit=dev/);
  }
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.ok(manifest.dependencies.tsx);
  assert.notEqual(lock.packages["node_modules/tsx"].dev, true);
});