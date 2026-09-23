import type { Finding, ModernizationEstimate, ModernizationOptions } from "@/types/modernization";

export function estimateModernization(input:{files:number;findings:Finding[];options:ModernizationOptions}):ModernizationEstimate{
 const scopeFactor=input.options.scope==="fullstack"?1:0.62;
 const sizeUnits=Math.max(1,input.files/250);
 const riskWeight=input.findings.reduce((sum,finding)=>sum+({critical:2.5,high:1.5,medium:.75,low:.25}[finding.severity]),0);
 const capabilityFactor=1+(input.options.cloudReady?.25:0)+(input.options.aiFeatures.length*.12);
 const agents=Math.min(6,Math.max(3,(input.options.scope==="fullstack"?5:4)+(input.options.cloudReady?1:0)));
 const generationHours=Math.max(4,Math.ceil((sizeUnits*7*scopeFactor*capabilityFactor+input.findings.length*1.5)/Math.max(2,agents-1)));
 const verificationDays=Math.max(2,Math.ceil((sizeUnits*1.15*scopeFactor+riskWeight*.45)*capabilityFactor));
 const expected=Math.max(4,Math.ceil(generationHours/8+verificationDays+2));
 return{optimisticDays:Math.max(3,Math.ceil(expected*.65)),expectedDays:expected,conservativeDays:Math.ceil(expected*1.65),aiGenerationHours:generationHours,verificationDays,parallelAgents:agents,confidence:input.files>0&&input.findings.length>=3?"high":"medium",assumptions:["Specialist agents generate independent file sets in parallel.","Human review and behavior-parity gates remain mandatory.","The existing test suite can run in an isolated build environment.","External API and database contracts are available and stable."]};
}