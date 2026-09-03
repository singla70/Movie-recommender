import { useState, useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import Sidebar from "./components/Sidebar.jsx";
import Landing from "./pages/Landing.jsx";
import QueryMode from "./pages/QueryMode.jsx";
import AdminMode from "./pages/AdminMode.jsx";
import { api } from "./api.js";

function AppShell({ children, connected }) {
  return (
    <div className="flex h-screen bg-theatre-bg">
      <Sidebar connected={connected} />
      <div className="flex flex-1 flex-col overflow-hidden">{children}</div>
    </div>
  );
}

export default function App() {
  const [connected, setConnected] = useState(null);

  useEffect(() => {
    api
      .connections()
      .then((data) => setConnected(Boolean(data?.ok)))
      .catch(() => setConnected(false));
  }, []);

  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route
        path="/query"
        element={
          <AppShell connected={connected}>
            <QueryMode />
          </AppShell>
        }
      />
      <Route
        path="/admin"
        element={
          <AppShell connected={connected}>
            <AdminMode />
          </AppShell>
        }
      />
    </Routes>
  );
}
