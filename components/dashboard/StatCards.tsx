import { Skeleton } from "@/components/ui/Skeleton";
import type { Stat } from "@/lib/sample-data";

export function StatCards({ stats, loading }: { stats: Stat[]; loading?: boolean }) {
  return (
    <dl className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 2xl:grid-cols-6">
      {stats.map((s) => (
        <div key={s.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-card sm:p-5">
          <dt className="text-sm text-ink-muted">{s.label}</dt>
          {loading ? (
            <>
              <Skeleton className="mt-2 h-8 w-16" />
              <Skeleton className="mt-2 h-3 w-24" />
            </>
          ) : (
            <>
              <dd className="mt-1 text-3xl font-bold tracking-tight">{s.value}</dd>
              <p className="mt-1 text-xs text-ink-muted">{s.hint}</p>
            </>
          )}
        </div>
      ))}
    </dl>
  );
}
