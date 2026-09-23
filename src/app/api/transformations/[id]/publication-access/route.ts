import {NextResponse} from "next/server";
import {AuthError,requireUser} from "@/lib/auth";
import {query} from "@/lib/db";
import {readPublicationAccess} from "@/lib/github-app";
import {needsWorkflowPermission} from "@/lib/publication-policy";
import {parseGitHubUrl} from "@/lib/github";

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    const user=await requireUser(request,["Modernization.Reader","Modernization.Admin"]);
    const {id}=await context.params;
    const run=await query<{repository_url:string}>("SELECT repository_url FROM modernization_runs WHERE id=$1 AND tenant_id=$2",[id,user.tenantId]);
    if(!run.rowCount)return NextResponse.json({error:"Transformation run not found."},{status:404});
    const changes=await query<{path:string}>("SELECT path FROM transformation_changes WHERE run_id=$1",[id]);
    const repository=parseGitHubUrl(run.rows[0].repository_url);
    return NextResponse.json(await readPublicationAccess(repository.owner,repository.repo,needsWorkflowPermission(changes.rows)),{headers:{"Cache-Control":"no-store"}});
  }catch(error){
    if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});
    console.error("Publication access lookup failed",error);
    return NextResponse.json({error:"GitHub permissions could not be checked. No publication was attempted."},{status:502});
  }
}