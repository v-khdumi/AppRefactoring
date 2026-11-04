import { NextResponse } from "next/server";
import { z } from "zod";
import {readSourceRepository} from "@/lib/source-provider";
import { AuthError, requireUser } from "@/lib/auth";

const schema = z.object({
  url: z.string().url(),
  branch: z.string().max(200).optional(),
});

export async function POST(request: Request) {
  try {
    await requireUser(request, ["Modernization.Reader", "Modernization.Admin"]);
    const input = schema.parse(await request.json());
    const branch=input.branch||"main";const repository=await readSourceRepository(input.url,branch);
    return NextResponse.json({
      name: repository.descriptor.name,
      provider:repository.descriptor.provider,
      branch,
      private: true,
      description: "Read from the pinned commit using the configured source connection",
      fileCount: repository.files.length,
      languages: {},
    });
  } catch (error) {
    if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof z.ZodError ? error.issues[0]?.message : error instanceof Error ? error.message : "The repository could not be analyzed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}