import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
// @ts-expect-error standalone Windows runner has no TypeScript declaration
import {windowsNpmVerification} from "../scripts/windows-node-verification.mjs";
import {npmVerificationCommands,reportPassed} from "../src/lib/verification-evidence";

const file=(path:string,content:string)=>({path,content:Buffer.from(content).toString("base64")});
const files=[file("ui/package.json",JSON.stringify({scripts:{build:"node build.cjs",test:"node --test test.cjs"}})),file("ui/package-lock.json","{}")];
const config={mode:"verify",variant:"candidate",root:"C:\\work\\candidate",files,source:files,node:"C:\\node\\node.exe",npmCli:"C:\\node\\npm-cli.js",npmVersion:"10.9.4"};

test("Windows npm records actual test evidence and the same server labels",async()=>{
  const result=await windowsNpmVerification(config,async(_node:string,args:string[])=>({exitCode:0,timedOut:false,log:"",output:args[1]==="test"?"# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n":"",durationMs:1}));
  assert.equal(result.failed,false);
  assert.deepEqual(result.steps.map((step:{command:string})=>step.command),npmVerificationCommands);
  assert.deepEqual(result.steps[2].tests,{tests:2,failed:0,skipped:0});
  const report={status:"passed" as const,reason:"",steps:[...result.steps.map((step:Record<string,unknown>)=>({...step,variant:"baseline"})),...result.steps]};
  assert.equal(reportPassed(report),true);
});
test("Windows npm rejects zero tests and does not replace another package manager",async()=>{
  const empty=await windowsNpmVerification(config,async()=>({exitCode:0,timedOut:false,log:"",output:"No tests executed",durationMs:1}));
  assert.equal(empty.failed,true);
  assert.equal(empty.steps[2].exitCode,1);
  await assert.rejects(windowsNpmVerification({...config,files:[file("package.json",'{"packageManager":"pnpm@10.28.2"}'),file("pnpm-lock.yaml","lock")]}),/requires npm/);
  await assert.rejects(windowsNpmVerification({...config,files:[file("package.json",'{"packageManager":"npm@1.2.3"}'),file("package-lock.json","{}")]}),/exact source npm/);
});
test("Windows supervisor pins the Node archive and runs repository work only as variant accounts",()=>{
  const source=readFileSync(new URL("../scripts/windows-verification-runner.ps1",import.meta.url),"utf8");
  assert.match(source,/node-v22\.23\.4-win-x64\.zip/);
  assert.match(source,/cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20/);
  assert.match(source,/Invoke-AsUser \$credential \$root \$node.node/);
});
