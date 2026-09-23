import { createHash } from "node:crypto";
import { z } from "zod";

export const verificationReportSchema = z.object({
  status:z.enum(["passed","failed","unsupported"]),
  reason:z.string().max(2000),
  steps:z.array(z.object({
    variant:z.enum(["baseline","candidate"]),project:z.string().max(500),command:z.string().max(500),
    exitCode:z.number().int().nullable(),timedOut:z.boolean(),log:z.string().max(32000),durationMs:z.number().nonnegative(),
  })).max(100),
});
export type VerificationReport = z.infer<typeof verificationReportSchema>;
export type VerificationChange = {path:string;oldPath?:string|null;operation:string;content:string};

export const npmVerificationCommands=["npm ci --ignore-scripts --no-fund","npm run build","npm test -- --run","npm audit --omit=dev --audit-level=high"];
export const pythonVerificationCommands=[
  "python3 -m venv .verification-venv",
  ".verification-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: --upgrade pip setuptools -r requirements.txt",
  ".verification-venv/bin/python -m compileall -q -x /[.]verification-venv/ .",
  "xvfb-run Python unittest discovery (tests/test_*.py; nonempty; no skips)",
  "pip-audit --path .verification-venv/lib/python3.11/site-packages --format json",
];
export const pythonTestDependenciesCommand=".verification-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: -c requirements.txt -r requirements-dev.txt";

export function expectedVerificationProjects(files:Array<{path:string;content:string}>){
  const projects:Array<{project:string;commands:string[]}>=[];
  const root=files.find(file=>file.path==="package.json");
  const workspaces=root&&JSON.parse(Buffer.from(root.content,"base64").toString("utf8")).workspaces;
  for(const file of files){
    if(file.path==="requirements.txt"||file.path.endsWith("/requirements.txt"))projects.push({project:file.path==="requirements.txt"?".":file.path.slice(0,-17),commands:[...pythonVerificationCommands,...(files.some(candidate=>candidate.path===file.path.replace(/requirements\.txt$/,"requirements-dev.txt"))?[pythonTestDependenciesCommand]:[])]});
    if(file.path==="package.json"||!workspaces&&file.path.endsWith("/package.json"))projects.push({project:file.path==="package.json"?".":file.path.slice(0,-13),commands:npmVerificationCommands});
  }
  return projects;
}

export function reportMatchesSnapshot(report:VerificationReport,snapshot:Record<string,Array<{path:string;content:string}>>){
  if(!reportPassed(report))return false;
  try{
    return (["baseline","candidate"] as const).every(variant=>{
      const projects=expectedVerificationProjects(snapshot[variant]||[]);
      return projects.length>0&&projects.every(({project,commands})=>commands.every(command=>report.steps.some(step=>step.variant===variant&&step.project===project&&step.command===command&&verificationStepAcceptable(step))));
    });
  }catch{return false;}
}

export function changesetDigest(sourceSha:string,changes:VerificationChange[]) {
  return createHash("sha256").update(JSON.stringify({sourceSha,changes:[...changes].sort((first,second)=>first.path.localeCompare(second.path)).map(change=>({path:change.path,oldPath:change.oldPath||null,operation:change.operation,content:change.content}))})).digest("hex");
}

export function reportPassed(report:VerificationReport) {
  if(report.status!=="passed"||!report.steps.length||report.steps.some(step=>!verificationStepAcceptable(step)))return false;
  for(const variant of ["baseline","candidate"] as const){
    const projects=new Set(report.steps.filter(step=>step.variant===variant).map(step=>step.project));
    if(!projects.size)return false;
    for(const project of projects){
      const steps=report.steps.filter(step=>step.variant===variant&&step.project===project);
      const profiles=[npmVerificationCommands,pythonVerificationCommands].filter(commands=>steps.some(step=>commands.includes(step.command)));
      if(!profiles.length||steps.some(step=>!profiles.some(commands=>commands.includes(step.command)||commands===pythonVerificationCommands&&step.command===pythonTestDependenciesCommand)))return false;
      for(const commands of profiles)for(const command of commands)if(!steps.some(step=>step.command===command))return false;
    }
  }
  return true;
}

export function safeSnapshotPath(path:string) {
  return Boolean(path && path.length<=500 && !path.includes("\\") && !path.startsWith("/") && !path.includes("\0") && !path.includes(":") && path.split("/").every(part=>part!==".."&&part!=="."&&part!==""&&part!==".git"&&part!=="node_modules"));
}

export function verificationStepAcceptable(step:VerificationReport["steps"][number]) {
  if(step.timedOut)return false;
  if(step.exitCode===0)return true;
  if(step.variant==="baseline"&&step.command===pythonVerificationCommands[4]&&step.exitCode===1){
    try{
      const audit=z.object({dependencies:z.array(z.object({name:z.string(),version:z.string(),skip_reason:z.string().optional(),vulns:z.array(z.object({id:z.string().min(1)}))})).min(1)}).parse(JSON.parse(step.log.slice(step.log.indexOf('{'))));
      return audit.dependencies.every(item=>!item.skip_reason)&&audit.dependencies.some(item=>item.vulns.length>0);
    }catch{return false;}
  }
  return step.variant==="baseline" && step.command==="npm audit --omit=dev --audit-level=high" && step.exitCode===1 && /# npm audit report/.test(step.log) && /\bSeverity: (high|critical)\b/.test(step.log);
}