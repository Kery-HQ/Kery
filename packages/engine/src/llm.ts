import { getConfig } from "./config.js";

export async function callLLM(prompt: string): Promise<string> {
  const config = getConfig();
  const apiKey = config.openrouterApiKey || config.openaiApiKey;
  if (!apiKey) throw new Error("No LLM API key configured (OPENROUTER_API_KEY or OPENAI_API_KEY).");

  const baseUrl = config.openrouterApiKey
    ? "https://openrouter.ai/api/v1"
    : "https://api.openai.com/v1";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 45_000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(config.openrouterApiKey ? { "HTTP-Referer": "https://kery.so", "X-Title": "Kery Agent" } : {}),
      },
      body: JSON.stringify({
        model: config.geminiSummaryModel,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 65535,
        temperature: 0.2,
        ...(config.openrouterApiKey && String(config.geminiSummaryModel || "").includes("gemini")
          ? {
              reasoning: {
                max_tokens: 20000,
                enabled: true,
                exclude: false,
              },
            }
          : {}),
      }),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error("LLM call timed out after 45s");
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM call failed: ${res.status} ${text}`);
  }

  const data: any = await res.json();
  return data.choices[0].message.content || "";
}
