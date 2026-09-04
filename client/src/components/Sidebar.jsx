import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  Film,
  MessageCircle,
  UploadCloud,
  Home,
  ChevronsLeft,
  ChevronsRight,
  X,
  RotateCw,
  Github,
} from "lucide-react";

const links = [
  { to: "/", label: "Overview", icon: Home, end: true },
  { to: "/query", label: "Query mode", icon: MessageCircle },
  { to: "/admin", label: "Admin", icon: UploadCloud },
];

// True at >= Tailwind's md breakpoint (768px). Drives the desktop
// (collapsible + resizable, part of the flex layout) vs. mobile
// (fixed off-canvas drawer) rendering below.
function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches
  );
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px)");
    const onChange = (e) => setIsDesktop(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isDesktop;
}

export default function Sidebar({
  connected,
  onRetryConnection,
  collapsed,
  onToggleCollapsed,
  width,
  defaultWidth,
  minWidth,
  maxWidth,
  collapsedWidth,
  onResizeWidth,
  mobileOpen,
  onCloseMobile,
}) {
  const isDesktop = useIsDesktop();
  const draggingRef = useRef(false);

  // Drag-to-resize (desktop only). The sidebar sits flush against the
  // left edge of the viewport, so the pointer's clientX doubles as the
  // requested width — no offset math needed.
  useEffect(() => {
    if (!isDesktop) return;
    function onMove(e) {
      if (!draggingRef.current) return;
      const next = Math.min(maxWidth, Math.max(minWidth, e.clientX));
      onResizeWidth(next);
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDesktop, minWidth, maxWidth, onResizeWidth]);

  function startResize(e) {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const showLabels = isDesktop ? !collapsed : true;
  const effectiveWidth = isDesktop ? (collapsed ? collapsedWidth : width) : 272;

  const connectionMeta =
    connected === null
      ? { dot: "bg-theatre-faint", text: "Checking systems…" }
      : connected
      ? { dot: "bg-teal", text: "All systems connected" }
      : { dot: "bg-gold", text: "Connection issue — tap to retry" };

  return (
    <>
      {/* Backdrop — mobile only, closes the drawer on tap-outside. */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        style={{ width: effectiveWidth }}
        className={`fixed inset-y-0 left-0 z-40 flex h-screen shrink-0 flex-col border-r border-theatre-border bg-theatre-surface transition-transform duration-200 ease-out md:relative md:z-auto md:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2.5 px-5 py-6">
          <Film size={20} className="shrink-0 text-gold" strokeWidth={1.75} />
          {showLabels && (
            <span className="font-display text-lg tracking-tight text-theatre-text">Cinegraph</span>
          )}

          {/* Mobile close button */}
          <button
            onClick={onCloseMobile}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-theatre-muted transition-colors hover:text-theatre-text md:hidden"
            aria-label="Close menu"
          >
            <X size={18} strokeWidth={1.75} />
          </button>

          {/* Desktop collapse toggle */}
          <button
            onClick={onToggleCollapsed}
            className="ml-auto hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-theatre-muted transition-colors hover:text-theatre-text md:flex"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight size={16} strokeWidth={1.75} /> : <ChevronsLeft size={16} strokeWidth={1.75} />}
          </button>
        </div>

        <div className="sprocket-rule mx-5 mb-4" />

        <nav className="flex flex-1 flex-col gap-1 px-3">
          {links.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onCloseMobile}
              title={showLabels ? undefined : label}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors ${
                  showLabels ? "" : "justify-center"
                } ${
                  isActive
                    ? "bg-theatre-surface2 text-theatre-text"
                    : "text-theatre-muted hover:bg-theatre-surface2/60 hover:text-theatre-text"
                }`
              }
            >
              <Icon size={17} strokeWidth={1.75} className="shrink-0" />
              {showLabels && label}
            </NavLink>
          ))}
        </nav>

        <div className="px-3 pb-2">
          <a
            href="https://github.com/singla70/Movie-recommender"
            target="_blank"
            rel="noreferrer"
            title={showLabels ? undefined : "View source on GitHub"}
            className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-theatre-muted transition-colors hover:bg-theatre-surface2/60 hover:text-theatre-text ${
              showLabels ? "" : "justify-center"
            }`}
          >
            <Github size={17} strokeWidth={1.75} className="shrink-0" />
            {showLabels && "View source"}
          </a>
        </div>

        <button
          onClick={onRetryConnection}
          disabled={connected === null}
          title={connected === false ? "Retry connection" : undefined}
          className={`flex items-center gap-2 border-t border-theatre-border px-5 py-4 text-xs text-theatre-muted transition-colors ${
            connected === false ? "cursor-pointer hover:text-theatre-text" : "cursor-default"
          } ${showLabels ? "" : "justify-center"}`}
        >
          {connected === false ? (
            <RotateCw size={12} className="shrink-0" strokeWidth={2} />
          ) : (
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${connectionMeta.dot}`} />
          )}
          {showLabels && <span className="text-left">{connectionMeta.text}</span>}
        </button>

        {/* Resize handle — desktop only, hidden while collapsed */}
        {isDesktop && !collapsed && (
          <div
            onMouseDown={startResize}
            onDoubleClick={() => onResizeWidth(defaultWidth)}
            title="Drag to resize · double-click to reset"
            className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize"
          />
        )}
      </aside>
    </>
  );
}