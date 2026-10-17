// MOCK of lib/integrations/tally-push
export function tallyPusher(args) { return { kind: "tally", args }; }
export function validateTallyUrl(raw) { try { return { ok: true, url: new URL(raw) }; } catch { return { ok: false, message: "bad" }; } }
