import type {PoolClient} from "pg";
import {changesetDigest,reportPassed,type VerificationReport} from "./verification-evidence";

export async function currentChanges(client:Pick<PoolClient,"query">,runId:string){
  const result=await client.query<{path:string;old_path:string|null;operation:string;after_content:string|null}>("SELECT path,old_path,operation,after_content FROM transformation_changes WHERE run_id=$1 ORDER BY path",[runId]);
  return result.rows.map(row=>({path:row.path,oldPath:row.old_path,operation:row.operation,content:row.after_content||""}));
}

export async function verifiedChangeset(client:Pick<PoolClient,"query">,runId:string,tenantId:string,sourceSha:string){
  const changes=await currentChanges(client,runId);
  if(!changes.length)return false;
  const digest=changesetDigest(sourceSha,changes);
  const evidence=await client.query<{status:string;report:VerificationReport}>("SELECT status,report FROM verification_jobs WHERE run_id=$1 AND tenant_id=$2 AND source_sha=$3 AND changeset_digest=$4 ORDER BY created_at DESC LIMIT 1",[runId,tenantId,sourceSha,digest]);
  return Boolean(evidence.rows[0]?.status==="passed"&&evidence.rows[0]?.report&&reportPassed(evidence.rows[0].report));
}
