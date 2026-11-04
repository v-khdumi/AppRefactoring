import assert from "node:assert/strict";
import {mkdir,rm} from "node:fs/promises";
import {materialize,verifySnapshot,runCommand} from "./verification-runner.mjs";

if(process.platform!=="linux"||process.getuid()!==0)throw new Error("Run this canary only in a dedicated ephemeral Linux verification job.");
if(process.env.VERIFICATION_TOKEN||process.env.DATABASE_URL)throw new Error("The verification canary must not receive production capabilities or database credentials.");

const file=(path,content)=>({path,content:Buffer.from(content).toString("base64"),executable:false});
const manifest={name:"modernize-verification-canary",version:"1.0.0",private:true,scripts:{build:"node -e \"require('node:assert/strict').notEqual(process.getuid(),0)\"",test:"node --test --test-reporter=tap test.cjs"}};
const lock=JSON.stringify({name:manifest.name,version:manifest.version,lockfileVersion:3,packages:{"":{name:manifest.name,version:manifest.version}}});
const results=[];
await mkdir("/work",{recursive:true,mode:0o755});
process.env.SUPERVISOR_CANARY_SECRET="supervisor-only";
for(const scenario of ["passed","failed","zero-tests","skipped-tests"]){
  await rm("/work/baseline",{recursive:true,force:true});
  await rm("/work/candidate",{recursive:true,force:true});
  const test=scenario==="skipped-tests"?"require('node:test').skip('unexecuted contract',()=>{})":`require('node:test')('executed contract',()=>{const assert=require('node:assert/strict');assert.notEqual(process.getuid(),0);assert.equal(process.env.SUPERVISOR_CANARY_SECRET,undefined);assert.equal(${scenario==="failed"?"false":"true"},true);})`;
  const packageJson=scenario==="zero-tests"?{...manifest,scripts:{...manifest.scripts,test:"node -e \"console.log('No tests executed')\""}}:manifest;
  const files=[file("package.json",JSON.stringify(packageJson)),file("package-lock.json",lock),file("test.cjs",test)];
  await materialize("/work/baseline",files,10001);
  await materialize("/work/candidate",files,10002);
  const report=await verifySnapshot({baseline:files,candidate:files},async()=>{});
  assert.equal(report.status,scenario==="passed"?"passed":"failed",JSON.stringify({scenario,reason:report.reason,step:report.steps.at(-1)}));
  results.push({scenario,status:report.status,tests:report.steps.filter(step=>step.command==="npm test -- --run").map(step=>step.tests)});
}
const timeout=await runCommand(["test"],"/work/candidate",10002,1);
assert.equal(timeout.timedOut,true);
console.log(JSON.stringify({event:"verification.canary",passed:true,uidIsolation:true,environmentIsolation:true,timeoutVerified:true,results}));
