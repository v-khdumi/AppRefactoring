import assert from "node:assert/strict";
import test from "node:test";
import {GitHubRequestError,WorkflowPermissionError,needsWorkflowPermission,permanentPublicationError} from "../src/lib/publication-policy";
test("workflow publishing requires an explicit granted permission",()=>{
 assert.equal(needsWorkflowPermission([{path:".github/workflows/cloud-readiness.yml"}]),true);
 assert.equal(needsWorkflowPermission([{path:"src/app.ts"}]),false);
 assert.equal(permanentPublicationError(new WorkflowPermissionError()),true);
});
test("permission failures stop retrying while rate limits and server errors may retry",()=>{
 assert.equal(permanentPublicationError(new GitHubRequestError(403,"POST git/trees")),true);
 assert.equal(permanentPublicationError(new GitHubRequestError(403,"POST git/trees",undefined,true)),false);
 assert.equal(permanentPublicationError(new GitHubRequestError(500,"POST git/trees")),false);
});