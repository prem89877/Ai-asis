// Error codes saved in processing_jobs.error_code, with a safe user-facing message for each.
// Messages never contain invoice content or provider details.

interface ErrorInfo {
  retryable: boolean; // worth another attempt inside the same run
  message: string;
}

export const ERROR_INFO = {
  file_missing: { retryable: false, message: "The stored file could not be found." },
  file_integrity: { retryable: false, message: "The stored file does not match the uploaded original. Upload it again." },
  empty_file: { retryable: false, message: "The file is empty." },
  unsupported_type: { retryable: false, message: "Only PDF, JPG and PNG files can be processed." },
  malformed_pdf: { retryable: false, message: "This PDF looks damaged or incomplete and could not be read." },
  password_protected: { retryable: false, message: "This PDF is encrypted. Remove the protection and upload it again." },
  too_many_pages: { retryable: false, message: "This PDF has more pages than the allowed limit." },
  unreadable_image: { retryable: false, message: "This image looks damaged or incomplete and could not be read." },
  image_too_small: { retryable: false, message: "This image is too small to read. Upload a higher-resolution copy." },
  provider_rate_limited: { retryable: true, message: "The AI service is busy. Try again in a few minutes." },
  provider_unavailable: { retryable: true, message: "The AI service is temporarily unavailable. Try again later." },
  provider_timeout: { retryable: true, message: "The AI service took too long to respond. Try again." },
  provider_auth: { retryable: false, message: "AI extraction is not configured correctly on the server. Contact support." },
  provider_model_unavailable: { retryable: false, message: "The configured AI model is not available. Contact support." },
  provider_rejected_input: { retryable: false, message: "The AI service could not read this file. Try a clearer copy." },
  provider_blocked: { retryable: false, message: "The AI service declined to process this file." },
  output_truncated: { retryable: false, message: "This invoice is too long to extract in one pass." },
  empty_response: { retryable: true, message: "The AI service returned no result. Try again." },
  invalid_model_output: { retryable: true, message: "The AI result could not be validated, so nothing was saved. Try again or enter the data manually." },
  not_an_invoice: { retryable: false, message: "This file does not look like an invoice." },
  stale_timeout: { retryable: false, message: "Processing did not finish in time. Try again." },
  invoice_removed: { retryable: false, message: "The invoice was deleted during processing." },
  internal_error: { retryable: false, message: "Something went wrong while processing. Try again." },
} as const satisfies Record<string, ErrorInfo>;

export type ExtractionErrorCode = keyof typeof ERROR_INFO;

export function isRetryable(code: ExtractionErrorCode): boolean {
  return ERROR_INFO[code].retryable;
}

export function userMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  const info = (ERROR_INFO as Record<string, ErrorInfo | undefined>)[code];
  return info ? info.message : ERROR_INFO.internal_error.message;
}
