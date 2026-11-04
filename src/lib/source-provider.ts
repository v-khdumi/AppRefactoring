import {parseGitHubUrl} from "./github";
import {readInstalledRepository,readInstalledFile,readVerificationSnapshot,publishChanges,createModernizationPullRequest} from "./github-app";

export function sourceRepository(value:string){
  const {owner,repo}=parseGitHubUrl(value);
  return {provider:"github" as const,url:`https://github.com/${owner}/${repo}`,name:`${owner}/${repo}`};
}

export async function readSourceRepository(url:string,branch:string){
  const descriptor=sourceRepository(url);
  const {owner,repo}=parseGitHubUrl(descriptor.url);
  const repository=await readInstalledRepository(owner,repo,branch);
  return {...repository,descriptor,readFile:(path:string)=>readInstalledFile(owner,repo,path,repository.sourceSha,repository.token)};
}

export async function readSourceSnapshot(url:string,sha:string){
  const {owner,repo}=parseGitHubUrl(url);
  return readVerificationSnapshot(owner,repo,sha);
}

export async function publishSourceChanges(url:string,input:Omit<Parameters<typeof publishChanges>[0],"owner"|"repo">){
  const {owner,repo}=parseGitHubUrl(url);
  return publishChanges({owner,repo,...input});
}

export async function createSourcePullRequest(url:string,input:Omit<Parameters<typeof createModernizationPullRequest>[0],"owner"|"repo">){
  const {owner,repo}=parseGitHubUrl(url);
  return createModernizationPullRequest({owner,repo,...input});
}
