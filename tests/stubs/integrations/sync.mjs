// MOCK of lib/integrations/sync: the test decides what the "engine" does.
export const MAX_INVOICES_PER_SYNC = 25;
export async function syncInvoices(args) {
  const h = globalThis.__h.integ;
  h.syncArgs = args;
  return h.sync(args);
}
