export const NextResponse = {
  json(body, init = {}) {
    return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
  },
  redirect(url, init = {}) {
    return new Response(null, { status: 307, headers: { location: String(url), ...(init.headers ?? {}) } });
  },
};
