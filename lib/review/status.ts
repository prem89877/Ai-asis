// One definition of the four review states shown to people, shared by the dashboard and by exports.
// Database statuses: uploaded, queued, processing, completed, needs_review, verified, failed, pending_deletion.
//  - "completed" means AI extraction finished with no flags. It is NOT human verification, so it still needs review.

export type ReviewState = "processing" | "needs_review" | "verified" | "failed" | "deleting";

export function reviewState(status: string): ReviewState {
  switch (status) {
    case "uploaded":
    case "queued":
    case "processing":
      return "processing";
    case "needs_review":
    case "completed":
      return "needs_review";
    case "verified":
      return "verified";
    case "failed":
      return "failed";
    default:
      return "deleting";
  }
}

export const REVIEW_STATE_LABEL: Record<ReviewState, string> = {
  processing: "Processing",
  needs_review: "Needs review",
  verified: "Verified",
  failed: "Failed",
  deleting: "Deleting",
};

// More precise text for tooltips and exports.
export function statusDetail(status: string): string {
  switch (status) {
    case "uploaded": return "Uploaded, waiting to be queued";
    case "queued": return "Queued for AI extraction";
    case "processing": return "AI extraction in progress";
    case "needs_review": return "Needs review: flagged by checks";
    case "completed": return "Needs review: no flags, not yet verified";
    case "verified": return "Verified by a person";
    case "failed": return "Processing failed";
    default: return "Being deleted";
  }
}

// Exports and review are only possible once extracted data exists.
export function hasExtractedData(status: string): boolean {
  return status === "completed" || status === "needs_review" || status === "verified";
}
