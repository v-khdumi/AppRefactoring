import assert from "node:assert/strict";
import test from "node:test";
import {env} from "../src/lib/env";
import {POST} from "../src/app/api/github/webhook/route";

test("disabled webhook ingestion rejects all requests before reading the payload or using persistence",async()=>{
  const original=env.GITHUB_WEBHOOK_ENABLED;
  try{
    env.GITHUB_WEBHOOK_ENABLED="false";
    const response=await POST(new Request("https://app.example.test/api/github/webhook",{method:"POST",body:"not-a-github-payload"}));
    assert.equal(response.status,503);
    assert.match((await response.json()).error,/explicitly disabled/);
    assert.equal(response.headers.get("cache-control"),"no-store");
  }finally{env.GITHUB_WEBHOOK_ENABLED=original;}
});
