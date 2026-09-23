import type {ModernizationScope} from "../types/modernization";
import {mapConcurrent} from "./agent-concurrency";

export interface ReadinessFile {path:string;content?:string;size?:number}
export interface VerificationReadiness {
  supported:boolean;
  projects:Array<{path:string;runtime:"npm"|"python"}>;
  blockers:Array<{code:string;path?:string;message:string}>;
  warnings:Array<{code:string;path?:string;message:string}>;
}

export function verificationReadiness(files:ReadinessFile[],options:{scope:ModernizationScope;backendTarget?:string}):VerificationReadiness {
  const result:VerificationReadiness={supported:true,projects:[],blockers:[],warnings:[]};
  const paths=new Set(files.map(file=>file.path));
  const projectPath=(file:string)=>file.includes("/")?file.slice(0,file.lastIndexOf("/")):".";
  const localPath=(project:string,file:string)=>project==="."?file:`${project}/${file}`;
  const unsupported=files.filter(file=>/(^|\/)([^/]+\.(?:csproj|fsproj|vbproj)|pom\.xml|build\.gradle(?:\.kts)?|go\.mod|Cargo\.toml|composer\.json|Gemfile)$/i.test(file.path));
  for(const file of unsupported)result.blockers.push({code:"UnsupportedRuntime",path:file.path,message:"This repository contains a runtime for which executed verification is not configured. Generation cannot be approved as a verified modernization."});
  if(options.scope!=="frontend"&&options.backendTarget&& !/^(Node\.js \+ NestJS|Python \+ FastAPI)$/.test(options.backendTarget)){
    result.blockers.push({code:"UnsupportedTarget",message:`Executed verification for target '${options.backendTarget}' is not configured. Available backend targets: Node.js + NestJS, Python + FastAPI.`});
  }
  for(const file of files.filter(file=>/(^|\/)(pyproject\.toml|Pipfile)$/.test(file.path))){
    if(!paths.has(localPath(projectPath(file.path),"requirements.txt")))result.blockers.push({code:"PythonRequirementsRequired",path:file.path,message:"Python verification currently requires requirements.txt; Poetry, uv and Pipenv-only projects are not configured."});
  }
  const root=files.find(file=>file.path==="package.json");
  let rootWorkspaces=false;
  try{rootWorkspaces=Boolean(root?.content&&JSON.parse(root.content).workspaces);}catch{}
  for(const file of files){
    const project=projectPath(file.path);
    if(/(^|\/)requirements\.txt$/.test(file.path)){
      result.projects.push({path:project,runtime:"python"});
      if(!file.content?.trim())result.warnings.push({code:"EmptyRequirements",path:file.path,message:"No Python dependencies were declared; installation and audit must still execute."});
      const prefix=localPath(project,"tests/");
      if(!files.some(candidate=>candidate.path.startsWith(prefix)&&/(^|\/)test_[^/]+\.py$/.test(candidate.path)))result.warnings.push({code:"TestsRequired",path:project,message:"Characterization tests must be generated and executed on baseline and candidate. Empty or skipped suites cannot pass."});
    }
    if(!/(^|\/)package\.json$/.test(file.path)||(rootWorkspaces&&project!=="."))continue;
    result.projects.push({path:project,runtime:"npm"});
    try{
      const manifest=JSON.parse(file.content||"");
      if(!manifest||typeof manifest!=="object"||Array.isArray(manifest))throw new Error("Invalid manifest");
      if(manifest.packageManager&&!String(manifest.packageManager).startsWith("npm@"))result.blockers.push({code:"UnsupportedPackageManager",path:file.path,message:"This project selects a non-npm package manager. A compatible runner must be configured rather than replacing its lockfile."});
      for(const script of ["build","test"]){
        if(typeof manifest.scripts?.[script]!=="string"||!manifest.scripts[script].trim())result.warnings.push({code:"ScriptRequired",path:file.path,message:`A real ${script} script and its tooling are required before verification can pass.`});
      }
      if(!paths.has(localPath(project,"package-lock.json")))result.blockers.push({code:"LockfileRequired",path:localPath(project,"package-lock.json"),message:"The baseline npm project has no supported reproducible lockfile. Add a reviewed package-lock.json to the source before starting generation."});
    }catch{result.blockers.push({code:"ManifestUnavailable",path:file.path,message:"The package manifest is invalid or could not be read completely. Generation cannot infer dependencies from filenames alone."});}
  }
  for(const runtime of ["npm","python"] as const)if(result.projects.filter(project=>project.runtime===runtime).length>8)result.blockers.push({code:"ProjectLimit",message:`Verification currently supports at most eight ${runtime} projects per snapshot.`});
  if(result.projects.length>8)result.blockers.push({code:"CombinedProjectLimit",message:"Verification supports at most eight runtime projects in a mixed snapshot."});
  if(!result.projects.length)result.blockers.push({code:"NoSupportedProject",message:"No supported project manifest was found. Executed verification currently requires npm package.json or Python requirements.txt."});
  result.supported=result.blockers.length===0;
  return result;
}

export class VerificationReadinessError extends Error {
  constructor(public readiness:VerificationReadiness){
    super(readiness.blockers.map(item=>`${item.path?`${item.path}: `:""}${item.message}`).join(" "));
    this.name="VerificationReadinessError";
  }
}

export async function readVerificationReadiness(files:ReadinessFile[],read:(path:string)=>Promise<string>,options:{scope:ModernizationScope;backendTarget?:string}){
  const manifests=files.filter(file=>/(^|\/)(package\.json|requirements\.txt)$/.test(file.path));
  if(manifests.length>64)throw new VerificationReadinessError({supported:false,projects:[],warnings:[],blockers:[{code:"ManifestLimit",message:"More than 64 project manifests were detected; verification needs a smaller explicitly scoped repository."}]});
  const contents=new Map((await mapConcurrent(manifests,6,async file=>({path:file.path,content:(file.size||0)>200000?undefined:await read(file.path)}))).map(file=>[file.path,file.content]));
  const readiness=verificationReadiness(files.map(file=>({...file,content:contents.get(file.path)})),options);
  if(!readiness.supported)throw new VerificationReadinessError(readiness);
  return readiness;
}