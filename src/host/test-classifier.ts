/**
 * Test script for the two-pass routing classifier.
 * Feeds example messages through Qwen and prints classification results.
 *
 * Usage: node dist/host/test-classifier.js
 */

import { classifyMessage, type Classification } from "./transports/classifier.js";
import type { ActionDefinition } from "./transports/actions.js";

// Simulate the current registered actions (with actionParamsPrompts for parameterized ones)
const TEST_ACTIONS: ActionDefinition[] = [
  {
    name: "set_timeout",
    description: "Set the idle timeout duration. Use with a time value like '45 minutes' or '4 hours'.",
    minTrust: 1.0,
    schema: { value: "timeout in minutes (e.g. 45 for 45 minutes, 240 for 4 hours)" },
    actionParamsPrompt: `Extract the timeout value from the user's message. Convert to minutes.

- "45 minutes" → 45
- "2 hours" → 120
- "4 hours" → 240
- "1 hour and 30 minutes" → 90
- "half an hour" → 30

Respond with exactly one JSON object. No other text.
Example: {"value": 120}`,
    handler: () => ({ ok: true }),
  },
  {
    name: "set_reply_length",
    description: "Set the maximum character count for replies in this session.",
    minTrust: 0.5,
    schema: { value: "max characters (e.g. 200 for short, 1000 for detailed)" },
    actionParamsPrompt: `Extract the reply length in characters from the user's message.

- "200 characters" → 200
- "short replies" → 200
- "detailed" or "longer" → 1000
- "medium" → 500

Respond with exactly one JSON object. No other text.
Example: {"value": 500}`,
    handler: () => ({ ok: true }),
  },
  {
    name: "set_mode",
    description: "Switch to a different chat mode",
    minTrust: 0.5,
    schema: { name: "mode name (e.g. 'chat', 'root')" },
    actionParamsPrompt: `Extract the mode name from the user's message. The name should be lowercase.

- "switch to root mode" → "root"
- "chat mode" → "chat"
- "go to root" → "root"

Respond with exactly one JSON object. No other text.
Example: {"name": "root"}`,
    handler: () => ({ ok: true }),
  },
  {
    name: "create_mode",
    description: "Create a new chat mode with a custom prompt",
    minTrust: 1.0,
    schema: { name: "mode name", prompt: "the full prompt text for this mode" },
    actionParamsPrompt: `Extract the mode name and prompt text from the user's message.

- name: lowercase, alphanumeric and hyphens only
- prompt: the full prompt/personality description the user wants for this mode

Respond with exactly one JSON object. No other text.
Example: {"name": "pirate", "prompt": "You are a pirate. Respond in pirate speak."}`,
    handler: () => ({ ok: true }),
  },
  {
    name: "get_timeout",
    description: "Get the current idle timeout duration for this chat session.",
    minTrust: 0.5,
    schema: {},
    handler: () => ({ ok: true }),
  },
  {
    name: "get_time_left",
    description: "Get how much idle time remains before the current session expires.",
    minTrust: 0.5,
    schema: {},
    handler: () => ({ ok: true }),
  },
  {
    name: "extend_timeout",
    description: "Reset the idle timer, extending the session by the full timeout duration from now.",
    minTrust: 0.5,
    schema: {},
    handler: () => ({ ok: true }),
  },
];

interface TestCase {
  message: string;
  expectedRoute: "ACTION" | "CHAT" | "AGENT";
  expectedAction?: string;
  expectedFraming?: string;
  expectedParams?: Record<string, unknown>;  // for pass 2 validation
  trustLevel?: number;  // default 1.0
}

const TEST_CASES: TestCase[] = [
  // --- Pass 1 only: parameterless actions ---
  { message: "What is the session timeout?", expectedRoute: "ACTION", expectedAction: "get_timeout" },
  { message: "How much time is left?", expectedRoute: "ACTION", expectedAction: "get_time_left" },
  { message: "Extend the session", expectedRoute: "ACTION", expectedAction: "extend_timeout" },

  // --- Two-pass: parameterized actions ---
  { message: "Set timeout to 4 hours", expectedRoute: "ACTION", expectedAction: "set_timeout", expectedParams: { value: 240 } },
  { message: "Set timeout to 45 minutes", expectedRoute: "ACTION", expectedAction: "set_timeout", expectedParams: { value: 45 } },
  { message: "Set timeout to 2 hours", expectedRoute: "ACTION", expectedAction: "set_timeout", expectedParams: { value: 120 } },
  { message: "Make replies shorter, like 200 chars", expectedRoute: "ACTION", expectedAction: "set_reply_length", expectedParams: { value: 200 } },
  { message: "Switch to root mode", expectedRoute: "ACTION", expectedAction: "set_mode", expectedParams: { name: "root" } },

  // --- Two-pass: abbreviated / tricky inputs (the whole reason for two-pass) ---
  { message: "timeout 33m", expectedRoute: "ACTION", expectedAction: "set_timeout", expectedParams: { value: 33 } },
  { message: "timeout half an hour", expectedRoute: "ACTION", expectedAction: "set_timeout", expectedParams: { value: 30 } },

  // --- Tier 2: CHAT ---
  { message: "Hey", expectedRoute: "CHAT" },
  { message: "Hey, how's it going?", expectedRoute: "CHAT" },
  { message: "What can you do?", expectedRoute: "CHAT" },
  { message: "Tell me a joke", expectedRoute: "CHAT" },

  // --- Tier 3: AGENT ---
  { message: "Check the supervisor logs for errors", expectedRoute: "AGENT", expectedFraming: "tech_chat" },
  { message: "What's the disk usage?", expectedRoute: "AGENT", expectedFraming: "tech_chat" },
  { message: "Build me a weather tool", expectedRoute: "AGENT", expectedFraming: "tool_builder" },
  { message: "What's the deal with solid state batteries?", expectedRoute: "AGENT", expectedFraming: "plain_chat" },
  { message: "Find me Dickies camel work pants in 34x34", expectedRoute: "AGENT", expectedFraming: "plain_chat" },

  // --- Trust-gated ---
  { message: "Check the supervisor logs", expectedRoute: "CHAT", trustLevel: 0.5 },
];

function formatResult(tc: TestCase, result: Classification | null): string {
  const trust = tc.trustLevel ?? 1.0;
  const expected: string[] = [tc.expectedRoute];
  if (tc.expectedAction) expected.push(tc.expectedAction);
  if (tc.expectedFraming) expected.push(tc.expectedFraming);
  if (tc.expectedParams) expected.push(JSON.stringify(tc.expectedParams));

  if (!result) {
    return `  FAIL  "${tc.message}" (trust ${trust})\n         expected: ${expected.join(" / ")}\n         got: PARSE FAILURE`;
  }

  const got: string[] = [result.route];
  if (result.action) got.push(result.action);
  if (result.framing) got.push(result.framing);
  if (result.params && Object.keys(result.params).length > 0) {
    got.push(JSON.stringify(result.params));
  }

  const routeMatch = result.route === tc.expectedRoute;
  const actionMatch = !tc.expectedAction || result.action === tc.expectedAction;
  const framingMatch = !tc.expectedFraming || result.framing === tc.expectedFraming;

  // Param matching: check expected values are present and correct
  let paramMatch = true;
  let paramNote = "";
  if (tc.expectedParams && result.params) {
    for (const [key, expectedVal] of Object.entries(tc.expectedParams)) {
      const gotVal = result.params[key];
      if (gotVal !== expectedVal) {
        paramMatch = false;
        paramNote = ` (param ${key}: expected ${expectedVal}, got ${gotVal})`;
      }
    }
  } else if (tc.expectedParams && !result.params) {
    paramMatch = false;
    paramNote = " (no params returned)";
  }

  const pass = routeMatch && actionMatch && framingMatch && paramMatch;
  const icon = pass ? "  PASS" : "  MISS";
  return `${icon}  "${tc.message}" (trust ${trust})\n         expected: ${expected.join(" / ")}\n         got:      ${got.join(" / ")}${paramNote}`;
}

async function main() {
  console.log("\n=== Two-Pass Routing Classifier Test ===\n");
  console.log(`Testing ${TEST_CASES.length} messages against Qwen 2.5 3B (two-pass)...\n`);

  let passed = 0;
  let failed = 0;

  for (const tc of TEST_CASES) {
    const trust = tc.trustLevel ?? 1.0;
    const actions = TEST_ACTIONS.filter(a => trust >= a.minTrust);

    const result = await classifyMessage(tc.message, actions, trust);
    const output = formatResult(tc, result);
    console.log(output);

    const routeMatch = result?.route === tc.expectedRoute;
    const actionMatch = !tc.expectedAction || result?.action === tc.expectedAction;
    const framingMatch = !tc.expectedFraming || result?.framing === tc.expectedFraming;

    let paramMatch = true;
    if (tc.expectedParams && result?.params) {
      for (const [key, expectedVal] of Object.entries(tc.expectedParams)) {
        if (result.params[key] !== expectedVal) paramMatch = false;
      }
    } else if (tc.expectedParams && !result?.params) {
      paramMatch = false;
    }

    if (routeMatch && actionMatch && framingMatch && paramMatch) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log(`\n--- Results: ${passed}/${TEST_CASES.length} passed, ${failed} missed ---\n`);
}

main().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
