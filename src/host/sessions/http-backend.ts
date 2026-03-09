export interface HttpBackendConfig {
  kind: "http";
  endpoint: string;
  model: string;
  stream: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Streams a chat completion from an OpenAI-compatible endpoint (Ollama).
 * Yields content deltas as they arrive.
 */
export async function* streamChatCompletion(
  config: HttpBackendConfig,
  messages: ChatMessage[],
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch(config.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: config.stream,
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama error ${res.status}: ${body}`);
  }

  if (!config.stream) {
    // Non-streaming: yield the whole response at once
    const json = await res.json() as { choices: { message: { content: string } }[] };
    yield json.choices[0].message.content;
    return;
  }

  // Streaming: parse SSE
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const chunk = JSON.parse(data) as {
          choices: { delta: { content?: string } }[];
        };
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // skip malformed chunks
      }
    }
  }
}
