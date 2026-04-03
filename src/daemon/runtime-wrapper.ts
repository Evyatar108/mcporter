import type { ListResourcesRequest } from '@modelcontextprotocol/sdk/types.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { ServerDefinition } from '../config.js';
import { isKeepAliveServer } from '../lifecycle.js';
import type { CallOptions, ListToolsOptions, Runtime } from '../runtime.js';
import type { DaemonClient } from './client.js';

interface KeepAliveRuntimeOptions {
  readonly daemonClient: DaemonClient | null;
  readonly keepAliveServers: Set<string>;
}

export function createKeepAliveRuntime(base: Runtime, options: KeepAliveRuntimeOptions): Runtime {
  if (!options.daemonClient || options.keepAliveServers.size === 0) {
    return base;
  }
  return new KeepAliveRuntime(base, options.daemonClient, options.keepAliveServers);
}

class KeepAliveRuntime implements Runtime {
  private readonly restartPromises = new Map<string, Promise<void>>();

  constructor(
    private readonly base: Runtime,
    private readonly daemon: DaemonClient,
    private readonly keepAliveServers: Set<string>
  ) {}

  listServers(): string[] {
    return this.base.listServers();
  }

  getDefinitions(): ServerDefinition[] {
    return this.base.getDefinitions();
  }

  getDefinition(server: string): ServerDefinition {
    return this.base.getDefinition(server);
  }

  registerDefinition(definition: ServerDefinition, options?: { overwrite?: boolean }): void {
    this.base.registerDefinition(definition, options);
    if (isKeepAliveServer(definition)) {
      this.keepAliveServers.add(definition.name);
    } else {
      this.keepAliveServers.delete(definition.name);
    }
  }

  async listTools(server: string, options?: ListToolsOptions): Promise<Awaited<ReturnType<Runtime['listTools']>>> {
    if (this.shouldUseDaemon(server)) {
      return (await this.invokeWithRestart(server, 'listTools', () =>
        this.daemon.listTools({
          server,
          includeSchema: options?.includeSchema,
          autoAuthorize: options?.autoAuthorize,
        })
      )) as Awaited<ReturnType<Runtime['listTools']>>;
    }
    return this.base.listTools(server, options);
  }

  async callTool(server: string, toolName: string, options?: CallOptions): Promise<unknown> {
    if (this.shouldUseDaemon(server)) {
      return this.invokeWithRestart(server, 'callTool', () =>
        this.daemon.callTool({
          server,
          tool: toolName,
          args: options?.args,
          timeoutMs: options?.timeoutMs,
        })
      );
    }
    return this.base.callTool(server, toolName, options);
  }

  async listResources(server: string, options?: Partial<ListResourcesRequest['params']>): Promise<unknown> {
    if (this.shouldUseDaemon(server)) {
      return this.invokeWithRestart(server, 'listResources', () =>
        this.daemon.listResources({ server, params: options ?? {} })
      );
    }
    return this.base.listResources(server, options);
  }

  async connect(server: string): Promise<Awaited<ReturnType<Runtime['connect']>>> {
    return this.base.connect(server);
  }

  async close(server?: string): Promise<void> {
    if (!server) {
      await this.base.close();
      return;
    }
    if (this.shouldUseDaemon(server)) {
      await this.daemon.closeServer({ server }).catch(() => {});
      return;
    }
    await this.base.close(server);
  }

  private shouldUseDaemon(server: string): boolean {
    return this.keepAliveServers.has(server);
  }

  private async invokeWithRestart<T>(server: string, operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (!shouldRestartDaemonServer(error)) {
        throw error;
      }
      // The daemon keeps STDIO transports warm; if a call fails due to a fatal error,
      // force-close the cached server so the retry launches a fresh Chrome instance.
      logDaemonRetry(server, operation, error);
      await this.restartServer(server);
      return action();
    }
  }

  private async restartServer(server: string): Promise<void> {
    const existing = this.restartPromises.get(server);
    if (existing) {
      await existing;
      return;
    }

    const restart = this.daemon.closeServer({ server }).catch(() => {});
    this.restartPromises.set(server, restart);
    try {
      await restart;
    } finally {
      this.restartPromises.delete(server);
    }
  }
}

/**
 * Create a daemon-aware runtime for generated CLIs.
 * Tries the daemon first -> auto-starts if not running -> falls back to direct spawn.
 * Config path determines daemon identity: generated CLIs write their embedded server
 * definition to ~/.mcporter/generated/<name>/mcporter.json on first run.
 */
export async function createDaemonAwareRuntime(options: {
  servers: Parameters<typeof import('../runtime.js').createRuntime>[0]['servers'];
  configPath?: string;
  name?: string;
}): Promise<Runtime> {
  const { createRuntime } = await import('../runtime.js');
  const base = await createRuntime({ servers: options.servers });

  // Try to connect to daemon
  try {
    const { DaemonClient } = await import('./client.js');

    // Determine config path for daemon identity
    let configPath = options.configPath;
    if (!configPath && options.name) {
      const os = await import('node:os');
      const path = await import('node:path');
      const fs = await import('node:fs/promises');
      configPath = path.join(os.homedir(), '.mcporter', 'generated', options.name, 'mcporter.json');
      // Write embedded server definition if it doesn't exist
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      try {
        await fs.access(configPath);
      } catch {
        const config = { mcpServers: {} as Record<string, unknown> };
        for (const server of options.servers) {
          config.mcpServers[(server as any).name ?? options.name] = server;
        }
        await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
      }
    }

    if (!configPath) {
      return base;
    }

    const { resolveDaemonPaths } = await import('./client.js');
    const daemonPaths = resolveDaemonPaths(configPath);
    const client = new DaemonClient({ configPath, rootDir: undefined });

    // Check if daemon is alive
    try {
      await client.status();
    } catch {
      // Try to auto-start daemon
      try {
        const { launchDaemonDetached } = await import('./launch.js');
        launchDaemonDetached({ configPath, socketPath: daemonPaths.socketPath, metadataPath: daemonPaths.metadataPath });
        // Wait briefly for daemon to start
        let started = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          try {
            await client.status();
            started = true;
            break;
          } catch {
            // Daemon not ready yet, retry
          }
        }
        if (!started) {
          // Daemon didn't start in time — fall back to direct spawn
          return base;
        }
      } catch {
        // Daemon unavailable -- fall back to direct spawn
        return base;
      }
    }

    // Build keep-alive server set from definitions
    const keepAliveServers = new Set<string>();
    for (const server of options.servers) {
      const name = (server as any).name;
      if (name) keepAliveServers.add(name);
    }

    return createKeepAliveRuntime(base, { daemonClient: client, keepAliveServers });
  } catch {
    // Daemon module not available or failed -- fall back to direct spawn
    return base;
  }
}

const NON_FATAL_CODES = new Set([ErrorCode.InvalidRequest, ErrorCode.MethodNotFound, ErrorCode.InvalidParams]);

function shouldRestartDaemonServer(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof McpError) {
    return !NON_FATAL_CODES.has(error.code);
  }
  return true;
}

function logDaemonRetry(server: string, operation: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error);
  console.log(`[mcporter] Restarting '${server}' before retrying ${operation}: ${reason}`);
}
