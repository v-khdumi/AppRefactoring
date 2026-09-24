import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { query, transaction } from "@/lib/db";
import { changesetDigest, reportPassed, reportMatchesSnapshot, verificationReportSchema } from "@/lib/verification-evidence";
import { currentChanges, deleteWindowsVerifier } from "@/lib/verification-service";
import {acceptPreparedLocks,preparedFilesSchema} from "@/lib/verification-artifacts";

async function capability(request:Request,id:string){
  if(!z.string().uuid().safeParse(id).success)return null;
  const token=request.headers.get("authorization")?.replace(/^Bearer /,"")||"";
  if(!/^[a-f0-9]{64}$/.test(token))return null;
  const result=await query<{id:string;run_id:string;tenant_id:string;token_hash:string;snapshot:unknown|null}>("SELECT id,run_id,tenant_id,token_hash,snapshot FROM verification_jobs WHERE id=$1 AND status IN ('preparing','running') AND expires_at>now()",[id]);
  const job=result.rows[0];
  if(!job)return null;
  const actual=createHash("sha256").update(token).digest();
  const expected=Buffer.from(job.token_hash,"hex");
  return expected.length===actual.length&&timingSafeEqual(expected,actual)?job:null;
}

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  const {id}=await context.params;
  const job=await capability(request,id);
  if(!job)return NextResponse.json({error:"Not found."},{status:404});
  const scriptKind=new URL(request.url).searchParams.get("script");
  if(scriptKind==="1")return new Response(await readFile("scripts/verification-runner.mjs","utf8"),{headers:{"Content-Type":"text/javascript","Cache-Control":"no-store"}});
  if(scriptKind==="windows")return new Response(await readFile("scripts/windows-verification-runner.ps1","utf8"),{headers:{"Content-Type":"text/plain; charset=utf-8","Cache-Control":"no-store"}});
  if(!job.snapshot)return NextResponse.json({error:"Snapshot not ready."},{status:409});
  return NextResponse.json(job.snapshot,{headers:{"Cache-Control":"no-store"}});
}

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  const {id}=await context.params;
  const job=await capability(request,id);
  if(!job)return NextResponse.json({error:"Not found."},{status:404});
  const body=await request.json();
  if(body&&typeof body==="object"&&"preparedFiles" in body){
    const prepared=preparedFilesSchema.safeParse(body.preparedFiles);
    if(!prepared.success)return NextResponse.json({error:"Invalid dependency artifacts."},{status:400});
    try{return NextResponse.json(await transaction(client=>acceptPreparedLocks(client,job,prepared.data)));}
    catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Dependency preparation rejected."},{status:409});}
  }
  const parsed=z.object({report:verificationReportSchema,final:z.boolean()}).safeParse(body);
  if(!parsed.success)return NextResponse.json({error:"Invalid execution report."},{status:400});
  const {report,final}=parsed.data;
  let windowsCleanup=false;
  await transaction(async client=>{
    const runs=await client.query<{source_commit_sha:string;status:string}>("SELECT source_commit_sha,status FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[job.run_id,job.tenant_id]);
    const run=runs.rows[0];
    const current=await client.query("SELECT status,snapshot,source_sha,changeset_digest FROM verification_jobs WHERE id=$1 AND expires_at>now() FOR UPDATE",[id]);
    if(!current.rows[0]||!["running","preparing"].includes(current.rows[0].status))return;
    windowsCleanup=Boolean(final&&(current.rows[0].snapshot as {windows?:boolean}|null)?.windows);
    const changes=await currentChanges(client,job.run_id);
    const currentJob=current.rows[0];
    const matches=run&&changesetDigest(run.source_commit_sha,changes)===currentJob.changeset_digest&&run.source_commit_sha===currentJob.source_sha;
    let status=final?report.status:"running";
    if(!matches||!["blocked","failed","awaiting-approval"].includes(run?.status||""))status="stale";
    if(final&&status==="passed"&&!reportPassed(report))status="failed";
    if(final&&status==="passed"&&!reportMatchesSnapshot(report,currentJob.snapshot||{}))status="failed";
    await client.query("UPDATE verification_jobs SET status=$2,report=$3::jsonb,updated_at=now(),snapshot=CASE WHEN $4 THEN NULL ELSE snapshot END WHERE id=$1",[id,status,JSON.stringify(report),final||status==="stale"]);
    if(final&&matches&&status!=="stale"){
      await client.query("UPDATE modernization_runs SET status=$3,current_stage=$4,progress=$5,error_code=$6,error_detail=$7,updated_at=now(),version=version+1 WHERE id=$1 AND tenant_id=$2",[job.run_id,job.tenant_id,status==="passed"?"awaiting-approval":"blocked",status==="passed"?"human-approval":"verification-failed",status==="passed"?90:75,status==="passed"?null:"VerificationFailed",status==="passed"?null:report.reason]);
      if(status==="passed")await client.query("UPDATE transformation_changes SET user_modified=false,validation=$2::jsonb WHERE run_id=$1",[job.run_id,JSON.stringify([`Executed verification ${id}: baseline and candidate build/tests passed; candidate audit passed. See report for baseline audit findings.`])]);
      await client.query("INSERT INTO audit_events(tenant_id,actor_id,actor_name,action,resource_type,resource_id,data) VALUES($1,'verification-runner','Isolated verification runner',$2,'run',$3,$4::jsonb)",[job.tenant_id,`verification.${status}`,job.run_id,JSON.stringify({jobId:id,digest:currentJob.changeset_digest,steps:report.steps.length})]);
    }
  });
  if(windowsCleanup)setTimeout(()=>{void deleteWindowsVerifier(id).catch(error=>console.error("Windows verifier cleanup failed",error instanceof Error?error.message:error));},5000);
  return NextResponse.json({recorded:true});
}