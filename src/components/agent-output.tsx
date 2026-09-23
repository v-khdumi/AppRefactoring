"use client";

import { useState } from "react";
import { parse } from "partial-json";
import type { ModernizationAgent, TransformationRun } from "@/types/modernization";
import { agentPublication } from "@/lib/agent-publication";

export function AgentOutput({ agent,run }: { agent?: ModernizationAgent;run?:TransformationRun }) {
  const [selectedPath, setSelectedPath] = useState("");
  const publication=agentPublication(agent,run);
  let preview: { summary?: string; changes?: Array<{path?: string; rationale?: string; after?: string}> } = {};
  try { preview = parse(agent?.output || "{}") || {}; } catch {}
  const changes = Array.isArray(preview.changes) ? preview.changes.filter(change => change && typeof change.path === "string") : [];
  const selected = changes.find(change => change.path === selectedPath) || changes.at(-1);
  return <section className="agent-output" aria-label="Generated output">
    <header className="output-heading"><h3>Generated output</h3><span className={`stage-status ${publication.complete?"passed":agent?.error ? "blocked" : agent?.status || "queued"}`}>{publication.complete?"Published output":agent?.error && agent.status === "passed" ? "Inconsistent recorded result" : agent?.error ? "Error recorded" : agent?.status === "passed" ? "Plan generated" : agent?.status?.replaceAll("-"," ") || "No agent selected"}</span></header>
    {agent?.objective && <p className="output-objective">{agent.objective}</p>}
    <dl className="output-metadata"><div><dt>Last output</dt><dd>{agent?.outputUpdatedAt ? <time dateTime={agent.outputUpdatedAt}>{new Date(agent.outputUpdatedAt).toLocaleString()}</time> : "Not received"}</dd></div>{agent?.startedAt&&<div><dt>Attempt started</dt><dd><time dateTime={agent.startedAt}>{new Date(agent.startedAt).toLocaleString()}</time></dd></div>}</dl>
    {publication.complete&&<p role="status">All {publication.paths.length} output files exactly match the verified changeset published in the draft pull request. No regeneration is required for these files.</p>}
    {agent?.error && (publication.complete?<details className="output-error-history"><summary>Recorded generation error (history)</summary><p>The task retains an error alongside its recorded completion. The file comparison above confirms publication; this historical retry instruction does not apply to the published run.</p><div className="error-note">{agent.error}</div></details>:<div className="error-note">{agent.error}</div>)}
    <details className="output-inputs"><summary>Input files ({agent?.inputPaths?.length || 0})</summary><ul>{agent?.inputPaths?.map(path => <li key={path}><code>{path}</code></li>)}</ul></details>
    {typeof preview.summary === "string" && <section className="output-decisions"><h4>Proposed decisions</h4><p>{preview.summary}</p></section>}
    {changes.length > 0 ? <><label>Generated file<select value={selected?.path || ""} onChange={event => setSelectedPath(event.target.value)}>{changes.map((change, index) => <option key={`${change.path}-${index}`} value={change.path}>{change.path}</option>)}</select></label><p>{selected?.rationale}</p>{selected?.path&&publication.paths.includes(selected.path)?<span className="published-output">Published content - exact match with the verified changeset</span>:<span>Draft output - publication not confirmed for this content</span>}<pre aria-label="Generated code"><code>{typeof selected?.after === "string" ? selected.after : "Waiting for file content..."}</code></pre></> : <p>{agent?.status === "running" ? "Waiting for public model output. No file content has been received for this attempt." : "No generated file preview for this attempt."}</p>}
    <details><summary>Raw public output ({agent?.output?.length || 0} characters)</summary><pre><code>{agent?.output || "No output received"}</code></pre></details>
  </section>;
}