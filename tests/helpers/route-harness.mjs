// Test harness for route handlers: an in-memory fake of the parts of the Supabase client the routes use, plus request
// builders. The fake REALLY applies eq / in / gte filters, so a route that forgets its firm_id filter leaks rows in the test.
import { register } from "node:module";

export function setup({ mockIntegrations = false } = {}) {
  register("./alias-hooks.mjs", import.meta.url, { data: { mockIntegrations } });
}

export function createDb(tables = {}, { rpc = {} } = {}) {
  const data = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const log = [];
  const rpcLog = [];
  const errors = {};
  const writes = [];
  const ctl = { writeErrors: {}, uploadError: null, removeError: null };
  function from(table) {
    const q = { filters: [], order: [], limit: null, range: null, opts: {}, single: false, cols: undefined, op: "select", patch: null };
    const api = {
      insert(row) {
        writes.push({ table, op: "insert", row });
        const err = ctl.writeErrors[table + ":insert"];
        if (err) return Promise.resolve({ data: null, error: err });
        (data[table] ??= []).push({ ...row });
        return Promise.resolve({ data: null, error: null });
      },
      update(patch) { q.op = "update"; q.patch = patch; return api; },
      delete() { q.op = "delete"; return api; },
      select(cols, opts) { q.cols = cols; q.opts = opts ?? {}; return api; },
      eq(c, v) { q.filters.push(["eq", c, v]); return api; },
      in(c, v) { q.filters.push(["in", c, v]); return api; },
      gte(c, v) { q.filters.push(["gte", c, v]); return api; },
      neq(c, v) { q.filters.push(["neq", c, v]); return api; },
      order(c, o) { q.order.push([c, o?.ascending !== false]); return api; },
      limit(n) { q.limit = n; return api; },
      range(a, b) { q.range = [a, b]; return api; },
      maybeSingle() { q.single = true; return exec(); },
      then(res, rej) { return exec().then(res, rej); },
    };
    function exec() {
      if (q.op !== "select") {
        writes.push({ table, op: q.op, patch: q.patch, filters: q.filters.map((f) => [...f]) });
        const err = ctl.writeErrors[table + ":" + q.op];
        if (err) return Promise.resolve({ data: null, error: err });
        const hit = (r) => q.filters.every(([op, c, v]) => (op === "eq" ? r[c] === v : op === "neq" ? r[c] !== v : op === "in" ? v.includes(r[c]) : r[c] >= v));
        if (q.op === "update") { for (const r of data[table] ?? []) if (hit(r)) Object.assign(r, q.patch); }
        else if (q.op === "delete") data[table] = (data[table] ?? []).filter((r) => !hit(r));
        return Promise.resolve({ data: null, error: null });
      }
      log.push({ table, filters: q.filters.map((f) => [...f]), cols: q.cols, opts: q.opts });
      if (errors[table]) return Promise.resolve({ data: null, error: errors[table], count: null });
      let rows = (data[table] ?? []).filter((r) => q.filters.every(([op, c, v]) => (op === "eq" ? r[c] === v : op === "neq" ? r[c] !== v : op === "in" ? v.includes(r[c]) : r[c] >= v)));
      for (const [c, asc] of [...q.order].reverse()) rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
      const count = rows.length;
      if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
      if (q.limit != null) rows = rows.slice(0, q.limit);
      if (q.opts.head) return Promise.resolve({ data: null, error: null, count: q.opts.count ? count : null });
      if (q.single) return Promise.resolve({ data: rows[0] ?? null, error: null });
      return Promise.resolve({ data: rows, error: null, count: q.opts.count ? count : null });
    }
    return api;
  }
  return {
    data, log, rpcLog, errors, writes, ctl, from,
    rpc(name, args) {
      rpcLog.push({ name, args });
      const f = rpc[name];
      return Promise.resolve(f ? f(args) : { data: null, error: { code: "XX000", message: "rpc not mocked" } });
    },
  };
}

// A signed-in (or anonymous) user client. `db` provides from/rpc.
export function userClient(db, user, objects = {}) {
  const storage = {
    signed: [], uploaded: [], removed: [],
    from: (bucket) => ({
      upload: async (path, bytes, opts) => {
        if (db.ctl.uploadError) return { data: null, error: db.ctl.uploadError };
        storage.uploaded.push({ bucket, path, size: bytes.length, opts }); objects[path] = bytes;
        return { data: { path }, error: null };
      },
      remove: async (paths) => {
        if (db.ctl.removeError) return { data: null, error: db.ctl.removeError };
        storage.removed.push(...paths); for (const p of paths) delete objects[p];
        return { data: [], error: null };
      },
      createSignedUrl: async (path, ttl, opts) => {
        if (!(path in objects)) return { data: null, error: { message: "Object not found" } };
        storage.signed.push({ bucket, path, ttl, opts });
        return { data: { signedUrl: `https://storage.test/${bucket}/${path}?token=t` }, error: null };
      },
      download: async (path) => (path in objects ? { data: new Blob([objects[path]]), error: null } : { data: null, error: { message: "Object not found" } }),
    }),
  };
  return { from: db.from, rpc: db.rpc, storage, auth: { getUser: async () => ({ data: { user }, error: null }) } };
}

export const U1 = { id: "u1" };
export const F1 = "11111111-1111-4111-8111-1111111111f1";
export const F2 = "22222222-2222-4222-8222-2222222222f2";

// Installs the fake world for the next request: who is signed in, which firm they belong to, what is in the database.
export function world({ user = U1, role = "owner", firm = F1, tables = {}, rpc: rpcOverrides = {}, admin = true, members, objects = {}, adminTables = {} } = {}) {
  // reserve_upload_slot / release_upload_slot behave like the SQL functions (018_quota_worker_upload_cap.sql): the count comes from
  // upload_events (adminTables), never from invoices, and release only works for a slot whose invoice does not exist.
  let adminDb;
  const rpc = {
    reserve_upload_slot: ({ p_firm_id, p_user_id, p_invoice_id, p_limit }) => {
      const events = (adminDb.data.upload_events ??= []);
      const since = Date.now() - 24 * 3600 * 1000;
      const used = events.filter((e) => e.firm_id === p_firm_id && new Date(e.created_at).getTime() >= since).length;
      if (used >= p_limit) return { data: { result: "limit", used }, error: null };
      const id = `slot-${events.length + 1}`;
      events.push({ id, firm_id: p_firm_id, user_id: p_user_id, invoice_id: p_invoice_id, created_at: new Date().toISOString() });
      return { data: { result: "ok", id, used: used + 1 }, error: null };
    },
    release_upload_slot: ({ p_firm_id, p_event_id }) => {
      const events = (adminDb.data.upload_events ??= []);
      const e = events.find((x) => x.id === p_event_id && x.firm_id === p_firm_id);
      const exists = e && (db.data.invoices ?? []).some((i) => i.id === e.invoice_id);
      if (e && !exists) adminDb.data.upload_events = events.filter((x) => x !== e);
      return { data: null, error: null };
    },
    ...rpcOverrides,
  };
  const db = createDb({ firm_members: members ?? (user ? [{ user_id: user.id, firm_id: firm, role, created_at: "2026-01-01" }] : []), ...tables }, { rpc });
  adminDb = createDb(adminTables, { rpc });
  globalThis.__h = { db, client: userClient(db, user, objects), admin: admin ? adminDb : null, adminDb, integ: { calls: [] } };
  return globalThis.__h;
}

export function req(path, { method = "POST", body, origin = "https://app.test", host = "app.test", headers = {} } = {}) {
  const h = { host, ...headers };
  if (origin) h.origin = origin;
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (body !== undefined && !isForm) h["content-type"] = "application/json";
  return new Request("https://app.test" + path, { method, headers: h, body: body === undefined ? undefined : isForm || typeof body === "string" ? body : JSON.stringify(body) });
}

export async function readJson(res) { return { status: res.status, headers: res.headers, body: await res.json() }; }

export function uuid(n) { return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`; }
