import type { LLMUsage } from "./llmTypes.js";
import { MAX_OUTPUT_TOKENS } from "./llmTypes.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

/** OpenRouter-style ids → Anthropic API `model` field (Messages API). */
const ANTHROPIC_MODEL_IDS: Record<string, string> = {
  "anthropic/claude-sonnet-4.6": "claude-sonnet-4-20250514",
  "anthropic/claude-haiku-4.5": "claude-haiku-4-5-20251001",
  "anthropic/claude-opus-4.6": "claude-opus-4-20250514",
};

function resolveAnthropicModelId(model: string): string {
  if (ANTHROPIC_MODEL_IDS[model]) return ANTHROPIC_MODEL_IDS[model];
  const prefixed = model.startsWith("anthropic/") ? model : `anthropic/${model}`;
  if (ANTHROPIC_MODEL_IDS[prefixed]) return ANTHROPIC_MODEL_IDS[prefixed];
  if (model.startsWith("anthropic/")) return model.slice("anthropic/".length);
  return model;
}

function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

function normalizeUserContent(content: string | any[]): any[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: String(content) }];
  }
  const imageBlocks: any[] = [];
  const textBlocks: any[] = [];
  for (const part of content) {
    if (part.type === "text") {
      textBlocks.push({ type: "text", text: part.text ?? "" });
    } else if (part.type === "image_url") {
      const url = part.image_url?.url ?? "";
      const parsed = parseDataUrl(url);
      if (!parsed) {
        throw new Error("Anthropic requires base64 data URLs for images (image_url.data).");
      }
      imageBlocks.push({
        type: "image",
        source: { type: "base64", media_type: parsed.mediaType, data: parsed.base64 },
      });
    }
  }
  return [...imageBlocks, ...textBlocks];
}

function normalizeAssistantContent(content: string | any[]): string | any[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: String(content) }];
  }
  const blocks: any[] = [];
  for (const part of content) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text ?? "" });
    else blocks.push({ type: "text", text: JSON.stringify(part) });
  }
  return blocks;
}

function openAIMessagesToAnthropicPayload(messages: any[]): { system?: string; messages: any[] } {
  const systemParts: string[] = [];
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      continue;
    }
    if (m.role === "user") {
      out.push({ role: "user", content: normalizeUserContent(m.content) });
      continue;
    }
    if (m.role === "assistant") {
      out.push({ role: "assistant", content: normalizeAssistantContent(m.content) });
      continue;
    }
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

function extractAnthropicTextContent(data: any): string {
  const blocks = data.content;
  if (!Array.isArray(blocks)) return "";
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && b.text) texts.push(b.text);
  }
  return texts.join("");
}

function extractAnthropicToolInput(data: any, toolName: string): Record<string, unknown> | null {
  const blocks = data.content;
  if (!Array.isArray(blocks)) return null;
  for (const b of blocks) {
    if (b.type === "tool_use" && b.name === toolName && b.input && typeof b.input === "object") {
      return b.input as Record<string, unknown>;
    }
  }
  return null;
}

export async function anthropicMessagesChat(
  messages: any[],
  model: string,
  apiKey: string,
  opts: {
    maxTokens?: number;
    temperature?: number;
    responseFormat?: any;
    timeoutMs?: number;
  }
): Promise<{ content: string; usage: LLMUsage }> {
  const wireModel = resolveAnthropicModelId(model);
  const { system, messages: anthropicMessages } = openAIMessagesToAnthropicPayload(messages);

  const maxOut = Math.min(opts.maxTokens ?? MAX_OUTPUT_TOKENS, 8192);

  const body: any = {
    model: wireModel,
    max_tokens: maxOut,
    temperature: opts.temperature ?? 0.1,
    messages: anthropicMessages,
    ...(system ? { system } : {}),
  };

  let toolName: string | null = null;
  if (opts.responseFormat?.type === "json_schema" && opts.responseFormat.json_schema) {
    const js = opts.responseFormat.json_schema;
    toolName = js.name;
    body.tools = [
      {
        name: js.name,
        description: "Structured response required by the application.",
        input_schema: js.schema,
      },
    ];
    body.tool_choice = { type: "tool", name: js.name };
  }

  const timeoutMs = opts.timeoutMs ?? 45000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error(`Anthropic call timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text}`);
  }

  const data: any = await res.json();

  let contentStr = "";
  if (toolName) {
    const input = extractAnthropicToolInput(data, toolName);
    if (input) contentStr = JSON.stringify(input);
    else contentStr = extractAnthropicTextContent(data);
  } else {
    contentStr = extractAnthropicTextContent(data);
  }

  const usage: LLMUsage = {
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
  };

  return { content: contentStr, usage };
}
