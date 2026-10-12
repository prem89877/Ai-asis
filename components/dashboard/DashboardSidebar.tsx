import Link from "next/link";
import { CreditCard, FileText, LayoutDashboard, Plug, Settings } from "lucide-react";
import { Logo } from "@/components/ui/Logo";
import { cn } from "@/lib/cn";

export type DashboardNavKey = "dashboard" | "billing" | "integrations";

// Invoices and Settings are placeholders from earlier phases (no page yet), so they stay non-links.
const items = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
  { key: "invoices", label: "Invoices", icon: FileText, href: null },
  { key: "integrations", label: "Integrations", icon: Plug, href: "/dashboard/integrations" },
  { key: "billing", label: "Billing", icon: CreditCard, href: "/dashboard/billing" },
  { key: "settings", label: "Settings", icon: Settings, href: null },
] as const;

export function DashboardSidebar({ current }: { current: DashboardNavKey }) {
  return (
    <aside className="border-b border-slate-200 bg-white p-4 lg:border-b-0 lg:border-r">
      <Logo />
      <nav aria-label="Dashboard" className="mt-4 flex gap-1 overflow-x-auto lg:flex-col">
        {items.map(({ key, label, icon: Icon, href }) => {
          const isCurrent = key === current;
          const cls = cn(
            "flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium",
            isCurrent ? "bg-brand-soft text-brand" : "text-ink-muted",
            href && !isCurrent && "hover:bg-slate-100 hover:text-ink"
          );
          const inner = (
            <>
              <Icon className="h-4 w-4" aria-hidden />
              {label}
            </>
          );
          return href ? (
            <Link key={key} href={href} aria-current={isCurrent ? "page" : undefined} className={cls}>{inner}</Link>
          ) : (
            <span key={key} className={cls}>{inner}</span>
          );
        })}
      </nav>
    </aside>
  );
}
