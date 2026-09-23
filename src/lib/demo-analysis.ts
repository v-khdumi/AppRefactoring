import type { AnalysisResult, ModernizationOptions } from "@/types/modernization";
import { estimateModernization } from "@/lib/estimation";

export function createDemoAnalysis(options?: Partial<ModernizationOptions>): AnalysisResult {
  const frontend = options?.frontendTarget || "Next.js 15 + TypeScript";
  const backend = options?.backendTarget || ".NET 9 Minimal APIs";
  const result:AnalysisResult = {
    mode: "demo",
    summary: "A mature monolithic application with valuable business logic, but end-of-life dependencies and tight coupling across presentation, domain, and data access. Incremental modernization reduces risk without changing existing behavior.",
    confidence: 92,
    repository: {
      name: "contoso/legacy-order-hub",
      branch: "main",
      files: 1248,
      languages: { "C#": 61, JavaScript: 23, HTML: 9, SQL: 7 },
    },
    currentArchitecture: [
      { id: "webforms", label: "ASP.NET Web Forms", detail: ".NET Framework 4.6.2", kind: "client" },
      { id: "monolith", label: "OrderHub Monolith", detail: "UI + business rules", kind: "service" },
      { id: "jobs", label: "Windows Services", detail: "4 scheduled workers", kind: "service" },
      { id: "sql", label: "SQL Server", detail: "178 tables · 92 SPs", kind: "data" },
      { id: "erp", label: "Legacy ERP", detail: "SOAP / XML", kind: "integration" },
    ],
    targetArchitecture: [
      { id: "next", label: frontend, detail: "Accessible web experience", kind: "client" },
      { id: "gateway", label: "Azure API Management", detail: "Versioning + security", kind: "cloud" },
      { id: "services", label: backend, detail: "Modular domain services", kind: "service" },
      { id: "workers", label: "Container Apps Jobs", detail: "Observable background work", kind: "cloud" },
      { id: "data", label: "Azure SQL", detail: "Schema preserved initially", kind: "data" },
      { id: "ai", label: "Azure AI Foundry", detail: "Support copilot + RAG", kind: "cloud" },
    ],
    findings: [
      { title: ".NET Framework 4.6.2 is end-of-life", detail: "The runtime no longer receives modern security updates and cannot support Linux workloads.", severity: "critical", file: "OrderHub.sln" },
      { title: "Business logic in code-behind", detail: "37 screens contain validation and domain rules that must be extracted behind characterization tests.", severity: "high", file: "Web/Orders/*.aspx.cs" },
      { title: "Direct SQL dependency", detail: "ADO.NET calls are distributed across 84 files and 92 stored procedures.", severity: "high", file: "Data/SqlHelper.cs" },
      { title: "Vulnerable JavaScript libraries", detail: "jQuery 1.12 and Bootstrap 3 should be removed after current UI behavior is captured.", severity: "medium", file: "packages.config" },
      { title: "SOAP integration without resilience", detail: "The ERP connector has no timeout, circuit breaker, or idempotency key.", severity: "medium", file: "Integrations/ErpClient.cs" },
    ],
    recommendations: [
      "Create characterization tests for the 23 critical flows before the first source change.",
      "Apply the Strangler Fig pattern: keep the monolith active and move capabilities incrementally through an API gateway.",
      "Extract the Orders domain as the first vertical slice; it has high value and only three external dependencies.",
      "Preserve the SQL schema initially and modernize data access after API contracts stabilize.",
      "Use feature flags and shadow-traffic comparison to validate functional parity.",
    ],
    migrationPhases: [
      { title: "Baseline & safety net", description: "Inventory, SBOM, contracts, and AI-generated characterization tests for critical flows.", duration: "4–8 hours" },
      { title: "Parallel generation", description: "Frontend, backend, cloud, security, and testing agents work on isolated file sets.", duration: "1–3 days" },
      { title: "Orders vertical slice", description: "Merge conflict-free agent output and validate the first complete business slice.", duration: "2–4 days" },
      { title: "Progressive migration", description: "Transform remaining capabilities in parallel waves with continuous regression testing.", duration: "5–10 days" },
      { title: "Cutover & optimize", description: "Shadow traffic, parity verification, human approval, and controlled cutover.", duration: "1–3 days" },
    ],
    behaviorContracts: [
      "23 end-to-end flows captured",
      "146 API and integration contract tests",
      "92 stored procedure snapshots",
      "Zero breaking changes accepted",
    ],
  };
  result.estimate=estimateModernization({files:result.repository.files,findings:result.findings,options:{scope:options?.scope||"fullstack",frontendTarget:options?.frontendTarget,backendTarget:options?.backendTarget,cloudReady:options?.cloudReady??true,cloudOptions:options?.cloudOptions||[],aiFeatures:options?.aiFeatures||["Support copilot"],preserveBehavior:true}});
  return result;
}