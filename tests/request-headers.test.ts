import assert from "node:assert/strict";
import test from "node:test";
import {workspaceRequestHeaders} from "../src/lib/request-headers";

test("authenticated requests preserve Request and Headers values without mutating callers",()=>{
  const request=new Request("https://workspace.example/api/runs",{headers:{"X-Original":"retained","Content-Type":"text/plain"}});
  const supplied=new Headers({"Content-Type":"application/json","X-New":"retained"});
  const headers=workspaceRequestHeaders(request,supplied,"https://workspace.example");
  assert.equal(headers.get("X-Original"),"retained");
  assert.equal(headers.get("X-New"),"retained");
  assert.equal(headers.get("Content-Type"),"application/json");
  headers.set("Authorization","Bearer fixture");
  assert.equal(supplied.has("Authorization"),false);
  assert.equal(workspaceRequestHeaders("/api/runs",undefined,"https://workspace.example").has("Authorization"),false);
});
test("workspace authorization cannot be attached to a different host or protocol",()=>{
  for(const url of ["https://external.example/api","//external.example/api","http://workspace.example/api"]){
    assert.throws(()=>workspaceRequestHeaders(url,undefined,"https://workspace.example"),/cannot leave/);
  }
});
