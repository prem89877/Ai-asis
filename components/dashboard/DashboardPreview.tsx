"use client";

import { useState } from "react";
import Link from "next/link";
import { FileText, LayoutDashboard, Settings } from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { PreviewLabel } from "@/components/ui/PreviewLabel";
import { cn } from "@/lib/cn";
import { SAMPLE_LABEL, sampleActivity, sampleInvoices, sampleStats } from "@/lib/sample-data";
import { StatCards } from "./StatCards";
import { RecentActivity } from "./RecentActivity";
import { InvoiceTable } from "./InvoiceTable";
import { UploadDropzone } from "./UploadDropzone";

type ViewState = "ready" | "loading" | "empty";

const views: { id: ViewState; label: string }[] = [
  { id: "ready", label: "With data" },
  { id: "loading", label: "Loading" },
  { id: "empty", label: "Empty" },
];

const nav = [
  { label: "Dashboard", icon: LayoutDashboard, current: true },
  { label: "Invoices", icon: FileText, current: false },
  { label: "Settings", icon: Settings, current: false },
];

export function DashboardPreview() {
  const [view, setView] = useState<ViewState>("ready");
  const loading = view === "loading";
  const empty = view === "empty";

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="border-b border-slate-200 bg-white p-4 lg:border-b-0 lg:border-r">
        <Logo />
        <nav aria-label="Dashboard" className="mt-4 flex gap-1 overflow-x-auto lg:flex-col">
          {nav.map(({ label, icon: Icon, current }) => (
            <span
              key={label}
              aria-current={current ? "page" : undefined}
              className={cn(
                "flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium",
                current ? "bg-brand-soft text-brand" : "text-ink-muted"
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </span>
          ))}
        </nav>
      </aside>

      <main className="p-4 sm:p-6 lg:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <PreviewLabel />
        </div>
        <p className="mt-1 text-sm text-ink-muted">{SAMPLE_LABEL}</p>

        <div role="group" aria-label="Preview state" className="mt-4 inline-flex rounded-lg border border-slate-300 bg-white p-1">
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={view === v.id}
              onClick={() => setView(v.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium",
                view === v.id ? "bg-brand text-white" : "text-ink-muted hover:bg-slate-100"
              )}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="mt-6 space-y-6">
          <StatCards stats={sampleStats} loading={loading} />
          <div className="grid gap-6 xl:grid-cols-[2fr_1fr]">
            <InvoiceTable invoices={empty ? [] : sampleInvoices} loading={loading} />
            <div className="space-y-6">
              <UploadDropzone />
              <RecentActivity items={empty ? [] : sampleActivity} loading={loading} />
            </div>
          </div>
        </div>
        <p className="mt-8 text-xs text-ink-muted">
          <Link href="/" className="underline">Back to home</Link>
        </p>
      </main>
    </div>
  );
}
