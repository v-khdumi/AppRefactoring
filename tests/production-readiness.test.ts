import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { assertProductionConfiguration, parseEnvironment, serviceBusNamespace } from "../src/lib/env";
import { operationallyReady, type WorkerHeartbeat } from "../src/lib/health-status";
import { GET as liveness } from "../src/app/api/health/live/route";
import { managedIdentityCredential } from "../src/lib/azure-identity";

const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://localhost/modernize",
  AZURE_TENANT_ID: "11111111-1111-4111-8111-111111111111",
  AZURE_CLIENT_ID: "22222222-2222-4222-8222-222222222222",
  AZURE_AI_FOUNDRY_ENDPOINT: "https://foundry.example.test/models",
  AZURE_AI_FOUNDRY_API_KEY: "test-inference-key",
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "test-key",
  GITHUB_WEBHOOK_SECRET: "test-webhook",
  HEALTH_CHECK_TOKEN: "x".repeat(32),
  AZURE_SERVICE_BUS_NAMESPACE: "modernize.servicebus.windows.net",
  VERIFICATION_JOB_RESOURCE_ID: "/subscriptions/test/resourceGroups/test/providers/Microsoft.App/jobs/verify",
  VERIFICATION_PUBLIC_ORIGIN: "https://modernize.example.test",
};

test("blank optional environment entries behave as unset without hiding invalid values", () => {
  const parsed = parseEnvironment({ AZURE_TENANT_ID: "", HEALTH_CHECK_TOKEN: "", DATABASE_URL: "", AZURE_SERVICE_BUS_QUEUE: "" });
  assert.equal(parsed.AZURE_TENANT_ID, undefined);
  assert.equal(parsed.DATABASE_URL, undefined);
  assert.equal(parsed.HEALTH_CHECK_TOKEN, undefined);
  assert.equal(parsed.AZURE_SERVICE_BUS_QUEUE, "modernization-runs");
  assert.throws(() => parseEnvironment({ AZURE_TENANT_ID: "invalid" }));
  assert.throws(() => parseEnvironment({ HEALTH_CHECK_TOKEN: "too-short" }));
});

test("production requires webhook, deep health and isolated verification configuration", () => {
  assert.doesNotThrow(() => assertProductionConfiguration(parseEnvironment(production)));
  for (const key of ["AZURE_AI_FOUNDRY_API_KEY", "GITHUB_WEBHOOK_SECRET", "HEALTH_CHECK_TOKEN", "VERIFICATION_JOB_RESOURCE_ID", "VERIFICATION_PUBLIC_ORIGIN"]) {
    assert.throws(() => assertProductionConfiguration(parseEnvironment({ ...production, [key]: "" })), new RegExp(key));
  }
  for (const key of ["AZURE_AI_FOUNDRY_ENDPOINT", "VERIFICATION_PUBLIC_ORIGIN"]) {
    assert.throws(() => assertProductionConfiguration(parseEnvironment({ ...production, [key]: "http://example.test" })), /HTTPS/);
  }
});

test("GitHub App credentials remain mandatory and cannot be replaced by legacy provider settings",()=>{
  const configuration=parseEnvironment({...production,GITHUB_APP_ID:"",GITHUB_APP_PRIVATE_KEY:"",GITHUB_WEBHOOK_SECRET:"",SOURCE_CONNECTIONS:JSON.stringify([{provider:"gitlab",origin:"https://gitlab.example.test",token:"test-service-credential"}])});
  assert.throws(()=>assertProductionConfiguration(configuration),/GITHUB_APP_ID.*GITHUB_APP_PRIVATE_KEY.*GITHUB_WEBHOOK_SECRET/);
});

test("connection string authentication is not replaced with managed identity", () => {
  const configuration = parseEnvironment({ ...production, AZURE_SERVICE_BUS_NAMESPACE: "", AZURE_SERVICE_BUS_CONNECTION_STRING: "Endpoint=sb://modernize.servicebus.windows.net/;SharedAccessKeyName=test;SharedAccessKey=test" });
  assert.equal(serviceBusNamespace(configuration), undefined);
  assert.doesNotThrow(() => assertProductionConfiguration(configuration));
  assert.equal(serviceBusNamespace(parseEnvironment(production)), production.AZURE_SERVICE_BUS_NAMESPACE);
});

test("Azure requests select the runtime managed identity rather than the API audience", async () => {
  const runtimeClientId = "33333333-3333-4333-8333-333333333333";
  let requestedClientId: string | null = null;
  const server = createServer((request, response) => {
    requestedClientId = new URL(request.url!, "http://localhost").searchParams.get("client_id");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ access_token: "test-access-token", expires_on: String(Math.floor(Date.now() / 1000) + 3600), resource: "https://management.azure.com", token_type: "Bearer" }));
  });
  const previous = { endpoint: process.env.IDENTITY_ENDPOINT, header: process.env.IDENTITY_HEADER };
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    process.env.IDENTITY_ENDPOINT = `http://127.0.0.1:${address.port}/token`;
    process.env.IDENTITY_HEADER = "test-identity-header";
    const credential = managedIdentityCredential(parseEnvironment({ ...production, AZURE_MANAGED_IDENTITY_CLIENT_ID: runtimeClientId }));
    const token = await credential.getToken("https://management.azure.com/.default");
    assert.equal(token.token, "test-access-token");
    assert.equal(requestedClientId, runtimeClientId);
  } finally {
    if (previous.endpoint === undefined) delete process.env.IDENTITY_ENDPOINT;
    else process.env.IDENTITY_ENDPOINT = previous.endpoint;
    if (previous.header === undefined) delete process.env.IDENTITY_HEADER;
    else process.env.IDENTITY_HEADER = previous.header;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

const workers: WorkerHeartbeat[] = ["transformation", "outbox"].map(worker_name => ({
  worker_name, status: "healthy", fresh: true, last_seen_at: new Date().toISOString(),
}));
const queue = { status: "healthy" as const, deadLetterMessages: 0 };

test("deep readiness requires each expected healthy worker and an available clean queue", () => {
  assert.equal(operationallyReady(workers, queue), true);
  for (const status of ["starting", "stopping", "degraded"]) {
    assert.equal(operationallyReady([{ ...workers[0], status }, workers[1]], queue), false);
  }
  assert.equal(operationallyReady([{ ...workers[0], fresh: false }, workers[1]], queue), false);
  assert.equal(operationallyReady([workers[0], { ...workers[1], worker_name: "unrelated" }], queue), false);
  assert.equal(operationallyReady([], queue), false);
  assert.equal(operationallyReady(undefined, queue), false);
  assert.equal(operationallyReady(workers, undefined), false);
  assert.equal(operationallyReady(workers, { status: "unavailable" }), false);
  assert.equal(operationallyReady(workers, { status: "healthy" }), false);
  assert.equal(operationallyReady(workers, { ...queue, deadLetterMessages: 1 }), false);
});

test("liveness is uncached and independent of external dependencies", async () => {
  const response = liveness();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "alive" });
});

test("migration deployment uses the release image and waits for success or fails closed", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "modernize-migrations-"));
  const bash=process.platform==="win32"?path.resolve(execFileSync("git",["--exec-path"],{encoding:"utf8"}).trim(),"..","..","..","bin","bash.exe"):"bash";
  const shellPath=(value:string)=>process.platform==="win32"?value.replace(/\\/g,"/").replace(/^([a-zA-Z]):/,(_match,drive:string)=>`/${drive.toLowerCase()}`):value;
  try {
    await writeFile(path.join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(path.join(directory, "az"), `#!/bin/sh
echo "$*" >> "$CALLS"
case "$*" in
  *"job update"*) exit 0 ;;
  *"job start"*) echo release-execution ;;
  *"execution show"*)
    if [ ! -f "$SEEN" ]; then touch "$SEEN"; echo Running; else echo "$RESULT"; fi ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    for (const result of ["Succeeded", "Failed", "Stopped", "Degraded", "unexpected", "Running"]) {
      const calls = path.join(directory, `calls-${result}`);
      const execution = spawnSync(bash, ["-c",'export PATH="$MOCK_BIN:$PATH"; exec bash "$@"',"modernize-migration-test","scripts/deploy-migrations.sh", "production-rg", "migrate", "registry/worker@sha256:release"], {
        encoding: "utf8",
        timeout:120000,
        env: { ...process.env, MOCK_BIN:shellPath(directory), CALLS: shellPath(calls), SEEN: shellPath(path.join(directory, `seen-${result}`)), RESULT: result },
      });
      assert.ifError(execution.error);
      assert.equal(execution.status, result === "Succeeded" ? 0 : 1, execution.stderr);
      const commands = await readFile(calls, "utf8");
      assert.match(commands, /job update .*--image registry\/worker@sha256:release/);
      assert.match(commands, /--job-execution-name release-execution/);
      assert.ok(commands.indexOf("job update") < commands.indexOf("job start"));
      if (result === "Running") assert.match(execution.stderr, /Timed out/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
