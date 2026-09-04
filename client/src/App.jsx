import { useState, useEffect, useCallback } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { Menu } from "lucide-react";
import Sidebar from "./components/Sidebar.jsx";
import Landing from "./pages/Landing.jsx";
import QueryMode from "./pages/QueryMode.jsx";
import AdminMode from "./pages/AdminMode.jsx";
import { api } from "./api.js";

const SIDEBAR_WIDTH_KEY = "cinegraph:sidebarWidth";
const SIDEBAR_COLLAPSED_KEY = "cinegraph:sidebarCollapsed";
const DEFAULT_WIDTH = 240;
const MIN_WIDTH = 200;
const MAX_WIDTH = 340;
const COLLAPSED_WIDTH = 68;

function readStoredWidth() {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return saved >= MIN_WIDTH && saved <= MAX_WIDTH ? saved : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function readStoredCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

// Wraps the app pages that need the persistent sidebar + a mobile
// topbar. Sidebar width/collapse state lives here (not inside
// Sidebar itself) so it survives Sidebar re-mounting and can be
// persisted to localStorage in one place.
function AppShell({ children, connected, onRetryConnection }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readStoredCollapsed);
  const [width, setWidth] = useState(readStoredWidth);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // localStorage unavailable (private mode etc) — collapse state just won't persist.
    }
  }, [collapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch {
      // same as above — non-fatal.
    }
  }, [width]);

  // Lock page scroll + let Escape close the drawer while it's open on mobile.
  useEffect(() => {
    if (!mobileOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => e.key === "Escape" && setMobileOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [mobileOpen]);

  return (
    <div className="flex h-screen overflow-hidden bg-theatre-bg">
      <Sidebar
        connected={connected}
        onRetryConnection={onRetryConnection}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
        width={width}
        defaultWidth={DEFAULT_WIDTH}
        minWidth={MIN_WIDTH}
        maxWidth={MAX_WIDTH}
        collapsedWidth={COLLAPSED_WIDTH}
        onResizeWidth={setWidth}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile-only topbar: the sidebar is an off-canvas drawer below
            the md breakpoint, so this hamburger is the only way in. */}
        <div className="flex items-center gap-3 border-b border-theatre-border px-4 py-3 md:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-theatre-border text-theatre-muted transition-colors hover:border-gold/40 hover:text-theatre-text"
            aria-label="Open menu"
          >
            <Menu size={18} strokeWidth={1.75} />
          </button>
          <span className="font-display text-base tracking-tight text-theatre-text">Cinegraph</span>
        </div>

        <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

export default function App() {
  const [connected, setConnected] = useState(null);

  const checkConnection = useCallback(() => {
    setConnected(null);
    api
      .connections()
      .then((data) => setConnected(Boolean(data?.ok)))
      .catch(() => setConnected(false));
  }, []);

  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/query"
        element={
          <AppShell connected={connected} onRetryConnection={checkConnection}>
            <QueryMode connected={connected} />
          </AppShell>
        }
      />
      <Route
        path="/admin"
        element={
          <AppShell connected={connected} onRetryConnection={checkConnection}>
            <AdminMode connected={connected} />
          </AppShell>
        }
      />
      {/* Unknown paths were previously a blank page — send them home instead. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}