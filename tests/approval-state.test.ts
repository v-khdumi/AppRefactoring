import assert from "node:assert/strict";
import test from "node:test";
import { approvalBlockReason } from "../src/lib/approval-state";
import { emptyLiveRun } from "../src/lib/execution-state";
import type { TransformationRun } from "../src/types/modernization";

function readyRun(): TransformationRun {
  return {...emptyLiveRun("run"),status:"awaiting-approval",currentStage:"human-approval",sourceCommitSha:"a".repeat(40),agents:[{id:"testing",type:"testing",name:"Testing Agent",objective:"Review",status:"passed",progress:100,filesOwned:[]}],files:[{path:"src/service.ts",status:"modified",area:"backend",before:"before",after:"after",additions:1,deletions:1,rationale:"Preserve contract",validation:["Evidence"]}]};
}

test("blocks approval during the reported user edit revalidation state",()=>{
  const run = readyRun();
  run.status="running";
  run.currentStage="testing-user-edit";
  run.files[0].userModified=true;
  assert.match(approvalBlockReason(run),/being revalidated/);
});

test("all files and Testing Agent must pass, regardless of the visible file filter",()=>{
  const run=readyRun();
  assert.match(approvalBlockReason(run),/Build and tests have not been verified/);
  assert.equal(approvalBlockReason({...run,validationExecution:{status:"passed",changesetDigest:"b".repeat(64),reason:"Executed",steps:[]}}),"");
  test("verification errors remain actionable instead of being hidden by a generic blocked run",()=>{
    const run={...readyRun(),status:"blocked" as const,currentStage:"verification-required"};
    assert.match(approvalBlockReason({...run,validationExecution:{status:"failed",reason:"npm test exited 1",steps:[]}}),/npm test exited 1/);
    assert.match(approvalBlockReason({...run,validationExecution:{status:"running",reason:"Installing",steps:[]}}),/in progress/);
    assert.match(approvalBlockReason({...readyRun(),validationExecution:{status:"passed",reason:"Executed",steps:[]}}),/identifier is missing/);
  });
  run.files.push({...run.files[0],path:"src/other.ts",validation:[]});
  assert.match(approvalBlockReason(run),/1 file/);
  run.files.pop();
  run.agents![0].status="running";
  assert.match(approvalBlockReason(run),/Testing Agent/);
});

test("missing source, empty changes and already-approved runs cannot be submitted",()=>{
  const run=readyRun();
  assert.match(approvalBlockReason({...run,sourceCommitSha:undefined}),/source commit/);
  assert.match(approvalBlockReason({...run,files:[]}),/No generated changes/);
  assert.match(approvalBlockReason({...run,status:"approved"}),/already recorded/);
  assert.match(approvalBlockReason({...run,status:"publication-failed"}),/already recorded/);
  assert.match(approvalBlockReason({...run,status:"failed"}),/awaiting human review/);
});