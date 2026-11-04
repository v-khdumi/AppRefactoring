import assert from "node:assert/strict";
import test from "node:test";
import {blockedRuntimeReasons,nodeManager,nodeVerificationCommands,pythonUnits,rustVerificationCommands,nodeLockPath} from "../src/lib/verification-ecosystems";
import {expectedVerificationProjects,managedPythonVerificationCommands,reportMatchesSnapshot,reportPassed,verificationStepAcceptable} from "../src/lib/verification-evidence";
import {verificationReadiness} from "../src/lib/verification-readiness";
import {validatePreparedLocks} from "../src/lib/verification-artifacts";
import {applyBaselineTestHarness} from "../src/lib/baseline-test-harness";

const file=(path:string,content="")=>({path,content:Buffer.from(content).toString("base64"),executable:false});
const counts={tests:2,failed:0,skipped:0};
// @ts-expect-error standalone isolated Linux runner
const runner=()=>import("../scripts/verification-runner.mjs");
const scripts={build:"node build.cjs",test:"node --test --test-reporter=tap tests/core.cjs"};

test("JavaScript detection preserves exact manager/version and rejects ambiguous or mismatched locks",async()=>{
  const {nodeManager:detect,nodeCommands,projectsFor}=await runner();
  assert.deepEqual(nodeCommands,nodeVerificationCommands);
  for(const [manager,version,lock] of [["npm","10.9.4","package-lock.json"],["pnpm","10.28.2","pnpm-lock.yaml"],["yarn","1.22.22","yarn.lock"],["yarn","4.18.1","yarn.lock"]]){
    const manifest={packageManager:`${manager}@${version}`,scripts};
    assert.deepEqual(detect(manifest,[lock]),nodeManager(manifest,[lock]));
    const files=[file("package.json",JSON.stringify(manifest)),file(lock,"lock")];
    assert.deepEqual(projectsFor(files),["."]);
    assert.deepEqual(expectedVerificationProjects(files)[0].commands,nodeVerificationCommands[manager as keyof typeof nodeVerificationCommands]);
    assert.equal(nodeLockPath("package.json",files),lock);
    assert.equal(nodeLockPath("package.json",files.slice(0,1)),undefined);
    assert.equal(verificationReadiness(files.map(item=>({...item,content:Buffer.from(item.content,"base64").toString("utf8")})),{scope:"frontend"}).supported,true);
  }
  for(const manifest of [{packageManager:"pnpm@latest"},{packageManager:"yarn@^4.0.0"},{packageManager:"bun@1.2.0"}])assert.throws(()=>nodeManager(manifest,[]),/exact/);
  assert.throws(()=>nodeManager({},["pnpm-lock.yaml"]),/exact packageManager/);
  assert.throws(()=>nodeManager({packageManager:"pnpm@10.28.2"},["package-lock.json"]),/does not own/);
  assert.throws(()=>nodeManager({},["package-lock.json","yarn.lock"]),/Ambiguous/);
  const workspace=[file("package.json",JSON.stringify({packageManager:"pnpm@10.28.2",scripts})),file("pnpm-workspace.yaml","packages: ['packages/*']"),file("pnpm-lock.yaml","lockfileVersion: '9.0'"),file("packages/ui/package.json","{}")];
  assert.deepEqual(projectsFor(workspace),["."]);assert.equal(expectedVerificationProjects(workspace).length,1);
  assert.equal(nodeLockPath("packages/ui/package.json",workspace),"pnpm-lock.yaml");
  assert.equal(nodeLockPath("api/package.json",[file("api/package.json",'{"packageManager":"yarn@4.18.1"}'),file("api/yarn.lock","lock")]),"api/yarn.lock");
});

test("server requires every manager command and nonempty unskipped test evidence",()=>{
  for(const manager of ["pnpm","yarn"] as const){
    const commands=nodeVerificationCommands[manager];
    const files=[file("package.json",JSON.stringify({packageManager:`${manager}@${manager==="pnpm"?"10.28.2":"4.18.1"}`,scripts})),file(manager==="pnpm"?"pnpm-lock.yaml":"yarn.lock","lock")];
    const report={status:"passed" as const,reason:"",steps:(["baseline","candidate"] as const).flatMap(variant=>commands.map(command=>({variant,project:".",command,exitCode:0,timedOut:false,log:"",durationMs:1,tests:command===commands[2]?counts:undefined})))};
    assert.equal(reportMatchesSnapshot(report,{baseline:files,candidate:files}),true);
    for(const tests of [undefined,{tests:0,failed:0,skipped:0},{tests:2,failed:0,skipped:1}])assert.equal(reportPassed({...report,steps:report.steps.map(step=>step.command===commands[2]?{...step,tests}:step)}),false);
    assert.equal(reportMatchesSnapshot({...report,steps:report.steps.slice(1)},{baseline:files,candidate:files}),false);
    const changed=[file("package.json",JSON.stringify({packageManager:`${manager}@0.0.1`,scripts})),files[1]];
    assert.equal(reportMatchesSnapshot(report,{baseline:files,candidate:changed}),false);
  }
});

test("manager audits preserve advisory details and reject missing summaries and errors",async()=>{
  const {nodeAuditFindings,auditStep}=await runner();
  const advisory={module_name:"minimist",id:123,url:"https://github.com/advisories/GHSA-test",severity:"high"};
  const pnpm={name:"pnpm"};
  assert.equal(nodeAuditFindings(JSON.stringify({metadata:{vulnerabilities:{high:1}},advisories:{"123":advisory}}),pnpm)[0].severity,"high");
  assert.throws(()=>nodeAuditFindings(JSON.stringify({metadata:{vulnerabilities:{high:1}},advisories:{}}),pnpm),/missing advisory details/);
  assert.throws(()=>nodeAuditFindings("{}",pnpm),/complete audit report/);
  assert.throws(()=>nodeAuditFindings('{"type":"error","data":"network failure"}',{name:"yarn",classic:true}),/audit summary/);
  const modern={name:"yarn",classic:false};
  assert.deepEqual(nodeAuditFindings("",modern),[]);
  const findings=nodeAuditFindings(JSON.stringify({value:"minimist",children:{ID:123,URL:advisory.url,Severity:"high"}}),modern);
  assert.equal(findings[0].package,"minimist");assert.equal(auditStep({exitCode:0,log:""},findings).exitCode,1);
  assert.throws(()=>nodeAuditFindings('{"type":"error","data":"registry unavailable"}',modern),/recognized/);
  assert.deepEqual(nodeAuditFindings(JSON.stringify({minimist:[advisory]}),modern).map((item:{severity:string})=>item.severity),["high"]);
});

test("Python lock owners are consistent and requirements cannot silently replace them",async()=>{
  const {pythonUnits:detect,managedPythonCommands,verifySnapshot}=await runner();
  assert.deepEqual(managedPythonCommands,managedPythonVerificationCommands);
  for(const [manager,manifest,lock] of [["poetry","pyproject.toml","poetry.lock"],["uv","pyproject.toml","uv.lock"],["pipenv","Pipfile","Pipfile.lock"]] as const){
    const files=[file(manifest,"project"),file(lock,"lock"),file("requirements.txt","must not replace lock"),file("tests/test_core.py","import unittest")];
    assert.deepEqual(detect(files.map(item=>item.path)),pythonUnits(files.map(item=>item.path)));
    assert.equal(expectedVerificationProjects(files).length,1);
    assert.deepEqual(expectedVerificationProjects(files)[0].commands,managedPythonVerificationCommands[manager]);
    const calls:Array<{command:string;uid:number}>=[];
    const tools={execute:async(command:string,_args:string[],_cwd:string,uid:number)=>{calls.push({command,uid});return {exitCode:0,timedOut:false,log:command.endsWith("pip-audit")?'{"dependencies":[]}':`MODERNIZE_TEST_COUNTS ${JSON.stringify(counts)}`,durationMs:1};}};
    const report=await verifySnapshot({baseline:files,candidate:files},async()=>{},undefined,undefined,tools);
    assert.equal(report.status,"passed",report.reason);assert.equal(reportMatchesSnapshot(report,{baseline:files,candidate:files}),true);
    assert.ok(calls.every(call=>[10001,10002].includes(call.uid)));
    assert.ok(calls.some(call=>call.command===`/opt/verification-tools/bin/${manager}`));
    const baseline=applyBaselineTestHarness(files.filter(item=>!item.path.startsWith("tests/")),files);
    assert.ok(baseline.some(item=>item.path==="tests/test_core.py"));
    assert.equal(baseline.find(item=>item.path===lock)?.content,files.find(item=>item.path===lock)?.content);
  }
  assert.throws(()=>pythonUnits(["pyproject.toml","requirements.txt"]),/will not silently replace/);
  assert.throws(()=>pythonUnits(["pyproject.toml","poetry.lock","uv.lock"]),/Ambiguous/);
});

test("prepared locks stay manager-owned and cannot replace baseline dependency evidence",()=>{
  const samples=[
    ["pnpm-lock.yaml","package.json",JSON.stringify({packageManager:"pnpm@10.28.2",scripts}),"lockfileVersion: '9.0'\nimporters: {}\n"],
    ["yarn.lock","package.json",JSON.stringify({packageManager:"yarn@4.18.1",scripts}),"__metadata:\n  version: 8\n"],
    ["poetry.lock","pyproject.toml","[project]\nname='fixture'","[metadata]\nlock-version = '2.1'\n"],
    ["uv.lock","pyproject.toml","[project]\nname='fixture'","version = 1\n"],
    ["Pipfile.lock","Pipfile","[packages]",JSON.stringify({_meta:{hash:{sha256:"a"}},default:{},develop:{}})],
    ["Cargo.lock","Cargo.toml","[package]\nname='fixture'","version = 4\n[[package]]\nname = 'fixture'\nversion = '0.1.0'\n"],
  ];
  for(const [lock,manifest,source,content] of samples){
    const original=[file(manifest,source),file(lock,content)];
    const snapshot={baseline:original,candidate:original,sourceLockfiles:[original[1]]};
    assert.doesNotThrow(()=>validatePreparedLocks(snapshot,[{variant:"candidate",path:lock,content}]));
    assert.throws(()=>validatePreparedLocks(snapshot,[{variant:"baseline",path:lock,content}]),/baseline locks/);
  }
});

test("changed candidate locks are revalidated by their owner and baseline npm preparation preserves its exact version",async()=>{
  const {prepareCandidateLocks}=await runner();
  const manifest=JSON.stringify({packageManager:"pnpm@10.28.2",scripts});
  const baseline=[file("package.json",manifest),file("pnpm-lock.yaml","original")];
  const candidate=[baseline[0],file("pnpm-lock.yaml","model-modified")];
  const calls:Array<{command:string;args:string[];uid:number}>=[];
  const runTool=async(command:string,args:string[],_cwd:string,uid:number)=>{calls.push({command,args,uid});return {exitCode:0,timedOut:false,log:"",durationMs:1};};
  const artifacts=await prepareCandidateLocks({baseline,candidate},async()=>{throw new Error("npm must not own pnpm preparation");},async(path:string)=>path.endsWith("package.json")?manifest:"lockfileVersion: '9.0'\n",runTool);
  assert.equal(artifacts[0].path,"pnpm-lock.yaml");assert.match(calls[0].command,/pnpm-10[.]28[.]2/);assert.equal(calls[0].uid,10002);assert.ok(calls[0].args.includes("--ignore-scripts"));
  const npm=JSON.stringify({packageManager:"npm@10.9.4",scripts});
  await prepareCandidateLocks({baseline:[file("package.json",npm),file("package-lock.json","{}")],candidate:[],baselinePreparationPaths:["package-lock.json"]},async()=>{throw new Error("the verifier image npm must not replace the declared baseline version");},async(path:string)=>path.endsWith("package.json")?npm:"{}",runTool);
  assert.match(calls[1].command,/npm-10[.]9[.]4/);assert.equal(calls[1].uid,10001);
});

test("Rust executes locked baseline and candidate tests and audits, with no silent git/custom registry exemption",async()=>{
  const {verifySnapshot,rustCommands,rustVersion,rustTestCounts,cargoDependencies}=await runner();
  assert.deepEqual(rustCommands,rustVerificationCommands);
  assert.equal(rustVersion([file("rust-toolchain.toml",'[toolchain]\nchannel = "1.85.0"')],"."),"1.85.0");
  assert.throws(()=>rustVersion([file("rust-toolchain","stable")],"."),/exact stable/);
  assert.deepEqual(rustTestCounts("test result: ok. 2 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out;"),{tests:3,failed:0,skipped:1});
  const metadata={workspace_members:["local"],packages:[{id:"local",name:"fixture",version:"0.1.0",source:null},{id:"remote",name:"itoa",version:"1.0.15",source:"registry+https://github.com/rust-lang/crates.io-index"}]};
  assert.deepEqual(cargoDependencies(JSON.stringify(metadata)),[{name:"itoa",version:"1.0.15"}]);
  assert.throws(()=>cargoDependencies(JSON.stringify({...metadata,packages:[{...metadata.packages[1],source:"git+https://example.invalid/repo"}]})),/Unauditable/);
  const files=[file("Cargo.toml",'[package]\nname="fixture"\nversion="0.1.0"'),file("Cargo.lock","version = 4"),file("src/lib.rs","#[test] fn works() {}")];
  for(const skipped of [0,1]){
    const tools={execute:async(_command:string,args:string[])=>({exitCode:0,timedOut:false,durationMs:1,log:"",output:args[0]==="test"?`test result: ok. 2 passed; 0 failed; ${skipped} ignored; 0 measured; 0 filtered out;`:args[0]==="metadata"?JSON.stringify(metadata):""}),osv:async()=>[]};
    const report=await verifySnapshot({baseline:files,candidate:files},async()=>{},undefined,undefined,tools);
    assert.equal(report.status,skipped?"failed":"passed");assert.equal(reportMatchesSnapshot(report,{baseline:files,candidate:files}),!skipped);
  }
  assert.equal(verificationStepAcceptable({variant:"candidate",project:".",command:rustCommands[2],exitCode:0,timedOut:false,log:"",durationMs:1}),false);
});

test("unconfigured Ruby, native C/C++ and COBOL cannot hide behind an otherwise passing frontend",async()=>{
  const {blockedRuntimeReasons:detect,verifySnapshot}=await runner();
  const manifests=[file("package.json",JSON.stringify({scripts})),file("package-lock.json","{}")];
  for(const path of ["Gemfile","native/conan.lock","legacy/main.cbl"]){
    assert.deepEqual(detect([path]),blockedRuntimeReasons([path]));
    const files=[...manifests,file(path,"source")];
    assert.equal(verificationReadiness(files.map(item=>({...item,content:Buffer.from(item.content,"base64").toString("utf8")})),{scope:"fullstack"}).supported,false);
    const report=await verifySnapshot({baseline:files,candidate:files},async()=>{},async(args:string[])=>({command:`npm ${args.join(" ")}`,exitCode:0,timedOut:false,log:"",durationMs:1,tests:counts}));
    assert.notEqual(report.status,"passed");
    assert.equal(reportMatchesSnapshot({...report,status:"passed"},{baseline:files,candidate:files}),false);
  }
});

test("scenario checks extend rather than replace runtime evidence and are snapshot-bound",async()=>{
  const {verifySnapshot}=await runner();
  const files=[file("package.json",JSON.stringify({scripts})),file("package-lock.json","{}")];
  const check={id:"public-api",kind:"contract" as const,project:".",variants:["baseline","candidate"] as Array<"baseline"|"candidate">,command:"node",args:["tests/modernization/contract.cjs"],report:{path:".modernize-reports/contract.tap",format:"tap" as const},timeoutSeconds:30};
  const tools={execute:async()=>({exitCode:0,timedOut:false,log:"",durationMs:1}),readFile:async()=>"# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"};
  const snapshot={baseline:files,candidate:files,scenarioChecks:[check]};
  const report=await verifySnapshot(snapshot,async()=>{},async(args:string[])=>({command:`npm ${args.join(" ")}`,exitCode:0,timedOut:false,log:"",durationMs:1,tests:counts}),undefined,tools);
  assert.equal(report.status,"passed",report.reason);assert.equal(report.steps.length,10);
  assert.equal(reportMatchesSnapshot(report,snapshot),true);
  assert.equal(reportMatchesSnapshot(report,{baseline:files,candidate:files}),false);
  assert.equal(reportMatchesSnapshot({...report,steps:report.steps.filter((step:{variant:string;command:string})=>!(step.variant==="candidate"&&step.command.startsWith("modernization acceptance")))},snapshot),false);
  assert.equal(reportPassed({...report,steps:report.steps.filter((step:{command:string})=>step.command.startsWith("modernization acceptance"))}),false);
});
