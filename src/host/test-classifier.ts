/**
 * Test script for the routing classifier.
 * Feeds example messages through Qwen and prints classification results.
 *
 * Usage: node dist/host/test-classifier.js
 */

import { classifyMessage, type Classification } from "./transports/classifier.js";
import type { ActionDefinition } from "./transports/actions.js";

// Simulate the current registered actions
const TEST_ACTIONS: ActionDefinition[] = [
  {
    name: "set_timeout",
    description: "Set the idle timeout for this chat session",
    minTrust: 1.0,
    schema: { value: "timeout in minutes (e.g. 45 for 45 minutes, 240 for 4 hours)" },
    handler: () => ({ ok: true }),
  },
  {
    name: "set_reply_length",
    description: "Set the maximum character count for replies",
    minTrust: 0.5,
    schema: { value: "max characters (e.g. 200 for short, 1000 for detailed)" },
    handler: () => ({ ok: true }),
  },
  {
    name: "set_mode",
    description: "Switch to a different chat mode",
    minTrust: 0.5,
    schema: { name: "mode name (e.g. 'chat', 'root')" },
    handler: () => ({ ok: true }),
  },
  {
    name: "create_mode",
    description: "Create a new chat mode with a custom prompt",
    minTrust: 1.0,
    schema: { name: "mode name", prompt: "the full prompt text for this mode" },
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
  trustLevel?: number;  // default 1.0
}

const TEST_CASES: TestCase[] = [
  // Tier 1: ACTION — should map to registered actions
  { message: "Set timeout to 4 hours", expectedRoute: "ACTION", expectedAction: "set_timeout" },
  { message: "Make replies shorter, like 200 chars", expectedRoute: "ACTION", expectedAction: "set_reply_length" },
  { message: "Switch to root mode", expectedRoute: "ACTION", expectedAction: "set_mode" },

  // Tier 1: ACTION — query actions (new)
  { message: "What is the session timeout?", expectedRoute: "ACTION", expectedAction: "get_timeout" },
  { message: "How much time is left?", expectedRoute: "ACTION", expectedAction: "get_time_left" },
  { message: "Extend the session", expectedRoute: "ACTION", expectedAction: "extend_timeout" },
  { message: "Set timeout to 45 minutes", expectedRoute: "ACTION", expectedAction: "set_timeout" },

  // Tier 2: CHAT — conversational, no tools needed
  { message: "Hey", expectedRoute: "CHAT" },
  { message: "Hey, how's it going?", expectedRoute: "CHAT" },
  { message: "What can you do?", expectedRoute: "CHAT" },
  { message: "Tell me a joke", expectedRoute: "CHAT" },

  // Tier 3: AGENT — needs real capabilities
  { message: "Check the supervisor logs for errors", expectedRoute: "AGENT", expectedFraming: "tech_chat" },
  { message: "What's the disk usage?", expectedRoute: "AGENT", expectedFraming: "tech_chat" },
  { message: "Build me a weather tool", expectedRoute: "AGENT", expectedFraming: "tool_builder" },
  { message: "What's the deal with solid state batteries?", expectedRoute: "AGENT", expectedFraming: "plain_chat" },
  { message: "Find me Dickies camel work pants in 34x34", expectedRoute: "AGENT", expectedFraming: "plain_chat" },

  // Trust-gated: low trust user should never get AGENT
  { message: "Check the supervisor logs", expectedRoute: "CHAT", trustLevel: 0.5 },
];

function formatResult(tc: TestCase, result: Classification | null): string {
  const trust = tc.trustLevel ?? 1.0;
  const expected: string[] = [tc.expectedRoute];
  if (tc.expectedAction) expected.push(tc.expectedAction);
  if (tc.expectedFraming) expected.push(tc.expectedFraming);

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
  const pass = routeMatch && actionMatch && framingMatch;

  const icon = pass ? "  PASS" : "  MISS";
  return `${icon}  "${tc.message}" (trust ${trust})\n         expected: ${expected.join(" / ")}\n         got:      ${got.join(" / ")}`;
}

async function main() {
  console.log("\n=== Routing Classifier Test ===\n");
  console.log(`Testing ${TEST_CASES.length} messages against Qwen 2.5 3B...\n`);

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

    if (routeMatch && actionMatch && framingMatch) {
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
