import { Outlet, Link } from "react-router-dom";

export default function Layout() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2 group">
            <span className="text-2xl">📡</span>
            <span className="text-lg font-bold tracking-tight group-hover:text-orange-400 transition-colors">
              CB Checker
            </span>
          </Link>
          <span className="text-xs text-zinc-500 ml-auto">
            Chaturbate Room Tracker
          </span>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
