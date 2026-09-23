"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight, Bell, Blocks, Bot, Check, CheckCheck, CheckCircle2, CircleDot,
  Cloud, Code2, Database, FileCode2, Gauge, GitBranch, Github, Home, Layers3, LockKeyhole,
  ExternalLink, Info, LoaderCircle, LogOut, Menu, Network, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, RefreshCw, Save, Search, Settings, ShieldCheck, Sparkles, TestTube2, WandSparkles, X,
} from "lucide-react";
import { ArchitectureMap } from "@/components/architecture-map";
import { TransformationWorkspace } from "@/components/transformation-workspace";
import { createDemoAnalysis } from "@/lib/demo-analysis";
import type { AnalysisResult } from "@/types/modernization";
import { useModernizeAuth } from "@/components/auth-provider";
import type { StackRecommendation } from "@/lib/stack-recommendation";
import { CustomCapabilityDesigner } from "@/components/custom-capability-designer";
import { requestJson } from "@/lib/request-json";
import { cleanWorkspaceUrl } from "@/lib/execution-state";
import { DeleteProjectButton } from "@/components/delete-project-button";
import {ProjectArchitecture,DependencyEvidence} from "@/components/project-architecture";

type View = "overview" | "projects" | "repositories" | "architecture" | "team" | "execution" | "settings";
type PortfolioRun = { id:string; repository_url?:string; repository?:string; target_branch?:string; targetBranch?:string; current_stage?:string; currentStage?:string; status:string; progress:number };

const navItems: Array<{ id: View; label: string; icon: typeof Home }> = [
  { id: "overview", label: "Overview", icon: Home },
  { id: "projects", label: "Modernizations", icon: WandSparkles },
  { id: "repositories", label: "Repositories", icon: Github },
  { id: "architecture", label: "Architecture", icon: Network },
  { id: "team", label: "Agent team", icon: Bot },
  { id: "execution", label: "Execution", icon: Play },
];

const activity = [
  { color: "green", title: "Inventory API · phase 2 completed", meta: "18 minutes ago · 284 tests passed" },
  { color: "violet", title: "AI analysis updated 3 recommendations", meta: "2 hours ago · OrderHub modernization" },
  { color: "blue", title: "Repository scan completed", meta: "Yesterday · 1,248 files analyzed" },
  { color: "amber", title: "Security gate requires review", meta: "Yesterday · 2 high-risk dependencies" },
];

export function ModernizeDashboard() {
  useEffect(() => {
    const cleaned = cleanWorkspaceUrl(window.location.href);
    if (cleaned !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(window.history.state, "", cleaned);
  }, []);
  const [view, setView] = useState<View>("overview");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [notificationsOpen,setNotificationsOpen]=useState(false);
  const [notificationsRead,setNotificationsRead]=useState(false);
  const [settingsSection,setSettingsSection]=useState<"foundry"|"notifications">("foundry");
  const auth = useModernizeAuth();
  const authorizedFetch=auth.authorizedFetch;
  const isDemo=auth.demo;
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(() => auth.demo ? createDemoAnalysis() : null);
  const [runs, setRuns] = useState<PortfolioRun[]>([]);
  const [portfolioLoading, setPortfolioLoading] = useState(!auth.demo);
  const [portfolioError, setPortfolioError] = useState("");
  const [activeRunId, setActiveRunId] = useState(auth.demo ? "MOD-1042" : "");
  const removeProject = (id:string) => {setRuns(current=>current.filter(run=>run.id!==id));if(activeRunId===id){setActiveRunId("");setAnalysis(null);}setView("projects");};
  useEffect(()=>{const close=(event:KeyboardEvent)=>{if(event.key==="Escape")setNotificationsOpen(false)};window.addEventListener("keydown",close);return()=>window.removeEventListener("keydown",close)},[]);

  useEffect(() => {
    if (isDemo) { setAnalysis(createDemoAnalysis()); setRuns([]); setPortfolioLoading(false); setPortfolioError(""); setActiveRunId("MOD-1042"); return; }
    setAnalysis(null); setPortfolioLoading(true); setPortfolioError(""); setActiveRunId("");
  }, [isDemo, authorizedFetch]);

  useEffect(()=>{
    if(isDemo)return;
    let active=true;let refreshing=false;
    const refresh=async()=>{
      if(refreshing)return;
      refreshing=true;
      try{
        const payload=await requestJson<{items:PortfolioRun[]}>(authorizedFetch,"/api/transformations",{cache:"no-store"},20000,"Portfolio refresh timed out. Displayed progress may be stale.");
        if(active){setRuns(payload.items||[]);setPortfolioError("");}
      }catch(error){if(active)setPortfolioError(error instanceof Error?error.message:"Unable to refresh the portfolio.");}
      finally{refreshing=false;if(active)setPortfolioLoading(false);}
    };
    void refresh();
    const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void refresh();},5000);
    const onFocus=()=>void refresh();
    window.addEventListener("focus",onFocus);
    return()=>{active=false;window.clearInterval(timer);window.removeEventListener("focus",onFocus);};
  },[isDemo,authorizedFetch,view]);

  const title = useMemo(() => ({
    overview: ["Modernization overview", "Monitor your portfolio and move every migration forward safely."],
    projects: ["Modernization projects", "Active plans, live progress, and behavior-parity controls."],
    repositories: ["Connected repositories", "Analyzed sources remain read-only until a plan is explicitly approved."],
    architecture: ["Architecture intelligence", "Compare the current architecture with the AI-recommended target."],
    team: ["Agent team", "Specialists, assigned work, generated proposals and recorded results."],
    execution: ["Transformation execution", "Track every agent action, file modification, test, and approval."],
    settings: ["Platform settings", "Configure Microsoft Foundry integration and organization policies."],
  }[view]), [view]);

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside id="workspace-sidebar" className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="brand">
          <div className="brand-mark"><Blocks size={21} /></div>
          <div><strong>Modernize<span>AI</span></strong><small>ENGINEERING INTELLIGENCE</small></div>
          <button className="mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close menu"><X size={18} /></button>
        </div>
        <nav className="nav-section">
          <span className="nav-caption">WORKSPACE</span>
          {navItems.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} title={item.label} aria-label={item.label} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); setSidebarOpen(false); }}><Icon size={18} /><span className="nav-label">{item.label}</span>{item.id === "projects" && <em>{auth.demo ? 3 : runs.length}</em>}</button>;
          })}
          <span className="nav-caption nav-separator">MANAGE</span>
          <button title="Settings" aria-label="Settings" className={view === "settings" ? "active" : ""} onClick={() => {setSettingsSection("foundry");setView("settings")}}><Settings size={18} /><span className="nav-label">Settings</span></button>
        </nav>
        <div className="foundry-card">
          <div className="foundry-icon"><Sparkles size={17} /></div>
          <div><strong>Microsoft Foundry</strong><span>{auth.demo ? "Demo environment" : "Production environment"}</span></div>
          <span className="status-dot" title="Healthy" />
        </div>
        <div className="user-card">
          <div className="avatar">{auth.account?.name?.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "DA"}</div>
          <div><strong>{auth.account?.name || "Demo Administrator"}</strong><span>{auth.demo ? "Demonstration workspace" : auth.account?.username || "Sign in required"}</span></div>
          <button className="identity-action" aria-label={auth.account ? "Sign out" : "Exit demo"} title={auth.account ? "Sign out" : "Exit demo"} onClick={() => void (auth.account ? auth.signOut() : auth.exitDemo())}><LogOut className="identity-icon" size={16}/><span>{auth.account ? "Sign out" : "Exit demo"}</span></button>
        </div>
      </aside>
      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />}

      <main className="main-content">
        <header className="topbar">
          <button className="desktop-sidebar-toggle" aria-label={sidebarCollapsed?"Expand sidebar":"Collapse sidebar"} title={sidebarCollapsed?"Expand sidebar":"Collapse sidebar"} aria-expanded={!sidebarCollapsed} aria-controls="workspace-sidebar" onClick={()=>setSidebarCollapsed(collapsed=>!collapsed)}>{sidebarCollapsed?<PanelLeftOpen size={19}/>:<PanelLeftClose size={19}/>}</button>
          <button className="menu-button" onClick={() => setSidebarOpen(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div className="top-search"><Search size={17} /><input placeholder="Search projects, repositories, findings…" /><kbd>⌘ K</kbd></div>
          <div className="top-actions"><div className={`demo-pill ${auth.demo ? "" : "live"}`}><CircleDot size={13} /> {auth.demo ? "DEMO MODE" : "LIVE MODE"}</div><div className="notifications-wrap"><button aria-label="Notifications" aria-expanded={notificationsOpen} onClick={()=>setNotificationsOpen(open=>!open)}><Bell size={18} />{!notificationsRead&&<i />}</button>{notificationsOpen&&<NotificationCenter demo={auth.demo} runs={runs} read={notificationsRead} onRead={()=>setNotificationsRead(true)} onSettings={()=>{setNotificationsOpen(false);setSettingsSection("notifications");setView("settings")}} onClose={()=>setNotificationsOpen(false)}/>}</div></div>
        </header>

        <div className="page-wrap">
          <section className="page-heading">
            <div><div className="eyebrow"><span>MODERNIZEAI</span><i />ENGINEERING CONTROL CENTER</div><h1>{title[0]}</h1><p>{title[1]}</p></div>
            <button className="primary-button" onClick={() => setWizardOpen(true)}><Plus size={17} /> New modernization</button>
          </section>

          {!isDemo&&["architecture","team","execution"].includes(view)&&runs.length>0&&<label className="project-context">Project<select aria-label="Selected project" value={activeRunId||runs[0].id} onChange={event=>{setActiveRunId(event.target.value);setAnalysis(null);}}>{runs.map(run=><option key={run.id} value={run.id}>{(run.repository||run.repository_url||run.id).replace("https://github.com/","")}</option>)}</select></label>}
          {view === "overview" && (auth.demo && analysis ? <Overview onOpenWizard={() => setWizardOpen(true)} onArchitecture={() => setView("architecture")} analysis={analysis} /> : <LiveOverview runs={runs} loading={portfolioLoading} error={portfolioError} onNew={() => setWizardOpen(true)} onOpen={(id) => { setActiveRunId(id); setView("execution"); }} />)}
          {view === "projects" && (auth.demo ? <Projects onOpenWizard={() => setWizardOpen(true)} onOpenRun={() => setView("execution")} /> : <LiveProjects runs={runs} loading={portfolioLoading} error={portfolioError} onNew={() => setWizardOpen(true)} onDeleted={removeProject} onOpen={(id) => { setActiveRunId(id); setView("execution"); }} />)}
          {view === "repositories" && <Repositories demo={auth.demo} />}
          {view === "architecture" && (!isDemo&&(activeRunId||runs[0]?.id)?<ProjectArchitecture key={activeRunId||runs[0].id} runId={activeRunId||runs[0].id}/>:analysis ? <Architecture analysis={analysis} runId={activeRunId} onChange={setAnalysis} /> : <LiveEmpty icon={Network} title="No architecture analysis yet" text="Start a modernization to inspect its proposed architecture." action="Start modernization" onAction={() => setWizardOpen(true)} />)}
          {(view === "execution"||view==="team") && ((activeRunId||runs[0]?.id) ? <TransformationWorkspace key={`${isDemo}-${activeRunId||runs[0].id}-${view}`} initialView={view==="team"?"history":"progress"} runId={activeRunId||runs[0].id} onBack={() => setView("projects")} onDeleted={()=>removeProject(activeRunId||runs[0].id)} /> : <LiveEmpty icon={Play} title="No transformation selected" text="Select a modernization project to inspect its team and execution." action="View modernizations" onAction={() => setView("projects")} />)}
          {view === "settings" && <PlatformSettings initialSection={settingsSection} />}
        </div>
      </main>
      {wizardOpen && <ModernizationWizard onClose={() => setWizardOpen(false)} onComplete={(result, runId) => { setAnalysis(result); if (runId) { setActiveRunId(runId); setRuns(current => [{ id:runId, repository:result.repository.name, targetBranch:"New modernization branch", status:"queued", progress:0 }, ...current]); } setWizardOpen(false); setView("execution"); }} />}
    </div>
  );
}

function Overview({ onOpenWizard, onArchitecture, analysis }: { onOpenWizard: () => void; onArchitecture: () => void; analysis: AnalysisResult }) {
  return <div className="content-stack fade-in">
    <section className="hero-card">
      <div className="hero-grid" />
      <div className="hero-copy"><div className="hero-badge"><Sparkles size={14} /> AI-POWERED MODERNIZATION</div><h2>Turn legacy complexity into<br /><span>modern momentum.</span></h2><p>Analyze architecture, preserve existing behavior, and deliver migration through controlled stages with Microsoft Foundry.</p><div className="hero-actions"><button className="light-button" onClick={onOpenWizard}>Start repository analysis <ArrowRight size={16} /></button><button className="ghost-button" onClick={onArchitecture}><Network size={16} /> Explore architecture</button></div></div>
      <div className="hero-orbit" aria-hidden="true"><div className="orbit orbit-one"/><div className="orbit orbit-two"/><div className="hero-core"><Bot size={31}/></div><span className="orbit-node n1"><Code2 size={16}/></span><span className="orbit-node n2"><Database size={16}/></span><span className="orbit-node n3"><Cloud size={16}/></span></div>
    </section>

    <section className="metric-grid">
      <Metric icon={Layers3} color="violet" label="Active modernizations" value="3" note="2 on track" trend="+1 this month" />
      <Metric icon={FileCode2} color="blue" label="Code analyzed" value="1.84M" note="lines of code" trend="+284K this week" />
      <Metric icon={ShieldCheck} color="green" label="Behavior parity" value="98.7%" note="across active projects" trend="↑ 2.4%" />
      <Metric icon={Gauge} color="amber" label="Tech debt reduced" value="34%" note="estimated portfolio" trend="126 issues closed" />
    </section>

    <section className="two-column">
      <div className="panel projects-panel"><PanelHeader title="Active modernizations" subtitle="Live status across your portfolio" action="View all" />
        <ProjectRow icon="OH" color="violet" title="OrderHub Modernization" repo="contoso/legacy-order-hub" phase="Backend extraction" progress={68} status="ON TRACK" />
        <ProjectRow icon="IP" color="blue" title="Inventory Portal" repo="contoso/inventory-web" phase="Validation & testing" progress={84} status="VALIDATING" />
        <ProjectRow icon="BS" color="amber" title="Billing Services" repo="contoso/billing-monolith" phase="Architecture analysis" progress={26} status="NEEDS REVIEW" />
      </div>
      <div className="panel activity-panel"><PanelHeader title="Recent activity" subtitle="Updates from your modernization agents" />
        <div className="activity-list">{activity.map((item) => <div className="activity-item" key={item.title}><span className={`activity-dot ${item.color}`} /><div><strong>{item.title}</strong><span>{item.meta}</span></div></div>)}</div>
        <button className="panel-footer">Open activity log <ArrowRight size={14} /></button>
      </div>
    </section>

    <section className="panel insight-panel"><div className="insight-heading"><div className="ai-symbol"><Sparkles size={20}/></div><div><span>FOUNDRY INSIGHT</span><h3>Highest-impact recommendation</h3></div></div><p>{analysis.recommendations[0]}</p><button onClick={onArchitecture}>Review recommendation <ArrowRight size={15}/></button></section>
  </div>;
}

function LiveOverview({ runs, loading, error, onNew, onOpen }: { runs:PortfolioRun[]; loading:boolean; error:string; onNew:()=>void; onOpen:(id:string)=>void }) {
  const active=runs.filter(run=>!["completed","pull-request-created","failed"].includes(run.status)).length;
  const completed=runs.filter(run=>run.status==="pull-request-created"||run.status==="completed").length;
  const average=runs.length?Math.round(runs.reduce((sum,run)=>sum+Number(run.progress||0),0)/runs.length):0;
  return <div className="content-stack fade-in"><section className="hero-card live-hero"><div className="hero-grid"/><div className="hero-copy"><div className="hero-badge"><ShieldCheck size={14}/> AUTHENTICATED WORKSPACE</div><h2>Your modernization<br/><span>control center.</span></h2><p>Only your organization&apos;s connected repositories, analyses, and transformation runs are shown here.</p><div className="hero-actions"><button className="light-button" onClick={onNew}>Start modernization <ArrowRight size={16}/></button></div></div></section>{error&&<div className="run-api-error"><X size={14}/>{error}</div>}<section className="metric-grid"><Metric icon={Layers3} color="violet" label="Active modernizations" value={loading?"—":String(active)} note="tenant-scoped runs" trend="Live data"/><Metric icon={CheckCircle2} color="green" label="Completed" value={loading?"—":String(completed)} note="pull requests created" trend="Live data"/><Metric icon={Gauge} color="blue" label="Average progress" value={loading?"—":`${average}%`} note="across real runs" trend="Live data"/><Metric icon={Github} color="amber" label="Connected source" value="GitHub" note="GitHub App installations" trend="Scoped access"/></section>{loading?<LiveLoading/>:runs.length?<div className="panel table-panel"><PanelHeader title="Your modernization runs" subtitle={`${runs.length} tenant-scoped run${runs.length===1?"":"s"}`}/>{runs.slice(0,5).map(run=><LiveRunRow key={run.id} run={run} onOpen={onOpen}/>)}</div>:<LiveEmpty icon={WandSparkles} title="Your workspace is ready" text="No modernization runs exist for your organization yet. Connect GitHub and start the first real analysis." action="Start first modernization" onAction={onNew}/>}</div>;
}

function LiveProjects({ runs, loading, error, onNew, onOpen, onDeleted }: { runs:PortfolioRun[]; loading:boolean; error:string; onNew:()=>void; onOpen:(id:string)=>void; onDeleted:(id:string)=>void }) {
  if(loading)return <LiveLoading/>;
  return <div className="content-stack fade-in">{error&&<div className="run-api-error"><X size={14}/>{error}</div>}{runs.length?<div className="panel table-panel"><PanelHeader title="Organization portfolio" subtitle={`${runs.length} real modernization run${runs.length===1?"":"s"}`}/>{runs.map(run=><div className="portfolio-run-actions" key={run.id}><LiveRunRow run={run} onOpen={onOpen}/><DeleteProjectButton id={run.id} repository={(run.repository||run.repository_url||"Repository").replace("https://github.com/","")} branch={run.targetBranch||run.target_branch||""} status={run.status} onDeleted={()=>onDeleted(run.id)}/></div>)}</div>:<LiveEmpty icon={Layers3} title="No modernizations yet" text="Create a transformation from a repository authorized through your GitHub App installation." action="New modernization" onAction={onNew}/>}</div>;
}

function LiveRunRow({run,onOpen}:{run:PortfolioRun;onOpen:(id:string)=>void}){
  const repository=(run.repository||run.repository_url||"Repository").replace("https://github.com/","");
  const branch=run.targetBranch||run.target_branch||"modernization branch";
  const stage=run.currentStage||run.current_stage||run.status;
  return <button className="live-run-row" onClick={()=>onOpen(run.id)}><div className="project-avatar violet"><GitBranch size={15}/></div><div><strong>{repository}</strong><span>{branch}</span></div><div><span>{stage.replace(/-/g," ")}</span><div className="progress"><i style={{width:`${run.progress||0}%`}}/></div></div><b>{run.status.replace(/-/g," ")}</b><strong>{run.progress||0}%</strong><ArrowRight size={14}/></button>;
}

function LiveLoading(){return <div className="panel live-loading"><RefreshCw className="spin" size={20}/><strong>Loading your workspace</strong><span>Retrieving tenant-scoped data…</span></div>}
function LiveEmpty({icon:Icon,title,text,action,onAction}:{icon:typeof Home;title:string;text:string;action:string;onAction:()=>void}){return <div className="panel live-empty"><div><Icon size={24}/></div><h3>{title}</h3><p>{text}</p><button className="primary-button" onClick={onAction}>{action}<ArrowRight size={14}/></button></div>}

function Metric({ icon: Icon, color, label, value, note, trend }: { icon: typeof Home; color: string; label: string; value: string; note: string; trend: string }) {
  return <div className="metric-card"><div className={`metric-icon ${color}`}><Icon size={19}/></div><span className="metric-label">{label}</span><strong>{value}</strong><small>{note}</small><div className={`metric-trend ${color}`}>{trend}</div></div>;
}

function PanelHeader({ title, subtitle, action }: { title: string; subtitle: string; action?: string }) {
  return <div className="panel-header"><div><h3>{title}</h3><p>{subtitle}</p></div>{action && <button>{action} <ArrowRight size={14}/></button>}</div>;
}

function ProjectRow({ icon, color, title, repo, phase, progress, status, onClick }: { icon: string; color: string; title: string; repo: string; phase: string; progress: number; status: string; onClick?: () => void }) {
  return <div className={`project-row ${onClick ? "clickable" : ""}`} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined}><div className={`project-avatar ${color}`}>{icon}</div><div className="project-info"><strong>{title}</strong><span><GitBranch size={12}/>{repo}</span></div><div className="phase"><span>{phase}</span><div className="progress"><i style={{ width: `${progress}%` }}/></div></div><b className={`status ${color}`}>{status}</b><strong className="progress-number">{progress}%</strong></div>;
}

function Projects({ onOpenWizard, onOpenRun }: { onOpenWizard: () => void; onOpenRun: () => void }) {
  return <div className="content-stack fade-in"><div className="panel table-panel"><PanelHeader title="Modernization portfolio" subtitle="3 active projects · select one to inspect every change" /><div className="project-table-head"><span>PROJECT</span><span>CURRENT PHASE</span><span>PROGRESS</span><span>QUALITY GATE</span></div><ProjectRow onClick={onOpenRun} icon="OH" color="violet" title="OrderHub Modernization" repo="contoso/legacy-order-hub" phase="Backend extraction" progress={68} status="ON TRACK"/><ProjectRow onClick={onOpenRun} icon="IP" color="blue" title="Inventory Portal" repo="contoso/inventory-web" phase="Validation & testing" progress={84} status="VALIDATING"/><ProjectRow onClick={onOpenRun} icon="BS" color="amber" title="Billing Services" repo="contoso/billing-monolith" phase="Architecture analysis" progress={26} status="NEEDS REVIEW"/></div><EmptyPrompt icon={WandSparkles} title="Modernize another application" text="Create a behavior-preserving modernization plan from any GitHub repository." action="Start modernization" onClick={onOpenWizard}/></div>;
}

function Repositories({demo}:{demo:boolean}) {
  const repos = [{ name: "legacy-order-hub", owner: "contoso", language: "C#", private: true, files: "1,248", scan: "18 min ago" },{ name: "inventory-web", owner: "contoso", language: "Java", private: true, files: "836", scan: "Yesterday" },{ name: "billing-monolith", owner: "contoso", language: "VB.NET", private: true, files: "2,104", scan: "2 days ago" }];
  return <div className="content-stack fade-in">{demo&&<div className="repo-grid">{repos.map((repo) => <div className="repo-card" key={repo.name}><div className="repo-top"><div className="repo-icon"><Github size={21}/></div><span className="connected"><CheckCircle2 size={13}/> DEMO</span></div><span className="repo-owner">{repo.owner} /</span><h3>{repo.name}</h3><div className="repo-meta"><span><CircleDot size={12}/>{repo.language}</span><span><FileCode2 size={12}/>{repo.files} files</span><span><LockKeyhole size={12}/>{repo.private ? "Private" : "Public"}</span></div><div className="repo-footer">Sample repository<span>Read only</span></div></div>)}</div>}<EmptyPrompt icon={Github} title={demo?"GitHub connection is disabled in demo":"Connect your GitHub account"} text={demo?"Exit demo and sign in to install the GitHub App on your account or organization.":"Choose your account or organization, then select exactly which repositories ModernizeAI may access."} action={demo?"Exit demo":"Install GitHub App"} onClick={() => { if(demo){window.location.reload();return;} window.location.href = `https://github.com/apps/${process.env.NEXT_PUBLIC_GITHUB_APP_SLUG || "modernizeai-khaled"}/installations/new`; }}/></div>;
}

function Architecture({ analysis,runId,onChange }: { analysis: AnalysisResult;runId:string;onChange:(analysis:AnalysisResult)=>void }) {
  const auth=useModernizeAuth();const[editing,setEditing]=useState(false);const[nodes,setNodes]=useState(analysis.targetArchitecture);const[saving,setSaving]=useState(false);const[saved,setSaved]=useState(false);const[error,setError]=useState("");
  useEffect(()=>setNodes(analysis.targetArchitecture),[analysis.targetArchitecture]);
  const save=async()=>{setSaving(true);setError("");try{if(!auth.demo&&runId){const response=await auth.authorizedFetch(`/api/transformations/${runId}/architecture`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nodes,connections:nodes.slice(1).map((node,index)=>({from:nodes[index].id,to:node.id})),rationale:"User-reviewed target architecture"})});const data=await response.json();if(!response.ok)throw new Error(data.error||"Architecture could not be saved.");}onChange({...analysis,targetArchitecture:nodes});setSaved(true);setEditing(false);window.setTimeout(()=>setSaved(false),2000);}catch(caught){setError(caught instanceof Error?caught.message:"Architecture could not be saved.");}finally{setSaving(false)}};
    return <div className="content-stack fade-in"><div className="architecture-summary"><div><span className={`mode-badge ${analysis.mode}`}>{analysis.mode === "demo" ? "DEMO ANALYSIS" : "LIVE FOUNDRY ANALYSIS"}</span><h2>{analysis.repository.name}</h2><p>{analysis.summary}</p></div><button className="architecture-edit" onClick={()=>setEditing(!editing)}><Pencil size={14}/>{editing?"Close designer":"Edit target architecture"}</button><div className="confidence-ring"><strong>{analysis.confidence}%</strong><span>AI confidence</span></div></div>{analysis.estimate&&<section className="panel estimate-card"><div className="estimate-heading"><div className="metric-icon violet"><Gauge size={19}/></div><div><span>AI-ADJUSTED DELIVERY ESTIMATE</span><h3>{analysis.estimate.optimisticDays}–{analysis.estimate.conservativeDays} working days</h3><p>Expected: {analysis.estimate.expectedDays} days · {analysis.estimate.confidence} confidence</p></div></div><div className="estimate-metrics"><div><strong>{analysis.estimate.aiGenerationHours}h</strong><span>Agent generation</span></div><div><strong>{analysis.estimate.verificationDays}d</strong><span>Validation & review</span></div><div><strong>{analysis.estimate.parallelAgents}</strong><span>Parallel agents</span></div></div><details><summary>Estimation assumptions</summary>{analysis.estimate.assumptions.map(item=><span key={item}><Check size={12}/>{item}</span>)}</details></section>}{saved&&<div className="settings-confirm"><CheckCircle2 size={14}/>Architecture revision saved</div>}{editing&&<div className="panel architecture-designer"><div className="panel-header"><div><h3>Target architecture designer</h3><p>Edit components, technology details, and architectural roles. A new revision is recorded on save.</p></div><button onClick={()=>setNodes([...nodes,{id:`custom-${Date.now()}`,label:"New component",detail:"Technology or responsibility",kind:"service"}])}><Plus size={14}/>Add component</button></div><div className="architecture-node-editor">{nodes.map((node,index)=><div key={node.id}><select value={node.kind} onChange={event=>setNodes(nodes.map((item,i)=>i===index?{...item,kind:event.target.value as typeof node.kind}:item))}><option value="client">Client</option><option value="service">Service</option><option value="data">Data</option><option value="integration">Integration</option><option value="cloud">Cloud</option></select><input value={node.label} onChange={event=>setNodes(nodes.map((item,i)=>i===index?{...item,label:event.target.value}:item))}/><input value={node.detail} onChange={event=>setNodes(nodes.map((item,i)=>i===index?{...item,detail:event.target.value}:item))}/><button aria-label={`Remove ${node.label}`} onClick={()=>setNodes(nodes.filter((_,i)=>i!==index))}><X size={14}/></button></div>)}</div>{error&&<div className="error-note">{error}</div>}<div className="designer-actions"><button className="secondary-button" onClick={()=>{setNodes(analysis.targetArchitecture);setEditing(false)}}>Cancel</button><button className="primary-button" onClick={()=>void save()} disabled={saving||!nodes.length}><Save size={14}/>{saving?"Saving…":"Save architecture revision"}</button></div></div>}<div className="architecture-compare"><div className="panel architecture-panel"><div className="architecture-title"><div><span>CURRENT STATE</span><h3>Legacy architecture</h3></div><b className="risk-badge">HIGH COUPLING</b></div><ArchitectureMap nodes={analysis.currentArchitecture} variant="current" /></div><div className="compare-arrow"><ArrowRight size={20}/></div><div className="panel architecture-panel recommended"><div className="architecture-title"><div><span>RECOMMENDED STATE</span><h3>Target architecture</h3></div><b className="target-badge"><Sparkles size={12}/> {editing?"USER EDITING":"AI PROPOSED"}</b></div><ArchitectureMap nodes={editing?nodes:analysis.targetArchitecture} variant="target" /></div></div><div className="two-column architecture-bottom"><div className="panel"><PanelHeader title="Technical findings" subtitle={`${analysis.findings.length} prioritized risks detected`} /><div className="finding-list">{analysis.findings.map((finding) => <div className="finding" key={finding.title}><span className={`severity ${finding.severity}`}>{finding.severity}</span><div><strong>{finding.title}</strong><p>{finding.detail}</p>{finding.file && <code>{finding.file}</code>}</div></div>)}</div></div><div className="panel"><PanelHeader title="Migration roadmap" subtitle="Incremental, reversible and measurable"/><div className="roadmap">{analysis.migrationPhases.map((phase, index) => <div className="roadmap-step" key={phase.title}><b>{index + 1}</b><div><strong>{phase.title}</strong><p>{phase.description}</p><span>{phase.duration}</span></div></div>)}</div></div></div><div className="panel behavior-panel"><div><TestTube2 size={22}/><div><h3>Behavior preservation gate</h3><p>The modernization cannot advance unless every required contract passes.</p></div></div><div className="contract-list">{analysis.behaviorContracts.map((contract) => <span key={contract}><Check size={14}/>{contract}</span>)}</div></div></div>;
}

function PlatformSettings({initialSection="foundry"}:{initialSection?:"foundry"|"notifications"}) {
  const auth = useModernizeAuth();
  const authorizedFetch=auth.authorizedFetch;
  const [section, setSection] = useState<"foundry"|"github"|"policies"|"notifications">(initialSection);
  useEffect(()=>setSection(initialSection),[initialSection]);
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [policies, setPolicies] = useState({ behavior: true, approval: true, security: true, directPush: false });
  const [notifications, setNotifications] = useState({ failures: true, approvals: true, completed: true, digest: false });
  const [foundryModel,setFoundryModel]=useState("Loading configured deployment…");
  useEffect(()=>{ authorizedFetch("/api/settings",{cache:"no-store"}).then(async response=>{if(!response.ok)return;const data=await response.json();if(data.policies)setPolicies(data.policies);if(data.notifications)setNotifications(data.notifications);if(data.runtime?.model)setFoundryModel(data.runtime.model);}).catch(()=>{}); },[authorizedFetch]);
  const save = async (target:"policies"|"notifications") => { setSettingsError(""); const response=await authorizedFetch("/api/settings",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({section:target,values:target==="policies"?policies:notifications})}); if(!response.ok){const data=await response.json();setSettingsError(data.error||"Settings could not be saved.");return;} setSaved(true); window.setTimeout(() => setSaved(false), 2200); };
  const check = async () => { setChecking(true); try { await fetch("/api/health", { cache: "no-store" }); } finally { window.setTimeout(() => setChecking(false), 500); } };
  const sections = [{id:"foundry" as const,label:"AI & Microsoft Foundry",icon:Sparkles},{id:"github" as const,label:"GitHub integration",icon:Github},{id:"policies" as const,label:"Policies & quality gates",icon:ShieldCheck},{id:"notifications" as const,label:"Notifications",icon:Bell}];
  return <div className="settings-grid fade-in"><div className="panel settings-nav">{sections.map((item)=><button key={item.id} className={section===item.id?"active":""} onClick={()=>setSection(item.id)}><item.icon size={16}/>{item.label}</button>)}</div><div className="panel settings-form">
    {section==="foundry"&&<><SettingsTitle icon={Sparkles} title="Microsoft Foundry connection" text="Live model inference configuration and service readiness." badge={auth.demo?"DEMO":"CONNECTED"}/><div className="settings-status"><span><i className="healthy"/>Model endpoint</span><strong>{auth.demo?"Demo simulation":"Connected securely"}</strong></div><label>Deployment / model<input value={auth.demo?"Demo modernization model":foundryModel} readOnly/></label><label>Authentication<input value={auth.demo?"Demonstration data":"Server-side credential / managed identity"} readOnly/></label><div className="setting-row"><div><strong>Service health</strong><p>Verify model, database, and runtime readiness now.</p></div><button className="settings-action" onClick={()=>void check()} disabled={checking}><RefreshCw className={checking?"spin":""} size={14}/>{checking?"Checking…":"Run check"}</button></div><div className="security-note"><ShieldCheck size={18}/><p>Credentials remain server-side and are never included in the browser bundle.</p></div></>}
    {section==="github"&&<><SettingsTitle icon={Github} title="GitHub App integration" text="Users install the public app on their own account or organization." badge={auth.demo?"DEMO":"AVAILABLE"}/><div className="integration-card"><div className="repo-icon"><Github size={21}/></div><div><strong>ModernizeAI GitHub App</strong><p>Contents and pull requests · selected repositories only · short-lived tokens</p></div><span className="connected"><CheckCircle2 size={13}/> READY</span></div><button className="connect-github" onClick={()=>{window.location.href=`https://github.com/apps/${process.env.NEXT_PUBLIC_GITHUB_APP_SLUG||"modernizeai-khaled"}/installations/new`;}}><Github size={16}/>Install or configure GitHub App<ExternalLink size={14}/></button><div className="security-note"><LockKeyhole size={18}/><p>Each user chooses the account, organization, and exact repositories ModernizeAI may access.</p></div></>}
    {section==="policies"&&<><SettingsTitle icon={ShieldCheck} title="Policies & quality gates" text="Organization guardrails applied to every modernization run." badge="ENFORCED"/><PolicyToggle title="Behavior parity required" text="Block publishing below the required parity threshold." checked={policies.behavior} onChange={()=>setPolicies({...policies,behavior:!policies.behavior})}/><PolicyToggle title="Independent human approval" text="Require an approver before branch and pull-request creation." checked={policies.approval} onChange={()=>setPolicies({...policies,approval:!policies.approval})}/><PolicyToggle title="Security scans required" text="Block critical SAST, secret, and dependency findings." checked={policies.security} onChange={()=>setPolicies({...policies,security:!policies.security})}/><PolicyToggle title="Allow direct push to default branch" text="Prohibited. ModernizeAI always uses a new branch in the selected repository." checked={policies.directPush} onChange={()=>setPolicies({...policies,directPush:!policies.directPush})}/>{settingsError&&<div className="error-note">{settingsError}</div>}<SaveBar saved={saved} onSave={()=>void save("policies")}/></>}
    {section==="notifications"&&<><SettingsTitle icon={Bell} title="Notification preferences" text="Choose the operational events that require your attention." badge="PERSONAL"/><PolicyToggle title="Transformation failures" text="Notify when workers exhaust retries or a quality gate fails." checked={notifications.failures} onChange={()=>setNotifications({...notifications,failures:!notifications.failures})}/><PolicyToggle title="Approval requests" text="Notify when a changeset is ready for human review." checked={notifications.approvals} onChange={()=>setNotifications({...notifications,approvals:!notifications.approvals})}/><PolicyToggle title="Completed pull requests" text="Notify when a draft pull request is created successfully." checked={notifications.completed} onChange={()=>setNotifications({...notifications,completed:!notifications.completed})}/><PolicyToggle title="Weekly modernization digest" text="Receive a weekly portfolio progress summary." checked={notifications.digest} onChange={()=>setNotifications({...notifications,digest:!notifications.digest})}/>{settingsError&&<div className="error-note">{settingsError}</div>}<SaveBar saved={saved} onSave={()=>void save("notifications")}/></>}
  </div></div>;
}

function SettingsTitle({icon:Icon,title,text,badge}:{icon:typeof Home;title:string;text:string;badge:string}){return <div className="settings-heading"><div className="foundry-logo"><Icon size={22}/></div><div><h3>{title}</h3><p>{text}</p></div><span className="settings-badge"><CircleDot size={12}/>{badge}</span></div>}
function PolicyToggle({title,text,checked,onChange}:{title:string;text:string;checked:boolean;onChange:()=>void}){return <div className="setting-row"><div><strong>{title}</strong><p>{text}</p></div><button className={`toggle ${checked?"active":""}`} onClick={onChange} role="switch" aria-checked={checked}><i/></button></div>}
function SaveBar({saved,onSave}:{saved:boolean;onSave:()=>void}){return <div className="settings-save"><span>{saved?<><CheckCircle2 size={14}/>Settings saved</>:"Changes apply to new modernization runs."}</span><button onClick={onSave}><Save size={14}/>Save changes</button></div>}

function EmptyPrompt({ icon: Icon, title, text, action, onClick }: { icon: typeof Home; title: string; text: string; action: string; onClick: () => void }) {
  return <div className="empty-prompt"><div><Icon size={21}/></div><h3>{title}</h3><p>{text}</p><button onClick={onClick}><Plus size={15}/>{action}</button></div>;
}

function NotificationCenter({demo,runs,read,onRead,onSettings,onClose}:{demo:boolean;runs:PortfolioRun[];read:boolean;onRead:()=>void;onSettings:()=>void;onClose:()=>void}){
  const items=demo?activity.slice(0,3).map(item=>({title:item.title,detail:item.meta})):runs.slice(0,5).map(run=>({title:`${String(run.repository_url||run.repository||"Modernization").replace("https://github.com/","")} · ${run.status}`,detail:`${String(run.current_stage||run.currentStage||"Queued").replaceAll("-"," ")} · ${run.progress}%`}));
  return <><button className="notifications-backdrop" aria-label="Close notifications" onClick={onClose}/><section className="notifications-panel" aria-label="Notification center"><header><div><strong>Notifications</strong><span>{read?"All caught up":`${Math.max(1,items.length)} unread`}</span></div><button onClick={onClose} aria-label="Close notification center"><X size={16}/></button></header><div className="notification-list">{items.length?items.map((item,index)=><article key={`${item.title}-${index}`} className={read?"read":""}><i/><div><strong>{item.title}</strong><span>{item.detail}</span></div></article>):<div className="notifications-empty"><Bell size={20}/><strong>No operational notifications</strong><span>Run failures, approvals, and completed pull requests will appear here.</span></div>}</div><footer><button onClick={onRead} disabled={read}><CheckCheck size={14}/>Mark all as read</button><button onClick={onSettings}><Settings size={14}/>Notification settings</button></footer></section></>;
}

// Wizard implementation follows in a separate section to keep the dashboard views focused.
const aiCapabilityCatalog=[
  {id:"Support copilot",icon:Bot,description:"An in-app assistant grounded in application and business context.",frontend:"Chat panel, citations, feedback, conversation history",backend:"Prompt orchestration, authorization, tool execution, audit",platform:"Foundry model + optional Azure AI Search"},
  {id:"Semantic search / RAG",icon:Search,description:"Natural-language search across approved application and business content.",frontend:"Search experience, filters, ranked results, source previews",backend:"Ingestion pipeline, chunking, retrieval, access trimming",platform:"Azure AI Search vector and semantic indexes"},
  {id:"Document intelligence",icon:FileCode2,description:"Extract, classify, validate, and route information from uploaded documents.",frontend:"Upload queue, extraction review, corrections, confidence UI",backend:"Document processing workflow, schemas, validation, storage",platform:"Azure AI Document Intelligence + Blob Storage"},
  {id:"Predictive insights",icon:Gauge,description:"Forecast trends and surface explainable risk or opportunity signals.",frontend:"Insight cards, trends, confidence, explanations, drill-downs",backend:"Feature pipeline, scoring API, monitoring, feedback loop",platform:"Foundry model endpoint + operational telemetry"},
] as const;

function getAzureServices(scope:string,cloudReady:boolean,aiFeatures:string[],customCapabilities:Array<{design:unknown}>){
  const services:string[]=[];
  if(cloudReady){
    services.push(scope==="frontend"?"Azure Container Apps (web)":scope==="backend"?"Azure Container Apps (APIs and workers)":"Azure Container Apps (web, APIs and workers)","Azure Container Registry","Azure Key Vault","Managed Identity","Application Insights","Log Analytics");
    if(scope!=="frontend")services.push("Azure API Management");
  }
  if(scope!=="frontend"&&(aiFeatures.length||customCapabilities.length))services.push("Microsoft Foundry Models");
  if(scope!=="frontend"&&(aiFeatures.includes("Support copilot")||aiFeatures.includes("Semantic search / RAG")))services.push("Azure AI Search");
  if(scope!=="frontend"&&(aiFeatures.includes("Semantic search / RAG")||aiFeatures.includes("Document intelligence")))services.push("Azure Blob Storage");
  if(scope!=="frontend"&&aiFeatures.includes("Document intelligence"))services.push("Azure AI Document Intelligence","Azure Service Bus");
  const customDesign=JSON.stringify(customCapabilities.map(capability=>capability.design)).toLowerCase();
  if(scope!=="frontend"&&customDesign.includes("search"))services.push("Azure AI Search");
  if(scope!=="frontend"&&(customDesign.includes("blob")||customDesign.includes("storage")))services.push("Azure Blob Storage");
  if(scope!=="frontend"&&customDesign.includes("document intelligence"))services.push("Azure AI Document Intelligence");
  if(scope!=="frontend"&&customDesign.includes("service bus"))services.push("Azure Service Bus");
  return [...new Set(services)];
}

function ModernizationWizard({ onClose, onComplete }: { onClose: () => void; onComplete: (result: AnalysisResult, runId?: string) => void }) {
  const { authorizedFetch } = useModernizeAuth();
  const [step, setStep] = useState(1); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const [launchPhase, setLaunchPhase] = useState<"analysis" | "queueing">("analysis");
  const [launchElapsed, setLaunchElapsed] = useState(0);
  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    setLaunchElapsed(0);
    const timer = window.setInterval(() => setLaunchElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [loading, launchPhase]);
  const [recommendation,setRecommendation]=useState<StackRecommendation|null>(null);const[recommending,setRecommending]=useState(false);
  const [form, setForm] = useState({ url: "", sourceBranch:"main", branch: `modernize/${Date.now()}-fullstack`, scope: "fullstack", frontend: "Next.js 15 + TypeScript", backend: "Node.js + NestJS", cloud: true, ai: [] as string[], customCapabilities:[] as Array<{name:string;description:string;design:unknown}>, preserve: true });
    const update = (patch: Partial<typeof form>) => {if(patch.scope||patch.url||patch.sourceBranch)setRecommendation(null);setForm((current) => ({ ...current, ...patch }));};
  useEffect(()=>setForm(current=>{const branch=/^modernize\/\d+-(frontend|backend|fullstack)$/.test(current.branch)?current.branch.replace(/(frontend|backend|fullstack)$/,current.scope):current.branch;return branch===current.branch?current:{...current,branch};}),[form.scope]);
  async function analyzeRepository(){
    if(recommending)return;setRecommending(true);setError("");
    try{
      const result=await requestJson<StackRecommendation>(authorizedFetch,"/api/repositories/recommend",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:form.url,branch:form.sourceBranch,scope:form.scope})},190000,"Repository recommendation timed out. No run was created.");
      setRecommendation({...result,scope:form.scope as StackRecommendation["scope"]});
      setForm(current=>({...current,...(current.scope!=="backend"?{frontend:result.frontendTarget}:{}),...(current.scope!=="frontend"?{backend:result.backendTarget}:{})}));
      setStep(2);
    }catch(caught){setError(caught instanceof Error?caught.message:"AI recommendation failed.");}finally{setRecommending(false);}
  }
  const activeCustomCapabilities=form.scope==="fullstack"?form.customCapabilities:[];
  const azureServices=getAzureServices(form.scope,form.cloud,form.ai,activeCustomCapabilities);
  async function launch() {
    if (loading) return;
    setLoading(true);
    setLaunchPhase("analysis");
    setError("");
    let queueing = false;
    try {
      const options = { scope: form.scope, ...(form.scope!=="backend"?{frontendTarget:form.frontend}:{}), ...(form.scope!=="frontend"?{backendTarget:form.backend}:{}), cloudReady: form.cloud, cloudOptions: azureServices, aiFeatures: [...form.ai, ...activeCustomCapabilities.map((capability) => capability.name)], customCapabilities: activeCustomCapabilities, preserveBehavior: form.preserve };
      const payload = await requestJson<AnalysisResult>(authorizedFetch, "/api/analysis", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repository: { url: form.url, branch: form.sourceBranch }, options }),
      }, 190_000, "Architecture analysis timed out. No modernization run was queued. Your selections are unchanged; retry the analysis.");
      queueing = true;
      setLaunchPhase("queueing");
      const runPayload = await requestJson<{ id: string }>(authorizedFetch, "/api/transformations", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl: form.url, sourceBranch: form.sourceBranch, targetBranch: form.branch, scope: form.scope, options, ...(payload.mode==="live"?{analysisSnapshot:payload}:{}) }),
      }, 45_000, "The server did not confirm whether the modernization was queued.");
      if (!runPayload?.id) throw new Error("The server did not return a modernization run ID.");
      onComplete(payload, runPayload.id);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Analysis failed.";
      setError(queueing ? `${message} Check Modernizations before retrying; the run may already exist.` : message);
    } finally {
      setLoading(false);
    }
  }
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="New modernization wizard"><div className="wizard"><div className="wizard-head"><div><span>NEW MODERNIZATION</span><h2>Build a safe transformation plan</h2></div><button onClick={onClose} disabled={loading} aria-label="Close"><X size={20}/></button></div><div className="wizard-body"><div className="wizard-steps">{["Repository", "Scope & target", "Cloud & AI", "Review"].map((label, index) => <div key={label} className={`${step === index + 1 ? "active" : ""} ${step > index + 1 ? "done" : ""}`}><b>{step > index + 1 ? <Check size={14}/> : index + 1}</b><span>{label}</span></div>)}</div><div className="wizard-content">
    {step === 1 && <div className="form-step"><div className="step-icon"><Github size={21}/></div><h3>Repository and scope</h3><label>Repository URL<input disabled={recommending} value={form.url} onChange={(event) => update({ url: event.target.value })} placeholder="https://github.com/owner/repository"/></label><label>Source branch<input disabled={recommending} value={form.sourceBranch} onChange={(event)=>update({sourceBranch:event.target.value})} placeholder="main"/></label><fieldset className="scope-choice"><legend>Modernization scope</legend>{[{id:"frontend",label:"Frontend",detail:"UI changes; existing services retained"},{id:"backend",label:"Backend",detail:"Services and data; existing UI retained"},{id:"fullstack",label:"Full app",detail:"UI, services and their integration"}].map(option=><label key={option.id}><input type="radio" name="modernization-scope" value={option.id} disabled={recommending} checked={form.scope===option.id} onChange={()=>update({scope:option.id})}/><span><strong>{option.label}</strong><small>{option.detail}</small></span></label>)}</fieldset><label>New modernization branch<input disabled={recommending} value={form.branch} onChange={(event)=>update({branch:event.target.value})} placeholder="modernize/my-modernization"/></label>{recommending&&<p role="status"><LoaderCircle className="spin" size={15}/>Reading repository evidence and preparing {form.scope==="fullstack"?"full app":form.scope} recommendations...</p>}{error&&<div className="error-note" role="alert">{error}</div>}</div>}
    {step === 2 && <div className="form-step"><h3>Targets for {form.scope==="fullstack"?"the full app":form.scope}</h3>{recommendation&&<div className="ai-recommendation"><strong>{recommendation.source==="foundry"?"AI recommendation":"Repository evidence recommendation"}</strong>{recommendation.warning&&<p>{recommendation.warning}</p>}<ul>{recommendation.rationale.map(item=><li key={item}>{item}</li>)}</ul>{recommendation.verificationReadiness&&<section aria-label="Verification prerequisites"><strong>Python/npm verification available</strong>{recommendation.verificationReadiness.warnings.map((item,index)=><p key={`${item.code}-${index}`}>{item.path?`${item.path}: `:""}{item.message}</p>)}</section>}{recommendation.risks.length>0&&<details><summary>Compatibility risks</summary>{recommendation.risks.map(item=><p key={item}>{item}</p>)}</details>}{recommendation.evidence&&<DependencyEvidence evidence={recommendation.evidence}/>}</div>}{form.scope!=="backend"&&<label>Frontend target<select value={form.frontend} onChange={event=>update({frontend:event.target.value})}>{["Next.js 15 + TypeScript","React 19 + TypeScript","Angular 19","Vue 3 + TypeScript"].map(value=><option key={value}>{value}</option>)}</select></label>}{form.scope!=="frontend"&&<label>Backend target<select value={form.backend} onChange={event=>update({backend:event.target.value})}>{["Node.js + NestJS","Python + FastAPI"].map(value=><option key={value}>{value}</option>)}</select></label>}<button className="secondary-button" onClick={()=>setStep(1)}>Change repository or scope</button></div>}
    {step === 3 && <div className="form-step capabilities-step">
      <div className="step-icon"><Cloud size={21}/></div>
      <h3>Make the application future-ready</h3>
      <p>Cloud and AI work follows the modernization boundary selected in the previous step. Nothing outside that boundary is generated implicitly.</p>
      <button className={`wide-option ${form.cloud ? "selected" : ""}`} onClick={() => update({ cloud: !form.cloud })}><Cloud size={20}/><div><strong>Cloud-ready on Azure</strong><span>Secure hosting, identity, observability, deployment, and operational readiness</span></div><span className={`switch ${form.cloud ? "on" : ""}`}><i/></span></button>
      {form.cloud&&<div className="azure-service-preview"><strong>Azure adaptation plan</strong><div>{getAzureServices(form.scope,true,[],[]).map(service=><span key={service}>{service}</span>)}</div></div>}
      <div className="feature-title">{form.scope==="fullstack"?"OPTIONAL AI CAPABILITIES · END-TO-END IMPLEMENTATION":form.scope==="frontend"?"OPTIONAL AI CAPABILITIES · EXPERIENCE INTEGRATION":"OPTIONAL AI CAPABILITIES · SERVICE IMPLEMENTATION"}</div>
      <div className="scope-capability-note"><Info size={15}/><span>{form.scope==="fullstack"?"Includes frontend experiences, backend orchestration, data, Azure services, security, and independent testing.":form.scope==="frontend"?"Adds accessible AI user experiences that integrate with existing approved APIs. New backend orchestration and data pipelines remain out of scope.":"Adds secured AI orchestration, data pipelines, and Azure services. New user-interface work remains out of scope."}</span></div>
      <div className="capability-grid">{aiCapabilityCatalog.map((feature) => { const checked = form.ai.includes(feature.id); const Icon=feature.icon; return <button key={feature.id} className={checked ? "selected" : ""} onClick={() => update({ ai: checked ? form.ai.filter((x) => x !== feature.id) : [...form.ai, feature.id] })}><div className="capability-head"><div><Icon size={17}/><strong>{feature.id}</strong></div><span>{checked&&<Check size={13}/>}</span></div><p>{feature.description}</p><dl>{form.scope!=="backend"&&<div><dt>USER EXPERIENCE</dt><dd>{feature.frontend}</dd></div>}{form.scope!=="frontend"&&<div><dt>BACKEND & DATA</dt><dd>{feature.backend}</dd></div>}{form.scope!=="frontend"&&<div><dt>AZURE SERVICES</dt><dd>{feature.platform}</dd></div>}</dl></button>; })}</div>
      {form.ai.length>0&&<div className="capability-impact"><Sparkles size={15}/><div><strong>{form.scope==="fullstack"?"End-to-end implementation impact":form.scope==="frontend"?"Frontend-only implementation impact":"Backend-only implementation impact"}</strong><p>{form.ai.length} selected {form.ai.length===1?"capability":"capabilities"} will be constrained to the {form.scope==="fullstack"?"frontend, backend, cloud, security, and testing agents":form.scope==="frontend"?"Frontend and Testing agents, using existing approved APIs":"Backend, Cloud, Security, and Testing agents"}. Existing behavior remains protected by the same quality gates.</p></div></div>}
      {form.scope==="fullstack"?<CustomCapabilityDesigner authorizedFetch={authorizedFetch} repository={form.url} onAdd={(capability)=>update({customCapabilities:[...form.customCapabilities,capability]})}/>:<div className="custom-capability-scope-note"><Layers3 size={16}/><div><strong>Custom capability design is available for full-stack plans</strong><span>Switch to Full stack when the AI should design a new experience, orchestration, data lifecycle, Azure resources, and tests together.</span></div><button onClick={()=>update({scope:"fullstack"})}>Switch to Full stack</button></div>}
      {form.scope==="fullstack"&&form.customCapabilities.length>0&&<div className="custom-capability-list"><span>CUSTOM CAPABILITIES ADDED</span>{form.customCapabilities.map((capability,index)=><div key={`${capability.name}-${index}`}><div><Sparkles size={14}/><span><strong>{capability.name}</strong><small>{capability.description}</small></span></div><button aria-label={`Remove ${capability.name}`} onClick={()=>update({customCapabilities:form.customCapabilities.filter((_,itemIndex)=>itemIndex!==index)})}><X size={13}/></button></div>)}</div>}
    </div>}
    {step === 4 && <div className="form-step review-step"><div className="step-icon"><ShieldCheck size={21}/></div><h3>Review the complete modernization plan</h3><p>Confirm the delivery boundary, target stack, Azure resources, AI capabilities, and mandatory quality gates before any work is queued.</p><div className="review-card"><ReviewRow label="Repository" value={form.url.replace("https://github.com/", "")}/><ReviewRow label="Source branch" value={form.sourceBranch}/><ReviewRow label="New branch" value={form.branch}/><ReviewRow label="Scope" value={form.scope === "fullstack" ? "Frontend + backend" : form.scope === "frontend" ? "Frontend only" : "Backend only"}/><ReviewRow label="Target" value={[form.scope !== "backend" && form.frontend, form.scope !== "frontend" && form.backend].filter(Boolean).join(" · ")}/><ReviewRow label="Cloud readiness" value={form.cloud ? `Enabled · ${azureServices.length} Azure services` : azureServices.length ? "Application hosting unchanged · AI platform services required" : "No Azure adaptation"}/><ReviewList label="Azure services" values={azureServices}/><ReviewList label="AI capabilities" values={[...form.ai,...activeCustomCapabilities.map(capability=>capability.name)]}/><ReviewRow label="AI delivery boundary" value={form.ai.length||activeCustomCapabilities.length?form.scope==="fullstack"?"End-to-end experience, services, data, cloud and tests":form.scope==="frontend"?"Experience integration using existing approved APIs":"Services, data, cloud and tests; no new UI":"No AI capabilities selected"}/></div><label className="preserve-check"><input type="checkbox" checked={form.preserve} onChange={(event) => update({ preserve: event.target.checked })}/><span><strong>Preserve all existing behavior</strong><small>Require characterization, contract and regression tests before generated changes can advance.</small></span></label>{error && <div className="error-note">{error}</div>}</div>}
    {loading && <div className="repository-analysis-progress" role="status" aria-live="polite"><div className="analysis-progress-head"><div><LoaderCircle className="spin" size={15}/><strong>{launchPhase === "analysis" ? "Waiting for architecture analysis" : "Creating modernization run"}</strong></div><b aria-live="off">{launchElapsed}s</b></div><p>{launchPhase === "analysis" ? "Reading repository evidence and requesting a Microsoft Foundry analysis. No modernization run has been queued yet." : "Architecture analysis received. Waiting for the server to confirm the queued run."}</p><span>{launchPhase === "analysis" ? "This request is limited to 190 seconds." : "Confirmation is limited to 45 seconds. Do not submit another run while waiting."}</span></div>}
  </div></div><div className="wizard-footer"><button className="secondary-button" disabled={loading} onClick={step === 1 ? onClose : () => setStep((value) => value - 1)}>{step === 1 ? "Cancel" : "Back"}</button><span>Step {step} of 4</span>{step < 4 ? <button className="primary-button" disabled={recommending || !form.url || !form.sourceBranch || !form.branch} onClick={step === 1 ? analyzeRepository : () => setStep((value) => value + 1)}>{step === 1 ? recommending ? <><span className="spinner"/>Analyzing repository…</> : <>Analyze &amp; recommend <Sparkles size={15}/></> : <>Continue <ArrowRight size={15}/></>}</button> : <button className="primary-button" disabled={!form.preserve || loading} onClick={launch}>{loading ? <><span className="spinner"/>{launchPhase === "analysis" ? "Analyzing architecture…" : "Queueing modernization…"}</> : <><Play size={15}/>Launch analysis</>}</button>}</div></div></div>;
}

function ReviewRow({ label, value }: { label: string; value: string }) { return <div><span>{label}</span><strong>{value}</strong></div>; }
function ReviewList({label,values}:{label:string;values:string[]}){return <div className="review-list"><span>{label}</span><div>{values.length?values.map(value=><i key={value}>{value}</i>):<strong>None</strong>}</div></div>}
