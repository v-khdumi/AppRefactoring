import {z} from "zod";

export const sourceProviders=["github","github-enterprise","gitlab","azure-repos","bitbucket"] as const;
export type SourceProvider=typeof sourceProviders[number];
const schema=z.array(z.object({provider:z.enum(sourceProviders),origin:z.url(),pathPrefix:z.string().default("/"),apiBaseUrl:z.url().optional(),token:z.string().min(1),username:z.string().optional()})).max(100);
export type SourceConnection=z.infer<typeof schema>[number];

export function sourceConnections(configuration=process.env.SOURCE_CONNECTIONS){
  let connections:SourceConnection[];
  try{connections=configuration?schema.parse(JSON.parse(configuration)):[];}
  catch(error){if(error instanceof SyntaxError||error instanceof z.ZodError)throw new Error("SOURCE_CONNECTIONS must be a valid array of provider, HTTPS origin and service-token settings. Configuration values were not logged.");throw error;}
  for(const entry of connections){
    const origin=new URL(entry.origin);
    if(origin.protocol!=="https:"||origin.origin!==entry.origin||!entry.pathPrefix.startsWith("/")||entry.pathPrefix.includes(".."))throw new Error("A source connection has an invalid origin or path prefix.");
    if(entry.apiBaseUrl){const api=new URL(entry.apiBaseUrl);if(api.protocol!=="https:"||api.username||api.password||api.search||api.hash)throw new Error("A source connection has an invalid API base URL.");}
  }
  const keys=connections.map(connection=>`${connection.origin}${connection.pathPrefix}`);
  if(new Set(keys).size!==keys.length)throw new Error("Source connections have ambiguous duplicate origin/path bindings.");
  return connections;
}
