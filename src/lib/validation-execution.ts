export const validationExecution = {
  status: "not-executed" as const,
  reason: "Build and tests have not been verified for this changeset. Run isolated verification in Validation. Model-written assertions are not execution evidence.",
};

export function requiresVerification(status: string) {
  return ["awaiting-approval","approved"].includes(status);
}