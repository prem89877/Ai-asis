// Reads a small JSON request body with a hard size cap, so a client cannot make the server buffer a huge payload.
export type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; message: string };

export async function readJsonBody(request: Request, maxBytes = 16 * 1024): Promise<BodyResult> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return { ok: false, status: 413, message: "Request is too large." };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, message: "Invalid request." };
  }
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, status: 413, message: "Request is too large." };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, message: "Invalid request." };
  }
}
