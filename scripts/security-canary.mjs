import assert from "node:assert/strict";
import {writeFile,rm,mkdir} from "node:fs/promises";
import {installCandidateScanner,scanCandidate} from "./candidate-security.mjs";
import {executeCommand,downloadVerified,materialize,readPreparedFile} from "./verification-runner.mjs";

if(process.platform!=="linux"||process.getuid?.()!==0)throw new Error("Run only in an identity-free ephemeral Linux verifier.");
if(process.env.VERIFICATION_TOKEN||process.env.DATABASE_URL)throw new Error("The security canary must not receive production capabilities.");
const tools={execute:executeCommand,downloadVerified,materialize,writeFile,readFile:readPreparedFile};
await installCandidateScanner(tools);
await mkdir("/work",{recursive:true,mode:0o755});
const file=(path,content)=>({path,content:Buffer.from(content).toString("base64"),executable:false});
const results=[];
for(const scenario of ["clean","finding","ignore-attempt","credential"]){
  await rm("/work/candidate-scan",{recursive:true,force:true});
  const files=[file("app.js",scenario==="finding"||scenario==="ignore-attempt"?"eval(process.argv[2]);":"export const total = (quantity,unit) => quantity*unit;")];
  if(scenario==="ignore-attempt")files.push(file(".semgrepignore","**"));
  if(scenario==="credential")files.push(file("config.txt",`ghp_${"x".repeat(36)}`));
  const step=await scanCandidate({candidate:files},tools);
  assert.equal(step.exitCode,scenario==="clean"?0:1,JSON.stringify({scenario,step}));
  results.push({scenario,exitCode:step.exitCode,evidence:JSON.parse(step.log)});
}
console.log(JSON.stringify({event:"candidate.security.canary",passed:true,results}));
