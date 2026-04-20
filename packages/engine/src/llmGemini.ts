import { FinishReason, GoogleGenAI, type Content, type Part } from "@google/genai";
import { logger } from "./logger.js";
import { wireModelForGeminiDirect } from "./llmProviders.js";
import type { LLMUsage, LlmChatOpts } from "./llmTypes.js";
import { MAX_OUTPUT_TOKENS } from "./llmTypes.js";

function parseDataUrl(url: string): { mediaType: string; base64: string } | null {
  const m = url.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mediaType: m[1], base64: m[2] };
}

function openAiContentToGeminiParts(content: string | unknown[]): Part[] {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content) }];
  const parts: Part[] = [];
  for (const part of content as any[]) {
    if (part.type === "text") parts.push({ text: part.text ?? "" });
    else if (part.type === "image_url") {
      const url = part.image_url?.url ?? "";
      const parsed = parseDataUrl(url);
      if (!parsed) {
        throw new Error("Gemini requires base64 data URLs for images (image_url.data).");
      }
      parts.push({ inlineData: { mimeType: parsed.mediaType, data: parsed.base64 } });
    }
  }
  return parts;
}

function openAiMessagesToGemini(
  messages: any[]
): { systemInstruction?: string; contents: Content[] } {
  const systemParts: string[] = [];
  const contents: Content[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      continue;
    }
    if (m.role === "user") {
      contents.push({ role: "user", parts: openAiContentToGeminiParts(m.content) });
      continue;
    }
    if (m.role === "assistant") {
      contents.push({ role: "model", parts: openAiContentToGeminiParts(m.content) });
    }
  }
  return {
    systemInstruction: systemParts.length ? systemParts.join("\n\n") : undefined,
    contents,
  };
}

export async function llmGeminiChat(
  messages: any[],
  model: string,
  apiKey: string,
  opts: LlmChatOpts = {}
): Promise<{ content: string; usage: LLMUsage }> {
  const wireModel = wireModelForGeminiDirect(model);
  const { systemInstruction, contents } = openAiMessagesToGemini(messages);
  if (!contents.length) {
    throw new Error("Gemini chat requires at least one user or assistant message.");
  }

  const timeoutMs = opts.timeoutMs ?? 45000;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
  // Combine external stop signal with internal timeout signal
  const abortSignal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutController.signal])
    : timeoutController.signal;

  const ai = new GoogleGenAI({ apiKey });

  const config: Record<string, unknown> = {
    temperature: opts.temperature ?? 0.1,
    maxOutputTokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
    abortSignal,
  };
  if (systemInstruction) config.systemInstruction = systemInstruction;

  const rf = opts.responseFormat as { type?: string; json_schema?: { schema?: unknown } } | undefined;
  if (rf?.type === "json_schema" && rf.json_schema?.schema) {
    config.responseMimeType = "application/json";
    config.responseJsonSchema = rf.json_schema.schema;
  }

  try {
    const response = await ai.models.generateContent({
      model: wireModel,
      contents,
      config: config as any,
    });

    const cand = response.candidates?.[0];
    const fr = cand?.finishReason;
    if (fr === FinishReason.SAFETY) {
      logger.warn("Gemini SAFETY filter triggered");
      return { content: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    }

    if (fr && fr !== FinishReason.STOP && fr !== FinishReason.MAX_TOKENS) {
      logger.warn({ finishReason: fr, model: wireModel }, "Gemini non-stop finish reason");
    }

    const text = response.text ?? "";
    const um = response.usageMetadata;
    const inputTokens = um?.promptTokenCount ?? 0;
    const outputTokens = um?.candidatesTokenCount ?? 0;
    const totalTokens = um?.totalTokenCount ?? inputTokens + outputTokens;

    return {
      content: text,
      usage: { inputTokens, outputTokens, totalTokens },
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      // Re-throw external abort as-is so callers can detect it; only wrap timeout aborts.
      if (opts.signal?.aborted) throw err;
      throw new Error(`Gemini call timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}
