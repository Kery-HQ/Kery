import { useEffect, useCallback } from "react";

export type Theme = "light" | "dark" | "system";
const STORAGE_KEY = "kery_theme";

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") {
    const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", isDark);
  } else {
    root.classList.toggle("dark", theme === "dark");
  }
}

export function getTheme(): Theme {
  return (localStorage.getItem(STORAGE_KEY) as Theme) || "dark";
}

export function setTheme(theme: Theme) {
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme(theme);
}

export function initTheme() {
  applyTheme(getTheme());
}

function applyWallpaper() {
  document.documentElement.style.setProperty("--app-wallpaper-image", "none");
  document.documentElement.style.setProperty("--app-wallpaper-blur-light", "6px");
  document.documentElement.style.setProperty("--app-wallpaper-blur-dark", "7px");
}

export function getWallpaperIndex(): number {
  return 0;
}

export function rotateWallpaper(): number {
  return 0;
}

export function initWallpaper() {
  applyWallpaper();
}

export function useHotkey(key: string, callback: () => void, deps: any[] = []) {
  const handler = useCallback(
    (e: KeyboardEvent) => {
      // Don't fire when typing in inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      if (key === "mod+k") {
        if ((e.metaKey || e.ctrlKey) && e.key === "k") {
          e.preventDefault();
          callback();
        }
        return;
      }

      if (e.key === key && !e.metaKey && !e.ctrlKey && !e.altKey) {
        callback();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, callback, ...deps],
  );

  useEffect(() => {
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handler]);
}
