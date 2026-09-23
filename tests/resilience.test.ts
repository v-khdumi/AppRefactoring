import assert from "node:assert/strict";
import test from "node:test";
import { resilientFetch } from "../src/lib/resilient-fetch";
import { serviceBusNamespaceFromConnectionString } from "../src/lib/env";
import { isDemoRequest } from "../src/lib/demo-session";
import { assertAgentChangeAreas, claimAgentPath } from "../src/lib/agent-policy";

test("derives a Service Bus namespace without exposing credentials",()=>{
  assert.equal(serviceBusNamespaceFromConnectionString("Endpoint=sb://modernize.servicebus.windows.net/;SharedAccessKeyName=hidden;SharedAccessKey=hidden"),"modernize.servicebus.windows.net");
  assert.equal(serviceBusNamespaceFromConnectionString(undefined),undefined);
});

test("retries transient responses and returns the successful response",async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls+=1;return new Response(calls<3?"retry":"ok",{status:calls<3?503:200});};
  try{const response=await resilientFetch("https://example.test",{attempts:3,baseDelayMs:1,timeoutMs:1000,operation:"test.transient"});assert.equal(response.status,200);assert.equal(calls,3);}finally{globalThis.fetch=original;}
});

test("does not retry permanent client errors",async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls+=1;return new Response("invalid",{status:400});};
  try{const response=await resilientFetch("https://example.test",{attempts:3,baseDelayMs:1,timeoutMs:1000,operation:"test.permanent"});assert.equal(response.status,400);assert.equal(calls,1);}finally{globalThis.fetch=original;}
});

test("requires both demo header and server-issued session cookie",()=>{
  assert.equal(isDemoRequest(new Request("https://example.test",{headers:{"x-modernize-demo":"true"}})),false);
  assert.equal(isDemoRequest(new Request("https://example.test",{headers:{"x-modernize-demo":"true",cookie:"modernize-demo-session=enabled"}})),true);
  assert.equal(isDemoRequest(new Request("https://example.test",{headers:{cookie:"modernize-demo-session=enabled"}})),false);
});

test("enforces agent areas and exclusive path ownership",()=>{
  assert.doesNotThrow(()=>assertAgentChangeAreas("frontend",[{path:"src/page.tsx",area:"frontend"}]));
  assert.throws(()=>assertAgentChangeAreas("testing",[{path:"src/page.tsx",area:"frontend"}]),/cannot own/);
  const owners=new Map();claimAgentPath(owners,"src/page.tsx","frontend");
  assert.throws(()=>claimAgentPath(owners,"src/page.tsx","backend"),/ownership conflict/);
});

test("preserves caller cancellation and does not retry an aborted request", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  const reason = new Error("Analysis deadline exceeded");
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    assert.ok(init?.signal);
    return new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      controller.abort(reason);
    });
  };
  try {
    await assert.rejects(resilientFetch("https://example.test", { signal: controller.signal, attempts: 3 }), error => error === reason);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("does not dispatch an already cancelled request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("unexpected"); };
  const reason = new Error("Already timed out");
  try {
    await assert.rejects(resilientFetch("https://example.test", { signal: AbortSignal.abort(reason) }), error => error === reason);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});