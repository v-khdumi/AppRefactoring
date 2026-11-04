import {NextResponse} from "next/server";
import {z} from "zod";
import {AuthError,requireUser} from "@/lib/auth";
import {isDemoRequest} from "@/lib/demo-session";
import {env} from "@/lib/env";
import {foundryModelParameters} from "@/lib/foundry-model";
import {resilientFetch} from "@/lib/resilient-fetch";
import {enforceRateLimit} from "@/lib/rate-limit";
import {assertNoCredentials,ContentPolicyError} from "@/lib/content-policy";
import {capabilityRequestSchema,capabilityDesignSchema,capabilityServices,rulesCapabilityDesign,type CapabilityRequest} from "@/lib/capability-design";
import {withRequestDeadline,RequestDeadlineError} from "@/lib/request-deadline";

function rulesResponse(input:CapabilityRequest,warning:string,demo=false){
  if(!demo)console.warn("Capability design used an explicitly labelled rules draft",warning);
  return NextResponse.json({...rulesCapabilityDesign(input),source:demo?"demo":"rules",warning,clarifications:input.answers});
}

export async function POST(request:Request){
  try{
    const demo=isDemoRequest(request);
    if(!demo){
      const user=await requireUser(request,["Modernization.Reader","Modernization.Admin"]);
      const rate=await enforceRateLimit(user.tenantId,"capability.design",30,3600);
      if(!rate.allowed)return NextResponse.json({error:"The hourly capability-design limit has been reached."},{status:429,headers:{"Retry-After":String(rate.retryAfterSeconds)}});
    }
    const input=capabilityRequestSchema.parse(await request.json());
    assertNoCredentials([{path:"capability requirements",content:JSON.stringify(input)}]);
    if(demo)return rulesResponse(input,"Demonstration requirements draft; no model inference or external integration was executed.",true);
    if(!env.AZURE_AI_FOUNDRY_ENDPOINT||!env.AZURE_AI_FOUNDRY_API_KEY)return rulesResponse(input,"Foundry is not configured. This is a rules-based requirements draft, not an AI analysis.");
    return await withRequestDeadline(async signal=>{
      const system=`You are a senior AI product architect. Turn the requested feature and all clarification answers into an application-specific implementation design. Ask at most four essential questions with status needs-clarification; otherwise use ready. Return JSON with status, name, summary, questions [{id,question,why,options,required}], frontend, backend, data, azure, services, testing, security, acceptanceCriteria. Every ready design needs meaningful frontend, backend, data, testing, security and measurable acceptance criteria. services contains only explicit required values from ${capabilityServices.join(", ")}; do not infer provisioned resources from prose. Distinguish mocks from live integrations and require an executed acceptance harness. Never claim execution, approval or deployment.`;
      const response=await resilientFetch(`${env.AZURE_AI_FOUNDRY_ENDPOINT!.replace(/\/$/,"")}/chat/completions?api-version=${encodeURIComponent(process.env.AZURE_AI_FOUNDRY_API_VERSION||"2024-05-01-preview")}`,{
        method:"POST",headers:{"Content-Type":"application/json","api-key":env.AZURE_AI_FOUNDRY_API_KEY!},
        body:JSON.stringify({model:env.AZURE_AI_FOUNDRY_MODEL,...foundryModelParameters(env.AZURE_AI_FOUNDRY_MODEL,.05),response_format:{type:"json_object"},messages:[{role:"system",content:system},{role:"user",content:JSON.stringify(input)}]}),
        attempts:2,timeoutMs:45000,operation:"foundry.capability_design",signal,
      });
      if(!response.ok){await response.body?.cancel();return rulesResponse(input,`Foundry returned HTTP ${response.status}. The displayed plan is a rules-based draft, not completed AI inference.`);}
      const payload=await response.json() as {choices?:Array<{message?:{content?:string}}>};
      const content=payload.choices?.[0]?.message?.content;
      if(!content)return rulesResponse(input,"Foundry returned no design. The displayed plan is a rules-based draft.");
      try{
        const design=capabilityDesignSchema.parse(JSON.parse(content));
        assertNoCredentials([{path:"capability design",content:JSON.stringify(design)}]);
        return NextResponse.json({...design,source:"foundry",clarifications:input.answers});
      }catch(error){
        if(error instanceof ContentPolicyError)throw error;
        if(!(error instanceof SyntaxError||error instanceof z.ZodError))throw error;
        return rulesResponse(input,"Foundry returned an invalid design which was rejected. The displayed plan is a rules-based draft.");
      }
    },120000,"Capability design timed out. No modernization was queued.");
  }catch(error){
    if(error instanceof AuthError||error instanceof ContentPolicyError)return NextResponse.json({error:error.message},{status:error.status});
    if(error instanceof z.ZodError)return NextResponse.json({error:"Capability requirements are invalid.",issues:error.issues},{status:400});
    if(error instanceof RequestDeadlineError)return NextResponse.json({error:error.message},{status:504});
    console.error("Capability design failed",error instanceof Error?error.message:error);
    return NextResponse.json({error:"Capability design could not be completed."},{status:500});
  }
}
