import assert from "node:assert/strict";
import test from "node:test";

test("runner requires real build/test scripts and lock files; failure never becomes success",async()=>{
  // @ts-expect-error standalone runner executes in the isolated Linux job
  const {projectsFor,verifySnapshot}=await import("../scripts/verification-runner.mjs");
  const files=[{path:"package.json",content:Buffer.from(JSON.stringify({scripts:{build:"tsc",test:"vitest"}})).toString("base64")},{path:"package-lock.json",content:Buffer.from("{}").toString("base64")}];
  assert.deepEqual(projectsFor(files),["."]);
  assert.throws(()=>projectsFor(files.slice(0,1)),/Missing package-lock/);
  const noTests=[{path:"package.json",content:Buffer.from(JSON.stringify({scripts:{build:"tsc -b --noCheck && vite build"},workspaces:{packages:["packages/*"]}})).toString("base64")},files[1]];
  const unsupported=await verifySnapshot({baseline:noTests,candidate:files},async()=>{},async(args:string[])=>({command:`npm ${args.join(" ")}`,exitCode:0,timedOut:false,log:"Executed available check",durationMs:1}));
  assert.equal(unsupported.status,"unsupported");
  assert.match(unsupported.reason,/baseline package.json: missing scripts.test/);
  assert.equal(unsupported.steps.length,7);
  assert.equal(unsupported.steps.filter((step:{variant:string;command:string})=>step.variant==="baseline"&&step.command==="npm test -- --run").length,0);
  assert.equal(unsupported.steps.filter((step:{variant:string;command:string})=>step.variant==="candidate"&&step.command==="npm test -- --run").length,1);
  const noBuild=[{...noTests[0],content:Buffer.from(JSON.stringify({scripts:{build:" ",test:""}})).toString("base64")},files[1]];
  const missingBoth=await verifySnapshot({baseline:noBuild,candidate:noBuild},async()=>{},async(args:string[])=>({command:`npm ${args.join(" ")}`,exitCode:0,timedOut:false,log:"",durationMs:1}));
  assert.equal(missingBoth.status,"unsupported");
  assert.equal(missingBoth.steps.length,4);
  assert.match(missingBoth.reason,/missing scripts.build/);
  let calls=0;
  const execute=async(args:string[])=>{calls++;return {command:`npm ${args.join(" ")}`,exitCode:calls===3?1:0,timedOut:false,log:"actual process output",durationMs:1};};
  const failed=await verifySnapshot({baseline:files,candidate:files},async()=>{},execute);
  assert.equal(failed.status,"failed");assert.equal(calls,3);
  const passed=await verifySnapshot({baseline:files,candidate:files},async()=>{},async(args:string[])=>({command:`npm ${args.join(" ")}`,exitCode:0,timedOut:false,log:"",durationMs:1}));
  assert.equal(passed.status,"passed");assert.equal(passed.steps.length,8);
});

test("baseline audit findings do not prevent measuring candidate checks or become a pass",async()=>{
  // @ts-expect-error standalone runner executes in the isolated Linux job
  const {verifySnapshot}=await import("../scripts/verification-runner.mjs");
  const manifest=(testScript:boolean)=>({path:"package.json",content:Buffer.from(JSON.stringify({scripts:{build:"tsc",...(testScript?{test:"vitest"}:{})}})).toString("base64")});
  const lock={path:"package-lock.json",content:Buffer.from("{}").toString("base64")};
  for(const candidateFails of [false,true]){
    const result=await verifySnapshot({baseline:[manifest(false),lock],candidate:[manifest(true),lock]},async()=>{},async(args:string[],cwd:string)=>({command:`npm ${args.join(" ")}`,exitCode:args[0]==="audit"&&(cwd.includes("baseline")||candidateFails)?1:0,timedOut:false,log:"# npm audit report\nSeverity: high",durationMs:10}));
    assert.equal(result.status,candidateFails?"failed":"unsupported");
    assert.equal(result.steps.length,7);
    assert.match(result.reason,/baseline/i);
    assert.match(result.reason,/missing scripts.test/);
    assert.ok(result.steps.some((step:{variant:string;command:string})=>step.variant==="candidate"&&step.command==="npm test -- --run"));
    if(candidateFails)assert.match(result.reason,/candidate .*audit.*failed/);
  }
});

test("a clean tested candidate can pass with recorded baseline vulnerabilities only",async()=>{
  // @ts-expect-error standalone runner executes in the isolated Linux job
  const {verifySnapshot}=await import("../scripts/verification-runner.mjs");
  const files=[{path:"package.json",content:Buffer.from(JSON.stringify({scripts:{build:"tsc",test:"vitest"}})).toString("base64")},{path:"package-lock.json",content:Buffer.from("{}").toString("base64")}];
  for(const auditError of [false,true]){
    const result=await verifySnapshot({baseline:files,candidate:files},async()=>{},async(args:string[],cwd:string)=>({command:`npm ${args.join(" ")}`,exitCode:args[0]==="audit"&&cwd.includes("baseline")?1:0,timedOut:false,log:auditError?"npm error ECONNRESET":"# npm audit report\nSeverity: high",durationMs:1}));
    assert.equal(result.status,auditError?"failed":"passed");
    if(!auditError){
      assert.equal(result.steps.length,8);
      assert.match(result.reason,/pre-existing baseline vulnerabilities/);
      const {reportPassed}=await import("../src/lib/verification-evidence");
      assert.equal(reportPassed(result),true);
    }
  }
});