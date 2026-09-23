import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import type { UserContext } from "../src/lib/auth";
import { deleteProject } from "../src/lib/delete-project";

const user = {id:"admin",name:"Administrator",tenantId:"tenant-a",roles:["Modernization.Admin"]} as UserContext;
function fixture(status: string, active = false, exists = true) {
  const statements: Array<{sql:string;values:unknown[]}> = [];
  const client = {query:async(sql:string,values:unknown[]) => {
    statements.push({sql,values});
    if (sql.includes("FOR UPDATE")) return {rowCount:exists?1:0,rows:exists?[{status,target_branch:"modernize/test",repository_url:"https://github.com/fixture/test"}]:[]};
    if (sql.includes("UNION ALL")) return {rowCount:active?1:0,rows:[]};
    return {rowCount:1,rows:[]};
  }} as unknown as PoolClient;
  return {client,statements};
}

test("deletes only a tenant-scoped inactive project after writing an audit event",async()=>{
  const {client,statements}=fixture("failed");
  assert.equal((await deleteProject(client,user,"run-1","modernize/test")).status,200);
  assert.match(statements[0].sql,/tenant_id=\$2 FOR UPDATE/);
  assert.deepEqual(statements[0].values,["run-1","tenant-a"]);
  assert.match(statements[1].sql,/run_id=\$1::uuid/);
  assert.match(statements[1].sql,/aggregate_id=\$1::text/);
  assert.match(statements[2].sql,/INSERT INTO audit_events/);
  assert.match(statements[3].sql,/DELETE FROM modernization_runs WHERE id=\$1 AND tenant_id=\$2/);
  assert.ok(!statements.some(statement=>/DELETE FROM audit_events/.test(statement.sql)));
});

test("unknown tenant project and wrong branch cannot be deleted",async()=>{
  for (const scenario of [{exists:false,branch:"modernize/test",status:404},{exists:true,branch:"wrong",status:400}]) {
    const {client,statements}=fixture("failed",false,scenario.exists);
    assert.equal((await deleteProject(client,user,"run-1",scenario.branch)).status,scenario.status);
    assert.equal(statements.length,1);
  }
});

test("active run, active agent and pending publication block deletion",async()=>{
  for (const [status,active] of [["running",false],["approved",false],["failed",true],["cancelled",true]] as const) {
    const {client,statements}=fixture(status,active);
    assert.equal((await deleteProject(client,user,"run-1","modernize/test")).status,409);
    assert.ok(!statements.some(statement=>statement.sql.startsWith("DELETE")));
  }
});