import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { isDemoRequest } from "@/lib/demo-session";
import { inspectRepository, parseGitHubUrl, readRepositoryFile } from "@/lib/github";
import { readInstalledFile, readInstalledRepository } from "@/lib/github-app";
import { demoStackRecommendation, recommendStack } from "@/lib/stack-recommendation";
import { enforceRateLimit } from "@/lib/rate-limit";
import {selectEvidenceFiles,repositoryEvidence} from "@/lib/repository-evidence";
import {readVerificationReadiness,VerificationReadinessError} from "@/lib/verification-readiness";

const schema=z.object({url:z.string().url().refine(value=>value.startsWith("https://github.com/"),"Only GitHub repositories are supported."),branch:z.string().min(1).max(200).default("main"),scope:z.enum(["frontend","backend","fullstack"])});
export async function POST(request:Request){try{const explicitDemo=isDemoRequest(request);if(explicitDemo)return NextResponse.json(demoStackRecommendation());const user=await requireUser(request,["Modernization.Reader","Modernization.Admin"]);const rate=await enforceRateLimit(user.tenantId,"repository.recommend",30,3600);if(!rate.allowed)return NextResponse.json({error:"The hourly repository-analysis limit has been reached."},{status:429,headers:{"Retry-After":String(rate.retryAfterSeconds)}});const input=schema.parse(await request.json());const parsed=parseGitHubUrl(input.url);let paths:string[]=[];let samples:Array<{path:string;content:string}>=[];
	let readSource:(path:string)=>Promise<string>;
	try{const repository=await readInstalledRepository(parsed.owner,parsed.repo,input.branch);readSource=path=>readInstalledFile(parsed.owner,parsed.repo,path,repository.sourceSha,repository.token);const candidates=selectEvidenceFiles(repository.files,input.scope);paths=repository.files.map(file=>file.path);samples=await Promise.all(candidates.map(async file=>({path:file.path,content:await readSource(file.path)})));}
	catch(appError){console.warn("GitHub App access unavailable; checking public repository access",appError instanceof Error?appError.message:appError);try{const repository=await inspectRepository(input.url,undefined,input.branch);readSource=path=>readRepositoryFile(parsed.owner,parsed.repo,path,repository.sourceSha);const candidates=selectEvidenceFiles(repository.files,input.scope);paths=repository.files.map(file=>file.path);samples=await Promise.all(candidates.map(async file=>({path:file.path,content:await readSource(file.path)})));}catch{throw new RepositoryAccessError("Repository access failed. Install or configure the ModernizeAI GitHub App for this repository, and verify the source branch name.");}}
	const readiness=await readVerificationReadiness(paths.map(path=>({path})),async path=>samples.find(sample=>sample.path===path)?.content??await readSource(path),{scope:input.scope});
	const evidence=repositoryEvidence(paths,samples,input.scope);
	return NextResponse.json({...await recommendStack({repository:`${parsed.owner}/${parsed.repo}`,scope:input.scope,paths,samples,evidence}),evidence,verificationReadiness:readiness});
 }catch(error){if(error instanceof VerificationReadinessError)return NextResponse.json({error:error.message,code:error.name,readiness:error.readiness},{status:422});if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});if(error instanceof RepositoryAccessError)return NextResponse.json({error:error.message},{status:422});if(error instanceof z.ZodError)return NextResponse.json({error:"The repository URL or source branch is invalid.",issues:error.issues},{status:400});console.error("Stack recommendation failed",error);return NextResponse.json({error:"The repository recommendation could not be prepared. Please retry."},{status:503});}}
class RepositoryAccessError extends Error{}