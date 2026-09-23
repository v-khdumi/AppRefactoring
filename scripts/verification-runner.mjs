import { mkdir, writeFile, open, chown, chmod, readdir, rm, rename } from "node:fs/promises";
import {constants,createWriteStream,existsSync} from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export function pythonProjectsFor(files) {
  const manifests=files.filter(file=>file.path==="requirements.txt"||file.path.endsWith("/requirements.txt"));
  if(manifests.length>8)throw new Error("Verification supports at most eight Python requirements projects.");
  return manifests.map(file=>path.posix.dirname(file.path));
}

export const pythonCommands=[
  "python3 -m venv .verification-venv",
  ".verification-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: --upgrade pip setuptools -r requirements.txt",
  ".verification-venv/bin/python -m compileall -q -x /[.]verification-venv/ .",
  "xvfb-run Python unittest discovery (tests/test_*.py; nonempty; no skips)",
  "pip-audit --path .verification-venv/lib/python3.11/site-packages --format json",
];
export const pythonTestDependenciesCommand=".verification-venv/bin/python -m pip install --disable-pip-version-check --only-binary=:all: -c requirements.txt -r requirements-dev.txt";
export function pythonAuditFindings(log){
  try{
    const report=JSON.parse(log.slice(log.indexOf('{')));
    return Array.isArray(report.dependencies)&&report.dependencies.length>0&&report.dependencies.every(item=>typeof item.name==='string'&&typeof item.version==='string'&&!item.skip_reason&&Array.isArray(item.vulns)&&item.vulns.every(vuln=>typeof vuln.id==='string'&&vuln.id.length>0))&&report.dependencies.some(item=>item.vulns.length>0);
  }catch{return false;}
}
const unittestProgram=`import sys, unittest
suite = unittest.defaultTestLoader.discover('tests', pattern='test_*.py')
result = unittest.TextTestRunner(verbosity=2).run(suite)
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
  return {...await executeCommand(command,args,cwd,uid),command:index===5?pythonTestDependenciesCommand:pythonCommands[index]};
}

export function projectsFor(files,{requireScripts=true,requireLock=true}={}) {
  const paths=new Set(files.map(file=>file.path));
  const manifests=files.filter(file=>file.path==="package.json"||file.path.endsWith("/package.json"));
  if(!manifests.length)throw new Error("Unsupported repository: no Node/npm package.json found.");
  const root=manifests.find(file=>file.path==="package.json");
  const rootPackage=root?JSON.parse(Buffer.from(root.content,"base64").toString("utf8")):undefined;
  const selected=rootPackage?.workspaces?[root]:manifests;
  if(selected.length>8)throw new Error("Verification supports at most eight independently buildable npm projects.");
  return selected.map(file=>{
    const manifest=JSON.parse(Buffer.from(file.content,"base64").toString("utf8"));
    const project=path.posix.dirname(file.path);
    const lock=project==="."?"package-lock.json":`${project}/package-lock.json`;
    if(requireLock&&!paths.has(lock))throw new Error(`Missing ${lock}; reproducible npm ci cannot run.`);
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
export const ecosystemCommands={dotnet:dotnetCommands,maven:mavenCommands,gradle:gradleCommands,go:goCommands,php:phpCommands};
export const auditFindingsPrefix="MODERNIZE_AUDIT_FINDINGS ";
export const toolchains={
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
  ];
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
  const plan={dotnet:null,java:new Set(),maven:false,gradle:false,go:false,php:new Set()};
  for(const variant of ["baseline","candidate"]){
    const files=snapshot[variant]||[];const paths=files.map(file=>file.path);
    for(const unit of ecosystemUnits(paths)){
      if(unit.runtime==="dotnet")plan.dotnet=true;
      if(unit.runtime==="maven"||unit.runtime==="gradle"){
        plan.java.add(javaFeature(files,unit.project,unit.runtime));
        if(unit.runtime==="maven"&&!paths.includes(local(unit.project,"mvnw")))plan.maven=true;
        if(unit.runtime==="gradle"&&!paths.includes(local(unit.project,"gradlew")))plan.gradle=true;
      }
      if(unit.runtime==="go")plan.go=true;
      if(unit.runtime==="php")plan.php.add(phpVersion(files,unit.project));
    }
  }
  if(plan.dotnet)plan.dotnet=dotnetRequirements([...(snapshot.baseline||[]),...(snapshot.candidate||[])]);
  if(plan.php.size)plan.php.add("8.5");
  return plan;
}
export function toolchainsRequired(plan){return Boolean(plan.dotnet||plan.java.size||plan.go||plan.php.size);}

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

async function setupCommand(command,args,timeoutMs=900000){
  const result=await executeCommand(command,args,"/tmp",0,timeoutMs,{PATH:"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"});
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
  await setupCommand("apt-get",["update"]);
  await setupCommand("apt-get",["install","-y","--no-install-recommends",...packages]);
  await mkdir("/opt/modernize",{recursive:true,mode:0o755});
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
  for(const {content} of documents){tests+=(content.match(/<testcase\b/g)||[]).length;skipped+=(content.match(/<skipped\b/g)||[]).length;failed+=(content.match(/<(?:failure|error)\b/g)||[]).length;}
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
  const passed=step.exitCode===0&&!step.timedOut&&counts.tests>0&&counts.failed===0&&counts.skipped===0;
  const notes=[`Executed tests: ${counts.tests}; failed: ${counts.failed}; skipped: ${counts.skipped}.`,counts.tests===0?"No tests were executed; verification cannot pass.":"",counts.skipped?"Skipped tests leave required coverage unverified.":""].filter(Boolean).join(" ");
  return {...step,exitCode:passed?0:step.exitCode&&step.exitCode!==0?step.exitCode:1,log:`${step.log}\n${notes}`.slice(-32000)};
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
  for(let offset=0;offset<unique.length;offset+=500){
    const chunk=unique.slice(offset,offset+500);
    const response=await fetcher("https://api.osv.dev/v1/querybatch",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({queries:chunk.map(item=>({package:{ecosystem,name:item.name},version:item.version}))}),signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error(`OSV query failed (${response.status}).`);
    const body=await response.json();
    if(!Array.isArray(body.results)||body.results.length!==chunk.length)throw new Error("OSV returned an incomplete result set.");
    body.results.forEach((result,index)=>{
      if(result.next_page_token)throw new Error("OSV returned paginated results; the audit is incomplete.");
      for(const vulnerability of result.vulns||[]){const affected=advisories.get(vulnerability.id)||[];affected.push(chunk[index]);advisories.set(vulnerability.id,affected);}
    });
  }
  if(advisories.size>300)throw new Error("Too many advisories to evaluate completely.");
  const findings=[];
  for(const [id,affected] of advisories){
    const response=await fetcher(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`OSV advisory lookup failed for ${id}.`);
    const advisory=await response.json();
    if(advisory.withdrawn)continue;
    for(const item of affected)findings.push({package:item.name,version:item.version,id,severity:advisory.database_specific?.severity||"unknown"});
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

export function ecosystemPlan(unit,variant,uid,files,tools){
  const root=path.join("/work",variant);const cwd=path.join(root,unit.project);const missing=[];
  const run=(label,invocations)=>runInvocations(label,invocations,tools.execute);
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
    const lockPath=project==="."?"package-lock.json":`${project}/package-lock.json`;
    const candidate=snapshot.candidate.find(file=>file.path===manifestPath);
    const original=snapshot.baseline.find(file=>file.path===manifestPath);
    const lock=snapshot.candidate.find(file=>file.path===lockPath);
    if(lock&&candidate.content===original?.content)continue;
    const cwd=path.join("/work","candidate",project);
    const step=await execute(["install","--package-lock-only","--ignore-scripts","--no-fund"],cwd,10002);
    if(step.exitCode!==0||step.timedOut)throw new Error(`Dependency preparation failed for ${project}: ${step.log.slice(-1500)}`);
    const manifest=await read(path.join(cwd,"package.json"),"utf8");
    if(Buffer.from(manifest).toString("base64")!==candidate.content)throw new Error("Dependency preparation unexpectedly changed the candidate manifest.");
    const content=await read(path.join(cwd,"package-lock.json"),"utf8");
    if(Buffer.byteLength(content)>2_000_000)throw new Error("Prepared dependency lockfile exceeds the 2 MB limit.");
    if(Buffer.from(content).toString("base64")!==lock?.content)artifacts.push({variant:"candidate",path:lockPath,content});
  }
  for(const lockPath of snapshot.baselinePreparationPaths||[]){
    validatePath(lockPath);
    const project=path.posix.dirname(lockPath);
    const cwd=path.join("/work","baseline",project);
    const step=await execute(["install","--package-lock-only","--ignore-scripts","--no-fund"],cwd,10001);
    if(step.exitCode!==0||step.timedOut)throw new Error(`Baseline test tooling lock preparation failed for ${project}: ${step.log.slice(-1500)}`);
    const manifestPath=lockPath.replace(/package-lock\.json$/,"package.json");
    const expected=snapshot.baseline.find(file=>file.path===manifestPath);
    if(!expected||Buffer.from(await read(path.join(cwd,"package.json"),"utf8")).toString("base64")!==expected.content)throw new Error("Baseline preparation unexpectedly changed the baseline manifest.");
    const content=await read(path.join(cwd,"package-lock.json"),"utf8");
    if(Buffer.byteLength(content)>2_000_000)throw new Error("Baseline test tooling lock exceeds the 2 MB limit.");
    artifacts.push({variant:"baseline",path:lockPath,content});
  }
  const candidateFile=filePath=>snapshot.candidate.find(file=>file.path===filePath);
  const changedArtifact=(filePath,content)=>{if(Buffer.byteLength(content)>2_000_000)throw new Error(`Prepared ${filePath} exceeds the 2 MB limit.`);if(Buffer.from(content).toString("base64")!==candidateFile(filePath)?.content)artifacts.push({variant:"candidate",path:filePath,content});};
  for(const unit of ecosystemUnits(snapshot.candidate.map(file=>file.path))){
    if(unit.runtime!=="go"&&unit.runtime!=="php")continue;
    const cwd=path.join("/work","candidate",unit.project);
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
  return executeCommand("npm",args,cwd,uid,timeoutMs);
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

export async function verifySnapshot(snapshot,publish,execute=runCommand,executePython=runPythonCommand,tools=defaultTools){
  const report={status:"failed",reason:"Verification started",steps:[]};
  const missing=[];
  const pythonFailures=[];
  const baselineAuditFailures=[];
  for(const [variant,uid] of [["baseline",10001],["candidate",10002]]){
    const files=snapshot[variant];
    const pythonProjects=pythonProjectsFor(files);
    for(const project of pythonProjects){
      const testPrefix=project==="."?"tests/":`${project}/tests/`;
      const hasTests=files.some(file=>file.path.startsWith(testPrefix)&&/(^|\/)test_[^/]+\.py$/.test(file.path));
      if(!hasTests)missing.push(`${variant} ${project}: no Python unittest tests found under ${testPrefix}`);
      const hasTestDependencies=files.some(file=>file.path===(project==="."?"requirements-dev.txt":`${project}/requirements-dev.txt`));
      for(const index of [0,1,...(hasTestDependencies?[5]:[]),2,3,4]){
        if(index===3&&!hasTests)continue;
        const step=await executePython(index,path.join("/work",variant,project),uid);
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
      const commands=[["ci","--ignore-scripts","--no-fund"]];
      for(const script of ["build","test"]){
        if(typeof manifest.scripts?.[script]==="string"&&manifest.scripts[script].trim())commands.push(script==="build"?["run","build"]:["test","--","--run"]);
        else missing.push(`${variant} ${manifestPath}: missing scripts.${script}`);
      }
      commands.push(["audit","--omit=dev","--audit-level=high"]);
      for(const args of commands){
        const step=await execute(args,path.join("/work",variant,project),uid);
        report.steps.push({...step,variant,project});
        await publish({...report,reason:`${variant}: ${project}: ${step.command}`},false);
        if(step.exitCode!==0||step.timedOut){
          const failure=`${variant} ${project}: ${step.command} ${step.timedOut?"timed out":`failed (exit ${step.exitCode})`}.`;
          if(variant==="baseline"&&args[0]==="audit"&&!step.timedOut&&step.exitCode===1&&/# npm audit report/.test(step.log)&&/\bSeverity: (high|critical)\b/.test(step.log)){
            baselineAuditFailures.push(failure);
            await publish({...report,reason:`Baseline audit failed; continuing candidate checks for comparison. ${failure}`},false);
            continue;
          }
          return {...report,reason:`${failure}${baselineAuditFailures.length?` Baseline findings: ${baselineAuditFailures.join(" ")}`:""}${missing.length?` Missing prerequisites: ${missing.join("; ")}.`:""}`.slice(0,2000)};
        }
      }
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
    if(pythonProjectsFor(snapshot.baseline).length||pythonProjectsFor(snapshot.candidate).length){
      await publish({status:"failed",reason:"Preparing Python 3.11, Tkinter, a virtual display and dependency audit tooling in the isolated job.",steps:[]},false);
      for(const [command,args] of [["apt-get",["update"]],["apt-get",["install","-y","--no-install-recommends","python3","python3-venv","python3-tk","xvfb","xauth","libasound2","libssl3"]],["python3",["-m","venv","/opt/verification-tools"]],["/opt/verification-tools/bin/python",["-m","pip","install","--disable-pip-version-check","pip-audit==2.9.0"]]]){
        const setup=await executeCommand(command,args,"/tmp",0,240000);
        if(setup.exitCode!==0||setup.timedOut)throw new Error(`Python runtime setup failed: ${command}. ${setup.log.slice(-1500)}`);
      }
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