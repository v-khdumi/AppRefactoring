import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../src/lib/env";
import { generateTransformationPlan } from "../src/lib/transformation-engine";
import { agentGenerationPolicy, AgentOwnershipError } from "../src/lib/agent-policy";

test("specialist prompts declare ownership without asking every agent to generate tests", () => {
  assert.match(agentGenerationPolicy("backend").instruction,/Every change.area must be one of: backend\./);
  assert.match(agentGenerationPolicy("backend").instruction,/do not generate test files/);
  assert.match(agentGenerationPolicy("testing").instruction,/Generate characterization and contract test files/);
  assert.throws(()=>agentGenerationPolicy("unknown"),/valid specialist/);
});

test("repairs the reported backend platform mismatch once and still rejects repeated violations", async () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = env.AZURE_AI_FOUNDRY_ENDPOINT;
  const originalKey = env.AZURE_AI_FOUNDRY_API_KEY;
  env.AZURE_AI_FOUNDRY_ENDPOINT = "https://example.test";
  env.AZURE_AI_FOUNDRY_API_KEY = "test-only";
  const input = {repository:"fixture/operations",scope:"backend",options:{agentType:"backend"},files:[]};
  const proposal = (area:string) => ({summary:"A conservative backend adapter proposal.",changes:[{path:area==="platform"?"modernization/operations/package.json":"src/backend/adapter.ts",status:"added",area,rationale:"Preserve the existing service contract.",before:"",after:"export const value = 1;",validation:[]}]});
  try {
    for (const repeated of [false,true]) {
      const prompts: string[] = [];
      globalThis.fetch = async (_url, options) => {
        prompts.push(JSON.parse(String(options?.body)).messages[0].content);
        return Response.json({choices:[{message:{content:JSON.stringify(proposal(prompts.length===1 || repeated ? "platform" : "backend"))}}]});
      };
      if (repeated) await assert.rejects(generateTransformationPlan(input),AgentOwnershipError);
      else assert.equal((await generateTransformationPlan(input)).changes[0].area,"backend");
      assert.equal(prompts.length,2);
      assert.match(prompts[1],/backend agent cannot own platform change: modernization\/operations\/package.json/);
      assert.match(prompts[0],/Do not relabel shared platform changes/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    env.AZURE_AI_FOUNDRY_ENDPOINT = originalEndpoint;
    env.AZURE_AI_FOUNDRY_API_KEY = originalKey;
  }
});