import { resilientFetch } from "@/lib/resilient-fetch";

const GITHUB_API = "https://api.github.com";

export function parseGitHubUrl(url: string) {
  let parsed:URL;
  try{parsed=new URL(url.trim());}catch{throw new Error("Use an HTTPS GitHub repository URL: https://github.com/owner/repository.");}
  if(parsed.origin!=="https://github.com"||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error("Only HTTPS github.com repository URLs without credentials, queries or fragments are supported.");
  const parts=parsed.pathname.replace(/\/$/,"").replace(/\.git$/,"").split("/");
  if(parts.length!==3||!parts[1]||!parts[2]||!parts.slice(1).every(part=>/^[A-Za-z0-9_.-]+$/.test(part)&&![".",".."].includes(part)))throw new Error("The GitHub repository URL must identify exactly an owner and repository.");
  return {owner:parts[1],repo:parts[2]};
}

function headers(token?: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function githubFetch<T>(path: string, token?: string): Promise<T> {
  const response = await resilientFetch(`${GITHUB_API}${path}`, {
    headers: headers(token || process.env.GITHUB_TOKEN),
    cache: "no-store",
    attempts:3,
    timeoutMs:30_000,
    operation:"github.public.request",
  });
  if (!response.ok) {
    if (response.status === 404) throw new Error("The repository was not found or access was denied.");
    if (response.status === 401) throw new Error("The GitHub token is invalid.");
    throw new Error(`GitHub API returned status ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

export async function inspectRepository(url: string, token?: string, requestedBranch?: string) {
  const { owner, repo } = parseGitHubUrl(url);
  const metadata = await githubFetch<{ default_branch: string; private: boolean; description: string | null }>(
    `/repos/${owner}/${repo}`,
    token,
  );
  const branch = requestedBranch || metadata.default_branch;
  const reference=await githubFetch<{object:{sha:string}}>(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,token);
  const [tree, languages] = await Promise.all([
    githubFetch<{truncated?:boolean; tree: Array<{ path: string; type: string; size?: number }> }>(
      `/repos/${owner}/${repo}/git/trees/${reference.object.sha}?recursive=1`,
      token,
    ),
    githubFetch<Record<string, number>>(`/repos/${owner}/${repo}/languages`, token),
  ]);
  if(tree.truncated)throw new Error("Repository inventory is truncated; analysis cannot omit projects.");
  return {
    owner,
    repo,
    branch,
    sourceSha:reference.object.sha,
    private: metadata.private,
    description: metadata.description,
    languages,
    files: tree.tree.filter((item) => item.type === "blob"),
  };
}

export async function readRepositoryFile(owner: string, repo: string, path: string, branch: string, token?: string) {
  const content = await githubFetch<{ content?: string; encoding?: string }>(
    `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`,
    token,
  );
  if (content.encoding !== "base64" || !content.content) return "";
  const decoded=Buffer.from(content.content.replace(/\n/g, ""), "base64");
  if(decoded.length>200000)throw new Error(`Repository text file exceeds the analysis size limit: ${path}`);
  return decoded.toString("utf8");
}