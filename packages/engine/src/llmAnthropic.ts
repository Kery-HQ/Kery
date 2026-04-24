import Anthropic from "@anthropic-ai/sdk";
import type { LLMUsage, LlmChatOpts } from "./llmTypes.js";
import { MAX_OUTPUT_TOKENS } from "./llmTypes.js";

const ANTHROPIC_MODEL_IDS: Record<string, string> = {
  // Current generation
  "anthropic/claude-opus-4.7":  "claude-opus-4-7",
  "anthropic/claude-sonnet-4.6": "claude-sonnet-4-6",
  "anthropic/claude-haiku-4.5":  "claude-haiku-4-5-20251001",
  "anthropic/claude-opus-4.6":   "claude-opus-4-6",
  "anthropic/claude-sonnet-4.5": "claude-sonnet-4-5-20250929",
  "anthropic/claude-opus-4.5":   "claude-opus-4-5-20251101",
  // Legacy aliases kept for backwards compat
  "anthropic/claude-opus-4.1":   "claude-opus-4-1-20250805",
  "anthropic/claude-sonnet-4.4": "claude-sonnet-4-20250514",
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

function normalizeUserContent(content: string | any[]): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: String(content) }];
  }
  const imageBlocks: Anthropic.ImageBlockParam[] = [];
  const textBlocks: Anthropic.TextBlockParam[] = [];
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
        source: {
          type: "base64",
          media_type: parsed.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: parsed.base64,
        },
      });
    }
  }
  return [...imageBlocks, ...textBlocks];
}

function normalizeAssistantContent(content: string | any[]): Anthropic.ContentBlockParam[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: String(content) }];
  }
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const part of content) {
    if (part.type === "text") blocks.push({ type: "text", text: part.text ?? "" });
    else blocks.push({ type: "text", text: JSON.stringify(part) });
  }
  return blocks;
}

function openAIMessagesToAnthropicPayload(messages: any[]): {
  system?: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];
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
    }
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

function extractAnthropicTextContent(data: Anthropic.Message): string {
  const texts: string[] = [];
  for (const b of data.content) {
    if (b.type === "text" && "text" in b) texts.push(b.text);
  }
  return texts.join("");
}

function extractAnthropicToolInput(data: Anthropic.Message, toolName: string): Record<string, unknown> | null {
  for (const b of data.content) {
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
  opts: LlmChatOpts = {}
): Promise<{ content: string; usage: LLMUsage }> {
  const wireModel = resolveAnthropicModelId(model);
  const { system, messages: anthropicMessages } = openAIMessagesToAnthropicPayload(messages);
  const maxOut = Math.min(opts.maxTokens ?? MAX_OUTPUT_TOKENS, 8192);
  const timeoutMs = opts.timeoutMs ?? 45000;

  const client = new Anthropic({ apiKey, timeout: timeoutMs });

  let toolName: string | null = null;
  const rf = opts.responseFormat as { type?: string; json_schema?: { name: string; schema: unknown } } | undefined;
  const tools: Anthropic.Tool[] | undefined =
    rf?.type === "json_schema" && rf.json_schema
      ? (() => {
          const js = rf.json_schema!;
          toolName = js.name;
          return [
            {
              name: js.name,
              description: "Structured response required by the application.",
              input_schema: js.schema as any,
            },
          ];
        })()
      : undefined;

  const params: Anthropic.MessageCreateParams = {
    model: wireModel,
    max_tokens: maxOut,
    temperature: opts.temperature ?? 0.1,
    messages: anthropicMessages,
    ...(system ? { system } : {}),
    ...(tools && toolName
      ? {
          tools,
          tool_choice: { type: "tool", name: toolName },
        }
      : {}),
  };

  let data: Anthropic.Message;
  try {
    data = await client.messages.create(params, opts.signal ? { signal: opts.signal } : undefined);
  } catch (err: any) {
    if (err?.name === "AbortError" || err?.message?.includes("timeout")) {
      throw new Error(`Anthropic call timed out after ${timeoutMs}ms`);
    }
    throw err;
  }

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
