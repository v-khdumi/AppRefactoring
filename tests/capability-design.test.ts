import assert from "node:assert/strict";
import test from "node:test";
import {capabilityRequestSchema,capabilityDesignSchema,rulesCapabilityDesign} from "../src/lib/capability-design";

test("rules planning requires every essential clarification and preserves actual acceptance criteria",()=>{
  const request=capabilityRequestSchema.parse({description:"Add an authorized document review workflow.",answers:{success:"A reviewer can validate ten documents without losing existing edits."}});
  assert.equal(rulesCapabilityDesign(request).status,"needs-clarification");
  const completed=rulesCapabilityDesign({...request,answers:{...request.answers,"primary-users":"Internal employees","data-sources":"Uploaded documents"}});
  assert.equal(completed.status,"ready");
  assert.equal(completed.acceptanceCriteria[0],request.answers.success);
  assert.deepEqual(completed.services,["Azure Blob Storage"]);
});
test("invalid AI plans are rejected instead of normalized into empty ready designs",()=>{
  assert.equal(capabilityDesignSchema.safeParse({status:"ready",name:"Empty plan",summary:"No evidence or implementation areas",questions:[],frontend:[],backend:[],data:[],azure:[],services:[],testing:[],security:[],acceptanceCriteria:[]}).success,false);
  const request=capabilityRequestSchema.parse({description:"x".repeat(2000)});
  assert.equal(rulesCapabilityDesign(request).summary.length,2000);
  assert.equal(rulesCapabilityDesign({...request,answers:{"primary-users":"x".repeat(2000),"data-sources":"y".repeat(2000),success:"z".repeat(2000)}}).status,"ready");
});
