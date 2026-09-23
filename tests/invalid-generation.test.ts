import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../src/lib/env";
import { generateTransformationPlan, InvalidGeneratedPlanError } from "../src/lib/transformation-engine";

const input = {repository:"fixture/app",scope:"backend",options:{agentType:"backend"},files:[{path:"src/service.ts",content:"export const original = true;"}]};
const valid = {summary:"Preserve the service contract with a typed adapter.",changes:[{path:"src/service.ts",status:"modified",area:"backend",rationale:"Retain all existing service behavior.",before:"",after:"export const original = true;\nexport const adapter = true;",validation:[]}]};
const incomplete = '{"summary":"Proposed service adapter", "changes":[{"after":"unterminated';

test("invalid generation is replaced once, never patched into an accepted plan", async () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;
  const originalKey = env.AZURE_AI_FOUNDRY_API_KEY;
  env.AZURE_AI_FOUNDRY_ENDPOINT = "https://example.test";
  env.AZURE_AI_FOUNDRY_API_KEY = "test-only";
  try {
    for (const streaming of [false,true]) {
      for (const mode of ["recover","repeat","schema","length","ownership","unsafe"] as const) {
        let calls = 0;
        const snapshots: string[] = [];
        globalThis.fetch = async (_url, options) => {
          calls++;
          const request = JSON.parse(String(options?.body));
          if (calls === 2) assert.match(request.messages[0].content,/final correction attempt/);
          const proposal = calls === 2 && mode === "ownership" ? {...valid,changes:valid.changes.map(change=>({...change,area:"platform"}))} :
            calls === 2 && mode === "unsafe" ? {...valid,changes:valid.changes.map(change=>({...change,path:"../escape.ts"}))} : valid;
          const content = calls === 1 || mode === "repeat" ? (mode === "schema" ? '{"summary":123,"changes":[]}' : incomplete) : JSON.stringify(proposal);
          const finish = mode === "length" && calls === 1 ? "length" : "stop";
          if (streaming) return new Response(`data: ${JSON.stringify({choices:[{delta:{content}}]})}\n\ndata: ${JSON.stringify({choices:[{finish_reason:finish}]})}\n\ndata: [DONE]\n\n`,{headers:{"Content-Type":"text/event-stream"}});
          return Response.json({choices:[{message:{content},finish_reason:finish}]});
        };
        const operation = generateTransformationPlan(input,streaming ? async output=>{snapshots.push(output);} : undefined);
        if (mode === "repeat") await assert.rejects(operation,InvalidGeneratedPlanError);
        else if (mode === "ownership") await assert.rejects(operation,/cannot own platform/);
        else if (mode === "unsafe") await assert.rejects(operation,/Unsafe repository path/);
        else {
          const plan = await operation;
          assert.equal(plan.changes[0].before,input.files[0].content);
          assert.equal(plan.changes[0].after,valid.changes[0].after);
        }
        assert.equal(calls,2,`${mode} must share one correction budget`);
        if (streaming) assert.ok(snapshots.some(output=>output.includes("no changes from this draft were accepted")));
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
    env.AZURE_AI_FOUNDRY_ENDPOINT = originalEndpoint;
    env.AZURE_AI_FOUNDRY_API_KEY = originalKey;
  }
});