export function safeRepositoryPath(path:string){
  return Boolean(path&&path.length<=500&&!path.includes("\\")&&!path.startsWith("/")&&!/[\x00-\x1f\x7f:]/.test(path)&&path.split("/").every(part=>part!==".."&&part!=="."&&part!==""&&part!==".git"&&part!=="node_modules"));
}
