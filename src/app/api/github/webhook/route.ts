import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { verifyGitHubSignature } from "@/lib/github-app";
import { query } from "@/lib/db";

export async function POST(request: Request) {
  const contentLength=Number(request.headers.get("content-length")||0);
  if(contentLength>1_000_000)return NextResponse.json({error:"Webhook payload is too large."},{status:413});
  const rawBody = await request.text();
  if(Buffer.byteLength(rawBody,"utf8")>1_000_000)return NextResponse.json({error:"Webhook payload is too large."},{status:413});
  if (!verifyGitHubSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
    return NextResponse.json({ error: "Invalid webhook signature." }, { status: 401 });
  }
  const event = request.headers.get("x-github-event") || "unknown";
  const delivery = request.headers.get("x-github-delivery");
  if(!delivery||delivery.length>100)return NextResponse.json({error:"Missing or invalid GitHub delivery identifier."},{status:400});
  const digest=createHash("sha256").update(rawBody).digest("hex");
  const result=await query("INSERT INTO github_webhook_deliveries(delivery_id,event_type,payload_sha256) VALUES($1,$2,$3) ON CONFLICT(delivery_id) DO NOTHING RETURNING delivery_id",[delivery,event.slice(0,100),digest]);
  return NextResponse.json({ accepted: true, event, delivery, duplicate:!result.rowCount }, { status: result.rowCount?202:200 });
}