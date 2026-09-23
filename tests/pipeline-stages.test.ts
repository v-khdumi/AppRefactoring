import assert from "node:assert/strict";
import test from "node:test";
import { pipelineStages } from "../src/lib/pipeline-stages";

test("revalidation shows Testing Agent state and leaves human approval queued",()=>{
  const stages=pipelineStages("running","testing-user-edit","queued",0);
  assert.equal(stages.find(stage=>stage.id==="testing-user-edit")?.status,"queued");
  assert.equal(stages.find(stage=>stage.id==="human-approval")?.status,"queued");
  assert.equal(stages.find(stage=>stage.id==="persisting-changes")?.status,"passed");
});
test("terminal run cannot display an active stage and completed publication is passed",()=>{
  assert.equal(pipelineStages("failed","parallel-agent-planning")[1].status,"failed");
  assert.ok(pipelineStages("failed","failed").every(stage=>stage.status!=="running"));
  assert.ok(pipelineStages("pull-request-created","completed").every(stage=>stage.status==="passed"));
  assert.equal(pipelineStages("approved","human-approval").at(-1)?.status,"queued");
});

test("missing execution verification blocks the verification stage and leaves approval queued",()=>{
  const stages=pipelineStages("blocked","verification-required");
  assert.equal(stages.find(stage=>stage.id==="verification-required")?.status,"blocked");
  assert.equal(stages.find(stage=>stage.id==="human-approval")?.status,"queued");
});

test("coordinated agents appear active without implying validation or approval",()=>{
  for(const agent of ["architect","backend","frontend","cloud","security","testing"]){
    const stages=pipelineStages("running",`coordinated-agent-${agent}`);
    assert.equal(stages[0].status,"passed");
    assert.equal(stages[1].id,`coordinated-agent-${agent}`);
    assert.equal(stages[1].status,"running");
    assert.match(stages[1].detail,/execution verification is still required/);
    assert.equal(stages.find(item=>item.id==="persisting-changes")?.status,"queued");
    assert.equal(stages.find(item=>item.id==="human-approval")?.status,"queued");
  }
  assert.equal(pipelineStages("failed","generation-failed")[1].status,"failed");
});