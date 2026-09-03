import { NavLink } from "react-router-dom";
import { Film, MessageCircle, UploadCloud, Home } from "lucide-react";

const links = [
  { to: "/", label: "Overview", icon: Home, end: true },
  { to: "/query", label: "Query mode", icon: MessageCircle },
  { to: "/admin", label: "Admin", icon: UploadCloud },
];

export default function Sidebar({ connected }) {
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r border-theatre-border bg-theatre-surface">
      <div className="flex items-center gap-2.5 px-5 py-6">
        <Film size={20} className="text-gold" strokeWidth={1.75} />
        <span className="font-display text-lg tracking-tight text-theatre-text">Cinegraph</span>
      </div>

      <div className="sprocket-rule mx-5 mb-4" />

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${
                isActive
                  ? "bg-theatre-surface2 text-theatre-text"
                  : "text-theatre-muted hover:bg-theatre-surface2/60 hover:text-theatre-text"
              }`
            }
          >
            <Icon size={17} strokeWidth={1.75} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-theatre-border px-5 py-4">
        <div className="flex items-center gap-2 text-xs text-theatre-muted">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              connected === null ? "bg-theatre-faint" : connected ? "bg-teal" : "bg-gold"
            }`}
          />
          {connected === null ? "Checking systems…" : connected ? "All systems connected" : "Connection issue"}
        </div>
      </div>
    </aside>
  );
}
