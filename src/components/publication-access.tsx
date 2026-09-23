"use client";
import {useEffect,useState} from "react";
import {ExternalLink,RefreshCw} from "lucide-react";
import {useModernizeAuth} from "@/components/auth-provider";
import {requestJson} from "@/lib/request-json";
import type {PublicationAccess as Access} from "@/lib/publication-access";

export function PublicationAccess({runId,onRetry}:{runId:string;onRetry:()=>void}){
  const {authorizedFetch}=useModernizeAuth();
  const [access,setAccess]=useState<Access|null>(null);
  const [error,setError]=useState("");
  const [checking,setChecking]=useState(true);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true;const controller=new AbortController();
    setChecking(true);setError("");setAccess(null);
    void requestJson<Access>(authorizedFetch,`/api/transformations/${runId}/publication-access`,{cache:"no-store",signal:controller.signal},30000,"GitHub permission check timed out. No publication was attempted.")
      .then(result=>{if(active)setAccess(result);})
      .catch(caught=>{if(active)setError(caught instanceof Error?caught.message:"Unable to check permissions.");})
      .finally(()=>{if(active)setChecking(false);});
    return()=>{active=false;controller.abort();};
  },[authorizedFetch,runId,revision]);
  return <div className="publication-access" aria-label="GitHub publication permissions">
    {checking&&<p role="status">Checking current GitHub permissions...</p>}
    {error&&<p role="alert">{error}</p>}
    {access&&<><p role="status">{access.reason}</p><dl>{access.permissions.map(permission=><div key={permission.name}><dt>{permission.name}</dt><dd>App: <strong>{permission.app}</strong> · Installation: <strong>{permission.installation}</strong> · Required: {permission.required}</dd></div>)}</dl></>}
    <div className="journey-buttons">
      {access&&!access.ready&&<><a className="secondary-button" href={access.appSettingsUrl} target="_blank" rel="noreferrer">App permissions<ExternalLink size={14}/></a><a className="secondary-button" href={access.installationSettingsUrl} target="_blank" rel="noreferrer">Installation permissions<ExternalLink size={14}/></a></>}
      <button className="secondary-button" disabled={checking} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={15} className={checking?"spin":""}/>Check permissions</button>
      <button className="primary-button" disabled={checking||!access?.ready} onClick={onRetry}><RefreshCw size={15}/>Retry publication</button>
    </div>
  </div>;
}