import * as http from "http";
import * as https from "https";
import { dockerHostProbeUrl } from "./dockerHost.js";
import { serializeError } from "./logger.js";

export type ConnectionAuditStatus = "ok" | "warning" | "failed";
export type ConnectionAuditCheckStatus = "passed" | "warning" | "failed" | "skipped";

export type ConnectionAuditCheck = {
  name: string;
  status: ConnectionAuditCheckStatus;
  message: string;
  details?: Record<string, unknown>;
};

export type ConnectionAuditProbe = {
  url: string;
  hostHeader?: string;
  durationMs: number;
  statusCode?: number;
  location?: string;
  responseSnippet?: string;
  error?: Record<string, unknown>;
};

export type ConnectionAuditResult = {
  status: ConnectionAuditStatus;
  summary: string;
  targetUrl: string;
  runtime: "docker" | "local";
  checkedAt: string;
  checks: ConnectionAuditCheck[];
  observations: string[];
  recommendations: string[];
  probe?: ConnectionAuditProbe;
};

export type ConnectionAuditOptions = {
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_SNIPPET_BYTES = 2_000;

function isDockerRuntime(): boolean {
  return Boolean(process.env.KERY_DOCKER);
}

function makeTimeoutError(timeoutMs: number): Error & { code?: string } {
  const err = new Error(`Connection probe timed out after ${timeoutMs}ms`) as Error & { code?: string };
  err.code = "ETIMEDOUT";
  return err;
}

async function probeHttpUrl(
  url: string,
  hostHeader: string | undefined,
  timeoutMs: number,
): Promise<Omit<ConnectionAuditProbe, "url" | "hostHeader" | "durationMs">> {
  const parsed = new URL(url);
  const transport = parsed.protocol === "https:" ? https : http;
  const headers: Record<string, string> = { "User-Agent": "Kery connection audit" };
  if (hostHeader) headers.Host = hostHeader;

  const options: http.RequestOptions & { servername?: string } = {
    method: "GET",
    timeout: timeoutMs,
    headers,
  };
  if (parsed.protocol === "https:" && hostHeader) {
    options.servername = hostHeader.split(":")[0];
  }

  return await new Promise((resolve, reject) => {
    const req = transport.request(parsed, options, (res) => {
      const location = Array.isArray(res.headers.location)
        ? res.headers.location[0]
        : res.headers.location;
      const chunks: Buffer[] = [];
      let collected = 0;

      res.on("data", (chunk: Buffer | string) => {
        if (collected >= MAX_RESPONSE_SNIPPET_BYTES) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = MAX_RESPONSE_SNIPPET_BYTES - collected;
        const slice = buf.subarray(0, remaining);
        chunks.push(slice);
        collected += slice.length;
      });
      res.once("end", () => {
        const responseSnippet = Buffer.concat(chunks).toString("utf8").replace(/\s+/g, " ").trim();
        resolve({
          statusCode: res.statusCode,
          location,
          responseSnippet: responseSnippet || undefined,
        });
      });
    });
    req.once("timeout", () => req.destroy(makeTimeoutError(timeoutMs)));
    req.once("error", reject);
    req.end();
  });
}

function looksLikeHostRejection(statusCode: number | undefined, responseSnippet: string | undefined): boolean {
  if (!statusCode || statusCode < 400 || statusCode >= 500 || !responseSnippet) return false;
  return /invalid host header|host .*not allowed|not allowed host|allowed hosts?|blocked request|origin .*not allowed|not allowed origin/i
    .test(responseSnippet);
}

function statusFromHttpCode(statusCode: number | undefined): ConnectionAuditStatus {
  if (!statusCode) return "warning";
  if (statusCode >= 500) return "warning";
  if (statusCode >= 400) return "warning";
  return "ok";
}

function classifyHttpResponse(
  targetUrl: string,
  probeUrl: string,
  hostHeader: string | undefined,
  durationMs: number,
  result: Awaited<ReturnType<typeof probeHttpUrl>>,
): ConnectionAuditResult {
  const statusCode = result.statusCode;
  const hostRejected = looksLikeHostRejection(statusCode, result.responseSnippet);
  const status = hostRejected ? "failed" : statusFromHttpCode(statusCode);
  const checks: ConnectionAuditCheck[] = [
    { name: "URL format", status: "passed", message: "The base URL is valid." },
    {
      name: "HTTP probe",
      status: status === "failed" ? "failed" : status === "warning" ? "warning" : "passed",
      message: statusCode ? `Received HTTP ${statusCode}.` : "Received a response without an HTTP status code.",
      details: { probeUrl, hostHeader, statusCode, location: result.location },
    },
  ];

  const observations: string[] = [];
  if (statusCode) observations.push(`HTTP ${statusCode} from ${targetUrl}.`);
  if (result.location) observations.push(`Redirect location: ${result.location}.`);
  if (hostHeader) observations.push(`Preserved Host header: ${hostHeader}.`);

  const recommendations: string[] = [];
  let summary = `Kery can reach ${targetUrl}.`;

  if (hostRejected) {
    summary = `Kery reached ${targetUrl}, but the application rejected the request host or origin.`;
    recommendations.push("Allow the configured host/origin in the application or identity-provider settings, then run the check again.");
  } else if (statusCode && statusCode >= 500) {
    summary = `Kery reached ${targetUrl}, but the application returned HTTP ${statusCode}.`;
    recommendations.push("Check the application server logs for the request that matches this check.");
  } else if (statusCode && statusCode >= 400) {
    summary = `Kery reached ${targetUrl}, and the application returned HTTP ${statusCode}.`;
    recommendations.push("If this URL is protected, continue with the appropriate credential setup.");
  } else if (statusCode && statusCode >= 300) {
    summary = `Kery reached ${targetUrl}, and the application redirected the request.`;
  }

  return {
    status,
    summary,
    targetUrl,
    runtime: isDockerRuntime() ? "docker" : "local",
    checkedAt: new Date().toISOString(),
    checks,
    observations,
    recommendations,
    probe: {
      url: probeUrl,
      hostHeader,
      durationMs,
      statusCode,
      location: result.location,
      responseSnippet: hostRejected ? result.responseSnippet : undefined,
    },
  };
}

function classifyProbeError(
  targetUrl: string,
  probeUrl: string,
  hostHeader: string | undefined,
  durationMs: number,
  err: unknown,
): ConnectionAuditResult {
  const serialized = serializeError(err);
  const code = typeof serialized.code === "string" ? serialized.code : undefined;
  const message = typeof serialized.message === "string" ? serialized.message : String(err);
  const recommendations: string[] = [];
  const observations = [
    `Probe failed before receiving an HTTP response.`,
    code ? `Error code: ${code}.` : `Error: ${message}.`,
  ];

  let summary = `Kery could not reach ${targetUrl}.`;
  let checkMessage = message;

  if (code === "ECONNREFUSED") {
    summary = `Kery could not open a TCP connection to ${targetUrl}.`;
    checkMessage = "The configured host and port refused the connection.";
    recommendations.push("Confirm the application is running at the configured host and port.");
    if (isDockerRuntime()) {
      recommendations.push("If the application runs on the host machine, make sure it listens on an address reachable from Docker.");
    }
  } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    summary = `Kery could not resolve the hostname for ${targetUrl}.`;
    checkMessage = "DNS resolution failed for the configured hostname.";
    recommendations.push("Check the hostname in the environment URL.");
  } else if (code === "ETIMEDOUT" || /timed out/i.test(message)) {
    summary = `Kery timed out while connecting to ${targetUrl}.`;
    checkMessage = "The connection attempt timed out.";
    recommendations.push("Confirm the application is reachable from the Kery runtime and is responding promptly.");
  } else if (
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    code === "CERT_HAS_EXPIRED"
  ) {
    summary = `Kery reached ${targetUrl}, but TLS verification failed.`;
    checkMessage = "The HTTPS certificate was rejected.";
    recommendations.push("Use a trusted certificate for this environment, or use an HTTP local URL if appropriate.");
  } else if (code === "ECONNRESET") {
    summary = `The connection to ${targetUrl} was reset before Kery received a response.`;
    recommendations.push("Check the application server logs for connection resets during this check.");
  } else if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    summary = `Kery could not route traffic to ${targetUrl}.`;
    recommendations.push("Check that the host is reachable from the Kery runtime.");
  } else {
    recommendations.push("Check the configured environment URL and application server logs.");
  }

  return {
    status: "failed",
    summary,
    targetUrl,
    runtime: isDockerRuntime() ? "docker" : "local",
    checkedAt: new Date().toISOString(),
    checks: [
      { name: "URL format", status: "passed", message: "The base URL is valid." },
      {
        name: "HTTP probe",
        status: "failed",
        message: checkMessage,
        details: { probeUrl, hostHeader, code },
      },
    ],
    observations,
    recommendations,
    probe: {
      url: probeUrl,
      hostHeader,
      durationMs,
      error: serialized,
    },
  };
}

export async function auditConnection(
  baseUrl: string,
  options: ConnectionAuditOptions = {},
): Promise<ConnectionAuditResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (err) {
    return {
      status: "failed",
      summary: "The environment base URL is not a valid URL.",
      targetUrl: baseUrl,
      runtime: isDockerRuntime() ? "docker" : "local",
      checkedAt: new Date().toISOString(),
      checks: [{
        name: "URL format",
        status: "failed",
        message: err instanceof Error ? err.message : String(err),
      }],
      observations: [],
      recommendations: ["Use a full URL including scheme, host, and port when needed."],
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      status: "failed",
      summary: "Kery can only test HTTP and HTTPS environment URLs.",
      targetUrl: baseUrl,
      runtime: isDockerRuntime() ? "docker" : "local",
      checkedAt: new Date().toISOString(),
      checks: [
        { name: "URL format", status: "passed", message: "The base URL is valid." },
        {
          name: "Protocol",
          status: "failed",
          message: `Unsupported protocol: ${parsed.protocol}`,
        },
      ],
      observations: [],
      recommendations: ["Use an HTTP or HTTPS URL for this environment."],
    };
  }

  let probeUrl = parsed.toString();
  let hostHeader: string | undefined;
  const dockerProbe = dockerHostProbeUrl(probeUrl);
  if (dockerProbe) {
    probeUrl = dockerProbe.url;
    hostHeader = dockerProbe.hostHeader;
  }

  const started = Date.now();
  try {
    const probeResult = await probeHttpUrl(probeUrl, hostHeader, timeoutMs);
    return classifyHttpResponse(baseUrl, probeUrl, hostHeader, Date.now() - started, probeResult);
  } catch (err) {
    return classifyProbeError(baseUrl, probeUrl, hostHeader, Date.now() - started, err);
  }
}
