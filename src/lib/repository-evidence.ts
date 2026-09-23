import type {ModernizationScope} from "../types/modernization";
export type RepositoryEvidence=ReturnType<typeof repositoryEvidence>;
export const dependencyManifest=/(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.(?:csproj|fsproj|vbproj)|packages\.config|Directory\.Packages\.props|go\.mod|Cargo\.toml|Gemfile|composer\.json)$/i;
export const dependencyLock=/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|Pipfile\.lock|packages\.lock\.json|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/i;
const sourceFile=/\.(cs|java|py|tsx?|jsx?|vb|sql|go|rs|php|html|css|vue)$/i;
const configuration=/(^|\/)(Dockerfile|[^/]+\.Dockerfile|[^/]+\.sln|tsconfig[^/]*\.json|vite\.config\.[^/]+|global\.json)$/i;
export function selectEvidenceFiles<T extends {path:string;size?:number}>(files:T[],scope:ModernizationScope,limit=24){
  const score=(file:T)=>dependencyManifest.test(file.path)?0:configuration.test(file.path)?1:scope==="frontend"&&/\.(tsx?|jsx?|html|css|vue)$/.test(file.path)?2:scope==="backend"&&/\.(cs|java|py|sql|go|rs|php)$/.test(file.path)?2:3;
  return files.filter(file=>(dependencyManifest.test(file.path)||configuration.test(file.path)||sourceFile.test(file.path))&&(file.size||0)<=80000&&!/(^|\/)(node_modules|vendor|dist|\.git|\.venv)\//.test(file.path))
    .sort((first,second)=>score(first)-score(second)||first.path.localeCompare(second.path)).slice(0,limit);
}
export function repositoryEvidence(paths:string[],samples:Array<{path:string;content:string}>,scope:ModernizationScope){
  const manifests=paths.filter(path=>dependencyManifest.test(path));
  const locks=paths.filter(path=>dependencyLock.test(path));
  const read=new Set(samples.map(file=>file.path));
  const declared=samples.filter(file=>file.path.endsWith("package.json")).flatMap(file=>{
    try{const manifest=JSON.parse(file.content);return [{path:file.path,engines:manifest.engines||{},workspaces:manifest.workspaces||null,dependencies:manifest.dependencies||{},devDependencies:manifest.devDependencies||{},peerDependencies:manifest.peerDependencies||{},scripts:manifest.scripts||{}}];}catch{return [];}
  });
  return {scope,manifests,lockfiles:locks,readManifests:manifests.filter(path=>read.has(path)),omittedManifests:manifests.filter(path=>!read.has(path)),sampledPaths:[...read],declaredPackages:declared,
    limits:["Bounded source and manifest samples; not a complete import/call graph.","Lockfiles are inventoried by path, not fully resolved or audited during AI analysis.","Cross-project APIs, shared libraries, runtime compatibility and transitive dependencies require executed validation."]};
}