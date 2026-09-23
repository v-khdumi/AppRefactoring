test("nested Python characterization installs only allowlisted test dependencies",()=>{
 const encoded=(path:string,content:string)=>({path,content:Buffer.from(content).toString('base64'),executable:false});
 const source=[encoded('api/requirements.txt','fastapi==0.115.0'),encoded('api/main.py','source')];
 const candidate=[...source,encoded('api/tests/test_api.py','characterization'),encoded('api/requirements-dev.txt','httpx==0.28.1')];
 const baseline=applyBaselineTestHarness(source,candidate);
 assert.ok(baseline.some(file=>file.path==='api/tests/test_api.py'));
 assert.ok(baseline.some(file=>file.path==='api/requirements-dev.txt'));
 assert.equal(baseline.find(file=>file.path==='api/main.py')?.content,source[1].content);
 assert.throws(()=>applyBaselineTestHarness(source,[...candidate.filter(file=>!file.path.endsWith('requirements-dev.txt')),encoded('api/requirements-dev.txt','-r arbitrary.txt')]),/allowlisted/);
});
test("automatic npm characterization adds only test tooling and retains original runtime",()=>{
 const encoded=(path:string,value:unknown)=>({path,content:Buffer.from(typeof value==="string"?value:JSON.stringify(value)).toString("base64"),executable:false});
 const source=[encoded("package.json",{name:"legacy",dependencies:{react:"18.0.0"},scripts:{build:"vite build"}}),encoded("src/App.tsx","original")];
 const candidate=[encoded("package.json",{name:"modern",dependencies:{react:"19.0.0"},devDependencies:{vitest:"3.2.7",jsdom:"27.0.0",unrelated:"1.0.0"},scripts:{build:"changed build",test:"vitest --config tests/vitest.config.mjs"}}),encoded("src/App.tsx","changed"),encoded("tests/app.test.ts","characterization"),encoded("tests/vitest.config.mjs","config")];
 const baseline=applyBaselineTestHarness(source,candidate);
 const manifest=JSON.parse(Buffer.from(baseline.find(file=>file.path==="package.json")!.content,"base64").toString());
 assert.deepEqual(manifest.dependencies,{react:"18.0.0"});assert.equal(manifest.name,"legacy");assert.equal(manifest.scripts.build,"vite build");
 assert.deepEqual(manifest.devDependencies,{vitest:"3.2.7",jsdom:"27.0.0"});
 assert.equal(baseline.find(file=>file.path==="src/App.tsx")?.content,source[1].content);
 assert.ok(baseline.some(file=>file.path==="tests/app.test.ts"));
});
import assert from "node:assert/strict";
import test from "node:test";
import {applyBaselineTestHarness} from "../src/lib/baseline-test-harness";
const file=(path:string,value:unknown)=>({path,content:Buffer.from(JSON.stringify(value)).toString("base64"),executable:false});
test("baseline harness adds explicit common tests but cannot alter runtime dependencies",()=>{
 const source={scripts:{build:"vite build"},dependencies:{react:"19.0.0"},devDependencies:{vite:"7.0.0"}};
 const devDependencies={vitest:"3.2.0"};const testScript="vitest --config tests/vitest.config.mjs";
 const manifest={...source,devDependencies:{...source.devDependencies,...devDependencies},scripts:{...source.scripts,test:testScript}};
 const baseline=[file("package.json",source),file("src/app.ts","original")];
 const harness={manifest,lockfile:{lockfileVersion:3},devDependencies,testScript};
 const result=applyBaselineTestHarness(baseline,[file("tests/baseline-harness.json",harness),file("tests/app.test.ts","test")]);
 assert.equal(result.find(item=>item.path==="src/app.ts")?.content,baseline[1].content);
 assert.ok(result.find(item=>item.path==="tests/app.test.ts"));
 assert.throws(()=>applyBaselineTestHarness(baseline,[file("tests/baseline-harness.json",{...harness,manifest:{...manifest,dependencies:{react:"changed"}}})]),/test tooling only/);
});