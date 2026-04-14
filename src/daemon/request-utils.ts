import type { ServerDefinition } from '../config.js';
import type { DaemonResponse } from './protocol.js';

export interface ServerActivity {
  connected: boolean;
  lastUsedAt?: number;
}

export function ensureManaged(server: string, managedServers: Map<string, ServerDefinition>): void {
  if (!managedServers.has(server)) {
    throw new Error(`Server '${server}' is not managed by the daemon.`);
  }
}

export function markActivity(server: string, activity: Map<string, ServerActivity>): void {
  const entry = activity.get(server);
  if (entry) {
    entry.connected = true;
    entry.lastUsedAt = Date.now();
  } else {
    activity.set(server, { connected: true, lastUsedAt: Date.now() });
  }
}

export function buildErrorResponse(id: string, code: string, error?: unknown): DaemonResponse {
  let message = code;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  }
  return {
    id,
    ok: false,
    error: {
      code,
      message,
    },
  };
}
