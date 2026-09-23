import assert from "node:assert/strict";
import test from "node:test";
import {validatePreparedLocks,type ArtifactSnapshot} from "../src/lib/verification-artifacts";
const manifest=JSON.stringify({name:"frontend",dependencies:{react:"^19"},devDependencies:{vitest:"^3"}});
const lock=JSON.stringify({name:"frontend",lockfileVersion:3,packages:{"":{dependencies:{react:"^19"},devDependencies:{vitest:"^3"}}}});
const file=(path:string,content:string)=>({path,content:Buffer.from(content).toString("base64")});
const snapshot:ArtifactSnapshot={baseline:[],candidate:[file("frontend/package.json",manifest)],sourceLockfiles:[]};
test("dependency preparation accepts only locks matching the candidate manifest",()=>{
 assert.doesNotThrow(()=>validatePreparedLocks(snapshot,[{variant:"candidate",path:"frontend/package-lock.json",content:lock}]));
 for(const path of ["frontend/src/App.tsx","backend/package-lock.json","../package-lock.json"])assert.throws(()=>validatePreparedLocks(snapshot,[{variant:"candidate",path,content:lock}]));
 assert.throws(()=>validatePreparedLocks(snapshot,[{variant:"baseline",path:"frontend/package-lock.json",content:lock}]));
 assert.throws(()=>validatePreparedLocks(snapshot,[{variant:"candidate",path:"frontend/package-lock.json",content:lock.replace('^19','^20')}]));
 assert.throws(()=>validatePreparedLocks({...snapshot,preparationComplete:true},[{variant:"candidate",path:"frontend/package-lock.json",content:lock}]));
});
test("supervisor prepares locks as the candidate user with scripts disabled",async()=>{
 // @ts-expect-error isolated job supervisor
 const {prepareCandidateLocks}=await import("../scripts/verification-runner.mjs");
 const artifacts=await prepareCandidateLocks(snapshot,async(args:string[],cwd:string,uid:number)=>{
  assert.ok(args.includes("--ignore-scripts"));assert.ok(args.includes("--package-lock-only"));assert.match(cwd,/frontend$/);assert.equal(uid,10002);
  return {exitCode:0,timedOut:false,log:""};
 },async(path:string)=>path.endsWith("package-lock.json")?lock:manifest);
 assert.deepEqual(artifacts,[{variant:"candidate",path:"frontend/package-lock.json",content:lock}]);
 await assert.rejects(prepareCandidateLocks(snapshot,async()=>({exitCode:1,timedOut:false,log:"resolution failed"})),/preparation failed/);
});

test("test-tooling resolution cannot silently upgrade baseline runtime packages",()=>{
 const original=JSON.parse(lock);
 original.packages['node_modules/react']={version:'19.0.0',resolved:'https://registry.npmjs.org/react/-/react-19.0.0.tgz',integrity:'sha512-fixture'};
 const source=file('frontend/package-lock.json',JSON.stringify(original));
 const baseline={...snapshot,baseline:snapshot.candidate,sourceLockfiles:[source],baselinePreparationPaths:['frontend/package-lock.json']};
 const prepared={variant:'baseline' as const,path:source.path,content:JSON.stringify(original)};
 assert.doesNotThrow(()=>validatePreparedLocks(baseline,[prepared]));
 original.packages['node_modules/react'].version='19.1.0';
 assert.throws(()=>validatePreparedLocks(baseline,[{...prepared,content:JSON.stringify(original)}]),/preserve locked runtime/);
});