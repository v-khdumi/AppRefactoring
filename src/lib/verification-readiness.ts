import type {ModernizationScope} from "../types/modernization";
import {mapConcurrent} from "./agent-concurrency";
import {backendTargetFor,backendTargetRuntimes,backendTargets,isBackendTarget,type VerificationRuntime} from "./modernization-targets";
import {dotnetProject,ecosystemUnits,ignoredManifestPath,isDotnetFrameworkProject,isDotnetTestProject} from "./verification-ecosystems";

export interface ReadinessFile {path:string;content?:string;size?:number}
export interface VerificationReadiness {
  supported:boolean;
  projects:Array<{path:string;runtime:VerificationRuntime}>;
  blockers:Array<{code:string;path?:string;message:string}>;
  warnings:Array<{code:string;path?:string;message:string}>;
}

const readableManifest=/(^|\/)(package\.json|requirements\.txt|pom\.xml|(?:settings|build)\.gradle(?:\.kts)?|go\.mod|composer\.json|global\.json|[^/]+\.(?:csproj|fsproj|vbproj))$/i;

export function verificationReadiness(files:ReadinessFile[],options:{scope:ModernizationScope;backendTarget?:string}):VerificationReadiness {
  const result:VerificationReadiness={supported:true,projects:[],blockers:[],warnings:[]};
  const paths=new Set(files.map(file=>file.path));
  const projectPath=(file:string)=>file.includes("/")?file.slice(0,file.lastIndexOf("/")):".";
  const localPath=(project:string,file:string)=>project==="."?file:`${project}/${file}`;
  const within=(project:string,file:string)=>project==="."||file.startsWith(`${project}/`);
  for(const file of files.filter(file=>/(^|\/)(Cargo\.toml|Gemfile)$/i.test(file.path)&&!ignoredManifestPath.test(file.path)))result.blockers.push({code:"UnsupportedRuntime",path:file.path,message:"Rust and Ruby verification are not configured. Generation cannot be approved as a verified modernization."});
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
    if(!/(^|\/)package\.json$/.test(file.path)||ignoredManifestPath.test(file.path)||(rootWorkspaces&&project!=="."))continue;
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
  const allPaths=files.map(file=>file.path);
  for(const unit of ecosystemUnits(allPaths)){
    result.projects.push({path:unit.project,runtime:unit.runtime});
    const unitFiles=files.filter(file=>within(unit.project,file.path));
    if(unit.runtime==="dotnet"){
      const projects=files.filter(file=>dotnetProject.test(file.path)&&!ignoredManifestPath.test(file.path));
      let windows=files.some(file=>/(^|\/)packages\.config$/i.test(file.path));
      for(const project of projects){
        if(project.content===undefined){result.blockers.push({code:"ManifestUnavailable",path:project.path,message:"The .NET project file could not be read completely."});continue;}
        if(isDotnetFrameworkProject(project.content))windows=true;
      }
      if(windows){
        result.warnings.push({code:"WindowsVerifier",path:".",message:".NET Framework projects are verified in an isolated Windows container (MSBuild, NuGet and VSTest from the pinned .NET Framework 4.8.1 SDK image). ASP.NET Web Forms, WCF hosting and IIS behavior are verified only through executable tests."});
        const others=ecosystemUnits(allPaths).filter(item=>item.runtime!=="dotnet");
        if(others.length||result.projects.some(item=>item.runtime==="npm"||item.runtime==="python"))result.blockers.push({code:"WindowsVerifierDotnetOnly",message:"The Windows .NET Framework verifier currently executes .NET projects only. Remove or separate the other runtime projects from this repository scope."});
      }
      if(!projects.some(project=>project.content&&isDotnetTestProject(project.content)))result.warnings.push({code:"TestsRequired",path:".",message:"No .NET test project was found. Characterization test projects must be generated and executed on baseline and candidate."});
    }
    if(unit.runtime==="maven"||unit.runtime==="gradle"){
      if(!unitFiles.some(file=>/(^|\/)src\/test\/.+\.(java|kt|groovy|scala)$/.test(file.path)))result.warnings.push({code:"TestsRequired",path:unit.project,message:"No JVM tests were found under src/test. Characterization tests must be generated and executed on baseline and candidate."});
      if(unit.runtime==="gradle"&&!paths.has(localPath(unit.project,"gradlew")))result.warnings.push({code:"GradleWrapperRecommended",path:unit.project,message:"No Gradle wrapper was found; pinned Gradle 9.7.1 will be used. Builds written for older Gradle versions may fail and will be reported as such."});
    }
    if(unit.runtime==="go"){
      const manifest=files.find(file=>file.path===localPath(unit.project,"go.mod"));
      if(manifest?.content===undefined)result.blockers.push({code:"ManifestUnavailable",path:localPath(unit.project,"go.mod"),message:"The go.mod file could not be read completely."});
      else if(/^\s*require\b/m.test(manifest.content)&&!paths.has(localPath(unit.project,"go.sum")))result.blockers.push({code:"LockfileRequired",path:localPath(unit.project,"go.sum"),message:"The baseline Go module declares requirements without go.sum. Add the reviewed go.sum before starting generation."});
      if(!unitFiles.some(file=>file.path.endsWith("_test.go")))result.warnings.push({code:"TestsRequired",path:unit.project,message:"No Go tests were found. Characterization tests must be generated and executed on baseline and candidate."});
    }
    if(unit.runtime==="php"){
      const manifest=files.find(file=>file.path===localPath(unit.project,"composer.json"));
      try{
        const composer=JSON.parse(manifest?.content||"") as {require?:Record<string,string>;"require-dev"?:Record<string,string>};
        const packages=Object.keys(composer.require||{}).filter(name=>!/^(php|ext-.+|lib-.+|composer-plugin-api|composer-runtime-api)$/i.test(name));
        if(packages.length&&!paths.has(localPath(unit.project,"composer.lock")))result.blockers.push({code:"LockfileRequired",path:localPath(unit.project,"composer.lock"),message:"The baseline PHP project has no composer.lock. Add the reviewed lockfile before starting generation."});
        if(!Object.keys(composer["require-dev"]||{}).some(name=>/^(phpunit\/phpunit|pestphp\/pest)$/i.test(name)))result.warnings.push({code:"TestsRequired",path:unit.project,message:"PHPUnit or Pest is not declared in require-dev. Characterization tests and test tooling are required before verification can pass."});
      }catch{result.blockers.push({code:"ManifestUnavailable",path:manifest?.path||localPath(unit.project,"composer.json"),message:"The composer.json file is invalid or could not be read completely."});}
    }
  }
  if(options.scope!=="frontend"&&options.backendTarget){
    if(!isBackendTarget(options.backendTarget))result.blockers.push({code:"UnsupportedTarget",message:`Executed verification for target '${options.backendTarget}' is not configured. Available backend targets: ${backendTargets.join(", ")}.`});
    else{
      const targetRuntimes=backendTargetRuntimes[options.backendTarget];
      const serverRuntimes=[...new Set(result.projects.map(project=>project.runtime).filter(runtime=>!["npm","python"].includes(runtime)))];
      if(serverRuntimes.length&&!serverRuntimes.some(runtime=>targetRuntimes.includes(runtime)))result.blockers.push({code:"CrossRuntimeTarget",message:`The original backend runs on ${serverRuntimes.join(", ")}. Rewriting it to ${options.backendTarget} would remove the original executable tests that prove behavior preservation. Select ${[...new Set(serverRuntimes.map(backendTargetFor))].join(" or ")}.`});
    }
  }
  for(const runtime of new Set(result.projects.map(project=>project.runtime)))if(result.projects.filter(project=>project.runtime===runtime).length>8)result.blockers.push({code:"ProjectLimit",message:`Verification currently supports at most eight ${runtime} projects per snapshot.`});
  if(result.projects.length>8)result.blockers.push({code:"CombinedProjectLimit",message:"Verification supports at most eight runtime projects in a mixed snapshot."});
  if(!result.projects.length)result.blockers.push({code:"NoSupportedProject",message:"No supported project was found. Executed verification supports npm, Python requirements.txt, SDK-style .NET, Maven, Gradle, Go modules and PHP Composer projects."});
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
  const manifests=files.filter(file=>readableManifest.test(file.path)&&!ignoredManifestPath.test(file.path));
  if(manifests.length>200)throw new VerificationReadinessError({supported:false,projects:[],warnings:[],blockers:[{code:"ManifestLimit",message:"More than 200 project manifests were detected; verification needs a smaller explicitly scoped repository."}]});
  const contents=new Map((await mapConcurrent(manifests,6,async file=>({path:file.path,content:(file.size||0)>200000?undefined:await read(file.path)}))).map(file=>[file.path,file.content]));
  const readiness=verificationReadiness(files.map(file=>({...file,content:contents.get(file.path)})),options);
  if(!readiness.supported)throw new VerificationReadinessError(readiness);
  return readiness;
}
