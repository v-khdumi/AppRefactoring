import type { TransformationRun } from "../types/modernization";
import { validationExecution } from "./validation-execution";

export function approvalBlockReason(run: TransformationRun) {
  if (run.mode === "demo") return "";
  if (["approved", "pull-request-created", "publication-failed"].includes(run.status)) return "Approval already recorded.";
  const execution = run.validationExecution;
  if (execution && execution.status !== "passed") {
    if (["preparing", "running"].includes(execution.status)) return "Verification is in progress. Approval becomes available only after the current checks pass.";
    if (["failed", "unsupported", "stale"].includes(execution.status)) return `Verification ${execution.status}: ${execution.reason}`;
    return execution.reason || validationExecution.reason;
  }
  if (run.currentStage === "verification-required") return validationExecution.reason;
  if (["testing-user-edit", "testing-agent-validation"].includes(run.currentStage) && run.status === "running") return "Approval is unavailable while the edited changes are being revalidated.";
  if (run.status !== "awaiting-approval") return "Approval is available only when the run is awaiting human review.";
  if (!run.sourceCommitSha || !/^[a-f0-9]{40}$/i.test(run.sourceCommitSha)) return "The reviewed source commit is missing. Refresh the run before approval.";
  if (!run.files.length) return "No generated changes are available for approval.";
  if (run.agents?.find(agent => agent.type === "testing")?.status !== "passed") return "The Testing Agent has not passed yet.";
  const pending = run.files.filter(file => file.userModified || !file.validation.length).length;
  if (pending) return `${pending} file${pending === 1 ? "" : "s"} still require current validation evidence.`;
  if (execution?.status === "passed" && !execution.changesetDigest) return "The verified changeset identifier is missing. Refresh verification results before approval.";
  return execution?.status === "passed" ? "" : validationExecution.reason;
}