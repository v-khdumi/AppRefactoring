import { createHash } from "node:crypto";
import { z } from "zod";
import { auditFindingsRecorded, blockedRuntimeReasons, ecosystemAuditCommands, ecosystemUnits, ecosystemVerificationCommands, nodeManager, nodeVerificationCommands, pythonUnits,nativeDependencyBlocker } from "./verification-ecosystems";
import {scenarioAcceptance,scenarioCommand,type AcceptanceManifest} from "./modernization-scenarios";
import {isImmutableOriginalTest,ignoredManifestPath} from "./verification-ecosystems";
import {safeRepositoryPath} from "./repository-path";

export const verificationReportSchema = z.object({
  status:z.enum(["passed","failed","unsupported"]),
  reason:z.string().max(2000),
  steps:z.array(z.object({
    variant:z.enum(["baseline","candidate"]),project:z.string().max(500),command:z.string().max(500),
    exitCode:z.number().int().nullable(),timedOut:z.boolean(),log:z.string().max(32000),durationMs:z.number().nonnegative(),
    tests:z.object({tests:z.number().int().nonnegative(),failed:z.number().int().nonnegative(),skipped:z.number().int().nonnegative()}).optional(),
  })).max(256),
});
export type VerificationReport = z.infer<typeof verificationReportSchema>;
export type VerificationChange = {path:string;oldPath?:string|null;operation:string;content:string};

export const npmVerificationCommands=nodeVerificationCommands.npm;
export const candidateSecurityCommand="candidate static and credential scan (Semgrep 1.183.0; local rules)";
export const pythonVerificationCommands=[
  "python3 -m venv .verification-venv",
  ".verification-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: --upgrade pip setuptools -r requirements.txt",
  ".verification-venv/bin/python -m compileall -q -x /[.]verification-venv/ .",
  "xvfb-run Python unittest discovery (tests/test_*.py; nonempty; no skips)",
  "pip-audit --path .verification-venv/lib/python3.11/site-packages --format json",
];
export const pythonTestDependenciesCommand=".verification-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: -c requirements.txt -r requirements-dev.txt";
export const managedPythonVerificationCommands={
  poetry:[pythonVerificationCommands[0],"poetry sync (locked; all groups; no root)",...pythonVerificationCommands.slice(2)],
  uv:[pythonVerificationCommands[0],"uv sync --frozen --all-groups --no-install-project",...pythonVerificationCommands.slice(2)],
  pipenv:["python3 -m venv .venv","pipenv sync --dev (locked)",".venv/bin/python -m compileall -q -x /[.]venv/ .",pythonVerificationCommands[3],"pip-audit --path .venv/lib/python3.11/site-packages --format json"],
};
const testCommands=new Set([pythonVerificationCommands[3],...Object.values(nodeVerificationCommands).map(commands=>commands[2]),...Object.values(ecosystemVerificationCommands).map(commands=>commands.find(command=>/nonempty/.test(command))!)]);
const pythonAuditCommands=new Set([pythonVerificationCommands[4],managedPythonVerificationCommands.pipenv[4]]);
const cobolManifestSchema=z.object({
  version:z.literal(1),
  programs:z.array(z.object({name:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),sources:z.array(z.string().refine(safeRepositoryPath)).min(1).max(100),format:z.enum(["fixed","free"]).optional()}).strict()).min(1).max(8),
  tests:z.array(z.object({name:z.string().min(1),program:z.string(),stdin:z.string().max(64000),stdout:z.string().max(64000),stderr:z.string().max(64000).optional(),exitCode:z.number().int().min(0).max(255)}).strict()).min(1).max(64),
}).strict();
function expectedCobolTests(files:Array<{path:string;content:string}>){
  const file=files.find(file=>file.path==="tests/cobol-contracts.json");
  if(!file)throw new Error("Missing reviewed COBOL contracts.");
  const text=Buffer.from(file.content,"base64").toString("utf8");
  const manifest=cobolManifestSchema.parse(JSON.parse(text));
  if(Buffer.byteLength(JSON.stringify(manifest))>100000||manifest.tests.some(test=>[test.stdin,test.stdout,test.stderr||""].some(value=>Buffer.byteLength(value)>64000)))throw new Error("COBOL contract payload exceeds its execution bound.");
  const sources=files.filter(file=>/\.(cob|cbl|cobol)$/i.test(file.path)&&!ignoredManifestPath.test(file.path)).map(file=>file.path);
  if(new Set(manifest.programs.map(program=>program.name)).size!==manifest.programs.length||manifest.programs.some(program=>program.sources.some(source=>!sources.includes(source))||!manifest.tests.some(test=>test.program===program.name))||sources.some(source=>!manifest.programs.some(program=>program.sources.includes(source)))||manifest.tests.some(test=>!manifest.programs.some(program=>program.name===test.program)))throw new Error("COBOL source/program/test inventory is incomplete.");
  return manifest.tests.length;
}

export function expectedVerificationProjects(files:Array<{path:string;content:string}>){
  const projects:Array<{project:string;commands:string[];testCount?:number}>=[];
  if(blockedRuntimeReasons(files.map(file=>file.path)).length)throw new Error("Unqualified runtime in snapshot.");
  for(const unit of pythonUnits(files.map(file=>file.path)))projects.push({project:unit.project,commands:unit.manager==="requirements"?[...pythonVerificationCommands,...(files.some(candidate=>candidate.path===unit.manifest.replace(/requirements\.txt$/,"requirements-dev.txt"))?[pythonTestDependenciesCommand]:[])]:managedPythonVerificationCommands[unit.manager]});
  const root=files.find(file=>file.path==="package.json");
  const workspaces=files.some(file=>file.path==="pnpm-workspace.yaml")||root&&JSON.parse(Buffer.from(root.content,"base64").toString("utf8")).workspaces;
  for(const file of files){
    if((file.path==="package.json"||!workspaces&&file.path.endsWith("/package.json"))&&!/(^|\/)(vendor|node_modules|testdata|\.git)\//.test(file.path)){
      const project=file.path==="package.json"?".":file.path.slice(0,-13);
      const manager=nodeManager(JSON.parse(Buffer.from(file.content,"base64").toString("utf8")),files.map(item=>item.path),project);
      if(!files.some(item=>item.path===manager.lock))throw new Error("Missing manager-owned lockfile.");
      projects.push({project,commands:nodeVerificationCommands[manager.name]});
    }
  }
  for(const unit of ecosystemUnits(files.map(file=>file.path))){
    if(unit.runtime==="cpp"&&nativeDependencyBlocker(files.map(file=>({...file,content:Buffer.from(file.content,"base64").toString("utf8")})),unit.project))throw new Error("Unqualified native dependency inventory.");
    projects.push({project:unit.project,commands:ecosystemVerificationCommands[unit.runtime],...(unit.runtime==="cobol"?{testCount:expectedCobolTests(files)}:{})});
  }
  return projects;
}

export function reportMatchesSnapshot(report:VerificationReport,snapshot:{baseline?:Array<{path:string;content:string}>;candidate?:Array<{path:string;content:string}>;scenario?:string;scenarioChecks?:AcceptanceManifest["checks"];candidateSecurity?:boolean}){
  if(!reportPassed(report))return false;
  try{
    if(snapshot.candidateSecurity&&!report.steps.some(step=>step.variant==="candidate"&&step.project==="."&&step.command===candidateSecurityCommand&&verificationStepAcceptable(step)))return false;
    let rewrite=false;
    if(snapshot.scenario==="rewrite"){
      const source=scenarioAcceptance(snapshot.baseline||[],"rewrite");
      const original=(snapshot.baseline||[]).find(file=>file.path==="tests/modernization-acceptance.json");
      if(!original||snapshot.candidate?.find(file=>file.path===original.path)?.content!==original.content)throw new Error("The reviewed source contract cannot change.");
      const canonical=(check:AcceptanceManifest["checks"][number])=>JSON.stringify([check.id,check.kind,check.project,check.variants,check.command,check.args,check.report,check.timeoutSeconds]);
      rewrite=Boolean(source?.checks.some(check=>check.kind==="contract"&&check.variants.includes("baseline")&&check.variants.includes("candidate")&&snapshot.scenarioChecks?.some(expected=>canonical(expected)===canonical(check))));
      if(!rewrite)throw new Error("A reviewed unchanged contract on both variants is required.");
    }
    for(const source of snapshot.baseline||[]){
      const test=isImmutableOriginalTest(source.path)||source.path.endsWith(".rs")&&/#\s*\[\s*(?:test|cfg\s*\(\s*test\s*\))/.test(Buffer.from(source.content,"base64").toString("utf8"));
      if(test&&snapshot.candidate?.find(file=>file.path===source.path)?.content!==source.content)throw new Error("Original test sources cannot be removed or rewritten.");
    }
    for(const baseline of snapshot.baseline||[]){
      if(!/(^|\/)package\.json$/.test(baseline.path))continue;
      const candidate=snapshot.candidate?.find(file=>file.path===baseline.path);
      if(!candidate){if(rewrite)continue;throw new Error("Original JavaScript project removed.");}
      const project=baseline.path==="package.json"?".":baseline.path.slice(0,-13);
      const before=nodeManager(JSON.parse(Buffer.from(baseline.content,"base64").toString("utf8")),(snapshot.baseline||[]).map(file=>file.path),project);
      const after=nodeManager(JSON.parse(Buffer.from(candidate.content,"base64").toString("utf8")),(snapshot.candidate||[]).map(file=>file.path),project);
      if(before.name!==after.name||before.version!==after.version||JSON.stringify(before.integrity)!==JSON.stringify(after.integrity))throw new Error("Original manager/version changed.");
    }
    for(const before of pythonUnits((snapshot.baseline||[]).map(file=>file.path))){
      const after=pythonUnits((snapshot.candidate||[]).map(file=>file.path)).find(after=>after.project===before.project);
      if(after?after.manager!==before.manager:!rewrite)throw new Error("Original Python manager changed.");
    }
    for(const before of ecosystemUnits((snapshot.baseline||[]).map(file=>file.path))){
      if(!ecosystemUnits((snapshot.candidate||[]).map(file=>file.path)).some(after=>after.runtime===before.runtime&&after.project===before.project)&&!rewrite)throw new Error("Original runtime project removed without an executed reviewed contract.");
      if(before.runtime==="ruby"){
        const path=before.project==="."?"Gemfile.lock":`${before.project}/Gemfile.lock`;
        const original=snapshot.baseline?.find(file=>file.path===path);const candidate=snapshot.candidate?.find(file=>file.path===path);
        if(candidate&&Buffer.from(original?.content||"","base64").toString("utf8").match(/^BUNDLED WITH\s*\r?\n\s+(\S+)/m)?.[1]!==Buffer.from(candidate.content,"base64").toString("utf8").match(/^BUNDLED WITH\s*\r?\n\s+(\S+)/m)?.[1])throw new Error("Original exact Bundler version changed.");
      }
    }
    const expectedScenario=(snapshot.scenarioChecks||[]).flatMap(check=>check.variants.map(variant=>({variant,project:check.project,command:scenarioCommand(check)})));
    if(report.steps.some(step=>step.command.startsWith("modernization acceptance ")&&!expectedScenario.some(expected=>expected.variant===step.variant&&expected.project===step.project&&expected.command===step.command)))return false;
    return expectedScenario.every(expected=>report.steps.some(step=>step.variant===expected.variant&&step.project===expected.project&&step.command===expected.command&&verificationStepAcceptable(step)))&&(["baseline","candidate"] as const).every(variant=>{
      const projects=expectedVerificationProjects(snapshot[variant]||[]);
      return projects.length>0&&projects.every(({project,commands,testCount})=>commands.every(command=>report.steps.some(step=>step.variant===variant&&step.project===project&&step.command===command&&verificationStepAcceptable(step)&&(command!==ecosystemVerificationCommands.cobol[1]||step.tests?.tests===testCount))));
    });
  }catch{return false;}
}

export function changesetDigest(sourceSha:string,changes:VerificationChange[]) {
  return createHash("sha256").update(JSON.stringify({sourceSha,changes:[...changes].sort((first,second)=>first.path.localeCompare(second.path)).map(change=>({path:change.path,oldPath:change.oldPath||null,operation:change.operation,content:change.content}))})).digest("hex");
}

export function reportPassed(report:VerificationReport) {
  if(report.status!=="passed"||!report.steps.length||report.steps.some(step=>!verificationStepAcceptable(step)))return false;
  for(const variant of ["baseline","candidate"] as const){
    if(!report.steps.some(step=>step.variant===variant&&!step.command.startsWith("modernization acceptance ")))return false;
    const projects=new Set(report.steps.filter(step=>step.variant===variant).map(step=>step.project));
    if(!projects.size)return false;
    for(const project of projects){
      const steps=report.steps.filter(step=>step.variant===variant&&step.project===project&&!step.command.startsWith("modernization acceptance ")&&step.command!==candidateSecurityCommand);
      if(!steps.length)continue;
      const profiles=[...Object.values(nodeVerificationCommands),pythonVerificationCommands,...Object.values(managedPythonVerificationCommands),...Object.values(ecosystemVerificationCommands)].filter(commands=>commands.every(command=>steps.some(step=>step.command===command)));
      if(!profiles.length||steps.some(step=>!profiles.some(commands=>commands.includes(step.command)||commands===pythonVerificationCommands&&step.command===pythonTestDependenciesCommand)))return false;
      for(const commands of profiles)for(const command of commands)if(!steps.some(step=>step.command===command))return false;
    }
  }
  return true;
}

export function safeSnapshotPath(path:string) {
  return safeRepositoryPath(path);
}

export function verificationStepAcceptable(step:VerificationReport["steps"][number]) {
  if(step.timedOut)return false;
  if(step.command===candidateSecurityCommand){
    try{
      const result=z.object({scanner:z.literal("Semgrep 1.183.0"),rulesSha256:z.string().regex(/^[a-f0-9]{64}$/),filesScanned:z.number().int().nonnegative(),findings:z.array(z.unknown()).length(0),credentialPaths:z.array(z.string()).length(0)}).parse(JSON.parse(step.log));
      return step.variant==="candidate"&&step.project==="."&&step.exitCode===0&&Boolean(result.scanner);
    }catch{return false;}
  }
  if((testCommands.has(step.command)||step.command.startsWith("modernization acceptance "))&&(!step.tests||step.tests.tests<1||step.tests.failed!==0||step.tests.skipped!==0))return false;
  if(step.exitCode===0){
    if(pythonAuditCommands.has(step.command)){
      try{
        const audit=z.object({dependencies:z.array(z.object({name:z.string(),version:z.string(),skip_reason:z.string().optional(),vulns:z.array(z.object({id:z.string().min(1)}))}))}).parse(JSON.parse(step.log.slice(step.log.indexOf("{"))));
        return audit.dependencies.every(item=>!item.skip_reason&&!item.vulns.length);
      }catch{return false;}
    }
    return true;
  }
  if(step.variant==="baseline"&&ecosystemAuditCommands.has(step.command)&&step.exitCode===1)return auditFindingsRecorded(step.log);
  if(step.variant==="baseline"&&pythonAuditCommands.has(step.command)&&step.exitCode===1){
    try{
      const audit=z.object({dependencies:z.array(z.object({name:z.string(),version:z.string(),skip_reason:z.string().optional(),vulns:z.array(z.object({id:z.string().min(1)}))})).min(1)}).parse(JSON.parse(step.log.slice(step.log.indexOf('{'))));
      return audit.dependencies.every(item=>!item.skip_reason)&&audit.dependencies.some(item=>item.vulns.length>0);
    }catch{return false;}
  }
  if(step.variant==="baseline"&&[nodeVerificationCommands.pnpm[3],nodeVerificationCommands.yarn[3]].includes(step.command)&&step.exitCode===1)return auditFindingsRecorded(step.log);
  return step.variant==="baseline" && step.command==="npm audit --omit=dev --audit-level=high" && step.exitCode===1 && /# npm audit report/.test(step.log) && /\bSeverity: (high|critical)\b/.test(step.log);
}