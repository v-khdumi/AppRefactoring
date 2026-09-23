"use client";
import { useState } from "react";
import { Play, LoaderCircle } from "lucide-react";
import type { TransformationRun } from "@/types/modernization";
import { useModernizeAuth } from "@/components/auth-provider";
import { requestJson } from "@/lib/request-json";

export function VerificationPanel({run,onRefresh}:{run:TransformationRun;onRefresh:()=>void}){
  const {authorizedFetch}=useModernizeAuth();
  const [starting,setStarting]=useState(false);const [error,setError]=useState("");
  const execution=run.validationExecution;
  const busy=starting||["preparing","running"].includes(execution?.status||"");
  const start=async()=>{
    if(busy)return;
    setStarting(true);setError("");
    try{await requestJson(authorizedFetch,`/api/transformations/${run.id}/verify`,{method:"POST"},30000,"Verification dispatch was not confirmed. Refresh its status before retrying.");onRefresh();}
    catch(caught){setError(caught instanceof Error?caught.message:"Verification failed to start.");}
    finally{setStarting(false);}
  };
  return <section className="verification-panel"><header><div><h3>Executed verification</h3><p>{execution?.status?.replaceAll("-"," ")||"Not started"}</p></div><button className="primary-button" disabled={busy||!run.files.length||!["blocked","failed","awaiting-approval"].includes(run.status)} onClick={()=>void start()}>{busy?<LoaderCircle size={15} className="spin"/>:<Play size={15}/>}Run verification</button></header><p>{execution?.reason||"No executed verification exists for this changeset."}</p>{error&&<p className="error-note" role="alert">{error}</p>}<p className="verification-disclosure">Isolated verification for npm, Python, SDK-style .NET, Maven, Gradle, Go and PHP Composer projects. Baseline and candidate: dependency installation, build or compilation, tests and dependency audit using checksum-pinned toolchains; empty or skipped suites do not pass. .NET Framework 4.x requires Windows and is not executed. Hardware and live cloud-service behavior are not covered by mocks.</p><div className="verification-steps">{execution?.steps.map((step,index)=><details key={`${step.variant}-${step.project}-${step.command}-${index}`} open={step.exitCode!==0||step.timedOut}><summary><strong>{step.variant} · {step.project}</strong><code>{step.command}</code><span>{step.timedOut?"Timed out":`Exit ${step.exitCode ?? "unavailable"}`} · {(step.durationMs/1000).toFixed(1)}s</span></summary><pre>{step.log||"Command produced no console output."}</pre></details>)}</div></section>;
}