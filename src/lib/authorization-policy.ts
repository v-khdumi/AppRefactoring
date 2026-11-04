export function hasRequiredRole(roles:string[],requiredRoles:string[]){
  return requiredRoles.length===0||requiredRoles.some(role=>roles.includes(role)||role==="Modernization.Reader"&&roles.includes("Modernization.Approver"));
}

export function approvalAccess(roles:string[],userId:string,createdBy:string,contributed:boolean){
  if(!hasRequiredRole(roles,["Modernization.Approver","Modernization.Admin"]))return {canApprove:false,reason:"The Approver or Administrator role is required."};
  if(!createdBy)return {canApprove:false,reason:"The run initiator is missing; independent approval cannot be established."};
  if(userId===createdBy||contributed)return {canApprove:false,reason:"An independent reviewer must approve this changeset. Initiators and contributors cannot approve their own work."};
  return {canApprove:true,reason:""};
}

export const contributorQuery=`SELECT EXISTS(
  SELECT 1 FROM user_code_edits e JOIN modernization_runs r ON r.id=e.run_id
  WHERE r.id=$1 AND r.tenant_id=$2 AND e.edited_by=$3
) OR EXISTS(
  SELECT 1 FROM audit_events WHERE resource_id=$1::text AND tenant_id=$2 AND actor_id=$3
  AND action IN ('agent.refinement.requested','transformation.repair.applied')
) OR EXISTS(
  SELECT 1 FROM architecture_revisions a JOIN modernization_runs r ON r.id=a.run_id
  WHERE r.id=$1 AND r.tenant_id=$2 AND a.created_by=$3
) AS contributed`;
