export class GitHubRequestError extends Error {
  constructor(public status:number,public operation:string,public requestId?:string,public rateLimited=false){
    super(`GitHub rejected ${operation} (HTTP ${status}).${status===403&&!rateLimited?" Check the GitHub App installation permissions and organization policies.":""}${requestId?` Request ID: ${requestId}.`:""}`);
    this.name="GitHubRequestError";
  }
}
export class WorkflowPermissionError extends Error {
  constructor(){super("This approved changeset modifies .github/workflows. The GitHub App installation must grant Workflows: write before publishing. Update the app permissions, accept the installation update, then retry publication. No workflow has been removed.");this.name="WorkflowPermissionRequired";}
}
export function needsWorkflowPermission(changes:Array<{path:string}>){return changes.some(change=>change.path.replaceAll("\\","/").startsWith(".github/workflows/"));}
export function permanentPublicationError(error:unknown){return error instanceof WorkflowPermissionError || error instanceof GitHubRequestError && [401,403,404,422].includes(error.status)&&!error.rateLimited;}