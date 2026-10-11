import Link from "next/link";

export function Logo() {
  return (
    <Link href="/" className="inline-flex items-center gap-2 rounded-md" aria-label="AI Asis home">
      <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
        <rect width="28" height="28" rx="7" fill="#2563EB" />
        <path d="M8 9h8M8 14h12M8 19h7" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <circle cx="21" cy="19" r="3" fill="#10B981" />
      </svg>
      <span className="text-lg font-bold tracking-tight text-ink">AI Asis</span>
    </Link>
  );
}
