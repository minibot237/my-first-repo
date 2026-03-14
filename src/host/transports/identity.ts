import fs from "node:fs";
import path from "node:path";
import { log } from "../log.js";

const IDENTITIES_PATH = path.join(process.cwd(), ".local", "config", "identities.json");

export interface TransportIdentity {
  /** Unique ID within the identity registry (e.g. "telegram:123456") */
  id: string;
  /** Human-readable name */
  displayName: string;
  /** 0.0–1.0, where 1.0 is root */
  trustLevel: number;
  /** Which transport registered this identity */
  transport: string;
  /** Transport-specific user ID */
  transportUserId: string;
}

export interface IdentityConfig {
  displayName: string;
  trustLevel: number;
}

/**
 * Maps (transport, userId) → TransportIdentity.
 * Config-driven — no database, just a typed object.
 */
export class IdentityRegistry {
  private identities = new Map<string, TransportIdentity>();

  private key(transport: string, userId: string): string {
    return `${transport}:${userId}`;
  }

  register(transport: string, userId: string, config: IdentityConfig): TransportIdentity {
    const id = this.key(transport, userId);
    const identity: TransportIdentity = {
      id,
      displayName: config.displayName,
      trustLevel: config.trustLevel,
      transport,
      transportUserId: userId,
    };
    this.identities.set(id, identity);
    log("identity", "registered", { id, displayName: config.displayName, trustLevel: config.trustLevel });
    return identity;
  }

  lookup(transport: string, userId: string): TransportIdentity | undefined {
    return this.identities.get(this.key(transport, userId));
  }

  list(): TransportIdentity[] {
    return [...this.identities.values()];
  }

  /** Get all registered user IDs for a given transport (for allowlists) */
  userIdsForTransport(transport: string): Set<string> {
    const ids = new Set<string>();
    for (const identity of this.identities.values()) {
      if (identity.transport === transport) {
        ids.add(identity.transportUserId);
      }
    }
    return ids;
  }

  /**
   * Load identities from .local/config/identities.json
   * Format: { "transport:userId": { displayName, trustLevel } }
   */
  loadFromDisk(): void {
    try {
      const raw = fs.readFileSync(IDENTITIES_PATH, "utf-8");
      const data = JSON.parse(raw) as Record<string, IdentityConfig>;
      for (const [key, config] of Object.entries(data)) {
        const colonIdx = key.indexOf(":");
        if (colonIdx === -1) continue;
        const transport = key.slice(0, colonIdx);
        const userId = key.slice(colonIdx + 1);
        this.register(transport, userId, config);
      }
      log("identity", "loaded from disk", { path: IDENTITIES_PATH, count: this.identities.size });
    } catch (err) {
      log("identity", "no identities file or parse error", { path: IDENTITIES_PATH, error: (err as Error).message });
    }
  }
}
