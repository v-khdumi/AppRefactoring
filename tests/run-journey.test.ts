import assert from "node:assert/strict";
import test from "node:test";
import {emptyLiveRun} from "../src/lib/execution-state";
import {runJourney} from "../src/lib/run-journey";
test("approval leads to publication rather than another verification or approval",()=>{
 const run={...emptyLiveRun("run"),status:"approved" as const,currentStage:"human-approval"};
 assert.equal(runJourney(run).step,3);assert.equal(runJourney(run).action,"refresh");
 assert.equal(runJourney({...run,status:"publication-failed",errorDetail:"Permission denied"}).action,"publication");
 assert.equal(runJourney({...run,status:"pull-request-created"}).action,"pull-request");
});
test("successful verification leads to explicit human review",()=>{
 const run={...emptyLiveRun("run"),status:"awaiting-approval" as const,validationExecution:{status:"passed",reason:"",steps:[]}};
 assert.equal(runJourney(run).action,"review");
});