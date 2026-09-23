import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "partial-json";

test("partial file previews decode newlines without waiting for complete plan JSON", () => {
  const preview = parse('{"summary":"Add an adapter","changes":[{"path":"src/adapter.ts","rationale":"Preserve callers","after":"export const value = 1;\\nexport');
  assert.equal(preview.changes[0].path, "src/adapter.ts");
  assert.equal(preview.changes[0].after, "export const value = 1;\nexport");
});