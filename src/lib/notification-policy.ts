export const notificationDefaults={failures:true,approvals:true,completed:true,digest:false};
export type NotificationPreferences=typeof notificationDefaults;

export function notificationItems(runs:Array<{status:string;progress:number;repository_url?:string;repository?:string;current_stage?:string;currentStage?:string}>,preferences:NotificationPreferences){
  const items=runs.filter(run=>
    preferences.failures&&["failed","blocked","publication-failed"].includes(run.status)||
    preferences.approvals&&run.status==="awaiting-approval"||
    preferences.completed&&run.status==="pull-request-created"
  ).slice(0,5).map(run=>({title:`${(run.repository_url||run.repository||"Modernization").replace(/^https:\/\/github\.com\//,"")} · ${run.status}`,detail:`${(run.current_stage||run.currentStage||run.status).replaceAll("-"," ")} · ${run.progress}%`}));
  if(preferences.digest)items.unshift({title:"Portfolio summary",detail:`${runs.length} modernizations · ${runs.filter(run=>run.status==="awaiting-approval").length} awaiting approval · ${runs.filter(run=>run.status==="pull-request-created").length} draft pull requests`});
  return items;
}
