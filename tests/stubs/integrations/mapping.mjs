// MOCK of lib/integrations/mapping
export const SYNC_FIELDS = [];
export const DEFAULT_SYNC_FIELDS = [];
export function defaultMapping() { return []; }
export function validateMapping(m) { return Array.isArray(m) && m.length > 0 ? { ok: true, mapping: m } : { ok: false, message: "invalid mapping" }; }
