export const frontendTargets=["Next.js 15 + TypeScript","React 19 + TypeScript","Angular 19","Vue 3 + TypeScript"] as const;
export const backendTargets=[".NET 10 + ASP.NET Core","Java 25 + Spring Boot 4","Go 1.27","PHP 8.5 + Laravel 13","Node.js + NestJS","Python + FastAPI"] as const;
export type FrontendTarget=typeof frontendTargets[number];
export type BackendTarget=typeof backendTargets[number];
export type VerificationRuntime="npm"|"python"|"dotnet"|"maven"|"gradle"|"go"|"php";

export const backendTargetRuntimes:Record<BackendTarget,VerificationRuntime[]>={
  ".NET 10 + ASP.NET Core":["dotnet"],
  "Java 25 + Spring Boot 4":["maven","gradle"],
  "Go 1.27":["go"],
  "PHP 8.5 + Laravel 13":["php"],
  "Node.js + NestJS":["npm"],
  "Python + FastAPI":["python"],
};

export function isBackendTarget(value:unknown):value is BackendTarget{return typeof value==="string"&&(backendTargets as readonly string[]).includes(value);}

export function backendTargetFor(runtime:VerificationRuntime):BackendTarget{
  return (Object.entries(backendTargetRuntimes) as Array<[BackendTarget,VerificationRuntime[]]>).find(([,runtimes])=>runtimes.includes(runtime))![0];
}
