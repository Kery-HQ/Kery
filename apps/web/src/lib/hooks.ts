import { useEffect, useCallback } from "react";

export type Theme = "light" | "dark" | "system";
const STORAGE_KEY = "kery_theme";
const WALLPAPER_STORAGE_KEY = "kery_wallpaper_index";

const WALLPAPERS = [
  null,
  "/wallpaper/kery_wallpaper_2.jpeg",
  "/wallpaper/kery_wallpaper_3.jpeg",
  "/wallpaper/kery_wallpaper_4.jpeg",
  "/wallpaper/run_details_wallpaper.png",
] as const;

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

function applyWallpaper(path: (typeof WALLPAPERS)[number]) {
  if (!path) {
    document.documentElement.style.setProperty("--app-wallpaper-image", "none");
    document.documentElement.style.setProperty("--app-wallpaper-blur-light", "6px");
    document.documentElement.style.setProperty("--app-wallpaper-blur-dark", "7px");
    return;
  }
  document.documentElement.style.setProperty("--app-wallpaper-image", `url("${path}")`);
  document.documentElement.style.setProperty("--app-wallpaper-blur-light", "2px");
  document.documentElement.style.setProperty("--app-wallpaper-blur-dark", "3px");
}

export function getWallpaperIndex(): number {
  const raw = localStorage.getItem(WALLPAPER_STORAGE_KEY);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  if (!Number.isFinite(parsed)) return 0;
  return ((parsed % WALLPAPERS.length) + WALLPAPERS.length) % WALLPAPERS.length;
}

export function rotateWallpaper(): number {
  const next = (getWallpaperIndex() + 1) % WALLPAPERS.length;
  localStorage.setItem(WALLPAPER_STORAGE_KEY, String(next));
  applyWallpaper(WALLPAPERS[next]);
  return next;
}

export function initWallpaper() {
  applyWallpaper(WALLPAPERS[getWallpaperIndex()]);
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
