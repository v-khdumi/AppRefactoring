import {NextResponse} from "next/server";
import {z} from "zod";
import {requireUser,AuthError} from "@/lib/auth";
import {query,transaction} from "@/lib/db";
import {readVerificationSnapshot} from "@/lib/github-app";
import {appendAudit} from "@/lib/audit";
import {safeSnapshotPath} from "@/lib/verification-evidence";
import {allowedRepairPath} from "@/lib/repair-paths";

const schema=z.object({baseVersion:z.number().int().positive(),files:z.array(z.object({path:z.string().max(500).refine(safeSnapshotPath),content:z.string().max(2000000)})).min(1).max(30)});
export async function POST(request:Request,context:{params:Promise<{id:string}>}){
 try{
  const user=await requireUser(request,["Modernization.Admin"]);const {id}=await context.params;
  const input=schema.parse(await request.json());
  if(new Set(input.files.map(file=>file.path)).size!==input.files.length)return NextResponse.json({error:"Duplicate file paths."},{status:400});
    if(input.files.some(file=>!allowedRepairPath(file.path)))return NextResponse.json({error:"Repair is limited to dependency manifests, test integration and the proposed backend service."},{status:400});
  const result=await query<{source_commit_sha:string;repository_url:string}>("SELECT source_commit_sha,repository_url FROM modernization_runs WHERE id=$1 AND tenant_id=$2",[id,user.tenantId]);
  if(!result.rows[0])return NextResponse.json({error:"Run not found."},{status:404});
  const run=result.rows[0];const match=run.repository_url.match(/^https:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i);
  if(!match)throw new Error("Invalid repository URL");
  const source=await readVerificationSnapshot(match[1],match[2],run.source_commit_sha);
  const sources=new Map(source.map(file=>[file.path,Buffer.from(file.content,"base64").toString("utf8")]));
  await transaction(async client=>{
   const locked=await client.query<{version:number;status:string;source_commit_sha:string}>("SELECT version,status,source_commit_sha FROM modernization_runs WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[id,user.tenantId]);
   const current=locked.rows[0];
   if(!current||current.version!==input.baseVersion||current.source_commit_sha!==run.source_commit_sha||!["blocked","failed","awaiting-approval"].includes(current.status))throw new Error("Run changed or is active. Refresh before applying repair.");
   const active=await client.query("SELECT 1 FROM agent_tasks WHERE run_id=$1 AND status IN ('running','retrying') UNION ALL SELECT 1 FROM verification_jobs WHERE run_id=$1 AND status IN ('preparing','running') AND expires_at>now() LIMIT 1",[id]);
   if(active.rowCount)throw new Error("Generation or verification is active; wait before applying repair.");
   for(const file of input.files){
    const before=sources.get(file.path)||"";const area=file.path.startsWith("tests/")||file.path.includes("/tests/")?"tests":file.path.startsWith("services/backend/")||file.path.startsWith("backend/")?"backend":file.path.startsWith("frontend/")?"frontend":"platform";
    await client.query("INSERT INTO transformation_changes(run_id,path,operation,area,rationale,before_content,after_content,additions,deletions,validation,agent_type,user_modified) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,$10,true) ON CONFLICT(run_id,path) DO UPDATE SET operation=EXCLUDED.operation,area=EXCLUDED.area,rationale=EXCLUDED.rationale,before_content=EXCLUDED.before_content,after_content=EXCLUDED.after_content,additions=EXCLUDED.additions,deletions=EXCLUDED.deletions,validation='[]'::jsonb,user_modified=true",[id,file.path,sources.has(file.path)?"modified":"added",area,"User-requested dependency and test integration repair; executed verification is required.",before,file.content,file.content.split("\n").length,before?before.split("\n").length:0,area==="tests"?"testing":area==="backend"?"backend":"cloud"]);
   }
   await client.query("UPDATE transformation_changes SET validation='[]'::jsonb WHERE run_id=$1",[id]);
   await client.query("UPDATE modernization_runs SET status='blocked',current_stage='verification-required',error_code=NULL,error_detail=NULL,version=version+1,updated_at=now() WHERE id=$1 AND tenant_id=$2",[id,user.tenantId]);
   await appendAudit(client,{tenantId:user.tenantId,actor:user,action:"transformation.repair.applied",resourceType:"run",resourceId:id,data:{baseVersion:input.baseVersion,files:input.files.map(file=>file.path)}});
  });
  return NextResponse.json({saved:true,verificationRequired:true});
 }catch(error){if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});if(error instanceof z.ZodError)return NextResponse.json({error:"Invalid repair payload."},{status:400});return NextResponse.json({error:error instanceof Error?error.message:"Repair failed"},{status:409});}
}