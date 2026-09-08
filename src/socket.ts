// Wire protocol between this plugin and the Herdr daemon.
//
// The contract is line-delimited JSON over the Herdr socket: one request per
// connection, fire-and-forget. Requests carry the pane id and a monotonic seq
// so Herdr can order reports from the same pane. Kept deliberately close to
// Herdr's own opencode integration wire format so both can coexist and so the
// daemon-side semantics need no new code.

import * as net from "node:net";

/** Lifecycle states Herdr understands for an agent pane. */
export type HerdrState = "idle" | "working" | "blocked";

export const HERDR_SOURCE = "herdr:opencode";
export const HERDR_AGENT = "opencode";

/** Herdr injects these for every process it spawns inside a pane. */
export interface HerdrEnv {
  HERDR_ENV?: string;
  HERDR_SOCKET_PATH?: string;
  HERDR_PANE_ID?: string;
  /** Opt-in stderr trace: HERDR_OPENCODE_DEBUG=1 */
  HERDR_OPENCODE_DEBUG?: string;
}

export function isHerdrPane(env: HerdrEnv = process.env): boolean {
  return (
    env.HERDR_ENV === "1" &&
    typeof env.HERDR_SOCKET_PATH === "string" &&
    env.HERDR_SOCKET_PATH.length > 0 &&
    typeof env.HERDR_PANE_ID === "string" &&
    env.HERDR_PANE_ID.length > 0
  );
}

export type ReportMethod =
  | "pane.report_agent"
  | "pane.report_agent_session";

export interface HerdrRequest {
  id: string;
  method: ReportMethod;
  params: Record<string, unknown>;
}

/** Build one wire request. Pure; exported for tests. */
export function buildRequest(
  method: ReportMethod,
  params: Record<string, unknown>,
  opts: { paneId: string; source?: string; agent?: string; seq: number; now?: number },
): HerdrRequest {
  return {
    id: `${opts.source ?? HERDR_SOURCE}:${opts.now ?? Date.now()}:${Math.floor(
      Math.random() * 1_000_000,
    )
      .toString()
      .padStart(6, "0")}`,
    method,
    params: {
      pane_id: opts.paneId,
      source: opts.source ?? HERDR_SOURCE,
      agent: opts.agent ?? HERDR_AGENT,
      seq: opts.seq,
      ...params,
    },
  };
}

export interface ReporterOptions {
  socketPath?: string;
  paneId?: string;
  /** Environment used for defaults; defaults to process.env. Tests pass {} for hermetic behavior. */
  env?: HerdrEnv;
  /** Socket write timeout in ms. Herdr answers (or not) fast; never block the host. */
  timeoutMs?: number;
  /** Called when debug logging is requested via HERDR_OPENCODE_DEBUG=1. */
  debug?: (message: string) => void;
}

/**
 * Serialized, fire-and-forget reporter. One connection per report; a hung
 * socket costs `timeoutMs` once and then the chain moves on — reporting must
 * never degrade the host editor.
 */
export class HerdrReporter {
  private readonly socketPath?: string;
  private readonly paneId?: string;
  private readonly timeoutMs: number;
  private readonly debug?: (message: string) => void;
  private seq: number;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: ReporterOptions = {}) {
    const env = options.env ?? process.env;
    this.socketPath = options.socketPath ?? env.HERDR_SOCKET_PATH;
    this.paneId = options.paneId ?? env.HERDR_PANE_ID;
    this.timeoutMs = options.timeoutMs ?? 500;
    this.debug = options.debug;
    this.seq = Date.now() * 1000;
  }

  get active(): boolean {
    return (
      typeof this.socketPath === "string" &&
      this.socketPath.length > 0 &&
      typeof this.paneId === "string" &&
      this.paneId.length > 0
    );
  }

  reportState(state: HerdrState, sessionID?: string): Promise<void> {
    const params: Record<string, unknown> = { state };
    if (sessionID) params.agent_session_id = sessionID;
    return this.send("pane.report_agent", params);
  }

  reportSession(sessionID: string, sessionStartSource?: "new"): Promise<void> {
    const params: Record<string, unknown> = { agent_session_id: sessionID };
    if (sessionStartSource) params.session_start_source = sessionStartSource;
    return this.send("pane.report_agent_session", params);
  }

  private send(method: ReportMethod, params: Record<string, unknown>): Promise<void> {
    if (!this.active || !this.socketPath || !this.paneId) return Promise.resolve();
    this.seq += 1;
    const request = buildRequest(method, params, {
      paneId: this.paneId,
      seq: this.seq,
    });
    this.debug?.(`${method} ${JSON.stringify(params)}`);
    const pending = this.chain.then(() =>
      requestOnce(request, this.socketPath!, this.timeoutMs),
    );
    // A rejected report must never poison subsequent reports.
    this.chain = pending.catch(() => {});
    return pending;
  }
}

function requestOnce(
  request: HerdrRequest,
  socketEndpoint: string,
  timeoutMs: number,
): Promise<void> {
  // Windows named pipes take a \\.\pipe\ prefix; the daemon hands us the
  // bare name on both platforms.
  const endpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${socketEndpoint}` : socketEndpoint;

  return new Promise((resolve) => {
    const client = net.createConnection(endpoint, () => {
      client.write(`${JSON.stringify(request)}\n`);
    });
    const finish = () => {
      client.destroy();
      resolve();
    };
    client.setTimeout(timeoutMs, finish);
    client.on("data", finish);
    client.on("error", finish);
    client.on("end", finish);
    client.on("close", finish);
  });
}
