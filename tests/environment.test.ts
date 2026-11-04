import assert from "node:assert/strict";
import test from "node:test";
import {parseEnvironment} from "../src/lib/env";

test("blank optional example settings are absent, while invalid configured values still fail",()=>{
  const parsed=parseEnvironment({AZURE_CLIENT_ID:"",AZURE_TENANT_ID:" ",DATABASE_URL:"",AZURE_SERVICE_BUS_CONNECTION_STRING:"",HEALTH_CHECK_TOKEN:""});
  assert.equal(parsed.AZURE_CLIENT_ID,undefined);
  assert.equal(parsed.DEMO_MODE,"false");
  assert.throws(()=>parseEnvironment({AZURE_CLIENT_ID:"not-a-uuid"}));
  assert.throws(()=>parseEnvironment({HEALTH_CHECK_TOKEN:"too-short"}));
  assert.throws(()=>parseEnvironment({DEMO_MODE:"yes"}));
});
