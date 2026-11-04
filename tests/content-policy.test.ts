import assert from "node:assert/strict";
import test from "node:test";
import {assertNoCredentials,ContentPolicyError} from "../src/lib/content-policy";
import {isForbiddenRepositoryPath,validateGeneratedPlan} from "../src/lib/transformation-engine";

test("credential policy blocks model context and reports only the path and credential kind",()=>{
  const secret=`ghp_${"x".repeat(36)}`;
  assert.throws(()=>assertNoCredentials([{path:"src/config.ts",content:`const token='${secret}'`}]),error=>error instanceof ContentPolicyError&&!error.message.includes(secret)&&error.message.includes("src/config.ts"));
  for(const content of [`-----BEGIN ${"PRIVATE KEY"}-----\n${"A".repeat(100)}\n-----END PRIVATE KEY-----`,`npm_${"x".repeat(36)}`,`AccountKey=${"A".repeat(64)}`,`apiKey="${"a".repeat(32)}"`])assert.throws(()=>assertNoCredentials([{path:"config",content}]),ContentPolicyError);
  assert.doesNotThrow(()=>assertNoCredentials([{path:".env.example",content:"API_KEY=<configure-in-key-vault>"}]));
  assert.doesNotThrow(()=>assertNoCredentials([{path:".env.example",content:'GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----"'}]));
});
test("generated credential files and credential literals are rejected before acceptance",()=>{
  for(const path of [".env",".env.production","config/.env.local","secrets/private.pem"])assert.equal(isForbiddenRepositoryPath(path),true);
  assert.equal(isForbiddenRepositoryPath(".env.example"),false);
  assert.throws(()=>validateGeneratedPlan({summary:"A complete reviewed generated proposal.",changes:[{path:"src/config.ts",status:"added",area:"backend",rationale:"Add protected service configuration.",before:"",after:`export const token='ghp_${"x".repeat(36)}'`,validation:[]}]},new Map()),ContentPolicyError);
});
