import type { ReactNode } from "react";
import { Logo } from "@/components/ui/Logo";

export const authInputClass =
  "mt-1.5 block h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base placeholder:text-slate-400 aria-[invalid=true]:border-red-600";

export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
          {children}
        </div>
      </div>
    </main>
  );
}
