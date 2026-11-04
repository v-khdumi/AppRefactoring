import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

test("the web image packages every supervisor script served through job capabilities",()=>{
  const dockerfile=readFileSync(new URL("../Dockerfile",import.meta.url),"utf8");
  const route=readFileSync(new URL("../src/app/api/verification-jobs/[id]/route.ts",import.meta.url),"utf8");
  const scripts=[...route.matchAll(/readFile\("scripts\/([^"]+)"/g)].map(match=>match[1]);
  assert.ok(scripts.length>=5);
  for(const script of scripts)assert.ok(dockerfile.includes(`/app/scripts/${script}`),`Missing runtime verifier artifact: ${script}`);
});
