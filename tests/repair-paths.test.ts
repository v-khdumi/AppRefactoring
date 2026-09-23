import assert from "node:assert/strict";
import test from "node:test";
import {allowedRepairPath} from "../src/lib/repair-paths";
test("mixed stack repair allows manifests and tests, not arbitrary runtime or secrets",()=>{
  for(const path of ["requirements.txt","frontend/package-lock.json","backend/tests/test_api.py","backend/ui_api.py","ops/cloud/tests/test_preflight.py","tests/approved-behavior.md"])assert.equal(allowedRepairPath(path),true);
  for(const path of ["backend/arbitrary.py","transcript_app/gui.py",".env","frontend/../main.py","frontend/src/App.tsx"])assert.equal(allowedRepairPath(path),false);
});