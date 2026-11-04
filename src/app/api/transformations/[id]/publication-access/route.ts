import {NextResponse} from "next/server";
import {AuthError,requireUser} from "@/lib/auth";
import {query} from "@/lib/db";
import {readPublicationAccess} from "@/lib/github-app";
import {needsWorkflowPermission} from "@/lib/publication-policy";
import {parseGitHubUrl} from "@/lib/github";
import {sourceRepository} from "@/lib/source-provider";

export async function GET(request:Request,context:{params:Promise<{id:string}>}){
  try{
    const user=await requireUser(request,["Modernization.Reader","Modernization.Admin"]);
    const {id}=await context.params;
    const run=await query<{repository_url:string}>("SELECT repository_url FROM modernization_runs WHERE id=$1 AND tenant_id=$2",[id,user.tenantId]);
    if(!run.rowCount)return NextResponse.json({error:"Transformation run not found."},{status:404});
    const changes=await query<{path:string}>("SELECT path FROM transformation_changes WHERE run_id=$1",[id]);
    const descriptor=sourceRepository(run.rows[0].repository_url);
    if(descriptor.provider!=="github")return NextResponse.json({ready:false,installationId:0,appSettingsUrl:descriptor.url,installationSettingsUrl:descriptor.url,permissions:[],reason:"This provider uses an administrator-configured service connection. Its write permissions are checked by the provider during approved publication; a readable repository does not establish write access."},{headers:{"Cache-Control":"no-store"}});
    const repository=parseGitHubUrl(run.rows[0].repository_url);
    return NextResponse.json(await readPublicationAccess(repository.owner,repository.repo,needsWorkflowPermission(changes.rows)),{headers:{"Cache-Control":"no-store"}});
  }catch(error){
    if(error instanceof AuthError)return NextResponse.json({error:error.message},{status:error.status});
    console.error("Publication access lookup failed",error);
    return NextResponse.json({error:"GitHub permissions could not be checked. No publication was attempted."},{status:502});
  }
}