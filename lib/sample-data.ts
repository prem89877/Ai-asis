// SAMPLE DATA: used only for clearly labelled UI previews.
// Replace with real API responses when the backend is integrated.

export type InvoiceStatus = "verified" | "needs_review" | "processing" | "error";

export interface Invoice {
  id: string;
  vendor: string;
  invoiceNo: string;
  date: string;
  gstin: string;
  taxable: number;
  gst: number;
  status: InvoiceStatus;
}

export interface Stat {
  label: string;
  value: string;
  hint: string;
}

export interface Activity {
  id: string;
  message: string;
  time: string;
  tone: "success" | "warning" | "info";
}

export const SAMPLE_LABEL = "Sample data. Not real invoices.";

export const sampleStats: Stat[] = [
  { label: "Invoices processed", value: "128", hint: "This month (sample)" },
  { label: "Verified", value: "104", hint: "Ready for export" },
  { label: "Needs review", value: "19", hint: "Flagged by checks" },
  { label: "Errors", value: "5", hint: "Could not be read" },
];

export const sampleInvoices: Invoice[] = [
  { id: "1", vendor: "Sample Traders Pvt Ltd", invoiceNo: "INV-2041", date: "2026-10-03", gstin: "27AAAAA0000A1Z5", taxable: 42500, gst: 7650, status: "verified" },
  { id: "2", vendor: "Demo Textiles", invoiceNo: "DT/118", date: "2026-10-02", gstin: "24BBBBB1111B1Z2", taxable: 18200, gst: 2184, status: "needs_review" },
  { id: "3", vendor: "Example Hardware Co", invoiceNo: "EH-7782", date: "2026-10-02", gstin: "29CCCCC2222C1Z8", taxable: 96400, gst: 17352, status: "verified" },
  { id: "4", vendor: "Placeholder Foods LLP", invoiceNo: "PF-0093", date: "2026-10-01", gstin: "07DDDDD3333D1Z4", taxable: 7800, gst: 390, status: "processing" },
  { id: "5", vendor: "Test Stationers", invoiceNo: "TS-554", date: "2026-09-30", gstin: "33EEEEE4444E1Z0", taxable: 3150, gst: 567, status: "error" },
];

export const sampleActivity: Activity[] = [
  { id: "a1", message: "Batch of 12 invoices uploaded", time: "10 min ago", tone: "info" },
  { id: "a2", message: "INV-2041 verified", time: "25 min ago", tone: "success" },
  { id: "a3", message: "DT/118: GST total mismatch flagged", time: "1 hr ago", tone: "warning" },
  { id: "a4", message: "Excel export generated (sample)", time: "Yesterday", tone: "success" },
];

export const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});
