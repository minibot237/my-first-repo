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
  // --- Scheduler actions ---
  {
    name: "list_schedules",
    description: "Show scheduled tasks, timers, and recurring jobs. Use when user says 'schedules', 'what's scheduled', 'list timers', 'show recurring tasks'.",
    minTrust: 0.5,
    schema: {},
    handler: () => ({ ok: true }),
  },
  {
    name: "add_schedule",
    description: "Schedule a task to run automatically on a timer. Use when user says 'schedule X every Y', 'run X daily at Y', 'set up recurring X'.",
    minTrust: 1.0,
    schema: {
      action: "action name to schedule",
      type: "'interval' or 'cron'",
      interval: "for interval: minutes between runs (e.g. 30)",
      cron: "for cron: time spec (e.g. '9:00', 'weekdays 8:30')",
      push: "'always', 'on_change', or 'never' (default: always)",
    },
    actionParamsPrompt: `Extract schedule parameters from the user's message.

- action: the name of the action to schedule
- type: "interval" if they say "every X minutes/hours", "cron" if they say "at X:XX" or "daily at"
- interval: number of minutes between runs (only for interval type)
- cron: time spec like "9:00" or "weekdays 8:30" (only for cron type)
- push: "always" unless they say otherwise

Examples:
"schedule get_timeout every 30 minutes" → {"action":"get_timeout","type":"interval","interval":30,"push":"always"}
"run get_time_left daily at 9am" → {"action":"get_time_left","type":"cron","cron":"9:00","push":"always"}
"check disk every hour, only tell me if it changes" → {"action":"check_disk","type":"interval","interval":60,"push":"on_change"}

Respond with exactly one JSON object. No other text.`,
    handler: () => ({ ok: true }),
  },
  {
    name: "remove_schedule",
    description: "Stop or remove a scheduled task. Use when user says 'stop scheduling X', 'unschedule X', 'remove the X schedule', 'cancel the timer for X'.",
    minTrust: 1.0,
    schema: { action: "action name to unschedule" },
    actionParamsPrompt: `Extract the action name to remove from the schedule.

Respond with exactly one JSON object. No other text.
Example: {"action": "get_timeout"}`,
    handler: () => ({ ok: true }),
  },
  // --- Notify action ---
  {
    name: "notify",
    description: "Send a message or notification to the user. Use when user says 'send me a message', 'notify me', 'tell me when', 'alert me', 'ping me'.",
    minTrust: 0.5,
    schema: { message: "the message text to send" },
    actionParamsPrompt: `Extract the message to send from the user's request.

Respond with exactly one JSON object. No other text.
Example: {"message": "Hello from minibot!"}`,
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
  // =============================================
  // PASS 1 ONLY: Parameterless actions
  // =============================================
  { message: "What is the session timeout?", expectedRoute: "ACTION", expectedAction: "get_timeout" },
  { message: "How much time is left?", expectedRoute: "ACTION", expectedAction: "get_time_left" },
  { message: "Extend the session", expectedRoute: "ACTION", expectedAction: "extend_timeout" },
  { message: "What schedules are running?", expectedRoute: "ACTION", expectedAction: "list_schedules" },
  { message: "Show me the scheduled tasks", expectedRoute: "ACTION", expectedAction: "list_schedules" },

  // =============================================
  // TWO-PASS: Parameterized actions — original set
  // =============================================
  { message: "Set timeout to 4 hours", expectedRoute: "ACTION", expectedAction: "set_timeout", expectedParams: { value: 240 } },
  { message: "Set timeout to 45 minutes", expectedRoute: "ACTION", expectedAction: "set_timeout", expectedParams: { value: 45 } },
  { message: "Set timeout to 2 hours", expectedRoute: "ACTION", expectedAction: "set_timeout", expectedParams: { value: 120 } },
  { message: "Make replies shorter, like 200 chars", expectedRoute: "ACTION", expectedAction: "set_reply_length", expectedParams: { value: 200 } },
  { message: "Switch to root mode", expectedRoute: "ACTION", expectedAction: "set_mode", expectedParams: { name: "root" } },

  // =============================================
  // TWO-PASS: Abbreviated / tricky inputs
  // =============================================
  { message: "timeout 33m", expectedRoute: "ACTION", expectedAction: "set_timeout", expectedParams: { value: 33 } },
  { message: "timeout half an hour", expectedRoute: "ACTION", expectedAction: "set_timeout", expectedParams: { value: 30 } },

  // =============================================
  // TWO-PASS: Scheduler actions
  // =============================================
  { message: "Schedule get_timeout every 30 minutes", expectedRoute: "ACTION", expectedAction: "add_schedule", expectedParams: { action: "get_timeout", type: "interval", interval: 30 } },
  { message: "Run get_time_left daily at 9am", expectedRoute: "ACTION", expectedAction: "add_schedule", expectedParams: { action: "get_time_left", type: "cron", cron: "9:00" } },
  { message: "Stop scheduling get_timeout", expectedRoute: "ACTION", expectedAction: "remove_schedule", expectedParams: { action: "get_timeout" } },
  { message: "Unschedule the timeout check", expectedRoute: "ACTION", expectedAction: "remove_schedule" },

  // =============================================
  // TWO-PASS: Notify action
  // =============================================
  { message: "Send me a message saying hello", expectedRoute: "ACTION", expectedAction: "notify", expectedParams: { message: "hello" } },
  { message: "Notify me that the build is done", expectedRoute: "ACTION", expectedAction: "notify" },

  // =============================================
  // TIER 2: Chat — greetings, small talk, general questions
  // =============================================
  { message: "Hey", expectedRoute: "CHAT" },
  { message: "Hey, how's it going?", expectedRoute: "CHAT" },
  // NOTE: "What can you do?" and "Tell me a joke" often route to AGENT/plain_chat.
  // That's functionally fine (works, just more expensive). Marking as CHAT is aspirational.
  { message: "What can you do?", expectedRoute: "CHAT" },
  { message: "Tell me a joke", expectedRoute: "CHAT" },
  { message: "Thanks", expectedRoute: "CHAT" },
  { message: "Good morning", expectedRoute: "CHAT" },

  // =============================================
  // TIER 3: Agent — needs tools, commands, file access
  // =============================================
  // tech_chat: about this system
  { message: "Check the supervisor logs for errors", expectedRoute: "AGENT", expectedFraming: "tech_chat" },
  { message: "What's the disk usage?", expectedRoute: "AGENT", expectedFraming: "tech_chat" },
  { message: "How does the canary pipeline work?", expectedRoute: "AGENT", expectedFraming: "tech_chat" },
  { message: "Show me the last 10 lines of the supervisor log", expectedRoute: "AGENT", expectedFraming: "tech_chat" },

  // tool_builder: wants a new repeating capability
  { message: "Build me a weather tool", expectedRoute: "AGENT", expectedFraming: "tool_builder" },
  { message: "Make a tool that checks my GitHub notifications", expectedRoute: "AGENT", expectedFraming: "tool_builder" },

  // plain_chat: general questions needing agent power
  { message: "What's the deal with solid state batteries?", expectedRoute: "AGENT", expectedFraming: "plain_chat" },
  { message: "Find me Dickies camel work pants in 34x34", expectedRoute: "AGENT", expectedFraming: "plain_chat" },
  { message: "What's the weather in Portland right now?", expectedRoute: "AGENT", expectedFraming: "plain_chat" },

  // =============================================
  // TRUST-GATED: Lower trust can't access AGENT
  // =============================================
  { message: "Check the supervisor logs", expectedRoute: "CHAT", trustLevel: 0.5 },
  { message: "Set timeout to 1 hour", expectedRoute: "CHAT", trustLevel: 0.5 },  // set_timeout requires trust 1.0

  // =============================================
  // EDGE CASES: Ambiguous or tricky routing
  // =============================================
  { message: "timeout?", expectedRoute: "ACTION", expectedAction: "get_timeout" },
  { message: "schedules", expectedRoute: "ACTION", expectedAction: "list_schedules" },
  { message: "extend", expectedRoute: "ACTION", expectedAction: "extend_timeout" },
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
