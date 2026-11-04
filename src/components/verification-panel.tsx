"use client";
import {useState} from "react";
import {Play,LoaderCircle} from "lucide-react";
import type {TransformationRun} from "@/types/modernization";
import {useModernizeAuth} from "@/components/auth-provider";
import {requestJson} from "@/lib/request-json";

export function VerificationPanel({run,onRefresh}:{run:TransformationRun;onRefresh:()=>void}){
  const {authorizedFetch}=useModernizeAuth();
  const [starting,setStarting]=useState(false);
  const [error,setError]=useState("");
  const execution=run.validationExecution;
  const busy=starting||["preparing","running"].includes(execution?.status||"");
  const canManage=run.mode==="demo"||run.permissions?.manage===true;
  const start=async()=>{
    if(busy)return;
    if(!canManage){setError("An administrator is required to dispatch verification.");return;}
    setStarting(true);setError("");
    try{await requestJson(authorizedFetch,`/api/transformations/${run.id}/verify`,{method:"POST"},30000,"Verification dispatch was not confirmed. Refresh its status before retrying.");onRefresh();}
    catch(caught){setError(caught instanceof Error?caught.message:"Verification failed to start.");}
    finally{setStarting(false);}
  };
  return <section className="verification-panel">
    <header><div><h3>Executed verification</h3><p>{execution?.status?.replaceAll("-"," ")||"Not started"}</p></div><button className="primary-button" title={canManage?"Execute isolated checks":"Administrator role required"} disabled={!canManage||busy||!run.files.length||!["blocked","failed","awaiting-approval"].includes(run.status)} onClick={()=>void start()}>{busy?<LoaderCircle size={15} className="spin"/>:<Play size={15}/>}Run verification</button></header>
    <p>{execution?.reason||"No executed verification exists for this changeset."}</p>
    {error&&<p className="error-note" role="alert">{error}</p>}
    <p className="verification-disclosure">Only profiles admitted by server-side readiness run. Inspect baseline and candidate command logs, executed test counts, dependency audits and strategy acceptance checks. Missing tools or evidence block approval. Windows hosting, hardware and real cloud-service behavior require their own executable acceptance fixtures; mocks do not establish live integration.</p>
    <div className="verification-steps">{execution?.steps.map((step,index)=><details key={`${step.variant}-${step.project}-${step.command}-${index}`} open={step.exitCode!==0||step.timedOut}><summary><strong>{step.variant} · {step.project}</strong><code>{step.command}</code><span>{step.timedOut?"Timed out":`Exit ${step.exitCode??"unavailable"}`} · {(step.durationMs/1000).toFixed(1)}s{step.tests?` · ${step.tests.tests} tests, ${step.tests.failed} failed, ${step.tests.skipped} skipped`:""}</span></summary><pre>{step.log||"Command produced no console output."}</pre></details>)}</div>
  </section>;
}
