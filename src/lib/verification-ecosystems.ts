export type EcosystemRuntime="dotnet"|"maven"|"gradle"|"go"|"php"|"rust"|"ruby"|"cpp"|"cobol";

export const dotnetVerificationCommands=["dotnet restore","dotnet build --no-restore -c Release","dotnet test -c Release (all test projects; nonempty; no skips)","dotnet list package --vulnerable --include-transitive --format json"];
export const mavenVerificationCommands=["mvn -B -DskipTests package","mvn -B test (JUnit reports; nonempty; no skips)","Maven runtime dependency audit (dependency:list + OSV)"];
export const gradleVerificationCommands=["gradle assemble","gradle test (JUnit reports; nonempty; no skips)","Gradle runtime dependency audit (runtimeClasspath + OSV)"];
export const goVerificationCommands=["go mod download","go build ./...","go test -json ./... (nonempty; no skips)","govulncheck ./..."];
export const phpVerificationCommands=["composer install --no-interaction --no-progress --prefer-dist --no-scripts","php -l (all project PHP files)","phpunit --log-junit (nonempty; no skips)","composer audit --locked --no-dev --format=json"];
export const rustVerificationCommands=["cargo fetch --locked","cargo build --locked --workspace --all-targets","cargo test --locked --workspace (nonempty; no skips)","Cargo locked dependency audit (metadata + OSV)"];
export const rubyVerificationCommands=["bundle install (frozen source lock)","Ruby syntax compilation","Ruby test suites (RSpec/Minitest; nonempty; no skips)","Ruby locked dependency audit (Bundler + OSV)"];
export const cppVerificationCommands=["cmake configure (Release; system dependencies only)","cmake --build .modernize-build --config Release","ctest (JUnit reports; nonempty; no skips)","Native dependency audit (compiler inventory + Debian OSV)"];
export const cobolVerificationCommands=["cobc -x (all declared programs)","COBOL executable contracts (nonempty; no skips)","Native dependency audit (GnuCOBOL inventory + Debian OSV)"];
export const ecosystemVerificationCommands:Record<EcosystemRuntime,string[]>={dotnet:dotnetVerificationCommands,maven:mavenVerificationCommands,gradle:gradleVerificationCommands,go:goVerificationCommands,php:phpVerificationCommands,rust:rustVerificationCommands,ruby:rubyVerificationCommands,cpp:cppVerificationCommands,cobol:cobolVerificationCommands};
export const ecosystemAuditCommands=new Set([dotnetVerificationCommands[3],mavenVerificationCommands[2],gradleVerificationCommands[2],goVerificationCommands[3],phpVerificationCommands[3],rustVerificationCommands[3],rubyVerificationCommands[3],cppVerificationCommands[3],cobolVerificationCommands[2]]);
export const auditFindingsPrefix="MODERNIZE_AUDIT_FINDINGS ";

export const dotnetProject=/\.(csproj|fsproj|vbproj)$/i;
export const dotnetSolution=/\.(sln|slnx)$/i;
export const ignoredManifestPath=/(^|\/)(vendor|node_modules|testdata|\.git)\//;
export const originalTestPath=/(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[^/]+$|_test\.(go|rb)$|(^|\/)[^/]*\.(?:Unit|Integration)?Tests?\//;
export const testBuildFile=/\.(csproj|fsproj|vbproj)$|(^|\/)(pom\.xml|build\.gradle(\.kts)?|package\.json|Cargo\.toml|CMakeLists\.txt|phpunit\.xml(\.dist)?|Directory\.Build\.(props|targets))$/i;
export function isImmutableOriginalTest(path:string){return originalTestPath.test(path)&&!testBuildFile.test(path);}

export function isDotnetTestProject(content:string){return /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true\s*<\/IsTestProject>|Sdk="MSTest\.Sdk|xunit\.v3|TUnit/i.test(content);}
export function isDotnetFrameworkProject(content:string){return !/<Project\b[^>]*\bSdk\s*=/i.test(content)||[...content.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/gi)].some(match=>match[1].split(";").some(item=>/^net[1-4]\d{1,2}$/i.test(item.trim())))||/<TargetFrameworkVersion>\s*v[1-4]/i.test(content);}
export function dotnetFrameworkMoniker(content:string){
  const version=content.match(/<TargetFrameworkVersion>\s*v(\d)\.(\d)(?:\.(\d))?\s*</i);
  if(version)return `net${version[1]}${version[2]}${version[3]||""}`;
  return content.match(/<TargetFrameworks?>\s*([^<;]+)/i)?.[1].trim();
}
export function requiresWindowsVerifier(files:Array<{path:string;content:string}>){
  return files.some(file=>/(^|\/)packages\.config$/i.test(file.path)&&!ignoredManifestPath.test(file.path)||dotnetProject.test(file.path)&&!ignoredManifestPath.test(file.path)&&isDotnetFrameworkProject(Buffer.from(file.content,"base64").toString("utf8")));
}

const directory=(path:string)=>path.includes("/")?path.slice(0,path.lastIndexOf("/")):".";
function roots(paths:string[],pattern:RegExp){
  const directories=[...new Set(paths.filter(path=>pattern.test(path)&&!ignoredManifestPath.test(path)).map(directory))].sort((first,second)=>first.length-second.length||first.localeCompare(second));
  return directories.filter(candidate=>!directories.some(other=>other!==candidate&&(other==="."||candidate.startsWith(`${other}/`))));
}
function directories(paths:string[],pattern:RegExp){return [...new Set(paths.filter(path=>pattern.test(path)&&!ignoredManifestPath.test(path)).map(directory))].sort();}

export function ecosystemUnits(paths:string[]):Array<{runtime:EcosystemRuntime;project:string}>{
  const maven=roots(paths,/(^|\/)pom\.xml$/);
  const gradle=roots(paths,/(^|\/)(settings|build)\.gradle(\.kts)?$/).filter(project=>!maven.includes(project));
  return [
    ...(paths.some(path=>dotnetProject.test(path)&&!ignoredManifestPath.test(path))?[{runtime:"dotnet" as const,project:"."}]:[]),
    ...maven.map(project=>({runtime:"maven" as const,project})),
    ...gradle.map(project=>({runtime:"gradle" as const,project})),
    ...directories(paths,/(^|\/)go\.mod$/).map(project=>({runtime:"go" as const,project})),
    ...directories(paths,/(^|\/)composer\.json$/).map(project=>({runtime:"php" as const,project})),
    ...roots(paths,/(^|\/)Cargo\.toml$/).map(project=>({runtime:"rust" as const,project})),
    ...directories(paths,/(^|\/)Gemfile$/).map(project=>({runtime:"ruby" as const,project})),
    ...roots(paths,/(^|\/)CMakeLists\.txt$/).map(project=>({runtime:"cpp" as const,project})),
    ...(paths.some(path=>/\.(cob|cbl|cobol|cpy)$/i.test(path)&&!ignoredManifestPath.test(path))?[{runtime:"cobol" as const,project:"."}]:[]),
  ];
}

export type NodeManager={name:"npm"|"pnpm"|"yarn";version?:string;lock:string;classic?:boolean;integrity?:{algorithm:string;hex:string}};
export function nodeManager(manifest:{packageManager?:unknown},paths:string[],project="."):NodeManager{
  const local=(name:string)=>project==="."?name:`${project}/${name}`;
  const locks=[["npm","package-lock.json"],["pnpm","pnpm-lock.yaml"],["yarn","yarn.lock"]].filter(([,lock])=>paths.includes(local(lock)));
  if(locks.length>1)throw new Error("Ambiguous JavaScript package managers: preserve one reviewed manager-owned lockfile.");
  const declared=manifest.packageManager;
  const match=typeof declared==="string"?declared.match(/^(npm|pnpm|yarn)@(\d+\.\d+\.\d+)(?:\+(sha(?:224|256|384|512))\.([a-f0-9]+))?$/):null;
  if(declared&&!match)throw new Error("packageManager must pin a supported manager to an exact stable version.");
  const name=(match?.[1]||locks[0]?.[0]||"npm") as NodeManager["name"];
  if(locks.length&&locks[0][0]!==name)throw new Error("Declared package manager does not own the source lockfile.");
  if(name!=="npm"&&!match)throw new Error(`${name} requires an exact packageManager version; no manager version will be guessed.`);
  if(match?.[3]&&match[4].length!==Number(match[3].slice(3))/4)throw new Error("packageManager has an invalid integrity digest.");
  return {name,version:match?.[2],lock:local(name==="npm"?"package-lock.json":name==="pnpm"?"pnpm-lock.yaml":"yarn.lock"),...(name==="yarn"?{classic:match?.[2].startsWith("1.")}: {}),...(match?.[3]?{integrity:{algorithm:match[3],hex:match[4]}}:{})};
}
export function nodeLockPath(manifestPath:string,files:Array<{path:string;content?:string}>,base64=true):string|undefined{
  if(!/(^|\/)package\.json$/.test(manifestPath)||!files.some(file=>file.path===manifestPath))return undefined;
  const read=(file:{path:string;content?:string})=>{
    if(file.content===undefined)throw new Error(`Missing package manifest content: ${file.path}`);
    return JSON.parse(base64?Buffer.from(file.content,"base64").toString("utf8"):file.content);
  };
  const root=files.find(file=>file.path==="package.json");
  const rootManifest=root?read(root):undefined;
  const workspace=Boolean(root&&(rootManifest?.workspaces||files.some(file=>file.path==="pnpm-workspace.yaml")));
  const selected=workspace?root!:files.find(file=>file.path===manifestPath)!;
  const manager=nodeManager(selected===root?rootManifest:read(selected),files.map(file=>file.path),directory(selected.path));
  return files.some(file=>file.path===manager.lock)?manager.lock:undefined;
}
export const nodeVerificationCommands={
  npm:["npm ci --ignore-scripts --no-fund","npm run build","npm test -- --run","npm audit --omit=dev --audit-level=high"],
  pnpm:["pnpm install --frozen-lockfile --ignore-scripts","pnpm run build","pnpm test (nonempty; no skips)","pnpm audit --prod --json"],
  yarn:["yarn install (immutable lock; scripts disabled)","yarn run build","yarn test (nonempty; no skips)","Yarn production dependency audit (JSON)"],
};
export type PythonManager="requirements"|"poetry"|"uv"|"pipenv";
export function pythonUnits(paths:string[]):Array<{project:string;manager:PythonManager;manifest:string;lock?:string}>{
  const projects=directories(paths,/(^|\/)(requirements\.txt|pyproject\.toml|Pipfile)$/);
  return projects.map(project=>{
    const local=(name:string)=>project==="."?name:`${project}/${name}`;
    const managers=([["poetry","poetry.lock","pyproject.toml"],["uv","uv.lock","pyproject.toml"],["pipenv","Pipfile.lock","Pipfile"]] as const).filter(([,lock])=>paths.includes(local(lock)));
    if(managers.length>1)throw new Error(`Ambiguous Python lock owners in ${project}.`);
    if(managers.length){const [manager,lock,manifest]=managers[0];if(!paths.includes(local(manifest)))throw new Error(`Missing ${manager} manifest in ${project}.`);return {project,manager,lock:local(lock),manifest:local(manifest)};}
    if(paths.includes(local("Pipfile"))||paths.includes(local("pyproject.toml")))throw new Error(`A reviewed Poetry, uv or Pipenv lock is required in ${project}; requirements.txt will not silently replace its manager.`);
    return {project,manager:"requirements" as const,manifest:local("requirements.txt")};
  });
}
export function blockedRuntimeReasons(paths:string[]){
  const reasons:string[]=[];
  if(paths.some(path=>/(^|\/)(Rakefile|[^/]+\.(gemspec|rb|rake))$/i.test(path)&&!ignoredManifestPath.test(path))&&!paths.some(path=>/(^|\/)Gemfile$/.test(path)))reasons.push("Ruby requires a Gemfile and reviewed Gemfile.lock; standalone Ruby has no complete dependency inventory.");
  if(paths.some(path=>/(^|\/)(meson\.build|conanfile\.(txt|py)|conan\.lock|vcpkg\.json|[^/]+\.vcxproj)$/i.test(path)&&!ignoredManifestPath.test(path)))reasons.push("C/C++: Meson, Conan, vcpkg and MSVC dependency/build adapters remain unqualified; their locks cannot be ignored.");
  if(paths.some(path=>/\.(c|cc|cpp|cxx|h|hpp)$/i.test(path)&&!ignoredManifestPath.test(path))&&!paths.some(path=>/(^|\/)CMakeLists\.txt$/.test(path)))reasons.push("C/C++ requires CMake and a complete system dependency inventory; other native builds remain blocked.");
  return reasons;
}
export function nativeDependencyBlocker(files:Array<{path:string;content?:string}>,project:string){
  const scoped=files.filter(file=>project==="."||file.path.startsWith(`${project}/`));
  if(scoped.some(file=>/(^|\/)(vendor|third_party|third-party|external)\//i.test(file.path)))return "Vendored native dependencies have no qualified version inventory; audit remains blocked.";
  for(const file of scoped.filter(file=>/(^|\/)CMakeLists\.txt$|\.cmake$/i.test(file.path))){
    if(file.content===undefined)return `${file.path}: native build manifest is unavailable.`;
    const content=file.content.replace(/#[^\n]*/g,"");
    if(/\b(FetchContent|ExternalProject|CPMAddPackage|pkg_check_modules)\b|\bfile\s*\(\s*DOWNLOAD\b|\b(execute_process|add_custom_command|add_custom_target|cmake_language)\s*\(/i.test(content)||[...content.matchAll(/\bfind_package\s*\(\s*([^\s)]+)/gi)].some(match=>match[1]!=="Threads"))return `${file.path}: external CMake dependency/process mechanisms have no complete qualified audit inventory.`;
  }
}

export function auditFindingsRecorded(log:string){
  const line=log.split("\n").reverse().find(item=>item.startsWith(auditFindingsPrefix));
  if(!line)return false;
  try{
    const report=JSON.parse(line.slice(auditFindingsPrefix.length)) as {findings?:unknown};
    return Array.isArray(report.findings)&&report.findings.length>0&&report.findings.every(item=>{
      const finding=item as Record<string,unknown>;
      return typeof finding.package==="string"&&typeof finding.id==="string"&&typeof finding.severity==="string"&&typeof finding.blocking==="boolean";
    })&&report.findings.some(item=>(item as {blocking:boolean}).blocking);
  }catch{return false;}
}
