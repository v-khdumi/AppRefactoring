import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

test("every container build stage installs current Alpine security fixes",()=>{
  const images=new Set<string>();
  for(const filename of ["Dockerfile","Dockerfile.worker","Dockerfile.outbox"]){
    const dockerfile=readFileSync(new URL(`../${filename}`,import.meta.url),"utf8");
    const stages=dockerfile.split(/^FROM /m).slice(1);
    assert.ok(stages.length);
    for(const stage of stages){
      const image=stage.split(/\s/)[0];
      assert.match(image,/^node:22-alpine@sha256:[a-f0-9]{64}$/);
      images.add(image);
      assert.match(stage,/^RUN apk upgrade --no-cache(?:\s|$)/m,`${filename} must patch OS packages in every stage`);
    }
  }
  assert.equal(images.size,1,"all application stages must share the same immutable base");
});

test("the web runtime retains the remote liveness probe",()=>{
  const dockerfile=readFileSync(new URL("../Dockerfile",import.meta.url),"utf8");
  assert.match(dockerfile,/^HEALTHCHECK .*http:\/\/127\.0\.0\.1:3000\/api\/health\/live \|\| exit 1$/m);
});

test("container CI retains its fail-closed scan and reports SARIF findings in logs",()=>{
  const workflow=readFileSync(new URL("../.github/workflows/container-security.yml",import.meta.url),"utf8");
  assert.match(workflow,/severity: CRITICAL,HIGH/);
  assert.match(workflow,/exit-code: '1'/);
  assert.match(workflow,/name: Report container scan findings\r?\n\s+if: always\(\)/);
  assert.ok(workflow.includes(".runs[].results[]? | .message.text"));
  for(const name of ["web","worker","outbox"])assert.ok(workflow.includes(`- name: ${name}`));
});
