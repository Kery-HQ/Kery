import { API_BASE } from "@/api";

/**
 * Resolve a media URL for `<img src>` and similar.
 *
 * In Vite dev, the SPA is usually on one port (e.g. 11113) and `/api` is **proxied** to the API.
 * Prefixing `API_BASE` (e.g. `http://localhost:11112`) bypasses the proxy, so images 404 or fail
 * while the same path works at `http://localhost:11113/api/...`. Use same-origin `/api/...` in dev.
 *
 * When `VITE_API_BASE_URL` is set (e.g. split API host in prod), use it for `/api` media.
 */
export function apiMediaUrl(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) return pathOrUrl;
  if (pathOrUrl.startsWith("/api/")) {
    if (typeof window !== "undefined" && import.meta.env.DEV) {
      return pathOrUrl;
    }
    const envBase = import.meta.env.VITE_API_BASE_URL;
    if (envBase != null && String(envBase).trim() !== "") {
      return `${String(envBase).replace(/\/$/, "")}${pathOrUrl}`;
    }
    if (typeof window !== "undefined") {
      return pathOrUrl;
    }
    return `${API_BASE}${pathOrUrl}`;
  }
  return pathOrUrl;
}

/**
 * Value may be a stored API path (`/api/bugs/...`), absolute URL, `data:...`, or raw base64 (JPEG).
 */
export function screenshotRefToSrc(ref: string | undefined | null): string | undefined {
  if (ref == null || ref === "") return undefined;
  if (ref.startsWith("http://") || ref.startsWith("https://") || ref.startsWith("data:")) return ref;
  if (ref.startsWith("/api/")) return apiMediaUrl(ref);
  return `data:image/jpeg;base64,${ref}`;
}

/** File under SCREENSHOTS_DIR/<runId>/ (e.g. bug-0.jpg, llm-3.jpg). */
export function runScreenshotFileUrl(runId: string, filename: string | undefined | null): string | undefined {
  if (filename == null || filename === "") return undefined;
  const safe = filename.replace(/^.*[/\\]/, "").trim();
  if (!safe) return undefined;
  return apiMediaUrl(`/api/bugs/${runId}/${safe}`);
}
