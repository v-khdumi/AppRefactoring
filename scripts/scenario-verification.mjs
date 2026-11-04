import path from "node:path";

export async function executeScenarioChecks(snapshot,publish,tools){
  const steps=[];
  if(!snapshot.scenarioChecks?.length)return steps;
  for(const check of snapshot.scenarioChecks)for(const variant of check.variants){
    const uid=variant==="baseline"?10001:10002;
    const cwd=path.join("/work",variant,check.project);
    const report=path.join(cwd,check.report.path);
    const command=`modernization acceptance ${check.kind}: ${check.id}`;
    const prepare=await tools.execute("node",["-e","const fs=require('node:fs');const path=require('node:path');fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true});fs.rmSync(process.argv[1],{force:true});",report],cwd,uid,30000);
    let step;
    if(prepare.exitCode!==0||prepare.timedOut)step={...prepare,command,exitCode:prepare.exitCode||1};
    else{
      step=await tools.execute(check.command,check.args,cwd,uid,check.timeoutSeconds*1000);
      step.command=command;
      try{
        const content=await tools.readFile(report,{limit:20_000_000});
        const counts=check.report.format==="junit"?tools.junitCounts([{content}]):tools.npmTestCounts(content,check.report.format==="json"?"json":"tap");
        step=tools.enforceExecutedTests(step,counts);
      }catch(error){step={...step,exitCode:step.exitCode||1,log:`${step.log}\nAcceptance test evidence is unavailable: ${error.message}`.slice(-32000)};}
    }
    delete step.output;delete step.outputs;
    steps.push({...step,variant,project:check.project});
    await publish({status:"failed",reason:`${variant}: ${command}`,steps},false);
    if(step.exitCode!==0||step.timedOut)break;
  }
  return steps;
}
