import {ManagedIdentityCredential} from "@azure/identity";
import {env} from "./env";

export function managedIdentityCredential(){
  return env.AZURE_MANAGED_IDENTITY_CLIENT_ID?new ManagedIdentityCredential({clientId:env.AZURE_MANAGED_IDENTITY_CLIENT_ID}):new ManagedIdentityCredential();
}
