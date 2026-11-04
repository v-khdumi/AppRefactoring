import assert from "node:assert/strict";
import test from "node:test";
import {sourceRepository,readSourceRepository,readSourceSnapshot,publishSourceChanges,createSourcePullRequest} from "../src/lib/source-provider";
import {parseGitHubUrl} from "../src/lib/github";

test("GitHub-only source URLs are canonicalized without embedding credentials",()=>{
  assert.deepEqual(sourceRepository("https://github.com/acme/app.git/"),{provider:"github",url:"https://github.com/acme/app",name:"acme/app"});
  assert.deepEqual(parseGitHubUrl("https://github.com/acme/app"),{owner:"acme",repo:"app"});
  for(const url of ["https://gitlab.com/group/app","https://dev.azure.com/org/project/_git/app","https://bitbucket.org/team/app","https://enterprise.example/acme/app","http://github.com/acme/app","https://token@github.com/acme/app","https://github.com/acme/app?token=value","https://github.com/acme/app#main","https://github.com/acme/app/tree/main","https://github.com/acme/%2fapp","https://github.com/acme/app:443"])assert.throws(()=>sourceRepository(url));
});

test("every source surface rejects a non-GitHub repository before external requests",async context=>{
  let requested=false;
  context.mock.method(globalThis,"fetch",async()=>{requested=true;throw new Error("No external request should be made.");});
  const url="https://gitlab.com/acme/app";
  await assert.rejects(readSourceRepository(url,"main"),/github.com/);
  await assert.rejects(readSourceSnapshot(url,"a".repeat(40)),/github.com/);
  await assert.rejects(publishSourceChanges(url,{sourceBranch:"main",targetBranch:"modernize/test",expectedCommitSha:"a".repeat(40),message:"reviewed",changes:[]}),/github.com/);
  await assert.rejects(createSourcePullRequest(url,{sourceBranch:"main",targetBranch:"modernize/test",title:"reviewed",body:"reviewed"}),/github.com/);
  assert.equal(requested,false);
});
