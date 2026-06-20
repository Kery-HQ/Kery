/**
 * Docker browser networking helpers.
 *
 * Keep the page URL/origin exactly as the user configured it. Browser launch args
 * resolve localhost to the Docker host without changing the Host header, which
 * avoids origin and allowed-host failures in user apps.
 */

const IS_DOCKER = !!process.env.KERY_DOCKER;

export function rewriteForDocker(url: string): string {
  return url;
}

export function dockerHostResolverArgs(): string[] {
  return IS_DOCKER
    ? ["--host-resolver-rules=MAP localhost host.docker.internal, MAP 127.0.0.1 host.docker.internal"]
    : [];
}

export function dockerHostProbeUrl(url: string): { url: string; hostHeader?: string } | null {
  if (!IS_DOCKER || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return null;
    const originalHost = parsed.host;
    parsed.hostname = "host.docker.internal";
    return { url: parsed.toString(), hostHeader: originalHost };
  } catch {
    return null;
  }
}
