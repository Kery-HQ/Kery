import type { Page } from "playwright";
import { createHmac } from "crypto";
import { clerk } from "@clerk/testing/playwright";
import { logger } from "./logger.js";

type TokenProviderConfig = {
  type: "supabase" | "clerk" | "custom";
  apiUrl: string;
  apiKey: string;
  credentials?: { email: string; password: string };
  appDomain?: string;
  refreshToken?: string;
};

// ─── Clerk ──────────────────────────────────────────────────────────────────

/**
 * Sign in to a Clerk-protected app using the official @clerk/testing SDK.
 *
 * Uses clerk.signIn() with the emailAddress parameter, which internally handles:
 * - Testing token fetch & injection (bypasses bot detection)
 * - Dev browser initialization (required for development instances)
 * - Full sign-in flow via the Clerk JS SDK running in the browser
 *
 * Requires the page to navigate to the app first so the Clerk JS SDK is loaded.
 */
export async function authenticateWithClerk(
  page: Page,
  provider: TokenProviderConfig,
  baseUrl: string,
): Promise<void> {
  const { apiKey, apiUrl, credentials } = provider;
  if (!credentials?.email) {
    throw new Error("Clerk auth requires credentials.email");
  }

  // clerk.signIn() reads the secret key from this env var
  process.env.CLERK_SECRET_KEY = apiKey;

  // frontendApiUrl must be the host only, without protocol
  const frontendApiUrl = new URL(apiUrl).host;

  // Navigate to the app first — clerk.signIn() needs the Clerk JS SDK to be loaded on the page
  logger.info({ baseUrl }, "Clerk: navigating to app to load Clerk JS SDK");
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  logger.info({ email: credentials.email, frontendApiUrl }, "Clerk: signing in via @clerk/testing");
  await clerk.signIn({
    page,
    emailAddress: credentials.email,
    setupClerkTestingTokenOptions: { frontendApiUrl },
  });

  logger.info("Clerk: sign-in complete");
}

// ─── Supabase ───────────────────────────────────────────────────────────────

export type SupabaseTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

export async function authenticateWithSupabase(
  provider: TokenProviderConfig,
): Promise<SupabaseTokens> {
  const { apiUrl, apiKey, credentials } = provider;
  if (!credentials?.email || !credentials?.password) {
    throw new Error("Supabase auth requires credentials (email + password)");
  }

  const res = await fetch(
    `${apiUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase auth failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Supabase auth response missing access_token");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
  };
}

export async function injectSupabaseSession(
  page: Page,
  tokens: SupabaseTokens,
  apiUrl: string,
  baseUrl: string,
): Promise<void> {
  // Extract project ref from Supabase URL (e.g. "xyz" from "https://xyz.supabase.co")
  const projectRef = new URL(apiUrl).hostname.split(".")[0];
  const storageKey = `sb-${projectRef}-auth-token`;

  const tokenPayload = JSON.stringify({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: tokens.expiresAt,
    token_type: "bearer",
    expires_in: tokens.expiresAt - Math.floor(Date.now() / 1000),
  });

  // localStorage requires same-origin — navigate to the app first
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate(
    ({ key, value }) => { localStorage.setItem(key, value); },
    { key: storageKey, value: tokenPayload },
  );
  // Reload so the Supabase client picks up the token
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

  logger.info({ projectRef }, "Supabase session injected into localStorage");
}

// ─── OAuth 2.0 Pre-obtained Token ────────────────────────────────────────────

export type OAuthTokenConfig = {
  accessToken: string;
  /** How to inject: "cookie" sets a cookie, "localStorage" puts it in localStorage, "header" uses route interception */
  injection?: "cookie" | "localStorage" | "header";
  /** Cookie/localStorage key name. Default: "access_token" */
  keyName?: string;
  /** Header prefix for header injection. Default: "Bearer" */
  headerPrefix?: string;
};

/**
 * Inject a pre-obtained OAuth access token into the page session.
 * Supports cookie, localStorage, or header injection modes.
 */
export async function injectOAuthToken(
  page: Page,
  config: OAuthTokenConfig,
  baseUrl: string,
): Promise<void> {
  const mode = config.injection ?? "cookie";
  const keyName = config.keyName ?? "access_token";
  const domain = new URL(baseUrl).hostname;

  if (mode === "cookie") {
    await page.context().addCookies([
      {
        name: keyName,
        value: config.accessToken,
        domain: domain.startsWith(".") ? domain : `.${domain}`,
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    logger.info({ domain, keyName }, "OAuth token injected as cookie");
  } else if (mode === "localStorage") {
    // localStorage requires same-origin — navigate first
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      ({ key, value }) => { localStorage.setItem(key, value); },
      { key: keyName, value: config.accessToken },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    logger.info({ keyName }, "OAuth token injected into localStorage");
  } else if (mode === "header") {
    const prefix = config.headerPrefix ?? "Bearer";
    await page.route("**/*", (route) => {
      const headers = { ...route.request().headers(), Authorization: `${prefix} ${config.accessToken}` };
      route.continue({ headers });
    });
    logger.info("OAuth token injected via header interception");
  }
}

// ─── Token session state (tracks expiry for refresh) ─────────────────────────

export type TokenSession = {
  provider: TokenProviderConfig;
  baseUrl: string;
  domain: string;
  expiresAt: number; // Unix seconds
  clerkSessionId?: string;
  supabaseTokens?: SupabaseTokens;
};

const REFRESH_BUFFER_SECS = 60;

// Per-run token session — keyed by page (runAgent creates one page per run)
const activeSessions = new WeakMap<Page, TokenSession>();

export function getTokenSession(page: Page): TokenSession | undefined {
  return activeSessions.get(page);
}

// ─── Unified handler ────────────────────────────────────────────────────────

export async function handleTokenAuth(
  page: Page,
  provider: TokenProviderConfig,
  baseUrl: string,
): Promise<boolean> {
  const domain = provider.appDomain || new URL(baseUrl).hostname;

  try {
    if (provider.type === "clerk") {
      await authenticateWithClerk(page, provider, baseUrl);
      // Clerk browser sessions are long-lived; set a generous expiry
      activeSessions.set(page, {
        provider, baseUrl, domain,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    } else if (provider.type === "supabase") {
      const tokens = await authenticateWithSupabase(provider);
      await injectSupabaseSession(page, tokens, provider.apiUrl, baseUrl);
      activeSessions.set(page, {
        provider, baseUrl, domain,
        expiresAt: tokens.expiresAt,
        supabaseTokens: tokens,
      });
    } else {
      logger.warn({ type: provider.type }, "Unsupported token provider type");
      return false;
    }
    logger.info({ provider: provider.type }, "Token auth complete");
    return true;
  } catch (err) {
    logger.error({ err: String(err).slice(0, 300), provider: provider.type }, "Token auth failed");
    return false;
  }
}

// ─── Token refresh ──────────────────────────────────────────────────────────

async function refreshClerkToken(session: TokenSession, page: Page): Promise<void> {
  await authenticateWithClerk(page, session.provider, session.baseUrl);
  session.expiresAt = Math.floor(Date.now() / 1000) + 3600;
  logger.info("Clerk token refreshed");
}

async function refreshSupabaseToken(session: TokenSession, page: Page): Promise<void> {
  const { provider } = session;
  const refreshToken = session.supabaseTokens?.refreshToken || provider.refreshToken;
  if (!refreshToken) {
    // No refresh token — re-authenticate from scratch
    const tokens = await authenticateWithSupabase(provider);
    await injectSupabaseSession(page, tokens, provider.apiUrl, session.baseUrl);
    session.supabaseTokens = tokens;
    session.expiresAt = tokens.expiresAt;
    return;
  }

  const res = await fetch(
    `${provider.apiUrl.replace(/\/$/, "")}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        apikey: provider.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );

  if (!res.ok) {
    logger.warn({ status: res.status }, "Supabase refresh failed, re-authenticating");
    const tokens = await authenticateWithSupabase(provider);
    await injectSupabaseSession(page, tokens, provider.apiUrl, session.baseUrl);
    session.supabaseTokens = tokens;
    session.expiresAt = tokens.expiresAt;
    return;
  }

  const data = await res.json();
  const tokens: SupabaseTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
  };
  await injectSupabaseSession(page, tokens, provider.apiUrl, session.baseUrl);
  session.supabaseTokens = tokens;
  session.expiresAt = tokens.expiresAt;
  logger.info("Supabase token refreshed");
}

/**
 * Check if the current token session needs refreshing and refresh if so.
 * Call this before each Navigator step during long-running tests.
 */
export async function refreshIfNeeded(page: Page): Promise<void> {
  const session = activeSessions.get(page);
  if (!session) return; // Not a token-auth run

  const now = Math.floor(Date.now() / 1000);
  if (now < session.expiresAt - REFRESH_BUFFER_SECS) return; // Still valid

  logger.info({ provider: session.provider.type, expiresAt: session.expiresAt }, "Token expiring soon, refreshing");

  try {
    if (session.provider.type === "clerk") {
      await refreshClerkToken(session, page);
    } else if (session.provider.type === "supabase") {
      await refreshSupabaseToken(session, page);
    }
  } catch (err) {
    logger.error({ err: String(err).slice(0, 300) }, "Token refresh failed");
  }
}

// ─── 2FA / MFA Support ──────────────────────────────────────────────────────

const TWO_FA_INDICATORS = [
  "verification code",
  "authenticator",
  "2fa",
  "two-factor",
  "two factor",
  "mfa",
  "one-time",
  "one time password",
  "otp",
  "6-digit code",
  "enter code",
  "security code",
];

/**
 * Detect if the current page is a 2FA/MFA challenge screen.
 */
export async function detect2FAScreen(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.evaluate(() =>
      document.body?.innerText?.toLowerCase().slice(0, 3000) ?? ""
    );
    return TWO_FA_INDICATORS.some(indicator => bodyText.includes(indicator));
  } catch {
    return false;
  }
}

/**
 * Generate a TOTP code from a base32-encoded secret.
 * Uses HMAC-SHA1 with a 30-second time step (RFC 6238).
 */
export function generateTOTP(base32Secret: string, timeStep = 30): string {
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / timeStep);

  // Decode base32 secret
  const secretBytes = base32Decode(base32Secret);

  // Counter as 8-byte big-endian buffer
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  // HMAC-SHA1
  const hmac = createHmac("sha1", secretBytes);
  hmac.update(counterBuf);
  const hash = hmac.digest();

  // Dynamic truncation
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  return String(code % 1000000).padStart(6, "0");
}

/**
 * Handle 2FA challenge: detect the screen, generate TOTP, and fill the code.
 * Returns true if 2FA was handled, false if not detected or no secret provided.
 */
export async function handle2FA(page: Page, totpSecret?: string): Promise<boolean> {
  if (!totpSecret) return false;

  const is2FA = await detect2FAScreen(page);
  if (!is2FA) return false;

  const code = generateTOTP(totpSecret);
  logger.info("2FA screen detected, entering TOTP code");

  try {
    // Try common selectors for OTP input fields
    const otpInput = page.locator(
      'input[type="text"][autocomplete*="one-time"], input[name*="otp"], input[name*="code"], input[name*="totp"], input[placeholder*="code"], input[aria-label*="code"]'
    ).first();

    if (await otpInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await otpInput.fill(code);
      // Try to submit
      const submitBtn = page.locator('button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue")').first();
      if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await submitBtn.click();
      }
      logger.info("2FA code submitted");
      return true;
    }
  } catch (err) {
    logger.warn({ err: String(err).slice(0, 200) }, "Failed to auto-fill 2FA code");
  }

  return false;
}

// ─── Base32 Decode ──────────────────────────────────────────────────────────

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s=-]+/g, "").toUpperCase();
  let bits = "";
  for (const char of cleaned) {
    const val = BASE32_CHARS.indexOf(char);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}
