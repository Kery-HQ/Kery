import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";
import "./styles/globals.css";

// Apply saved theme before first render to avoid flash
import { initTheme, initWallpaper } from "@/lib/hooks";
initTheme();
initWallpaper();

import { Nav } from "@/components/nav";
import { CommandPalette } from "@/components/command-palette";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fetchApiKeySettings } from "@/projectApi";
import { Warning } from "@phosphor-icons/react";
import { useNavigate, useLocation } from "react-router-dom";
import { Overview } from "@/pages/Overview";
import { Environments } from "@/pages/Environments";
import { Runs } from "@/pages/Runs";
import { TestsPlans } from "@/pages/TestsPlans";
import { Memory } from "@/pages/Memory";
import { Settings } from "@/pages/Settings";
import { ProjectSettings } from "@/pages/ProjectSettings";
import { RunDetail } from "@/pages/RunDetail";
import { Bugs } from "@/pages/Bugs";
import { FlowDetail } from "@/pages/FlowDetail";
import { ProjectProvider } from "@/lib/projectContext";
import { WelcomeModal } from "@/components/welcome-modal";
import { useHotkey } from "@/lib/hooks";

function NoKeysBanner() {
  const navigate = useNavigate();
  const location = useLocation();
  const isSettingsPage = location.pathname === "/settings";

  if (isSettingsPage) return null;

  return (
    <div className="shrink-0 flex items-center gap-2.5 px-4 py-2.5 bg-status-warn/10 border-b border-status-warn/25 text-[12px] text-status-warn">
      <Warning className="h-3.5 w-3.5 shrink-0" weight="fill" />
      <span className="flex-1">No API keys configured — tests cannot run until at least one provider key is added.</span>
      <button
        type="button"
        onClick={() => navigate("/settings")}
        className="shrink-0 font-medium underline underline-offset-2 hover:opacity-75 transition-opacity"
      >
        Configure keys
      </button>
    </div>
  );
}

function AppShell() {
  const [cmdkOpen, setCmdkOpen] = React.useState(false);
  const [hasAnyKey, setHasAnyKey] = React.useState<boolean | null>(null);

  useHotkey("mod+k", () => setCmdkOpen(true));

  React.useEffect(() => {
    fetchApiKeySettings()
      .then((r) => {
        const any = Object.values(r).some((info) => info.hasKey);
        setHasAnyKey(any);
      })
      .catch(() => setHasAnyKey(null));
  }, []);

  return (
    <div className="flex h-screen overflow-hidden">
      <Nav onOpenCommandPalette={() => setCmdkOpen(true)} />
      <main className="flex-1 flex flex-col min-h-0 overflow-y-auto bg-transparent">
        {hasAnyKey === false && <NoKeysBanner />}
        <Outlet />
      </main>
      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} />
      <WelcomeModal />
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <TooltipProvider delayDuration={300}>
        <ProjectProvider>
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<Navigate to="/overview" replace />} />
              <Route path="overview" element={<Overview />} />
              <Route path="environments" element={<Environments />} />
              <Route path="tests" element={<Outlet />}>
                <Route index element={<TestsPlans />} />
                <Route path=":testId" element={<FlowDetail />} />
              </Route>
              <Route path="tests" element={<TestsPlans />} />
              <Route path="runs" element={<Runs />} />
              <Route path="runs/:runId" element={<RunDetail />} />
              <Route path="bugs" element={<Bugs />} />
              <Route path="memory" element={<Memory />} />
              <Route path="settings" element={<Settings />} />
              <Route path="project-settings" element={<ProjectSettings />} />
            </Route>
            <Route path="*" element={<Navigate to="/overview" replace />} />
          </Routes>
          <Toaster />
        </ProjectProvider>
      </TooltipProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
