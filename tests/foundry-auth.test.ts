import assert from "node:assert/strict";
import test from "node:test";
import {foundryConfigured,foundryHeaders} from "../src/lib/foundry-auth";
import {assertProductionConfiguration,parseEnvironment} from "../src/lib/env";

const endpoint="https://foundry.example.test/models";
test("Foundry API-key and Managed Identity modes never silently fall back to each other",async()=>{
  assert.equal(foundryConfigured({AZURE_AI_FOUNDRY_ENDPOINT:endpoint,AZURE_AI_FOUNDRY_AUTH_MODE:"managed-identity"}),true);
  assert.equal(foundryConfigured({AZURE_AI_FOUNDRY_ENDPOINT:endpoint,AZURE_AI_FOUNDRY_AUTH_MODE:"api-key"}),false);
  assert.deepEqual(await foundryHeaders(undefined,{AZURE_AI_FOUNDRY_ENDPOINT:endpoint,AZURE_AI_FOUNDRY_AUTH_MODE:"api-key",AZURE_AI_FOUNDRY_API_KEY:"fixture"}),{"Content-Type":"application/json","api-key":"fixture"});
  const signal=new AbortController().signal;
  const headers=await foundryHeaders(signal,{AZURE_AI_FOUNDRY_ENDPOINT:endpoint,AZURE_AI_FOUNDRY_AUTH_MODE:"managed-identity",AZURE_AI_FOUNDRY_API_KEY:"must-not-be-used"},{getToken:async(scope,options)=>{assert.equal(scope,"https://cognitiveservices.azure.com/.default");assert.equal(options?.abortSignal,signal);return {token:"identity-fixture"};}});
  assert.deepEqual(headers,{"Content-Type":"application/json",Authorization:"Bearer identity-fixture"});
  await assert.rejects(foundryHeaders(undefined,{AZURE_AI_FOUNDRY_ENDPOINT:endpoint,AZURE_AI_FOUNDRY_AUTH_MODE:"managed-identity"},{getToken:async()=>null}),/no Microsoft Foundry access token/);
});
test("production Managed Identity configuration does not require or enable a Foundry key",()=>{
  const configuration=parseEnvironment({NODE_ENV:"production",DATABASE_URL:"postgresql://localhost/app",AZURE_TENANT_ID:"11111111-1111-4111-8111-111111111111",AZURE_CLIENT_ID:"22222222-2222-4222-8222-222222222222",AZURE_AI_FOUNDRY_ENDPOINT:endpoint,AZURE_AI_FOUNDRY_AUTH_MODE:"managed-identity",GITHUB_APP_ID:"fixture",GITHUB_APP_PRIVATE_KEY:"fixture",GITHUB_WEBHOOK_SECRET:"fixture",HEALTH_CHECK_TOKEN:"h".repeat(32),VERIFICATION_JOB_RESOURCE_ID:"/fixture",VERIFICATION_PUBLIC_ORIGIN:"https://app.example.test",AZURE_SERVICE_BUS_NAMESPACE:"fixture.servicebus.windows.net"});
  assert.doesNotThrow(()=>assertProductionConfiguration(configuration));
  assert.throws(()=>assertProductionConfiguration({...configuration,AZURE_AI_FOUNDRY_AUTH_MODE:"api-key"}),/AZURE_AI_FOUNDRY_API_KEY/);
});
