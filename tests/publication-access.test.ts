import assert from "node:assert/strict";
import test from "node:test";
import {publicationAccess} from "../src/lib/publication-access";
const app={slug:"modernizer",owner:{login:"app-owner",type:"User"},permissions:{contents:"write",pull_requests:"write"}};
const installation={id:42,account:{login:"repo-org",type:"Organization"},permissions:{...app.permissions}};
test("distinguishes app configuration from installation acceptance",()=>{
 const missing=publicationAccess(app,installation,true);
 assert.equal(missing.ready,false);assert.match(missing.reason,/App configuration/);
 assert.equal(missing.appSettingsUrl,"https://github.com/settings/apps/modernizer/permissions");
 assert.equal(missing.installationSettingsUrl,"https://github.com/organizations/repo-org/settings/installations/42");
 const pending=publicationAccess({...app,permissions:{...app.permissions,workflows:"write"}},installation,true);
 assert.equal(pending.ready,false);assert.match(pending.reason,/installation has not granted/);
});
test("granted permissions allow retry without requesting unused workflow access",()=>{
 assert.equal(publicationAccess(app,installation,false).ready,true);
 const permissions={...app.permissions,workflows:"write"};
 assert.equal(publicationAccess({...app,permissions},{...installation,permissions},true).ready,true);
 assert.equal(publicationAccess({...app,permissions},{...installation,permissions,suspended_at:"2026-09-06"},true).ready,false);
});