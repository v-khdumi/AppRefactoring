import type {ModernizationScope,ModernizationScenario} from "../types/modernization";
import {mapConcurrent} from "./agent-concurrency";
import {backendTargetFor,backendTargetRuntimes,backendTargets,isBackendTarget,type VerificationRuntime} from "./modernization-targets";
import {blockedRuntimeReasons,dotnetProject,ecosystemUnits,ignoredManifestPath,isDotnetFrameworkProject,isDotnetTestProject,nodeManager,pythonUnits,nativeDependencyBlocker} from "./verification-ecosystems";
import {acceptanceManifestPath,scenarioAcceptance} from "./modernization-scenarios";

export interface ReadinessFile {path:string;content?:string;size?:number}
export interface VerificationReadiness {
  supported:boolean;
  projects:Array<{path:string;runtime:VerificationRuntime}>;
  blockers:Array<{code:string;path?:string;message:string}>;
  warnings:Array<{code:string;path?:string;message:string}>;
}

const readableManifest=/(^|\/)(package\.json|requirements\.txt|pyproject\.toml|Pipfile|Cargo\.toml|Gemfile|Gemfile\.lock|CMakeLists\.txt|cobol-contracts\.json|rust-toolchain(?:\.toml)?|pom\.xml|(?:settings|build)\.gradle(?:\.kts)?|go\.mod|composer\.json|global\.json|[^/]+\.(?:cmake|csproj|fsproj|vbproj))$/i;

export function verificationReadiness(files:ReadinessFile[],options:{scope:ModernizationScope;backendTarget?:string;scenario?:ModernizationScenario}):VerificationReadiness {
  const result:VerificationReadiness={supported:true,projects:[],blockers:[],warnings:[]};
  const paths=new Set(files.map(file=>file.path));
  const projectPath=(file:string)=>file.includes("/")?file.slice(0,file.lastIndexOf("/")):".";
  const localPath=(project:string,file:string)=>project==="."?file:`${project}/${file}`;
  const within=(project:string,file:string)=>project==="."||file.startsWith(`${project}/`);
  for(const reason of blockedRuntimeReasons([...paths]))result.blockers.push({code:"UnqualifiedRuntime",message:reason});
  try{
    for(const unit of pythonUnits([...paths])){
      result.projects.push({path:unit.project,runtime:"python"});
      if(unit.manager!=="requirements")result.warnings.push({code:"LockedPythonManager",path:unit.manifest,message:`Verification preserves ${unit.manager} and ${unit.lock}; Python 3.11 compatibility, all locked dependency groups, tests and dependency audit must execute on both variants.`});
      if(!files.some(file=>file.path.startsWith(localPath(unit.project,"tests/"))&&/(^|\/)test_[^/]+\.py$/.test(file.path)))result.warnings.push({code:"TestsRequired",path:unit.project,message:"Nonempty, unskipped Python unittest tests must execute on baseline and candidate."});
    }
  }catch(error){result.blockers.push({code:"PythonLockRequired",message:(error as Error).message});}
  const root=files.find(file=>file.path==="package.json");
  let rootWorkspaces=paths.has("pnpm-workspace.yaml");
  try{rootWorkspaces=rootWorkspaces||Boolean(root?.content&&JSON.parse(root.content).workspaces);}catch{}
  for(const file of files){
    const project=projectPath(file.path);
    if(/(^|\/)requirements\.txt$/.test(file.path)){
      if(!file.content?.trim())result.warnings.push({code:"EmptyRequirements",path:file.path,message:"No Python dependencies were declared; installation and audit must still execute."});
      const prefix=localPath(project,"tests/");
      if(!files.some(candidate=>candidate.path.startsWith(prefix)&&/(^|\/)test_[^/]+\.py$/.test(candidate.path)))result.warnings.push({code:"TestsRequired",path:project,message:"Characterization tests must be generated and executed on baseline and candidate. Empty or skipped suites cannot pass."});
    }
    if(!/(^|\/)package\.json$/.test(file.path)||ignoredManifestPath.test(file.path)||(rootWorkspaces&&project!=="."))continue;
    try{
      const manifest=JSON.parse(file.content||"");
      if(!manifest||typeof manifest!=="object"||Array.isArray(manifest))throw new Error("Invalid manifest");
      const manager=nodeManager(manifest,[...paths],project);
      result.projects.push({path:project,runtime:manager.name});
      for(const script of ["build","test"]){
        if(typeof manifest.scripts?.[script]!=="string"||!manifest.scripts[script].trim())result.warnings.push({code:"ScriptRequired",path:file.path,message:`A real ${script} script and its tooling are required before verification can pass.`});
      }
      if(!paths.has(manager.lock))result.blockers.push({code:"LockfileRequired",path:manager.lock,message:`The baseline ${manager.name} project needs its reviewed manager-owned lockfile before generation.`});
    }catch(error){result.blockers.push({code:"ManifestUnavailable",path:file.path,message:`The package manifest or manager configuration is unavailable: ${(error as Error).message}`});}
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
        if(others.length||result.projects.some(item=>["npm","pnpm","yarn","python"].includes(item.runtime)))result.blockers.push({code:"WindowsVerifierDotnetOnly",message:"Mixed Windows verification remains unqualified. The .NET+npm executor is implemented, but the live ACI canary failed before supervisor startup and the alternative region was denied by Azure policy. No runtime or audit may be omitted."});
        if(options.scenario&&["replatform","extract-services","rewrite","database-migration","ai-capability"].includes(options.scenario))result.blockers.push({code:"WindowsAcceptanceRequired",message:"Specialized strategy acceptance commands have not been qualified on Windows and cannot be waived."});
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
    if(unit.runtime==="rust"){
      if(!paths.has(localPath(unit.project,"Cargo.lock")))result.blockers.push({code:"LockfileRequired",path:localPath(unit.project,"Cargo.lock"),message:"Cargo verification requires the reviewed baseline Cargo.lock, including for libraries."});
      result.warnings.push({code:"RustToolchain",path:unit.project,message:"Cargo uses an exact source rust-toolchain version when present, otherwise pinned Rust 1.90.0. Floating channels, git dependencies and unauditable registries block verification."});
    }
    if(unit.runtime==="ruby"){
      if(!paths.has(localPath(unit.project,"Gemfile.lock")))result.blockers.push({code:"LockfileRequired",path:localPath(unit.project,"Gemfile.lock"),message:"Ruby requires its reviewed Gemfile.lock, including an exact BUNDLED WITH version."});
      if(!unitFiles.some(file=>/(^|\/)(test|spec)\//.test(file.path)&&/(_test|_spec)\.rb$|\/test_[^/]+\.rb$/.test(file.path)))result.warnings.push({code:"TestsRequired",path:unit.project,message:"Real RSpec and/or Minitest suites must execute with nonempty, unskipped counters."});
    }
    if(unit.runtime==="cpp"){
      const blocker=nativeDependencyBlocker(files,unit.project);
      if(blocker)result.blockers.push({code:"NativeDependencyAuditUnavailable",path:unit.project,message:blocker});
      result.warnings.push({code:"NativeAuditBoundary",path:unit.project,message:"The CMake system-library adapter executes real compilation/tests/audits, but passing native qualification on the current Debian image is blocked by unrated system-package advisories and large Linux-header OSV inventories. No findings or missing pages may be waived. FetchContent, vendored libraries and external package managers remain blocked."});
    }
    if(unit.runtime==="cobol"&&!paths.has("tests/cobol-contracts.json"))result.blockers.push({code:"CobolContractsRequired",path:"tests/cobol-contracts.json",message:"A reviewed COBOL executable contract manifest must declare every program source and nonempty stdin/stdout/exit assertions. Tests and dependency audit cannot be waived."});
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
      const serverRuntimes=[...new Set(result.projects.map(project=>project.runtime).filter(runtime=>!["npm","pnpm","yarn","python"].includes(runtime)))];
      let qualifiedRewrite=false;
      if(options.scenario==="rewrite"){
        try{
          const acceptance=scenarioAcceptance(files.filter((file):file is ReadinessFile&{content:string}=>file.content!==undefined),"rewrite",false);
          qualifiedRewrite=Boolean(acceptance?.checks.some(check=>check.kind==="contract"&&check.variants.includes("baseline")&&check.variants.includes("candidate")));
          if(!qualifiedRewrite)throw new Error("The same reviewed black-box contract check must run on both baseline and candidate.");
        }catch(error){result.blockers.push({code:"RewriteContractRequired",path:acceptanceManifestPath,message:(error as Error).message});}
      }
      if(serverRuntimes.length&&!serverRuntimes.some(runtime=>targetRuntimes.includes(runtime))&&!qualifiedRewrite)result.blockers.push({code:"CrossRuntimeTarget",message:`The original backend runs on ${serverRuntimes.join(", ")}. Rewriting it to ${options.backendTarget} would remove the original executable tests that prove behavior preservation. Select ${[...new Set(serverRuntimes.map(backendTargetFor).filter(Boolean))].join(" or ")}.`});
    }
  }
  for(const runtime of new Set(result.projects.map(project=>project.runtime)))if(result.projects.filter(project=>project.runtime===runtime).length>8)result.blockers.push({code:"ProjectLimit",message:`Verification currently supports at most eight ${runtime} projects per snapshot.`});
  if(result.projects.length>8)result.blockers.push({code:"CombinedProjectLimit",message:"Verification supports at most eight runtime projects in a mixed snapshot."});
  if(!result.projects.length)result.blockers.push({code:"NoSupportedProject",message:"No configured executable project was found. Reviewed runtime manifests, dependency configuration and executable tests are required; filenames alone cannot establish passing verification."});
  result.supported=result.blockers.length===0;
  return result;
}

export class VerificationReadinessError extends Error {
  constructor(public readiness:VerificationReadiness){
    super(readiness.blockers.map(item=>`${item.path?`${item.path}: `:""}${item.message}`).join(" "));
    this.name="VerificationReadinessError";
  }
}

export async function readVerificationReadiness(files:ReadinessFile[],read:(path:string)=>Promise<string>,options:{scope:ModernizationScope;backendTarget?:string;scenario?:ModernizationScenario}){
  const manifests=files.filter(file=>(readableManifest.test(file.path)||file.path===acceptanceManifestPath)&&!ignoredManifestPath.test(file.path));
  if(manifests.length>200)throw new VerificationReadinessError({supported:false,projects:[],warnings:[],blockers:[{code:"ManifestLimit",message:"More than 200 project manifests were detected; verification needs a smaller explicitly scoped repository."}]});
  const contents=new Map((await mapConcurrent(manifests,6,async file=>({path:file.path,content:(file.size||0)>200000?undefined:await read(file.path)}))).map(file=>[file.path,file.content]));
  const readiness=verificationReadiness(files.map(file=>({...file,content:contents.get(file.path)})),options);
  if(!readiness.supported)throw new VerificationReadinessError(readiness);
  return readiness;
}
