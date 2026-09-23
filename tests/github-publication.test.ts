import assert from "node:assert/strict";
import {generateKeyPairSync} from "node:crypto";
import test from "node:test";
import {env} from "../src/lib/env";
import {publishChanges,createModernizationPullRequest} from "../src/lib/github-app";

env.GITHUB_APP_ID="fixture";
env.GITHUB_APP_PRIVATE_KEY=generateKeyPairSync("rsa",{modulusLength:2048}).privateKey.export({type:"pkcs8",format:"pem"}).toString();
const input={owner:"owner",repo:"repo",sourceBranch:"main",targetBranch:"modernize/test",expectedCommitSha:"source",message:"Reviewed changes",changes:[{path:"src/app.ts",content:"updated"}]};
function respond(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});}
test("matching existing branch and PR are recovered without overwriting or duplication",async context=>{
 const writes:string[]=[];
 context.mock.method(globalThis,"fetch",async(url:string,options:RequestInit)=>{
  const path=new URL(url).pathname;
  if(options.method==="POST")writes.push(path);
  if(path.endsWith("/installation"))return respond({id:1});
  if(path.endsWith("/access_tokens"))return respond({token:"fixture"});
  if(path.endsWith("/git/ref/heads/main"))return respond({object:{sha:"source"}});
  if(path.endsWith("/git/commits/source"))return respond({tree:{sha:"base"}});
  if(path.endsWith("/git/trees"))return respond({sha:"approved-tree"});
  if(path.endsWith("/git/ref/heads/modernize%2Ftest"))return respond({object:{sha:"candidate"}});
  if(path.endsWith("/git/commits/candidate"))return respond({tree:{sha:"approved-tree"},parents:[{sha:"source"}]});
  if(path.endsWith("/pulls"))return respond([{number:1,html_url:"https://github.com/owner/repo/pull/1"}]);
  throw new Error(`Unexpected GitHub request ${path}`);
 });
 assert.equal(await publishChanges(input),"candidate");
 assert.equal((await createModernizationPullRequest({...input,title:"Title",body:"Body"})).number,1);
 assert.ok(writes.every(path=>path.endsWith("/access_tokens")||path.endsWith("/git/trees")));
});
test("workflow changes fail before publishing unless installation permission is granted",async context=>{
 context.mock.method(globalThis,"fetch",async(url:string)=>{
  assert.ok(url.endsWith("/installation"));return respond({id:1,permissions:{contents:"write"}});
 });
 await assert.rejects(publishChanges({...input,changes:[{path:".github/workflows/ci.yml",content:"workflow"}]}),/Workflows: write/);
});
test("workflow-enabled token explicitly requests the granted permission and refuses conflicting branches",async context=>{
 context.mock.method(globalThis,"fetch",async(url:string,options:RequestInit)=>{
  const path=new URL(url).pathname;
  if(path.endsWith("/installation"))return respond({id:1,permissions:{workflows:"write"}});
  if(path.endsWith("/access_tokens")){assert.equal(JSON.parse(String(options.body)).permissions.workflows,"write");return respond({token:"fixture"});}
  if(path.endsWith("/git/ref/heads/main"))return respond({object:{sha:"source"}});
  if(path.endsWith("/git/commits/source"))return respond({tree:{sha:"base"}});
  if(path.endsWith("/git/trees"))return respond({sha:"approved-tree"});
  if(path.endsWith("/git/ref/heads/modernize%2Ftest"))return respond({object:{sha:"candidate"}});
  if(path.endsWith("/git/commits/candidate"))return respond({tree:{sha:"different-tree"},parents:[{sha:"source"}]});
  throw new Error(`Unexpected GitHub write ${path}`);
 });
 await assert.rejects(publishChanges({...input,changes:[{path:".github/workflows/ci.yml",content:"workflow"}]}),/without overwriting/);
});
test("source branch is never used as the publication target",async()=>{
 await assert.rejects(publishChanges({...input,targetBranch:"main"}),/never the source branch/);
});