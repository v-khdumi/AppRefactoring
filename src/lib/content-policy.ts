const credentialPatterns=[
  {name:"private key material",pattern:/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[A-Za-z0-9+/=\s\\]{80,}-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/},
  {name:"GitHub access token",pattern:/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/},
  {name:"npm access token",pattern:/\bnpm_[A-Za-z0-9]{36,}\b/},
  {name:"AWS access key",pattern:/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/},
  {name:"storage account key",pattern:/\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/},
  {name:"hard-coded service credential",pattern:/\b(?:client[_-]?secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{32,}["']/i},
];

export class ContentPolicyError extends Error {
  readonly status=422;
  constructor(path:string,kind:string){
    super(`Potential ${kind} was detected in ${path}. Remove or redact it before model processing or accepting generated changes. The matching value was not logged.`);
    this.name="ContentPolicyError";
  }
}

export function assertNoCredentials(files:Array<{path:string;content:string}>){
  for(const file of files)for(const rule of credentialPatterns)if(rule.pattern.test(file.content))throw new ContentPolicyError(file.path,rule.name);
}
