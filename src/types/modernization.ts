export type ModernizationScope = "frontend" | "backend" | "fullstack";
export type FindingSeverity = "critical" | "high" | "medium" | "low";

export interface RepositoryInput {
  url: string;
  branch?: string;
  token?: string;
}

export interface ModernizationOptions {
  scope: ModernizationScope;
  frontendTarget?: string;
  backendTarget?: string;
  cloudReady: boolean;
  cloudOptions: string[];
  aiFeatures: string[];
  preserveBehavior: boolean;
}

export interface AnalysisRequest {
  repository: RepositoryInput;
  options: ModernizationOptions;
}

export interface ArchitectureNode {
  id: string;
  label: string;
  detail: string;
  kind: "client" | "service" | "data" | "integration" | "cloud";
}

export interface Finding {
  title: string;
  detail: string;
  severity: FindingSeverity;
  file?: string;
}

export interface AnalysisResult {
  sourceCommitSha?:string;
  scope?:ModernizationScope;
  evidence?:import("../lib/repository-evidence").RepositoryEvidence;
  mode: "demo" | "live";
  summary: string;
  confidence: number;
  repository: { name: string; branch: string; files: number; languages: Record<string, number> };
  currentArchitecture: ArchitectureNode[];
  targetArchitecture: ArchitectureNode[];
  findings: Finding[];
  recommendations: string[];
  migrationPhases: Array<{ title: string; description: string; duration: string }>;
  behaviorContracts: string[];
  estimate?: ModernizationEstimate;
}

export interface ModernizationEstimate {
  optimisticDays: number;
  expectedDays: number;
  conservativeDays: number;
  aiGenerationHours: number;
  verificationDays: number;
  parallelAgents: number;
  confidence: "low"|"medium"|"high";
  assumptions: string[];
}

export type TransformationStatus = "queued" | "retrying" | "running" | "passed" | "blocked" | "awaiting-approval" | "approved" | "rejected" | "failed" | "cancelled" | "publication-failed" | "pull-request-created";

export interface TransformationStage {
  id: string;
  title: string;
  detail: string;
  status: TransformationStatus;
  progress: number;
  startedAt?: string;
  completedAt?: string;
}

export interface TransformationFile {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  area: "frontend" | "backend" | "platform" | "tests";
  additions: number;
  deletions: number;
  rationale: string;
  before: string;
  after: string;
  validation: string[];
  agentType?: AgentType;
  userModified?: boolean;
}

export type AgentType = "architect" | "frontend" | "backend" | "cloud" | "testing" | "security";
export interface ModernizationAgent {
  reportedStatus?: TransformationStatus;
  id: string;
  type: AgentType;
  name: string;
  objective: string;
  status: TransformationStatus;
  progress: number;
  summary?: string;
  filesOwned: string[];
  output?: string;
  outputUpdatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  inputPaths?: string[];
}
export interface AgentMessage { id: string; agentType: AgentType; role: "user"|"agent"|"system"; content: string; createdAt: string }

export interface TransformationRun {
  publication?: {attempts:number;lastError?:string;nextAttemptAt?:string};
  validationExecution?: {id?:string;changesetDigest?:string;status:string;reason:string;updatedAt?:string;steps:Array<{variant:"baseline"|"candidate";project:string;command:string;exitCode:number|null;timedOut:boolean;log:string;durationMs:number}>};
  id: string;
  name: string;
  repository: string;
  branch: string;
  targetBranch: string;
  mode: "demo" | "live";
  status: TransformationStatus;
  progress: number;
  currentStage: string;
  sourceCommitSha?: string;
  pullRequestUrl?: string;
  aiModel?: string;
  errorCode?: string;
  errorDetail?: string;
  version?: number;
  attemptStartedAt?: string;
  stages: TransformationStage[];
  files: TransformationFile[];
  agents?: ModernizationAgent[];
}