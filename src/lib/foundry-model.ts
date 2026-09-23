export function foundryModelParameters(model:string,temperature:number){
  if(model.startsWith("gpt-5.6-")||model.startsWith("gpt-6-"))return{reasoning_effort:"medium" as const};
  return{temperature};
}
