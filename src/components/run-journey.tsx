"use client";
import {ArrowRight,Check,ExternalLink,RefreshCw,ShieldCheck} from "lucide-react";
import type {TransformationRun} from "@/types/modernization";
import {runJourney} from "@/lib/run-journey";
import {PublicationAccess} from "@/components/publication-access";
export function RunJourney({run,onReview,onVerify,onAgents,onRefresh,onRetry,onApprove,reviewing,approving,approvalReason}:{run:TransformationRun;onReview:()=>void;onVerify:()=>void;onAgents:()=>void;onRefresh:()=>void;onRetry:()=>void;onApprove:()=>void;reviewing:boolean;approving:boolean;approvalReason:string}){
 const state=runJourney(run);
 return <section className="run-journey" aria-label="Next modernization step"><ol>{["Generate","Verify","Review & approve","Publish"].map((label,index)=><li key={label} aria-current={state.step===index?"step":undefined} className={index<state.step?"done":index===state.step?"current":""}><span>{index<state.step?<Check size={13}/>:index+1}</span>{label}</li>)}</ol><div className="journey-action"><div><h3>{state.title}</h3><p>{state.detail}</p>{run.publication?.attempts? <small>Publication attempt {run.publication.attempts}{run.publication.nextAttemptAt&&run.status==="approved"&&run.errorDetail?` · Next retry: ${new Date(run.publication.nextAttemptAt).toLocaleString()}`:""}</small>:null}</div><div className="journey-buttons">
 {state.action==="review"&&(reviewing?<button className="primary-button" disabled={approving||Boolean(approvalReason)} onClick={onApprove}><ShieldCheck size={15}/>{approving?"Recording approval...":"Approve & create draft PR"}</button>:<button className="primary-button" onClick={onReview}>Review changes<ArrowRight size={15}/></button>)}
 {state.action==="verify"&&<button className="primary-button" onClick={onVerify}>Open verification<ArrowRight size={15}/></button>}
 {state.action==="agents"&&<button className="primary-button" onClick={onAgents}>View agent tasks<ArrowRight size={15}/></button>}
 {state.action==="refresh"&&<button className="secondary-button" onClick={onRefresh}><RefreshCw size={15}/>Refresh publication</button>}
 {state.action==="publication"&&run.errorCode!=="WorkflowPermissionRequired"&&<button className="primary-button" onClick={onRetry}><RefreshCw size={15}/>Retry publication</button>}
 {state.action==="pull-request"&&run.pullRequestUrl&&<a className="primary-button" href={run.pullRequestUrl} target="_blank" rel="noreferrer">Open draft pull request<ExternalLink size={15}/></a>}
 </div></div>{state.action==="publication"&&run.errorCode==="WorkflowPermissionRequired"&&<PublicationAccess runId={run.id} onRetry={onRetry}/>} {state.action==="review"&&reviewing&&approvalReason&&<p role="status">{approvalReason}</p>}</section>;
}