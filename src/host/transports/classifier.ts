import { log } from "../log.js";
import { streamChatCompletion, type HttpBackendConfig } from "../sessions/http-backend.js";
import type { ActionDefinition } from "./actions.js";

/**
 * Routing classification result from Qwen.
 * Determines which tier handles the message and how.
 */
export interface Classification {
  route: "ACTION" | "CHAT" | "AGENT";
  action?: string;          // action name (ACTION route only)
  params?: Record<string, unknown>;  // extracted params (ACTION route only)
  framing?: "tool_builder" | "tech_chat" | "plain_chat";  // AGENT route only
}

const OLLAMA_CONFIG: HttpBackendConfig = {
  kind: "http",
  endpoint: "http://localhost:11434/v1/chat/completions",
  model: "qwen2.5:3b",
  stream: false,
};

/**
 * Build the routing prompt for Qwen.
 * Includes available actions and trust-gated route options.
 */
function buildRoutingPrompt(
  actions: ActionDefinition[],
  trustLevel: number,
): string {
  const actionList = actions.length > 0
    ? actions.map(a => {
        const params = Object.entries(a.schema)
          .map(([name, desc]) => `${name}: ${desc}`)
          .join(", ");
        return `- ${a.name}: ${a.description}${params ? ` (params: ${params})` : ""}`;
      }).join("\n")
    : "(no actions registered)";

  const routes = trustLevel >= 1.0
    ? "ACTION, CHAT, AGENT"
    : "ACTION, CHAT";

  if (trustLevel >= 1.0) {
    return `You are a message classifier. Classify the user's message into one route.

Available actions:
${actionList}

RULES:
1. ACTION — the message matches one of the available actions above. This includes both commands ("set timeout to 45 minutes") AND queries ("what is the timeout?", "how much time is left?") — if there's a matching action, use it. Extract action name and params.
2. CHAT — greeting, small talk, or questions that don't match any action. "Hey" "Tell me a joke" "What can you do?"
3. AGENT — needs tools, commands, file access, web search, or real work. Pick a framing:
   - "tool_builder" — user wants a REPEATING capability built (e.g. "build me a weather tool", "make a status checker")
   - "tech_chat" — about THIS SYSTEM's code, logs, config, architecture (e.g. "check the logs", "what's disk usage", "how does the canary work")
   - "plain_chat" — anything else that needs agent power: web research, shopping, random questions, life stuff (e.g. "find me pants", "what's the deal with X topic")

Respond with exactly one JSON object on a single line. No other text.

Examples:
{"route":"ACTION","action":"set_timeout","params":{"value":45}}
{"route":"ACTION","action":"get_timeout"}
{"route":"ACTION","action":"get_time_left"}
{"route":"ACTION","action":"extend_timeout"}
{"route":"CHAT"}
{"route":"AGENT","framing":"tool_builder"}
{"route":"AGENT","framing":"tech_chat"}
{"route":"AGENT","framing":"plain_chat"}`;
  }

  return `You are a message classifier. Classify the user's message into one route.

Available actions:
${actionList}

RULES:
1. ACTION — the message matches one of the available actions above. This includes both commands ("set reply length to 200") AND queries ("what is the reply length?") — if there's a matching action, use it. Extract action name and params.
2. CHAT — everything else. Greetings, questions, requests that don't match any action.

You can ONLY use ACTION or CHAT. No other routes exist.

Respond with exactly one JSON object on a single line. No other text.

Examples:
{"route":"ACTION","action":"set_reply_length","params":{"value":200}}
{"route":"CHAT"}`;
}

const MAX_ATTEMPTS = 2;

/**
 * Try to extract valid JSON from raw LLM output.
 * Strips markdown fences, handles common Qwen quirks.
 */
function extractJson(raw: string): unknown | null {
  let cleaned = raw.trim();

  // Strip markdown code fences
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    const lastFence = cleaned.lastIndexOf("```");
    if (firstNewline !== -1 && lastFence > firstNewline) {
      cleaned = cleaned.slice(firstNewline + 1, lastFence).trim();
    }
  }

  // Try direct parse first
  try {
    return JSON.parse(cleaned);
  } catch {
    // noop — try recovery below
  }

  // Try to find a JSON object in the output (Qwen sometimes adds explanation text)
  const match = cleaned.match(/\{[^}]+\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // noop
    }
  }

  return null;
}

/**
 * Validate parsed JSON into a Classification.
 * Returns the classification or a string describing what went wrong (for retry hints).
 */
function validateClassification(
  parsed: unknown,
  trustLevel: number,
): Classification | string {
  if (typeof parsed !== "object" || parsed === null) {
    return "response was not a JSON object";
  }

  const obj = parsed as Record<string, unknown>;
  const route = obj.route;

  if (route !== "ACTION" && route !== "CHAT" && route !== "AGENT") {
    return `invalid route "${route}" — must be ACTION, CHAT, or AGENT`;
  }

  // Trust enforcement: reject AGENT from low-trust prompts
  // (shouldn't happen since the prompt excludes it, but belt-and-suspenders)
  if (route === "AGENT" && trustLevel < 1.0) {
    return "AGENT route not available at this trust level — use ACTION or CHAT";
  }

  const result: Classification = { route };

  if (route === "ACTION") {
    if (typeof obj.action !== "string" || !obj.action) {
      return "ACTION route requires an \"action\" field with the action name";
    }
    result.action = obj.action;
    if (typeof obj.params === "object" && obj.params !== null) {
      result.params = obj.params as Record<string, unknown>;
    }
  }

  if (route === "AGENT") {
    const f = obj.framing;
    if (f === "tool_builder" || f === "tech_chat" || f === "plain_chat") {
      result.framing = f;
    } else {
      result.framing = "plain_chat";  // safe default
    }
  }

  return result;
}

/**
 * Classify a user message using Qwen.
 * Retries once with a hint if the first attempt produces invalid output.
 * Returns the routing classification or null on total failure.
 */
export async function classifyMessage(
  message: string,
  actions: ActionDefinition[],
  trustLevel: number,
): Promise<Classification | null> {
  const systemPrompt = buildRoutingPrompt(actions, trustLevel);

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: message },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw = "";
    try {
      for await (const chunk of streamChatCompletion(OLLAMA_CONFIG, messages)) {
        raw += chunk;
      }
    } catch (err) {
      log("classifier", "ollama error", { attempt, error: (err as Error).message });
      return null;
    }

    const parsed = extractJson(raw);
    if (parsed === null) {
      log("classifier", "parse failed", { attempt, raw: raw.trim().slice(0, 200) });
      if (attempt < MAX_ATTEMPTS) {
        // Add the failed response and a retry hint to the conversation
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: "That was not valid JSON. Respond with ONLY a single JSON object on one line. No explanation.",
        });
        continue;
      }
      return null;
    }

    const result = validateClassification(parsed, trustLevel);
    if (typeof result === "string") {
      log("classifier", "validation failed", { attempt, reason: result, raw: raw.trim().slice(0, 200) });
      if (attempt < MAX_ATTEMPTS) {
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: `Invalid classification: ${result}. Try again — respond with ONLY a single JSON object.`,
        });
        continue;
      }
      return null;
    }

    log("classifier", "classified", {
      message: message.slice(0, 80),
      result,
      raw: raw.trim().slice(0, 200),
      ...(attempt > 1 ? { attempt } : {}),
    });
    return result;
  }

  return null;
}
