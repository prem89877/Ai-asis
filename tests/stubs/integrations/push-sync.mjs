// MOCK of lib/integrations/push-sync: the test decides what the engine does.
export const MAX_PUSH_PER_RUN = 15;
export async function pushInvoices(args) { const h = globalThis.__h.integ; h.pushArgs = args; return h.push ? h.push(args) : []; }
