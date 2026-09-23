import assert from "node:assert/strict";
import test from "node:test";
import {coordinatedGeneration,generationSequence,type GeneratedChange} from "../src/lib/generation-workflow";
import {coordinationContractPath,type CoordinationContract} from "../src/lib/coordination-contract";
const contract:CoordinationContract={version:1,scope:"fullstack",projects:[{id:"api",directory:"backend",runtime:"python",area:"backend",responsibility:"Local authenticated API"},{id:"ui",directory:"frontend",runtime:"npm",area:"frontend",responsibility:"Existing browser experience"}],interfaces:[{id:"session",provider:"api",consumers:["ui"],protocol:"http",definition:"GET /api/session returns {running:boolean}; POST /api/session/start starts capture.",authentication:"Same-origin authenticated session",verification:"Execute frontend requests against the actual backend test server."}],preservedBehavior:[{id:"export",requirement:"Transcript exports retain UTF-8 content.",verification:"Compare baseline and candidate exported contents."}]};
const change=(path:string,area:GeneratedChange["area"],after:string,status:GeneratedChange["status"]="added"):GeneratedChange=>({path,area,after,status,before:"",rationale:"Preserve the documented contract and behavior.",validation:[]});
test("implementation agents share accepted code; testing sees the final candidate",async()=>{
 const seen:string[]=[];
 const result=await coordinatedGeneration({scope:"fullstack",cloudReady:true,source:[{path:"backend/api.py",content:"original"}],generate:async context=>{
  seen.push(context.agent);
  if(context.agent==="architect")return {summary:"Shared contracts established for both projects.",contract,changes:[]};
  assert.deepEqual(context.contract,contract);
  assert.ok(context.files.some(file=>file.path===coordinationContractPath));
  if(context.agent==="backend")return {summary:"Backend implements the exact shared contract.",changes:[change("backend/api.py","backend","GET /api/session","modified")]};
  if(context.agent==="frontend"){
   assert.equal(context.files.find(file=>file.path==="backend/api.py")?.content,"GET /api/session");
   return {summary:"Frontend consumes the implemented backend endpoint.",changes:[change("frontend/api.ts","frontend","fetch('/api/session')")]};
  }
  if(context.agent==="security")return {summary:"Existing backend errors sanitized without contract changes.",changes:[change("backend/api.py","backend","GET /api/session secure","modified")]};
  if(context.agent==="testing"){
   assert.equal(context.files.find(file=>file.path==="backend/api.py")?.content,"GET /api/session secure");
   assert.equal(context.files.find(file=>file.path==="frontend/api.ts")?.content,"fetch('/api/session')");
   assert.ok(context.preceding.some(item=>item.agent==="security"));
  }
  return {summary:"Reviewed the candidate; no additional changes needed.",changes:[]};
 }});
 assert.deepEqual(seen,["architect","backend","frontend","cloud","security","testing"]);
 const merged=result.changes.find(item=>item.change.path==="backend/api.py")!;
 assert.equal(merged.change.before,"original");assert.equal(merged.change.after,"GET /api/session secure");assert.equal(merged.agent,"backend");
});
test("partial scopes omit other implementation agents and optional cloud work",()=>{
 assert.deepEqual(generationSequence("frontend",false),["architect","frontend","security","testing"]);
 assert.deepEqual(generationSequence("backend",false),["architect","backend","security","testing"]);
});
test("scope changes, invalid shared contracts and conflicting writes stop generation",async()=>{
 await assert.rejects(coordinatedGeneration({scope:"frontend",cloudReady:false,source:[],generate:async()=>({summary:"Wrong scope contract must never be used.",contract,changes:[]})}),/cannot expand/);
 await assert.rejects(coordinatedGeneration({scope:"fullstack",cloudReady:false,source:[],generate:async context=>context.agent==="architect"?{summary:"Plan",contract,changes:[]}:{summary:"Edit",changes:[change(coordinationContractPath,"platform","replacement","modified")]}}));
});
test("cancellation is checked between stages before any accepted result",async()=>{
 let checks=0;let accepted=0;
 await assert.rejects(coordinatedGeneration({scope:"fullstack",cloudReady:false,source:[],assertActive:async()=>{if(++checks===2)throw Error("Cancelled");},generate:async()=>({summary:"Plan",contract,changes:[]}),onAccepted:async()=>{accepted++;}}),/Cancelled/);
 assert.equal(accepted,0);
});

test("original tests cannot be deleted and lockfiles cannot come from model output",async()=>{
    const source=[{path:coordinationContractPath,content:JSON.stringify(contract)},{path:"tests/original.cjs",content:"original assertion"}];
    for(const proposed of [change("tests/original.cjs","tests","original assertion","deleted"),change("package-lock.json","platform","{}")]){
        await assert.rejects(coordinatedGeneration({scope:"fullstack",cloudReady:false,source,stages:["security"],generate:async()=>({summary:"Rejected proposal must not be applied.",changes:[proposed]})}),/Original tests|isolated package manager/);
    }
});

test("refinement retains original diffs and does not mutate the caller's stage list",async()=>{
    const stages=["testing"] as const;
    const mutableStages:["testing"]=[...stages];
    const result=await coordinatedGeneration({scope:"fullstack",cloudReady:false,source:[{path:"backend/api.py",content:"source implementation"}],initialChanges:[{agent:"backend",change:{...change("backend/api.py","backend","reviewed candidate","modified"),before:"source implementation"}}],stages:mutableStages,generate:async context=>{
        assert.equal(context.files.find(file=>file.path==="backend/api.py")?.content,"reviewed candidate");
        return context.agent==="architect"?{summary:"Contract reconstructed for explicit review.",contract,changes:[]}:{summary:"Existing candidate tested without changes.",changes:[]};
    }});
    assert.deepEqual(mutableStages,stages);
    assert.equal(result.changes.find(item=>item.change.path==="backend/api.py")?.change.before,"source implementation");
    await assert.rejects(coordinatedGeneration({scope:"frontend",cloudReady:false,source:[{path:coordinationContractPath,content:JSON.stringify(contract)}],stages:["testing"],generate:async()=>{throw Error("Must not invoke the model");}}),/does not match the selected scope/);
});