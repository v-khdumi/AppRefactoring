import assert from "node:assert/strict";
import test from "node:test";
import {approvalAccess,approvalPolicy,hasRequiredRole} from "../src/lib/authorization-policy";

test("approvers can read evidence without gaining administration privileges",()=>{
  assert.equal(hasRequiredRole(["Modernization.Approver"],["Modernization.Reader","Modernization.Admin"]),true);
  assert.equal(hasRequiredRole(["Modernization.Approver"],["Modernization.Admin"]),false);
  assert.equal(hasRequiredRole(["Modernization.Reader"],["Modernization.Approver","Modernization.Admin"]),false);
  assert.equal(hasRequiredRole([],["Modernization.Reader"]),false);
});

test("self-approval is available only to administrators with both explicit pilot settings",()=>{
  const enabled=approvalPolicy({DEPLOYMENT_TIER:"pilot",PILOT_ALLOW_ADMIN_SELF_APPROVAL:"true"});
  for(const contributed of [false,true]){
    const access=approvalAccess(["Modernization.Admin"],"creator","creator",contributed,enabled);
    assert.equal(access.canApprove,true);
    assert.equal(access.selfApprovalException,true);
  }
  assert.equal(approvalAccess(["Modernization.Admin"],"editor","creator",true,enabled).selfApprovalException,true);
  for(const roles of [[],["Modernization.Reader"],["Modernization.Approver"]])assert.equal(approvalAccess(roles,"creator","creator",false,enabled).canApprove,false);
  assert.equal(approvalAccess(["Modernization.Admin"],"creator","",false,enabled).canApprove,false);
  assert.equal(approvalAccess(["Modernization.Approver"],"reviewer","creator",false,enabled).selfApprovalException,undefined);
  for(const policy of [approvalPolicy({DEPLOYMENT_TIER:"production",PILOT_ALLOW_ADMIN_SELF_APPROVAL:"true"}),approvalPolicy({DEPLOYMENT_TIER:"production",PILOT_ALLOW_ADMIN_SELF_APPROVAL:"false"}),approvalPolicy({DEPLOYMENT_TIER:"pilot",PILOT_ALLOW_ADMIN_SELF_APPROVAL:"false"}),{deploymentTier:"production" as const,allowAdminSelfApproval:true}]){
    assert.equal(approvalAccess(["Modernization.Admin"],"creator","creator",false,policy).canApprove,false);
  }
});

test("approval requires an independent authorized reviewer, including for administrators",()=>{
  for(const role of ["Modernization.Approver","Modernization.Admin"]){
    assert.equal(approvalAccess([role],"reviewer","creator",false).canApprove,true);
    assert.equal(approvalAccess([role],"creator","creator",false).canApprove,false);
    assert.equal(approvalAccess([role],"editor","creator",true).canApprove,false);
    assert.equal(approvalAccess([role],"reviewer","",false).canApprove,false);
  }
  assert.equal(approvalAccess(["Modernization.Reader"],"reviewer","creator",false).canApprove,false);
});
