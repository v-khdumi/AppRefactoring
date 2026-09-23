"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowLeft, Check, CheckCircle2, ChevronRight, Circle, Clock3, Code2,
  Bot, FileDiff, FilePlus2, GitBranch, Github, ListChecks, LoaderCircle, Pencil, Play, Save, Search,
  RefreshCw, Send, ShieldCheck, TerminalSquare, TestTube2, Users, XCircle,
} from "lucide-react";
import { createDemoTransformation } from "@/lib/demo-transformation";
import type { AgentMessage, AgentType, ModernizationAgent, TransformationFile, TransformationRun } from "@/types/modernization";
import { useModernizeAuth } from "@/components/auth-provider";
import { AgentOutput } from "@/components/agent-output";
import { emptyLiveRun, mergeRunSnapshot } from "@/lib/execution-state";
import { requestJson } from "@/lib/request-json";
import { DeleteProjectButton } from "@/components/delete-project-button";
import { approvalBlockReason } from "@/lib/approval-state";
import { withRequestDeadline } from "@/lib/request-deadline";
import { agentActivityLabel, agentNames, filterChanges } from "@/lib/execution-presentation";
import { ExecutionControl } from "@/components/execution-control";
import { validationExecution } from "@/lib/validation-execution";
import { VerificationPanel } from "@/components/verification-panel";
import { RunJourney } from "@/components/run-journey";
import { agentPublication, canRefineRun } from "@/lib/agent-publication";

type RunTab = "progress" | "history" | "changes" | "validation";
const demoAgents:ModernizationAgent[]=[
  {id:"architect",type:"architect",name:"Architecture Agent",objective:"Design target boundaries and migration decisions",status:"passed",progress:100,filesOwned:["docs/architecture.md"]},
  {id:"frontend",type:"frontend",name:"Frontend Agent",objective:"Modernize UI while preserving interactions",status:"running",progress:72,filesOwned:["src/web"]},
  {id:"backend",type:"backend",name:"Backend Agent",objective:"Extract typed APIs and domain services",status:"running",progress:81,filesOwned:["src/OrderService"]},
  {id:"cloud",type:"cloud",name:"Cloud Agent",objective:"Add Azure readiness and observability",status:"passed",progress:100,filesOwned:[".github/workflows"]},
  {id:"testing",type:"testing",name:"Testing Agent",objective:"Independently verify behavior, contracts, build, and security",status:"running",progress:64,filesOwned:["tests"]},
  {id:"security",type:"security",name:"Security Agent",objective:"Review generated changes for vulnerabilities and secrets",status:"passed",progress:100,filesOwned:[]},
];

export function TransformationWorkspace({ onBack, onDeleted, runId,initialView="progress" }: { onBack: () => void; onDeleted?:()=>void; runId: string;initialView?:"progress"|"history" }) {
  const { authorizedFetch, demo } = useModernizeAuth();
  const [run, setRun] = useState<TransformationRun>(() => demo ? ({ ...createDemoTransformation(), id: runId }) : emptyLiveRun(runId));
  const [tab, setTab] = useState<RunTab>(initialView);
  const [historyView,setHistoryView]=useState<"agents"|"activity">("agents");
  const openAgent=(agent?:AgentType)=>{if(agent)setSelectedAgent(agent);setHistoryView("agents");setTab("history");};
  const [selectedPath, setSelectedPath] = useState("");
  const [filter, setFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [selectedAgent, setSelectedAgent] = useState<AgentType>("architect");
  const [query, setQuery] = useState("");
  const [approving, setApproving] = useState(false);
  const [editingCode,setEditingCode]=useState(false);
  const approvalInFlight = useRef(false);
  const [approvalError, setApprovalError] = useState("");
  const [rejectedVersion, setRejectedVersion] = useState<number | null>(null);
  const [apiError, setApiError] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [loaded,setLoaded]=useState(false);
  const [lastSync, setLastSync] = useState("");
  const [refreshingStatus,setRefreshingStatus] = useState(false);
  const [refreshRequest,setRefreshRequest] = useState(0);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      if(active)setRefreshingStatus(true);
      try {
        const latest = await requestJson<TransformationRun>(authorizedFetch, `/api/transformations/${runId}`, { cache: "no-store" }, 20_000, "Progress refresh timed out. Displayed data may be stale.");
        if (!demo && latest.mode !== "live") throw new Error("Live execution did not return a live run. Sample data was not displayed.");
        if (active && !demo) {
          setRun(current => mergeRunSnapshot(current,{...latest,agents:current.agents}));
          setLoaded(true);
        }
        if (!demo) {
          const data = await requestJson<{agents:ModernizationAgent[];messages:AgentMessage[]}>(authorizedFetch, `/api/transformations/${runId}/agents`, {cache:"no-store"}, 20_000, "Agent output refresh timed out. Displayed data may be stale.");
          if (active) { setMessages(data.messages || []); setRun(current => mergeRunSnapshot(current,{...latest,agents:data.agents || []})); }
        } else if (active) {
          setRun(current=>mergeRunSnapshot(current,latest));
        }
        if (active) { setLoaded(true); setApiError(""); setLastSync(new Date().toLocaleTimeString()); }
      } catch (error) { if (active){setApiError(error instanceof Error ? error.message : "Unable to refresh transformation progress.");setLoaded(true);} }
      finally { refreshing = false; if(active)setRefreshingStatus(false); }
    }
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [authorizedFetch, runId, demo, refreshRequest]);

  useEffect(() => {
    if (!demo || run.status !== "running") return;
    const timer = window.setInterval(() => {
      setRun((current) => {
        if (current.progress >= 74) return current;
        const progress = current.progress + 1;
        return {
          ...current,
          progress,
          stages: current.stages.map((stage) => stage.id === "generate" ? { ...stage, progress: Math.min(86, stage.progress + 2) } : stage),
        };
      });
    }, 2400);
    return () => window.clearInterval(timer);
  }, [run.status, demo]);

  const visibleFiles = useMemo(() => filterChanges(run.files,filter,agentFilter,query), [run.files, filter, agentFilter, query]);
  const selected = visibleFiles.find((file) => file.path === selectedPath) || visibleFiles[0];
  useEffect(()=>{if(!visibleFiles.length){if(selectedPath)setSelectedPath("");return;}if(!visibleFiles.some(file=>file.path===selectedPath))setSelectedPath(visibleFiles[0].path);},[selectedPath,visibleFiles]);
  const additions = visibleFiles.reduce((sum, file) => sum + file.additions, 0);
  const deletions = visibleFiles.reduce((sum, file) => sum + file.deletions, 0);
  const approved = ["approved", "pull-request-created", "publication-failed"].includes(run.status);
  const approvalReason = (editingCode?"Finish or discard the code edit before approval.":"") || approvalBlockReason(run) || (rejectedVersion === (run.version ?? 0) ? "The server rejected approval for this revision. Waiting for updated validation state." : "");

  async function approve() {
    if (approvalInFlight.current || approvalReason || approved) return;
    approvalInFlight.current = true;
    setApproving(true);
    setApprovalError("");
    try {
      await withRequestDeadline(async signal => {
        const response = await authorizedFetch(`/api/transformations/${run.id}/approve`, {
          method: "POST", signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ commitSha: run.sourceCommitSha, changesetDigest:run.validationExecution?.changesetDigest, decision: "approved", comment: "Reviewed exact file diff and validation evidence." }),
        });
        if (response.status === 409) setRejectedVersion(run.version ?? 0);
        if (!response.ok) { const payload = await response.json().catch(()=>({})); throw new Error(payload.error || `Approval failed (HTTP ${response.status}).`); }
      }, 30_000, "Approval confirmation timed out. Check the refreshed run state before trying again.");
      setRun((current) => ({ ...current, version: Math.max(current.version ?? 0,(run.version ?? 0)+1), status: "approved", currentStage: "pull-request-publication" }));
      setTab("progress");setRefreshRequest(value=>value+1);
    } catch (error) { setApprovalError(error instanceof Error ? error.message : "Approval failed."); }
    finally { approvalInFlight.current = false; setApproving(false); }
  }
  async function saveCode(path:string,content:string){
    if(run.mode==="demo"){setRun(current=>({...current,files:current.files.map(file=>file.path===path?{...file,after:content,userModified:true,validation:[]}:file)}));return;}
    const response=await authorizedFetch(`/api/transformations/${run.id}/changes`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({path,content,baseVersion:run.version||1})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||"Code edit could not be saved.");setApprovalError("");setRun(current=>({...current,version:(current.version||1)+1,status:"running",currentStage:"testing-user-edit",agents:current.agents?.map(agent=>agent.type==="testing"?{...agent,status:"queued",progress:0}:agent),files:current.files.map(file=>file.path===path?{...file,after:content,userModified:true,validation:[]}:file)}));
  }
  async function sendInstruction(agentType:AgentType,content:string){
    if(run.mode==="demo"){setMessages(current=>[...current,{id:`demo-${Date.now()}`,agentType,role:"user",content,createdAt:new Date().toISOString()},{id:`demo-agent-${Date.now()}`,agentType,role:"agent",content:"Instruction received. I will refine my owned files and send the result to the Testing Agent.",createdAt:new Date().toISOString()}]);return;}
    const response=await authorizedFetch(`/api/transformations/${run.id}/agents`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentType,content})});const data=await response.json();if(!response.ok)throw new Error(data.error||"Instruction could not be sent.");setMessages(current=>[...current,{id:`local-${Date.now()}`,agentType,role:"user",content,createdAt:new Date().toISOString()}]);
  }
  async function changeLifecycle(action:"cancel"|"retry") {setApiError("");try{const data=await requestJson<{status:TransformationRun["status"]}>(authorizedFetch,`/api/transformations/${run.id}/${action}`,{method:"POST",headers:{"Content-Type":"application/json"},body:action==="cancel"?JSON.stringify({reason:"Cancelled by an administrator."}):"{}"},30000,"Action confirmation timed out. Check the current run state before retrying.");setRun(current=>({...current,status:data.status,currentStage:data.status==="approved"?"publication-queued":data.status,errorDetail:undefined,errorCode:undefined,progress:action==="retry"&&data.status!=="approved"?0:current.progress}));if(data.status==="approved")setTab("progress");setRefreshRequest(value=>value+1);}catch(error){setApiError(error instanceof Error?error.message:`Run ${action} failed.`);}}

  if(!loaded)return <div className="live-loading"><LoaderCircle className="spin" size={28}/><strong>Loading transformation</strong><span>Retrieving tenant-scoped run state and validation evidence…</span></div>;

  if(initialView==="history")return <div className="run-workspace team-workspace"><p className="team-context">{run.repository} · {run.status.replaceAll("-"," ")}</p>{apiError&&<p className="error-note" role="alert">{apiError}</p>}<AgentsTab run={run} selected={selectedAgent} onSelect={setSelectedAgent} agents={run.agents?.length?run.agents:(demo?demoAgents:[])} messages={messages} onSend={sendInstruction}/><details className="historical-execution"><summary>Recorded task results</summary><ExecutionControl run={run} lastSync={lastSync} error={apiError} refreshing={refreshingStatus} onRefresh={()=>setRefreshRequest(value=>value+1)} onAgent={agent=>setSelectedAgent(agent)}/></details></div>;

  return <div className="run-workspace fade-in">
    <button className="back-link" onClick={onBack}><ArrowLeft size={14}/> Back to projects</button>
    <section className="run-header panel">
      <div className="run-identity"><div className="run-logo"><Code2 size={21}/></div><div><div className="run-badges"><span className="run-id">{run.id}</span><span className={`mode-badge ${run.mode}`}>{run.mode.toUpperCase()} RUN</span>{run.aiModel&&<span className="model-badge">{run.aiModel}</span>}{!demo && <span className={`run-sync ${apiError?"stale":""}`} title={apiError ? "Refresh failed; displayed state may be stale." : `Last successful refresh: ${lastSync || "pending"}`}><RefreshCw size={11}/>{apiError ? "Sync delayed" : "Live"}</span>}</div><h2>{run.name}</h2><p><Github size={13}/>{run.repository}<GitBranch size={13}/>{run.targetBranch}</p></div></div>
      <div className="run-header-controls"><div className="run-overall"><div><span>{run.status==="pull-request-created"?"PR PUBLICATION COMPLETE":"PROGRESS TO DRAFT PR"}</span><strong>{run.progress}%</strong></div><div className="run-progress"><i style={{ width: `${run.progress}%` }}/></div><p>{["queued","retrying","running","approved"].includes(run.status)&&<LoaderCircle className="spin" size={13}/>} {run.status==="pull-request-created"?"Draft PR created":run.currentStage.replaceAll("-"," ")}</p></div>{run.mode==="live"&&["queued","retrying","running","awaiting-approval"].includes(run.status)&&<button className="run-lifecycle cancel" onClick={()=>void changeLifecycle("cancel")}><XCircle size={14}/>Cancel run</button>}{run.mode==="live"&&["failed","cancelled"].includes(run.status)&&<button className="run-lifecycle" onClick={()=>void changeLifecycle("retry")}><RefreshCw size={14}/>Retry run</button>}</div>
    </section>

    {run.mode === "demo" && <div className="demo-disclosure"><AlertTriangle size={15}/><strong>Demonstration run:</strong> progress and diffs are representative. No GitHub files are being changed until a live GitHub App connection and approval are configured.</div>}
    {run.mode === "live"&&run.errorDetail&&<div className="run-api-error"><XCircle size={14}/><div><strong>{run.errorCode||"Transformation failed"}</strong><span>{run.errorDetail}</span></div></div>}
    {apiError && <div className="run-api-error"><XCircle size={14}/>{apiError}</div>}
    {run.mode === "live" && ["preparing","running"].includes(run.validationExecution?.status || "") && <div className="inline-note" role="status"><LoaderCircle className="spin" size={15}/><span>{run.validationExecution?.reason}</span><button className="secondary-button" onClick={()=>setTab("validation")}>View verification</button></div>}
    {!demo && run.status === "retrying" && <div className="inline-note"><RefreshCw size={14}/>Retry scheduled. Progress will restart for the new attempt.</div>}
    {!demo && <div className="run-project-actions"><DeleteProjectButton id={run.id} repository={run.repository} branch={run.targetBranch} status={run.status} onDeleted={onDeleted || onBack}/></div>}

    {run.mode==="live"&&<RunJourney run={run} reviewing={tab==="changes"} approving={approving} approvalReason={approvalReason} onReview={()=>setTab("changes")} onVerify={()=>setTab("validation")} onAgents={()=>openAgent()} onRefresh={()=>setRefreshRequest(value=>value+1)} onRetry={()=>void changeLifecycle("retry")} onApprove={()=>void approve()}/>}
    <nav className="run-tabs" aria-label="Transformation details">
      <button aria-current={tab==="progress"?"page":undefined} className={tab === "progress" ? "active" : ""} onClick={() => setTab("progress")}><Play size={15}/>Status</button>
      <button aria-current={tab==="changes"?"page":undefined} className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}><FileDiff size={15}/>Changes <b>{run.files.length}</b></button>
      <button aria-current={tab==="validation"?"page":undefined} className={tab === "validation" ? "active" : ""} onClick={() => setTab("validation")}><TestTube2 size={15}/>Verification</button>
      <button aria-current={tab==="history"?"page":undefined} className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}><Clock3 size={15}/>History</button>
    </nav>

    {tab === "progress" && <>{!approved&&<ExecutionControl run={run} lastSync={lastSync} error={apiError} refreshing={refreshingStatus} onRefresh={()=>setRefreshRequest(value=>value+1)} onAgent={openAgent}/>}<ProgressTab run={run} stale={Boolean(apiError)} onReview={() => setTab("changes")} onAgent={openAgent} />{approved&&<div className="status-verification"><div><h3>Changeset verification</h3><p>{run.validationExecution?.status==="passed"?"Passed. Approval recorded for this changeset.":run.validationExecution?.reason||"No execution report available."}</p>{run.status==="pull-request-created"&&<p>GitHub CI, merge and deployment status are not tracked here.</p>}</div><button className="secondary-button" onClick={()=>setTab("validation")}><TestTube2 size={15}/>View results</button></div>}</>}
    {tab === "history"&&<section className="run-history" aria-label="Run history"><fieldset className="history-switch"><legend className="sr-only">History view</legend>{(["agents","activity"] as const).map(value=><label key={value}><input type="radio" name={`history-${run.id}`} checked={historyView===value} onChange={()=>setHistoryView(value)}/>{value==="agents"?<Users size={14}/>:<TerminalSquare size={14}/>}<span>{value==="agents"?"Agents":"Activity"}</span></label>)}</fieldset>{historyView==="agents"?<><details className="historical-execution"><summary>Recorded task results</summary><ExecutionControl run={run} lastSync={lastSync} error={apiError} refreshing={refreshingStatus} onRefresh={()=>setRefreshRequest(value=>value+1)} onAgent={openAgent}/></details><div id="agent-output-view"><AgentsTab run={run} selected={selectedAgent} onSelect={setSelectedAgent} agents={run.agents?.length?run.agents:(run.mode==="demo"?demoAgents:[])} messages={messages} onSend={sendInstruction}/></div></>:<LogsTab run={run} messages={messages}/>}</section>}
    {tab === "changes" && <div className="changes-toolbar"><label>Agent<select value={agentFilter} onChange={event=>setAgentFilter(event.target.value)}><option value="all">All agents</option>{Object.entries(agentNames).map(([type,name])=><option key={type} value={type}>{name} ({run.files.filter(file=>file.agentType===type).length})</option>)}<option value="unassigned">Unassigned ({run.files.filter(file=>!file.agentType).length})</option></select></label><label>Area<select value={filter} onChange={event=>setFilter(event.target.value)}>{["all","frontend","backend","platform","tests"].map(area=><option key={area} value={area}>{area==="all"?"All areas":area}</option>)}</select></label><label>File path<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search file paths"/></label><span>{visibleFiles.length} of {run.files.length} files</span><button className="secondary-button" onClick={()=>{setAgentFilter("all");setFilter("all");setQuery("");}}>Reset filters</button></div>}
    {tab === "changes" && run.mode === "live" && !approved && approvalReason && <section className="approval-readiness" aria-label="Approval requirements"><div><strong>Approval unavailable</strong><p>{approvalReason}</p></div><button className="secondary-button" onClick={()=>setTab("validation")}><TestTube2 size={15}/>{run.validationExecution?.id ? "View verification results" : "Open verification"}</button></section>}
    {tab === "changes" && <ChangesTab onEditingChange={setEditingCode} files={visibleFiles} selected={selected} selectedPath={selectedPath} setSelectedPath={setSelectedPath} filter={filter} setFilter={setFilter} query={query} setQuery={setQuery} additions={additions} deletions={deletions} approved={approved} approving={approving} approvalReason={approvalReason} approvalError={approvalError} onApprove={approve} onSaveEdit={saveCode} />}
    {tab === "validation" && (run.mode==="live"?<VerificationPanel run={run} onRefresh={()=>setRefreshRequest(value=>value+1)}/>:<ValidationTab run={run} />)}
  </div>;
}

function ProgressTab({ run, onReview, onAgent, stale }: { run: TransformationRun; onReview: () => void; onAgent:(agent:AgentType)=>void; stale:boolean }) {
  if(["approved","publication-failed","pull-request-created"].includes(run.status))return <section className="publication-summary"><h3>Approved publication</h3><p>{run.files.length} reviewed files · Verification {run.validationExecution?.status||"unavailable"} · Approval recorded</p><p><GitBranch size={14}/> {run.targetBranch}</p><p>Source commit: <code>{run.sourceCommitSha}</code></p><button className="secondary-button" onClick={onReview}><FileDiff size={14}/>View approved changes</button></section>;
  const activeAgent=["testing-user-edit","testing-agent-validation"].includes(run.currentStage) ? run.agents?.find(agent=>agent.type==="testing") : run.agents?.find(agent=>agent.status==="running"||agent.status==="retrying") || run.agents?.find(agent=>agent.error) || run.agents?.find(agent=>agent.output);
  return <div className="run-grid"><section className="panel stage-panel"><div className="panel-header"><div><h3>Transformation pipeline</h3><p>Every stage is observable, reversible, and protected by quality gates.</p></div><span className="live-badge"><i/> LIVE</span></div><div className="stage-list">{run.stages.map((stage, index) => <div className={`stage-row ${stage.status}`} key={stage.id}><div className="stage-rail"><StageIcon status={stage.status}/>{index < run.stages.length - 1 && <i/>}</div><div className="stage-main"><div className="stage-top"><div><strong>{stage.title}</strong><p>{stage.detail}</p></div><StageStatus status={stage.status}/></div>{stage.status === "running" && <div className="stage-progress"><i style={{width:`${stage.progress}%`}}/><span>{stage.progress}%</span></div>}<div className="stage-time">{stage.startedAt && <span><Clock3 size={11}/>Started {stage.startedAt}</span>}{stage.completedAt && <span><Check size={11}/>Completed {stage.completedAt}</span>}</div></div></div>)}</div></section>
    <aside className="run-side"><section className="panel run-stat-card"><span>FILES IN CHANGESET</span><strong>{run.files.length}</strong><p>{run.files.length?`${run.files.filter(file=>!file.userModified&&file.validation.length>0).length} with validation evidence`:`Changes appear after agent generation completes`}</p><button onClick={onReview} disabled={!run.files.length}>Review exact changes <ChevronRight size={14}/></button></section><section className="panel agent-card"><span>REPORTED AGENT STATE · {run.aiModel||"Microsoft Foundry"}</span><h3>{activeAgent?.name||"Orchestrator"}</h3><p>{activeAgent?.objective || run.currentStage}</p><div role="status">{agentActivityLabel(run,activeAgent,stale)}</div>{activeAgent?.error&&<p className="error-note">{activeAgent.error}</p>}{activeAgent?.output&&<a className="agent-output-link" href="#agent-output-view" onClick={event=>{event.preventDefault();onAgent(activeAgent.type);}}>Generated output available in Agents</a>}{activeAgent?.outputUpdatedAt && <p>Last output: {new Date(activeAgent.outputUpdatedAt).toLocaleString()}</p>}</section></aside>
  </div>;
}

function StageIcon({ status }: { status: string }) {
  if (status === "passed") return <span className="stage-icon passed"><Check size={14}/></span>;
  if (status === "running") return <span className="stage-icon running"><LoaderCircle className="spin" size={14}/></span>;
  if (status === "blocked") return <span className="stage-icon blocked"><XCircle size={14}/></span>;
  return <span className="stage-icon"><Circle size={12}/></span>;
}
function StageStatus({ status }: { status: string }) { return <span className={`stage-status ${status}`}>{status === "passed" ? "PASSED" : status === "running" ? "IN PROGRESS" : status === "awaiting-approval" ? "AWAITING APPROVAL" : status.toUpperCase()}</span>; }

function AgentsTab({run,agents,messages,onSend,selected,onSelect:setSelected}:{run:TransformationRun;agents:ModernizationAgent[];messages:AgentMessage[];onSend:(agent:AgentType,content:string)=>Promise<void>;selected:AgentType;onSelect:(agent:AgentType)=>void}){
 const[draft,setDraft]=useState("");const[sending,setSending]=useState(false);const[error,setError]=useState("");const active=agents.find(agent=>agent.type===selected)||agents[0];const conversation=messages.filter(message=>message.agentType===active?.type);
 const editable=canRefineRun(run.status);
 const send=async()=>{if(!editable||!draft.trim() || !active)return;setSending(true);setError("");try{await onSend(active.type,draft.trim());setDraft("");}catch(caught){setError(caught instanceof Error?caught.message:"Instruction failed.");}finally{setSending(false)}};
 return <div className="agents-layout"><section className="panel agent-roster"><div className="panel-header"><h3>Agent team</h3></div><div className="agent-grid">{agents.map(agent=>{
   const published=agentPublication(agent,run).complete;
   return <button key={agent.id} className={active?.type===agent.type?"active":""} onClick={()=>setSelected(agent.type)}><div className={`agent-avatar ${agent.type}`}><Bot size={17}/></div><div><strong>{agent.name}</strong><span>{agent.objective}</span></div><b className={`stage-status ${published?"passed":agent.status}`}>{published?(agent.error?"Published; error history":"Published"):agent.status}</b></button>;
 })}</div></section><section className="panel agent-conversation">
   <div className="agent-chat-head"><Bot size={18}/><div><h3>{active?.name || "No agent selected"}</h3><p>{active?.filesOwned.length||0} output paths recorded</p></div></div>
   <AgentOutput key={active?.id} agent={active} run={run}/>
   {conversation.length>0&&<div className="agent-messages">{conversation.map(message=><div key={message.id} className={`agent-message ${message.role}`}><span>{message.role==="user"?"You":active?.name} · {new Date(message.createdAt).toLocaleString()}</span><p>{message.content}</p></div>)}</div>}
   {error&&<div className="error-note">{error}</div>}
   {editable?<div className="agent-compose"><textarea value={draft} onChange={event=>setDraft(event.target.value)} placeholder={`Refinement for ${active?.name || "agent"}...`}/><button aria-label="Send refinement" onClick={()=>void send()} disabled={sending||!draft.trim()||!active||active.status==="running"}><Send size={15}/></button></div>:<p className="agent-readonly">This run is read-only. Further changes require a new reviewed changeset.</p>}
 </section></div>;
}

function ChangesTab({ files, selected, selectedPath, setSelectedPath, filter, setFilter, query, setQuery, additions, deletions, approved, approving, approvalReason, approvalError, onApprove, onSaveEdit,onEditingChange }: { files: TransformationFile[]; selected?: TransformationFile; selectedPath: string; setSelectedPath: (path:string)=>void; filter:string; setFilter:(value:string)=>void; query:string; setQuery:(value:string)=>void; additions:number; deletions:number; approved:boolean; approving:boolean; approvalReason:string; approvalError:string; onApprove:()=>void; onSaveEdit:(path:string,content:string)=>Promise<void>;onEditingChange:(editing:boolean)=>void }) {
  const[editing,setEditing]=useState(false);const[draft,setDraft]=useState(selected?.after||"");const[saving,setSaving]=useState(false);const[editError,setEditError]=useState("");
  useEffect(()=>{onEditingChange(editing);return()=>onEditingChange(false);},[editing,onEditingChange]);
  useEffect(()=>{setDraft(selected?.after||"");setEditing(false);setEditError("");},[selected?.path,selected?.after]);
  if(!selected)return <div className="panel live-empty"><FileDiff size={24}/><h3>No files match the current filters</h3><p>No matching generated changes are available.</p></div>;
  const save=async()=>{setSaving(true);setEditError("");try{await onSaveEdit(selected.path,draft);setEditing(false);}catch(error){setEditError(error instanceof Error?error.message:"Edit could not be saved.");}finally{setSaving(false)}};
  return <div className="changes-layout"><section className="panel file-browser"><div className="changes-summary"><div><strong>{files.length} files</strong><span><b>+{additions}</b> <em>−{deletions}</em></span></div><p>Exact proposed changes</p></div><div className="file-search"><Search size={13}/><input value={query} onChange={(event)=>setQuery(event.target.value)} placeholder="Filter files…"/></div><div className="area-filters">{["all","frontend","backend","platform","tests"].map((area)=><button key={area} className={filter===area?"active":""} onClick={()=>setFilter(area)}>{area}</button>)}</div><div className="file-list">{files.map((file)=><button key={file.path} className={selectedPath===file.path?"active":""} onClick={()=>setSelectedPath(file.path)}><FileStatus status={file.status}/><div><strong>{file.path.split("/").pop()}</strong><span>{file.path}</span></div><small><b>+{file.additions}</b><em>−{file.deletions}</em></small></button>)}</div></section>
    <section className="panel diff-panel"><div className="diff-head"><div><span className={`file-status ${selected.status}`}>{selected.status.toUpperCase()}</span><strong>{selected.path}</strong>{selected.agentType&&<small>Owned by {selected.agentType} agent</small>}{selected.userModified&&<span className="user-edited">USER EDITED</span>}</div><div><button className="edit-code-button" disabled={approving || approved} onClick={()=>setEditing(!editing)}>{editing?<XCircle size={13}/>:<Pencil size={13}/>} {editing?"Cancel edit":"Edit file"}</button><b>+{selected.additions}</b><em>−{selected.deletions}</em></div></div><div className="rationale"><ListChecks size={16}/><div><strong>Why this change is proposed</strong><p>{selected.rationale}</p></div></div>{editing?<div className="code-editor"><div><Code2 size={14}/>Editing {selected.path}<span>Testing Agent will rerun after save</span></div><textarea value={draft} onChange={event=>setDraft(event.target.value)} spellCheck={false}/>{editError&&<div className="error-note">{editError}</div>}<button onClick={()=>void save()} disabled={saving}><Save size={14}/>{saving?"Saving…":"Save and revalidate"}</button></div>:<div className="diff-columns"><CodePane title="BEFORE" code={selected.before} side="before"/><CodePane title="AFTER" code={selected.after} side="after"/></div>}<div className="file-validation"><strong>VALIDATION EVIDENCE</strong><div>{selected.validation.length?selected.validation.map((check)=><span key={check}><CheckCircle2 size={13}/>{check}</span>):<span className="pending-validation"><LoaderCircle className="spin" size={13}/>Testing Agent validation required</span>}</div></div>{approvalError&&<div className="error-note" role="alert">{approvalError}</div>}<div className="approval-bar"><div><ShieldCheck size={18}/><span><strong>{approved ? "Approval recorded" : "Human review required"}</strong><small>{editing ? "Finish or discard the code edit before approval." : approvalReason || "Approval records the reviewed commit SHA in the audit log."}</small></span></div><button className={approved?"approved":""} onClick={onApprove} disabled={approved || approving || saving || editing || Boolean(approvalReason)}>{approved?<><Check size={14}/>Changes approved</>:approving?"Recording approval...":"Approve changeset"}</button></div></section>
  </div>;
}

function FileStatus({ status }: { status: TransformationFile["status"] }) { return status === "added" ? <FilePlus2 className="added" size={15}/> : <FileDiff className="modified" size={15}/>; }
function CodePane({ title, code, side }: { title:string; code:string; side:"before"|"after" }) { const lines=code ? code.split("\n") : ["New file — no previous content"]; return <div className={`code-pane ${side}`}><div>{title}</div><pre>{lines.map((line,index)=><span key={`${index}-${line}`}><i>{index+1}</i><code>{line || " "}</code></span>)}</pre></div>; }

function ValidationTab({run}:{run:TransformationRun}) {
  if(run.mode === "live") return <section className="panel"><div className="panel-header"><h3>Execution verification</h3><span className="stage-status blocked">NOT EXECUTED</span></div><div className="agent-output"><p>{validationExecution.reason}</p><p>{run.files.length} proposed files. No verified build exit codes, test reports or sandbox execution records are available.</p></div></section>;
  const suites=[{title:"Compilation",detail:"5 projects · 0 errors · 0 warnings",value:"Passed",count:"5/5"},{title:"Characterization tests",detail:"Existing behavior captured before transformation",value:"Passed",count:"23/23"},{title:"Contract tests",detail:"API and ERP integration snapshots",value:"Passed",count:"146/146"},{title:"Security scan",detail:"SAST, secrets and dependency vulnerabilities",value:"Passed",count:"0 critical"},{title:"Behavior parity",detail:"Legacy vs modern response comparison",value:"Running",count:"98.7%"}];
  return <div className="validation-grid"><section className="panel"><div className="panel-header"><div><h3>Quality gate evidence</h3><p>Generated code cannot advance unless mandatory checks pass.</p></div><span className="gate-score">4 / 5 passed</span></div><div className="suite-list">{suites.map((suite)=><div key={suite.title}><span className={suite.value==="Passed"?"passed":"running"}>{suite.value==="Passed"?<Check size={14}/>:<LoaderCircle className="spin" size={14}/>}</span><div><strong>{suite.title}</strong><p>{suite.detail}</p></div><b>{suite.count}</b></div>)}</div></section><section className="panel parity-card"><ShieldCheck size={26}/><span>BEHAVIOR PARITY</span><strong>98.7%</strong><div><i style={{width:"98.7%"}}/></div><p>Target threshold: 99.5%. Three response ordering differences remain under investigation.</p><button>Open mismatch report <ChevronRight size={13}/></button></section></div>;
}

function LogsTab({run,messages}:{run:TransformationRun;messages:AgentMessage[]}) {
  const events = [...(run.agents || []).flatMap(agent => [
    ...(agent.startedAt ? [{id:`${agent.id}-start`,time:agent.startedAt,text:`${agent.name}: generation requested (${agent.inputPaths?.length || 0} input files)`}] : []),
    ...(agent.outputUpdatedAt ? [{id:`${agent.id}-output`,time:agent.outputUpdatedAt,text:`${agent.name}: ${agent.output?.length || 0} public output characters received`}] : []),
    ...(agent.completedAt ? [{id:`${agent.id}-end`,time:agent.completedAt,text:`${agent.name}: ${agent.error || agent.summary || agent.status}`}] : []),
  ]), ...messages.map(message => ({id:message.id,time:message.createdAt,text:`${message.agentType}: ${message.content}`}))].sort((first,second) => Date.parse(first.time)-Date.parse(second.time));
  return <section className="panel log-panel"><div className="panel-header"><h3>Recorded agent activity</h3></div><ol className="agent-activity-list">{events.length ? events.map(event => <li key={event.id}><time dateTime={event.time}>{new Date(event.time).toLocaleString()}</time><p>{event.text}</p></li>) : <li>No agent activity recorded for this run.</li>}</ol></section>;
}