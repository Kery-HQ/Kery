/**
 * Rewrites localhost URLs to host.docker.internal when running inside Docker,
 * so the browser can reach apps on the host machine.
 */

const IS_DOCKER = !!process.env.KERY_DOCKER;

export function rewriteForDocker(url: string): string {
  if (!IS_DOCKER || !url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      parsed.hostname = "host.docker.internal";
      return parsed.toString().replace(/\/$/, "");
    }
  } catch {
    // not a valid URL, return as-is
  }
  return url;
}
