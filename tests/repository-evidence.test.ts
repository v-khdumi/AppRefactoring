import assert from "node:assert/strict";
import test from "node:test";
import {selectEvidenceFiles,repositoryEvidence} from "../src/lib/repository-evidence";
test("prioritizes manifests across projects and the requested scope",()=>{
 const files=[...Array.from({length:40},(_,index)=>({path:`docs/example-${index}.py`})),{path:"frontend/package.json"},{path:"backend/requirements.txt"},{path:"frontend/ui.tsx"},{path:"frontend/package-lock.json"}];
 assert.deepEqual(selectEvidenceFiles(files,"frontend",3).map(file=>file.path),["backend/requirements.txt","frontend/package.json","frontend/ui.tsx"]);
 const evidence=repositoryEvidence(files.map(file=>file.path),[{path:"frontend/package.json",content:'{"dependencies":{"react":"^19"}}'}],"frontend");
 assert.deepEqual(evidence.omittedManifests,["backend/requirements.txt"]);
 assert.deepEqual(evidence.lockfiles,["frontend/package-lock.json"]);
 assert.equal(evidence.declaredPackages[0].dependencies.react,"^19");
});