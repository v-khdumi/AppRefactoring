import { NextResponse } from "next/server";
import { z } from "zod";
import { createDemoAnalysis } from "@/lib/demo-analysis";
import { analyzeWithFoundry, isFoundryConfigured } from "@/lib/foundry";
import {readSourceRepository} from "@/lib/source-provider";
import { AuthError, requireUser } from "@/lib/auth";
import { enforceRateLimit } from "@/lib/rate-limit";
import { isDemoRequest } from "@/lib/demo-session";
import { RequestDeadlineError, withRequestDeadline } from "@/lib/request-deadline";
import {selectEvidenceFiles,repositoryEvidence} from "@/lib/repository-evidence";
import {architectureSnapshotSchema} from "@/lib/architecture-snapshot";
import {readVerificationReadiness,VerificationReadinessError} from "@/lib/verification-readiness";
import {validateScenarioScope,ScenarioPolicyError} from "@/lib/modernization-scenarios";
import {assertNoCredentials,ContentPolicyError} from "@/lib/content-policy";
import {modernizationOptionsSchema} from "@/lib/modernization-options";

const requestSchema = z.object({
  repository: z.object({
    url: z.string().url(),
    branch: z.string().max(200).optional(),
    token: z.string().max(500).optional(),
  }),
  options:modernizationOptionsSchema,
});

export async function POST(request: Request) {
  try {
    return await withRequestDeadline(async signal => {
    const explicitDemo = isDemoRequest(request);
    if (!explicitDemo){const user=await requireUser(request,["Modernization.Reader","Modernization.Admin"]);const rate=await enforceRateLimit(user.tenantId,"analysis.create",20,3600);if(!rate.allowed)return NextResponse.json({error:"The hourly analysis limit has been reached."},{status:429,headers:{"Retry-After":String(rate.retryAfterSeconds)}});}
    const input = requestSchema.parse(await request.json());
    assertNoCredentials([{path:"analysis request",content:JSON.stringify(input)}]);
    validateScenarioScope(input.options.scenario,input.options.scope);
    if (explicitDemo) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return NextResponse.json(createDemoAnalysis(input.options));
    }
    if(!isFoundryConfigured())return NextResponse.json({error:"Microsoft Foundry is not configured. Live analysis did not run; demo data was not substituted."},{status:503});

    const branch=input.repository.branch||"main";
    const repository = await readSourceRepository(input.repository.url,branch);
    const readiness=await readVerificationReadiness(repository.files,repository.readFile,input.options);
    const candidates = selectEvidenceFiles(repository.files,input.options.scope);
    const samples = await Promise.all(
      candidates.map(async (file) => ({
        path: file.path,
        content: await repository.readFile(file.path),
      })),
    );
    signal.throwIfAborted();
    const analysis = await analyzeWithFoundry({
      repositoryName: repository.descriptor.name,
      branch,
      languages: inferLanguages(repository.files.map(file=>file.path)),
      files: repository.files.map((file) => file.path),
      samples,
      evidence:repositoryEvidence(repository.files.map(file=>file.path),samples,input.options.scope),
      options: input.options,
    }, signal);
    const snapshot={...analysis,scenario:input.options.scenario,repository:{...analysis.repository,url:repository.descriptor.url},sourceCommitSha:repository.sourceSha,scope:input.options.scope,evidence:repositoryEvidence(repository.files.map(file=>file.path),samples,input.options.scope)};
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
    if (error instanceof AuthError||error instanceof ContentPolicyError||error instanceof ScenarioPolicyError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "The analysis could not be completed.";
    return NextResponse.json({ error: message }, { status: error instanceof z.ZodError ? 400 : 500 });
  }
}

function inferLanguages(paths:string[]){const labels:Record<string,string>={cs:"C#",java:"Java",kt:"Kotlin",scala:"Scala",groovy:"Groovy",py:"Python",ts:"TypeScript",tsx:"TypeScript",js:"JavaScript",jsx:"JavaScript",vb:"Visual Basic",go:"Go",rs:"Rust",php:"PHP",rb:"Ruby",c:"C",cc:"C++",cpp:"C++",cxx:"C++",hpp:"C++",cob:"COBOL",cbl:"COBOL",cpy:"COBOL"};const counts:Record<string,number>={};for(const path of paths){const extension=path.split(".").pop()?.toLowerCase()||"";const label=labels[extension];if(label)counts[label]=(counts[label]||0)+1;}return counts;}