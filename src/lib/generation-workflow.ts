import type {AgentType,ModernizationScope} from "../types/modernization";
import type {GeneratedPlan} from "./transformation-engine";
import {validateGeneratedPlan} from "./transformation-engine";
import {assertAgentChangeAreas,assertModernizationScope,AgentOwnershipError} from "./agent-policy";
import {coordinationContractSchema,coordinationContractPath,type CoordinationContract} from "./coordination-contract";
import {dependencyLock} from "./repository-evidence";
import {isImmutableOriginalTest} from "./verification-ecosystems";

export type SourceFile={path:string;content:string};
export type GeneratedChange=GeneratedPlan["changes"][number];
export interface AgentGenerationContext {
  agent:AgentType;
  files:SourceFile[];
  contract?:CoordinationContract;
  preceding:Array<{agent:AgentType;summary:string;paths:string[]}>;
}
export function generationSequence(scope:ModernizationScope,cloudReady:boolean):AgentType[]{
  return ["architect",...(scope!=="frontend"?["backend" as const]:[]),...(scope!=="backend"?["frontend" as const]:[]),...(cloudReady?["cloud" as const]:[]),"security","testing"];
}

export async function coordinatedGeneration(input:{
  source:SourceFile[];scope:ModernizationScope;cloudReady:boolean;
  initialChanges?:Array<{agent:AgentType;change:GeneratedChange}>;
  stages?:AgentType[];
  generate:(context:AgentGenerationContext)=>Promise<GeneratedPlan>;
  onAccepted?:(agent:AgentType,plan:GeneratedPlan)=>Promise<void>;
  assertActive?:()=>Promise<void>;
}){
  const original=new Map(input.source.map(file=>[file.path,file.content]));
  const candidate=new Map(original);
  const owners=new Map<string,AgentType>();
  const changes=new Map<string,{agent:AgentType;change:GeneratedChange}>();
  for(const existing of input.initialChanges||[]){
    changes.set(existing.change.path,structuredClone(existing));owners.set(existing.change.path,existing.agent);
    if(existing.change.status==="deleted")candidate.delete(existing.change.path);
    else candidate.set(existing.change.path,existing.change.after);
  }
  const preceding:AgentGenerationContext["preceding"]=[];
  let contract:CoordinationContract|undefined;
  const saved=candidate.get(coordinationContractPath);
  if(saved)contract=coordinationContractSchema.parse(JSON.parse(saved));
  const stages=input.stages?[...input.stages]:generationSequence(input.scope,input.cloudReady);
  if(contract&&contract.scope!==input.scope&&stages[0]!=="architect")throw new AgentOwnershipError("The saved coordination contract does not match the selected scope; architecture review is required.");
  if(!contract&&stages[0]!=="architect")stages.unshift("architect");
  for(const agent of stages){
    await input.assertActive?.();
    const files=[...candidate].map(([path,content])=>({path,content}));
    if(files.reduce((size,file)=>size+Buffer.byteLength(file.content,"utf8"),0)>1_000_000)throw new Error("The coordinated source context exceeds 1 MB. Select a smaller application boundary; generation was not silently truncated.");
    const plan=await input.generate({agent,files,contract,preceding:structuredClone(preceding)});
    await input.assertActive?.();
    validateGeneratedPlan(plan,candidate);
    assertModernizationScope(input.scope,plan.changes);
    assertAgentChangeAreas(agent,plan.changes);
    if(agent==="architect"){
      contract=coordinationContractSchema.parse(plan.contract);
      if(contract.scope!==input.scope)throw new AgentOwnershipError("The coordination contract cannot expand the user-selected scope.");
      if(plan.changes.some(change=>change.path===coordinationContractPath))throw new AgentOwnershipError("The platform persists the validated coordination contract; the agent must not supply a second version.");
      const contractChange:GeneratedChange={path:coordinationContractPath,status:original.has(coordinationContractPath)?"modified":"added",area:"platform",rationale:"Shared implementation and verification contract for the selected modernization scope.",before:original.get(coordinationContractPath)||"",after:JSON.stringify(contract,null,2)+"\n",validation:[]};
      candidate.set(contractChange.path,contractChange.after);owners.set(contractChange.path,agent);changes.set(contractChange.path,{agent,change:contractChange});
    }
    for(const change of plan.changes){
      if(change.path===coordinationContractPath||change.oldPath===coordinationContractPath)throw new AgentOwnershipError("The shared coordination contract is immutable during implementation.");
      if(dependencyLock.test(change.path)||change.oldPath&&dependencyLock.test(change.oldPath))throw new AgentOwnershipError(`Dependency lockfiles must be prepared by the isolated package manager, not model output: ${change.path}`);
      const previousOwner=owners.get(change.path)||change.oldPath&&owners.get(change.oldPath);
      if(original.has(change.path)&&isImmutableOriginalTest(change.path)&&(change.status!=="modified"||change.after!==original.get(change.path)))throw new AgentOwnershipError(`Original tests must remain unchanged; add explicit regression coverage instead: ${change.path}`);
      if(agent==="testing"&&change.area==="platform"&&/(^|\/)composer\.json$/.test(change.path)){
        const before=candidate.get(change.path);
        if(!before||change.status==="deleted")throw new AgentOwnershipError("Testing Agent must wire an existing Composer project, not create or remove a runtime project.");
        const runtime=(manifest:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(manifest).filter(([key])=>!["require-dev","autoload-dev","scripts"].includes(key)).sort(([first],[second])=>first.localeCompare(second))));
        if(runtime(JSON.parse(before))!==runtime(JSON.parse(change.after)))throw new AgentOwnershipError(`Testing Agent cannot replace runtime Composer fields: ${change.path}`);
      }
      if(agent==="testing"&&change.area==="platform"&&/(^|\/)package\.json$/.test(change.path)){
        const before=candidate.get(change.path);
        if(!before||change.status==="deleted")throw new AgentOwnershipError("Testing Agent must wire an existing project manifest, not create or remove a runtime project.");
        const previous=JSON.parse(before);const proposed=JSON.parse(change.after);
        const runtime=(manifest:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(manifest).filter(([key])=>!['scripts','devDependencies'].includes(key)).sort(([first],[second])=>first.localeCompare(second))));
        if(runtime(previous)!==runtime(proposed))throw new AgentOwnershipError(`Testing Agent cannot replace runtime manifest fields: ${change.path}`);
        for(const [name,value] of Object.entries(previous.scripts||{}))if(!['test','build'].includes(name)&&proposed.scripts?.[name]!==value)throw new AgentOwnershipError(`Testing Agent cannot replace unrelated script ${name}.`);
      }
      const testConfiguration=/(^|\/)(package\.json|requirements(?:-dev)?\.txt|pyproject\.toml|vitest\.config\.[^/]+|pytest\.ini|tests?\/|pom\.xml|(?:build|settings)\.gradle(?:\.kts)?|go\.mod|composer\.json|phpunit\.xml(?:\.dist)?|[^/]+\.(?:sln|slnx)|src\/test\/)|_test\.go$|(^|\/)[^/]*\.(?:Unit|Integration)?Tests?\//.test(change.path);
      if(previousOwner&&previousOwner!==agent&&agent!=="security"&&!(agent==="testing"&&testConfiguration))throw new AgentOwnershipError(`${agent} cannot overwrite the ${previousOwner} proposal at ${change.path}.`);
      if(change.status==="renamed")throw new AgentOwnershipError("Coordinated generation requires explicit added/deleted changes for renames to preserve source-bound diffs.");
      const before=original.get(change.path);
      if(change.status==="deleted"){
        candidate.delete(change.path);
        if(before===undefined){changes.delete(change.path);owners.delete(change.path);continue;}
      }else candidate.set(change.path,change.after);
      const status=change.status==="deleted"?"deleted":before===undefined?"added":"modified";
      if(status!=="deleted"&&change.after===before){changes.delete(change.path);continue;}
      owners.set(change.path,previousOwner||agent);
      changes.set(change.path,{agent:previousOwner||agent,change:{...change,status,before:before||""}});
    }
    preceding.push({agent,summary:plan.summary,paths:plan.changes.map(change=>change.path)});
    await input.onAccepted?.(agent,plan);
  }
  return {contract:contract!,changes:[...changes.values()],candidate:[...candidate].map(([path,content])=>({path,content})),agents:preceding};
}