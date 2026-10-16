// Reads a request body with a hard size cap that does NOT depend on the Content-Length header: a chunked request has none, so the
// bytes are counted as they arrive and the read is stopped (and the rest of the upload dropped) the moment the cap is passed.
// Hosting platforms usually enforce their own limit as well; this is the application-level guard.
export type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; message: string };
export type FormResult = { ok: true; form: FormData } | { ok: false; status: number; message: string };

const TOO_LARGE = { ok: false, status: 413, message: "Request is too large." } as const;

async function readTextCapped(request: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return TOO_LARGE;
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return TOO_LARGE;
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, message: "Invalid request." };
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { ok: true, text: new TextDecoder().decode(all) };
}

export async function readJsonBody(request: Request, maxBytes = 16 * 1024): Promise<BodyResult> {
  const r = await readTextCapped(request, maxBytes);
  if (!r.ok) return r;
  try {
    return { ok: true, value: JSON.parse(r.text) };
  } catch {
    return { ok: false, status: 400, message: "Invalid request." };
  }
}

// multipart/form-data with the same guarantee. The body is passed through a counting stream; passing the cap makes the stream fail,
// which stops formData() from buffering any more.
export async function readFormDataCapped(request: Request, maxBytes: number): Promise<FormResult> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return TOO_LARGE;
  if (!request.body) return { ok: false, status: 400, message: "Invalid upload." };
  let total = 0;
  let exceeded = false;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        exceeded = true;
        controller.error(new Error("too_large"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  const capped = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body.pipeThrough(counter),
    duplex: "half",
  } as RequestInit);
  try {
    return { ok: true, form: await capped.formData() };
  } catch {
    return exceeded ? TOO_LARGE : { ok: false, status: 400, message: "Invalid upload." };
  }
}
