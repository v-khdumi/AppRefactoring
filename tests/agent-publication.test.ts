import assert from "node:assert/strict";
import test from "node:test";
import {agentPublication,canRefineRun} from "../src/lib/agent-publication";
import {emptyLiveRun} from "../src/lib/execution-state";
import type {ModernizationAgent,TransformationRun} from "../src/types/modernization";
const change={path:"docs/architecture/README.md",after:"Reviewed architecture",status:"added" as const};
const agent:ModernizationAgent={id:"architect",type:"architect",name:"Architecture Agent",objective:"Design",status:"blocked",error:"Old invalid JSON error",progress:0,filesOwned:[change.path],output:JSON.stringify({changes:[change]})};
const run:TransformationRun={...emptyLiveRun("run"),status:"pull-request-created",pullRequestUrl:"https://github.com/owner/repo/pull/1",validationExecution:{status:"passed",changesetDigest:"a".repeat(64),reason:"Executed",steps:[]},files:[{...change,agentType:"architect",area:"platform",before:"",rationale:"Design",validation:["Executed"],additions:1,deletions:0}]};
test("published content is confirmed without erasing contradictory error history",()=>{
 assert.deepEqual(agentPublication(agent,run),{paths:[change.path],complete:true});
 assert.equal(agent.error,"Old invalid JSON error");assert.equal(agent.status,"blocked");
});
test("draft, malformed, changed, unowned or unverified output is never marked published",()=>{
 for(const candidate of [{...run,status:"approved" as const},{...run,pullRequestUrl:undefined},{...run,validationExecution:undefined},{...run,files:[{...run.files[0],after:"Different"}]},{...run,files:[{...run.files[0],agentType:"cloud" as const}]},{...run,files:[{...run.files[0],userModified:true}]}])assert.equal(agentPublication(agent,candidate).complete,false);
 assert.equal(agentPublication({...agent,output:agent.output?.slice(0,-1)},run).complete,false);
 assert.equal(agentPublication({...agent,output:JSON.stringify({changes:[change,change]})},run).complete,false);
});
test("partial publication is identified per file, never as a complete proposal",()=>{
 const result=agentPublication({...agent,output:JSON.stringify({changes:[change,{...change,path:"docs/missing.md"}]})},run);
 assert.deepEqual(result,{paths:[change.path],complete:false});
});
test("approved and published runs cannot accept agent refinements",()=>{
 for(const status of ["approved","publication-failed","pull-request-created","cancelled"] as const)assert.equal(canRefineRun(status),false);
 assert.equal(canRefineRun("awaiting-approval"),true);assert.equal(canRefineRun("blocked"),true);
});