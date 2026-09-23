import { mkdir, writeFile, open, chown, chmod } from "node:fs/promises";
import {constants} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function pythonProjectsFor(files) {
  const manifests=files.filter(file=>file.path==="requirements.txt"||file.path.endsWith("/requirements.txt"));
  if(manifests.length>8)throw new Error("Verification supports at most eight Python requirements projects.");
  return manifests.map(file=>path.posix.dirname(file.path));
}

export const pythonCommands=[
  "python3 -m venv .verification-venv",
  ".verification-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: --upgrade pip setuptools -r requirements.txt",
  ".verification-venv/bin/python -m compileall -q -x /[.]verification-venv/ .",
  "xvfb-run Python unittest discovery (tests/test_*.py; nonempty; no skips)",
  "pip-audit --path .verification-venv/lib/python3.11/site-packages --format json",
];
export const pythonTestDependenciesCommand=".verification-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: -c requirements.txt -r requirements-dev.txt";
export function pythonAuditFindings(log){
  try{
    const report=JSON.parse(log.slice(log.indexOf('{')));
    return Array.isArray(report.dependencies)&&report.dependencies.length>0&&report.dependencies.every(item=>typeof item.name==='string'&&typeof item.version==='string'&&!item.skip_reason&&Array.isArray(item.vulns)&&item.vulns.every(vuln=>typeof vuln.id==='string'&&vuln.id.length>0))&&report.dependencies.some(item=>item.vulns.length>0);
  }catch{return false;}
}
const unittestProgram=`import sys, unittest
suite = unittest.defaultTestLoader.discover('tests', pattern='test_*.py')
result = unittest.TextTestRunner(verbosity=2).run(suite)
if result.testsRun == 0:
    print('No tests discovered; verification cannot pass.', file=sys.stderr)
if result.skipped:
    print('Skipped tests leave required coverage unverified.', file=sys.stderr)
sys.exit(0 if result.wasSuccessful() and result.testsRun > 0 and not result.skipped else 1)
`;

export async function runPythonCommand(index,cwd,uid){
  const commands=[
    ["python3",["-m","venv",".verification-venv"]],
    [".verification-venv/bin/python",["-m","pip","install","--disable-pip-version-check","--only-binary=:all:","--upgrade","pip","setuptools","-r","requirements.txt"]],
    [".verification-venv/bin/python",["-m","compileall","-q","-x","/[.]verification-venv/","."]],
    ["xvfb-run",["--auto-servernum",".verification-venv/bin/python","-c",unittestProgram]],
    ["/opt/verification-tools/bin/pip-audit",["--path",path.join(cwd,".verification-venv/lib/python3.11/site-packages"),"--format","json"]],
    [".verification-venv/bin/python",["-m","pip","install","--disable-pip-version-check","--only-binary=:all:","-c","requirements.txt","-r","requirements-dev.txt"]],
  ];
  const [command,args]=commands[index];
  return {...await executeCommand(command,args,cwd,uid),command:index===5?pythonTestDependenciesCommand:pythonCommands[index]};
}

export function projectsFor(files,{requireScripts=true,requireLock=true}={}) {
  const paths=new Set(files.map(file=>file.path));
  const manifests=files.filter(file=>file.path==="package.json"||file.path.endsWith("/package.json"));
  if(!manifests.length)throw new Error("Unsupported repository: no Node/npm package.json found.");
  const root=manifests.find(file=>file.path==="package.json");
  const rootPackage=root?JSON.parse(Buffer.from(root.content,"base64").toString("utf8")):undefined;
  const selected=rootPackage?.workspaces?[root]:manifests;
  if(selected.length>8)throw new Error("Verification supports at most eight independently buildable npm projects.");
  return selected.map(file=>{
    const manifest=JSON.parse(Buffer.from(file.content,"base64").toString("utf8"));
    const project=path.posix.dirname(file.path);
    const lock=project==="."?"package-lock.json":`${project}/package-lock.json`;
    if(requireLock&&!paths.has(lock))throw new Error(`Missing ${lock}; reproducible npm ci cannot run.`);
    if(requireScripts&&(typeof manifest.scripts?.build!=="string"||!manifest.scripts.build.trim()||typeof manifest.scripts?.test!=="string"||!manifest.scripts.test.trim()))throw new Error(`${file.path} must define nonempty build and test scripts.`);
    return project;
  });
}

export async function readPreparedFile(filePath){
  const file=await open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const metadata=await file.stat();
    if(!metadata.isFile()||metadata.size>2_000_000||![10001,10002].includes(metadata.uid))throw new Error("Prepared artifacts must be bounded regular files owned by the verifier user.");
    return await file.readFile("utf8");
  }finally{await file.close();}
}

export async function prepareCandidateLocks(snapshot,execute=runCommand,read=readPreparedFile){
  if(!snapshot.candidate.some(file=>file.path==="package.json"||file.path.endsWith("/package.json")))return [];
  const artifacts=[];
  for(const project of projectsFor(snapshot.candidate,{requireScripts:false,requireLock:false})){
    const manifestPath=project==="."?"package.json":`${project}/package.json`;
    const lockPath=project==="."?"package-lock.json":`${project}/package-lock.json`;
    const candidate=snapshot.candidate.find(file=>file.path===manifestPath);
    const original=snapshot.baseline.find(file=>file.path===manifestPath);
    const lock=snapshot.candidate.find(file=>file.path===lockPath);
    if(lock&&candidate.content===original?.content)continue;
    const cwd=path.join("/work","candidate",project);
    const step=await execute(["install","--package-lock-only","--ignore-scripts","--no-fund"],cwd,10002);
    if(step.exitCode!==0||step.timedOut)throw new Error(`Dependency preparation failed for ${project}: ${step.log.slice(-1500)}`);
    const manifest=await read(path.join(cwd,"package.json"),"utf8");
    if(Buffer.from(manifest).toString("base64")!==candidate.content)throw new Error("Dependency preparation unexpectedly changed the candidate manifest.");
    const content=await read(path.join(cwd,"package-lock.json"),"utf8");
    if(Buffer.byteLength(content)>2_000_000)throw new Error("Prepared dependency lockfile exceeds the 2 MB limit.");
    if(Buffer.from(content).toString("base64")!==lock?.content)artifacts.push({variant:"candidate",path:lockPath,content});
  }
  for(const lockPath of snapshot.baselinePreparationPaths||[]){
    validatePath(lockPath);
    const project=path.posix.dirname(lockPath);
    const cwd=path.join("/work","baseline",project);
    const step=await execute(["install","--package-lock-only","--ignore-scripts","--no-fund"],cwd,10001);
    if(step.exitCode!==0||step.timedOut)throw new Error(`Baseline test tooling lock preparation failed for ${project}: ${step.log.slice(-1500)}`);
    const manifestPath=lockPath.replace(/package-lock\.json$/,"package.json");
    const expected=snapshot.baseline.find(file=>file.path===manifestPath);
    if(!expected||Buffer.from(await read(path.join(cwd,"package.json"),"utf8")).toString("base64")!==expected.content)throw new Error("Baseline preparation unexpectedly changed the baseline manifest.");
    const content=await read(path.join(cwd,"package-lock.json"),"utf8");
    if(Buffer.byteLength(content)>2_000_000)throw new Error("Baseline test tooling lock exceeds the 2 MB limit.");
    artifacts.push({variant:"baseline",path:lockPath,content});
  }
  return artifacts;
}

function validatePath(value){
  if(!value||value.length>500||value.includes("\\")||value.includes(":")||value.startsWith("/")||value.includes("\0")||value.split("/").some(part=>["..",".","",".git","node_modules"].includes(part)))throw new Error("Unsafe snapshot path.");
}

export async function materialize(root,files,uid){
  await mkdir(root,{recursive:true,mode:0o700});await chown(root,uid,uid);
  const dirs=new Set();
  for(const file of files){
    validatePath(file.path);
    const target=path.join(root,file.path);
    let parent=path.dirname(target);
    while(parent!==root){dirs.add(parent);parent=path.dirname(parent);}
    await mkdir(path.dirname(target),{recursive:true,mode:0o700});
    await writeFile(target,Buffer.from(file.content,"base64"),{mode:file.executable?0o700:0o600});
    await chown(target,uid,uid);
  }
  for(const dir of dirs){await chown(dir,uid,uid);await chmod(dir,0o700);}
}

export async function runCommand(args,cwd,uid,timeoutMs=240000){
  return executeCommand("npm",args,cwd,uid,timeoutMs);
}

export async function executeCommand(command,args,cwd,uid,timeoutMs=240000){
  const started=Date.now();let log="";let timedOut=false;
  const variant=uid===10001?"baseline":"candidate";
  return new Promise(resolve=>{
    const child=spawn(command,args,{cwd,uid,gid:uid,detached:true,stdio:["ignore","pipe","pipe"],env:{PATH:"/usr/bin:/usr/local/bin:/bin",HOME:cwd,CI:"true",NODE_ENV:"test",MODERNIZE_VERIFICATION_VARIANT:variant,PYTHONUNBUFFERED:"1",PYTHONNOUSERSITE:"1",PIP_NO_INPUT:"1",TMPDIR:cwd,DEBIAN_FRONTEND:"noninteractive",npm_config_cache:path.join(cwd,".npm-cache"),npm_config_update_notifier:"false",npm_config_ignore_scripts:args[0]==="ci"?"true":"false"}});
    const capture=data=>{log=(log+data.toString()).slice(-32000);};
    child.stdout.on("data",capture);child.stderr.on("data",capture);
    const terminate=()=>{if(child.pid)try{process.kill(-child.pid,"SIGKILL");}catch{}};
    const timer=setTimeout(()=>{timedOut=true;terminate();},timeoutMs);
    let settled=false;
    const finish=exitCode=>{if(settled)return;settled=true;clearTimeout(timer);terminate();resolve({command:`${command} ${args.join(" ")}`,exitCode,timedOut,log,durationMs:Date.now()-started});};
    child.on("error",error=>{capture(Buffer.from(error.message));finish(null);});
    child.on("close",code=>finish(code));
  });
}

export async function verifySnapshot(snapshot,publish,execute=runCommand,executePython=runPythonCommand){
  const report={status:"failed",reason:"Verification started",steps:[]};
  const missing=[];
  const pythonFailures=[];
  const baselineAuditFailures=[];
  for(const [variant,uid] of [["baseline",10001],["candidate",10002]]){
    const files=snapshot[variant];
    const pythonProjects=pythonProjectsFor(files);
    for(const project of pythonProjects){
      const testPrefix=project==="."?"tests/":`${project}/tests/`;
      const hasTests=files.some(file=>file.path.startsWith(testPrefix)&&/(^|\/)test_[^/]+\.py$/.test(file.path));
      if(!hasTests)missing.push(`${variant} ${project}: no Python unittest tests found under ${testPrefix}`);
      const hasTestDependencies=files.some(file=>file.path===(project==="."?"requirements-dev.txt":`${project}/requirements-dev.txt`));
      for(const index of [0,1,...(hasTestDependencies?[5]:[]),2,3,4]){
        if(index===3&&!hasTests)continue;
        const step=await executePython(index,path.join("/work",variant,project),uid);
        report.steps.push({...step,variant,project});
        await publish({...report,reason:`${variant}: ${project}: ${step.command}`},false);
        if(step.exitCode!==0||step.timedOut){
          if(variant==="baseline"&&index===4&&step.exitCode===1&&!step.timedOut&&pythonAuditFindings(step.log)){
            baselineAuditFailures.push(`${variant} ${project}: pre-existing Python vulnerabilities (see audit report).`);
            continue;
          }
          pythonFailures.push(`${variant} ${project}: ${step.command} ${step.timedOut?"timed out":`failed (exit ${step.exitCode})`}.`);
          if(index<2||index===5||step.timedOut)break;
        }
      }
    }
    let projects=[];
    const hasNpm=files.some(file=>file.path==="package.json"||file.path.endsWith("/package.json"));
    if(hasNpm){try{projects=projectsFor(files,{requireScripts:false});}catch(error){missing.push(`${variant}: ${error.message}`);}}
    if(!pythonProjects.length&&!hasNpm)missing.push(`${variant}: unsupported stack; expected a Python requirements.txt or Node/npm package.json`);
    for(const project of projects){
      const manifestPath=project==="."?"package.json":`${project}/package.json`;
      const manifest=JSON.parse(Buffer.from(snapshot[variant].find(file=>file.path===manifestPath).content,"base64").toString("utf8"));
      const commands=[["ci","--ignore-scripts","--no-fund"]];
      for(const script of ["build","test"]){
        if(typeof manifest.scripts?.[script]==="string"&&manifest.scripts[script].trim())commands.push(script==="build"?["run","build"]:["test","--","--run"]);
        else missing.push(`${variant} ${manifestPath}: missing scripts.${script}`);
      }
      commands.push(["audit","--omit=dev","--audit-level=high"]);
      for(const args of commands){
        const step=await execute(args,path.join("/work",variant,project),uid);
        report.steps.push({...step,variant,project});
        await publish({...report,reason:`${variant}: ${project}: ${step.command}`},false);
        if(step.exitCode!==0||step.timedOut){
          const failure=`${variant} ${project}: ${step.command} ${step.timedOut?"timed out":`failed (exit ${step.exitCode})`}.`;
          if(variant==="baseline"&&args[0]==="audit"&&!step.timedOut&&step.exitCode===1&&/# npm audit report/.test(step.log)&&/\bSeverity: (high|critical)\b/.test(step.log)){
            baselineAuditFailures.push(failure);
            await publish({...report,reason:`Baseline audit failed; continuing candidate checks for comparison. ${failure}`},false);
            continue;
          }
          return {...report,reason:`${failure}${baselineAuditFailures.length?` Baseline findings: ${baselineAuditFailures.join(" ")}`:""}${missing.length?` Missing prerequisites: ${missing.join("; ")}.`:""}`.slice(0,2000)};
        }
      }
    }
  }
  if(pythonFailures.length)return {...report,status:"failed",reason:`${pythonFailures.join(" ")}${missing.length?` Missing prerequisites: ${missing.join("; ")}.`:""} Approval remains blocked.`.slice(0,2000)};
  if(missing.length)return {...report,status:"unsupported",reason:`Available checks completed, but required checks were not executed: ${missing.join("; ")}.${baselineAuditFailures.length?" Baseline audit findings are retained for comparison.":""} Add the missing tests or reproducible dependency configuration, then verify again. Approval remains blocked.`.slice(0,2000)};
  return {...report,status:"passed",reason:baselineAuditFailures.length?"Baseline and candidate install, build and tests passed. Candidate dependency audit passed; pre-existing baseline vulnerabilities are retained as diagnostics. Human review remains required.":"Baseline and candidate dependency installation, build/compilation, tests and dependency audit completed successfully for all detected projects. Human review remains required; this does not prove complete behavioral equivalence."};
}

async function main(){
  if(process.getuid?.()!==0)throw new Error("Verification supervisor must run as root and execute repository code as separate unprivileged users.");
  const endpoint=process.env.VERIFICATION_ENDPOINT;
  const token=process.env.VERIFICATION_TOKEN;
  if(!endpoint||!token)throw new Error("Missing job capability.");
  delete process.env.VERIFICATION_TOKEN;delete process.env.VERIFICATION_ENDPOINT;
  const publish=async(report,final=true)=>{
    const response=await fetch(endpoint,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({report,final}),signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`Evidence upload failed (${response.status}).`);
  };
  try{
    const response=await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error(`Snapshot download failed (${response.status}).`);
    let snapshot=await response.json();
    if(pythonProjectsFor(snapshot.baseline).length||pythonProjectsFor(snapshot.candidate).length){
      await publish({status:"failed",reason:"Preparing Python 3.11, Tkinter, a virtual display and dependency audit tooling in the isolated job.",steps:[]},false);
      for(const [command,args] of [["apt-get",["update"]],["apt-get",["install","-y","--no-install-recommends","python3","python3-venv","python3-tk","xvfb","xauth","libasound2","libssl3"]],["python3",["-m","venv","/opt/verification-tools"]],["/opt/verification-tools/bin/python",["-m","pip","install","--disable-pip-version-check","pip-audit==2.9.0"]]]){
        const setup=await executeCommand(command,args,"/tmp",0,240000);
        if(setup.exitCode!==0||setup.timedOut)throw new Error(`Python runtime setup failed: ${command}. ${setup.log.slice(-1500)}`);
      }
    }
    await mkdir("/work",{recursive:true,mode:0o755});
    await materialize("/work/baseline",snapshot.baseline,10001);
    await materialize("/work/candidate",snapshot.candidate,10002);
    await publish({status:"failed",reason:"Preparing generated dependency lockfiles in the isolated job before verification.",steps:[]},false);
    const preparedFiles=await prepareCandidateLocks(snapshot);
    if(preparedFiles.length){
      const saved=await fetch(endpoint,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({preparedFiles}),signal:AbortSignal.timeout(60000)});
      if(!saved.ok)throw new Error(`Dependency artifacts were not accepted (${saved.status}). No tests were reported as passed.`);
      const refreshed=await fetch(endpoint,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(60000)});
      if(!refreshed.ok)throw new Error("Prepared snapshot could not be confirmed.");
      snapshot=await refreshed.json();
    }
    const report=await verifySnapshot(snapshot,publish);
    await publish(report);
    console.log(JSON.stringify({status:report.status,steps:report.steps.length}));
  }catch(error){
    await publish({status:"failed",reason:String(error.message).slice(0,2000),steps:[]}).catch(()=>{});
    throw error;
  }
}
if(process.env.VERIFICATION_ENDPOINT)main().catch(error=>{console.error(error.message);process.exitCode=1;});