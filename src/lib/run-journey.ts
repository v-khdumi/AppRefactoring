import type {TransformationRun} from "../types/modernization";

export function runJourney(run:TransformationRun){
 if(run.status==="pull-request-created")return {step:4,title:"Draft pull request created",detail:"Publication completed. Review and merge in GitHub when ready.",action:"pull-request"};
 if(run.status==="publication-failed")return {step:3,title:"Publication blocked",detail:run.errorDetail||"Approval is recorded, but GitHub publication failed.",action:"publication"};
 if(run.status==="approved")return {step:3,title:run.errorDetail?"Publication retry scheduled":run.currentStage==="publishing-branch"?"Creating the modernization branch":run.currentStage==="publishing-pull-request"?"Creating the draft pull request":"Approved; queued for publication",detail:run.errorDetail||"Your approval is recorded. No additional approval or verification is needed for this changeset.",action:run.errorDetail?"publication":"refresh"};
 if(run.validationExecution?.status==="passed")return {step:2,title:"Verification passed; review the changes",detail:"Review the exact diff, then approve publication of a new branch and draft pull request.",action:"review"};
 if(run.files.length)return {step:1,title:["preparing","running"].includes(run.validationExecution?.status||"")?"Verification in progress":"Verification required",detail:run.validationExecution?.reason||"Run isolated checks before reviewing for publication.",action:"verify"};
 return {step:0,title:["failed","blocked","cancelled"].includes(run.status)?"Generation stopped":"Generating the modernization plan",detail:run.errorDetail||run.currentStage.replaceAll("-"," "),action:"agents"};
}