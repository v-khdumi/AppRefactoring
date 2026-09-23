import type { TransformationStage, TransformationStatus } from "../types/modernization";

export function pipelineStages(status: TransformationStatus, stage: string, testingStatus: TransformationStatus = "queued", testingProgress = 0): TransformationStage[] {
  const revalidating = ["testing-user-edit","testing-agent-validation","verification-required"].includes(stage);
  const coordinated=stage.startsWith("coordinated-agent-");
  const specialists:Record<string,string>={architect:"Architecture contract",backend:"Backend implementation",frontend:"Frontend integration",cloud:"Cloud configuration",security:"Security review",testing:"Test generation"};
  const planning=coordinated?[stage,specialists[stage.slice("coordinated-agent-".length)]||"Coordinated generation"]:["parallel-agent-planning","Foundry transformation planning"];
  const definitions = [
    ["repository-inventory","Repository inventory"],
    planning,
    ["persisting-changes","Persist exact changes"],
    ...(revalidating ? [[stage,stage === "verification-required" ? "Execute build and tests" : "Revalidate edited changes"]] : []),
    ["human-approval","Human approval"],
    ["completed","Draft pull request created"],
  ];
  let current = definitions.findIndex(([id])=>id===stage);
  if(stage==="generation-failed")current=1;
  if (status === "approved" || status === "publication-failed") current=definitions.length-1;
  if (status === "awaiting-approval" || status === "rejected") current=definitions.length-2;
  if (status === "pull-request-created") current=definitions.length;
  return definitions.map(([id,title],index)=>{
    let state: TransformationStatus = "queued";
    if(index<current) state="passed";
    else if(index===current) {
      state = status === "approved" ? "queued" : status === "running" && revalidating ? testingStatus : status;
    }
    return {id,title,detail:id==="human-approval"?"Review exact changes before publishing":coordinated&&id===stage?"Working from the shared contract and accepted candidate files; execution verification is still required.":"Recorded pipeline state",status:state,progress:state==="passed"?100:revalidating&&id===stage?testingProgress:0};
  });
}