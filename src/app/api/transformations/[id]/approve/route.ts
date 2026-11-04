import {NextResponse} from "next/server";
import {z} from "zod";
import {AuthError,requireUser} from "@/lib/auth";
import {isDemoRequest} from "@/lib/demo-session";
import {demoEnabled} from "@/lib/env";
import {transaction} from "@/lib/db";
import {enforceRateLimit} from "@/lib/rate-limit";
import {recordApproval,ApprovalFailure} from "@/lib/approval-service";
import {ContentPolicyError} from "@/lib/content-policy";

const schema=z.object({commitSha:z.string().regex(/^[a-f0-9]{40}$/i),changesetDigest:z.string().regex(/^[a-f0-9]{64}$/i).optional(),decision:z.enum(["approved","rejected"]),comment:z.string().max(2000).optional()});

export async function POST(request:Request,context:{params:Promise<{id:string}>}){
  try{
    const {id}=await context.params;
    if(isDemoRequest(request))return NextResponse.json({id,decision:"approved",recorded:true,demo:true});
    const actor=await requireUser(request,["Modernization.Approver","Modernization.Admin"]);
    const rate=await enforceRateLimit(actor.tenantId,`transformation.approve:${id}`,10,60);
    if(!rate.allowed)return NextResponse.json({error:"Too many approval attempts. Retry after the current window resets."},{status:429,headers:{"Retry-After":String(rate.retryAfterSeconds)}});
    const input=schema.parse(await request.json());
    if(demoEnabled)return NextResponse.json({id,decision:input.decision,recorded:true,demo:true});
    await transaction(client=>recordApproval(client,{id,actor,...input,requestId:request.headers.get("x-request-id")||undefined}));
    return NextResponse.json({id,decision:input.decision,recorded:true});
  }catch(error){
    if(error instanceof AuthError||error instanceof ApprovalFailure||error instanceof ContentPolicyError)return NextResponse.json({error:error.message,...(error instanceof ApprovalFailure&&error.code?{code:error.code}:{})},{status:error.status});
    if(error instanceof z.ZodError)return NextResponse.json({error:"Invalid approval payload.",issues:error.issues},{status:400});
    console.error("Approval failed",error);
    return NextResponse.json({error:"The approval could not be recorded."},{status:500});
  }
}
