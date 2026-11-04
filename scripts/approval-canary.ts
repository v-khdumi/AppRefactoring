import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdir,chown,readdir,readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import pg from "pg";
import {recordApproval,ApprovalFailure} from "../src/lib/approval-service";
import {changesetDigest,npmVerificationCommands} from "../src/lib/verification-evidence";
import type {UserContext} from "../src/lib/auth";

if(process.platform!=="linux"||process.getuid?.()!==0)throw new Error("Run only in a dedicated ephemeral Linux canary job.");
if(process.env.DATABASE_URL||process.env.GITHUB_APP_PRIVATE_KEY||process.env.VERIFICATION_TOKEN)throw new Error("This canary must not receive production credentials or capabilities.");

function command(executable:string,args:string[],uid?:number,gid=uid){
  const result=spawnSync(executable,args,{uid,gid,encoding:"utf8",timeout:240000,maxBuffer:16_000_000,env:{NODE_ENV:"test",PATH:"/usr/bin:/usr/local/bin:/bin",HOME:"/tmp",LANG:"C.UTF-8",DEBIAN_FRONTEND:"noninteractive"}});
  if(result.error||result.status!==0)throw new Error(`Canary command failed: ${executable}: ${result.error?.message||result.stderr.slice(-2000)}`);
  return result.stdout.trim();
}

async function main(){
  command("apt-get",["update"]);
  command("apt-get",["install","-y","--no-install-recommends","postgresql","postgresql-contrib"]);
  const versions=(await readdir("/usr/lib/postgresql")).filter(version=>/^\d+$/.test(version)).sort((first,second)=>Number(second)-Number(first));
  if(!versions.length)throw new Error("No PostgreSQL verifier binary was installed.");
  const binaries=`/usr/lib/postgresql/${versions[0]}/bin`;
  const uid=Number(command("id",["-u","postgres"]));
  const gid=Number(command("id",["-g","postgres"]));
  if(!Number.isSafeInteger(uid)||uid<1||!Number.isSafeInteger(gid)||gid<1)throw new Error("PostgreSQL must run under a non-root identity.");
  const directory="/tmp/modernize-approval-postgres";
  await mkdir(directory,{mode:0o700});await chown(directory,uid,gid);
  command(`${binaries}/initdb`,["-D",directory,"-A","trust","--no-locale","-E","UTF8"],uid,gid);
  command(`${binaries}/pg_ctl`,["-D",directory,"-l",`${directory}/server.log`,"-o","-h 127.0.0.1 -p 55432","-w","start"],uid,gid);
  const pool=new pg.Pool({host:"127.0.0.1",port:55432,user:"postgres",database:"postgres",max:5});
  try{
    const migrations=process.env.CANARY_MIGRATIONS?JSON.parse(Buffer.from(process.env.CANARY_MIGRATIONS,"base64").toString("utf8")) as Array<{name:string;content:string}>:await Promise.all((await readdir("database")).filter(name=>name.endsWith(".sql")).sort().map(async name=>({name,content:await readFile(path.join("database",name),"utf8")})));
    if(!migrations.length)throw new Error("Canary migrations are missing.");
    delete process.env.CANARY_MIGRATIONS;
    await pool.query("CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for(const migration of migrations){await pool.query(migration.content);await pool.query("INSERT INTO schema_migrations(name) VALUES($1)",[migration.name]);}
    const sourceSha="a".repeat(40);
    const actor=(id:string):UserContext=>({id,name:id,roles:["Modernization.Approver"],tenantId:"canary-tenant"});
    async function seed(){
      const id=randomUUID();
      const changes=[{path:"src/app.ts",operation:"modified",content:"candidate"}];
      const digest=changesetDigest(sourceSha,changes);
      const steps=(["baseline","candidate"] as const).flatMap(variant=>npmVerificationCommands.map(command=>({variant,project:".",command,exitCode:0,timedOut:false,log:"Seeded verifier evidence for SQL transaction tests.",durationMs:1,tests:command===npmVerificationCommands[2]?{tests:1,failed:0,skipped:0}:undefined})));
      await pool.query("INSERT INTO modernization_runs(id,tenant_id,repository_url,source_branch,target_branch,scope,status,source_commit_sha,created_by) VALUES($1,'canary-tenant','https://github.com/example/isolated-canary','main',$3,'backend','awaiting-approval',$2,'creator')",[id,sourceSha,`modernize/canary-${id}`]);
      await pool.query("INSERT INTO transformation_changes(run_id,path,operation,area,rationale,before_content,after_content,validation) VALUES($1,'src/app.ts','modified','backend','Synthetic canary change','baseline','candidate','[\"executed evidence\"]'::jsonb)",[id]);
      await pool.query("INSERT INTO agent_tasks(run_id,agent_type,status,progress,objective) VALUES($1,'testing','passed',100,'Synthetic transaction test')",[id]);
      await pool.query("INSERT INTO verification_jobs(run_id,tenant_id,source_sha,changeset_digest,token_hash,expires_at,status,report) VALUES($1,'canary-tenant',$2,$3,$4,now()+interval '75 minutes','passed',$5::jsonb)",[id,sourceSha,digest,"0".repeat(64),JSON.stringify({status:"passed",reason:"Seeded report for transaction semantics only.",steps})]);
      return {id,digest};
    }
    async function approve(run:{id:string;digest:string},user:UserContext,digest=run.digest){
      const client=await pool.connect();
      try{
        await client.query("BEGIN");
        await recordApproval(client,{id:run.id,actor:user,commitSha:sourceSha,changesetDigest:digest,decision:"approved"});
        await client.query("COMMIT");
      }catch(error){await client.query("ROLLBACK");throw error;}
      finally{client.release();}
    }
    async function noWrites(id:string){
      const result=await pool.query("SELECT (SELECT count(*)::int FROM approvals WHERE run_id=$1) AS approvals,(SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1::text) AS events",[id]);
      assert.deepEqual(result.rows[0],{approvals:0,events:0});
    }
    const self=await seed();
    await assert.rejects(approve(self,actor("creator")),error=>error instanceof ApprovalFailure&&error.status===403);
    await noWrites(self.id);
    const edited=await seed();
    await pool.query("INSERT INTO user_code_edits(run_id,path,content,edited_by,base_version) VALUES($1,'src/app.ts','candidate','editor',1)",[edited.id]);
    await assert.rejects(approve(edited,actor("editor")),error=>error instanceof ApprovalFailure&&error.status===403);
    await noWrites(edited.id);
    const stale=await seed();
    await assert.rejects(approve(stale,actor("reviewer"),"f".repeat(64)),error=>error instanceof ApprovalFailure&&error.status===409);
    await noWrites(stale.id);
    const tenant=await seed();
    await assert.rejects(approve(tenant,{...actor("reviewer"),tenantId:"another-tenant"}),error=>error instanceof ApprovalFailure&&error.status===404);
    await noWrites(tenant.id);
    const emptyTests=await seed();
    await pool.query("UPDATE verification_jobs SET report=jsonb_set(report,'{steps,2,tests,tests}','0'::jsonb) WHERE run_id=$1",[emptyTests.id]);
    await assert.rejects(approve(emptyTests,actor("reviewer")),error=>error instanceof ApprovalFailure&&error.code==="VerificationRequired");
    await noWrites(emptyTests.id);
    const race=await seed();
    const results=await Promise.allSettled([approve(race,actor("reviewer-a")),approve(race,actor("reviewer-b"))]);
    assert.equal(results.filter(result=>result.status==="fulfilled").length,1);
    const counts=await pool.query("SELECT (SELECT count(*)::int FROM approvals WHERE run_id=$1) AS approvals,(SELECT count(*)::int FROM outbox_events WHERE aggregate_id=$1::text) AS events,(SELECT status FROM modernization_runs WHERE id=$1) AS status",[race.id]);
    assert.deepEqual(counts.rows[0],{approvals:1,events:1,status:"approved"});
    await assert.rejects(pool.query("UPDATE audit_events SET actor_name='modified' WHERE resource_id=$1",[race.id]));
    const version=await pool.query<{version:string}>("SELECT version()");
    console.log(JSON.stringify({event:"approval.postgres.canary",passed:true,postgres:version.rows[0].version,migrations:migrations.length,selfApprovalRejected:true,contributorApprovalRejected:true,staleDigestRejected:true,tenantIsolation:true,zeroTestEvidenceRejected:true,concurrentApprovals:counts.rows[0],appendOnlyAudit:true}));
  }finally{await pool.end();command(`${binaries}/pg_ctl`,["-D",directory,"-m","fast","-w","stop"],uid,gid);}
}

void main().catch(error=>{console.error(error);process.exitCode=1;});
