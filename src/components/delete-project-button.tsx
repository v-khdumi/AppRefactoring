"use client";

import { useEffect, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import { useModernizeAuth } from "@/components/auth-provider";
import { requestJson } from "@/lib/request-json";
import { canDeleteRun } from "@/lib/run-progress";

export function DeleteProjectButton({id,repository,branch,status,onDeleted}:{id:string;repository:string;branch:string;status:string;onDeleted:()=>void}) {
  const {authorizedFetch} = useModernizeAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const [step,setStep] = useState(0);
  const [confirmation,setConfirmation] = useState("");
  const [acknowledged,setAcknowledged] = useState(false);
  const [deleting,setDeleting] = useState(false);
  const [error,setError] = useState("");
  useEffect(() => { if (step) dialog.current?.showModal(); else dialog.current?.close(); }, [step]);
  const remove = async () => {
    if (step !== 2 || confirmation !== branch || !acknowledged || deleting) return;
    setDeleting(true);setError("");
    try {
      await requestJson(authorizedFetch, `/api/transformations/${id}`, {method:"DELETE",headers:{"Content-Type":"application/json"},body:JSON.stringify({confirmed:true,targetBranch:confirmation})},30_000,"Deletion was not confirmed. Refresh the portfolio before trying again.");
      setStep(0);onDeleted();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Project deletion failed."); }
    finally { setDeleting(false); }
  };
  const eligible = canDeleteRun(status);
  return <><button className="delete-project-button" aria-label={`Delete project ${repository}`} title={eligible ? "Delete project" : "Stop the active run before deleting"} disabled={!eligible} onClick={() => {setConfirmation("");setAcknowledged(false);setError("");setStep(1);}}><Trash2 size={16}/></button>
    <dialog className="delete-project-dialog" ref={dialog} onCancel={event => {event.preventDefault();if(!deleting)setStep(0);}} aria-labelledby={`delete-title-${id}`}>
      <header><h3 id={`delete-title-${id}`}>{step === 2 ? "Confirm permanent deletion" : "Delete this project?"}</h3><button aria-label="Close deletion dialog" disabled={deleting} onClick={()=>setStep(0)}><X size={18}/></button></header>
      <strong>{repository}</strong><p className="delete-branch">{branch}</p>
      <p>This removes the modernization run, generated changes, agent output and conversations from ModernizeAI. Audit records are retained. The GitHub repository, branches and pull requests remain unchanged.</p>
      {step === 2 && <><label>Type the exact modernization branch<input autoComplete="off" value={confirmation} onChange={event=>setConfirmation(event.target.value)} disabled={deleting}/></label><label className="delete-acknowledgement"><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)} disabled={deleting}/>I understand this project cannot be restored in ModernizeAI.</label></>}
      {error && <div className="error-note" role="alert">{error}</div>}
      <footer><button className="secondary-button" disabled={deleting} onClick={()=>setStep(0)}>Cancel</button>{step === 1 ? <button className="primary-button" onClick={()=>setStep(2)}>Continue</button> : <button className="delete-confirm-button" disabled={deleting || confirmation!==branch || !acknowledged} onClick={()=>void remove()}><Trash2 size={14}/>{deleting ? "Deleting..." : "Delete permanently"}</button>}</footer>
    </dialog></>;
}