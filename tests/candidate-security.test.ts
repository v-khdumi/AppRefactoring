import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error isolated scanner helper
import {scanCandidate,candidateSecurityCommand,rules} from "../scripts/candidate-security.mjs";
import {verificationStepAcceptable} from "../src/lib/verification-evidence";

test("candidate security requires actual structured scanner output, no findings, and no suppressed errors",async()=>{
  assert.match(rules,/modernize\.dynamic-evaluation/);
  for(const scenario of ["clean","finding","error","credential"]){
    let materialized=false;
    const step=await scanCandidate({candidate:[{path:"config.txt",content:Buffer.from(scenario==="credential"?`ghp_${"x".repeat(36)}`:"source").toString("base64")},{path:".semgrepignore",content:Buffer.from("**").toString("base64")}]},{
      materialize:async(_root:string,files:Array<{path:string}>)=>{materialized=true;assert.ok(files.every(file=>file.path!==".semgrepignore"));},
      execute:async()=>({exitCode:0,timedOut:false,log:"",durationMs:1}),
      readFile:async()=>JSON.stringify({results:scenario==="finding"?[{check_id:"rule",path:"app.js",start:{line:1}}]:[],errors:scenario==="error"?[{message:"parse failure"}]:[],paths:{scanned:["app.js"]}}),
    });
    assert.equal(materialized,true);
    assert.equal(step.command,candidateSecurityCommand);
    assert.equal(verificationStepAcceptable(step),scenario==="clean");
  }
});
