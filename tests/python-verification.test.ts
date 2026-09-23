import assert from "node:assert/strict";
import test from "node:test";
import {pythonVerificationCommands,reportPassed,reportMatchesSnapshot,expectedVerificationProjects,type VerificationReport} from "../src/lib/verification-evidence";
import {applyBaselineTestHarness} from "../src/lib/baseline-test-harness";
import {verificationStepAcceptable} from "../src/lib/verification-evidence";
import {pythonTestDependenciesCommand} from "../src/lib/verification-evidence";
const file=(path:string,content:string)=>({path,content:Buffer.from(content).toString("base64")});
test("Python baseline vulnerabilities remain diagnostic but audit errors and candidate findings block",async()=>{
  // @ts-expect-error standalone Linux supervisor
  const {pythonAuditFindings,verifySnapshot}=await import("../scripts/verification-runner.mjs");
  const log='Found 1 vulnerability\n'+JSON.stringify({dependencies:[{name:"python-dotenv",version:"1.0.1",vulns:[{id:"PYSEC-test"}]}]});
  const step={variant:"baseline" as const,project:".",command:pythonVerificationCommands[4],exitCode:1,timedOut:false,log,durationMs:1};
  assert.equal(pythonAuditFindings(log),true);assert.equal(verificationStepAcceptable(step),true);
  assert.equal(verificationStepAcceptable({...step,variant:"candidate"}),false);
  for(const bad of ["network timeout",'{"dependencies":[]}',JSON.stringify({dependencies:[{name:"unresolved",skip_reason:"not found",vulns:[]}]})]){
    assert.equal(pythonAuditFindings(bad),false);assert.equal(verificationStepAcceptable({...step,log:bad}),false);
  }
  const files=[file("requirements.txt",""),file("tests/test_core.py","")];
  const report=await verifySnapshot({baseline:files,candidate:files},async()=>{},undefined,async(index:number,cwd:string)=>({command:pythonVerificationCommands[index],exitCode:index===4&&cwd.includes("baseline")?1:0,timedOut:false,log,durationMs:1}));
  assert.equal(report.status,"passed");assert.equal(reportPassed(report),true);assert.match(report.reason,/pre-existing baseline/);
});
test("detects Python projects without inventing an npm manifest",async()=>{
  // @ts-expect-error standalone Linux supervisor
  const {pythonProjectsFor}=await import("../scripts/verification-runner.mjs");
  assert.deepEqual(pythonProjectsFor([file("requirements.txt","azure-cognitiveservices-speech==1.42.0\npython-dotenv==1.0.1")]),["."]);
  assert.deepEqual(pythonProjectsFor([file("services/api/requirements.txt","pytest==8.3.5")]),["services/api"]);
  assert.deepEqual(pythonProjectsFor([file("package.json","{}")]),[]);
});

test("Python execution and server gate agree; npm parts cannot be omitted",async()=>{
  // @ts-expect-error standalone Linux supervisor
  const {pythonCommands,verifySnapshot}=await import("../scripts/verification-runner.mjs");
  assert.deepEqual(pythonCommands,pythonVerificationCommands);
  const files=[file("requirements.txt","python-dotenv==1.0.1"),file("tests/test_core.py","import unittest")];
  const result=await verifySnapshot({baseline:files,candidate:files},async()=>{},async()=>{throw Error("npm must not run");},async(index:number)=>({command:pythonCommands[index],exitCode:0,timedOut:false,log:"tests ran",durationMs:1}));
  assert.equal(result.status,"passed");assert.equal(result.steps.length,10);assert.equal(reportPassed(result),true);
  assert.equal(reportMatchesSnapshot(result,{baseline:files,candidate:files}),true);
  assert.equal(reportMatchesSnapshot(result,{baseline:files,candidate:[...files,file("frontend/package.json","{}")]}),false);
  assert.equal(reportPassed({...result,steps:result.steps.filter((step:{command:string})=>step.command!==pythonCommands[3])}),false);
  assert.deepEqual(expectedVerificationProjects([file("backend/requirements.txt",""),file("ops/cloud/requirements.txt","")]).map(project=>project.project),["backend","ops/cloud"]);
});

test("Python test failure, audit failure and missing suites never become approval",async()=>{
  // @ts-expect-error standalone Linux supervisor
  const {pythonCommands,verifySnapshot}=await import("../scripts/verification-runner.mjs");
  const files=[file("requirements.txt",""),file("tests/test_core.py","")];
  for(const failing of [3,4]){
    const report=await verifySnapshot({baseline:files,candidate:files},async()=>{},undefined,async(index:number)=>({command:pythonCommands[index],exitCode:index===failing?1:0,timedOut:false,log:"failure",durationMs:1}));
    assert.equal(report.status,"failed");assert.equal(reportPassed(report),false);
    assert.ok(report.steps.some((step:{variant:string})=>step.variant==="candidate"));
  }
  const report=await verifySnapshot({baseline:files.slice(0,1),candidate:files},async()=>{},undefined,async(index:number)=>({command:pythonCommands[index],exitCode:0,timedOut:false,log:"",durationMs:1}));
  assert.equal(report.status,"unsupported");assert.match(report.reason,/no Python unittest tests/);
  const forged:VerificationReport={status:"passed",reason:"",steps:[]};assert.equal(reportMatchesSnapshot(forged,{baseline:files,candidate:files}),false);
});

test("baseline receives only additive Python tests, never runtime replacements",()=>{
  const original=[file("requirements.txt","original"),file("main.py","original")].map(item=>({...item,executable:false}));
  const candidate=[...original.map(item=>({...item,content:Buffer.from("changed").toString("base64")})),{...file("tests/test_core.py","characterization"),executable:false}];
  const baseline=applyBaselineTestHarness(original,candidate);
  assert.equal(baseline.find(item=>item.path==="main.py")?.content,original[1].content);
  assert.equal(baseline.find(item=>item.path==="requirements.txt")?.content,original[0].content);
  assert.ok(baseline.some(item=>item.path==="tests/test_core.py"));
  assert.throws(()=>applyBaselineTestHarness([...original,{...file("tests/test_core.py","existing"),executable:false}],candidate),/cannot overwrite/);
});
test("Python test dependencies execute separately and are mandatory when declared",async()=>{
  // @ts-expect-error standalone Linux supervisor
  const {verifySnapshot,pythonTestDependenciesCommand:runnerCommand}=await import("../scripts/verification-runner.mjs");
  assert.equal(runnerCommand,pythonTestDependenciesCommand);
  const files=[file("requirements.txt","fastapi==0.115.0"),file("requirements-dev.txt","httpx==0.28.1"),file("tests/test_api.py","")];
  const report=await verifySnapshot({baseline:files,candidate:files},async()=>{},undefined,async(index:number)=>({command:index===5?pythonTestDependenciesCommand:pythonVerificationCommands[index],exitCode:0,timedOut:false,log:"fixture",durationMs:1}));
  assert.equal(report.steps.length,12);assert.equal(reportPassed(report),true);assert.equal(reportMatchesSnapshot(report,{baseline:files,candidate:files}),true);
  assert.equal(reportMatchesSnapshot({...report,steps:report.steps.filter((step:{command:string})=>step.command!==pythonTestDependenciesCommand)},{baseline:files,candidate:files}),false);
});