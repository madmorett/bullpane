import type { JobActionKind, JobActionResponse } from "../api/hooks";

const DONE: Record<JobActionKind, string> = {
  retry: "retried",
  promote: "promoted",
  remove: "removed",
  discard: "discarded",
};

/** Toast text for a single-job action. A scheduler's job runs as a copy, and the operator must know. */
export function jobActionMessage(jobId: string, action: JobActionKind, result?: JobActionResponse): string {
  if (action === "promote" && result?.mode === "ran_copy") {
    return `Job ${jobId} belongs to scheduler "${result.schedulerId}": ran a copy (${result.jobId}) now, the next scheduled run is unchanged`;
  }
  return `Job ${jobId} ${DONE[action]}`;
}
