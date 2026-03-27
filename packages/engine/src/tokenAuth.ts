import type { Page } from "playwright";
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

export async function authenticateWithClerk(
  provider: TokenProviderConfig,
): Promise<{ sessionToken: string }> {
  const { apiUrl, apiKey, credentials } = provider;
  if (!credentials?.email || !credentials?.password) {
    throw new Error("Clerk auth requires credentials (email + password)");
  }

  // Step 1: Create a sign-in via Clerk Backend API
  const signInRes = await fetch(`${apiUrl.replace(/\/$/, "")}/v1/sign_ins`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      identifier: credentials.email,
      password: credentials.password,
    }),
  });

  if (!signInRes.ok) {
    const body = await signInRes.text().catch(() => "");
    throw new Error(`Clerk sign_in failed (${signInRes.status}): ${body.slice(0, 300)}`);
  }

  const signInData = await signInRes.json();
  const sessionId = signInData?.response?.created_session_id;
  if (!sessionId) {
    throw new Error("Clerk sign_in did not return a session ID");
  }

  // Step 2: Get a session token (JWT)
  const tokenRes = await fetch(
    `${apiUrl.replace(/\/$/, "")}/v1/sessions/${sessionId}/tokens`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  );

  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => "");
    throw new Error(`Clerk session token failed (${tokenRes.status}): ${body.slice(0, 300)}`);
  }

  const tokenData = await tokenRes.json();
  const jwt = tokenData?.jwt;
  if (!jwt) {
    throw new Error("Clerk token response did not contain a JWT");
  }

  return { sessionToken: jwt };
}

export async function injectClerkSession(
  page: Page,
  sessionToken: string,
  domain: string,
): Promise<void> {
  // Clerk uses a __session cookie
  await page.context().addCookies([
    {
      name: "__session",
      value: sessionToken,
      domain: domain.startsWith(".") ? domain : `.${domain}`,
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  logger.info({ domain }, "Clerk session cookie injected");
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
      const { sessionToken } = await authenticateWithClerk(provider);
      await injectClerkSession(page, sessionToken, domain);
      // Clerk JWTs expire in ~60s by default
      activeSessions.set(page, {
        provider, baseUrl, domain,
        expiresAt: Math.floor(Date.now() / 1000) + 60,
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
  // Re-authenticate entirely — Clerk Backend API doesn't have a refresh flow
  const { sessionToken } = await authenticateWithClerk(session.provider);
  await injectClerkSession(page, sessionToken, session.domain);
  session.expiresAt = Math.floor(Date.now() / 1000) + 60;
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
