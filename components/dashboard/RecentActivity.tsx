import { Inbox } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Skeleton";
import type { Activity } from "@/lib/sample-data";

const dot = { success: "bg-success", warning: "bg-amber-500", info: "bg-brand" } as const;

export function RecentActivity({ items, loading }: { items: Activity[]; loading?: boolean }) {
  return (
    <section aria-labelledby="activity-title" className="rounded-xl border border-slate-200 bg-white shadow-card">
      <h2 id="activity-title" className="border-b border-slate-100 px-5 py-4 text-base font-semibold">Recent activity</h2>
      {loading ? (
        <div className="space-y-4 p-5">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={Inbox} title="No activity yet" description="Uploads, reviews and exports will show up here." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((a) => (
            <li key={a.id} className="flex items-start gap-3 px-5 py-3">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[a.tone]}`} aria-hidden />
              <div>
                <p className="text-sm">{a.message}</p>
                <p className="text-xs text-ink-muted">{a.time}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
