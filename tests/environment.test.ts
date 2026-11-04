import assert from "node:assert/strict";
import test from "node:test";
import {parseEnvironment,assertProductionConfiguration} from "../src/lib/env";

test("blank optional example settings are absent, while invalid configured values still fail",()=>{
  const parsed=parseEnvironment({AZURE_CLIENT_ID:"",AZURE_TENANT_ID:" ",DATABASE_URL:"",AZURE_SERVICE_BUS_CONNECTION_STRING:"",HEALTH_CHECK_TOKEN:""});
  assert.equal(parsed.AZURE_CLIENT_ID,undefined);
  assert.equal(parsed.DEMO_MODE,"false");
  assert.throws(()=>parseEnvironment({AZURE_CLIENT_ID:"not-a-uuid"}));
  assert.throws(()=>parseEnvironment({HEALTH_CHECK_TOKEN:"too-short"}));
  assert.throws(()=>parseEnvironment({DEMO_MODE:"yes"}));
});
test("pilot self-approval defaults off and cannot be enabled for production",()=>{
  assert.equal(parseEnvironment({}).DEPLOYMENT_TIER,"production");
  assert.equal(parseEnvironment({}).PILOT_ALLOW_ADMIN_SELF_APPROVAL,"false");
  assert.throws(()=>assertProductionConfiguration(parseEnvironment({DEPLOYMENT_TIER:"production",PILOT_ALLOW_ADMIN_SELF_APPROVAL:"true"})),/forbidden outside an explicit pilot/);
  assert.doesNotThrow(()=>assertProductionConfiguration(parseEnvironment({DEPLOYMENT_TIER:"pilot",PILOT_ALLOW_ADMIN_SELF_APPROVAL:"true"})));
  assert.throws(()=>parseEnvironment({DEPLOYMENT_TIER:"demo"}));
  assert.throws(()=>parseEnvironment({PILOT_ALLOW_ADMIN_SELF_APPROVAL:"yes"}));
});
