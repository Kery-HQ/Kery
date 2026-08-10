/**
 * Email OTP / magic-link login support.
 *
 * The test account's email address is an API-readable inbox (testmail.app or a
 * custom endpoint). When login lands on a "check your email" screen, we poll
 * the inbox for a message that arrived after the login attempt started, then
 * either type the extracted code or open the magic link — in the SAME browser
 * context, because magic links are frequently bound to the requesting session.
 */
import type { Page } from "playwright";
import type { EmailOtpConfig } from "./types.js";
import { logger } from "./logger.js";

export type InboxMessage = {
  subject: string;
  text: string;
  html: string;
  /** Unix ms when the message arrived. */
  timestamp: number;
};

// ─── Inbox adapters ──────────────────────────────────────────────────────────

/**
 * testmail.app JSON API. `livequery=true` long-polls: the request blocks until
 * a matching email arrives (auto-continuing via 307 self-redirects, which
 * fetch follows), so we bound each call with our own abort timeout.
 */
async function fetchTestmail(
  cfg: NonNullable<EmailOtpConfig["testmail"]>,
  sinceMs: number,
  waitMs: number,
): Promise<InboxMessage | null> {
  const url = new URL("https://api.testmail.app/api/json");
  url.searchParams.set("apikey", cfg.apiKey);
  url.searchParams.set("namespace", cfg.namespace);
  url.searchParams.set("tag", cfg.tag);
  url.searchParams.set("timestamp_from", String(sinceMs));
  url.searchParams.set("livequery", "true");
  url.searchParams.set("limit", "10");

  const res = await fetch(url, { signal: AbortSignal.timeout(waitMs) });
  if (!res.ok) throw new Error(`testmail API failed: ${res.status}`);
  const body = (await res.json()) as any;
  if (body?.result !== "success" || !Array.isArray(body.emails) || body.emails.length === 0) return null;
  const newest = body.emails.reduce((a: any, b: any) => (Number(a.timestamp) >= Number(b.timestamp) ? a : b));
  return {
    subject: String(newest.subject ?? ""),
    text: String(newest.text ?? ""),
    html: String(newest.html ?? ""),
    timestamp: Number(newest.timestamp ?? Date.now()),
  };
}

/** Generic adapter: GET url (+headers) returning { emails: [{subject,text,html,timestamp}] }. */
async function fetchCustom(
  cfg: NonNullable<EmailOtpConfig["custom"]>,
  sinceMs: number,
  waitMs: number,
): Promise<InboxMessage | null> {
  const res = await fetch(cfg.url, {
    headers: cfg.headers ?? {},
    signal: AbortSignal.timeout(waitMs),
  });
  if (!res.ok) throw new Error(`custom inbox API failed: ${res.status}`);
  const body = (await res.json()) as any;
  const emails: any[] = Array.isArray(body?.emails) ? body.emails : [];
  const fresh = emails.filter((e) => Number(e.timestamp ?? 0) >= sinceMs);
  if (fresh.length === 0) return null;
  const newest = fresh.reduce((a, b) => (Number(a.timestamp) >= Number(b.timestamp) ? a : b));
  return {
    subject: String(newest.subject ?? ""),
    text: String(newest.text ?? ""),
    html: String(newest.html ?? ""),
    timestamp: Number(newest.timestamp ?? Date.now()),
  };
}

// ─── Extraction ──────────────────────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

const CODE_KEYWORDS = /code|otp|verification|passcode|pin|one[- ]?time/i;

/** Extract the most likely OTP code: prefer 6 digits near a "code" keyword; reject years. */
export function extractOtpCode(message: InboxMessage): string | null {
  const sources = [message.subject, message.text || htmlToText(message.html)];
  let best: { code: string; score: number } | null = null;
  for (const source of sources) {
    if (!source) continue;
    const re = /(?<!\d)(\d{4,8})(?!\d)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const code = match[1];
      // Years and obvious non-codes.
      if (/^(19|20)\d{2}$/.test(code) && code.length === 4) continue;
      let score = 0;
      if (code.length === 6) score += 3;
      else if (code.length === 4 || code.length === 8) score += 1;
      const windowStart = Math.max(0, match.index - 80);
      const context = source.slice(windowStart, match.index + code.length + 40);
      if (CODE_KEYWORDS.test(context)) score += 4;
      if (source === message.subject) score += 2;
      if (!best || score > best.score) best = { code, score };
    }
  }
  return best && best.score >= 3 ? best.code : null;
}

const LINK_KEYWORDS = /verify|magic|token|auth|confirm|login|sign-?in|callback|activate|session/i;

/** Extract the most likely magic link, preferring the app's own origin. */
export function extractMagicLink(message: InboxMessage, appOrigin?: string): string | null {
  const candidates = new Set<string>();
  // Match href with single OR double quotes (Firebase and others single-quote).
  const hrefRe = /href\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(message.html)) !== null) candidates.add(match[1]);
  // Also scan raw URLs across html + text + subject — catches links the href
  // regex misses (unusual quoting/attributes) and text-only emails. The text
  // body sometimes drops the URL entirely, so html must be scanned too.
  const rawRe = /https?:\/\/[^\s<>"')\]]+/gi;
  for (const source of [message.html, message.text, message.subject]) {
    if (!source) continue;
    while ((match = rawRe.exec(source)) !== null) candidates.add(match[0]);
  }

  let appHost: string | null = null;
  try {
    appHost = appOrigin ? new URL(appOrigin).hostname : null;
  } catch {
    appHost = null;
  }

  let best: { url: string; score: number } | null = null;
  for (const raw of candidates) {
    let url: URL;
    try {
      url = new URL(raw.replace(/&amp;/g, "&"));
    } catch {
      continue;
    }
    // Never follow unsubscribe/marketing links.
    if (/unsubscribe|preferences|privacy|terms/i.test(url.href)) continue;
    let score = 0;
    if (appHost && (url.hostname === appHost || url.hostname.endsWith(`.${appHost}`))) score += 4;
    if (LINK_KEYWORDS.test(url.pathname + url.search)) score += 3;
    if (url.search.length > 24) score += 1; // token-bearing query strings are long
    if (!best || score > best.score) best = { url: url.href, score };
  }
  return best && best.score >= 3 ? best.url : null;
}

// ─── Screen detection + code entry ──────────────────────────────────────────

const EMAIL_OTP_INDICATORS = [
  "check your email",
  "check your inbox",
  "we sent",
  "we've sent",
  "sent you",
  "emailed you",
  "verification code",
  "enter the code",
  "code sent",
  "magic link",
  "sign-in link",
  "sign in link",
  "signin link",
  "login link",
  "log-in link",
  "link to sign",
  "link to log",
  "sent a link",
  "sent you a link",
  "emailed a link",
  "link has been sent",
  "one-time",
  "one time password",
  "6-digit code",
  "security code",
];

/** Detect a "we emailed you a code / link" screen. */
export async function detectEmailOtpScreen(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.evaluate(() =>
      document.body?.innerText?.toLowerCase().slice(0, 3000) ?? ""
    );
    return EMAIL_OTP_INDICATORS.some((indicator) => bodyText.includes(indicator));
  } catch {
    return false;
  }
}

const OTP_INPUT_SELECTOR =
  'input[autocomplete*="one-time"], input[name*="otp" i], input[name*="code" i], input[name*="token" i], ' +
  'input[placeholder*="code" i], input[aria-label*="code" i], input[inputmode="numeric"]';

async function submitAfterCode(page: Page): Promise<void> {
  const submit = page
    .locator('button[type="submit"], button:has-text("Verify"), button:has-text("Submit"), button:has-text("Continue"), button:has-text("Confirm")')
    .first();
  if (await submit.isVisible({ timeout: 2000 }).catch(() => false)) {
    await submit.click().catch(() => {});
  }
}

/** Fill the code into a single input or segmented per-digit boxes. */
async function fillCode(page: Page, code: string): Promise<boolean> {
  const inputs = page.locator(OTP_INPUT_SELECTOR);
  const count = await inputs.count().catch(() => 0);
  if (count === 0) return false;

  if (count >= code.length) {
    // Segmented one-digit boxes: focus the first, type through — most
    // implementations auto-advance focus.
    await inputs.first().click({ timeout: 3000 }).catch(() => {});
    await page.keyboard.type(code, { delay: 60 });
  } else {
    const input = inputs.first();
    if (!(await input.isVisible({ timeout: 3000 }).catch(() => false))) return false;
    // Type per-character rather than fill(): React OTP fields (Clerk's input-otp,
    // react-otp-input) read the `input` event stream and ignore a one-shot value
    // set, so fill() leaves the visible boxes empty. pressSequentially fires a
    // keystroke per digit, which they honor.
    await input.click({ timeout: 3000 }).catch(() => {});
    await input.fill("").catch(() => {});
    await input.pressSequentially(code, { delay: 60 });
  }
  await submitAfterCode(page);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  return true;
}

// ─── Main handler ────────────────────────────────────────────────────────────

/**
 * Wait for the login email and complete the flow: type the code or open the
 * magic link in the same context. `sinceMs` should be the moment the login
 * attempt started so stale messages are ignored. Returns true when handled.
 */
export async function handleEmailOtp(
  page: Page,
  cfg: EmailOtpConfig,
  sinceMs: number,
  baseUrl?: string,
): Promise<boolean> {
  const timeoutMs = (cfg.timeoutSeconds ?? 90) * 1000;
  const deadline = Date.now() + timeoutMs;
  logger.info({ provider: cfg.provider, address: cfg.address }, "Email OTP: waiting for login email");

  let message: InboxMessage | null = null;
  while (Date.now() < deadline && !message) {
    const waitMs = Math.max(5_000, Math.min(75_000, deadline - Date.now()));
    try {
      if (cfg.provider === "testmail" && cfg.testmail) {
        message = await fetchTestmail(cfg.testmail, sinceMs, waitMs);
      } else if (cfg.provider === "custom" && cfg.custom) {
        message = await fetchCustom(cfg.custom, sinceMs, waitMs);
        if (!message) await new Promise((resolve) => setTimeout(resolve, 5_000));
      } else {
        logger.warn({ provider: cfg.provider }, "Email OTP: no usable inbox adapter configured");
        return false;
      }
    } catch (err) {
      if (Date.now() >= deadline) break;
      logger.debug({ err: String(err).slice(0, 160) }, "Email OTP: inbox poll retrying");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }

  if (!message) {
    logger.warn({ address: cfg.address, timeoutMs }, "Email OTP: no email arrived before the timeout");
    return false;
  }
  logger.info({ subject: message.subject.slice(0, 120) }, "Email OTP: login email received");

  // Prefer typing a code (keeps the current page state); fall back to the link.
  const code = extractOtpCode(message);
  if (code && (await fillCode(page, code))) {
    logger.info("Email OTP: code entered");
    return true;
  }

  const link = extractMagicLink(message, baseUrl);
  if (link) {
    // Same browser context — magic links are often bound to the session that
    // requested them.
    logger.info({ host: new URL(link).hostname }, "Email OTP: opening magic link");
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    return true;
  }

  logger.warn("Email OTP: email arrived but no code or magic link could be extracted");
  return false;
}
