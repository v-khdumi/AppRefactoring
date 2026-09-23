import assert from "node:assert/strict";
import test from "node:test";
import { validationExecution } from "../src/lib/validation-execution";
import { approvalBlockReason } from "../src/lib/approval-state";
import { emptyLiveRun } from "../src/lib/execution-state";

test("generated validation assertions do not enable publication",()=>{
  assert.equal(validationExecution.status,"not-executed");
  const run={...emptyLiveRun("run"),status:"awaiting-approval" as const,sourceCommitSha:"a".repeat(40),agents:[{id:"test",type:"testing" as const,name:"Testing Agent",objective:"Generate tests",status:"passed" as const,progress:100,filesOwned:[]}],files:[{path:"test.ts",status:"added" as const,area:"tests" as const,additions:1,deletions:0,before:"",after:"test()",rationale:"Generated tests",validation:["All tests passed"]}]};
  assert.match(approvalBlockReason(run),/Run isolated verification/);
  assert.equal(approvalBlockReason({...run,mode:"demo"}),"");
});