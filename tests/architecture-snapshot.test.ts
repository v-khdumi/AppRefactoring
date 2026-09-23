import test from "node:test";
import assert from "node:assert/strict";
import {architectureSnapshotSchema} from "../src/lib/architecture-snapshot";
import {createDemoAnalysis} from "../src/lib/demo-analysis";
test("saved architecture requires real source identity and preserves both diagrams",()=>{
 const sample={...createDemoAnalysis(),mode:"live",scope:"frontend",sourceCommitSha:"a".repeat(40)};
 const parsed=architectureSnapshotSchema.parse(sample);
 assert.deepEqual(parsed.currentArchitecture,sample.currentArchitecture);
 assert.deepEqual(parsed.targetArchitecture,sample.targetArchitecture);
 assert.equal(parsed.scope,"frontend");
 assert.equal(architectureSnapshotSchema.safeParse({...sample,sourceCommitSha:undefined}).success,false);
 assert.equal(architectureSnapshotSchema.safeParse({...sample,targetArchitecture:[]}).success,false);
});