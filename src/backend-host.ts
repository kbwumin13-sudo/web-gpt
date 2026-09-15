import type { AppConfig } from "./config";
import { startServer, type BackendServer } from "./server";
import {
  connectTunnel,
  stopTunnel,
  waitForTunnelReady,
  type TunnelRuntimeStatus,
} from "./tunnel";

export type BackendHostState = "stopped" | "starting" | "ready" | "stopping" | "failed";

export interface BackendHostStatus {
  state: BackendHostState;
  pid: number;
  mode: AppConfig["mode"];
  port: number;
  tunnelReady: boolean | null;
}

export interface BackendHostDependencies {
  startServer: (config: AppConfig) => BackendServer;
  connectTunnel: (config: AppConfig) => void;
  waitForTunnelReady: (config: AppConfig) => Promise<TunnelRuntimeStatus>;
  stopTunnel: (config: AppConfig) => void;
}

const defaultDependencies: BackendHostDependencies = {
  startServer,
  connectTunnel,
  waitForTunnelReady,
  stopTunnel,
};

export class BackendHost {
  private readonly dependencies: BackendHostDependencies;
  private state: BackendHostState = "stopped";
  private server?: BackendServer;
  private tunnelStarted = false;
  private startPromise?: Promise<BackendHostStatus>;
  private stopPromise?: Promise<void>;
  private tunnelReady: boolean | null = null;
  private idleTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: AppConfig,
    dependencies: Partial<BackendHostDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  currentStatus(): BackendHostStatus {
    return {
      state: this.state,
      pid: process.pid,
      mode: this.config.mode,
      port: this.config.port,
      tunnelReady: this.tunnelReady,
    };
  }

  async start(): Promise<BackendHostStatus> {
    if (this.stopPromise) await this.stopPromise;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = undefined;
    }
  }

  private async startInternal(): Promise<BackendHostStatus> {
    if (this.state === "ready") return this.currentStatus();
    if (this.config.browserHost === "launcher") {
      throw new Error("Backend Host requires managed-chrome; Launcher-owned browser turns are not headless");
    }
    this.state = "starting";
    this.tunnelReady = this.config.mode === "full" ? false : null;
    try {
      if (this.config.mode === "full") {
        this.tunnelStarted = true;
        this.dependencies.connectTunnel(this.config);
        const tunnel = await this.dependencies.waitForTunnelReady(this.config);
        if (!tunnel.ok) throw new Error(`Tunnel runtime did not become ready: ${tunnel.detail}`);
        this.tunnelReady = true;
      }
      this.server = this.dependencies.startServer(this.config);
      this.state = "ready";
      this.scheduleIdleShutdown();
      return this.currentStatus();
    } catch (error) {
      this.state = "failed";
      await this.cleanupAfterStartFailure(error);
      throw error;
    }
  }

  private async cleanupAfterStartFailure(error: unknown): Promise<void> {
    this.clearIdleShutdown();
    const failures: unknown[] = [];
    if (this.server) {
      try {
        await this.server.shutdown();
      } catch (caught) {
        failures.push(caught);
      }
      this.server = undefined;
    }
    if (this.tunnelStarted) {
      try {
        this.dependencies.stopTunnel(this.config);
      } catch (caught) {
        failures.push(caught);
      }
      this.tunnelStarted = false;
    }
    if (failures.length > 0) {
      const detail = failures.map(failure => failure instanceof Error ? failure.message : String(failure)).join("; ");
      throw new Error(`${error instanceof Error ? error.message : String(error)}; startup cleanup failed: ${detail}`);
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.state === "stopped") return;
    this.clearIdleShutdown();
    this.state = "stopping";
    const failures: unknown[] = [];
    if (this.server) {
      try {
        await this.server.shutdown();
      } catch (error) {
        failures.push(error);
      }
      this.server = undefined;
    }
    if (this.tunnelStarted) {
      try {
        this.dependencies.stopTunnel(this.config);
      } catch (error) {
        failures.push(error);
      }
      this.tunnelStarted = false;
    }
    this.tunnelReady = this.config.mode === "full" ? false : null;
    this.state = failures.length > 0 ? "failed" : "stopped";
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        failures.map(error => error instanceof Error ? error.message : String(error)).join("; "),
      );
    }
  }

  private scheduleIdleShutdown(): void {
    if (!this.server?.isIdle) return;
    this.clearIdleShutdown();
    this.idleTimer = setInterval(() => {
      if (this.state !== "ready" || !this.server?.isIdle?.()) return;
      void this.stop().catch(error => {
        process.exitCode = 1;
        console.error(`[codex-chatgpt-web] idle shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 5_000);
    this.idleTimer.unref?.();
  }

  private clearIdleShutdown(): void {
    if (!this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = undefined;
  }
}
