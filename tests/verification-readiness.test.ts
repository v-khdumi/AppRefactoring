import assert from "node:assert/strict";
import test from "node:test";
import {verificationReadiness,readVerificationReadiness} from "../src/lib/verification-readiness";

test("unsupported source and target stacks are rejected before generation",()=>{
  const source=verificationReadiness([{path:"native/Cargo.toml"},{path:"frontend/package.json",content:'{"scripts":{"build":"vite build","test":"vitest"}}'},{path:"frontend/package-lock.json"}],{scope:"frontend"});
  assert.equal(source.supported,false);
  assert.ok(source.blockers.some(item=>item.code==="UnsupportedRuntime"));
  assert.equal(verificationReadiness([{path:"requirements.txt",content:"fastapi==0.115.0"}],{scope:"backend",backendTarget:".NET 9 Minimal APIs"}).supported,false);
  assert.equal(verificationReadiness([{path:"Backend/App.csproj"}],{scope:"backend"}).blockers[0].code,"ManifestUnavailable");
});
test("Python without tests is supported but missing coverage remains explicit",()=>{
  const result=verificationReadiness([{path:"requirements.txt",content:"python-dotenv==1.2.2"},{path:"main.py"}],{scope:"fullstack",backendTarget:"Python + FastAPI"});
  assert.equal(result.supported,true);assert.deepEqual(result.projects,[{path:".",runtime:"python"}]);
  assert.equal(result.warnings[0].code,"TestsRequired");
});
test("npm requires complete manifests and original reproducible dependencies",()=>{
  assert.equal(verificationReadiness([{path:"package.json"}],{scope:"frontend"}).blockers[0].code,"ManifestUnavailable");
  const missing=verificationReadiness([{path:"package.json",content:'{"scripts":{"build":"vite build"}}'}],{scope:"frontend"});
  assert.equal(missing.supported,false);assert.ok(missing.blockers.some(item=>item.code==="LockfileRequired"));
  assert.ok(missing.warnings.some(item=>item.code==="ScriptRequired"));
  assert.equal(verificationReadiness([{path:"package.json",content:'{"packageManager":"pnpm@10"}'},{path:"package-lock.json"}],{scope:"frontend"}).supported,false);
});
test("root workspaces do not require duplicate nested npm locks",()=>{
  const result=verificationReadiness([{path:"package.json",content:'{"workspaces":["packages/*"],"scripts":{"build":"npm run build --workspaces","test":"npm test --workspaces"}}'},{path:"package-lock.json"},{path:"packages/ui/package.json",content:'{}'},{path:"api/requirements.txt",content:"fastapi==0.115.0"}],{scope:"fullstack",backendTarget:"Python + FastAPI"});
  assert.equal(result.supported,true);assert.equal(result.projects.length,2);
});

test("server readiness reads complete manifests and propagates fetch failures",async()=>{
  const paths=[{path:"package.json"},{path:"package-lock.json"}];
  const report=await readVerificationReadiness(paths,async()=>'{"scripts":{"build":"vite build","test":"vitest"}}',{scope:"frontend"});
  assert.equal(report.supported,true);
  await assert.rejects(readVerificationReadiness(paths,async()=>{throw Error("Not authorized");},{scope:"frontend"}),/Not authorized/);
  assert.equal(verificationReadiness([{path:"package.json",content:'{}'},{path:"npm-shrinkwrap.json"}],{scope:"frontend"}).supported,false);
});