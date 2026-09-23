import assert from "node:assert/strict";
import test from "node:test";
import type {Pool,PoolClient} from "pg";
import {requireActiveRun,reserveRefinement,withRunLock,noteQueueDelay} from "../src/lib/run-coordination";
test("run lock prevents duplicate workers and is released on failure",async()=>{
 const calls:string[]=[];let acquired=false;
 const client={query:async(sql:string)=>{calls.push(sql);return {rows:[{acquired}]};},release:()=>{calls.push("release");}};
 const pool={connect:async()=>client} as unknown as Pick<Pool,"connect">;
 let executions=0;await withRunLock(pool,"run","tenant",async()=>{executions++;});assert.equal(executions,0);
 acquired=true;await assert.rejects(withRunLock(pool,"run","tenant",async()=>{throw Error("provider failed");}),/provider failed/);
 assert.ok(calls.some(sql=>sql.includes("pg_advisory_unlock")));assert.equal(calls.at(-1),"release");
});
test("non-active runs refuse stale agent results",async()=>{
 const client={query:async()=>({rows:[],rowCount:0})} as unknown as Pick<PoolClient,"query">;
 await assert.rejects(requireActiveRun(client,"run","tenant"),/no longer active/);
});
test("refinement invalidates approval evidence and persists recovery request atomically",async()=>{
 const calls:Array<{sql:string;values:unknown[]}>=[];
 const client={query:async(sql:string,values:unknown[]=[])=>{
  calls.push({sql,values});
  if(sql.includes("advisory"))return {rows:[{acquired:true}]};
  if(sql.startsWith("SELECT status"))return {rows:[{status:"awaiting-approval",options:{}}],rowCount:1};
  if(sql.startsWith("SELECT 1 FROM verification"))return {rows:[],rowCount:0};
  return {rows:[],rowCount:1};
 }} as unknown as Pick<PoolClient,"query">;
 await reserveRefinement(client,{runId:"run",tenantId:"tenant",agentType:"frontend",instruction:"Preserve API contract",actorId:"user"});
 assert.ok(calls.some(call=>call.sql.includes("verification_jobs SET status='stale'")));
 const update=calls.find(call=>call.sql.includes("pendingRefinement"))!;
 assert.match(update.sql,/status='queued'/);assert.equal(JSON.parse(String(update.values[2])).agentType,"frontend");
});
test("unconfirmed queue delivery only annotates still-queued tenant runs",async()=>{
 const client={query:async(sql:string,values:unknown[])=>{assert.match(sql,/AND status='queued'/);assert.match(sql,/tenant_id=\$2/);assert.ok(!sql.includes("SET status="));assert.deepEqual(values,["run","tenant"]);return {rowCount:1};}} as unknown as Pick<PoolClient,"query">;
 await noteQueueDelay(client,"run","tenant");
});