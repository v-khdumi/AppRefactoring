import assert from "node:assert/strict";
import test from "node:test";
import {modernizationOptionsSchema,parseRunOptions} from "../src/lib/modernization-options";

test("analysis and launch share strict scoped strategy options",()=>{
  assert.equal(parseRunOptions("backend",{}).scenario,"refactor");
  assert.equal(parseRunOptions("backend",{}).preserveBehavior,true);
  assert.throws(()=>parseRunOptions("frontend",{scope:"backend"}),/must match/);
  assert.throws(()=>parseRunOptions("frontend",{scenario:"database-migration"}));
  assert.throws(()=>parseRunOptions("backend",{workerToken:"client-controlled"}));
  assert.throws(()=>parseRunOptions("backend",{preserveBehavior:false}));
});
test("AI strategy requires actual selected requirements and accepts full capability names",()=>{
  assert.equal(modernizationOptionsSchema.safeParse({scope:"fullstack",scenario:"ai-capability"}).success,false);
  assert.equal(parseRunOptions("fullstack",{scenario:"ai-capability",aiFeatures:["Document intelligence"]}).scenario,"ai-capability");
  assert.equal(parseRunOptions("fullstack",{aiFeatures:["A".repeat(100)]}).aiFeatures[0].length,100);
});
