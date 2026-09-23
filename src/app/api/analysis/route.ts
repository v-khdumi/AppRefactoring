import { NextResponse } from "next/server";
import { z } from "zod";
import { createDemoAnalysis } from "@/lib/demo-analysis";
import { analyzeWithFoundry, isFoundryConfigured } from "@/lib/foundry";
import { parseGitHubUrl } from "@/lib/github";
import { readInstalledFile, readInstalledRepository } from "@/lib/github-app";
import { AuthError, requireUser } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isDemoRequest } from "@/lib/demo-session";
import { RequestDeadlineError, withRequestDeadline } from "@/lib/request-deadline";
import {selectEvidenceFiles,repositoryEvidence} from "@/lib/repository-evidence";
import {architectureSnapshotSchema} from "@/lib/architecture-snapshot";
import {readVerificationReadiness,VerificationReadinessError} from "@/lib/verification-readiness";

const requestSchema = z.object({
  repository: z.object({
    url: z.string().url(),
    branch: z.string().max(200).optional(),
    token: z.string().max(500).optional(),
  }),
  options: z.object({
    scope: z.enum(["frontend", "backend", "fullstack"]),
    frontendTarget: z.string().max(120).optional(),
    backendTarget: z.string().max(120).optional(),
    cloudReady: z.boolean(),
    cloudOptions: z.array(z.string().max(80)).max(20),
    aiFeatures: z.array(z.string().max(80)).max(20),
    customCapabilities: z.array(z.object({
      name: z.string().min(1).max(120),
      description: z.string().min(20).max(4000),
      design: z.unknown(),
    })).max(10).optional(),
    preserveBehavior: z.literal(true),
  }).refine(options=>options.scope==="fullstack"||!options.customCapabilities?.length,{message:"Custom AI capabilities require full-stack modernization.",path:["customCapabilities"]}),
});

export async function POST(request: Request) {
  try {
    return await withRequestDeadline(async signal => {
    const explicitDemo = isDemoRequest(request);
    if (!explicitDemo){const user=await requireUser(request,["Modernization.Reader","Modernization.Admin"]);const rate=await enforceRateLimit(user.tenantId,"analysis.create",20,3600);if(!rate.allowed)return NextResponse.json({error:"The hourly analysis limit has been reached."},{status:429,headers:{"Retry-After":String(rate.retryAfterSeconds)}});}
    const input = requestSchema.parse(await request.json());
    if (explicitDemo) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return NextResponse.json(createDemoAnalysis(input.options));
    }
    if(!isFoundryConfigured())return NextResponse.json({error:"Microsoft Foundry is not configured. Live analysis did not run; demo data was not substituted."},{status:503});

    const parsed=parseGitHubUrl(input.repository.url);const branch=input.repository.branch||"main";
    const repository = await readInstalledRepository(parsed.owner,parsed.repo,branch);
    const readiness=await readVerificationReadiness(repository.files,path=>readInstalledFile(parsed.owner,parsed.repo,path,repository.sourceSha,repository.token),input.options);
    const candidates = selectEvidenceFiles(repository.files,input.options.scope);
    const samples = await Promise.all(
      candidates.map(async (file) => ({
        path: file.path,
        content: await readInstalledFile(parsed.owner,parsed.repo,file.path,repository.sourceSha,repository.token),
      })),
    );
    signal.throwIfAborted();
    const analysis = await analyzeWithFoundry({
      repositoryName: `${parsed.owner}/${parsed.repo}`,
      branch,
      languages: inferLanguages(repository.files.map(file=>file.path)),
      files: repository.files.map((file) => file.path),
      samples,
      evidence:repositoryEvidence(repository.files.map(file=>file.path),samples,input.options.scope),
      options: input.options,
    }, signal);
    const snapshot={...analysis,sourceCommitSha:repository.sourceSha,scope:input.options.scope,evidence:repositoryEvidence(repository.files.map(file=>file.path),samples,input.options.scope)};
    const valid=architectureSnapshotSchema.safeParse(snapshot);
    if(!valid.success)throw new Error("The architecture proposal did not match the required schema. No run was created.");
    return NextResponse.json({...valid.data,estimate:analysis.estimate,verificationReadiness:readiness});
    }, 170_000, "Architecture analysis timed out. No modernization run was queued. Retry the analysis.");
  } catch (error) {
    if(error instanceof VerificationReadinessError)return NextResponse.json({error:error.message,code:error.name,readiness:error.readiness},{status:422});
    console.error("Analysis failed", error instanceof Error ? error.message : error);
    if (error instanceof RequestDeadlineError || (error instanceof Error && error.name === "TimeoutError")) {
      return NextResponse.json({ error: "Architecture analysis timed out. No modernization run was queued. Retry the analysis." }, { status: 504 });
    }
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "The analysis could not be completed.";
    return NextResponse.json({ error: message }, { status: error instanceof z.ZodError ? 400 : 500 });
  }
}

function inferLanguages(paths:string[]){const labels:Record<string,string>={cs:"C#",java:"Java",py:"Python",ts:"TypeScript",tsx:"TypeScript",js:"JavaScript",jsx:"JavaScript",vb:"Visual Basic",go:"Go",rs:"Rust",php:"PHP"};const counts:Record<string,number>={};for(const path of paths){const extension=path.split(".").pop()?.toLowerCase()||"";const label=labels[extension];if(label)counts[label]=(counts[label]||0)+1;}return counts;}