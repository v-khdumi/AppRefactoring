import { NextResponse } from "next/server";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import {architectureSnapshotSchema} from "@/lib/architecture-snapshot";
export async function GET(request:Request,context:{params:Promise<{id:string}>}){
 try{
  const user=await requireUser(request,["Modernization.Reader","Modernization.Admin"]);const {id}=await context.params;
  const runs=await query("SELECT repository_url,source_branch,source_commit_sha,scope,options FROM modernization_runs WHERE id=$1 AND tenant_id=$2",[id,user.tenantId]);
  if(!runs.rowCount)return NextResponse.json({error:"Transformation not found."},{status:404});
  const run=runs.rows[0];
  const saved=architectureSnapshotSchema.safeParse(run.options?.architectureAnalysis);
  const revisions=await query("SELECT nodes,rationale,created_at FROM architecture_revisions WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1",[id]);
  const changes=await query("SELECT path,area,agent_type,after_content FROM transformation_changes WHERE run_id=$1 ORDER BY path",[id]);
  const documents=changes.rows.filter(file=>file.agent_type==="architect"&&/\.md$/i.test(file.path)).map(file=>({path:file.path,content:file.after_content}));
  const areas=[...new Set(changes.rows.map(file=>String(file.area)))].filter(area=>["frontend","backend","platform"].includes(area));
  const derived=areas.map(area=>({id:area,label:area==="frontend"?"Frontend changes":area==="backend"?"Backend changes":"Platform changes",detail:changes.rows.filter(file=>file.area===area).map(file=>file.path).slice(0,5).join(", "),kind:area==="frontend"?"client":area==="backend"?"service":"cloud"}));
  return NextResponse.json({repository:String(run.repository_url).replace("https://github.com/",""),scope:run.scope,sourceCommitSha:run.source_commit_sha,analysis:saved.success?saved.data:null,currentNodes:saved.success?saved.data.currentArchitecture:[],targetNodes:revisions.rows[0]?.nodes||(saved.success?saved.data.targetArchitecture:derived),origin:revisions.rowCount?"reviewed-revision":saved.success?"saved-analysis":"generated-file-inventory",stale:saved.success&&Boolean(run.source_commit_sha)&&saved.data.sourceCommitSha!==run.source_commit_sha,documents},{headers:{"Cache-Control":"no-store"}});
 }catch(error){if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});return NextResponse.json({error:"Architecture could not be loaded."},{status:500});}
}
const node=z.object({id:z.string().min(1).max(100),label:z.string().min(1).max(200),detail:z.string().max(500),kind:z.enum(["client","service","data","integration","cloud"])});
const schema=z.object({nodes:z.array(node).min(1).max(100),connections:z.array(z.object({from:z.string(),to:z.string()})).max(300).default([]),rationale:z.string().max(3000).optional()});
export async function POST(request:Request,context:{params:Promise<{id:string}>}){try{const user=await requireUser(request,["Modernization.Admin"]);const{id}=await context.params;const input=schema.parse(await request.json());const exists=await query("SELECT 1 FROM modernization_runs WHERE id=$1 AND tenant_id=$2",[id,user.tenantId]);if(!exists.rowCount)return NextResponse.json({error:"Transformation not found."},{status:404});await query("INSERT INTO architecture_revisions(run_id,nodes,connections,rationale,created_by) VALUES($1,$2::jsonb,$3::jsonb,$4,$5)",[id,JSON.stringify(input.nodes),JSON.stringify(input.connections),input.rationale,user.id]);return NextResponse.json({saved:true});}catch(error){if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});if(error instanceof z.ZodError)return NextResponse.json({error:"Invalid architecture."},{status:400});return NextResponse.json({error:"Architecture could not be saved."},{status:500})}}