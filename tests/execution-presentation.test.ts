import assert from "node:assert/strict";
import test from "node:test";
import { filterChanges, agentActivityLabel } from "../src/lib/execution-presentation";
import { emptyLiveRun } from "../src/lib/execution-state";
import type { ModernizationAgent, TransformationFile } from "../src/types/modernization";

test("agent filtering intersects area and path filters and retains unassigned files",()=>{
  const files = [{path:"src/api.ts",area:"backend",agentType:"backend"},{path:"tests/api.ts",area:"tests",agentType:"testing"},{path:"docs/api.md",area:"platform"}] as TransformationFile[];
  assert.deepEqual(filterChanges(files,"all","testing","api"),[files[1]]);
  assert.deepEqual(filterChanges(files,"backend","testing",""),[]);
  assert.deepEqual(filterChanges(files,"all","unassigned",""),[files[2]]);
  assert.equal(filterChanges(files,"all","all","API").length,3);
});

test("old output never makes a stopped or queued agent appear active",()=>{
  const agent = {status:"running",output:"old output"} as ModernizationAgent;
  const run = {...emptyLiveRun("run"),status:"running" as const};
  assert.equal(agentActivityLabel({...run,status:"failed"},agent),"failed");
  assert.equal(agentActivityLabel(run,{...agent,status:"queued"}),"Queued for processing");
  assert.equal(agentActivityLabel(run,{...agent,status:"passed"}),"Plan generation completed");
  assert.equal(agentActivityLabel(run,agent,true),"Status refresh unavailable");
});