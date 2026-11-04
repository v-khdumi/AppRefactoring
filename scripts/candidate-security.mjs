import {mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";

export const candidateSecurityCommand="candidate static and credential scan (Semgrep 1.183.0; local rules)";
export const semgrepWheel={
  url:"https://files.pythonhosted.org/packages/c5/fd/85ac31a5ec53feee54ebdce933ab1c94af81695a2b244b0baefdbcdba92a/semgrep-1.183.0-cp310.cp311.cp312.cp313.cp314.py310.py311.py312.py313.py314-none-manylinux_2_34_x86_64.whl",
  sha256:"f36115c4d0cb43056ceb308273421a2f6a35e055e7e029601e130850f836646e",
};
export const rules=`rules:
  - id: modernize.dynamic-evaluation
    languages: [javascript, typescript, python, php]
    severity: ERROR
    message: Dynamic code evaluation requires removal or explicit independent security review.
    pattern: eval(...)
  - id: modernize.python-shell
    languages: [python]
    severity: ERROR
    message: Shell command execution must not interpolate untrusted inputs.
    pattern-either:
      - pattern: subprocess.$F(..., shell=True, ...)
      - pattern: os.system(...)
  - id: modernize.node-shell
    languages: [javascript, typescript]
    severity: ERROR
    message: Review shell execution; prefer argument-array execution without a shell.
    patterns:
      - pattern-either:
          - pattern: $CP.exec(...)
          - pattern: $CP.execSync(...)
      - metavariable-regex:
          metavariable: $CP
          regex: (child_process|childProcess|cp)
  - id: modernize.python-unsafe-yaml
    languages: [python]
    severity: ERROR
    message: Use a safe YAML loader for untrusted input.
    pattern: yaml.unsafe_load(...)
  - id: modernize.java-runtime-exec
    languages: [java]
    severity: ERROR
    message: Review command execution against untrusted input.
    pattern: Runtime.getRuntime().exec(...)
  - id: modernize.disabled-node-tls
    languages: [javascript, typescript]
    severity: ERROR
    message: Do not disable TLS certificate verification.
    pattern: "{ rejectUnauthorized: false, ... }"
  - id: modernize.disabled-python-tls
    languages: [python]
    severity: ERROR
    message: Do not disable TLS certificate verification.
    pattern: requests.$F(..., verify=False, ...)
  - id: modernize.ruby-dynamic-evaluation
    languages: [ruby]
    severity: ERROR
    message: Dynamic code evaluation requires independent security review.
    pattern: eval(...)
  - id: modernize.native-unbounded-copy
    languages: [c, cpp]
    severity: ERROR
    message: Unbounded string copying can corrupt memory; use a bounded operation.
    pattern: strcpy(...)
  - id: modernize.csharp-process
    languages: [csharp]
    severity: ERROR
    message: Review process execution against untrusted arguments.
    pattern: Process.Start(...)
  - id: modernize.rust-shell
    languages: [rust]
    severity: ERROR
    message: Review shell execution against untrusted inputs.
    pattern: std::process::Command::new("sh")
  - id: modernize.go-disabled-tls
    languages: [go]
    severity: ERROR
    message: Do not disable TLS certificate verification.
    pattern: "tls.Config{InsecureSkipVerify: true, ...}"
  - id: modernize.cobol-shell
    languages: [generic]
    severity: ERROR
    message: COBOL system shell calls require independent security review.
    pattern-regex: "(?i)CALL[ \\\\t]+[\\"']SYSTEM[\\"']"
`;
export async function installCandidateScanner(tools){
  for(const [command,args] of [["apt-get",["update"]],["apt-get",["install","-y","--no-install-recommends","python3","python3-venv"]],["python3",["-m","venv","/opt/modernize-security"]]]){
    const step=await tools.execute(command,args,"/tmp",0,900000);
    if(step.exitCode!==0||step.timedOut)throw new Error(`Candidate scanner setup failed: ${command}. ${step.log.slice(-1000)}`);
  }
  const wheel=`/tmp/${semgrepWheel.url.split("/").pop()}`;
  await tools.downloadVerified(semgrepWheel.url,"sha256",semgrepWheel.sha256,wheel);
  const installed=await tools.execute("/opt/modernize-security/bin/python",["-m","pip","install","--disable-pip-version-check",wheel],"/tmp",0,900000);
  if(installed.exitCode!==0||installed.timedOut)throw new Error(`Candidate scanner installation failed. ${installed.log.slice(-1500)}`);
  await mkdir("/opt/modernize-security/rules",{recursive:true});
  await tools.writeFile("/opt/modernize-security/rules/modernize.yml",rules,{mode:0o644});
}
export async function scanCandidate(snapshot,tools){
  const started=Date.now();
  const files=snapshot.candidate||[];
  const credentialPatterns=[
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[A-Za-z0-9+/=\s\\]{80,}-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|npm_[A-Za-z0-9]{36,})\b/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bAccountKey=[A-Za-z0-9+/]{40,}={0,2}/,
  ];
  const credentials=files.filter(file=>credentialPatterns.some(pattern=>pattern.test(Buffer.from(file.content,"base64").toString("utf8")))).map(file=>file.path);
  const root="/work/candidate-scan";
  await tools.materialize(root,files.filter(file=>!/(^|\/)\.(?:semgrepignore|gitignore)$/.test(file.path)),10002);
  const reportPath=`${root}/.modernize-semgrep.json`;
  const step=await tools.execute("/opt/modernize-security/bin/semgrep",["scan","--config","/opt/modernize-security/rules/modernize.yml","--json","--output",reportPath,"--metrics","off","--disable-version-check","--no-git-ignore","--exclude","node_modules","--exclude","vendor","."],root,10002,240000,{SEMGREP_SEND_METRICS:"off",SEMGREP_ENABLE_VERSION_CHECK:"0",SEMGREP_APP_TOKEN:"",SEMGREP_SETTINGS_FILE:`${root}/.semgrep-settings.yml`});
  const result={command:candidateSecurityCommand,variant:"candidate",project:".",exitCode:step.exitCode,timedOut:step.timedOut,durationMs:Date.now()-started,log:""};
  if(step.exitCode!==0||step.timedOut)return {...result,log:`Static analysis did not complete successfully. ${step.log.slice(-1500)}`};
  try{
    const report=JSON.parse(await tools.readFile(reportPath,{limit:20_000_000}));
    if(!Array.isArray(report.results)||!Array.isArray(report.errors)||!Array.isArray(report.paths?.scanned))throw new Error("The scanner returned incomplete structured evidence.");
    if(report.errors.length)throw new Error("Static analysis reported parse or execution errors; no scan was waived.");
    const findings=report.results.map(finding=>({rule:finding.check_id,path:finding.path,line:finding.start?.line}));
    const blocked=credentials.length||findings.length;
    return {...result,exitCode:blocked?1:0,log:JSON.stringify({scanner:"Semgrep 1.183.0",rulesSha256:createHash("sha256").update(rules).digest("hex"),filesScanned:report.paths.scanned.length,findings,credentialPaths:credentials,limitations:"Local high-confidence rules; not complete SAST, secret detection, taint coverage or production qualification."}).slice(-32000)};
  }catch(error){return {...result,exitCode:2,log:`Candidate scanner evidence is incomplete: ${error.message}`};}
}
