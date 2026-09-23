"use client";

import { RefreshCw, ArrowRight } from "lucide-react";
import type { AgentType, TransformationRun } from "@/types/modernization";
import { approvalBlockReason } from "@/lib/approval-state";

export function ExecutionControl({run,onAgent,onRefresh,refreshing,lastSync,error}:{run:TransformationRun;onAgent:(agent:AgentType)=>void;onRefresh:()=>void;refreshing:boolean;lastSync:string;error:string}) {
  const agents=run.agents || [];
  const completed=agents.filter(agent=>agent.status==="passed"&&!agent.error).length;
  const running=agents.filter(agent=>agent.status==="running").length;
  const queued=agents.filter(agent=>["queued","retrying"].includes(agent.status)).length;
  const blocked=agents.filter(agent=>agent.error||["failed","blocked"].includes(agent.status)).length;
  const pending=run.files.filter(file=>file.userModified||!file.validation.length).length;
  const gate=approvalBlockReason(run);
  return <section className="execution-control" aria-label="Execution control">
    <header><div><h3>Execution control</h3><p>{run.status.replaceAll("-"," ")} · {run.currentStage.replaceAll("-"," ")}</p></div><button className="secondary-button" disabled={refreshing} onClick={onRefresh}><RefreshCw size={14} className={refreshing?"spin":""}/>Refresh status</button></header>
    <dl className="execution-counters"><div><dt>Plans generated</dt><dd>{completed} / {agents.length}</dd></div><div><dt>Reported running</dt><dd>{running}</dd></div><div><dt>Queued / retrying</dt><dd>{queued}</dd></div><div><dt>Blocked / failed</dt><dd>{blocked}</dd></div><div><dt>Files pending validation</dt><dd>{pending} / {run.files.length}</dd></div></dl>
    <p className="execution-evidence-note">Plan generation is not proof of executed tests. Agent percentages are reported milestones, not time remaining.</p>
    <div className="execution-metadata"><span>Last server refresh: {lastSync||"Not received"}</span>{run.attemptStartedAt&&<span>Attempt started: {new Date(run.attemptStartedAt).toLocaleString()}</span>}{run.sourceCommitSha&&<span>Source commit: <code>{run.sourceCommitSha}</code></span>}</div>
    {error&&<p className="error-note" role="alert">{error} Displayed task states may be stale.</p>}
    {gate&&<p className="execution-gate"><strong>Approval:</strong> {gate}</p>}
    <div className="execution-table-wrap"><table className="execution-task-table"><caption>Recorded agent tasks</caption><thead><tr><th>Agent / objective</th><th>Recorded state</th><th>Milestone</th><th>Latest output</th><th>Result</th></tr></thead><tbody>{agents.map(agent=><tr key={agent.id}><td><button className="task-agent-link" onClick={()=>onAgent(agent.type)}>{agent.name}<ArrowRight size={12}/></button><p>{agent.objective}</p></td><td>{agent.error ? (agent.status==="passed"?"Inconsistent result":"Error recorded") : agent.status==="passed"?"Plan generated":agent.status.replaceAll("-"," ")}{run.status!=="running"&&agent.status==="running"&&<small>Run is {run.status}; activity not confirmed.</small>}</td><td>{agent.error?"Unverified":`${agent.progress}%`}</td><td>{agent.outputUpdatedAt?new Date(agent.outputUpdatedAt).toLocaleString():"No output recorded"}<small>{agent.output?.length||0} characters</small></td><td>{agent.error&&<p role="alert"><strong>Recorded error:</strong> {agent.error}</p>}{agent.summary&&<details><summary>Generated plan summary</summary><p>{agent.summary}</p></details>}{!agent.summary&&!agent.error&&"No result recorded"}{agent.completedAt&&<small>Finished: {new Date(agent.completedAt).toLocaleString()}</small>}<small>{agent.filesOwned.length} proposed paths (not execution evidence)</small></td></tr>)}</tbody></table>{!agents.length&&<p>No agent tasks received yet.</p>}</div>
  </section>;
}