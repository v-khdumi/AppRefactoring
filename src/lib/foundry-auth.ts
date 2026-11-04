import {env} from "./env";
import {managedIdentityCredential} from "./azure-identity";

type FoundryConfiguration=Pick<typeof env,"AZURE_AI_FOUNDRY_ENDPOINT"|"AZURE_AI_FOUNDRY_API_KEY"|"AZURE_AI_FOUNDRY_AUTH_MODE">;
type Credential={getToken:(scope:string,options?:{abortSignal?:AbortSignal})=>Promise<{token:string}|null>};

export function foundryConfigured(configuration:FoundryConfiguration=env){
  return Boolean(configuration.AZURE_AI_FOUNDRY_ENDPOINT&&(configuration.AZURE_AI_FOUNDRY_AUTH_MODE==="managed-identity"||configuration.AZURE_AI_FOUNDRY_API_KEY));
}

export async function foundryHeaders(signal?:AbortSignal,configuration:FoundryConfiguration=env,credential?:Credential):Promise<Record<string,string>>{
  if(!foundryConfigured(configuration))throw new Error("Microsoft Foundry is not configured for the selected authentication mode.");
  if(configuration.AZURE_AI_FOUNDRY_AUTH_MODE==="api-key")return {"Content-Type":"application/json","api-key":configuration.AZURE_AI_FOUNDRY_API_KEY!};
  const token=await (credential||managedIdentityCredential()).getToken("https://cognitiveservices.azure.com/.default",{abortSignal:signal});
  if(!token?.token)throw new Error("Managed Identity returned no Microsoft Foundry access token.");
  return {"Content-Type":"application/json",Authorization:`Bearer ${token.token}`};
}
