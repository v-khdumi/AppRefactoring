import { NextResponse } from "next/server";
import { z } from "zod";
import { parseGitHubUrl } from "@/lib/github";
import { readInstalledRepository } from "@/lib/github-app";
import { AuthError, requireUser } from "@/lib/auth";

const schema = z.object({
  url: z.string().url().refine((url) => url.toLowerCase().startsWith("https://github.com/"), "Only GitHub repositories are supported."),
  branch: z.string().max(200).optional(),
});

export async function POST(request: Request) {
  try {
    await requireUser(request, ["Modernization.Reader", "Modernization.Admin"]);
    const input = schema.parse(await request.json());
    const parsed=parseGitHubUrl(input.url);const branch=input.branch||"main";const repository=await readInstalledRepository(parsed.owner,parsed.repo,branch);
    return NextResponse.json({
      name: `${parsed.owner}/${parsed.repo}`,
      branch,
      private: true,
      description: "Authorized through the installed GitHub App",
      fileCount: repository.files.length,
      languages: {},
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "The repository could not be analyzed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}