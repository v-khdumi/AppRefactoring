import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import {sourceRepository,SourceClient,validateSourceInventory,bitbucketCommitBody,type SourceProvider} from "../src/lib/source-provider";

const source="a".repeat(40),candidate="b".repeat(40);
const urls:Record<SourceProvider,string>={github:"https://github.com/acme/app","github-enterprise":"https://git.example.test/acme/app",gitlab:"https://gitlab.com/group/subgroup/app","azure-repos":"https://dev.azure.com/acme/project/_git/app",bitbucket:"https://bitbucket.org/acme/app"};
const descriptor=(provider:SourceProvider)=>sourceRepository(urls[provider],JSON.stringify([{provider,origin:new URL(urls[provider]).origin,token:"test-service-credential"}]));
const json=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers:{"Content-Type":"application/json",...headers}});
const proposal={sourceBranch:"main",targetBranch:"modernize/slice",expectedCommitSha:source,message:"Reviewed modernization",changes:[{path:"src/app.txt",content:"candidate"}]};

test("source URLs identify all five providers and require configured enterprise hosts",()=>{
  for(const provider of Object.keys(urls) as SourceProvider[])assert.equal(descriptor(provider).provider,provider);
  assert.equal(sourceRepository("https://github.com/acme/app.git/").url,urls.github);
  assert.equal(descriptor("gitlab").name,"group/subgroup/app");
  assert.throws(()=>sourceRepository(urls["github-enterprise"]),/administrator-configured/);
  for(const url of ["http://github.com/acme/app","https://secret@github.com/acme/app","https://github.com/acme/app?token=secret","https://github.com/acme/app/tree/main","https://github.com/acme/app#main"])assert.throws(()=>sourceRepository(url));
  assert.throws(()=>sourceRepository(urls.gitlab,"not-json"));
  const malformed='raw-service-secret-with-broken-json';
  assert.throws(()=>sourceRepository(urls.gitlab,malformed),error=>error instanceof Error&&!error.message.includes(malformed));
});

test("source inventory rejects incomplete or unsafe source boundaries",()=>{
  const file={path:"src/app.ts",type:"blob",mode:"100644"};
  assert.doesNotThrow(()=>validateSourceInventory([file]));
  for(const invalid of [{...file,path:"../escape"},{...file,mode:"120000"},{...file,type:"commit"},{...file,path:".env.production"},{...file,path:"private.pem"},{...file,size:30_000_001}])assert.throws(()=>validateSourceInventory([invalid]));
  assert.throws(()=>validateSourceInventory([file,file]),/duplicate/);
});

test("GitLab snapshots read all pages from the pinned commit and preserve binary bytes",async()=>{
  const bytes=Buffer.from([0,1,2,255]);
  const blob=createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  const client=new SourceClient(descriptor("gitlab"),async(url,options)=>{
    assert.equal(new Headers(options?.headers).get("Authorization"),"Bearer test-service-credential");
    const parsed=new URL(url);
    if(parsed.pathname.endsWith("/repository/tree")){
      assert.equal(parsed.searchParams.get("ref"),source);
      return parsed.searchParams.get("page")==="2"?json([{path:"image.bin",type:"blob",mode:"100644",id:blob}]):json([] ,200,{"x-next-page":"2"});
    }
    assert.equal(parsed.searchParams.get("ref"),source);
    return new Response(bytes);
  });
  const files=await client.snapshot(source);
  assert.deepEqual(files,[{path:"image.bin",content:bytes.toString("base64"),executable:false}]);
});

test("pagination cannot exfiltrate credentials to another host or repository",async()=>{
  const client=new SourceClient(descriptor("bitbucket"),async()=>json({values:[],next:"https://attacker.example.test/steal"}));
  await assert.rejects(client.inventory(source),/left the configured repository/);
});

test("Bitbucket uploads preserve executable modes, explicit parents, and safe multipart fields",()=>{
  const multipart=bitbucketCommitBody({...proposal,changes:[{path:'bin/run"tool.sh',content:"#!/bin/sh\ntrue"},{path:"obsolete.txt",content:null}]},[{path:'bin/run"tool.sh',executable:true}]);
  assert.match(multipart.contentType,/^multipart\/form-data; boundary=modernize-/);
  assert.match(multipart.body,/name="parents"\r\n\r\na{40}/);
  assert.match(multipart.body,/x-attributes="executable"/);
  assert.match(multipart.body,/run%22tool\.sh/);
  assert.match(multipart.body,/name="files"\r\n\r\n\/obsolete\.txt/);
  assert.throws(()=>bitbucketCommitBody({...proposal,changes:[{path:"bad\r\nfile",content:"x"}]},[]),/Unsafe/);
});

for(const provider of ["gitlab","azure-repos","github-enterprise"] as const){
  test(`${provider} publication binds the new branch to the reviewed source`,async()=>{
    let writes=0;
    const blob=createHash("sha1").update("blob 9\0candidate").digest("hex");
    const client=new SourceClient(descriptor(provider),async(url,options={})=>{
      const path=new URL(url).pathname;
      if(options.method==="POST"){
        writes++;
        const body=JSON.parse(String(options.body));
        if(provider==="gitlab"){assert.equal(body.start_sha,source);assert.equal(body.branch,proposal.targetBranch);assert.equal(body.actions[0].action,"create");return json({id:candidate});}
        if(provider==="azure-repos"){assert.equal(body.refUpdates[0].oldObjectId,"0".repeat(40));assert.deepEqual(body.commits[0].parents,[source]);assert.equal(body.commits[0].changes[0].changeType,"add");return json({commits:[{commitId:candidate}]});}
        if(path.endsWith("/git/trees")){assert.equal(body.base_tree,"c".repeat(40));return json({sha:"d".repeat(40)});}
        if(path.endsWith("/git/commits")){assert.deepEqual(body.parents,[source]);return json({sha:candidate});}
        assert.equal(body.ref,`refs/heads/${proposal.targetBranch}`);return json({object:{sha:candidate}});
      }
      if(provider==="gitlab"){
        if(path.includes("/repository/branches/"))return path.endsWith("/main")?json({commit:{id:source,parent_ids:[]}}):writes?json({commit:{id:candidate,parent_ids:[source]}}):json({},404);
        if(path.includes("/repository/files/"))return new Response("candidate");
        return json(new URL(url).searchParams.get("ref")===candidate?[{path:"src/app.txt",type:"blob",mode:"100644",id:blob}]:[]);
      }
      if(provider==="azure-repos"){
        if(path.endsWith("/refs"))return json({value:new URL(url).searchParams.get("filter")==="heads/main"?[{name:"refs/heads/main",objectId:source}]:writes?[{name:`refs/heads/${proposal.targetBranch}`,objectId:candidate}]:[]});
        if(path.endsWith(`/commits/${source}`))return json({parents:[],treeId:"c".repeat(40)});
        if(path.endsWith(`/commits/${candidate}`))return json({parents:[source],treeId:"e".repeat(40)});
        if(path.endsWith("/items"))return new Response("candidate");
        return json({treeEntries:path.endsWith(`/trees/${"e".repeat(40)}`)?[{relativePath:"src/app.txt",objectType:"blob",mode:"100644",sha1:blob}]:[]});
      }
      if(path.endsWith("/git/ref/heads/main"))return json({object:{sha:source}});
      if(path.includes("/git/ref/heads/"))return writes?json({object:{sha:candidate}}):json({},404);
      if(path.endsWith(`/git/commits/${source}`))return json({tree:{sha:"c".repeat(40)},parents:[]});
      if(path.endsWith(`/git/commits/${candidate}`))return json({parents:[{sha:source}]});
      if(path.includes("/git/trees/"))return json({tree:path.includes(candidate)?[{path:"src/app.txt",type:"blob",mode:"100644",sha:blob}]:[],truncated:false});
      if(path.includes("/contents/"))return json({encoding:"base64",content:Buffer.from("candidate").toString("base64")});
      return json({},404);
    });
    assert.equal(await client.publish(proposal),candidate);
    assert.equal(writes,provider==="github-enterprise"?3:1);
  });
}

for(const provider of ["gitlab","azure-repos","bitbucket","github-enterprise"] as const){
  test(`${provider} source drift prevents every write`,async()=>{
    let writes=0;
    const client=new SourceClient(descriptor(provider),async(_url,options={})=>{
      if(options.method==="POST")writes++;
      return json(provider==="gitlab"?{commit:{id:candidate,parent_ids:[]}}:provider==="azure-repos"?{value:[{name:"refs/heads/main",objectId:candidate}],parents:[]}:provider==="bitbucket"?{target:{hash:candidate,parents:[]}}:{object:{sha:candidate},parents:[]});
    });
    await assert.rejects(client.publish(proposal),/source changed/);
    assert.equal(writes,0);
  });
  test(`${provider} pull request creation requires confirmed draft status`,async()=>{
    let posted=false;
    const client=new SourceClient(descriptor(provider),async(_url,options={})=>{
      if(options.method!=="POST")return json(provider==="gitlab"||provider==="github-enterprise"?[]:provider==="azure-repos"?{value:[]}:{values:[]});
      posted=true;const body=JSON.parse(String(options.body));
      if(provider==="gitlab"){assert.match(body.title,/^Draft:/);return json({draft:true,web_url:`${urls.gitlab}/-/merge_requests/1`});}
      if(provider==="azure-repos"){assert.equal(body.isDraft,true);return json({isDraft:true,pullRequestId:1});}
      assert.equal(body.draft,true);
      return json(provider==="bitbucket"?{draft:true,links:{html:{href:`${urls.bitbucket}/pull-requests/1`}}}:{draft:true,html_url:`${urls["github-enterprise"]}/pull/1`});
    });
    assert.match((await client.pullRequest({...proposal,title:"Modernization",body:"Reviewed evidence"})).html_url,/https:/);
    assert.equal(posted,true);
  });
}
