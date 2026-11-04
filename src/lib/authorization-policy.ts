export function hasRequiredRole(roles:string[],requiredRoles:string[]){
  return requiredRoles.length===0||requiredRoles.some(role=>roles.includes(role)||role==="Modernization.Reader"&&roles.includes("Modernization.Approver"));
}

export interface ApprovalPolicy {
  deploymentTier:"production"|"pilot";
  allowAdminSelfApproval:boolean;
}
export interface ApprovalAccess {canApprove:boolean;reason:string;selfApprovalException?:boolean}

export function approvalPolicy(configuration:{DEPLOYMENT_TIER:"production"|"pilot";PILOT_ALLOW_ADMIN_SELF_APPROVAL:"true"|"false"}):ApprovalPolicy{
  return {deploymentTier:configuration.DEPLOYMENT_TIER,allowAdminSelfApproval:configuration.DEPLOYMENT_TIER==="pilot"&&configuration.PILOT_ALLOW_ADMIN_SELF_APPROVAL==="true"};
}

export function approvalAccess(roles:string[],userId:string,createdBy:string,contributed:boolean,policy:ApprovalPolicy={deploymentTier:"production",allowAdminSelfApproval:false}):ApprovalAccess{
  if(!hasRequiredRole(roles,["Modernization.Approver","Modernization.Admin"]))return {canApprove:false,reason:"The Approver or Administrator role is required."};
  if(!createdBy)return {canApprove:false,reason:"The run initiator is missing; independent approval cannot be established."};
  if(userId===createdBy||contributed){
    if(policy.deploymentTier==="pilot"&&policy.allowAdminSelfApproval&&roles.includes("Modernization.Admin"))return {canApprove:true,reason:"Pilot administrator self-approval requires explicit acknowledgement and current verification evidence.",selfApprovalException:true};
    return {canApprove:false,reason:"An independent reviewer must approve this changeset. Initiators and contributors cannot approve their own work."};
  }
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
