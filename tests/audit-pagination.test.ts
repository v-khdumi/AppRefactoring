import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error standalone verifier audit adapter
import {osvFindings} from "../scripts/verification-runner.mjs";

test("native dependency auditing follows every OSV result page without dropping advisories",async()=>{
  const queried:string[]=[];
  const first={id:"DEBIAN-CVE-first",affected:[{package:{name:"lib",ecosystem:"Debian:12"},ecosystem_specific:{urgency:"low"}}]};
  const second={id:"DEBIAN-CVE-second",affected:[{package:{name:"lib",ecosystem:"Debian:12"},ecosystem_specific:{urgency:"high"}}]};
  const findings=await osvFindings("Debian:12",[{name:"lib",version:"1"}],async(url:string,options:RequestInit={})=>{
    if(url.endsWith("querybatch"))return Response.json({results:[{vulns:[{id:first.id}],next_page_token:"next"}]});
    const body=JSON.parse(String(options.body));queried.push(body.page_token||"first");
    return Response.json(body.page_token?{vulns:[second]}:{vulns:[first],next_page_token:"next"});
  });
  assert.deepEqual(queried,["first","next"]);
  assert.deepEqual(findings.map((item:{id:string;severity:string})=>[item.id,item.severity]),[[first.id,"low"],[second.id,"high"]]);
});
test("invalid and looping advisory pages fail closed",async()=>{
  await assert.rejects(osvFindings("Debian:12",[{name:"lib",version:"1"}],async(url:string)=>Response.json(url.endsWith("querybatch")?{results:[{vulns:[],next_page_token:"loop"}]}:{vulns:[],next_page_token:"loop"})),/repeated/);
});
