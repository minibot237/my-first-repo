import { log } from "../log.js";

/** A action payload: name + params. Source-agnostic — comes from classifier, scheduler, agent, or user. */
export interface Action {
  action: string;
  [key: string]: unknown;
}

export interface ChatResponse {
  reply: string;
  actions?: Action[];
}

export interface ActionDefinition {
  name: string;
  description: string;
  minTrust: number;
  schema: Record<string, string>;  // param name → description
  handler: (params: Action, context: ActionContext) => ActionResult;
}

export interface ActionContext {
  identityId: string;
  trustLevel: number;
  sessionId?: string;  // absent for Tier 1 direct actions (no session needed)
}

export interface ActionResult {
  ok: boolean;
  message?: string;
}

/**
 * Registry of available chat actions.
 * Actions are trust-gated — the registry filters by trust level
 * both for prompt generation (what Claude knows about) and
 * execution (belt-and-suspenders validation).
 */
export class ActionRegistry {
  private actions = new Map<string, ActionDefinition>();

  register(def: ActionDefinition): void {
    this.actions.set(def.name, def);
    log("actions", "registered", { name: def.name, minTrust: def.minTrust });
  }

  /** Get actions available at a given trust level (for prompt building) */
  forTrust(trustLevel: number): ActionDefinition[] {
    return [...this.actions.values()].filter(a => trustLevel >= a.minTrust);
  }

  /** Execute an action with trust validation */
  execute(action: Action, context: ActionContext): ActionResult {
    const def = this.actions.get(action.action);
    if (!def) {
      log("actions", "unknown action", { action: action.action, identity: context.identityId });
      return { ok: false, message: `Unknown action: ${action.action}` };
    }

    if (context.trustLevel < def.minTrust) {
      log("actions", "trust rejected", {
        action: action.action,
        identity: context.identityId,
        required: def.minTrust,
        actual: context.trustLevel,
      });
      return { ok: false, message: `Insufficient trust for ${action.action}` };
    }

    try {
      return def.handler(action, context);
    } catch (err) {
      log("actions", "handler error", { action: action.action, error: (err as Error).message });
      return { ok: false, message: (err as Error).message };
    }
  }
}

/**
 * Parse Claude's raw response into a ChatResponse.
 * Strict: JSON.parse, read known fields, done.
 * On failure: returns an error reply, no actions.
 */
export function parseChatResponse(raw: string): ChatResponse {
  // Claude might wrap JSON in markdown code fences
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    const firstNewline = cleaned.indexOf("\n");
    const lastFence = cleaned.lastIndexOf("```");
    if (firstNewline !== -1 && lastFence > firstNewline) {
      cleaned = cleaned.slice(firstNewline + 1, lastFence).trim();
    }
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.reply !== "string") {
      return { reply: "[parse error: response missing 'reply' field]" };
    }
    const response: ChatResponse = { reply: parsed.reply };
    if (Array.isArray(parsed.actions)) {
      response.actions = parsed.actions.filter(
        (a: unknown) => typeof a === "object" && a !== null && typeof (a as Action).action === "string"
      );
    }
    return response;
  } catch {
    // If Claude just sent plain text (shouldn't happen, but safety net)
    return { reply: raw.trim() };
  }
}
