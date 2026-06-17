import React from "react";

const ENV_OVERRIDE =
  String(import.meta.env.VITE_SHOW_RUN_DEBUG ?? "").toLowerCase() === "true";

const LS_KEY = "kery_developer_mode";

export function getDevMode(): boolean {
  return ENV_OVERRIDE || localStorage.getItem(LS_KEY) === "true";
}

export function setDevMode(enabled: boolean): void {
  localStorage.setItem(LS_KEY, String(enabled));
  window.dispatchEvent(new StorageEvent("storage", { key: LS_KEY, newValue: String(enabled) }));
}

export function useDevMode(): boolean {
  const [enabled, setEnabled] = React.useState(getDevMode);

  React.useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === LS_KEY || e.key === null) setEnabled(getDevMode());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return enabled;
}

// Kept for backwards compat — use useDevMode() in components that need reactivity
export const SHOW_RUN_DEBUG = ENV_OVERRIDE;
