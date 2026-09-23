import type {ModernizationAgent,TransformationRun} from "../types/modernization";

export function agentPublication(agent?:ModernizationAgent,run?:TransformationRun){
  const unavailable={paths:[] as string[],complete:false};
  if(!agent||!run||run.mode!=="live"||run.status!=="pull-request-created"||!run.pullRequestUrl||run.validationExecution?.status!=="passed"||!run.validationExecution.changesetDigest)return unavailable;
  try{
    const output:unknown=JSON.parse(agent.output||"");
    if(!output||typeof output!=="object"||!("changes" in output)||!Array.isArray(output.changes)||!output.changes.length)return unavailable;
    const paths:string[]=[];
    for(const change of output.changes){
      if(!change||typeof change!=="object"||typeof change.path!=="string"||typeof change.after!=="string")continue;
      const accepted=run.files.find(file=>file.path===change.path&&file.agentType===agent.type);
      if(accepted&&!accepted.userModified&&accepted.validation.length&&accepted.after===change.after&&accepted.status===change.status&&!paths.includes(change.path))paths.push(change.path);
    }
    return {paths,complete:paths.length===output.changes.length};
  }catch{return unavailable;}
}

export function canRefineRun(status:TransformationRun["status"]){
  return ["awaiting-approval","blocked","failed"].includes(status);
}