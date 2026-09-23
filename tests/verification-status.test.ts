import assert from "node:assert/strict";
import test from "node:test";
import { verificationDescription,verificationErrorCode } from "../src/lib/verification-status";

test("preparing and dispatched verification are not rendered as errors",()=>{
  assert.equal(verificationErrorCode("preparing"),null);
  assert.equal(verificationErrorCode("running"),null);
  assert.match(verificationDescription("preparing"),/snapshot/);
  assert.match(verificationDescription("running"),/dispatched/);
});
test("terminal verification states never fall back to Preparing",()=>{
  assert.equal(verificationErrorCode("unsupported"),"VerificationUnsupported");
  for(const status of ["unsupported","failed","stale","passed"])assert.doesNotMatch(verificationDescription(status),/Preparing/);
  assert.equal(verificationDescription("unsupported","Missing package-lock.json"),"Missing package-lock.json");
  assert.equal(verificationDescription("failed",undefined,"Dispatch failed (403)"),"Dispatch failed (403)");
});