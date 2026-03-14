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

const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Pass 1 — Route + action name (no schemas, no params)
// ---------------------------------------------------------------------------

/**
 * Build the pass 1 routing prompt.
 * Action names + descriptions only — no schemas, no param details.
 * Stays small forever regardless of action catalog size.
 */
function buildRoutingPrompt(
  actions: ActionDefinition[],
  trustLevel: number,
): string {
  const actionList = actions.length > 0
    ? actions.map(a => `- ${a.name}: ${a.description}`).join("\n")
    : "(no actions registered)";

  if (trustLevel >= 1.0) {
    return `You are a message classifier. Classify the user's message into one route.

Available actions:
${actionList}

RULES:
1. ACTION — the message matches one of the available actions above. This includes both commands ("set timeout to 45 minutes") AND queries ("what is the timeout?", "how much time is left?") — if there's a matching action, use it.
2. CHAT — greeting, small talk, or questions that don't match any action. "Hey" "Tell me a joke" "What can you do?"
3. AGENT — needs tools, commands, file access, web search, or real work. Pick a framing:
   - "tool_builder" — user wants a REPEATING capability built (e.g. "build me a weather tool", "make a status checker")
   - "tech_chat" — about THIS SYSTEM's code, logs, config, architecture (e.g. "check the logs", "what's disk usage", "how does the canary work")
   - "plain_chat" — anything else that needs agent power: web research, shopping, random questions, life stuff (e.g. "find me pants", "what's the deal with X topic")

Respond with exactly one JSON object on a single line. No other text. Do NOT include params.

Examples:
{"route":"ACTION","action":"set_timeout"}
{"route":"ACTION","action":"get_timeout"}
{"route":"CHAT"}
{"route":"AGENT","framing":"tool_builder"}
{"route":"AGENT","framing":"tech_chat"}
{"route":"AGENT","framing":"plain_chat"}`;
  }

  return `You are a message classifier. Classify the user's message into one route.

Available actions:
${actionList}

RULES:
1. ACTION — the message matches one of the available actions above. This includes both commands ("set reply length to 200") AND queries ("what is the reply length?") — if there's a matching action, use it.
2. CHAT — everything else. Greetings, questions, requests that don't match any action.

You can ONLY use ACTION or CHAT. No other routes exist.

Respond with exactly one JSON object on a single line. No other text. Do NOT include params.

Examples:
{"route":"ACTION","action":"set_reply_length"}
{"route":"CHAT"}`;
}

/**
 * Validate pass 1 output: route + action name, no params expected.
 */
function validatePass1(
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

  if (route === "AGENT" && trustLevel < 1.0) {
    return "AGENT route not available at this trust level — use ACTION or CHAT";
  }

  const result: Classification = { route };

  if (route === "ACTION") {
    if (typeof obj.action !== "string" || !obj.action) {
      return "ACTION route requires an \"action\" field with the action name";
    }
    result.action = obj.action;
  }

  if (route === "AGENT") {
    const f = obj.framing;
    if (f === "tool_builder" || f === "tech_chat" || f === "plain_chat") {
      result.framing = f;
    } else {
      result.framing = "plain_chat";
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pass 2 — Slot filling (focused per-action param extraction)
// ---------------------------------------------------------------------------

/**
 * Build the pass 2 slot-filling prompt for a specific action.
 * Uses the action's custom actionParamsPrompt if present, otherwise auto-generates from schema.
 */
function buildSlotPrompt(action: ActionDefinition): string {
  if (action.actionParamsPrompt) return action.actionParamsPrompt;

  // Auto-generate from schema
  const fields = Object.entries(action.schema)
    .map(([name, desc]) => `- ${name}: ${desc}`)
    .join("\n");

  return `You are a parameter extractor. Extract parameters from the user's message for the "${action.name}" action.

Parameters:
${fields}

Respond with exactly one JSON object containing the extracted parameter values. No other text.

Example for ${action.name}:
${JSON.stringify(Object.fromEntries(Object.keys(action.schema).map(k => [k, `<${k}>`])))}`;
}

/**
 * Validate pass 2 output: must be an object with expected param keys.
 */
function validatePass2(
  parsed: unknown,
  action: ActionDefinition,
): Record<string, unknown> | string {
  if (typeof parsed !== "object" || parsed === null) {
    return "response was not a JSON object";
  }

  const obj = parsed as Record<string, unknown>;

  // Check that at least one expected key is present
  const expectedKeys = Object.keys(action.schema);
  const foundKeys = expectedKeys.filter(k => k in obj);
  if (foundKeys.length === 0 && expectedKeys.length > 0) {
    return `expected at least one of: ${expectedKeys.join(", ")}`;
  }

  return obj;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
 * Make a Qwen call with retry. Returns the validated result or null.
 */
async function qwenCall<T>(
  systemPrompt: string,
  userMessage: string,
  validate: (parsed: unknown) => T | string,
  logTag: string,
): Promise<{ result: T; raw: string } | null> {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let raw = "";
    try {
      for await (const chunk of streamChatCompletion(OLLAMA_CONFIG, messages)) {
        raw += chunk;
      }
    } catch (err) {
      log("classifier", `${logTag} ollama error`, { attempt, error: (err as Error).message });
      return null;
    }

    const parsed = extractJson(raw);
    if (parsed === null) {
      log("classifier", `${logTag} parse failed`, { attempt, raw: raw.trim().slice(0, 200) });
      if (attempt < MAX_ATTEMPTS) {
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: "That was not valid JSON. Respond with ONLY a single JSON object on one line. No explanation.",
        });
        continue;
      }
      return null;
    }

    const result = validate(parsed);
    if (typeof result === "string") {
      log("classifier", `${logTag} validation failed`, { attempt, reason: result, raw: raw.trim().slice(0, 200) });
      if (attempt < MAX_ATTEMPTS) {
        messages.push({ role: "assistant", content: raw });
        messages.push({
          role: "user",
          content: `Invalid: ${result}. Try again — respond with ONLY a single JSON object.`,
        });
        continue;
      }
      return null;
    }

    return { result, raw: raw.trim() };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a user message using two-pass Qwen classification.
 *
 * Pass 1: Route + action name (lean prompt, no schemas).
 * Pass 2: Slot filling (only for ACTION with params). Uses the matched action's
 *         actionParamsPrompt if defined, otherwise auto-generates from schema.
 *
 * Parameterless actions skip pass 2 entirely.
 */
export async function classifyMessage(
  message: string,
  actions: ActionDefinition[],
  trustLevel: number,
): Promise<Classification | null> {
  // --- Pass 1: Route + action name ---
  const routingPrompt = buildRoutingPrompt(actions, trustLevel);
  const pass1 = await qwenCall<Classification>(
    routingPrompt,
    message,
    (parsed) => validatePass1(parsed, trustLevel),
    "pass1",
  );

  if (!pass1) return null;

  const classification = pass1.result;

  log("classifier", "pass1", {
    message: message.slice(0, 80),
    result: classification,
    raw: pass1.raw.slice(0, 200),
  });

  // Non-ACTION routes are done after pass 1
  if (classification.route !== "ACTION" || !classification.action) {
    return classification;
  }

  // Look up the matched action
  const matchedAction = actions.find(a => a.name === classification.action);
  if (!matchedAction) {
    // Action name from Qwen doesn't match any registered action — treat as CHAT fallback
    log("classifier", "pass1 action not found, falling back to CHAT", { action: classification.action });
    return { route: "CHAT" };
  }

  // Parameterless actions skip pass 2
  const hasParams = Object.keys(matchedAction.schema).length > 0;
  if (!hasParams) {
    return classification;
  }

  // --- Pass 2: Slot filling ---
  const actionParamsPrompt = buildSlotPrompt(matchedAction);
  const pass2 = await qwenCall<Record<string, unknown>>(
    actionParamsPrompt,
    message,
    (parsed) => validatePass2(parsed, matchedAction),
    "pass2",
  );

  if (!pass2) {
    // Pass 2 failed — we know the action but can't fill params.
    // Return the classification without params; the action handler
    // can decide whether to fail or use defaults.
    log("classifier", "pass2 failed, returning action without params", { action: classification.action });
    return classification;
  }

  classification.params = pass2.result;

  log("classifier", "pass2", {
    action: classification.action,
    params: pass2.result,
    raw: pass2.raw.slice(0, 200),
  });

  return classification;
}
