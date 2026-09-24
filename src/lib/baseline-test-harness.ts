import { safeSnapshotPath } from "./verification-evidence";
import { ecosystemUnits, isDotnetTestProject, dotnetProject, dotnetFrameworkMoniker } from "./verification-ecosystems";

type SnapshotFile={path:string;content:string;executable:boolean};
const directoryOf=(path:string)=>path.includes("/")?path.slice(0,path.lastIndexOf("/")):".";
const withinUnit=(project:string,path:string)=>project==="."||path.startsWith(`${project}/`);
const decode=(file:SnapshotFile)=>Buffer.from(file.content,"base64").toString("utf8");
function resolveRelative(from:string,reference:string){
  const parts=directoryOf(from)==="."?[]:directoryOf(from).split("/");
  for(const part of reference.replace(/\\/g,"/").split("/")){if(part==="..")parts.pop();else if(part&&part!==".")parts.push(part);}
  return parts.join("/");
}
function retargetCharacterizationProject(project:SnapshotFile,baseline:SnapshotFile[]){
  const content=decode(project);
  const frameworks=[...content.matchAll(/<ProjectReference\s+Include="([^"]+)"/gi)].map(match=>baseline.find(file=>file.path===resolveRelative(project.path,match[1]))).filter((file):file is SnapshotFile=>Boolean(file)).map(file=>dotnetFrameworkMoniker(decode(file))).filter((value):value is string=>Boolean(value));
  const target=frameworks.find(value=>/^net[1-4]\d{1,2}$/.test(value))||frameworks[0];
  if(!target)return project;
  let retargeted=content.replace(/<TargetFrameworks?>[^<]*<\/TargetFrameworks?>/i,`<TargetFramework>${target}</TargetFramework>`);
  if(/^net[1-4]\d{1,2}$/.test(target)&&!/<LangVersion>/i.test(retargeted))retargeted=retargeted.replace(/<\/TargetFramework>/i,"</TargetFramework>\n    <LangVersion>latest</LangVersion>");
  return {...project,content:Buffer.from(retargeted).toString("base64")};
}
function additiveEcosystemTests(files:Map<string,SnapshotFile>,baseline:SnapshotFile[],candidate:SnapshotFile[]){
  const original=new Set(baseline.map(file=>file.path));
  const originalDirectories=new Set(baseline.map(file=>directoryOf(file.path)));
  const add=(file:SnapshotFile)=>{
    if(!safeSnapshotPath(file.path))throw new Error("Unsafe baseline test path.");
    if(files.has(file.path)){if(files.get(file.path)!.content!==file.content)throw new Error(`Baseline harness cannot overwrite existing test: ${file.path}`);return;}
    files.set(file.path,file);
  };
  const additions=candidate.filter(file=>!original.has(file.path));
  const characterization=(path:string)=>/characteri[sz]ation/i.test(path);
  for(const unit of ecosystemUnits(baseline.map(file=>file.path))){
    const scoped=additions.filter(file=>withinUnit(unit.project,file.path));
    if(unit.runtime==="maven"||unit.runtime==="gradle")scoped.filter(file=>/(^|\/)src\/test\//.test(file.path)&&characterization(file.path)).forEach(add);
    if(unit.runtime==="go")scoped.filter(file=>file.path.endsWith("_test.go")&&characterization(file.path)&&originalDirectories.has(directoryOf(file.path))).forEach(add);
    if(unit.runtime==="php"){
      let composer:{"require-dev"?:Record<string,string>}={};
      try{composer=JSON.parse(Buffer.from(baseline.find(file=>file.path===(unit.project==="."?"composer.json":`${unit.project}/composer.json`))?.content||"","base64").toString("utf8"));}catch{}
      if(Object.keys(composer["require-dev"]||{}).some(name=>/^(phpunit\/phpunit|pestphp\/pest)$/i.test(name)))scoped.filter(file=>/(^|\/)tests?\//i.test(file.path)&&characterization(file.path)||/(^|\/)phpunit\.xml(\.dist)?$/.test(file.path)).forEach(add);
    }
    if(unit.runtime==="dotnet"){
      for(const project of additions.filter(file=>dotnetProject.test(file.path)&&isDotnetTestProject(Buffer.from(file.content,"base64").toString("utf8")))){
        const directory=directoryOf(project.path);
        if(directory==="."||originalDirectories.has(directory)||!characterization(directory))continue;
        additions.filter(file=>file.path.startsWith(`${directory}/`)&&file.path!==project.path).forEach(add);
        add(retargetCharacterizationProject(project,baseline));
      }
    }
  }
}
const testTools=new Set(["vitest","jsdom","@testing-library/react","@testing-library/dom","@testing-library/user-event","@testing-library/jest-dom"]);
function automaticHarness(baseline:SnapshotFile[],candidate:SnapshotFile[]){
  const files=new Map(baseline.map(file=>[file.path,file]));
  const copyTests=(prefix:string)=>{
    for(const file of candidate.filter(file=>file.path.startsWith(`${prefix}tests/`)||new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}vitest\\.config\\.[^/]+$`).test(file.path))){
      if(!safeSnapshotPath(file.path))throw new Error("Unsafe baseline test path.");
      if(files.has(file.path)&&files.get(file.path)!.content!==file.content)throw new Error(`Baseline harness cannot overwrite existing test: ${file.path}`);
      files.set(file.path,file);
    }
  };
  for(const project of baseline.filter(file=>/(^|\/)requirements\.txt$/.test(file.path))){
    const prefix=project.path.slice(0,-"requirements.txt".length);
    for(const file of candidate.filter(file=>file.path.startsWith(`${prefix}tests/`)&&file.path.endsWith(".py"))){
      if(!safeSnapshotPath(file.path))throw new Error("Unsafe baseline Python test path.");
      if(files.has(file.path)&&files.get(file.path)!.content!==file.content)throw new Error(`Baseline harness cannot overwrite existing test: ${file.path}`);
      files.set(file.path,file);
    }
    const development=candidate.find(file=>file.path===`${prefix}requirements-dev.txt`);
    if(development&&!files.has(development.path)){
      const requirements=Buffer.from(development.content,"base64").toString("utf8").split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
      if(requirements.some(line=>!/^(httpx|pytest|hypothesis|coverage|pytest-cov)==[0-9][a-zA-Z0-9.!+_-]*$/.test(line)))throw new Error("Baseline test dependencies must be pinned, allowlisted test tools.");
      files.set(development.path,development);
    }
  }
  for(const original of baseline.filter(file=>/(^|\/)package\.json$/.test(file.path))){
    const source=JSON.parse(Buffer.from(original.content,"base64").toString("utf8"));
    if(typeof source.scripts?.test==="string"&&source.scripts.test.trim())continue;
    const proposal=candidate.find(file=>file.path===original.path);
    if(!proposal)continue;
    const updated=JSON.parse(Buffer.from(proposal.content,"base64").toString("utf8"));
    if(typeof updated.scripts?.test!=="string"||!/^vitest(?:\s+--config\s+(?:tests\/)?vitest\.config\.(?:ts|mts|js|mjs))?$/.test(updated.scripts.test))continue;
    const tools=Object.fromEntries(Object.entries(updated.devDependencies||{}).filter(([name])=>testTools.has(name)&&!source.dependencies?.[name]&&!source.devDependencies?.[name]));
    const manifest={...source,devDependencies:{...source.devDependencies,...tools},scripts:{...source.scripts,test:updated.scripts.test}};
    copyTests(original.path.slice(0,-"package.json".length));
    files.set(original.path,{...original,content:Buffer.from(JSON.stringify(manifest)).toString("base64")});
  }
  additiveEcosystemTests(files,baseline,candidate);
  return [...files.values()];
}
export function applyBaselineTestHarness(baseline:SnapshotFile[],candidate:SnapshotFile[]) {
  const configuration=candidate.find(file=>file.path==="tests/baseline-harness.json");
  if(!configuration)return automaticHarness(baseline,candidate);
  const harness=JSON.parse(Buffer.from(configuration.content,"base64").toString("utf8"));
  const original=baseline.find(file=>file.path==="package.json");
  if(!original)throw new Error("Baseline test harness requires a root npm project.");
  const manifest=JSON.parse(Buffer.from(original.content,"base64").toString("utf8"));
  if(typeof manifest.scripts?.test==="string"&&manifest.scripts.test.trim())throw new Error("Baseline harness must not replace an existing test command.");
  if(typeof harness.manifest!=="object"||!harness.manifest||!harness.lockfile)throw new Error("Invalid baseline test harness.");
  const expected={...manifest,devDependencies:{...manifest.devDependencies,...harness.devDependencies},scripts:{...manifest.scripts,test:harness.testScript}};
  const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([first],[second])=>first.localeCompare(second))):item);
  if(canonical(harness.manifest)!==canonical(expected)||typeof harness.testScript!=="string")throw new Error("Baseline harness may add test tooling only, not alter existing source configuration.");
  if(harness.testScript!=="vitest --config tests/vitest.config.mjs")throw new Error("Unsupported baseline harness command.");
  const tools=new Set(["vitest","jsdom","@testing-library/react","@testing-library/dom"]);
  if(!harness.devDependencies||Object.keys(harness.devDependencies).some(name=>!tools.has(name)))throw new Error("Unapproved baseline test tooling.");
  const files=new Map(baseline.map(file=>[file.path,file]));
  for(const file of candidate.filter(file=>file.path.startsWith("tests/")&&file.path!==configuration.path)){
    if(!safeSnapshotPath(file.path))throw new Error("Unsafe baseline test path.");
    if(files.has(file.path)&&files.get(file.path)!.content!==file.content)throw new Error(`Baseline harness cannot overwrite existing test: ${file.path}`);
    files.set(file.path,file);
  }
  files.set("package.json",{path:"package.json",content:Buffer.from(JSON.stringify(expected)).toString("base64"),executable:false});
  files.set("package-lock.json",{path:"package-lock.json",content:Buffer.from(JSON.stringify(harness.lockfile)).toString("base64"),executable:false});
  return [...files.values()];
}