import Link from "next/link";
import { Logo } from "@/components/ui/Logo";

export function Footer() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="container-page flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Logo />
          <p className="mt-2 text-sm text-ink-muted">AI invoice extraction for Indian accounting workflows.</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-muted">
          <a href="#features" className="hover:text-ink">Features</a>
          <a href="#pricing" className="hover:text-ink">Pricing</a>
          <a href="#faq" className="hover:text-ink">FAQ</a>
          <Link href="/login" className="hover:text-ink">Log in</Link>
        </nav>
      </div>
      <div className="border-t border-slate-100 py-4 text-center text-xs text-ink-muted">
        © {new Date().getFullYear()} AI Asis. Phase 1 interface preview.
      </div>
    </footer>
  );
}
