// TallyPrime direct push: posts the same purchase-voucher XML as the file export to TallyPrime's built-in HTTP server.
// !! Unit-tested with mocked HTTP only. Never run against a real TallyPrime. Read docs/PHASE7_INTEGRATIONS_SETUP.md first. !!
//
// How it can work at all: TallyPrime listens on a port on the accountant's own PC (default 9000) and that PC is not on the internet.
// The server can only reach it through a public HTTPS address that forwards to that port (Cloudflare Tunnel, ngrok, a reverse proxy
// with a password). The address is entered by the firm owner, so it is checked HARD before the server calls it (SSRF protection):
// https only, no credentials in the URL, no IP literals, no localhost / internal names, every resolved address must be public,
// redirects are never followed, the answer is size-limited.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { buildVouchers, toTallyXml, xmlEscape } from "../tally/build.ts";
import type { TallyConfig } from "../tally/build.ts";
import type { ExportInvoice } from "../export/columns.ts";
import { IntegrationError } from "./http.ts";
import { PushRefusal } from "./push-sync.ts";
import type { Pusher } from "./push-sync.ts";

export type TallyUrlCheck = { ok: true; url: URL } | { ok: false; message: string };

export function validateTallyUrl(raw: unknown): TallyUrlCheck {
  if (typeof raw !== "string" || raw.length > 300) return { ok: false, message: "Enter the public https address of your Tally connection." };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, message: "That is not a valid web address." }; }
  if (u.protocol !== "https:") return { ok: false, message: "Use an https address. TallyPrime itself is plain http, so put a tunnel or proxy with https in front of it." };
  if (u.username || u.password) return { ok: false, message: "Do not put a user name or password in the address. Use the access token field." };
  const host = u.hostname.toLowerCase();
  if (isIP(host) || host.startsWith("[")) return { ok: false, message: "Use a host name, not an IP address." };
  if (!host.includes(".") || host === "localhost" || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(host)) return { ok: false, message: "That address is not reachable from the internet." };
  u.hash = "";
  return { ok: true, url: u };
}

const privateV4 = (a: string) => { const p = a.split(".").map(Number); return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] >= 224; };
export function isPublicAddress(addr: string): boolean {
  const a = addr.toLowerCase();
  if (isIP(a) === 4) return !privateV4(a);
  if (isIP(a) === 6) {
    if (a === "::" || a === "::1" || a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb") || a.startsWith("fc") || a.startsWith("fd")) return false;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    return m ? !privateV4(m[1]) : true;
  }
  return false;
}

export interface TallyTransport {
  lookupHost?: (host: string) => Promise<string[]>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}
const defaultLookup = async (host: string) => (await lookup(host, { all: true })).map((r: { address: string }) => r.address);

export async function assertPublicHost(u: URL, t: TallyTransport = {}): Promise<void> {
  let addrs: string[];
  try { addrs = await (t.lookupHost ?? defaultLookup)(u.hostname); } catch { throw new IntegrationError("network"); }
  if (addrs.length === 0 || !addrs.every(isPublicAddress)) throw new IntegrationError("permission_denied"); // resolves to a private address: refused
}

export interface TallyReply { ok: boolean; created: number; altered: number; errors: number; detail: string }
const num = (xml: string, tag: string) => { const m = new RegExp(`<${tag}>\\s*(\\d+)\\s*</${tag}>`, "i").exec(xml); return m ? Number(m[1]) : 0; };
export function parseTallyReply(xml: string): TallyReply {
  const created = num(xml, "CREATED"), altered = num(xml, "ALTERED"), errors = num(xml, "ERRORS");
  const line = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(xml)?.[1] ?? (/<DESC>([\s\S]*?)<\/DESC>/i.exec(xml)?.[1] ?? "");
  const detail = line.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  return { ok: errors === 0 && created + altered > 0, created, altered, errors, detail };
}

// One request with a timeout, no redirects, a size limit. Returns the text of the answer.
export async function postToTally(url: URL, token: string | null, xml: string, t: TallyTransport = {}): Promise<string> {
  await assertPublicHost(url, t);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t.timeoutMs ?? 25_000);
  try {
    const res = await (t.fetchImpl ?? ((u, i) => fetch(u, i)))(url.toString(), {
      method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Content-Type": "text/xml; charset=utf-8", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: xml,
    });
    if (res.status >= 300 && res.status < 400) throw new IntegrationError("bad_request", res.status); // redirects are never followed
    if (res.status === 401 || res.status === 403) throw new IntegrationError("permission_denied", res.status);
    if (res.status >= 400) throw new IntegrationError(res.status >= 500 ? "server_error" : "bad_request", res.status);
    return (await res.text()).slice(0, 20_000);
  } catch (e) {
    if (e instanceof IntegrationError) throw e;
    throw new IntegrationError((e as { name?: string } | null)?.name === "AbortError" ? "timeout" : "network");
  } finally { clearTimeout(timer); }
}

// Asks Tally which companies are open: proves the connection works without creating anything.
export function companiesRequestXml(): string {
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="List of Companies"><TYPE>Company</TYPE><FETCH>Name</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>';
}
export function parseCompanies(xml: string): string[] {
  return Array.from(xml.matchAll(/<COMPANY[^>]*>[\s\S]*?<NAME[^>]*>([^<]{1,100})<\/NAME>/gi)).map((m) => m[1].trim()).filter(Boolean).slice(0, 20);
}

// One voucher per request, so every invoice gets its own answer. A timeout after the request left is an UNKNOWN outcome: the voucher
// may exist in Tally, so the message tells the user to look in Tally before sending again (nothing is retried automatically).
export function tallyPusher(args: { url: URL; token: string | null; config: TallyConfig; transport?: TallyTransport }): Pusher {
  return {
    async push(inv: ExportInvoice) {
      const { vouchers, skipped } = buildVouchers([inv], args.config);
      if (vouchers.length === 0) throw new PushRefusal(skipped[0]?.reason ?? "This invoice cannot be turned into a Tally voucher.");
      let text: string;
      try { text = await postToTally(args.url, args.token, toTallyXml(vouchers, args.config), args.transport); }
      catch (e) {
        if (e instanceof IntegrationError && (e.code === "timeout" || e.code === "network")) throw new PushRefusal(`Tally did not answer, so it is not known whether voucher ${xmlEscape(vouchers[0].voucherNumber)} was created. Check Tally before pressing Sync again.`, "unconfirmed");
        throw e;
      }
      const r = parseTallyReply(text);
      if (!r.ok) throw new PushRefusal(`Tally refused the voucher${r.detail ? `: ${r.detail}` : "."} Check that the ledger names in the Tally settings exist in Tally.`, "tally_rejected");
      return {};
    },
  };
}
