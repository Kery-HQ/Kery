import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import "./styles/globals.css";

// Apply saved theme before first render to avoid flash
;(() => {
  const saved = localStorage.getItem("kery_theme") ?? "system";
  if (saved === "dark") {
    document.documentElement.classList.add("dark");
  } else if (saved === "system") {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches)
      document.documentElement.classList.add("dark");
  }
})();

import { Nav } from "./components/nav";
import { Overview } from "./pages/Overview";
import { Environments } from "./pages/Environments";
import { Runs } from "./pages/Runs";
import { TestsPlans } from "./pages/TestsPlans";
import { Memory } from "./pages/Memory";
import { Settings } from "./pages/Settings";
import { RunDetail } from "./pages/RunDetail";
import { Bugs } from "./pages/Bugs";
import { Pages } from "./pages/Pages";
import { PageDetail } from "./pages/PageDetail";
import { ProjectProvider } from "./lib/projectContext";

function AppShell() {
  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Nav />
      <main className="flex-1 flex flex-col overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ProjectProvider>
        <Routes>
          <Route path="/" element={<AppShell />}>
            <Route index element={<Navigate to="/overview" replace />} />
            <Route path="overview"      element={<Overview />} />
            <Route path="environments"  element={<Environments />} />
            <Route path="pages"         element={<Outlet />}>
              <Route index               element={<Pages />} />
              <Route path=":destinationId" element={<PageDetail />} />
            </Route>
            <Route path="discover"      element={<Navigate to="/pages" replace />} />
            <Route path="tree"          element={<Navigate to="/pages" replace />} />
            <Route path="tests"         element={<TestsPlans />} />
            <Route path="runs"          element={<Runs />} />
            <Route path="runs/:runId"   element={<RunDetail />} />
            <Route path="bugs"          element={<Bugs />} />
            <Route path="memory"        element={<Memory />} />
            <Route path="settings"      element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </ProjectProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
