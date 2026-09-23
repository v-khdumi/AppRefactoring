export function verificationDescription(status:string,reason?:string|null,error?:string|null) {
  if(error)return error;
  if(reason)return reason;
  switch(status){
    case "preparing": return "Preparing the pinned repository snapshot for isolated verification.";
    case "running": return "Verification job dispatched. Waiting for the first command result.";
    case "unsupported": return "The repository does not meet this runner's requirements. Open Validation for the recorded prerequisite failure.";
    case "failed": return "Verification failed before a complete report was recorded.";
    case "stale": return "The changeset has changed. Verification must be run again.";
    case "passed": return "Executed verification passed for this changeset.";
    default: return "No executed verification exists for this changeset.";
  }
}

export function verificationErrorCode(status:string) {
  if(status==="preparing"||status==="running")return null;
  if(status==="unsupported")return "VerificationUnsupported";
  if(status==="failed")return "VerificationFailed";
  if(status==="stale")return "VerificationStale";
  return "VerificationNotExecuted";
}