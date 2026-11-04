import { ManagedIdentityCredential } from "@azure/identity";
import { env } from "./env";

export function managedIdentityCredential(configuration = env) {
  return new ManagedIdentityCredential({ clientId: configuration.AZURE_MANAGED_IDENTITY_CLIENT_ID });
}
