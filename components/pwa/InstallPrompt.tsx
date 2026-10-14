"use client";

import { useEffect, useState } from "react";
import { Download, Share, X } from "lucide-react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "ai-asis-install-dismissed";
const DISMISS_DAYS = 14;

function recentlyDismissed(): boolean {
  try {
    const t = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    return Date.now() - t < DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIos, setShowIos] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone || recentlyDismissed()) return;

    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setDeferred(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    // iOS Safari has no install event: show a one-line "Add to Home Screen" hint instead.
    const ua = navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    if (isIos) setShowIos(true);

    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setDeferred(null);
    setShowIos(false);
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice.catch(() => undefined);
    setDeferred(null);
  }

  if (!deferred && !showIos) return null;

  return (
    <div
      role="dialog"
      aria-label="Install AI Asis"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-md items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-card"
      style={{ marginBottom: "env(safe-area-inset-bottom)" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icons/icon-192.png" alt="" width={40} height={40} className="h-10 w-10 rounded-lg" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-ink">Install AI Asis</p>
        {deferred ? (
          <p className="text-ink-muted">Open it like an app, straight from your home screen.</p>
        ) : (
          <p className="text-ink-muted">
            Tap <Share className="inline h-4 w-4 align-text-bottom" aria-label="Share" /> then &ldquo;Add to Home Screen&rdquo;.
          </p>
        )}
      </div>
      {deferred && (
        <button
          type="button"
          onClick={install}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand-hover"
        >
          <Download className="h-4 w-4" aria-hidden /> Install
        </button>
      )}
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-1.5 text-ink-muted hover:bg-slate-100"
      >
        <X className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
