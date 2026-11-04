export function workspaceRequestHeaders(input:RequestInfo|URL,headers:HeadersInit|undefined,origin:string){
  const url=new URL(input instanceof Request?input.url:String(input),origin);
  if(url.origin!==origin)throw new Error("Authenticated workspace requests cannot leave the workspace origin.");
  const result=new Headers(input instanceof Request?input.headers:undefined);
  new Headers(headers).forEach((value,name)=>result.set(name,value));
  return result;
}
