import assert from "node:assert/strict";
import test from "node:test";
import {retryPublication} from "../src/lib/publication-retry";
import type {PoolClient} from "pg";
function fixture({acquired=true,error="Permission denied",hasEvent=true}={}){
 const calls:Array<{sql:string;values:unknown[]}>=[];
 const client={query:async(sql:string,values:unknown[]=[])=>{calls.push({sql,values});if(sql.includes("advisory"))return {rows:[{acquired}]};if(sql.startsWith("SELECT id"))return {rowCount:hasEvent?1:0,rows:hasEvent?[{id:"event",last_error:error}]:[]};return {rowCount:1,rows:[]};}} as unknown as Pick<PoolClient,"query">;
 return {client,calls};
}
test("publication retry preserves approved progress and uses only tenant-scoped pending event",async()=>{
 const {client,calls}=fixture();assert.equal(await retryPublication(client,"run","tenant","approved"),true);
 assert.deepEqual(calls[1].values,["run","tenant"]);
 assert.match(calls[1].sql,/tenant_id=\$2/);
 assert.deepEqual(calls[2].values,["event"]);
 assert.ok(!calls[3].sql.includes("progress="));
 assert.ok(calls.every(call=>!call.sql.includes("agent_tasks")&&!call.sql.includes("approvals")));
});
test("active publisher, missing event and already queued publication cannot be retried",async()=>{
 for(const options of [{acquired:false},{error:""},{hasEvent:false}]){
  const {client,calls}=fixture(options);await assert.rejects(retryPublication(client,"run","tenant","approved"));assert.ok(calls.every(call=>!call.sql.startsWith("UPDATE")));
 }
});