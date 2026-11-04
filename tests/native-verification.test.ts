import assert from "node:assert/strict";
import test from "node:test";
import {ecosystemUnits,ecosystemVerificationCommands,nativeDependencyBlocker,isImmutableOriginalTest} from "../src/lib/verification-ecosystems";
import {verificationReadiness} from "../src/lib/verification-readiness";
import {reportMatchesSnapshot,verificationStepAcceptable} from "../src/lib/verification-evidence";
import {validatePreparedLocks} from "../src/lib/verification-artifacts";
const file=(path:string,content="")=>({path,content:Buffer.from(content).toString("base64"),executable:false});
// @ts-expect-error isolated standalone runner
const runner=()=>import("../scripts/verification-runner.mjs");
const ruby=[file("Gemfile",'source "https://rubygems.org"\ngem "minitest"'),file("Gemfile.lock","GEM\n  specs:\nDEPENDENCIES\n  minitest\nBUNDLED WITH\n   2.6.9\n"),file("test/core_test.rb","original Minitest assertions")];
const cpp=[file("CMakeLists.txt","project(contract LANGUAGES CXX)\nadd_executable(contract main.cpp)\nenable_testing()\nadd_test(NAME contract COMMAND contract)"),file("main.cpp","int main(){return 0;}")];
const contracts={version:1,programs:[{name:"contract",sources:["main.cob"],format:"free"}],tests:[{name:"stdout",program:"contract",stdin:"",stdout:"OK\n",exitCode:0}]};
const cobol=[file("main.cob","original COBOL"),file("tests/cobol-contracts.json",JSON.stringify(contracts))];
function tools({skipped=0,vulnerable=false,empty=false}={}){
  return {
    execute:async(command:string,args:string[])=>({exitCode:0,timedOut:false,durationMs:1,log:"",output:command==="python3"?'[{"name":"glibc","version":"2.36-9+deb12u13"}]':command==="ruby3.1"&&args.some(arg=>arg.includes("LockfileParser"))?'[{"name":"minitest","version":"5.25.5"}]':command==="ruby3.1"?`MODERNIZE_RUBY_TEST_COUNTS ${JSON.stringify({tests:empty?0:1,failed:0,skipped})}`:command==="node"&&args.some(arg=>arg.includes("MODERNIZE_COBOL_TEST_COUNTS"))?`MODERNIZE_COBOL_TEST_COUNTS ${JSON.stringify({tests:empty?0:1,failed:0,skipped})}`:""}),
    readFile:async(path:string)=>path.endsWith("Gemfile.lock")?Buffer.from(ruby[1].content,"base64").toString("utf8"):path.endsWith("Gemfile")?Buffer.from(ruby[0].content,"base64").toString("utf8"):empty?"<testsuite/>":`<testsuite><testcase name="contract">${skipped?"<skipped/>":""}</testcase></testsuite>`,
    osv:async()=>vulnerable?[{package:"dependency",version:"1",id:"CVE-test",severity:"high"}]:[],
  };
}
test("Ruby/CMake/COBOL detection and server command matrices agree with the runner",async()=>{
  const {ecosystemUnits:detect,ecosystemCommands,verifySnapshot,isImmutableOriginalTest:immutable}=await runner();
  assert.deepEqual(ecosystemCommands,ecosystemVerificationCommands);
  for(const path of ["Billing.Tests/TotalTests.cs","tests/Directory.Build.props","test/core_test.rb","spec/core_spec.rb","tests/CMakeLists.txt","tests/cobol-contracts.json"])assert.equal(immutable(path),isImmutableOriginalTest(path),path);
  for(const [runtime,files] of [["ruby",ruby],["cpp",cpp],["cobol",cobol]] as const){
    assert.deepEqual(detect(files.map(item=>item.path)),ecosystemUnits(files.map(item=>item.path)));
    const report=await verifySnapshot({baseline:files,candidate:files},async()=>{},undefined,undefined,tools());
    assert.equal(report.status,"passed",report.reason);assert.equal(reportMatchesSnapshot(report,{baseline:files,candidate:files}),true);
    const testStep=report.steps.find((step:{tests?:unknown})=>step.tests);
    assert.equal(verificationStepAcceptable({...testStep,tests:undefined}),false);
    assert.equal(verificationReadiness(files.map(item=>({...item,content:Buffer.from(item.content,"base64").toString("utf8")})),{scope:"backend"}).supported,true,runtime);
    for(const options of [{skipped:1},{empty:true},{vulnerable:true}]){
      const bad=await verifySnapshot({baseline:files,candidate:files},async()=>{},undefined,undefined,tools(options));
      assert.equal(bad.status,"failed",`${runtime}: ${JSON.stringify(options)}`);assert.equal(reportMatchesSnapshot({...bad,status:"passed"},{baseline:files,candidate:files}),false);
    }
  }
});
test("native dependencies without complete provenance remain blocked rather than skipped",async()=>{
  const {nativePolicy,junitCounts}=await runner();
  assert.deepEqual(junitCounts([{content:'<testsuite tests="1" disabled="1"><testcase name="contract" status="disabled"><system-out>Disabled</system-out></testcase></testsuite>'}]),{tests:1,failed:0,skipped:1});
  assert.deepEqual(junitCounts([{content:'<testcase name="contract" status="notrun"/>'}]),{tests:1,failed:0,skipped:1});
  assert.deepEqual(junitCounts([{content:'<testsuite failures="1"><testcase name="contract"/></testsuite>'}]),{tests:1,failed:1,skipped:0});
  for(const content of ["include(FetchContent)","find_package(OpenSSL REQUIRED)","add_custom_command(COMMAND curl download)","execute_process(COMMAND sh network.sh)"]){
    const files=[file("CMakeLists.txt",content)];
    assert.throws(()=>nativePolicy(files,"."),/qualified audit/);
    assert.ok(nativeDependencyBlocker([{path:"CMakeLists.txt",content}],"."));
    assert.equal(verificationReadiness([{path:"CMakeLists.txt",content}],{scope:"backend"}).supported,false);
  }
  assert.equal(verificationReadiness([{path:"CMakeLists.txt",content:"project(app)"},{path:"conan.lock"}],{scope:"backend"}).supported,false);
  assert.doesNotThrow(()=>nativePolicy([file("CMakeLists.txt","find_package(Threads REQUIRED)")],"."));
});
test("Ruby respects its exact locked Bundler and rejects unknown runtime versions and sources",async()=>{
  const {bundlerVersion,rubyTestCounts}=await runner();
  assert.equal(bundlerVersion(ruby,"."),"2.6.9");
  assert.throws(()=>bundlerVersion(ruby.slice(0,1),"."),/exact BUNDLED WITH/);
  assert.throws(()=>bundlerVersion([...ruby,file(".ruby-version","3.3.0")],"."),/not qualified/);
  assert.deepEqual(rubyTestCounts(JSON.stringify({examples:[{status:"passed"},{status:"pending"}],summary:{example_count:2,failure_count:0,pending_count:1}}),"rspec"),{tests:2,failed:0,skipped:1});
  assert.throws(()=>rubyTestCounts('{"examples":[],"summary":{"example_count":2}}',"rspec"),/incomplete/);
  const content=Buffer.from(ruby[1].content,"base64").toString("utf8");
  assert.doesNotThrow(()=>validatePreparedLocks({baseline:ruby,candidate:ruby,sourceLockfiles:[ruby[1]]},[{variant:"candidate",path:"Gemfile.lock",content}]));
  assert.throws(()=>validatePreparedLocks({baseline:ruby,candidate:ruby,sourceLockfiles:[ruby[1]]},[{variant:"candidate",path:"Gemfile.lock",content:content.replace("2.6.9","2.6.8")}]),/exact Bundler version/);
  assert.throws(()=>validatePreparedLocks({baseline:ruby,candidate:ruby,sourceLockfiles:[ruby[1]]},[{variant:"baseline",path:"Gemfile.lock",content}]),/baseline locks/);
});
test("COBOL contract manifest compiles every source and forbids empty suites and skips",async()=>{
  const {cobolContracts}=await runner();
  assert.equal(cobolContracts(cobol).tests.length,1);
  for(const config of [{...contracts,tests:[]},{...contracts,tests:[{...contracts.tests[0],skip:true}]},{...contracts,programs:[{...contracts.programs[0],sources:["not-original.cob"]}]}])assert.throws(()=>cobolContracts([cobol[0],file("tests/cobol-contracts.json",JSON.stringify(config))]));
  assert.throws(()=>cobolContracts([...cobol,file("untested.cbl","original")]),/Every detected COBOL/);
});
test("cross-runtime manifest removal requires unchanged reviewed contracts actually executing both variants",async()=>{
  const {verifySnapshot,pythonCommands,reviewedRewrite}=await runner();
  const check={id:"blackbox",kind:"contract" as const,project:".",variants:["baseline","candidate"] as Array<"baseline"|"candidate">,command:"node",args:["tests/modernization/contract.cjs"],report:{path:".modernize-reports/contract.tap",format:"tap" as const},timeoutSeconds:30};
  const manifest=file("tests/modernization-acceptance.json",JSON.stringify({version:1,scenario:"rewrite",checks:[check]}));
  const originalTest=file("tests/modernization/contract.cjs","unchanged reviewed black-box assertions");
  const originalUnit=file("tests/core.test.cjs","unchanged original unit assertions");
  const baseline=[file("package.json",'{"scripts":{"build":"node build.cjs","test":"node --test"}}'),file("package-lock.json","{}"),manifest,originalTest,originalUnit];
  const candidate=[file("requirements.txt",""),file("tests/test_core.py","candidate Python unittest"),manifest,originalTest,originalUnit];
  const snapshot={scenario:"rewrite",scenarioChecks:[check],baseline,candidate};
  assert.equal(reviewedRewrite(snapshot),true);
  const counts={tests:1,failed:0,skipped:0};
  const execute=async(args:string[])=>({command:`npm ${args.join(" ")}`,exitCode:0,timedOut:false,log:"",durationMs:1,tests:counts});
  const python=async(index:number)=>({command:pythonCommands[index],exitCode:0,timedOut:false,log:index===4?'{"dependencies":[]}':"",durationMs:1,tests:index===3?counts:undefined});
  const acceptance={execute:async()=>({exitCode:0,timedOut:false,log:"",durationMs:1}),readFile:async()=>"# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n"};
  const report=await verifySnapshot(snapshot,async()=>{},execute,python,acceptance);
  assert.equal(report.status,"passed",report.reason);assert.equal(reportMatchesSnapshot(report,snapshot),true);
  assert.equal(reportMatchesSnapshot(report,{...snapshot,scenario:"refactor"}),false);
  assert.equal(reportMatchesSnapshot({...report,steps:report.steps.filter((step:{variant:string;command:string})=>!(step.variant==="candidate"&&step.command.startsWith("modernization acceptance")))},snapshot),false);
  assert.equal(reviewedRewrite({...snapshot,candidate:candidate.map(item=>item.path===manifest.path?file(item.path,"changed"):item)}),false);
  assert.equal(reportMatchesSnapshot(report,{...snapshot,candidate:candidate.filter(item=>item.path!==originalUnit.path)}),false);
});
