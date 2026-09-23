import assert from "node:assert/strict";
import test from "node:test";
import { changesetDigest, reportPassed, safeSnapshotPath, type VerificationReport } from "../src/lib/verification-evidence";

test("verification is bound to source, content, operations and paths",()=>{
 const changes=[{path:"src/a.ts",operation:"modified",content:"a"},{path:"src/b.ts",operation:"added",content:"b"}];
 const digest=changesetDigest("sha",changes);
 assert.equal(digest,changesetDigest("sha",[...changes].reverse()));
 assert.notEqual(digest,changesetDigest("new-sha",changes));
 assert.notEqual(digest,changesetDigest("sha",[{...changes[0],content:"changed"},changes[1]]));
});
test("only actual complete baseline and candidate command evidence passes",()=>{
 const commands=["npm ci --ignore-scripts --no-fund","npm run build","npm test -- --run","npm audit --omit=dev --audit-level=high"];
 const report:VerificationReport={status:"passed",reason:"",steps:(["baseline","candidate"] as const).flatMap(variant=>commands.map(command=>({variant,project:".",command,exitCode:0,timedOut:false,log:"",durationMs:10})))};
 assert.ok(reportPassed(report));
 assert.equal(reportPassed({...report,steps:report.steps.slice(1)}),false);
 assert.equal(reportPassed({...report,steps:[]}),false);
 assert.equal(reportPassed({...report,steps:report.steps.map((step,index)=>index?step:{...step,exitCode:1})}),false);
 assert.equal(reportPassed({...report,steps:report.steps.map((step,index)=>index?step:{...step,timedOut:true})}),false);
});
test("snapshot paths cannot escape or write repository metadata",()=>{
 for(const path of ["../escape","/root/file","C:/file","src/../file",".git/config","node_modules/hook","src\\file"])assert.equal(safeSnapshotPath(path),false);
 assert.ok(safeSnapshotPath("src/service.test.ts"));
});

test("baseline vulnerabilities are diagnostic but candidate vulnerabilities and audit errors block",()=>{
 const commands=["npm ci --ignore-scripts --no-fund","npm run build","npm test -- --run","npm audit --omit=dev --audit-level=high"];
 const report:VerificationReport={status:"passed",reason:"",steps:(["baseline","candidate"] as const).flatMap(variant=>commands.map(command=>({variant,project:".",command,exitCode:0,timedOut:false,log:"",durationMs:1})))};
 const audit=report.steps[3];audit.exitCode=1;audit.log="# npm audit report\npackage\nSeverity: high\n1 high severity vulnerability";
 assert.equal(reportPassed(report),true);
 report.steps[7]={...audit,variant:"candidate"};assert.equal(reportPassed(report),false);
 report.steps[7]={...audit,variant:"candidate",exitCode:0};
 audit.log="npm error network unavailable";assert.equal(reportPassed(report),false);
 audit.log="# npm audit report\nSeverity: high";audit.timedOut=true;assert.equal(reportPassed(report),false);
});