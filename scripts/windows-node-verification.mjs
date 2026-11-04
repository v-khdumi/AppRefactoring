import {readFile,writeFile,rm,lstat,open} from "node:fs/promises";
import path from "node:path";
import {spawn} from "node:child_process";
import {nodeManager,projectsFor,nodeCommands,npmTestCounts,enforceExecutedTests} from "./verification-runner.mjs";

export async function windowsNpmVerification(config,execute=run){
  const steps=[],artifacts=[];
  const files=config.files;
  for(const project of projectsFor(files,{requireScripts:false,requireLock:config.mode!=="prepare"})){
    const cwd=path.resolve(config.root,project);
    const manifestPath=project==="."?"package.json":`${project}/package.json`;
    const manifest=JSON.parse(Buffer.from(files.find(file=>file.path===manifestPath).content,"base64").toString("utf8"));
    const manager=nodeManager(manifest,files.map(file=>file.path),project);
    if(manager.name!=="npm")throw new Error("Windows mixed-runtime verification currently requires npm; pnpm and Yarn remain blocked on Windows.");
    if(manager.version&&manager.version!==config.npmVersion)throw new Error(`Windows requires the exact source npm ${manager.version}; installed ${config.npmVersion}. No manager substitution is allowed.`);
    const command=async(args)=>execute(config.node,[config.npmCli,...args],cwd);
    if(config.mode==="prepare"){
      const original=config.source.find(file=>file.path===manifestPath);
      if(config.variant==="candidate"&&original?.content===files.find(file=>file.path===manifestPath).content&&files.some(file=>file.path===manager.lock))continue;
      if(config.variant==="baseline"&&!config.baselinePreparationPaths?.includes(manager.lock))continue;
      const step=await command(["install","--package-lock-only","--ignore-scripts","--no-fund"]);
      if(step.exitCode!==0||step.timedOut)throw new Error(`Windows npm lock preparation failed: ${step.log.slice(-1500)}`);
      const actual=await regularFile(path.join(cwd,"package.json"),200000);
      if(Buffer.from(actual).toString("base64")!==files.find(file=>file.path===manifestPath).content)throw new Error("Lock preparation changed the source manifest.");
      const content=await regularFile(path.join(config.root,manager.lock),2_000_000);
      if(Buffer.from(content).toString("base64")!==files.find(file=>file.path===manager.lock)?.content)artifacts.push({variant:config.variant,path:manager.lock,content});
      continue;
    }
    for(let index=0;index<4;index++){
      if(index===1||index===2)if(typeof manifest.scripts?.[index===1?"build":"test"]!=="string"||!manifest.scripts[index===1?"build":"test"].trim())throw new Error(`Windows npm project ${project} is missing scripts.${index===1?"build":"test"}.`);
      let step;
      if(index===2){
        const script=manifest.scripts.test;
        const reporter=/\b(vitest|jest)\b/.test(script);
        const report=path.join(cwd,".modernize-verification-tests.json");
        if(reporter)await rm(report,{force:true});
        const args=/\bvitest\b/.test(script)?["test","--","--run","--reporter=json",`--outputFile=${report}`]:/\bjest\b/.test(script)?["test","--","--runInBand","--json",`--outputFile=${report}`]:["test"];
        step=await command(args);
        try{step=enforceExecutedTests(step,npmTestCounts(reporter?await regularFile(report,20_000_000):step.output,reporter?"json":"tap"));}
        catch(error){step={...step,exitCode:step.exitCode||1,log:`${step.log}\nExecuted tests unavailable: ${error.message}`.slice(-32000)};}
      }else step=await command(index===0?["ci","--ignore-scripts","--no-fund"]:index===1?["run","build"]:["audit","--omit=dev","--audit-level=high"]);
      delete step.output;
      step={...step,command:nodeCommands.npm[index],variant:config.variant,project};
      steps.push(step);
      const baselineAdvisory=config.variant==="baseline"&&index===3&&step.exitCode===1&&!step.timedOut&&/# npm audit report/.test(step.log)&&/\bSeverity: (high|critical)\b/.test(step.log);
      if((step.exitCode!==0||step.timedOut)&&!baselineAdvisory)return {steps,artifacts,failed:true};
    }
  }
  return {steps,artifacts,failed:false};
}

async function regularFile(file,limit){
  const metadata=await lstat(file);
  if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.size>limit)throw new Error("Verifier artifacts must be bounded regular files.");
  const handle=await open(file,"r");
  try{return await handle.readFile("utf8");}finally{await handle.close();}
}
async function run(command,args,cwd){
  const started=Date.now();
  return new Promise(resolve=>{
    let output="",log="",size=0,timedOut=false,settled=false,oversized=false;
    const child=spawn(command,args,{cwd,windowsHide:true,stdio:["ignore","pipe","pipe"],env:{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,PATH:`${path.dirname(command)};${process.env.SystemRoot}\\System32`,HOME:cwd,USERPROFILE:cwd,APPDATA:path.join(cwd,".appdata"),LOCALAPPDATA:path.join(cwd,".localappdata"),TEMP:cwd,TMP:cwd,CI:"true",NODE_ENV:"test",MODERNIZE_VERIFICATION_VARIANT:process.env.MODERNIZE_VERIFICATION_VARIANT,npm_config_cache:path.join(cwd,".npm-cache"),npm_config_registry:"https://registry.npmjs.org/",npm_config_ignore_scripts:args.includes("ci")?"true":"false"}});
    const capture=(data,stdout)=>{size+=data.length;log=(log+data).slice(-32000);if(size>20_000_000){oversized=true;terminate();}else if(stdout)output+=data;};
    child.stdout.on("data",data=>capture(data.toString(),true));
    child.stderr.on("data",data=>capture(data.toString(),false));
    const terminate=()=>{if(child.pid)spawn("taskkill.exe",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});};
    const timer=setTimeout(()=>{timedOut=true;terminate();},240000);
    const finish=exitCode=>{if(settled)return;settled=true;clearTimeout(timer);terminate();resolve({exitCode:oversized&&exitCode===0?1:exitCode,timedOut,log:oversized?`${log}\nEvidence exceeded the 20 MB limit.`.slice(-32000):log,output,durationMs:Date.now()-started});};
    child.on("error",error=>{log=(log+"\n"+error.message).slice(-32000);finish(null);});
    child.on("close",finish);
  });
}
async function main(){
  const config=JSON.parse(await readFile(process.argv[3],"utf8"));
  try{const result=await windowsNpmVerification(config);await writeFile(config.result,JSON.stringify(result));if(result.failed)process.exitCode=1;}
  catch(error){console.error(error.message);process.exitCode=1;}
}
if(process.argv[2]==="--execute")void main().catch(error=>{console.error(error.message);process.exitCode=1;});
