import type { ReactNode } from "react";
import logo from "../images/logo-mark.svg";

// Mirrors zscraper's shell: centered header row, max-w-7xl, safe-area-aware
// padding so it sits correctly as an installed PWA on notched phones.
export default function Layout({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-white dark:bg-stone-950">
      <header className="border-b border-stone-200 bg-white pt-[env(safe-area-inset-top)] dark:border-stone-800 dark:bg-stone-950">
        <div className="mx-auto flex max-w-7xl items-center justify-center gap-6 py-4 pl-[max(1.5rem,env(safe-area-inset-left))] pr-[max(1.5rem,env(safe-area-inset-right))]">
          <a href="/" className="flex shrink-0 items-center gap-2.5">
            <img src={logo} alt="" className="h-9 w-9" />
            <span className="text-lg font-semibold tracking-tight text-stone-900 dark:text-stone-100">CB Checker</span>
          </a>
          {actions}
        </div>
      </header>
      <main className="mx-auto max-w-7xl pt-6 pb-[calc(1.5rem_+_env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))]">
        {children}
      </main>
    </div>
  );
}
