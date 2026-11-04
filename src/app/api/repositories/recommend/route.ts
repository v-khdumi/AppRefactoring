import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { isDemoRequest } from "@/lib/demo-session";
import { inspectRepository, parseGitHubUrl, readRepositoryFile } from "@/lib/github";
import {readSourceRepository,sourceRepository,SourceRequestError} from "@/lib/source-provider";
import { demoStackRecommendation, recommendStack } from "@/lib/stack-recommendation";
import { enforceRateLimit } from "@/lib/rate-limit";
import {selectEvidenceFiles,repositoryEvidence} from "@/lib/repository-evidence";
import {readVerificationReadiness,VerificationReadinessError} from "@/lib/verification-readiness";
import {ContentPolicyError} from "@/lib/content-policy";

const schema=z.object({url:z.string().url(),branch:z.string().min(1).max(200).default("main"),scope:z.enum(["frontend","backend","fullstack"])});
export async function POST(request:Request){
  try{
    if(isDemoRequest(request))return NextResponse.json(demoStackRecommendation());
    const user=await requireUser(request,["Modernization.Reader","Modernization.Admin"]);
    const rate=await enforceRateLimit(user.tenantId,"repository.recommend",30,3600);
    if(!rate.allowed)return NextResponse.json({error:"The hourly repository-analysis limit has been reached."},{status:429,headers:{"Retry-After":String(rate.retryAfterSeconds)}});
    const input=schema.parse(await request.json());
    const descriptor=sourceRepository(input.url);
    let files:Array<{path:string;size?:number}>;
    let readSource:(path:string)=>Promise<string>;
    try{
      const repository=await readSourceRepository(input.url,input.branch);
      files=repository.files;readSource=repository.readFile;
    }catch(error){
      if(descriptor.provider!=="github")throw error;
      console.warn("GitHub App read failed; checking public read-only access",error instanceof Error?error.message:error);
      const parsed=parseGitHubUrl(input.url);
      const repository=await inspectRepository(input.url,undefined,input.branch);
      files=repository.files;readSource=path=>readRepositoryFile(parsed.owner,parsed.repo,path,repository.sourceSha);
    }
    const samples=await Promise.all(selectEvidenceFiles(files,input.scope).map(async file=>({path:file.path,content:await readSource(file.path)})));
    const paths=files.map(file=>file.path);
    const readiness=await readVerificationReadiness(files,async path=>samples.find(sample=>sample.path===path)?.content??await readSource(path),{scope:input.scope});
    const evidence=repositoryEvidence(paths,samples,input.scope);
    return NextResponse.json({...await recommendStack({repository:descriptor.name,scope:input.scope,paths,samples,evidence}),evidence,verificationReadiness:readiness});
  }catch(error){
    if(error instanceof VerificationReadinessError)return NextResponse.json({error:error.message,code:error.name,readiness:error.readiness},{status:422});
    if(error instanceof AuthError||error instanceof ContentPolicyError)return NextResponse.json({error:error.message},{status:error.status});
    if(error instanceof SourceRequestError)return NextResponse.json({error:error.message},{status:422});
    if(error instanceof z.ZodError)return NextResponse.json({error:"The repository URL, source connection or branch is invalid.",issues:error.issues},{status:400});
    console.error("Stack recommendation failed",error instanceof Error?error.message:error);
    return NextResponse.json({error:error instanceof Error?error.message:"The repository recommendation could not be prepared."},{status:503});
  }
}