import { after, NextResponse } from "next/server";
import { AuthError, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { dispatchVerification, prepareVerification } from "@/lib/verification-service";
import { enforceRateLimit } from "@/lib/rate-limit";

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    const user=await requireUser(request,["Modernization.Admin"]);
    const {id}=await context.params;
    const rate=await enforceRateLimit(user.tenantId,"verification.create",10,3600);
    if(!rate.allowed)return NextResponse.json({error:"The hourly verification limit has been reached."},{status:429});
    const prepared=await prepareVerification(id,user.tenantId);
    after(async()=>{await dispatchVerification(prepared).catch(error=>console.error("Verification dispatch failed",error instanceof Error?error.message:"Unknown error"));});
    return NextResponse.json({id:prepared.id,status:"preparing"},{status:202});
  }catch(error){
    if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});
    return NextResponse.json({error:error instanceof Error?error.message:"Verification could not start."},{status:409});
  }
}

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    const user=await requireUser(request,["Modernization.Reader","Modernization.Admin"]);
    const {id}=await context.params;
    const result=await query("SELECT id,status,error,report,source_sha,changeset_digest,created_at,updated_at,expires_at FROM verification_jobs WHERE run_id=$1 AND tenant_id=$2 ORDER BY created_at DESC LIMIT 1",[id,user.tenantId]);
    const job=result.rows[0];
    if(job&&["preparing","running"].includes(job.status)&&Date.parse(job.expires_at)<Date.now())return NextResponse.json({job:{...job,status:"failed",error:"Verification deadline exceeded."}});
    return NextResponse.json({job:job||null},{headers:{"Cache-Control":"no-store"}});
  }catch(error){if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});return NextResponse.json({error:"Verification status unavailable."},{status:500});}
}