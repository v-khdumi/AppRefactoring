import {createHash,randomBytes} from "node:crypto";
import {z} from "zod";
import {resilientFetch} from "./resilient-fetch";
import {mapConcurrent} from "./agent-concurrency";
import {safeSnapshotPath} from "./verification-evidence";
import {readInstalledRepository,readInstalledFile,readVerificationSnapshot,publishChanges,createModernizationPullRequest} from "./github-app";
import {sourceConnections,type SourceProvider,type SourceConnection} from "./source-connections";

export {sourceProviders,type SourceProvider} from "./source-connections";
export interface SourceRepository {provider:SourceProvider;url:string;name:string;apiUrl:string;connection?:SourceConnection}
interface InventoryFile {path:string;type:string;mode:string;size?:number;sha?:string}
interface SnapshotFile {path:string;content:string;executable:boolean}
interface Head {sha:string;parents:string[]}
interface Page<T> {values:T[];next?:string}
const encode=encodeURIComponent;
const shaSchema=z.string().regex(/^[a-f0-9]{40}$/i);
const gitPath=(value:string)=>value.split("/").map(encode).join("/");
const pathInside=(path:string,prefix:string)=>prefix==="/"||path===prefix||path.startsWith(`${prefix.replace(/\/$/,"")}/`);

export function sourceRepository(value:string,configuration=process.env.SOURCE_CONNECTIONS):SourceRepository{
  const url=new URL(value);
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)throw new Error("Use an HTTPS repository URL without embedded credentials, query parameters or fragments.");
  const segments=url.pathname.replace(/\/$/,"").replace(/\.git$/,"").split("/").filter(Boolean).map(part=>decodeURIComponent(part));
  if(segments.some(part=>!part||part==="."||part===".."||part.includes("/")||part.includes("\\")))throw new Error("The repository URL contains an invalid path.");
  const connections=sourceConnections(configuration);
  const canonicalPath=`/${segments.map(encode).join("/")}`;
  const connection=connections.filter(entry=>entry.origin===url.origin&&pathInside(canonicalPath,entry.pathPrefix)).sort((first,second)=>second.pathPrefix.length-first.pathPrefix.length)[0];
  const provider:SourceProvider=connection?.provider||(url.hostname==="github.com"?"github":url.hostname==="gitlab.com"?"gitlab":url.hostname==="dev.azure.com"?"azure-repos":url.hostname==="bitbucket.org"?"bitbucket":(()=>{throw new Error("This source host requires an administrator-configured SOURCE_CONNECTIONS entry.");})());
  if(provider==="github"&&url.hostname!=="github.com")throw new Error("Use github-enterprise for a non-public GitHub host.");
  if(["github","github-enterprise","bitbucket"].includes(provider)&&segments.length!==2)throw new Error("The repository URL must identify an owner/workspace and repository.");
  if(provider==="gitlab"&&(segments.length<2||segments.includes("-")))throw new Error("Use the GitLab project URL, not a file or branch URL.");
  if(provider==="azure-repos"&&(url.hostname!=="dev.azure.com"||segments.length!==4||segments[2]!=="_git"))throw new Error("Use https://dev.azure.com/organization/project/_git/repository.");
  const name=segments.join("/");
  const base=(connection?.apiBaseUrl||(provider==="github"?"https://api.github.com":provider==="github-enterprise"?`${url.origin}/api/v3`:provider==="gitlab"?`${url.origin}/api/v4`:provider==="bitbucket"?"https://api.bitbucket.org/2.0":"https://dev.azure.com")).replace(/\/$/,"");
  const apiUrl=provider==="gitlab"?`${base}/projects/${encode(name)}`:provider==="azure-repos"?`${base}/${encode(segments[0])}/${encode(segments[1])}/_apis/git/repositories/${encode(segments[3])}`:`${base}/${provider==="bitbucket"?"repositories":"repos"}/${segments.map(encode).join("/")}`;
  return {provider,url:`${url.origin}/${segments.map(encode).join("/")}`,name,apiUrl,connection};
}

export class SourceRequestError extends Error {
  constructor(public status:number,provider:SourceProvider){super(`${provider} returned HTTP ${status}. Check the configured service credential, repository access and branch.`);this.name="SourceRequestError";}
}

export class SourceClient {
  constructor(readonly repository:SourceRepository,private fetcher:(url:string,options?:RequestInit)=>Promise<Response>=(url,options={})=>resilientFetch(url,{...options,attempts:!options.method||options.method==="GET"?3:1,retryNetworkErrors:!options.method||options.method==="GET",operation:"source.request"})){}
  private async request(path:string,options:RequestInit={},optional=false){
    const {repository}=this;
    const url=new URL(path.startsWith("https:")?path:`${repository.apiUrl}${path}`);
    const allowed=new URL(repository.apiUrl);
    if(url.origin!==allowed.origin||!url.pathname.startsWith(`${allowed.pathname}/`)&&url.pathname!==allowed.pathname)throw new Error("Source API pagination left the configured repository.");
    if(repository.provider==="azure-repos")url.searchParams.set("api-version","7.1");
    const headers=new Headers(options.headers);
    headers.set("Accept","application/json");
    const credential=repository.connection;
    if(credential){
      headers.set("Authorization",repository.provider==="azure-repos"||credential.username?`Basic ${Buffer.from(`${credential.username||""}:${credential.token}`).toString("base64")}`:`Bearer ${credential.token}`);
    }
    if(options.body&&typeof options.body==="string"&&!headers.has("Content-Type"))headers.set("Content-Type","application/json");
    const response=await this.fetcher(url.toString(),{...options,headers,cache:"no-store",redirect:"error",signal:options.signal||AbortSignal.timeout(30000)});
    if(optional&&response.status===404)return undefined;
    if(!response.ok)throw new SourceRequestError(response.status,repository.provider);
    return response;
  }
  private async json<T>(path:string,options:RequestInit={},optional=false):Promise<T|undefined>{
    const response=await this.request(path,options,optional);
    return response?await response.json() as T:undefined;
  }
  private async pages<T>(path:string):Promise<T[]>{
    const values:T[]=[];let next:string|undefined=path;
    for(let page=0;next;page++){
      if(page>=100||values.length>6000)throw new Error("Source inventory exceeds the bounded pagination limit.");
      const response=await this.request(next);
      if(!response)throw new Error("Source inventory is unavailable.");
      if(this.repository.provider==="gitlab"){
        const batch=await response.json() as T[];
        if(!Array.isArray(batch))throw new Error("GitLab returned an invalid inventory page.");
        values.push(...batch);
        const cursor=response.headers.get("x-next-page");
        const url=new URL(`${this.repository.apiUrl}${path}`);if(cursor&&!/^\d+$/.test(cursor))throw new Error("Invalid GitLab pagination cursor.");
        if(cursor)url.searchParams.set("page",cursor);next=cursor?url.toString():undefined;
      }else{
        const batch=await response.json() as Page<T>;
        if(!Array.isArray(batch.values))throw new Error("The source provider returned an invalid inventory page.");
        values.push(...batch.values);next=batch.next;
      }
    }
    return values;
  }
  async head(branch:string,optional=false):Promise<Head|undefined>{
    const {provider}=this.repository;
    if(provider==="gitlab"){
      const item=await this.json<{commit:{id:string;parent_ids:string[]}}>(`/repository/branches/${encode(branch)}`,{},optional);
      return item?{sha:shaSchema.parse(item.commit.id),parents:item.commit.parent_ids}:undefined;
    }
    if(provider==="bitbucket"){
      const item=await this.json<{target:{hash:string;parents:Array<{hash:string}>}}>(`/refs/branches/${encode(branch)}`,{},optional);
      return item?{sha:shaSchema.parse(item.target.hash),parents:item.target.parents.map(parent=>parent.hash)}:undefined;
    }
    if(provider==="azure-repos"){
      const refs=await this.json<{value:Array<{name:string;objectId:string}>}>(`/refs?filter=${encode(`heads/${branch}`)}`);
      const reference=refs?.value.find(item=>item.name===`refs/heads/${branch}`);
      if(!reference){if(optional)return undefined;throw new Error("The Azure Repos branch was not found.");}
      const item=await this.json<{parents:string[]}>(`/commits/${shaSchema.parse(reference.objectId)}`);
      return {sha:reference.objectId,parents:item?.parents||[]};
    }
    const reference=await this.json<{object:{sha:string}}>(`/git/ref/heads/${encode(branch)}`,{},optional);
    if(!reference)return undefined;
    const sha=shaSchema.parse(reference.object.sha);
    const item=await this.json<{parents:Array<{sha:string}>}>(`/git/commits/${sha}`);
    if(!item)throw new Error("The pinned Git commit is unavailable.");
    return {sha,parents:item.parents.map(parent=>parent.sha)};
  }
  async inventory(sourceSha:string):Promise<InventoryFile[]>{
    shaSchema.parse(sourceSha);
    const {provider}=this.repository;let files:InventoryFile[];
    if(provider==="gitlab"){
      const tree=await this.pages<{path:string;type:string;mode:string;id:string}>(`/repository/tree?recursive=true&per_page=100&ref=${sourceSha}`);
      files=tree.filter(item=>item.type!=="tree").map(item=>({...item,sha:item.id}));
    }else if(provider==="bitbucket"){
      files=[];const directories=[""];
      for(let index=0;index<directories.length;index++){
        if(directories.length>3000)throw new Error("The repository contains too many directories.");
        const tree=await this.pages<{path:string;type:string;size?:number;attributes?:string[]}>(`/src/${sourceSha}/${gitPath(directories[index])}?pagelen=100`);
        for(const item of tree){
          if(item.attributes?.some(attribute=>["link","subrepository"].includes(attribute)))throw new Error("Source symlinks and submodules are not supported.");
          if(item.type==="commit_directory")directories.push(item.path);
          else files.push({path:item.path,type:item.type==="commit_file"?"blob":item.type,mode:item.attributes?.includes("executable")?"100755":"100644",size:item.size});
        }
        if(files.length>3000)throw new Error("The source snapshot exceeds 3000 files.");
      }
    }else if(provider==="azure-repos"){
      const commit=await this.json<{treeId:string}>(`/commits/${sourceSha}`);
      if(!commit?.treeId)throw new Error("Azure Repos did not return the pinned commit tree.");
      const tree=await this.json<{treeEntries:Array<{relativePath:string;objectType:string;mode:string;sha1:string;size?:number}>;truncated?:boolean}>(`/trees/${commit.treeId}?recursive=true`);
      if(!tree||tree.truncated)throw new Error("Azure Repos returned an incomplete source tree.");
      files=tree.treeEntries.filter(item=>item.objectType!=="tree").map(item=>({path:item.relativePath,type:item.objectType,mode:item.mode,sha:item.sha1,size:item.size}));
    }else{
      const tree=await this.json<{tree:InventoryFile[];truncated?:boolean}>(`/git/trees/${sourceSha}?recursive=1`);
      if(!tree||tree.truncated)throw new Error("GitHub Enterprise returned an incomplete source tree.");
      files=tree.tree.filter(item=>item.type!=="tree");
    }
    validateSourceInventory(files);
    return files;
  }
  async bytes(path:string,sourceSha:string):Promise<Buffer>{
    if(!safeSnapshotPath(path))throw new Error("Unsafe source path.");
    shaSchema.parse(sourceSha);
    const provider=this.repository.provider;
    if(provider==="github-enterprise"){
      const item=await this.json<{encoding:string;content:string}>(`/contents/${gitPath(path)}?ref=${sourceSha}`);
      if(item?.encoding!=="base64"||typeof item.content!=="string")throw new Error(`The source file is unavailable: ${path}`);
      return Buffer.from(item.content,"base64");
    }
    const suffix=provider==="gitlab"?`/repository/files/${encode(path)}/raw?ref=${sourceSha}`:provider==="bitbucket"?`/src/${sourceSha}/${gitPath(path)}`:`/items?path=${encode(`/${path}`)}&versionDescriptor.version=${sourceSha}&versionDescriptor.versionType=commit&$format=octetStream`;
    const response=await this.request(suffix);
    if(!response)throw new Error(`The source file is unavailable: ${path}`);
    const declared=Number(response.headers.get("content-length")||0);
    if(declared>30_000_000)throw new Error(`Source file exceeds the snapshot size limit: ${path}`);
    const reader=response.body?.getReader();
    if(!reader)throw new Error(`Source file has no response body: ${path}`);
    const chunks:Uint8Array[]=[];let size=0;
    try{while(true){const result=await reader.read();if(result.done)break;size+=result.value.byteLength;if(size>30_000_000)throw new Error(`Source file exceeds the snapshot size limit: ${path}`);chunks.push(result.value);}}
    finally{await reader.cancel();reader.releaseLock();}
    return Buffer.concat(chunks);
  }
  async snapshot(sourceSha:string):Promise<SnapshotFile[]>{
    const inventory=await this.inventory(sourceSha);let total=0;
    return mapConcurrent(inventory,6,async file=>{
      const bytes=await this.bytes(file.path,sourceSha);total+=bytes.length;
      if(total>30_000_000)throw new Error("The source snapshot exceeds 30 MB.");
      if(file.sha&&gitBlobHash(bytes)!==file.sha)throw new Error(`Pinned source integrity mismatch: ${file.path}`);
      return {path:file.path,content:bytes.toString("base64"),executable:file.mode==="100755"};
    });
  }
  async publish(input:{sourceBranch:string;targetBranch:string;expectedCommitSha:string;message:string;changes:Array<{path:string;content:string|null}>}){
    if(!this.repository.connection)throw new Error("Publication requires an administrator-configured service credential.");
    if(input.sourceBranch===input.targetBranch)throw new Error("Publication must never write the source branch.");
    const source=await this.head(input.sourceBranch);
    if(source?.sha!==input.expectedCommitSha)throw new Error("The source changed after review. Analyze and approve the current commit.");
    const baseline=await this.snapshot(input.expectedCommitSha);
    const desired=new Map(baseline.map(file=>[file.path,file]));
    for(const change of input.changes){
      if(!safeSnapshotPath(change.path))throw new Error("Unsafe publication path.");
      if(change.content===null)desired.delete(change.path);
      else desired.set(change.path,{path:change.path,content:Buffer.from(change.content).toString("base64"),executable:desired.get(change.path)?.executable||false});
    }
    const existing=await this.head(input.targetBranch,true);
    if(existing){
      if(existing.parents.length===1&&existing.parents[0]===input.expectedCommitSha&&snapshotDigest(await this.snapshot(existing.sha))===snapshotDigest([...desired.values()]))return existing.sha;
      throw new Error("The target branch already exists with different content. Choose a new branch; no existing branch was overwritten.");
    }
    const finish=async(expectedSha?:string)=>{
      const committed=await this.head(input.targetBranch);
      if(!committed||expectedSha&&committed.sha!==expectedSha||committed.parents.length!==1||committed.parents[0]!==input.expectedCommitSha||snapshotDigest(await this.snapshot(committed.sha))!==snapshotDigest([...desired.values()]))throw new Error("Publication did not produce the approved source-bound snapshot. No pull request was created; investigate the target branch.");
      return committed.sha;
    };
    const {provider}=this.repository;
    if(provider==="gitlab"){
      const commit=await this.json<{id:string}>("/repository/commits",{method:"POST",body:JSON.stringify({branch:input.targetBranch,start_sha:input.expectedCommitSha,commit_message:input.message,actions:input.changes.map(change=>({action:change.content===null?"delete":baseline.some(file=>file.path===change.path)?"update":"create",file_path:change.path,...(change.content===null?{}:{content:change.content})}))})});
      return finish(shaSchema.parse(commit?.id));
    }
    if(provider==="azure-repos"){
      const push=await this.json<{commits:Array<{commitId:string}>}>("/pushes",{method:"POST",body:JSON.stringify({refUpdates:[{name:`refs/heads/${input.targetBranch}`,oldObjectId:"0".repeat(40)}],commits:[{comment:input.message,parents:[input.expectedCommitSha],changes:input.changes.map(change=>({changeType:change.content===null?"delete":baseline.some(file=>file.path===change.path)?"edit":"add",item:{path:`/${change.path}`},...(change.content===null?{}:{newContent:{content:change.content,contentType:"rawtext"}})}))}]})});
      return finish(shaSchema.parse(push?.commits[0]?.commitId));
    }
    if(provider==="bitbucket"){
      const {body,contentType}=bitbucketCommitBody(input,baseline);
      await this.request("/src",{method:"POST",headers:{"Content-Type":contentType},body});
      return finish();
    }
    const base=await this.json<{tree:{sha:string}}>(`/git/commits/${input.expectedCommitSha}`);
    if(!base?.tree.sha)throw new Error("The pinned GitHub Enterprise tree is unavailable.");
    const tree=await this.json<{sha:string}>(`/git/trees`,{method:"POST",body:JSON.stringify({base_tree:base.tree.sha,tree:input.changes.map(change=>({path:change.path,mode:desired.get(change.path)?.executable?"100755":"100644",type:"blob",...(change.content===null?{sha:null}:{content:change.content})}))})});
    const commit=await this.json<{sha:string}>("/git/commits",{method:"POST",body:JSON.stringify({message:input.message,tree:tree?.sha,parents:[input.expectedCommitSha]})});
    const sha=shaSchema.parse(commit?.sha);
    await this.request("/git/refs",{method:"POST",body:JSON.stringify({ref:`refs/heads/${input.targetBranch}`,sha})});
    return finish(sha);
  }
  async pullRequest(input:{sourceBranch:string;targetBranch:string;title:string;body:string}){
    const {provider}=this.repository;
    if(provider==="gitlab"){
      const existing=await this.json<Array<{web_url:string;draft:boolean}>>(`/merge_requests?state=opened&source_branch=${encode(input.targetBranch)}&target_branch=${encode(input.sourceBranch)}`);
      if(existing?.length){if(!existing[0].draft)throw new Error("The existing merge request is not a draft.");return {html_url:existing[0].web_url};}
      const pr=await this.json<{web_url:string;draft:boolean}>("/merge_requests",{method:"POST",body:JSON.stringify({source_branch:input.targetBranch,target_branch:input.sourceBranch,title:`Draft: ${input.title}`,description:input.body})});
      if(!pr?.draft)throw new Error("GitLab did not confirm a draft merge request.");
      return {html_url:pr.web_url};
    }
    if(provider==="azure-repos"){
      const existing=await this.json<{value:Array<{pullRequestId:number;isDraft:boolean}>}>(`/pullrequests?searchCriteria.status=active&searchCriteria.sourceRefName=${encode(`refs/heads/${input.targetBranch}`)}&searchCriteria.targetRefName=${encode(`refs/heads/${input.sourceBranch}`)}`);
      const pr=existing?.value[0]||await this.json<{pullRequestId:number;isDraft:boolean}>("/pullrequests",{method:"POST",body:JSON.stringify({sourceRefName:`refs/heads/${input.targetBranch}`,targetRefName:`refs/heads/${input.sourceBranch}`,title:input.title,description:input.body,isDraft:true})});
      if(!pr?.isDraft)throw new Error("Azure Repos did not confirm a draft pull request.");
      return {html_url:`${this.repository.url}/pullrequest/${pr.pullRequestId}`};
    }
    if(provider==="bitbucket"){
      const query=`state="OPEN" AND source.branch.name=${JSON.stringify(input.targetBranch)} AND destination.branch.name=${JSON.stringify(input.sourceBranch)}`;
      const existing=await this.json<{values:Array<{draft:boolean;links:{html:{href:string}}}>}>(`/pullrequests?q=${encode(query)}`);
      const pr=existing?.values[0]||await this.json<{draft:boolean;links:{html:{href:string}}}>("/pullrequests",{method:"POST",body:JSON.stringify({title:input.title,description:input.body,source:{branch:{name:input.targetBranch}},destination:{branch:{name:input.sourceBranch}},draft:true,close_source_branch:false})});
      if(!pr?.draft)throw new Error("Bitbucket did not confirm a draft pull request.");
      return {html_url:pr.links.html.href};
    }
    const existing=await this.json<Array<{html_url:string;draft:boolean}>>(`/pulls?state=open&head=${encode(`${this.repository.name.split("/")[0]}:${input.targetBranch}`)}&base=${encode(input.sourceBranch)}`);
    const pr=existing?.[0]||await this.json<{html_url:string;draft:boolean}>("/pulls",{method:"POST",body:JSON.stringify({title:input.title,body:input.body,head:input.targetBranch,base:input.sourceBranch,draft:true})});
    if(!pr?.draft)throw new Error("GitHub Enterprise did not confirm a draft pull request.");
    return {html_url:pr.html_url};
  }
}

export function validateSourceInventory(files:InventoryFile[]){
  if(files.length>3000||files.reduce((sum,file)=>sum+(file.size||0),0)>30_000_000)throw new Error("The source snapshot exceeds 3000 files / 30 MB.");
  if(new Set(files.map(file=>file.path)).size!==files.length)throw new Error("The source inventory contains duplicate paths.");
  for(const file of files){
    if(file.type!=="blob"||!["100644","100755"].includes(file.mode)||!safeSnapshotPath(file.path))throw new Error("Source submodules, symlinks or unsafe paths are not supported.");
    if(/(^|\/)(\.env(?!\.example$|\.sample$)(\.|$)|.*\.(pem|key|pfx|p12)$)/i.test(file.path))throw new Error("Tracked credential files must be removed before analysis or verification.");
  }
}
const gitBlobHash=(bytes:Buffer)=>createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const snapshotDigest=(files:SnapshotFile[])=>createHash("sha256").update(JSON.stringify([...files].sort((a,b)=>a.path.localeCompare(b.path)))).digest("hex");

export function bitbucketCommitBody(input:{targetBranch:string;expectedCommitSha:string;message:string;changes:Array<{path:string;content:string|null}>},baseline:Array<{path:string;executable:boolean}>){
  const boundary=`modernize-${randomBytes(24).toString("hex")}`;
  const fields:string[]=[];
  const quoted=(value:string)=>value.replace(/["\r\n]/g,char=>`%${char.charCodeAt(0).toString(16).padStart(2,"0")}`);
  const append=(name:string,value:string,filename?:string,executable=false)=>{
    fields.push(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"${filename?`; filename="${quoted(filename)}"${executable?'; x-attributes="executable"':""}`:""}\r\n\r\n${value}\r\n`);
  };
  append("branch",input.targetBranch);append("parents",input.expectedCommitSha);append("message",input.message);
  for(const change of input.changes){
    if(!safeSnapshotPath(change.path))throw new Error("Unsafe multipart source path.");
    if(change.content===null)append("files",`/${change.path}`);
    else append(`/${change.path}`,change.content,change.path.split("/").pop(),baseline.some(file=>file.path===change.path&&file.executable));
  }
  fields.push(`--${boundary}--\r\n`);
  return {body:fields.join(""),contentType:`multipart/form-data; boundary=${boundary}`};
}

export async function readSourceRepository(url:string,branch:string){
  const descriptor=sourceRepository(url);
  if(descriptor.provider==="github"){
    const [owner,repo]=descriptor.name.split("/");
    const result=await readInstalledRepository(owner,repo,branch);
    return {...result,descriptor,readFile:(path:string)=>readInstalledFile(owner,repo,path,result.sourceSha,result.token)};
  }
  const client=new SourceClient(descriptor);const head=await client.head(branch);
  if(!head)throw new Error("The source branch was not found.");
  return {descriptor,sourceSha:head.sha,files:await client.inventory(head.sha),readFile:async(path:string)=>{const bytes=await client.bytes(path,head.sha);if(bytes.length>200000)throw new Error(`Source text exceeds 200 KB: ${path}`);return new TextDecoder("utf-8",{fatal:true}).decode(bytes);}};
}
export async function readSourceSnapshot(url:string,sha:string){
  const descriptor=sourceRepository(url);
  if(descriptor.provider==="github"){const [owner,repo]=descriptor.name.split("/");return readVerificationSnapshot(owner,repo,sha);}
  return new SourceClient(descriptor).snapshot(sha);
}
export async function publishSourceChanges(url:string,input:Parameters<SourceClient["publish"]>[0]){
  const descriptor=sourceRepository(url);
  if(descriptor.provider==="github"){const [owner,repo]=descriptor.name.split("/");return publishChanges({owner,repo,...input});}
  return new SourceClient(descriptor).publish(input);
}
export async function createSourcePullRequest(url:string,input:Parameters<SourceClient["pullRequest"]>[0]){
  const descriptor=sourceRepository(url);
  if(descriptor.provider==="github"){const [owner,repo]=descriptor.name.split("/");return createModernizationPullRequest({owner,repo,...input});}
  return new SourceClient(descriptor).pullRequest(input);
}
