import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KeryClient } from "@kery/client";

const exec = promisify(execFile);

/**
 * Start Kery Docker containers.
 * Looks for docker-compose.yml in standard locations, or uses the bundled image.
 */
export async function startDocker(): Promise<void> {
  try {
    await exec("docker", ["compose", "up", "-d"], { timeout: 60_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to start Kery Docker containers. ` +
      `Make sure Docker is installed and running.\n${msg}`,
    );
  }
}

/** Stop Kery Docker containers. */
export async function stopDocker(): Promise<void> {
  try {
    await exec("docker", ["compose", "down"], { timeout: 30_000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to stop Kery Docker containers.\n${msg}`);
  }
}

/**
 * Wait for the Kery API to become healthy.
 * Polls /health every 2 seconds up to `timeoutMs`.
 */
export async function waitForHealthy(
  client: KeryClient,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await client.checkHealth()) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}
