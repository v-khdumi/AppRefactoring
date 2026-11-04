import assert from "node:assert/strict";
import test from "node:test";
import {approvalAccess,hasRequiredRole} from "../src/lib/authorization-policy";

test("approvers can read evidence without gaining administration privileges",()=>{
  assert.equal(hasRequiredRole(["Modernization.Approver"],["Modernization.Reader","Modernization.Admin"]),true);
  assert.equal(hasRequiredRole(["Modernization.Approver"],["Modernization.Admin"]),false);
  assert.equal(hasRequiredRole(["Modernization.Reader"],["Modernization.Approver","Modernization.Admin"]),false);
  assert.equal(hasRequiredRole([],["Modernization.Reader"]),false);
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
