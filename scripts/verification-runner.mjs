import { mkdir, writeFile, readFile, open, chown, chmod, readdir, rm, rename } from "node:fs/promises";
import {constants,createWriteStream,existsSync} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export function pythonProjectsFor(files) {
  const units=pythonUnits(files.map(file=>file.path));
  if(units.length>8)throw new Error("Verification supports at most eight Python projects.");
  return units.map(unit=>unit.project);
}
export function pythonUnits(paths){
  return manifestDirectories(paths,/(^|\/)(requirements\.txt|pyproject\.toml|Pipfile)$/).map(project=>{
    const managers=[["poetry","poetry.lock","pyproject.toml"],["uv","uv.lock","pyproject.toml"],["pipenv","Pipfile.lock","Pipfile"]].filter(([,lock])=>paths.includes(local(project,lock)));
    if(managers.length>1)throw new Error(`Ambiguous Python lock owners in ${project}.`);
    if(managers.length){const [manager,lock,manifest]=managers[0];if(!paths.includes(local(project,manifest)))throw new Error(`Missing ${manager} manifest in ${project}.`);return {project,manager,lock:local(project,lock),manifest:local(project,manifest)};}
    if(paths.includes(local(project,"Pipfile"))||paths.includes(local(project,"pyproject.toml")))throw new Error(`A reviewed Poetry, uv or Pipenv lock is required in ${project}; requirements.txt will not silently replace its manager.`);
    return {project,manager:"requirements",manifest:local(project,"requirements.txt")};
  });
}

export const pythonCommands=[
  "python3 -m venv .verification-venv",
  ".verification-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: --upgrade pip setuptools -r requirements.txt",
  ".verification-venv/bin/python -m compileall -q -x /[.]verification-venv/ .",
  "xvfb-run Python unittest discovery (tests/test_*.py; nonempty; no skips)",
  "pip-audit --path .verification-venv/lib/python3.11/site-packages --format json",
];
export const pythonTestDependenciesCommand=".verification-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: -c requirements.txt -r requirements-dev.txt";
export const managedPythonCommands={
  poetry:[pythonCommands[0],"poetry sync (locked; all groups; no root)",...pythonCommands.slice(2)],
  uv:[pythonCommands[0],"uv sync --frozen --all-groups --no-install-project",...pythonCommands.slice(2)],
  pipenv:["python3 -m venv .venv","pipenv sync --dev (locked)",".venv/bin/python -m compileall -q -x /[.]venv/ .",pythonCommands[3],"pip-audit --path .venv/lib/python3.11/site-packages --format json"],
};
export function pythonAuditFindings(log){
  try{
    const report=JSON.parse(log.slice(log.indexOf('{')));
    return Array.isArray(report.dependencies)&&report.dependencies.length>0&&report.dependencies.every(item=>typeof item.name==='string'&&typeof item.version==='string'&&!item.skip_reason&&Array.isArray(item.vulns)&&item.vulns.every(vuln=>typeof vuln.id==='string'&&vuln.id.length>0))&&report.dependencies.some(item=>item.vulns.length>0);
  }catch{return false;}
}
export function completePythonAudit(step){
  if(step.timedOut||![0,1].includes(step.exitCode))return step;
  try{
    const text=step.output||step.log;
    const report=JSON.parse(text.slice(text.indexOf("{")));
    if(!Array.isArray(report.dependencies)||!report.dependencies.every(item=>typeof item.name==="string"&&typeof item.version==="string"&&!item.skip_reason&&Array.isArray(item.vulns)&&item.vulns.every(vuln=>typeof vuln.id==="string"&&vuln.id.length)))throw new Error("Unresolved packages or incomplete dependency inventory.");
    const vulnerable=report.dependencies.some(item=>item.vulns.length);
    if((step.exitCode===1)!==vulnerable)throw new Error("Audit exit status does not match the vulnerability inventory.");
    return step;
  }catch(error){return {...step,exitCode:2,log:`${step.log}\nPython dependency audit is incomplete: ${error.message}`.slice(-32000)};}
}
const unittestProgram=`import sys, unittest, json
suite = unittest.defaultTestLoader.discover('tests', pattern='test_*.py')
result = unittest.TextTestRunner(verbosity=2).run(suite)
print('MODERNIZE_TEST_COUNTS ' + json.dumps(dict(tests=result.testsRun, failed=len(result.failures)+len(result.errors)+len(result.unexpectedSuccesses), skipped=len(result.skipped)+len(result.expectedFailures))))
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
  let step={...await executeCommand(command,args,cwd,uid),command:index===5?pythonTestDependenciesCommand:pythonCommands[index]};
  if(index===3)step=enforceExecutedTests(step,pythonTestCounts(step.log));
  return step;
}
export function pythonTestCounts(output){
  try{return JSON.parse(output.split("\n").findLast(line=>line.startsWith("MODERNIZE_TEST_COUNTS ")).slice("MODERNIZE_TEST_COUNTS ".length));}
  catch{return {tests:0,failed:0,skipped:0};}
}
export async function runManagedPythonCommand(unit,index,cwd,uid,tools=defaultTools){
  const venv=unit.manager==="pipenv"?".venv":".verification-venv";
  const python=path.join(cwd,venv,"bin/python");
  const env={VIRTUAL_ENV:path.join(cwd,venv),PATH:`${path.join(cwd,venv,"bin")}:/opt/verification-tools/bin:/usr/local/bin:/usr/bin:/bin`,UV_PROJECT_ENVIRONMENT:path.join(cwd,venv),UV_PYTHON_DOWNLOADS:"never",PIPENV_VENV_IN_PROJECT:"1",PIPENV_IGNORE_VIRTUALENVS:"1",POETRY_VIRTUALENVS_CREATE:"false",POETRY_NO_INTERACTION:"1"};
  const invocations=[
    {command:"python3",args:["-m","venv",venv]},
    unit.manager==="poetry"?{command:"/opt/verification-tools/bin/poetry",args:["sync","--all-groups","--no-root","--no-interaction"]}:unit.manager==="uv"?{command:"/opt/verification-tools/bin/uv",args:["sync","--frozen","--all-groups","--no-install-project"]}:{command:"/opt/verification-tools/bin/pipenv",args:["sync","--dev"]},
    {command:python,args:["-m","compileall","-q","-x",`/[.]${venv.slice(1)}/`,"."]},
    {command:"xvfb-run",args:["--auto-servernum",python,"-c",unittestProgram]},
    {command:"/opt/verification-tools/bin/pip-audit",args:["--path",path.join(cwd,venv,"lib/python3.11/site-packages"),"--format","json"]},
  ];
  const selected=invocations[index];
  if(index===1&&unit.manager!=="poetry"){
    const checked=await tools.execute(`/opt/verification-tools/bin/${unit.manager}`,unit.manager==="uv"?["lock","--check"]:["verify"],cwd,uid,900000,env);
    if(checked.exitCode!==0||checked.timedOut)return {...checked,command:managedPythonCommands[unit.manager][index]};
  }
  let step={...await tools.execute(selected.command,selected.args,cwd,uid,900000,env),command:managedPythonCommands[unit.manager][index]};
  if(index===3)step=enforceExecutedTests(step,pythonTestCounts(step.log));
  return step;
}

export const nodeCommands={
  npm:["npm ci --ignore-scripts --no-fund","npm run build","npm test -- --run","npm audit --omit=dev --audit-level=high"],
  pnpm:["pnpm install --frozen-lockfile --ignore-scripts","pnpm run build","pnpm test (nonempty; no skips)","pnpm audit --prod --json"],
  yarn:["yarn install (immutable lock; scripts disabled)","yarn run build","yarn test (nonempty; no skips)","Yarn production dependency audit (JSON)"],
};
export function nodeManager(manifest,paths,project="."){
  const locks=[["npm","package-lock.json"],["pnpm","pnpm-lock.yaml"],["yarn","yarn.lock"]].filter(([,lock])=>paths.includes(local(project,lock)));
  if(locks.length>1)throw new Error("Ambiguous JavaScript package managers: preserve one reviewed manager-owned lockfile.");
  const declared=manifest.packageManager;
  const match=typeof declared==="string"?declared.match(/^(npm|pnpm|yarn)@(\d+\.\d+\.\d+)(?:\+(sha(?:224|256|384|512))\.([a-f0-9]+))?$/):null;
  if(declared&&!match)throw new Error("packageManager must pin a supported manager to an exact stable version.");
  const name=match?.[1]||locks[0]?.[0]||"npm";
  if(locks.length&&locks[0][0]!==name)throw new Error("Declared package manager does not own the source lockfile.");
  if(name!=="npm"&&!match)throw new Error(`${name} requires an exact packageManager version; no manager version will be guessed.`);
  if(match?.[3]&&match[4].length!==Number(match[3].slice(3))/4)throw new Error("packageManager has an invalid integrity digest.");
  return {name,version:match?.[2],lock:local(project,name==="npm"?"package-lock.json":name==="pnpm"?"pnpm-lock.yaml":"yarn.lock"),...(name==="yarn"?{classic:match?.[2].startsWith("1.")}: {}),...(match?.[3]?{integrity:{algorithm:match[3],hex:match[4]}}:{})};
}
export function managerExecutable(manager){
  return manager.version?`/opt/modernize/node-managers/${manager.name}-${manager.version}/node_modules/${manager.name==="yarn"&&!manager.classic?"@yarnpkg/cli-dist":manager.name}/bin/${manager.name==="yarn"?"yarn.js":manager.name==="pnpm"?"pnpm.cjs":"npm-cli.js"}`:"npm";
}

export function projectsFor(files,{requireScripts=true,requireLock=true}={}) {
  const paths=new Set(files.map(file=>file.path));
  const manifests=files.filter(file=>(file.path==="package.json"||file.path.endsWith("/package.json"))&&!ignoredManifestPath.test(file.path));
  if(!manifests.length)throw new Error("Unsupported repository: no Node/npm package.json found.");
  const root=manifests.find(file=>file.path==="package.json");
  const rootPackage=root?JSON.parse(Buffer.from(root.content,"base64").toString("utf8")):undefined;
  const selected=root&&(rootPackage?.workspaces||paths.has("pnpm-workspace.yaml"))?[root]:manifests;
  if(selected.length>8)throw new Error("Verification supports at most eight independently buildable npm projects.");
  return selected.map(file=>{
    const manifest=JSON.parse(Buffer.from(file.content,"base64").toString("utf8"));
    const project=path.posix.dirname(file.path);
    const manager=nodeManager(manifest,[...paths],project);
    if(requireLock&&!paths.has(manager.lock))throw new Error(`Missing ${manager.lock}; reproducible ${manager.name} install cannot run.`);
    if(requireScripts&&(typeof manifest.scripts?.build!=="string"||!manifest.scripts.build.trim()||typeof manifest.scripts?.test!=="string"||!manifest.scripts.test.trim()))throw new Error(`${file.path} must define nonempty build and test scripts.`);
    return project;
  });
}

export async function readPreparedFile(filePath,options){
  const limit=typeof options==="object"&&options?.limit?options.limit:2_000_000;
  const file=await open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const metadata=await file.stat();
    if(!metadata.isFile()||metadata.size>limit||![10001,10002].includes(metadata.uid))throw new Error("Prepared artifacts must be bounded regular files owned by the verifier user.");
    return await file.readFile("utf8");
  }finally{await file.close();}
}

export const dotnetCommands=["dotnet restore","dotnet build --no-restore -c Release","dotnet test -c Release (all test projects; nonempty; no skips)","dotnet list package --vulnerable --include-transitive --format json"];
export const mavenCommands=["mvn -B -DskipTests package","mvn -B test (JUnit reports; nonempty; no skips)","Maven runtime dependency audit (dependency:list + OSV)"];
export const gradleCommands=["gradle assemble","gradle test (JUnit reports; nonempty; no skips)","Gradle runtime dependency audit (runtimeClasspath + OSV)"];
export const goCommands=["go mod download","go build ./...","go test -json ./... (nonempty; no skips)","govulncheck ./..."];
export const phpCommands=["composer install --no-interaction --no-progress --prefer-dist --no-scripts","php -l (all project PHP files)","phpunit --log-junit (nonempty; no skips)","composer audit --locked --no-dev --format=json"];
export const rustCommands=["cargo fetch --locked","cargo build --locked --workspace --all-targets","cargo test --locked --workspace (nonempty; no skips)","Cargo locked dependency audit (metadata + OSV)"];
export const rubyCommands=["bundle install (frozen source lock)","Ruby syntax compilation","Ruby test suites (RSpec/Minitest; nonempty; no skips)","Ruby locked dependency audit (Bundler + OSV)"];
export const cppCommands=["cmake configure (Release; system dependencies only)","cmake --build .modernize-build --config Release","ctest (JUnit reports; nonempty; no skips)","Native dependency audit (compiler inventory + Debian OSV)"];
export const cobolCommands=["cobc -x (all declared programs)","COBOL executable contracts (nonempty; no skips)","Native dependency audit (GnuCOBOL inventory + Debian OSV)"];
export const ecosystemCommands={dotnet:dotnetCommands,maven:mavenCommands,gradle:gradleCommands,go:goCommands,php:phpCommands,rust:rustCommands,ruby:rubyCommands,cpp:cppCommands,cobol:cobolCommands};
export const auditFindingsPrefix="MODERNIZE_AUDIT_FINDINGS ";
export const toolchains={
  nativeDebian:{ruby:"3.1.2-7+deb12u1",cmake:"3.25.1-1",gnucobol:"3.1.2-5+b1",gcc:"4:12.2.0-3",gcc12:"12.2.0-14+deb12u1",make:"4.3-4.1",binutils:"2.40-2"},
  rustup:{version:"1.28.2",url:"https://static.rust-lang.org/rustup/archive/1.28.2/x86_64-unknown-linux-gnu/rustup-init",sha256:"20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c"},
  pythonManagers:{poetry:"2.2.1",uv:"0.9.9",pipenv:"2025.0.4"},
  dotnetSdk:{version:"10.0.401",url:"https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.401/dotnet-sdk-10.0.401-linux-x64.tar.gz",sha512:"51c8b999af9e8dd9998c9edc5944e19a90788862068acd38694e098889054ce8c23d4f0c5cccfa16bf187d044562359e5ee69a9f8ad0bbe913ba90311fbce25b"},
  dotnetInstall:{url:"https://raw.githubusercontent.com/dotnet/install-scripts/e5cf1dd2d1540ed05ac84f8eb8c5cdec2807621e/src/dotnet-install.sh",sha256:"082f7685e156738a1b2e2ed8381a621870d4ce8e8c59278034556f05c186eb2e"},
  temurin:{
    8:{url:"https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u504-b01/OpenJDK8U-jdk_x64_linux_hotspot_8u504b01.tar.gz",sha256:"9c70e102f527ac674ac2fe9c7d47b9a04e2d19842ba5ab8e9b33f368bbadfaea"},
    11:{url:"https://github.com/adoptium/temurin11-binaries/releases/download/jdk-11.0.32.1%2B1/OpenJDK11U-jdk_x64_linux_hotspot_11.0.32.1_1.tar.gz",sha256:"5c3f68887c325d36d852ba534303e1f5f1f5cae7d6cc1e951d73e0d8e98a058d"},
    17:{url:"https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz",sha256:"3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e"},
    21:{url:"https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz",sha256:"ce79869e1307ed8ee1e2baa86a412b1eb5b75d10a01006d788a6f968bcfaee94"},
    25:{url:"https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jdk_x64_linux_hotspot_25.0.4.1_1.tar.gz",sha256:"dbb698396d478e7fa2b1e50f4103324b2a99b90569ee27c33f2261f9215cf41e"},
  },
  maven:{version:"3.9.16",url:"https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.16/apache-maven-3.9.16-bin.tar.gz",sha512:"831a8591fe20c8243b1dbe7d71e3244f31d1665b0804b2e825e38cbbe5ce0cafb8338851f90780735568773e0a6cd07bbec107cda0b896b008b861075358b6f6"},
  gradle:{version:"9.7.1",url:"https://services.gradle.org/distributions/gradle-9.7.1-bin.zip",sha256:"acd53f1edaf02f1a8ff99879f8a34b302661a057d9b063ae9e35b552f804d20a"},
  go:{version:"1.27.1",url:"https://go.dev/dl/go1.27.1.linux-amd64.tar.gz",sha256:"63d339f0da5ab53635a56f2490a7984dfe12dfcff22ad749f63edaf590168445"},
  govulncheck:"golang.org/x/vuln/cmd/govulncheck@v1.8.0",
  mavenDependencyPlugin:"org.apache.maven.plugins:maven-dependency-plugin:3.11.0:list",
  suryKeyring:{url:"https://packages.sury.org/debsuryorg-archive-keyring.deb",sha256:"7511384559c9ddf1d5ce5f60be429ae9d4e7d01d9480d6f1b7a30c0810cf8b60"},
  composer:{current:{url:"https://getcomposer.org/download/2.10.3/composer.phar",sha256:"7a2d379d5b8ffdaa028580ef26494c36d2feef4b178d3dd1473a4dbc5e17c8d6",path:"/opt/composer/composer-2.10.3.phar"},lts:{url:"https://getcomposer.org/download/2.2.30/composer.phar",sha256:"8c2b4478b64f8f7cdf1574838fdb0033b29049ca821dad452db7a3dcfcdbffc2",path:"/opt/composer/composer-2.2.30.phar"}},
};

const dotnetProject=/\.(csproj|fsproj|vbproj)$/i;
const dotnetSolution=/\.(sln|slnx)$/i;
const ignoredManifestPath=/(^|\/)(vendor|node_modules|testdata|\.git)\//;
export function isImmutableOriginalTest(value){
  return /(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[^/]+$|_test\.(go|rb)$|(^|\/)[^/]*\.(?:Unit|Integration)?Tests?\//.test(value)&&!/\.(csproj|fsproj|vbproj)$|(^|\/)(pom\.xml|build\.gradle(\.kts)?|package\.json|Cargo\.toml|CMakeLists\.txt|phpunit\.xml(\.dist)?|Directory\.Build\.(props|targets))$/i.test(value);
}
const decoded=file=>file?Buffer.from(file.content,"base64").toString("utf8"):"";
const inUnit=(project,filePath)=>project==="."||filePath.startsWith(`${project}/`);
const local=(project,name)=>project==="."?name:`${project}/${name}`;
export function isDotnetTestProject(content){return /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true\s*<\/IsTestProject>|Sdk="MSTest\.Sdk|xunit\.v3|TUnit/i.test(content);}
function manifestRoots(paths,pattern){
  const directories=[...new Set(paths.filter(item=>pattern.test(item)&&!ignoredManifestPath.test(item)).map(item=>path.posix.dirname(item)))].sort((first,second)=>first.length-second.length||first.localeCompare(second));
  return directories.filter(candidate=>!directories.some(other=>other!==candidate&&(other==="."||candidate.startsWith(`${other}/`))));
}
function manifestDirectories(paths,pattern){return [...new Set(paths.filter(item=>pattern.test(item)&&!ignoredManifestPath.test(item)).map(item=>path.posix.dirname(item)))].sort();}
export function ecosystemUnits(paths){
  const maven=manifestRoots(paths,/(^|\/)pom\.xml$/);
  const gradle=manifestRoots(paths,/(^|\/)(settings|build)\.gradle(\.kts)?$/).filter(project=>!maven.includes(project));
  return [
    ...(paths.some(item=>dotnetProject.test(item)&&!ignoredManifestPath.test(item))?[{runtime:"dotnet",project:"."}]:[]),
    ...maven.map(project=>({runtime:"maven",project})),
    ...gradle.map(project=>({runtime:"gradle",project})),
    ...manifestDirectories(paths,/(^|\/)go\.mod$/).map(project=>({runtime:"go",project})),
    ...manifestDirectories(paths,/(^|\/)composer\.json$/).map(project=>({runtime:"php",project})),
    ...manifestRoots(paths,/(^|\/)Cargo\.toml$/).map(project=>({runtime:"rust",project})),
    ...manifestDirectories(paths,/(^|\/)Gemfile$/).map(project=>({runtime:"ruby",project})),
    ...manifestRoots(paths,/(^|\/)CMakeLists\.txt$/).map(project=>({runtime:"cpp",project})),
    ...(paths.some(item=>/\.(cob|cbl|cobol|cpy)$/i.test(item)&&!ignoredManifestPath.test(item))?[{runtime:"cobol",project:"."}]:[]),
  ];
}
export function blockedRuntimeReasons(paths){
  const reasons=[];
  if(paths.some(item=>/(^|\/)(Rakefile|[^/]+\.(gemspec|rb|rake))$/i.test(item)&&!ignoredManifestPath.test(item))&&!paths.some(item=>/(^|\/)Gemfile$/.test(item)))reasons.push("Ruby requires a Gemfile and reviewed Gemfile.lock; standalone Ruby has no complete dependency inventory.");
  if(paths.some(item=>/(^|\/)(meson\.build|conanfile\.(txt|py)|conan\.lock|vcpkg\.json|[^/]+\.vcxproj)$/i.test(item)&&!ignoredManifestPath.test(item)))reasons.push("C/C++: Meson, Conan, vcpkg and MSVC dependency/build adapters remain unqualified; their locks cannot be ignored.");
  if(paths.some(item=>/\.(c|cc|cpp|cxx|h|hpp)$/i.test(item)&&!ignoredManifestPath.test(item))&&!paths.some(item=>/(^|\/)CMakeLists\.txt$/.test(item)))reasons.push("C/C++ requires CMake and a complete system dependency inventory; other native builds remain blocked.");
  return reasons;
}
export function bundlerVersion(files,project){
  const lock=files.find(file=>file.path===local(project,"Gemfile.lock"));
  const version=decoded(lock).match(/^BUNDLED WITH\s*\r?\n\s+(\d+\.\d+\.\d+)\s*$/m)?.[1];
  if(!version)throw new Error(`Ruby requires the source Gemfile.lock with an exact BUNDLED WITH version: ${project}`);
  const declared=decoded(files.find(file=>file.path===local(project,".ruby-version"))).trim().replace(/^ruby-/,"")||decoded(files.find(file=>file.path===local(project,"Gemfile"))).match(/^\s*ruby\s+["']([^"']+)["']/m)?.[1];
  if(declared&&declared!=="3.1.2")throw new Error(`Ruby ${declared} is not qualified by the pinned Ruby 3.1.2 Debian toolchain.`);
  return version;
}
export function rustVersion(files,project){
  const file=files.find(file=>file.path===local(project,"rust-toolchain.toml"))||files.find(file=>file.path===local(project,"rust-toolchain"))||files.find(file=>file.path==="rust-toolchain.toml"||file.path==="rust-toolchain");
  if(!file)return "1.90.0";
  const content=decoded(file).trim();
  const version=file.path.endsWith(".toml")?content.match(/^\s*channel\s*=\s*["']([^"']+)["']/m)?.[1]:content;
  if(!/^\d+\.\d+\.\d+$/.test(version||""))throw new Error("Rust requires an exact stable rust-toolchain version; floating channels are not reproducible.");
  return version;
}

const jdkFeatures=[8,11,17,21,25];
export function javaFeature(files,project,runtime){
  const sources=files.filter(file=>inUnit(project,file.path)&&!ignoredManifestPath.test(file.path)&&(runtime==="maven"?/(^|\/)pom\.xml$/.test(file.path):/(^|\/)((build|settings)\.gradle(\.kts)?|gradle\.properties)$/.test(file.path))).map(decoded).join("\n");
  const found=[];
  for(const pattern of [/<maven\.compiler\.(?:release|source|target)>\s*(?:1\.)?(\d+)\s*</g,/<java\.version>\s*(?:1\.)?(\d+)\s*</g,/<(release|source|target)>\s*(?:1\.)?(\d+)\s*<\/\1>/g,/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/g,/jvmToolchain\(\s*(\d+)\s*\)/g,/JavaVersion\.VERSION_(?:1_)?(\d+)/g,/(?:source|target)Compatibility\s*=\s*['"]?(?:1\.)?(\d+)/g]){
    for(const match of sources.matchAll(pattern))found.push(Number(match[match.length-1]));
  }
  const boot=sources.match(/spring-boot[\w-]*<\/artifactId>\s*<version>\s*(\d+)\./)||sources.match(/org\.springframework\.boot['"]?\)?\s*version\s*['"](\d+)\./);
  if(boot&&Number(boot[1])>=3)found.push(17);
  const required=found.filter(value=>value>=5&&value<=40);
  let target=required.length?Math.max(...required):runtime==="maven"?11:17;
  if(runtime==="gradle"&&!files.some(file=>file.path===local(project,"gradlew")))target=Math.max(target,17);
  return jdkFeatures.find(feature=>feature>=target)||25;
}

const phpVersions=["5.6","7.0","7.1","7.2","7.3","7.4","8.0","8.1","8.2","8.3","8.4","8.5"];
const versionParts=value=>value.split(".").map(Number);
const compareVersions=(first,second)=>{const a=versionParts(first),b=versionParts(second);for(let index=0;index<3;index++){const difference=(a[index]||0)-(b[index]||0);if(difference)return difference;}return 0;};
export function phpSatisfies(version,constraint){
  if(!constraint||!constraint.trim())return true;
  return constraint.split("||").some(alternative=>alternative.trim().split(/[\s,]+/).filter(Boolean).every(term=>{
    const match=term.replace(/^v/,"").match(/^(\^|~|>=|<=|>|<|==|=|!=)?\s*(\d+)(?:\.(\d+|\*))?(?:\.(\d+|\*))?/);
    if(term==="*"||!match)return true;
    const [,operator="",major,minorText,patchText]=match;
    const minor=minorText===undefined||minorText==="*"?undefined:Number(minorText);
    const bound=`${major}.${minor??0}.${patchText&&patchText!=="*"?patchText:0}`;
    const [actualMajor,actualMinor]=versionParts(version);
    const actual=`${version}.99`;
    if(operator==="^")return compareVersions(actual,bound)>=0&&actualMajor===Number(major);
    if(operator==="~")return compareVersions(actual,bound)>=0&&(patchText===undefined?actualMajor===Number(major):actualMajor===Number(major)&&actualMinor===minor);
    if(operator===">=")return compareVersions(actual,bound)>=0;
    if(operator===">")return compareVersions(actual,bound)>0;
    if(operator==="<=")return compareVersions(`${version}.0`,bound)<=0;
    if(operator==="<")return compareVersions(`${version}.0`,bound)<0;
    if(operator==="!=")return true;
    return actualMajor===Number(major)&&(minor===undefined||actualMinor===minor);
  }));
}
export function phpVersion(files,project){
  let composer={};let lock={};
  try{composer=JSON.parse(decoded(files.find(file=>file.path===local(project,"composer.json"))));}catch{}
  try{lock=JSON.parse(decoded(files.find(file=>file.path===local(project,"composer.lock"))));}catch{}
  const platform=typeof composer.config?.platform?.php==="string"?composer.config.platform.php.match(/^(\d+\.\d+)/)?.[1]:undefined;
  if(platform&&phpVersions.includes(platform))return platform;
  const constraints=[composer.require?.php,...[...(lock.packages||[]),...(lock["packages-dev"]||[])].map(item=>item?.require?.php)].filter(value=>typeof value==="string");
  const root=typeof composer.require?.php==="string"?composer.require.php:"";
  return phpVersions.find(version=>constraints.every(constraint=>phpSatisfies(version,constraint)))||[...phpVersions].reverse().find(version=>phpSatisfies(version,root))||"8.3";
}
export function composerFor(version){return compareVersions(version,"7.2")<0?toolchains.composer.lts:toolchains.composer.current;}

export function dotnetRequirements(files){
  const channels=new Set();const sdks=new Set();let aspnet=false;
  for(const file of files){
    if(dotnetProject.test(file.path)&&!ignoredManifestPath.test(file.path)){
      const content=decoded(file);
      for(const match of content.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/gi))for(const framework of match[1].split(";").map(item=>item.trim())){
        const version=framework.match(/^netcoreapp(\d+\.\d+)$/i)?.[1]||framework.match(/^net([5-9]|\d{2,})\.(\d+)/i)?.slice(1,3).join(".");
        if(version&&version!=="10.0")channels.add(version);
      }
      if(/Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"|Microsoft\.AspNetCore/i.test(content))aspnet=true;
    }
    if(/(^|\/)global\.json$/.test(file.path)){
      try{const version=JSON.parse(decoded(file)).sdk?.version;if(typeof version==="string"&&/^\d+\.\d+\.\d+$/.test(version)&&!version.startsWith("10.0."))sdks.add(version);}catch{}
    }
  }
  return {channels:[...channels].sort(),sdks:[...sdks].sort(),aspnet};
}

export function toolchainPlan(snapshot){
  const plan={dotnet:null,java:new Set(),maven:false,gradle:false,go:false,php:new Set(),rust:new Set(),nodeManagers:new Map(),pythonManagers:new Set(),ruby:new Set(),cpp:false,cobol:false};
  for(const variant of ["baseline","candidate"]){
    const files=snapshot[variant]||[];const paths=files.map(file=>file.path);
    for(const unit of pythonUnits(paths))plan.pythonManagers.add(unit.manager);
    if(paths.some(item=>/(^|\/)package\.json$/.test(item)))for(const project of projectsFor(files,{requireScripts:false,requireLock:variant==="baseline"})){
      const manager=nodeManager(JSON.parse(decoded(files.find(file=>file.path===local(project,"package.json")))),paths,project);
      if(manager.version)plan.nodeManagers.set(`${manager.name}-${manager.version}`,manager);
    }
    for(const unit of ecosystemUnits(paths)){
      if(unit.runtime==="dotnet")plan.dotnet=true;
      if(unit.runtime==="maven"||unit.runtime==="gradle"){
        plan.java.add(javaFeature(files,unit.project,unit.runtime));
        if(unit.runtime==="maven"&&!paths.includes(local(unit.project,"mvnw")))plan.maven=true;
        if(unit.runtime==="gradle"&&!paths.includes(local(unit.project,"gradlew")))plan.gradle=true;
      }
      if(unit.runtime==="go")plan.go=true;
      if(unit.runtime==="php")plan.php.add(phpVersion(files,unit.project));
      if(unit.runtime==="rust")plan.rust.add(rustVersion(files,unit.project));
      if(unit.runtime==="ruby")plan.ruby.add(bundlerVersion(files,unit.project));
      if(unit.runtime==="cpp")plan.cpp=true;
      if(unit.runtime==="cobol")plan.cobol=true;
    }
  }
  if(plan.dotnet)plan.dotnet=dotnetRequirements([...(snapshot.baseline||[]),...(snapshot.candidate||[])]);
  if(plan.php.size)plan.php.add("8.5");
  return plan;
}
export function toolchainsRequired(plan){return Boolean(plan.dotnet||plan.java.size||plan.go||plan.php.size||plan.rust?.size||plan.nodeManagers?.size||plan.pythonManagers?.size||plan.ruby?.size||plan.cpp||plan.cobol);}

export async function downloadVerified(url,algorithm,expected,destination){
  const response=await fetch(url,{redirect:"follow",signal:AbortSignal.timeout(900000)});
  if(!response.ok||!response.body)throw new Error(`Toolchain download failed (${response.status}): ${url}`);
  const hash=createHash(algorithm);
  await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,_encoding,callback){hash.update(chunk);callback(null,chunk);}}),createWriteStream(destination,{mode:0o600}));
  if(hash.digest("hex")!==expected.toLowerCase()){await rm(destination,{force:true});throw new Error(`Integrity verification failed for ${url}; the toolchain was not installed.`);}
}

const gradleInitScript=`def modernizeOutput = new File(System.getProperty("modernize.output"))
allprojects { modernizeProject ->
  modernizeProject.tasks.register("modernizeDependencies") {
    doLast {
      def configuration = modernizeProject.configurations.findByName("runtimeClasspath")
      if (configuration != null && configuration.canBeResolved) {
        configuration.incoming.resolutionResult.allComponents.each { component ->
          def id = component.id
          if (id instanceof org.gradle.api.artifacts.component.ModuleComponentIdentifier) {
            synchronized (modernizeOutput) { modernizeOutput << "\${id.group}:\${id.module}:\${id.version}\\n" }
          }
        }
      }
    }
  }
}
`;

async function setupCommand(command,args,timeoutMs=900000,extraEnv={}){
  const result=await executeCommand(command,args,"/opt",0,timeoutMs,{PATH:"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",...extraEnv});
  if(result.exitCode!==0||result.timedOut)throw new Error(`Toolchain setup failed: ${command} ${args.join(" ")}. ${result.log.slice(-1500)}`);
}
export async function ensureOwnedDirectory(directory,uid){
  await mkdir(directory,{recursive:true,mode:0o700});
  await chown(directory,uid,uid);
  await chmod(directory,0o700);
}
export async function installToolchains(plan){
  const packages=["ca-certificates","unzip","xz-utils"];
  if(plan.dotnet)packages.push("libicu72","libssl3","zlib1g","curl");
  if(plan.go)packages.push("gcc","libc6-dev");
  if(plan.rust?.size)packages.push("gcc","libc6-dev","pkg-config","libssl-dev");
  if(plan.pythonManagers?.size)packages.push("python3","python3-venv","python3-tk","xvfb","xauth","libasound2","libssl3");
  if(plan.ruby?.size||plan.cpp||plan.cobol)packages.push(`gcc=${toolchains.nativeDebian.gcc}`,`g++=${toolchains.nativeDebian.gcc}`,`gcc-12=${toolchains.nativeDebian.gcc12}`,`g++-12=${toolchains.nativeDebian.gcc12}`,`make=${toolchains.nativeDebian.make}`,`binutils=${toolchains.nativeDebian.binutils}`,"libc6-dev","python3");
  if(plan.ruby?.size)packages.push(`ruby3.1=${toolchains.nativeDebian.ruby}`,`ruby3.1-dev=${toolchains.nativeDebian.ruby}`,"zlib1g-dev");
  if(plan.cpp)packages.push(`cmake=${toolchains.nativeDebian.cmake}`);
  if(plan.cobol)packages.push(`gnucobol3=${toolchains.nativeDebian.gnucobol}`);
  await setupCommand("apt-get",["update"]);
  await setupCommand("apt-get",["install","-y","--no-install-recommends",...packages]);
  await mkdir("/opt/modernize",{recursive:true,mode:0o755});
  for(const version of plan.ruby||[]){
    const response=await fetch(`https://rubygems.org/api/v2/rubygems/bundler/versions/${version}.json`,{signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error(`Cannot verify pinned Bundler ${version}.`);
    const metadata=await response.json();
    if(metadata.version!==version||!/^[a-f0-9]{64}$/.test(metadata.sha||""))throw new Error("Missing RubyGems SHA-256 metadata.");
    const archive=`/opt/modernize/bundler-${version}.gem`;
    await downloadVerified(`https://rubygems.org/downloads/bundler-${version}.gem`,"sha256",metadata.sha,archive);
    await setupCommand("gem3.1",["install","--local",archive,"--no-document","--install-dir","/opt/modernize/ruby-gems"]);
    await rm(archive,{force:true});
    const checked=await executeCommand("ruby3.1",["-e",`gem 'bundler','= ${version}'; require 'bundler'; puts Bundler::VERSION`],"/opt",0,30000,{GEM_PATH:"/opt/modernize/ruby-gems"});
    if(checked.exitCode!==0||checked.log.trim()!==version)throw new Error(`Bundler ${version} could not verify its executable version.`);
  }
  for(const [enabled,command,expected] of [[plan.ruby?.size,"ruby3.1","3.1.2"],[plan.cpp,"cmake","3.25.1"],[plan.cobol,"cobc","3.1.2"],[plan.ruby?.size||plan.cpp||plan.cobol,"gcc","12.2.0"],[plan.ruby?.size||plan.cpp||plan.cobol,"g++","12.2.0"],[plan.ruby?.size||plan.cpp||plan.cobol,"make","4.3"],[plan.ruby?.size||plan.cpp||plan.cobol,"ld","2.40"]]){
    if(!enabled)continue;
    const checked=await executeCommand(command,["--version"],"/opt",0,30000);
    if(checked.exitCode!==0||!checked.log.includes(expected))throw new Error(`The pinned ${command} version did not verify.`);
  }
  for(const [key,manager] of plan.nodeManagers||[]){
    const packageName=manager.name==="yarn"&&!manager.classic?"@yarnpkg/cli-dist":manager.name;
    const metadataResponse=await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${manager.version}`,{signal:AbortSignal.timeout(60000)});
    if(!metadataResponse.ok)throw new Error(`Cannot verify pinned package manager ${key}.`);
    const metadata=await metadataResponse.json();
    if(metadata.name!==packageName||metadata.version!==manager.version||!/^https:\/\/registry\.npmjs\.org\//.test(metadata.dist?.tarball||"")||!/^sha512-[A-Za-z0-9+/=]+$/.test(metadata.dist?.integrity||""))throw new Error(`Incomplete registry integrity metadata for ${key}.`);
    const archive=`/opt/modernize/${key}.tgz`;
    await downloadVerified(metadata.dist.tarball,"sha512",Buffer.from(metadata.dist.integrity.slice(7),"base64").toString("hex"),archive);
    if(manager.integrity&&createHash(manager.integrity.algorithm).update(await readFile(archive)).digest("hex")!==manager.integrity.hex)throw new Error(`Source-declared packageManager integrity mismatch for ${key}.`);
    await setupCommand("npm",["install","--prefix",`/opt/modernize/node-managers/${key}`,"--ignore-scripts","--no-audit","--no-fund","--engine-strict",archive]);
    await rm(archive,{force:true});
    const version=await executeCommand(managerExecutable(manager),["--version"],"/opt",0,30000,{YARN_IGNORE_PATH:"1"});
    if(version.exitCode!==0||version.log.trim()!==manager.version)throw new Error(`The pinned ${key} executable did not verify its version.`);
  }
  if(plan.pythonManagers?.size){
    await setupCommand("python3",["-m","venv","/opt/verification-tools"]);
    await setupCommand("/opt/verification-tools/bin/python",["-m","pip","install","--disable-pip-version-check","--only-binary=:all:","pip-audit==2.9.0",...[...plan.pythonManagers].filter(manager=>manager!=="requirements").map(manager=>`${manager}==${toolchains.pythonManagers[manager]}`)]);
    for(const manager of plan.pythonManagers)if(manager!=="requirements"){
      const version=await executeCommand(`/opt/verification-tools/bin/${manager}`,["--version"],"/opt",0,30000);
      if(version.exitCode!==0||!version.log.includes(toolchains.pythonManagers[manager]))throw new Error(`The pinned ${manager} version could not be verified.`);
    }
  }
  if(plan.rust?.size){
    const bootstrap="/opt/modernize/rustup-init";
    await downloadVerified(toolchains.rustup.url,"sha256",toolchains.rustup.sha256,bootstrap);
    await chmod(bootstrap,0o700);
    const env={RUSTUP_HOME:"/opt/rustup",CARGO_HOME:"/opt/cargo"};
    await setupCommand(bootstrap,["-y","--no-modify-path","--profile","minimal","--default-toolchain","none"],900000,env);
    for(const version of plan.rust)await setupCommand("/opt/cargo/bin/rustup",["toolchain","install",version,"--profile","minimal","--no-self-update"],900000,env);
    await setupCommand("chmod",["-R","a+rX","/opt/rustup","/opt/cargo"]);
    await rm(bootstrap,{force:true});
  }
  if(plan.dotnet){
    const archive="/opt/modernize/dotnet-sdk.tar.gz";
    await downloadVerified(toolchains.dotnetSdk.url,"sha512",toolchains.dotnetSdk.sha512,archive);
    await mkdir("/opt/dotnet",{recursive:true,mode:0o755});
    await setupCommand("tar",["-xzf",archive,"-C","/opt/dotnet"]);
    await rm(archive,{force:true});
    if(plan.dotnet.channels.length||plan.dotnet.sdks.length){
      const script="/opt/modernize/dotnet-install.sh";
      await downloadVerified(toolchains.dotnetInstall.url,"sha256",toolchains.dotnetInstall.sha256,script);
      for(const channel of plan.dotnet.channels){
        await setupCommand("bash",[script,"--runtime","dotnet","--channel",channel,"--install-dir","/opt/dotnet","--no-path"]);
        if(plan.dotnet.aspnet)await setupCommand("bash",[script,"--runtime","aspnetcore","--channel",channel,"--install-dir","/opt/dotnet","--no-path"]);
      }
      for(const version of plan.dotnet.sdks)await setupCommand("bash",[script,"--version",version,"--install-dir","/opt/dotnet","--no-path"]);
    }
  }
  for(const feature of plan.java){
    const pin=toolchains.temurin[feature];const archive=`/opt/modernize/temurin-${feature}.tar.gz`;const home=`/opt/java/${feature}`;
    await downloadVerified(pin.url,"sha256",pin.sha256,archive);
    await mkdir(home,{recursive:true,mode:0o755});
    await setupCommand("tar",["-xzf",archive,"-C",home,"--strip-components=1"]);
    await rm(archive,{force:true});
  }
  if(plan.java.size)await writeFile("/opt/modernize/dependencies.init.gradle",gradleInitScript,{mode:0o644});
  if(plan.maven){
    const archive="/opt/modernize/maven.tar.gz";
    await downloadVerified(toolchains.maven.url,"sha512",toolchains.maven.sha512,archive);
    await mkdir("/opt/maven",{recursive:true,mode:0o755});
    await setupCommand("tar",["-xzf",archive,"-C","/opt/maven","--strip-components=1"]);
    await rm(archive,{force:true});
  }
  if(plan.gradle){
    const archive="/opt/modernize/gradle.zip";
    await downloadVerified(toolchains.gradle.url,"sha256",toolchains.gradle.sha256,archive);
    await setupCommand("unzip",["-q",archive,"-d","/opt/modernize/gradle-extract"]);
    await rename(`/opt/modernize/gradle-extract/gradle-${toolchains.gradle.version}`,"/opt/gradle");
    await rm(archive,{force:true});
  }
  if(plan.go){
    const archive="/opt/modernize/go.tar.gz";
    await downloadVerified(toolchains.go.url,"sha256",toolchains.go.sha256,archive);
    await setupCommand("tar",["-xzf",archive,"-C","/opt"]);
    await rm(archive,{force:true});
  }
  if(plan.php.size){
    const keyring="/opt/modernize/debsuryorg-archive-keyring.deb";
    await downloadVerified(toolchains.suryKeyring.url,"sha256",toolchains.suryKeyring.sha256,keyring);
    await setupCommand("dpkg",["-i",keyring]);
    await writeFile("/etc/apt/sources.list.d/php.list","deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ bookworm main\n",{mode:0o644});
    await setupCommand("apt-get",["update"]);
    const phpPackages=[...plan.php].flatMap(version=>["cli","xml","mbstring","curl","zip","sqlite3","intl","bcmath",...(compareVersions(version,"8.0")<0?["json"]:[])].map(extension=>`php${version}-${extension}`));
    await setupCommand("apt-get",["install","-y","--no-install-recommends",...phpPackages]);
    await mkdir("/opt/composer",{recursive:true,mode:0o755});
    for(const composer of new Set([...plan.php].map(composerFor))){
      await downloadVerified(composer.url,"sha256",composer.sha256,composer.path);
      await chmod(composer.path,0o644);
    }
  }
}

export function ecosystemEnvironment(runtime,cwd,options={}){
  const base="/usr/bin:/usr/local/bin:/bin";
  if(runtime==="dotnet")return {PATH:`/opt/dotnet:${base}`,DOTNET_ROOT:"/opt/dotnet",DOTNET_CLI_HOME:cwd,NUGET_PACKAGES:path.join(cwd,".nuget/packages"),DOTNET_CLI_TELEMETRY_OPTOUT:"1",DOTNET_NOLOGO:"1",DOTNET_SKIP_FIRST_TIME_EXPERIENCE:"1",MSBUILDDISABLENODEREUSE:"1",DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE:"1",DOTNET_GENERATE_ASPNET_CERTIFICATE:"false"};
  if(runtime==="java"){const home=`/opt/java/${options.feature}`;return {PATH:`${home}/bin:/opt/maven/bin:/opt/gradle/bin:${base}`,JAVA_HOME:home,MAVEN_OPTS:"-Xmx1536m",MAVEN_USER_HOME:path.join(cwd,".m2"),GRADLE_USER_HOME:path.join(cwd,".gradle-home"),GRADLE_OPTS:"-Dorg.gradle.daemon=false -Xmx1536m"};}
  if(runtime==="go")return {PATH:`/opt/go/bin:${base}`,GOPATH:path.join(cwd,".gopath"),GOMODCACHE:path.join(cwd,".gopath/pkg/mod"),GOCACHE:path.join(cwd,".gocache"),GOTOOLCHAIN:"auto",GOWORK:"off",TMPDIR:path.join(cwd,".modernize-tmp")};
  if(runtime==="php")return {COMPOSER_HOME:path.join(cwd,".composer"),COMPOSER_CACHE_DIR:path.join(cwd,".composer/cache"),COMPOSER_NO_INTERACTION:"1"};
  return {};
}

export async function readOwnedReports(root,pattern,{maxFiles=500,maxBytes=64_000_000}={}){
  const reports=[];let total=0;
  const skipped=new Set([".git","node_modules",".nuget",".m2",".gradle-home",".gopath",".gocache",".composer","vendor"]);
  async function walk(directory,depth){
    if(depth>25||reports.length>=maxFiles)return;
    let entries;try{entries=await readdir(directory,{withFileTypes:true});}catch{return;}
    for(const entry of entries){
      if(entry.isSymbolicLink())continue;
      const full=path.join(directory,entry.name);
      if(entry.isDirectory()){if(!skipped.has(entry.name))await walk(full,depth+1);continue;}
      if(!entry.isFile()||!pattern.test(full))continue;
      const content=await readPreparedFile(full,{limit:20_000_000}).catch(()=>null);
      if(content===null)continue;
      total+=content.length;
      if(total>maxBytes)throw new Error("Test reports exceed the evidence size limit.");
      reports.push({path:full,content});
    }
  }
  await walk(root,0);
  return reports;
}
export function junitCounts(documents){
  let tests=0,skipped=0,failed=0;
  for(const {content} of documents){
    let documentSkipped=0,documentFailed=0;
    for(const match of content.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase\s*>)/g)){
      tests++;
      if(/<(?:skipped|ignored)\b/i.test(match[2]||"")||/\bstatus=["'](?:disabled|notrun|skipped|ignored|pending)["']/i.test(match[1]))documentSkipped++;
      if(/<(?:failure|error)\b/i.test(match[2]||"")||/\bstatus=["'](?:failed|failure|error|timeout)["']/i.test(match[1]))documentFailed++;
    }
    const suites=[...content.matchAll(/<testsuite\b[^>]*>/g)].map(match=>match[0]);
    const maximum=names=>Math.max(0,...suites.flatMap(suite=>names.map(name=>Number(suite.match(new RegExp(`\\b${name}=["'](\\d+)["']`))?.[1]||0))));
    skipped+=Math.max(documentSkipped,maximum(["skipped","disabled"]));
    failed+=Math.max(documentFailed,maximum(["failures","errors"]));
  }
  return {tests,skipped,failed};
}
export function trxCounts(documents){
  let tests=0,skipped=0,failed=0;
  for(const {content} of documents){
    const counters=content.match(/<Counters\b[^>]*>/)?.[0];
    if(!counters)continue;
    const value=name=>Number(counters.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1]||0);
    const total=value("total");
    tests+=total;skipped+=Math.max(value("notExecuted"),total-value("executed"));failed+=value("failed")+value("error")+value("timeout")+value("aborted");
  }
  return {tests,skipped,failed};
}
export function goTestCounts(output){
  let tests=0,skipped=0,failed=0;
  for(const line of output.split("\n")){
    if(!line.startsWith("{"))continue;
    try{const event=JSON.parse(line);if(!event.Test)continue;if(event.Action==="pass")tests++;else if(event.Action==="skip"){tests++;skipped++;}else if(event.Action==="fail"){tests++;failed++;}}catch{}
  }
  return {tests,skipped,failed};
}
export function enforceExecutedTests(step,counts){
  const valid=counts&&[counts.tests,counts.failed,counts.skipped].every(value=>Number.isSafeInteger(value)&&value>=0);
  if(!valid)counts={tests:0,failed:0,skipped:0};
  const passed=valid&&step.exitCode===0&&!step.timedOut&&counts.tests>0&&counts.failed===0&&counts.skipped===0;
  const notes=[`Executed tests: ${counts.tests}; failed: ${counts.failed}; skipped: ${counts.skipped}.`,counts.tests===0?"No tests were executed; verification cannot pass.":"",counts.skipped?"Skipped tests leave required coverage unverified.":""].filter(Boolean).join(" ");
  return {...step,tests:counts,exitCode:passed?0:step.exitCode&&step.exitCode!==0?step.exitCode:1,log:`${step.log}\n${notes}`.slice(-32000)};
}
export function npmTestCounts(output,format="tap"){
  if(format==="json"){
    const report=JSON.parse(output);
    const values=[report.numTotalTests,report.numFailedTests,report.numPendingTests,report.numPassedTests,report.numTodoTests??0];
    if(values.some(value=>!Number.isSafeInteger(value)||value<0))throw new Error("The npm test reporter returned invalid test counters.");
    const [tests,failed,pending,passed,todo]=values;
    if(passed+failed+pending!==tests||todo>pending)throw new Error("The npm test reporter returned inconsistent test counters.");
    return {tests,failed,skipped:pending};
  }
  const count=name=>{const match=output.match(new RegExp(`^(?:#\\s*|ℹ\\s*)${name}\\s+(\\d+)\\s*$`,"m"));if(!match)throw new Error(`The npm test output has no machine-readable ${name} counter. Use Vitest, Jest, or a Node TAP reporter.`);return Number(match[1]);};
  const tests=count("tests"),failed=count("fail")+count("cancelled"),skipped=count("skipped")+count("todo"),passed=count("pass");
  if(passed+failed+skipped!==tests)throw new Error("The npm TAP reporter returned inconsistent test counters.");
  return {tests,failed,skipped};
}
export function auditStep(step,findings){
  const normalized=findings.map(item=>{const severity=String(item.severity||"unknown").toLowerCase().replace("moderate","medium");return {package:String(item.package),version:String(item.version||""),id:String(item.id),severity,blocking:["high","critical","unknown"].includes(severity)};});
  const blocking=normalized.some(item=>item.blocking);
  const summary=normalized.length?`${auditFindingsPrefix}${JSON.stringify({findings:normalized.slice(0,100)})}`:"No known vulnerabilities were reported.";
  return {...step,exitCode:blocking?1:0,log:`${step.log.slice(-(31000-summary.length))}\n${summary}`};
}
export async function osvFindings(ecosystem,packages,fetcher=fetch){
  const unique=[...new Map(packages.map(item=>[`${item.name}@${item.version}`,item])).values()];
  if(unique.length>5000)throw new Error("Dependency inventory exceeds the audit limit.");
  const advisories=new Map();
  const details=new Map();
  const collect=(vulnerability,item)=>{
    if(typeof vulnerability?.id!=="string"||!vulnerability.id)throw new Error("OSV returned an advisory without an identifier.");
    const affected=advisories.get(vulnerability.id)||[];
    if(!affected.some(previous=>previous.name===item.name&&previous.version===item.version))affected.push(item);
    advisories.set(vulnerability.id,affected);
    if(vulnerability.affected)details.set(vulnerability.id,vulnerability);
    if(advisories.size>10000)throw new Error("OSV returned more than 10000 advisories; the bounded audit cannot complete.");
  };
  for(let offset=0;offset<unique.length;offset+=500){
    const chunk=unique.slice(offset,offset+500);
    const response=await fetcher("https://api.osv.dev/v1/querybatch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({queries:chunk.map(item=>({package:{ecosystem,name:item.name},version:item.version}))}),signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error(`OSV query failed (${response.status}).`);
    const body=await response.json();
    if(!Array.isArray(body.results)||body.results.length!==chunk.length)throw new Error("OSV returned an incomplete result set.");
    for(let index=0;index<body.results.length;index++){
      const result=body.results[index],item=chunk[index];
      if(!result||result.vulns!==undefined&&!Array.isArray(result.vulns))throw new Error("OSV returned an invalid vulnerability page.");
      for(const vulnerability of result.vulns||[])collect(vulnerability,item);
      if(result.next_page_token){
        let token;
        const seen=new Set();
        for(let page=0;page<100;page++){
          const response=await fetcher("https://api.osv.dev/v1/query",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({package:{ecosystem,name:item.name},version:item.version,...(token?{page_token:token}:{})}),signal:AbortSignal.timeout(60000)});
          if(!response.ok)throw new Error(`OSV paginated query failed (${response.status}).`);
          const next=await response.json();
          if(next.vulns!==undefined&&!Array.isArray(next.vulns))throw new Error("OSV returned an invalid paginated vulnerability set.");
          for(const vulnerability of next.vulns||[])collect(vulnerability,item);
          token=next.next_page_token;
          if(!token)break;
          if(typeof token!=="string"||seen.has(token))throw new Error("OSV returned a repeated or invalid pagination cursor.");
          seen.add(token);
          if(page===99)throw new Error("OSV audit exceeded 100 result pages; no findings were waived.");
        }
      }
    }
  }
  const findings=[];
  for(const [id,affected] of advisories){
    let advisory=details.get(id);
    if(!advisory){
      const response=await fetcher(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error(`OSV advisory lookup failed for ${id}.`);
      advisory=await response.json();
    }
    if(advisory.withdrawn)continue;
    for(const item of affected){
      const urgency=ecosystem==="Debian:12"?advisory.affected?.find(entry=>entry.package?.ecosystem===ecosystem&&entry.package?.name===item.name)?.ecosystem_specific?.urgency:undefined;
      const severity=advisory.database_specific?.severity||({unimportant:"low",low:"low",medium:"medium",high:"high"}[urgency])||"unknown";
      findings.push({package:item.name,version:item.version,id,severity});
    }
  }
  return findings;
}
export function mavenDependencies(content){
  const found=[];
  for(const line of content.split("\n")){
    const match=line.trim().match(/^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?:([A-Za-z0-9_.+-]+):(compile|runtime)\b/);
    if(match)found.push({name:`${match[1]}:${match[2]}`,version:match[3]});
  }
  return found;
}
export function gradleDependencies(content){
  return content.split("\n").map(line=>line.trim().match(/^([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):([A-Za-z0-9_.+-]+)$/)).filter(Boolean).map(match=>({name:`${match[1]}:${match[2]}`,version:match[3]}));
}
export function dotnetFindings(outputs){
  const findings=[];
  for(const result of outputs){
    const text=result.output||"";
    const report=JSON.parse(text.slice(text.indexOf("{")));
    if(!Array.isArray(report.projects))throw new Error("Unexpected dotnet audit output.");
    if((report.problems||[]).some(problem=>String(problem.level).toLowerCase()==="error"))throw new Error("dotnet reported audit errors.");
    for(const project of report.projects)for(const framework of project.frameworks||[])for(const item of [...(framework.topLevelPackages||[]),...(framework.transitivePackages||[])])for(const vulnerability of item.vulnerabilities||[]){
      findings.push({package:item.id,version:item.resolvedVersion,id:String(vulnerability.advisoryurl||"advisory").split("/").pop(),severity:vulnerability.severity});
    }
  }
  return findings;
}
export function composerFindings(output){
  const report=JSON.parse(output.slice(output.indexOf("{")));
  if(!report||typeof report.advisories!=="object")throw new Error("Unexpected composer audit output.");
  return Object.entries(Array.isArray(report.advisories)?{}:report.advisories).flatMap(([name,items])=>Object.values(items||{}).map(item=>({package:name,version:"",id:item.advisoryId||item.cve||"advisory",severity:item.severity||"unknown"})));
}

async function runInvocations(label,invocations,execute){
  const started=Date.now();let log="";let exitCode=0;let timedOut=false;const outputs=[];
  for(const item of invocations){
    const result=await execute(item.command,item.args,item.cwd,item.uid,item.timeoutMs||900000,item.env||{},item.fullOutputLimit||0);
    log=`${log}\n$ ${item.display||[item.command,...item.args].join(" ")}\n${result.log}`.slice(-32000);
    outputs.push(result);
    if(result.exitCode!==0||result.timedOut){exitCode=result.exitCode;timedOut=result.timedOut;break;}
  }
  return {command:label,exitCode,timedOut,log,durationMs:Date.now()-started,outputs};
}
function evaluated(step,evaluate){
  try{return evaluate();}catch(error){return {...step,exitCode:2,log:`${step.log}\nThe tool output could not be evaluated: ${error.message}`.slice(-32000)};}
}

export function rustTestCounts(output){
  let tests=0,failed=0,skipped=0;
  for(const match of output.matchAll(/^test result: (?:ok|FAILED)\.\s+(\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out/gm)){
    const values=match.slice(1).map(Number);
    tests+=values.reduce((sum,value)=>sum+value,0);failed+=values[1];skipped+=values[2]+values[3]+values[4];
  }
  return {tests,failed,skipped};
}
export function cargoDependencies(output){
  const metadata=JSON.parse(output);
  if(!Array.isArray(metadata.packages)||!Array.isArray(metadata.workspace_members))throw new Error("Cargo metadata is incomplete.");
  return metadata.packages.flatMap(item=>{
    if(metadata.workspace_members.includes(item.id))return [];
    if(item.source!=="registry+https://github.com/rust-lang/crates.io-index")throw new Error(`Unauditable Cargo source for ${item.name}; git, external path and custom registry dependencies are blocked.`);
    if(typeof item.name!=="string"||typeof item.version!=="string")throw new Error("Invalid Cargo dependency.");
    return [{name:item.name,version:item.version}];
  });
}
export function rubyTestCounts(output,format="minitest"){
  if(format==="rspec"){
    const report=JSON.parse(output);
    if(!Array.isArray(report.examples)||report.examples.length!==report.summary?.example_count)throw new Error("RSpec example inventory is incomplete.");
    const counts={tests:report.summary.example_count,failed:report.summary.failure_count,skipped:report.summary.pending_count};
    for(const [status,key] of [["failed","failed"],["pending","skipped"]])if(report.examples.filter(item=>item.status===status).length!==counts[key])throw new Error("RSpec summary counters are inconsistent.");
    return counts;
  }
  const line=output.split("\n").findLast(line=>line.startsWith("MODERNIZE_RUBY_TEST_COUNTS "));
  if(!line)throw new Error("Minitest did not emit executed test counters.");
  return JSON.parse(line.slice("MODERNIZE_RUBY_TEST_COUNTS ".length));
}
const minitestProgram=`require 'json'
require 'minitest/autorun'
Minitest::SummaryReporter.prepend(Module.new do
  def report
    super
    puts 'MODERNIZE_RUBY_TEST_COUNTS ' + JSON.generate(tests: count, failed: failures + errors, skipped: skips)
  end
end)
files=ARGV.dup
ARGV.clear
files.each { |file| require File.expand_path(file) }
`;
export function nativePolicy(files,project){
  const scoped=files.filter(file=>inUnit(project,file.path));
  if(scoped.some(file=>/(^|\/)(vendor|third_party|third-party|external)\//i.test(file.path)))throw new Error("Vendored native dependencies have no qualified version inventory; audit remains blocked.");
  for(const file of scoped.filter(file=>/(^|\/)CMakeLists\.txt$|\.cmake$/i.test(file.path))){
    const content=decoded(file).replace(/#[^\n]*/g,"");
    if(/\b(FetchContent|ExternalProject|CPMAddPackage|pkg_check_modules)\b|\bfile\s*\(\s*DOWNLOAD\b|\b(execute_process|add_custom_command|add_custom_target|cmake_language)\s*\(/i.test(content)||[...content.matchAll(/\bfind_package\s*\(\s*([^\s)]+)/gi)].some(match=>match[1]!=="Threads"))throw new Error(`${file.path}: external CMake dependency/process mechanisms have no complete qualified audit inventory.`);
  }
}
export function cobolContracts(files){
  const manifest=files.find(file=>file.path==="tests/cobol-contracts.json");
  if(!manifest)throw new Error("Reviewed tests/cobol-contracts.json is required.");
  const config=JSON.parse(decoded(manifest));
  if(Buffer.byteLength(JSON.stringify(config))>100000)throw new Error("COBOL executable contracts exceed the bounded 100 KB command payload.");
  if(config.version!==1||!Array.isArray(config.programs)||!config.programs.length||config.programs.length>8||!Array.isArray(config.tests)||!config.tests.length||config.tests.length>64||Object.keys(config).some(key=>!["version","programs","tests"].includes(key)))throw new Error("COBOL contracts require 1-8 programs and 1-64 executable tests.");
  const sources=files.filter(file=>/\.(cob|cbl|cobol)$/i.test(file.path)&&!ignoredManifestPath.test(file.path)).map(file=>file.path);
  const names=new Set();
  for(const program of config.programs){
    if(typeof program.name!=="string"||!/^[a-zA-Z0-9_-]{1,60}$/.test(program.name)||names.has(program.name)||!Array.isArray(program.sources)||!program.sources.length||program.sources.length>100||program.sources.some(source=>!sources.includes(source))||program.format!==undefined&&!["fixed","free"].includes(program.format)||Object.keys(program).some(key=>!["name","sources","format"].includes(key)))throw new Error("Invalid/duplicate COBOL program or original source path.");
    names.add(program.name);
    if(!config.tests.some(test=>test.program===program.name))throw new Error(`COBOL program ${program.name} has no executable contract.`);
  }
  if(sources.some(source=>!config.programs.some(program=>program.sources.includes(source))))throw new Error("Every detected COBOL program source must be compiled.");
  for(const item of config.tests)if(!names.has(item.program)||typeof item.name!=="string"||!item.name||typeof item.stdin!=="string"||Buffer.byteLength(item.stdin)>64000||typeof item.stdout!=="string"||Buffer.byteLength(item.stdout)>64000||item.stderr!==undefined&&(typeof item.stderr!=="string"||Buffer.byteLength(item.stderr)>64000)||!Number.isInteger(item.exitCode)||item.exitCode<0||item.exitCode>255||Object.keys(item).some(key=>!["program","name","stdin","stdout","stderr","exitCode"].includes(key)))throw new Error("Invalid COBOL executable assertion; skips and arbitrary commands are not permitted.");
  return config;
}
const cobolTestProgram=`const path=require('node:path'),cp=require('node:child_process');const config=JSON.parse(process.argv[1]);let failed=0;for(const item of config.tests){const result=cp.spawnSync(path.join(process.cwd(),'.modernize-build',item.program),[],{input:item.stdin,encoding:'utf8',timeout:30000,maxBuffer:1000000});const ok=!result.error&&result.status===item.exitCode&&result.stdout===item.stdout&&result.stderr===(item.stderr||'');if(!ok){failed++;console.error(item.name,JSON.stringify({error:result.error?.message,status:result.status,stdout:result.stdout,stderr:result.stderr}));}}console.log('MODERNIZE_COBOL_TEST_COUNTS '+JSON.stringify({tests:config.tests.length,failed,skipped:0}));process.exitCode=failed?1:0;`;
export const nativeInventoryProgram=String.raw`import os, sys, json, pathlib, subprocess, shlex, re
root=pathlib.Path.cwd().resolve()
build=root/'.modernize-build'
paths=set()
for dep in build.rglob('*.d'):
    text=dep.read_text().replace('\\\n',' ')
    words=shlex.split(text.split(':',1)[1] if ':' in text else '')
    for word in words:
        p=pathlib.Path(word)
        paths.add(str(p if p.is_absolute() else root/p))
for line in sys.argv[1].splitlines():
    if re.fullmatch(r'/[^\s]+\.(?:a|o|so(?:\.\d+)*)',line.strip()):
        paths.add(line.strip())
binaries=[]
for candidate in build.rglob('*'):
    if not candidate.is_file() or candidate.is_symlink() or 'CMakeFiles' in candidate.parts: continue
    with candidate.open('rb') as handle: head=handle.read(20)
    if head[:4]!=b'\x7fELF' or len(head)<20: continue
    if int.from_bytes(head[16:18],'little' if head[5]==1 else 'big') not in (2,3): continue
    binaries.append(str(candidate))
    result=subprocess.run(['ldd',str(candidate)],capture_output=True,text=True,timeout=30)
    if result.returncode and 'not a dynamic executable' not in result.stderr+result.stdout: raise RuntimeError('ldd inventory failed: '+result.stderr+result.stdout)
    if 'not found' in result.stdout: raise RuntimeError('Unresolved native shared library')
    for match in re.finditer(r'(?:=>\s*)?(/[^\s]+)\s+\(',result.stdout): paths.add(match[1])
if not binaries: raise RuntimeError('No fresh executable/shared-library build artifacts were inventoried')
packages=set(sys.argv[2:])
for value in paths:
    p=pathlib.Path(value).resolve()
    if p==root or root in p.parents: continue
    if not str(p).startswith(('/usr/','/lib/','/lib64/','/bin/')): raise RuntimeError('Unauditable external native path: '+str(p))
    found=False
    for variant in dict.fromkeys([value,str(p),str(p).removeprefix('/usr')]):
        result=subprocess.run(['dpkg-query','-S',variant],capture_output=True,text=True,timeout=30)
        if not result.returncode:
            packages.update(line.split(': ',1)[0] for line in result.stdout.splitlines() if ': ' in line)
            found=True;break
    if not found: raise RuntimeError('Native dependency is not owned by a signed Debian package: '+str(p))
inventory={}
for package in sorted(packages):
    result=subprocess.run(['dpkg-query','-W','-f=$'+'{source:Package}\t$'+'{source:Version}\n',package],capture_output=True,text=True,check=True,timeout=30)
    for line in result.stdout.splitlines():
        name,version=line.split('\t')
        if not name or not version: raise RuntimeError('Missing Debian source package version')
        inventory[name+'@'+version]={'name':name,'version':version}
print(json.dumps(list(inventory.values())))
`;
function nativeAudit(label,inventory,tools){
  return async()=>{
    const step=await runInvocations(label,[inventory],tools.execute);
    if(step.exitCode!==0||step.timedOut)return step;
    try{
      const packages=JSON.parse(step.outputs[0]?.output||"");
      if(!Array.isArray(packages)||!packages.length||packages.some(item=>typeof item.name!=="string"||typeof item.version!=="string"))throw new Error("Native dependency inventory is incomplete.");
      return auditStep(step,await tools.osv("Debian:12",packages));
    }catch(error){return {...step,exitCode:2,log:`${step.log}\nNative dependency audit is incomplete: ${error.message}`.slice(-32000)};}
  };
}
export function ecosystemPlan(unit,variant,uid,files,tools){
  const root=path.join("/work",variant);const cwd=path.join(root,unit.project);const missing=[];
  const run=(label,invocations)=>runInvocations(label,invocations,tools.execute);
  if(unit.runtime==="ruby"){
    const version=bundlerVersion(files,unit.project);
    const env={PATH:"/opt/modernize/ruby-gems/bin:/usr/local/bin:/usr/bin:/bin",GEM_PATH:"/opt/modernize/ruby-gems:/var/lib/gems/3.1.0:/usr/lib/ruby/gems/3.1.0",GEM_HOME:path.join(cwd,".gem-home"),BUNDLE_PATH:path.join(cwd,".modernize-gems"),BUNDLE_FROZEN:"true",BUNDLE_DEPLOYMENT:"true",BUNDLE_DISABLE_SHARED_GEMS:"true",BUNDLE_DISABLE_VERSION_CHECK:"true"};
    const ruby=(args,extra={})=>({command:"ruby3.1",args,cwd,uid,env,timeoutMs:900000,fullOutputLimit:30_000_000,...extra});
    const bundle=args=>ruby(["-S","bundle",`_${version}_`,...args]);
    const scoped=files.filter(file=>inUnit(unit.project,file.path)&&!ignoredManifestPath.test(file.path));
    const rspec=scoped.some(file=>/(^|\/)spec\/.+_spec\.rb$/.test(file.path));
    const minitest=scoped.filter(file=>/(^|\/)test\/(?:.*\/)?(?:test_[^/]+|[^/]+_test)\.rb$/.test(file.path)).map(file=>path.posix.relative(unit.project,file.path));
    if(!rspec&&!minitest.length)missing.push(`${variant} ${unit.project}: real RSpec/Minitest suites are required`);
    const report=path.join(cwd,".modernize-rspec.json");
    return {missing,steps:[
      {index:0,run:()=>run(rubyCommands[0],[bundle(["install","--jobs","2","--retry","2"])])},
      {index:1,run:()=>run(rubyCommands[1],[ruby(["-e","ARGV.each { |file| RubyVM::InstructionSequence.compile_file(file) }",...scoped.filter(file=>file.path.endsWith(".rb")).map(file=>path.posix.relative(unit.project,file.path))])])},
      ...((rspec||minitest.length)?[{index:2,run:async()=>{
        let total={tests:0,failed:0,skipped:0};const steps=[];
        if(rspec){
          const cleared=await run(rubyCommands[2],[ruby(["-e","File.unlink(ARGV[0]) if File.exist?(ARGV[0])",report])]);
          if(cleared.exitCode!==0)return cleared;
          const step=await run(rubyCommands[2],[bundle(["exec","rspec","--format","json","--out",report])]);
          try{const counts=rubyTestCounts(await tools.readFile(report),"rspec");steps.push(enforceExecutedTests(step,counts));total=counts;}catch(error){steps.push({...step,exitCode:2,log:`${step.log}\n${error.message}`});}
        }
        if(minitest.length){
          const step=await run(rubyCommands[2],[bundle(["exec","ruby3.1","-Itest","-e",minitestProgram,...minitest])]);
          try{const counts=rubyTestCounts(step.outputs[0]?.output||"");steps.push(enforceExecutedTests(step,counts));for(const key of Object.keys(total))total[key]+=counts[key];}catch(error){steps.push({...step,exitCode:2,log:`${step.log}\n${error.message}`});}
        }
        return {...steps[0],command:rubyCommands[2],exitCode:steps.every(step=>step.exitCode===0&&!step.timedOut)?0:1,timedOut:steps.some(step=>step.timedOut),tests:total,log:steps.map(step=>step.log).join("\n").slice(-32000),durationMs:steps.reduce((sum,step)=>sum+step.durationMs,0)};
      }}]:[]),
      {index:3,audit:true,run:async()=>{
        for(const name of ["Gemfile","Gemfile.lock"]){
          const expected=decoded(files.find(file=>file.path===local(unit.project,name)));
          if(await tools.readFile(path.join(cwd,name))!==expected)return {command:rubyCommands[3],exitCode:2,timedOut:false,durationMs:0,log:`Ruby ${name} changed during repository commands; source-bound dependency auditing is blocked.`};
        }
        const program=`gem 'bundler','= ${version}'; require 'bundler'; require 'json'; parser=Bundler::LockfileParser.new(File.read('Gemfile.lock')); list=parser.specs.filter_map { |spec| next if spec.source.is_a?(Bundler::Source::Path) && File.expand_path(spec.source.path.to_s)==Dir.pwd; unless spec.source.is_a?(Bundler::Source::Rubygems); raise 'Unauditable Git/path Ruby dependency'; end; {name:spec.name,version:spec.version.to_s} }; puts JSON.generate(list)`;
        const step=await run(rubyCommands[3],[ruby(["-e",program])]);
        if(step.exitCode!==0||step.timedOut)return step;
        try{const packages=JSON.parse(step.outputs[0]?.output||"");if(!Array.isArray(packages))throw new Error("Missing Ruby lock inventory.");return auditStep(step,await tools.osv("RubyGems",packages));}catch(error){return {...step,exitCode:2,log:`${step.log}\nRuby dependency audit is incomplete: ${error.message}`.slice(-32000)};}
      }},
    ]};
  }
  if(unit.runtime==="cpp"){
    nativePolicy(files,unit.project);let linkOutput="";
    const invoke=(command,args,extra={})=>({command,args,cwd,uid,timeoutMs:900000,fullOutputLimit:30_000_000,...extra});
    const report=path.join(cwd,".modernize-build/ctest.xml");
    return {missing,steps:[
      {index:0,run:()=>run(cppCommands[0],[invoke("node",["-e","require('node:fs').rmSync('.modernize-build',{recursive:true,force:true})"]),invoke("cmake",["-S",".","-B",".modernize-build","-DCMAKE_BUILD_TYPE=Release","-DCMAKE_EXE_LINKER_FLAGS=-Wl,-t","-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-t"])])},
      {index:1,run:async()=>{const step=await run(cppCommands[1],[invoke("cmake",["--build",".modernize-build","--config","Release","--parallel","2"])]);linkOutput=step.outputs[0]?.output||"";return step;}},
      {index:2,run:async()=>{const step=await run(cppCommands[2],[invoke("ctest",["--test-dir",".modernize-build","--output-on-failure","--no-tests=error","--output-junit",report])]);try{return enforceExecutedTests(step,junitCounts([{content:await tools.readFile(report)}]));}catch(error){return {...step,exitCode:2,log:`${step.log}\nCTest report is unavailable: ${error.message}`};}}},
      {index:3,audit:true,run:()=>nativeAudit(cppCommands[3],invoke("python3",["-c",nativeInventoryProgram,linkOutput,"libc6","libgcc-s1","libstdc++6"]),tools)()},
    ]};
  }
  if(unit.runtime==="cobol"){
    const config=cobolContracts(files);let linkOutput="";
    const copyDirectories=[...new Set(files.filter(file=>/\.(cpy|cob|cbl|cobol)$/i.test(file.path)).map(file=>path.posix.dirname(file.path)))];
    const invoke=(command,args)=>({command,args,cwd,uid,timeoutMs:900000,fullOutputLimit:30_000_000});
    return {missing,steps:[
      {index:0,run:async()=>{
        const step=await run(cobolCommands[0],[invoke("node",["-e","const fs=require('node:fs');fs.rmSync('.modernize-build',{recursive:true,force:true});fs.mkdirSync('.modernize-build')"]),...config.programs.map(program=>invoke("cobc",["-x",program.format==="free"?"-free":"-fixed","-Q","-Wl,-t",...copyDirectories.flatMap(directory=>["-I",directory]),"-o",path.join(".modernize-build",program.name),...program.sources]))]);
        linkOutput=(step.outputs||[]).map(output=>output.output||"").join("\n");return step;
      }},
      {index:1,run:async()=>{const step=await run(cobolCommands[1],[invoke("node",["-e",cobolTestProgram,JSON.stringify(config)])]);try{const line=(step.outputs[0]?.output||"").split("\n").findLast(line=>line.startsWith("MODERNIZE_COBOL_TEST_COUNTS "));return enforceExecutedTests(step,line?JSON.parse(line.slice("MODERNIZE_COBOL_TEST_COUNTS ".length)):{tests:0,failed:0,skipped:0});}catch(error){return {...step,exitCode:2,log:`${step.log}\n${error.message}`};}}},
      {index:2,audit:true,run:()=>nativeAudit(cobolCommands[2],invoke("python3",["-c",nativeInventoryProgram,linkOutput,"gnucobol3","libcob4","libc6"]),tools)()},
    ]};
  }
  if(unit.runtime==="rust"){
    const version=rustVersion(files,unit.project);
    const env={PATH:"/opt/cargo/bin:/usr/local/bin:/usr/bin:/bin",RUSTUP_HOME:"/opt/rustup",RUSTUP_TOOLCHAIN:version,CARGO_HOME:path.join(cwd,".cargo-home"),CARGO_TARGET_DIR:path.join(cwd,".modernize-target")};
    const cargo=args=>({command:"/opt/cargo/bin/cargo",args,cwd,uid,env,timeoutMs:1200000,fullOutputLimit:30_000_000});
    if(!files.some(file=>file.path===local(unit.project,"Cargo.lock")))missing.push(`${variant} ${unit.project}: original reviewed Cargo.lock is required`);
    return {missing,steps:[
      {index:0,run:()=>run(rustCommands[0],[cargo(["fetch","--locked"])])},
      {index:1,run:()=>run(rustCommands[1],[cargo(["build","--locked","--workspace","--all-targets"])])},
      {index:2,run:async()=>{const step=await run(rustCommands[2],[cargo(["test","--locked","--workspace","--","--format","pretty"])]);return enforceExecutedTests(step,rustTestCounts(step.outputs[0]?.output||""));}},
      {index:3,audit:true,run:async()=>{const step=await run(rustCommands[3],[cargo(["metadata","--format-version","1","--locked"])]);if(step.exitCode!==0||step.timedOut)return step;try{return auditStep(step,await tools.osv("crates.io",cargoDependencies(step.outputs[0]?.output||"")));}catch(error){return {...step,exitCode:2,log:`${step.log}\nCargo audit is incomplete: ${error.message}`.slice(-32000)};}}},
    ]};
  }
  if(unit.runtime==="dotnet"){
    const env=ecosystemEnvironment("dotnet",root);
    const projects=files.filter(file=>dotnetProject.test(file.path)&&!ignoredManifestPath.test(file.path));
    const solutions=files.filter(file=>dotnetSolution.test(file.path)&&!ignoredManifestPath.test(file.path)).map(file=>file.path);
    const targets=solutions.length?solutions:projects.map(file=>file.path);
    if(targets.length>32)throw new Error("Verification supports at most 32 .NET build targets.");
    const testProjects=projects.filter(file=>isDotnetTestProject(decoded(file))).map(file=>file.path);
    const runtimeProjects=projects.filter(file=>!isDotnetTestProject(decoded(file))).map(file=>file.path);
    const auditTargets=runtimeProjects.length?runtimeProjects:targets;
    if(!testProjects.length)missing.push(`${variant} .NET: no test project found`);
    const invoke=args=>({command:"dotnet",args,cwd:root,uid,env,timeoutMs:1200000});
    const results=path.join(root,".modernize-trx");
    return {missing,steps:[
      {index:0,run:()=>run(dotnetCommands[0],targets.map(target=>invoke(["restore",target])))},
      {index:1,run:()=>run(dotnetCommands[1],targets.map(target=>invoke(["build",target,"--no-restore","-c","Release","-nologo"])))},
      ...(testProjects.length?[{index:2,run:async()=>{const step=await run(dotnetCommands[2],testProjects.map((project,index)=>invoke(["test",project,"-c","Release","--logger","trx","--results-directory",path.join(results,String(index))])));return enforceExecutedTests(step,trxCounts(await tools.readReports(results,/\.trx$/)));}}]:[]),
      {index:3,audit:true,run:async()=>{const step=await run(dotnetCommands[3],auditTargets.map(target=>({...invoke(["list",target,"package","--vulnerable","--include-transitive","--format","json"]),fullOutputLimit:20_000_000})));return step.exitCode===0&&!step.timedOut?evaluated(step,()=>auditStep(step,dotnetFindings(step.outputs))):step;}},
    ]};
  }
  if(unit.runtime==="maven"||unit.runtime==="gradle"){
    const feature=javaFeature(files,unit.project,unit.runtime);
    const env=ecosystemEnvironment("java",cwd,{feature});
    const hasTests=files.some(file=>inUnit(unit.project,file.path)&&/(^|\/)src\/test\/.+\.(java|kt|groovy|scala)$/.test(file.path));
    if(!hasTests)missing.push(`${variant} ${unit.project}: no JVM tests found under src/test`);
    const inventory=path.join(cwd,`.modernize-${unit.runtime}-dependencies.txt`);
    if(unit.runtime==="maven"){
      const wrapper=files.some(file=>file.path===local(unit.project,"mvnw"));
      const common=["-B","-Dstyle.color=never",`-Dmaven.repo.local=${path.join(cwd,".m2/repository")}`,"-Dorg.slf4j.simpleLogger.log.org.apache.maven.cli.transfer.Slf4jMavenTransferListener=warn"];
      const maven=args=>wrapper?{command:"sh",args:["./mvnw",...common,...args],cwd,uid,env,timeoutMs:1500000}:{command:"/opt/maven/bin/mvn",args:[...common,...args],cwd,uid,env,timeoutMs:1500000};
      return {missing,steps:[
        {index:0,run:()=>run(mavenCommands[0],[maven(["-DskipTests","package"])])},
        ...(hasTests?[{index:1,run:async()=>enforceExecutedTests(await run(mavenCommands[1],[maven(["test"])]),junitCounts(await tools.readReports(cwd,/\/target\/surefire-reports\/TEST-[^/]+\.xml$/)))}]:[]),
        {index:2,audit:true,run:async()=>{const step=await run(mavenCommands[2],[maven([toolchains.mavenDependencyPlugin,"-DincludeScope=runtime",`-DoutputFile=${inventory}`,"-DappendOutput=true"])]);if(step.exitCode!==0||step.timedOut)return step;try{return auditStep(step,await tools.osv("Maven",mavenDependencies(await tools.readFile(inventory,{limit:20_000_000}))));}catch(error){return {...step,exitCode:2,log:`${step.log}\nDependency audit could not be completed: ${error.message}`.slice(-32000)};}}},
      ]};
    }
    const wrapper=files.some(file=>file.path===local(unit.project,"gradlew"));
    const wrapperVersion=decoded(files.find(file=>file.path===local(unit.project,"gradle/wrapper/gradle-wrapper.properties"))).match(/gradle-(\d+)\.(\d+)/);
    const configurationCacheFlag=!wrapper||!wrapperVersion||Number(wrapperVersion[1])>6||Number(wrapperVersion[1])===6&&Number(wrapperVersion[2])>=6;
    const gradle=args=>wrapper?{command:"sh",args:["./gradlew","--no-daemon","--console=plain",...args],cwd,uid,env,timeoutMs:1500000}:{command:"/opt/gradle/bin/gradle",args:["--no-daemon","--console=plain",...args],cwd,uid,env,timeoutMs:1500000};
    return {missing,steps:[
      {index:0,run:()=>run(gradleCommands[0],[gradle(["assemble"])])},
      ...(hasTests?[{index:1,run:async()=>enforceExecutedTests(await run(gradleCommands[1],[gradle(["test"])]),junitCounts(await tools.readReports(cwd,/\/build\/test-results\/[^/]+\/TEST-[^/]+\.xml$/)))}]:[]),
      {index:2,audit:true,run:async()=>{const step=await run(gradleCommands[2],[gradle(["-I","/opt/modernize/dependencies.init.gradle",`-Dmodernize.output=${inventory}`,...(configurationCacheFlag?["--no-configuration-cache"]:[]),"modernizeDependencies"])]);if(step.exitCode!==0||step.timedOut)return step;try{const content=existsSync(inventory)?await tools.readFile(inventory,{limit:20_000_000}):"";return auditStep(step,await tools.osv("Maven",gradleDependencies(content)));}catch(error){return {...step,exitCode:2,log:`${step.log}\nDependency audit could not be completed: ${error.message}`.slice(-32000)};}}},
    ]};
  }
  if(unit.runtime==="go"){
    const env=ecosystemEnvironment("go",cwd);
    const go=(args,extra={})=>({command:"/opt/go/bin/go",args,cwd,uid,env,timeoutMs:1200000,...extra});
    const hasTests=files.some(file=>inUnit(unit.project,file.path)&&file.path.endsWith("_test.go"));
    if(!hasTests)missing.push(`${variant} ${unit.project}: no Go tests found`);
    return {missing,steps:[
      {index:0,run:async()=>{await (tools.ensureDirectory||ensureOwnedDirectory)(env.TMPDIR,uid);return run(goCommands[0],[go(["mod","download"])]);}},
      {index:1,run:()=>run(goCommands[1],[go(["build","./..."])])},
      ...(hasTests?[{index:2,run:async()=>{const step=await run(goCommands[2],[go(["test","-json","./..."],{fullOutputLimit:50_000_000})]);return enforceExecutedTests(step,goTestCounts(step.outputs[0]?.output||""));}}]:[]),
      {index:3,audit:true,run:async()=>{const step=await run(goCommands[3],[go(["run",toolchains.govulncheck,"./..."],{fullOutputLimit:20_000_000})]);if(step.timedOut||![0,3].includes(step.exitCode))return step;const ids=[...new Set([...(step.outputs[0]?.output||"").matchAll(/Vulnerability #\d+:\s*(GO-\d{4}-\d+)/g)].map(match=>match[1]))];if(step.exitCode===3&&!ids.length)return {...step,exitCode:2,log:`${step.log}\ngovulncheck reported findings that could not be parsed.`};return auditStep({...step,exitCode:0},ids.map(id=>({package:unit.project,version:"",id,severity:"unknown"})));}},
    ]};
  }
  const version=phpVersion(files,unit.project);const php=`/usr/bin/php${version}`;const composer=composerFor(version);
  const env=ecosystemEnvironment("php",cwd);
  let manifest={};try{manifest=JSON.parse(decoded(files.find(file=>file.path===local(unit.project,"composer.json"))));}catch{}
  const hasTooling=Object.keys(manifest["require-dev"]||{}).some(name=>/^(phpunit\/phpunit|pestphp\/pest)$/i.test(name));
  const hasTests=files.some(file=>inUnit(unit.project,file.path)&&/(^|\/)tests?\/.+\.php$/i.test(file.path));
  if(!hasTooling||!hasTests)missing.push(`${variant} ${unit.project}: PHPUnit or Pest tests are required`);
  const junit=path.join(cwd,".modernize-phpunit-junit.xml");
  const invoke=(command,args,extra={})=>({command,args,cwd,uid,env,timeoutMs:1200000,...extra});
  return {missing,steps:[
    {index:0,run:()=>run(phpCommands[0],[invoke(php,[composer.path,"install","--no-interaction","--no-progress","--prefer-dist","--no-scripts"])])},
    {index:1,run:()=>run(phpCommands[1],[invoke("bash",["-c","set -o pipefail; find . \\( -path ./vendor -o -path './.*' \\) -prune -o -type f -name '*.php' -print0 | xargs -0 -r -n1 \"$0\" -l | { grep -v '^No syntax errors detected' || true; }",php],{display:`${php} -l (every project PHP file)`})])},
    ...(hasTooling&&hasTests?[{index:2,run:async()=>{const runner=tools.exists(path.join(cwd,"vendor/bin/phpunit"))?"vendor/bin/phpunit":"vendor/bin/pest";const step=await run(phpCommands[2],[invoke(php,[runner,"--log-junit",junit])]);let reports=[];try{reports=[{content:await tools.readFile(junit,{limit:20_000_000})}];}catch{}return enforceExecutedTests(step,junitCounts(reports));}}]:[]),
    {index:3,audit:true,run:async()=>{const step=await run(phpCommands[3],[invoke("/usr/bin/php8.5",[toolchains.composer.current.path,"audit","--locked","--no-dev","--format=json","--abandoned=ignore"],{fullOutputLimit:20_000_000})]);if(step.timedOut)return step;const output=step.outputs[0]?.output||"";if(!output.includes("{")&&/No (installed|locked) packages found/.test(step.log)){let runtimePackages;try{runtimePackages=JSON.parse(await tools.readFile(path.join(cwd,"composer.lock"),{limit:20_000_000})).packages;}catch{}if(Array.isArray(runtimePackages)&&runtimePackages.length===0)return auditStep({...step,log:`${step.log}\ncomposer.lock declares no runtime packages; there is nothing to audit.`},[]);}return evaluated(step,()=>auditStep({...step,exitCode:0},composerFindings(output)));}},
  ]};
}

export async function prepareCandidateLocks(snapshot,execute=runCommand,read=readPreparedFile,runTool=executeCommand){
  const artifacts=[];
  const hasNpm=snapshot.candidate.some(file=>file.path==="package.json"||file.path.endsWith("/package.json"));
  for(const project of hasNpm?projectsFor(snapshot.candidate,{requireScripts:false,requireLock:false}):[]){
    const manifestPath=project==="."?"package.json":`${project}/package.json`;
    const candidate=snapshot.candidate.find(file=>file.path===manifestPath);
    const original=snapshot.baseline.find(file=>file.path===manifestPath);
    const manager=nodeManager(JSON.parse(decoded(candidate)),snapshot.candidate.map(file=>file.path),project);
    if(original){
      const before=nodeManager(JSON.parse(decoded(original)),snapshot.baseline.map(file=>file.path),project);
      if(before.name!==manager.name||before.version!==manager.version||JSON.stringify(before.integrity)!==JSON.stringify(manager.integrity))throw new Error(`Changing the source package manager/version in ${project} is not permitted.`);
    }
    const lockPath=manager.lock;
    const lock=snapshot.candidate.find(file=>file.path===lockPath);
    const originalLock=snapshot.baseline.find(file=>file.path===lockPath);
    if(lock&&candidate.content===original?.content&&lock.content===originalLock?.content)continue;
    const cwd=path.join("/work","candidate",project);
    const args=manager.name==="npm"?["install","--package-lock-only","--ignore-scripts","--no-fund"]:manager.name==="pnpm"?["install","--lockfile-only","--ignore-scripts","--no-frozen-lockfile"]:manager.classic?["install","--ignore-scripts","--non-interactive"]:["install","--mode=update-lockfile"];
    const step=manager.name==="npm"&&!manager.version?await execute(args,cwd,10002):await runTool(managerExecutable(manager),args,cwd,10002,900000,{YARN_IGNORE_PATH:"1",YARN_ENABLE_SCRIPTS:"false",YARN_ENABLE_IMMUTABLE_INSTALLS:"false",npm_config_manage_package_manager_versions:"false"});
    if(step.exitCode!==0||step.timedOut)throw new Error(`Dependency preparation failed for ${project}: ${step.log.slice(-1500)}`);
    const manifest=await read(path.join(cwd,"package.json"),"utf8");
    if(Buffer.from(manifest).toString("base64")!==candidate.content)throw new Error("Dependency preparation unexpectedly changed the candidate manifest.");
    const content=await read(path.join("/work","candidate",lockPath),"utf8");
    if(Buffer.byteLength(content)>2_000_000)throw new Error("Prepared dependency lockfile exceeds the 2 MB limit.");
    if(Buffer.from(content).toString("base64")!==lock?.content)artifacts.push({variant:"candidate",path:lockPath,content});
  }
  for(const lockPath of snapshot.baselinePreparationPaths||[]){
    validatePath(lockPath);
    const project=path.posix.dirname(lockPath);
    const cwd=path.join("/work","baseline",project);
    const manifestPath=lockPath.replace(/package-lock\.json$/,"package.json");
    const expected=snapshot.baseline.find(file=>file.path===manifestPath);
    if(!expected)throw new Error("Missing baseline manifest for tooling preparation.");
    const manager=nodeManager(JSON.parse(decoded(expected)),snapshot.baseline.map(file=>file.path),project);
    if(manager.name!=="npm"||manager.lock!==lockPath)throw new Error("Automatic baseline tooling preparation is qualified for npm locks only.");
    const args=["install","--package-lock-only","--ignore-scripts","--no-fund"];
    const step=manager.version?await runTool(managerExecutable(manager),args,cwd,10001,900000):await execute(args,cwd,10001);
    if(step.exitCode!==0||step.timedOut)throw new Error(`Baseline test tooling lock preparation failed for ${project}: ${step.log.slice(-1500)}`);
    if(!expected||Buffer.from(await read(path.join(cwd,"package.json"),"utf8")).toString("base64")!==expected.content)throw new Error("Baseline preparation unexpectedly changed the baseline manifest.");
    const content=await read(path.join(cwd,"package-lock.json"),"utf8");
    if(Buffer.byteLength(content)>2_000_000)throw new Error("Baseline test tooling lock exceeds the 2 MB limit.");
    artifacts.push({variant:"baseline",path:lockPath,content});
  }
  const candidateFile=filePath=>snapshot.candidate.find(file=>file.path===filePath);
  const changedArtifact=(filePath,content)=>{if(Buffer.byteLength(content)>2_000_000)throw new Error(`Prepared ${filePath} exceeds the 2 MB limit.`);if(Buffer.from(content).toString("base64")!==candidateFile(filePath)?.content)artifacts.push({variant:"candidate",path:filePath,content});};
  for(const unit of pythonUnits(snapshot.candidate.map(file=>file.path))){
    const before=pythonUnits(snapshot.baseline.map(file=>file.path)).find(item=>item.project===unit.project);
    if(before&&before.manager!==unit.manager)throw new Error("Changing the original Python lock owner is not permitted.");
    if(unit.manager==="requirements")continue;
    const original=snapshot.baseline.find(file=>file.path===unit.manifest);
    if(original?.content===candidateFile(unit.manifest)?.content&&candidateFile(unit.lock)?.content===snapshot.baseline.find(file=>file.path===unit.lock)?.content)continue;
    const cwd=path.join("/work","candidate",unit.project);
    const args=unit.manager==="poetry"?["lock","--no-interaction"]:["lock"];
    const step=await runTool(`/opt/verification-tools/bin/${unit.manager}`,args,cwd,10002,900000,{PATH:"/opt/verification-tools/bin:/usr/local/bin:/usr/bin:/bin",PIPENV_VENV_IN_PROJECT:"1",PIPENV_IGNORE_VIRTUALENVS:"1",UV_PYTHON_DOWNLOADS:"never"});
    if(step.exitCode!==0||step.timedOut)throw new Error(`${unit.manager} lock preparation failed: ${step.log.slice(-1500)}`);
    if(Buffer.from(await read(path.join("/work","candidate",unit.manifest))).toString("base64")!==candidateFile(unit.manifest)?.content)throw new Error("Python lock preparation changed the source manifest.");
    changedArtifact(unit.lock,await read(path.join("/work","candidate",unit.lock)));
  }
  for(const unit of ecosystemUnits(snapshot.candidate.map(file=>file.path))){
    if(!["go","php","rust","ruby"].includes(unit.runtime))continue;
    const cwd=path.join("/work","candidate",unit.project);
    if(unit.runtime==="ruby"){
      const version=bundlerVersion(snapshot.candidate,unit.project);
      if(snapshot.baseline.some(file=>file.path===local(unit.project,"Gemfile"))&&bundlerVersion(snapshot.baseline,unit.project)!==version)throw new Error("The original exact Bundler version cannot be silently changed.");
      const lockPath=local(unit.project,"Gemfile.lock");
      const changed=snapshot.candidate.some(file=>inUnit(unit.project,file.path)&&(/(^|\/)Gemfile$|\.gemspec$/.test(file.path))&&snapshot.baseline.find(original=>original.path===file.path)?.content!==file.content);
      if(!changed&&candidateFile(lockPath)?.content===snapshot.baseline.find(file=>file.path===lockPath)?.content)continue;
      const step=await runTool("ruby3.1",["-S","bundle",`_${version}_`,"lock"],cwd,10002,900000,{PATH:"/opt/modernize/ruby-gems/bin:/usr/local/bin:/usr/bin:/bin",GEM_PATH:"/opt/modernize/ruby-gems:/usr/lib/ruby/gems/3.1.0",GEM_HOME:path.join(cwd,".gem-home"),BUNDLE_PATH:path.join(cwd,".modernize-gems"),BUNDLE_FROZEN:"false",BUNDLE_DEPLOYMENT:"false"});
      if(step.exitCode!==0||step.timedOut)throw new Error(`Bundler lock preparation failed: ${step.log.slice(-1500)}`);
      changedArtifact(lockPath,await read(path.join(cwd,"Gemfile.lock")));
      continue;
    }
    if(unit.runtime==="rust"){
      const lockPath=local(unit.project,"Cargo.lock");
      const changed=snapshot.candidate.some(file=>inUnit(unit.project,file.path)&&/(^|\/)Cargo\.toml$/.test(file.path)&&snapshot.baseline.find(original=>original.path===file.path)?.content!==file.content);
      if(!changed&&candidateFile(lockPath)&&candidateFile(lockPath).content===snapshot.baseline.find(file=>file.path===lockPath)?.content)continue;
      const step=await runTool("/opt/cargo/bin/cargo",["generate-lockfile"],cwd,10002,900000,{PATH:"/opt/cargo/bin:/usr/local/bin:/usr/bin:/bin",RUSTUP_HOME:"/opt/rustup",RUSTUP_TOOLCHAIN:rustVersion(snapshot.candidate,unit.project),CARGO_HOME:path.join(cwd,".cargo-home")});
      if(step.exitCode!==0||step.timedOut)throw new Error(`Cargo lock preparation failed: ${step.log.slice(-1500)}`);
      changedArtifact(lockPath,await read(path.join(cwd,"Cargo.lock")));
      continue;
    }
    if(unit.runtime==="go"){
      const modPath=local(unit.project,"go.mod");const sumPath=local(unit.project,"go.sum");
      const original=snapshot.baseline.find(file=>file.path===modPath);
      if(original?.content===candidateFile(modPath).content&&(candidateFile(sumPath)||!/^\s*require\b/m.test(decoded(candidateFile(modPath)))))continue;
      const goEnvironment=ecosystemEnvironment("go",cwd);
      await ensureOwnedDirectory(goEnvironment.TMPDIR,10002);
      const step=await runTool("/opt/go/bin/go",["mod","tidy"],cwd,10002,1200000,goEnvironment);
      if(step.exitCode!==0||step.timedOut)throw new Error(`Go dependency preparation failed for ${unit.project}: ${step.log.slice(-1500)}`);
      changedArtifact(modPath,await read(path.join(cwd,"go.mod")));
      if(existsSync(path.join(cwd,"go.sum")))changedArtifact(sumPath,await read(path.join(cwd,"go.sum")));
      continue;
    }
    const manifestPath=local(unit.project,"composer.json");const lockPath=local(unit.project,"composer.lock");
    const original=snapshot.baseline.find(file=>file.path===manifestPath);
    if(original?.content===candidateFile(manifestPath).content&&candidateFile(lockPath))continue;
    let manifest={};try{manifest=JSON.parse(decoded(candidateFile(manifestPath)));}catch{throw new Error(`Invalid candidate composer.json: ${manifestPath}`);}
    if(!Object.keys({...(manifest.require||{}),...(manifest["require-dev"]||{})}).some(name=>!/^(php|ext-.+|lib-.+)$/i.test(name)))continue;
    const version=phpVersion(snapshot.candidate,unit.project);
    const step=await runTool(`/usr/bin/php${version}`,[composerFor(version).path,"update","--no-install","--no-scripts","--no-plugins","--no-interaction","--no-progress"],cwd,10002,1200000,ecosystemEnvironment("php",cwd));
    if(step.exitCode!==0||step.timedOut)throw new Error(`Composer dependency preparation failed for ${unit.project}: ${step.log.slice(-1500)}`);
    if(Buffer.from(await read(path.join(cwd,"composer.json"))).toString("base64")!==candidateFile(manifestPath).content)throw new Error("Composer preparation unexpectedly changed the candidate manifest.");
    changedArtifact(lockPath,await read(path.join(cwd,"composer.lock")));
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
  if(args[0]!=="test")return executeCommand("npm",args,cwd,uid,timeoutMs,args[0]==="audit"?{npm_config_registry:"https://registry.npmjs.org/"}:{});
  const manifest=JSON.parse(await readFile(path.join(cwd,"package.json"),"utf8"));
  const script=manifest.scripts?.test||"";
  const jsonReporter=/\b(vitest|jest)\b/.test(script);
  const reportPath=path.join(cwd,".modernize-verification-tests.json");
  if(jsonReporter){
    const cleared=await executeCommand("node",["-e","require('node:fs').rmSync(process.argv[1],{force:true})",reportPath],cwd,uid,30000);
    if(cleared.exitCode!==0||cleared.timedOut)return {...cleared,command:"npm test -- --run",exitCode:1};
  }
  const testArgs=/\bvitest\b/.test(script)?["test","--","--run","--reporter=json",`--outputFile=${reportPath}`]:/\bjest\b/.test(script)?["test","--","--runInBand","--json",`--outputFile=${reportPath}`]:["test"];
  const step=await executeCommand("npm",testArgs,cwd,uid,timeoutMs,{},20_000_000);
  step.command="npm test -- --run";
  try{
    const output=jsonReporter?await readPreparedFile(reportPath,{limit:20_000_000}):step.output;
    return enforceExecutedTests(step,npmTestCounts(output,jsonReporter?"json":"tap"));
  }catch(error){return {...step,exitCode:step.exitCode||1,log:`${step.log}\nExecuted npm tests could not be established: ${error.message}`.slice(-32000)};}
}
export function nodeAuditFindings(output,manager){
    const findings=[];
    let advertised;
    const add=advisory=>{
      const severity=advisory.severity;
      const id=advisory.github_advisory_id||advisory.url||String(advisory.id||"");
      const name=advisory.module_name||advisory.name;
      if(typeof severity!=="string"||!id||typeof name!=="string")throw new Error("Incomplete package-manager advisory.");
      findings.push({package:name,version:"",id,severity});
    };
    if(manager.name==="yarn"&&manager.classic){
      let summary=false;
      for(const line of output.split("\n").filter(Boolean)){const event=JSON.parse(line);if(event.type==="auditAdvisory")add(event.data.advisory);if(event.type==="auditSummary"){summary=true;advertised=event.data?.vulnerabilities;}}
      if(!summary)throw new Error("Yarn did not return a complete audit summary.");
    }else{
      if(manager.name==="yarn"&&!manager.classic&&!output.trim())return findings;
      if(manager.name==="pnpm"){
        const report=JSON.parse(output);
        if(!report.metadata?.vulnerabilities||!report.advisories)throw new Error("pnpm did not return a complete audit report.");
        advertised=report.metadata.vulnerabilities;
        Object.values(report.advisories).forEach(add);
      }else{
        for(const line of output.split("\n").filter(item=>item.trim())){
          const record=JSON.parse(line);
          if(record?.type==="info"&&record.data==="No audit suggestions")continue;
          if(record?.children&&typeof record.value==="string")add({module_name:record.value,id:record.children.ID,url:record.children.URL,severity:record.children.Severity});
          else if(record&&typeof record==="object"&&!Array.isArray(record)&&Object.values(record).every(value=>Array.isArray(value))){
            for(const [name,advisories] of Object.entries(record))for(const advisory of advisories)add({...advisory,module_name:name});
          }else throw new Error("Yarn did not return a recognized complete advisory report.");
        }
      }
    }
    if(manager.name==="pnpm"||manager.classic){
      if(!advertised||Object.values(advertised).some(count=>!Number.isSafeInteger(count)||count<0))throw new Error("Invalid audit summary counters.");
      for(const [severity,count] of Object.entries(advertised))if(count>0&&!findings.some(item=>item.severity===severity))throw new Error("Audit summary findings are missing advisory details.");
    }
    return findings;
  }
  export async function runNodeCommand(manager,index,cwd,uid,manifest,tools=defaultTools){
    const executable=managerExecutable(manager);
    const env={YARN_IGNORE_PATH:"1",YARN_ENABLE_SCRIPTS:"false",COREPACK_ENABLE_PROJECT_SPEC:"0",npm_config_manage_package_manager_versions:"false",...(index===3?{npm_config_registry:"https://registry.npmjs.org/",YARN_REGISTRY:"https://registry.npmjs.org/",YARN_NPM_AUDIT_REGISTRY:"https://registry.npmjs.org/"}:{})};
    if(index===3&&manager.name==="yarn"&&!manager.classic){
      for(const key of ["npmAuditExcludePackages","npmAuditIgnoreAdvisories"]){
        const checked=await tools.execute(executable,["config","get",key,"--json"],cwd,uid,30000,env,1_000_000);
        try{
          const value=JSON.parse(checked.output);
          if(checked.exitCode!==0||checked.timedOut||!Array.isArray(value)||value.length)throw new Error("Repository audit exclusions cannot waive required dependency checks.");
        }catch(error){return {...checked,command:nodeCommands.yarn[3],exitCode:2,log:`${checked.log}\nYarn audit configuration is incomplete: ${error.message}`.slice(-32000)};}
      }
    }
    const install=manager.name==="npm"?["ci","--ignore-scripts","--no-fund"]:manager.name==="pnpm"?["install","--frozen-lockfile","--ignore-scripts"]:manager.classic?["install","--frozen-lockfile","--ignore-scripts","--non-interactive"]:["install","--immutable"];
    const audit=manager.name==="npm"?["audit","--omit=dev","--audit-level=high"]:manager.name==="pnpm"?["audit","--prod","--json"]:manager.classic?["audit","--groups","dependencies","--json"]:["npm","audit","--environment","production","--all","--recursive","--json"];
    const script=manifest.scripts?.test||"";
    const jsonReporter=/\b(vitest|jest)\b/.test(script);
    const reportPath=path.join(cwd,".modernize-verification-tests.json");
    if(index===2&&jsonReporter){
      const cleared=await tools.execute("node",["-e","require('node:fs').rmSync(process.argv[1],{force:true})",reportPath],cwd,uid,30000);
      if(cleared.exitCode!==0||cleared.timedOut)return {...cleared,command:nodeCommands[manager.name][2],exitCode:1};
    }
    const testFlags=/\bvitest\b/.test(script)?["--run","--reporter=json",`--outputFile=${reportPath}`]:/\bjest\b/.test(script)?["--runInBand","--json",`--outputFile=${reportPath}`]:[];
    const testArgs=manager.name==="npm"?["test",...(testFlags.length?["--",...testFlags]:[])]:["run","test",...(manager.name==="yarn"&&manager.classic&&testFlags.length?["--"]:[]),...testFlags];
    let step={...await tools.execute(executable,[install,["run","build"],testArgs,audit][index],cwd,uid,900000,env,30_000_000),command:nodeCommands[manager.name][index]};
    if(index===2){
      try{return enforceExecutedTests(step,npmTestCounts(jsonReporter?await tools.readFile(reportPath,{limit:20_000_000}):step.output,jsonReporter?"json":"tap"));}
      catch(error){return {...step,exitCode:step.exitCode||1,log:`${step.log}\nExecuted tests could not be established: ${error.message}`.slice(-32000)};}
    }
    if(index===3&&manager.name!=="npm"&&!step.timedOut){
      try{
        const findings=nodeAuditFindings(step.output,manager);
        if(step.exitCode!==0&&!findings.length)return {...step,exitCode:2,log:`${step.log}\nThe audit exited unsuccessfully without verifiable findings.`.slice(-32000)};
        return auditStep(step,findings);
      }catch(error){return {...step,exitCode:2,log:`${step.log}\nDependency audit is incomplete: ${error.message}`.slice(-32000)};}
    }
    return step;
  }
export async function executeCommand(command,args,cwd,uid,timeoutMs=240000,extraEnv={},fullOutputLimit=0){
  const started=Date.now();let log="";let timedOut=false;let output="";let outputBytes=0;let outputTruncated=false;
  const variant=uid===10001?"baseline":"candidate";
  return new Promise(resolve=>{
    const child=spawn(command,args,{cwd,uid,gid:uid,detached:true,stdio:["ignore","pipe","pipe"],env:{PATH:"/usr/bin:/usr/local/bin:/bin",HOME:cwd,CI:"true",NODE_ENV:"test",MODERNIZE_VERIFICATION_VARIANT:variant,PYTHONUNBUFFERED:"1",PYTHONNOUSERSITE:"1",PIP_NO_INPUT:"1",TMPDIR:cwd,DEBIAN_FRONTEND:"noninteractive",npm_config_cache:path.join(cwd,".npm-cache"),npm_config_update_notifier:"false",npm_config_ignore_scripts:args[0]==="ci"?"true":"false",...extraEnv}});
    const capture=data=>{log=(log+data.toString()).slice(-32000);};
    child.stdout.on("data",data=>{capture(data);if(fullOutputLimit){outputBytes+=data.length;if(outputBytes>fullOutputLimit)outputTruncated=true;else output+=data.toString();}});
    child.stderr.on("data",capture);
    const terminate=()=>{if(child.pid)try{process.kill(-child.pid,"SIGKILL");}catch{}};
    const timer=setTimeout(()=>{timedOut=true;terminate();},timeoutMs);
    let settled=false;
    const finish=exitCode=>{if(settled)return;settled=true;clearTimeout(timer);terminate();if(outputTruncated)log=`${log}\nCommand output exceeded the evidence limit and was not evaluated.`.slice(-32000);resolve({command:`${command} ${args.join(" ")}`,exitCode:outputTruncated&&exitCode===0?1:exitCode,timedOut,log,output,durationMs:Date.now()-started});};
    child.on("error",error=>{capture(Buffer.from(error.message));finish(null);});
    child.on("close",code=>finish(code));
  });
}

export function auditFindingsRecorded(log){
  const line=log.split("\n").reverse().find(item=>item.startsWith(auditFindingsPrefix));
  if(!line)return false;
  try{
    const report=JSON.parse(line.slice(auditFindingsPrefix.length));
    return Array.isArray(report.findings)&&report.findings.length>0&&report.findings.every(item=>typeof item.package==="string"&&typeof item.id==="string"&&typeof item.severity==="string"&&typeof item.blocking==="boolean")&&report.findings.some(item=>item.blocking);
  }catch{return false;}
}
const defaultTools={execute:executeCommand,readReports:readOwnedReports,readFile:readPreparedFile,osv:osvFindings,exists:existsSync};
export function reviewedRewrite(snapshot){
  if(snapshot.scenario!=="rewrite")return false;
  const original=snapshot.baseline?.find(file=>file.path==="tests/modernization-acceptance.json");
  if(!original||snapshot.candidate?.find(file=>file.path===original.path)?.content!==original.content)return false;
  try{
    const source=JSON.parse(decoded(original));
    if(source.version!==1||source.scenario!=="rewrite"||!Array.isArray(source.checks))return false;
    const canonical=check=>JSON.stringify([check.id,check.kind,check.project||".",check.variants,check.command,check.args||[],check.report,check.timeoutSeconds||240]);
    return source.checks.some(check=>check.kind==="contract"&&check.variants?.includes("baseline")&&check.variants?.includes("candidate")&&snapshot.scenarioChecks?.some(expected=>canonical(expected)===canonical(check)));
  }catch{return false;}
}

export async function verifySnapshot(snapshot,publish,execute=runCommand,executePython=runPythonCommand,tools=defaultTools){
  const report={status:"failed",reason:"Verification started",steps:[]};
  const missing=[];
  const pythonFailures=[];
  const baselineAuditFailures=[];
  const rewrite=reviewedRewrite(snapshot);
  for(const source of snapshot.baseline||[]){
    const test=isImmutableOriginalTest(source.path)||source.path.endsWith(".rs")&&/#\s*\[\s*(?:test|cfg\s*\(\s*test\s*\))/.test(decoded(source));
    if(test&&snapshot.candidate?.find(file=>file.path===source.path)?.content!==source.content)pythonFailures.push(`Original test source cannot be removed or rewritten: ${source.path}`);
    if(/(^|\/)package\.json$/.test(source.path)&&!snapshot.candidate?.some(file=>file.path===source.path)&&!rewrite)missing.push(`Original JavaScript project cannot be removed without an executed reviewed black-box contract: ${source.path}`);
  }
  for(const before of ecosystemUnits((snapshot.baseline||[]).map(file=>file.path)))if(!ecosystemUnits((snapshot.candidate||[]).map(file=>file.path)).some(after=>after.runtime===before.runtime&&after.project===before.project)&&!rewrite)missing.push(`Original ${before.runtime} project cannot be removed without an executed reviewed black-box contract: ${before.project}`);
  try{
    const beforeUnits=pythonUnits((snapshot.baseline||[]).map(file=>file.path));
    const afterUnits=pythonUnits((snapshot.candidate||[]).map(file=>file.path));
    for(const before of beforeUnits){
      const after=afterUnits.find(after=>before.project===after.project);
      if(after?after.manager!==before.manager:!rewrite)missing.push(`Original Python manager in ${before.project} cannot be removed or converted.`);
    }
  }catch(error){missing.push(error.message);}
  for(const [variant,uid] of [["baseline",10001],["candidate",10002]]){
    const files=snapshot[variant];
    missing.push(...blockedRuntimeReasons(files.map(file=>file.path)).map(reason=>`${variant}: ${reason}`));
    let pythonProjects=[];
    try{pythonProjects=pythonUnits(files.map(file=>file.path));}catch(error){missing.push(`${variant}: ${error.message}`);}
    for(const unit of pythonProjects){
      const {project}=unit;
      const testPrefix=project==="."?"tests/":`${project}/tests/`;
      const hasTests=files.some(file=>file.path.startsWith(testPrefix)&&/(^|\/)test_[^/]+\.py$/.test(file.path));
      if(!hasTests)missing.push(`${variant} ${project}: no Python unittest tests found under ${testPrefix}`);
      const hasTestDependencies=unit.manager==="requirements"&&files.some(file=>file.path===(project==="."?"requirements-dev.txt":`${project}/requirements-dev.txt`));
      for(const index of [0,1,...(hasTestDependencies?[5]:[]),2,3,4]){
        if(index===3&&!hasTests)continue;
        let step=unit.manager==="requirements"?await executePython(index,path.join("/work",variant,project),uid):await runManagedPythonCommand(unit,index,path.join("/work",variant,project),uid,tools);
        if(index===3)step=enforceExecutedTests(step,step.tests||{tests:0,failed:0,skipped:0});
        if(index===4)step=completePythonAudit(step);
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
    const units=ecosystemUnits(files.map(file=>file.path));
    for(const unit of units){
      let plan;
      try{plan=ecosystemPlan(unit,variant,uid,files,tools);}catch(error){pythonFailures.push(`${variant} ${unit.runtime} ${unit.project}: ${error.message}`);continue;}
      missing.push(...plan.missing);
      for(const item of plan.steps){
        const step=await item.run();delete step.outputs;
        report.steps.push({...step,variant,project:unit.project});
        await publish({...report,reason:`${variant}: ${unit.project}: ${step.command}`},false);
        if(step.exitCode!==0||step.timedOut){
          if(variant==="baseline"&&item.audit&&step.exitCode===1&&!step.timedOut&&auditFindingsRecorded(step.log)){
            baselineAuditFailures.push(`${variant} ${unit.project}: pre-existing ${unit.runtime} dependency vulnerabilities (see audit report).`);
            continue;
          }
          pythonFailures.push(`${variant} ${unit.runtime} ${unit.project}: ${step.command} ${step.timedOut?"timed out":`failed (exit ${step.exitCode})`}.`);
          if(item.index<2||step.timedOut)break;
        }
      }
    }
    let projects=[];
    const hasNpm=files.some(file=>file.path==="package.json"||file.path.endsWith("/package.json"));
    if(hasNpm){try{projects=projectsFor(files,{requireScripts:false});}catch(error){missing.push(`${variant}: ${error.message}`);}}
    if(!pythonProjects.length&&!hasNpm&&!units.length)missing.push(`${variant}: unsupported stack; expected npm, Python, .NET, Maven, Gradle, Go or PHP Composer project files`);
    for(const project of projects){
      const manifestPath=project==="."?"package.json":`${project}/package.json`;
      const manifest=JSON.parse(Buffer.from(snapshot[variant].find(file=>file.path===manifestPath).content,"base64").toString("utf8"));
      const manager=nodeManager(manifest,files.map(file=>file.path),project);
      if(variant==="candidate"){
        const source=snapshot.baseline.find(file=>file.path===manifestPath);
        if(source){
          const before=nodeManager(JSON.parse(decoded(source)),snapshot.baseline.map(file=>file.path),project);
          if(before.name!==manager.name||before.version!==manager.version||JSON.stringify(before.integrity)!==JSON.stringify(manager.integrity)){missing.push(`Original package manager/version in ${project} cannot be changed.`);continue;}
        }
      }
      const commands=[["ci","--ignore-scripts","--no-fund"]];
      for(const script of ["build","test"]){
        if(typeof manifest.scripts?.[script]==="string"&&manifest.scripts[script].trim())commands.push(script==="build"?["run","build"]:["test","--","--run"]);
        else missing.push(`${variant} ${manifestPath}: missing scripts.${script}`);
      }
      commands.push(["audit","--omit=dev","--audit-level=high"]);
      for(const args of commands){
        const index=args[0]==="ci"?0:args[0]==="run"?1:args[0]==="test"?2:3;
        let step=manager.name==="npm"&&!manager.version?await execute(args,path.join("/work",variant,project),uid):await runNodeCommand(manager,index,path.join("/work",variant,project),uid,manifest,tools);
        if(args[0]==="test")step=enforceExecutedTests(step,step.tests||{tests:0,failed:0,skipped:0});
        delete step.output;
        report.steps.push({...step,variant,project});
        await publish({...report,reason:`${variant}: ${project}: ${step.command}`},false);
        if(step.exitCode!==0||step.timedOut){
          const failure=`${variant} ${project}: ${step.command} ${step.timedOut?"timed out":`failed (exit ${step.exitCode})`}.`;
          if(variant==="baseline"&&args[0]==="audit"&&!step.timedOut&&step.exitCode===1&&(manager.name==="npm"?/# npm audit report/.test(step.log)&&/\bSeverity: (high|critical)\b/.test(step.log):auditFindingsRecorded(step.log))){
            baselineAuditFailures.push(failure);
            await publish({...report,reason:`Baseline audit failed; continuing candidate checks for comparison. ${failure}`},false);
            continue;
          }
          return {...report,reason:`${failure}${baselineAuditFailures.length?` Baseline findings: ${baselineAuditFailures.join(" ")}`:""}${missing.length?` Missing prerequisites: ${missing.join("; ")}.`:""}`.slice(0,2000)};
        }
      }
    }
  }
  if(snapshot.scenarioChecks?.length){
    const {executeScenarioChecks}=await import("./scenario-verification.mjs");
    const steps=await executeScenarioChecks(snapshot,async(update)=>publish({...report,reason:update.reason,steps:[...report.steps,...update.steps]},false),{execute:tools.execute,readFile:tools.readFile,junitCounts,npmTestCounts,enforceExecutedTests});
    report.steps.push(...steps);
    for(const check of snapshot.scenarioChecks)for(const variant of check.variants){
      const command=`modernization acceptance ${check.kind}: ${check.id}`;
      const step=steps.find(step=>step.variant===variant&&step.project===check.project&&step.command===command);
      if(!step||step.exitCode!==0||step.timedOut||!step.tests||step.tests.tests<1||step.tests.failed||step.tests.skipped)pythonFailures.push(`${variant} ${check.project}: ${command} did not complete successfully with nonempty, unskipped tests.`);
    }
    if(snapshot.candidateSecurity){
      const {scanCandidate}=await import("./candidate-security.mjs");
      const step=await scanCandidate(snapshot,{...tools,materialize});
      report.steps.push(step);
      await publish({...report,reason:step.command},false);
      if(step.exitCode!==0||step.timedOut)pythonFailures.push("Candidate static or credential scanning failed; inspect the structured scan evidence.");
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
    if(snapshot.candidateSecurity){
      const {installCandidateScanner}=await import("./candidate-security.mjs");
      await installCandidateScanner({execute:executeCommand,downloadVerified,writeFile});
    }
    const plan=toolchainPlan(snapshot);
    if(toolchainsRequired(plan)){
      const selected=[plan.dotnet&&`.NET SDK ${toolchains.dotnetSdk.version}${plan.dotnet.channels.length?` with runtimes ${plan.dotnet.channels.join(", ")}`:""}`,plan.java.size&&`Temurin JDK ${[...plan.java].join(", ")}`,plan.go&&`Go ${toolchains.go.version}`,plan.php.size&&`PHP ${[...plan.php].join(", ")}`].filter(Boolean).join("; ");
      await publish({status:"failed",reason:`Installing checksum-verified toolchains in the isolated job: ${selected}.`,steps:[]},false);
      await installToolchains(plan);
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