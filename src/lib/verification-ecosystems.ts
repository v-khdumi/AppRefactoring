export type EcosystemRuntime="dotnet"|"maven"|"gradle"|"go"|"php";

export const dotnetVerificationCommands=["dotnet restore","dotnet build --no-restore -c Release","dotnet test -c Release (all test projects; nonempty; no skips)","dotnet list package --vulnerable --include-transitive --format json"];
export const mavenVerificationCommands=["mvn -B -DskipTests package","mvn -B test (JUnit reports; nonempty; no skips)","Maven runtime dependency audit (dependency:list + OSV)"];
export const gradleVerificationCommands=["gradle assemble","gradle test (JUnit reports; nonempty; no skips)","Gradle runtime dependency audit (runtimeClasspath + OSV)"];
export const goVerificationCommands=["go mod download","go build ./...","go test -json ./... (nonempty; no skips)","govulncheck ./..."];
export const phpVerificationCommands=["composer install --no-interaction --no-progress --prefer-dist --no-scripts","php -l (all project PHP files)","phpunit --log-junit (nonempty; no skips)","composer audit --locked --no-dev --format=json"];
export const ecosystemVerificationCommands:Record<EcosystemRuntime,string[]>={dotnet:dotnetVerificationCommands,maven:mavenVerificationCommands,gradle:gradleVerificationCommands,go:goVerificationCommands,php:phpVerificationCommands};
export const ecosystemAuditCommands=new Set([dotnetVerificationCommands[3],mavenVerificationCommands[2],gradleVerificationCommands[2],goVerificationCommands[3],phpVerificationCommands[3]]);
export const auditFindingsPrefix="MODERNIZE_AUDIT_FINDINGS ";

export const dotnetProject=/\.(csproj|fsproj|vbproj)$/i;
export const dotnetSolution=/\.(sln|slnx)$/i;
export const ignoredManifestPath=/(^|\/)(vendor|node_modules|testdata|\.git)\//;
export const originalTestPath=/(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[^/]+$|_test\.go$|(^|\/)[^/]*\.(?:Unit|Integration)?Tests?\//;
export const testBuildFile=/\.(csproj|fsproj|vbproj)$|(^|\/)(pom\.xml|build\.gradle(\.kts)?|package\.json|phpunit\.xml(\.dist)?|Directory\.Build\.(props|targets))$/i;
export function isImmutableOriginalTest(path:string){return originalTestPath.test(path)&&!testBuildFile.test(path);}

export function isDotnetTestProject(content:string){return /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true\s*<\/IsTestProject>|Sdk="MSTest\.Sdk|xunit\.v3|TUnit/i.test(content);}

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
  ];
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
