/**
 * Robust JSON extraction from raw LLM output.
 *
 * Strategy (same pattern used across memoryCurator, scriptGenerator, agent):
 *   1. Direct JSON.parse on trimmed input          — fast path for clean responses
 *   2. Strip markdown fences, retry JSON.parse     — handles ```json ... ``` wrapping
 *   3. Bracket-match from first { or [             — handles preamble/postamble text
 *   4. Outer-bounds indexOf/lastIndexOf fallback   — handles truncated bracket stacks
 */

function stripFences(raw: string): string {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : raw;
}

/**
 * Extract the first complete JSON value (object or array) via bracket matching.
 * Returns the raw JSON string, or null if nothing balanced is found.
 */
function bracketMatch(source: string, open: "{" | "["): string | null {
  const close = open === "{" ? "}" : "]";
  const start = source.indexOf(open);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Outer-bounds fallback: slice from first open bracket to last matching close bracket.
 * Less precise than bracketMatch but recovers from truncated/concatenated responses.
 */
function outerBounds(source: string, open: "{" | "["): string | null {
  const close = open === "{" ? "}" : "]";
  const start = source.indexOf(open);
  const end = source.lastIndexOf(close);
  if (start === -1 || end <= start) return null;
  return source.slice(start, end + 1);
}

function tryParse<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

/**
 * Determine which bracket type to try first based on position in the source.
 * If both exist, prefer the one that appears first. If only one exists, use that.
 */
function preferredOpen(source: string): "{" | "[" | null {
  const obj = source.indexOf("{");
  const arr = source.indexOf("[");
  if (obj === -1 && arr === -1) return null;
  if (obj === -1) return "[";
  if (arr === -1) return "{";
  return arr < obj ? "[" : "{";
}

function extractAndParse<T>(source: string): T | null {
  const first = preferredOpen(source);
  if (!first) return null;
  const second = first === "{" ? "[" : "{";

  // Bracket-match the preferred type first, then the other
  for (const open of [first, second] as ("{" | "[")[]) {
    const result = tryParse<T>(bracketMatch(source, open));
    if (result !== null) return result;
  }

  // Last resort: outer-bounds slice (handles truncated bracket stacks)
  for (const open of [first, second] as ("{" | "[")[]) {
    const result = tryParse<T>(outerBounds(source, open));
    if (result !== null) return result;
  }

  return null;
}

/**
 * Parse the first JSON value (object or array) from raw LLM output.
 * Handles markdown fences, preamble text, and concatenated responses.
 */
export function parseFirstJson<T>(raw: string): T | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // 1. Direct parse
  const direct = tryParse<T>(trimmed);
  if (direct !== null) return direct;

  // 2. Strip fences and retry
  const stripped = stripFences(trimmed);
  if (stripped !== trimmed) {
    const fenceResult = tryParse<T>(stripped);
    if (fenceResult !== null) return fenceResult;
  }

  // 3. Bracket-match + outer-bounds on stripped source
  return extractAndParse<T>(stripped);
}

/**
 * Parse the first JSON object `{...}` from raw LLM output.
 * Handles markdown fences and preamble text.
 */
export function parseFirstJsonObject<T>(raw: string): T | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // 1. Direct parse
  const direct = tryParse<T>(trimmed);
  if (direct !== null && !Array.isArray(direct)) return direct;

  // 2. Strip fences and retry
  const stripped = stripFences(trimmed);
  if (stripped !== trimmed) {
    const fenceResult = tryParse<T>(stripped);
    if (fenceResult !== null && !Array.isArray(fenceResult)) return fenceResult;
  }

  // 3. Bracket-match
  const matched = tryParse<T>(bracketMatch(stripped, "{"));
  if (matched !== null) return matched;

  // 4. Outer-bounds fallback
  return tryParse<T>(outerBounds(stripped, "{"));
}

/** Extract the first JSON object string from raw text (without parsing). */
export function extractFirstJsonObject(raw: string): string | null {
  if (!raw) return null;
  const stripped = stripFences(raw.trim());
  return bracketMatch(stripped, "{") ?? outerBounds(stripped, "{");
}

/** Extract the first JSON array string from raw text (without parsing). */
export function extractFirstJsonArray(raw: string): string | null {
  if (!raw) return null;
  const stripped = stripFences(raw.trim());
  return bracketMatch(stripped, "[") ?? outerBounds(stripped, "[");
}
