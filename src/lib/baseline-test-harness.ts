import { safeSnapshotPath } from "./verification-evidence";

type SnapshotFile={path:string;content:string;executable:boolean};
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