// MOCK of lib/integrations/zoho
export const DEFAULT_ZOHO_REGION = "in";
export const isZohoRegion = (v) => typeof v === "string" && ["com", "in", "eu", "com.au", "jp", "ca", "sa", "uk"].includes(v);
export function zohoSheetDriver(token, region, resourceId, worksheetName) { return { kind: "zoho_sheet", token, region, resourceId, worksheetName }; }
export async function booksTaxes() { return []; }
