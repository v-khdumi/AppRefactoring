import assert from "node:assert/strict";
import test from "node:test";
import {acceptanceManifestSchema,scenarioAcceptance,scenarioForOptions,scenarioRequirements,scenarioCommand,applyScenarioHarness,validateScenarioScope} from "../src/lib/modernization-scenarios";

const check={id:"public-api",kind:"contract",project:".",variants:["baseline","candidate"],command:"node",args:["tests/modernization/contract.cjs"],report:{path:".modernize-reports/contract.json",format:"json"},timeoutSeconds:120};
const file=(path:string,content:unknown)=>({path,content:Buffer.from(typeof content==="string"?content:JSON.stringify(content)).toString("base64"),executable:false});

test("legacy runs default to refactor while unsupported scenario names are rejected",()=>{
  assert.equal(scenarioForOptions({}),"refactor");
  assert.equal(scenarioForOptions({scenario:"upgrade"}),"upgrade");
  assert.throws(()=>scenarioForOptions({scenario:"anything"}));
  assert.equal(scenarioAcceptance([],"refactor"),undefined);
  assert.equal(scenarioAcceptance([],"upgrade"),undefined);
});
test("cross-runtime rewriting requires the same reviewed contract on both variants",()=>{
  assert.throws(()=>scenarioAcceptance([],"rewrite"),/reviewed/);
  const manifest={version:1,scenario:"rewrite",checks:[check]};
  assert.equal(scenarioAcceptance([file("tests/modernization-acceptance.json",manifest)],"rewrite")?.checks.length,1);
  assert.throws(()=>scenarioAcceptance([file("tests/modernization-acceptance.json",{...manifest,checks:[{...check,variants:["candidate"]}]})],"rewrite"),/baseline contract/);
  assert.throws(()=>scenarioAcceptance([file("tests/modernization-acceptance.json",manifest)],"extract-services"),/does not match/);
});
test("data, service, cloud and AI strategies require explicit specialized acceptance checks",()=>{
  for(const scenario of ["replatform","extract-services","database-migration","ai-capability"] as const){
    assert.throws(()=>scenarioAcceptance([],scenario),/requires a reviewed/);
    const checks=scenarioRequirements(scenario).map((requirement,index)=>({...check,id:`check-${index}`,kind:requirement.kind,variants:[...requirement.variants]}));
    const manifest=scenarioAcceptance([file("tests/modernization-acceptance.json",{version:1,scenario,checks})],scenario);
    assert.ok(manifest);
    assert.match(scenarioCommand(manifest.checks[0]),/^modernization acceptance /);
  }
  assert.throws(()=>validateScenarioScope("database-migration","frontend"),/backend/);
  assert.doesNotThrow(()=>validateScenarioScope("ai-capability","frontend"));
});
test("acceptance harnesses cannot escape the workspace, run forever or reuse ambiguous check IDs",()=>{
  for(const invalid of [{...check,report:{...check.report,path:"../stolen.json"}},{...check,report:{...check.report,path:"package.json"}},{...check,command:"/bin/sh"},{...check,timeoutSeconds:10000}]){
    assert.equal(acceptanceManifestSchema.safeParse({version:1,scenario:"rewrite",checks:[invalid]}).success,false);
  }
  assert.equal(acceptanceManifestSchema.safeParse({version:1,scenario:"rewrite",checks:[check,check]}).success,false);
});
test("only additive dedicated harness files are copied to the verification baseline",()=>{
  const original=file("tests/modernization/original.cjs","unchanged");
  const added=file("tests/modernization/contract.cjs","new contract");
  const baseline=applyScenarioHarness([original],[original,added,file("src/new-runtime.js","implementation")]);
  assert.deepEqual(baseline,[original,added]);
  assert.throws(()=>applyScenarioHarness([original],[file(original.path,"rewritten")]),/cannot be rewritten/);
});
