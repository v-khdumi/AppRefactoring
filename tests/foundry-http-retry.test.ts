import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../src/lib/env";
import { FoundryRequestError, generateTransformationPlan } from "../src/lib/transformation-engine";

test("streaming retries HTTP failures before content, never resumes ambiguous network failures",async()=>{
  const originalFetch=globalThis.fetch;
  const originalEndpoint=env.AZURE_AI_FOUNDRY_ENDPOINT;
  const originalKey=env.AZURE_AI_FOUNDRY_API_KEY;
  env.AZURE_AI_FOUNDRY_ENDPOINT="https://example.test";
  env.AZURE_AI_FOUNDRY_API_KEY="test-only";
  const input={repository:"fixture/app",scope:"backend",options:{agentType:"backend"},files:[]};
  const plan={summary:"A conservative standalone backend adapter.",changes:[{path:"src/adapter.ts",status:"added",area:"backend",rationale:"Preserve the existing backend contract.",after:"export const adapter = true;",validation:[]}]};
  try {
    for(const mode of ["recover","exhaust","permanent","network"]){
      let calls=0;const snapshots:string[]=[];
      globalThis.fetch=async()=>{
        calls++;
        if(mode==="network")throw new TypeError("fetch failed");
        if(mode==="permanent" || mode==="exhaust" || calls<3)return new Response("Internal provider details",{status:mode==="permanent"?400:500,headers:{"Retry-After":"0"}});
        return new Response(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(plan)}}]})}\n\ndata: [DONE]\n\n`);
      };
      const operation=generateTransformationPlan(input,async output=>{snapshots.push(output);});
      if(mode==="recover")assert.equal((await operation).changes[0].after,plan.changes[0].after);
      else await assert.rejects(operation,mode==="network"?TypeError:FoundryRequestError);
      assert.equal(calls,mode==="permanent"||mode==="network"?1:3);
      assert.ok(snapshots.every(output=>!output.includes("Internal provider details")));
      if(mode==="recover")assert.ok(snapshots.some(output=>output.includes("attempt 3 of 3")));
    }
  }finally{globalThis.fetch=originalFetch;env.AZURE_AI_FOUNDRY_ENDPOINT=originalEndpoint;env.AZURE_AI_FOUNDRY_API_KEY=originalKey;}
});