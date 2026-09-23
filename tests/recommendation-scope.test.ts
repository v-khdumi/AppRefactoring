import assert from "node:assert/strict";
import test from "node:test";
import {env} from "../src/lib/env";
import {recommendStack} from "../src/lib/stack-recommendation";
import {assertModernizationScope} from "../src/lib/agent-policy";
test("scope blocks other-layer changes even from unrestricted specialists",()=>{
 assert.throws(()=>assertModernizationScope("frontend",[{path:"backend/api.py",area:"platform"}]),/Selected scope/);
 assert.throws(()=>assertModernizationScope("backend",[{path:"src/components/UI.tsx",area:"frontend"}]),/Selected scope/);
 assert.doesNotThrow(()=>assertModernizationScope("frontend",[{path:"frontend/App.tsx",area:"frontend"}]));
 assert.doesNotThrow(()=>assertModernizationScope("fullstack",[{path:"backend/api.py",area:"backend"}]));
});
test("recommendations cannot override the selected scope",async context=>{
 const endpoint=env.AZURE_AI_FOUNDRY_ENDPOINT;const key=env.AZURE_AI_FOUNDRY_API_KEY;
 env.AZURE_AI_FOUNDRY_ENDPOINT="https://fixture.invalid";env.AZURE_AI_FOUNDRY_API_KEY="fixture";
 context.after(()=>{env.AZURE_AI_FOUNDRY_ENDPOINT=endpoint;env.AZURE_AI_FOUNDRY_API_KEY=key;});
 context.mock.method(globalThis,"fetch",async(_url:string,options:RequestInit)=>{
  const body=JSON.parse(String(options.body));const input=JSON.parse(body.messages[1].content);
  assert.match(body.messages[0].content,new RegExp(`user selected ${input.scope}`));
  return Response.json({choices:[{message:{content:JSON.stringify({scope:"fullstack",rationale:["Use supplied evidence"]})}}]});
 });
 for(const scope of ["frontend","backend","fullstack"] as const){
  const result=await recommendStack({repository:"owner/repo",scope,paths:["main.py","ui.tsx"],samples:[]});
  assert.equal(result.scope,scope);
 }
});