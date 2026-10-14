// Minimal Gemini REST client (no SDK). Server-side only: the API key travels in a header and
// is never placed in a URL, a log line, an error message or the browser bundle.
import { buildResponseSchema } from "./schema.ts";
import { SYSTEM_PROMPT, USER_PROMPT } from "./prompt.ts";
import type { ExtractionErrorCode } from "./errors.ts";
import { isRetryable } from "./errors.ts";

export interface Usage {
  inputTokens: number;
  outputTokens: number; // includes thinking tokens, which Google bills as output
}

export interface GeminiCallInput {
  apiKey: string;
  model: string;
  mime: string;
  data: Uint8Array;
  timeoutMs: number;
  maxOutputTokens: number;
  fetchImpl?: typeof fetch;
  // Optional prompt overrides. Used by the second-check pass; the first pass uses the defaults.
  systemPrompt?: string;
  userPrompt?: string;
  // Optional schema override (the key-figures reading uses a small schema). Default: the full invoice schema.
  responseSchema?: unknown;
  // Optional: ask Gemini to read the file at high media resolution (more tokens per page, small print is easier to read).
  // Only the targeted source verification asks for it. Never sent by the other readings.
  highResolution?: boolean;
}

export type GeminiCallResult =
  | { ok: true; text: string; usage: Usage }
  | { ok: false; code: ExtractionErrorCode; retryable: boolean; httpStatus?: number; retryAfterMs?: number; usage?: Usage };

export type GeminiCaller = (input: GeminiCallInput) => Promise<GeminiCallResult>;

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

function fail(code: ExtractionErrorCode, extra: { httpStatus?: number; retryAfterMs?: number; usage?: Usage } = {}): GeminiCallResult {
  return { ok: false, code, retryable: isRetryable(code), ...extra };
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 60) * 1000;
  return undefined;
}

export function readUsage(meta: unknown): Usage | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const m = meta as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  const input = n(m.promptTokenCount);
  const output = n(m.candidatesTokenCount) + n(m.thoughtsTokenCount);
  if (input === 0 && output === 0) return undefined;
  return { inputTokens: input, outputTokens: output };
}

export function estimateCostUsd(usage: Usage, inputPricePerMTok: number, outputPricePerMTok: number): number {
  const cost = (usage.inputTokens * inputPricePerMTok + usage.outputTokens * outputPricePerMTok) / 1_000_000;
  return Math.round(cost * 1e6) / 1e6;
}

export const callGemini: GeminiCaller = async (input) => {
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  const body = {
    systemInstruction: { parts: [{ text: input.systemPrompt ?? SYSTEM_PROMPT }] },
    contents: [
      {
        role: "user",
        parts: [
          { text: input.userPrompt ?? USER_PROMPT },
          { inlineData: { mimeType: input.mime, data: Buffer.from(input.data).toString("base64") } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: input.responseSchema ?? buildResponseSchema(),
      maxOutputTokens: input.maxOutputTokens,
      ...(input.highResolution ? { mediaResolution: "MEDIA_RESOLUTION_HIGH" } : {}),
    },
  };

  try {
    let res: Response;
    try {
      res = await doFetch(`${ENDPOINT}/${encodeURIComponent(input.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": input.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
      return fail(aborted ? "provider_timeout" : "provider_unavailable");
    }

    if (!res.ok) {
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      const s = res.status;
      if (s === 429) return fail("provider_rate_limited", { httpStatus: s, retryAfterMs });
      if (s === 408 || s === 504) return fail("provider_timeout", { httpStatus: s, retryAfterMs });
      if (s >= 500) return fail("provider_unavailable", { httpStatus: s, retryAfterMs });
      if (s === 401 || s === 403) return fail("provider_auth", { httpStatus: s });
      if (s === 404) return fail("provider_model_unavailable", { httpStatus: s });
      return fail("provider_rejected_input", { httpStatus: s });
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return fail(controller.signal.aborted ? "provider_timeout" : "empty_response", { httpStatus: res.status });
    }
    if (typeof json !== "object" || json === null) return fail("empty_response");
    const root = json as Record<string, unknown>;
    const usage = readUsage(root.usageMetadata);

    const feedback = root.promptFeedback as Record<string, unknown> | undefined;
    if (feedback && typeof feedback.blockReason === "string") return fail("provider_blocked", { usage });

    const candidates = root.candidates;
    const first = Array.isArray(candidates) ? (candidates[0] as Record<string, unknown> | undefined) : undefined;
    if (!first) return fail("empty_response", { usage });

    const finish = typeof first.finishReason === "string" ? first.finishReason : null;
    if (finish === "MAX_TOKENS") return fail("output_truncated", { usage });
    if (finish && finish !== "STOP") return fail("provider_blocked", { usage });

    const content = first.content as Record<string, unknown> | undefined;
    const parts = content && Array.isArray(content.parts) ? (content.parts as Record<string, unknown>[]) : [];
    const text = parts
      .filter((p) => p.thought !== true && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
    if (text.trim() === "") return fail("empty_response", { usage });

    return { ok: true, text, usage: usage ?? { inputTokens: 0, outputTokens: 0 } };
  } finally {
    clearTimeout(timer);
  }
};
