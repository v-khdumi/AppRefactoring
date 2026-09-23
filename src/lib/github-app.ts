import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { resilientFetch } from "@/lib/resilient-fetch";
import { safeSnapshotPath } from "@/lib/verification-evidence";
import { mapConcurrent } from "@/lib/agent-concurrency";
import { publicationAccess } from "@/lib/publication-access";

const API = "https://api.github.com";
import { GitHubRequestError, needsWorkflowPermission, WorkflowPermissionError } from "@/lib/publication-policy";

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

async function appJwt() {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) throw new Error("GitHub App credentials are not configured.");
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }));
  const unsigned = `${header}.${payload}`;
  const key = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key);
  return `${unsigned}.${base64url(signature)}`;
}

async function github<T>(path: string, options: RequestInit = {}, token?: string): Promise<T> {
  const response = await resilientFetch(`${API}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token || await appJwt()}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    cache: "no-store",
    attempts: 3,
    timeoutMs: 30_000,
    operation: "github.app.request",
  });
  if (!response.ok) throw new GitHubRequestError(response.status,`${options.method||"GET"} ${path}`,response.headers.get("x-github-request-id")||undefined,response.headers.get("x-ratelimit-remaining")==="0"||response.headers.has("retry-after"));
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function installationToken(owner: string, repo: string, workflows=false,write=false) {
  const installation = await github<{ id: number;permissions?:Record<string,string> }>(`/repos/${owner}/${repo}/installation`);
  if(workflows&&installation.permissions?.workflows!=="write")throw new WorkflowPermissionError();
  const token = await github<{ token: string; expires_at: string }>(`/app/installations/${installation.id}/access_tokens`, {
    method: "POST",
    body: JSON.stringify({ repositories: [repo], permissions: { contents: write?"write":"read", pull_requests: write?"write":"read", metadata: "read",...(workflows?{workflows:"write"}:{}) } }),
  });
  return token.token;
}

export async function readPublicationAccess(owner:string,repo:string,workflows:boolean){
  const app=await github<{slug:string;owner:{login:string;type:string};permissions:Record<string,string>}>("/app");
  const installation=await github<{id:number;account:{login:string;type:string};permissions:Record<string,string>;suspended_at?:string|null}>(`/repos/${owner}/${repo}/installation`);
  return publicationAccess(app,installation,workflows);
}

export async function readInstalledRepository(owner: string, repo: string, branch: string) {
  const token = await installationToken(owner, repo);
  const reference = await github<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, {}, token,
  );
  const tree = await github<{ truncated?:boolean;tree: Array<{ path: string; type: string;mode?:string; size?: number }> }>(
    `/repos/${owner}/${repo}/git/trees/${reference.object.sha}?recursive=1`, {}, token,
  );
  if(tree.truncated)throw new Error("Repository inventory is truncated. Analysis cannot silently omit projects.");
  const files=tree.tree.filter(item=>item.type!=="tree");
  if(files.length>3000||files.reduce((total,file)=>total+(file.size||0),0)>30_000_000)throw new Error("Repository exceeds the isolated verification limit (3000 files / 30 MB).");
  if(files.some(file=>file.type!=="blob"||file.mode&&!['100644','100755'].includes(file.mode)||!safeSnapshotPath(file.path)))throw new Error("Repository contains unsupported submodules, symlinks or unsafe paths.");
  if(files.some(file=>/(^|\/)(\.env(?!\.example$|\.sample$)(\.|$)|.*\.(pem|key|pfx|p12)$)/i.test(file.path)))throw new Error("Tracked credential files must be removed before analysis or verification.");
  return { files, token, sourceSha: reference.object.sha };
}

export async function readInstalledFile(owner: string, repo: string, path: string, branch: string, token: string) {
  const item = await github<{ content?: string; encoding?: string }>(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`, {}, token,
  );
  if (item.encoding !== "base64" || !item.content) return "";
  return Buffer.from(item.content.replace(/\n/g, ""), "base64").toString("utf8");
}

export async function createModernizationPullRequest(input: {
  owner: string; repo: string; sourceBranch: string; targetBranch: string; title: string; body: string;
}) {
  const token = await installationToken(input.owner, input.repo,false,true);
  const existing=await github<Array<{number:number;html_url:string}>>(`/repos/${input.owner}/${input.repo}/pulls?state=open&head=${encodeURIComponent(`${input.owner}:${input.targetBranch}`)}&base=${encodeURIComponent(input.sourceBranch)}`,{},token);
  if(existing.length)return existing[0];
  return github<{ number: number; html_url: string }>(`/repos/${input.owner}/${input.repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title: input.title, head: input.targetBranch, base: input.sourceBranch, body: input.body, draft: true }),
  }, token);
}

export function verifyGitHubSignature(rawBody: string, signature: string | null) {
  if (!env.GITHUB_WEBHOOK_SECRET || !signature?.startsWith("sha256=")) return false;
  const digest = `sha256=${createHmac("sha256", env.GITHUB_WEBHOOK_SECRET).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const digestBuffer = Buffer.from(digest);
  return actualBuffer.length === digestBuffer.length && timingSafeEqual(actualBuffer, digestBuffer);
}

export async function publishChanges(input: {
  owner: string; repo: string; sourceBranch: string; targetBranch: string; expectedCommitSha: string;
  message: string; changes: Array<{ path: string; content: string | null }>;
}) {
  if(input.sourceBranch===input.targetBranch)throw new Error("Publication must use a new target branch, never the source branch.");
  const token = await installationToken(input.owner, input.repo,needsWorkflowPermission(input.changes),true);
  const source = await github<{ object: { sha: string } }>(`/repos/${input.owner}/${input.repo}/git/ref/heads/${encodeURIComponent(input.sourceBranch)}`, {}, token);
  if (source.object.sha !== input.expectedCommitSha) throw new Error("The source branch changed after approval; a new review is required.");
  const baseCommit = await github<{ tree: { sha: string } }>(`/repos/${input.owner}/${input.repo}/git/commits/${source.object.sha}`, {}, token);
  const tree = await github<{ sha: string }>(`/repos/${input.owner}/${input.repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: input.changes.map((change) => change.content === null ? { path: change.path, mode: "100644", type: "blob", sha: null } : { path: change.path, mode: "100644", type: "blob", content: change.content }) }),
  }, token);
  try {
    const reference=await github<{object:{sha:string}}>(`/repos/${input.owner}/${input.repo}/git/ref/heads/${encodeURIComponent(input.targetBranch)}`,{},token);
    const previous=await github<{tree:{sha:string};parents:Array<{sha:string}>}>(`/repos/${input.owner}/${input.repo}/git/commits/${reference.object.sha}`,{},token);
    if(previous.tree.sha===tree.sha&&previous.parents.length===1&&previous.parents[0].sha===input.expectedCommitSha)return reference.object.sha;
    throw new Error("The target branch already exists with different content. Publication stopped without overwriting it.");
  }catch(error){if(!(error instanceof GitHubRequestError)||error.status!==404)throw error;}
  const commit = await github<{ sha: string }>(`/repos/${input.owner}/${input.repo}/git/commits`, {
    method: "POST", body: JSON.stringify({ message: input.message, tree: tree.sha, parents: [source.object.sha] }),
  }, token);
  await github(`/repos/${input.owner}/${input.repo}/git/refs`, {
    method: "POST", body: JSON.stringify({ ref: `refs/heads/${input.targetBranch}`, sha: commit.sha }),
  }, token);
  return commit.sha;
}

export async function readVerificationSnapshot(owner:string,repo:string,sourceSha:string) {
  if(!/^[a-f0-9]{40}$/i.test(sourceSha))throw new Error("A pinned source commit is required for verification.");
  const token=await installationToken(owner,repo);
  const tree=await github<{truncated:boolean;tree:Array<{path:string;type:string;mode:string;sha:string;size?:number}>}>(`/repos/${owner}/${repo}/git/trees/${sourceSha}?recursive=1`,{},token);
  if(tree.truncated)throw new Error("Repository tree is truncated; verification cannot use an incomplete checkout.");
  const files=tree.tree.filter(item=>item.type!=="tree");
  if(files.length>3000||files.reduce((total,file)=>total+(file.size||0),0)>30_000_000)throw new Error("Repository exceeds the verification snapshot limit (3000 files / 30 MB).");
  if(files.some(file=>file.type!=="blob"||!["100644","100755"].includes(file.mode)||!safeSnapshotPath(file.path)))throw new Error("Snapshot contains unsupported submodules, symlinks or unsafe paths.");
  if(files.some(file=>/(^|\/)(\.env(?!\.example$|\.sample$)(\.|$)|.*\.(pem|key|pfx|p12)$)/i.test(file.path)))throw new Error("Tracked credential files must be removed before isolated verification.");
  return mapConcurrent(files,6,async file=>{
    const blob=await github<{encoding:string;content:string}>(`/repos/${owner}/${repo}/git/blobs/${file.sha}`,{},token);
    if(blob.encoding!=="base64")throw new Error(`Unsupported encoding: ${file.path}`);
    return {path:file.path,content:blob.content.replace(/\s/g,""),executable:file.mode==="100755"};
  });
}