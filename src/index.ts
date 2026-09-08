// herdr-opencode — native Herdr lifecycle reporting for OpenCode v1 AND v2.
//
// One entrypoint, two plugin registries:
//   * OpenCode v1 (>= 1.18.29) calls `server()` and uses the returned hooks.
//   * OpenCode v2 (`opencode2`) reads the default export's `id` + `setup()`.
// OpenCode's own docs bless exactly this dual shape, so one published package
// serves both hosts.
//
// The plugin reports the pane's lifecycle state (idle / working / blocked) and
// root session identity to the Herdr daemon over its socket, giving Herdr
// accurate agent-state rows and pane restore (`opencode --session <id>`). It
// fixes the two defects that leave Herdr's stock v1 integration silent on
// modern OpenCode (herdr#2548): named-export loading and root/child session
// misclassification. It is a complete no-op outside a Herdr pane.

import { HerdrReporter, isHerdrPane, type HerdrEnv } from "./socket.js";
import {
  applyReports,
  classifyEvent,
  createTracker,
  type HerdrEvent,
  type Report,
  type SessionTracker,
} from "./state.js";

export type { HerdrState } from "./socket.js";

function makeDebug(env: HerdrEnv): ((message: string) => void) | undefined {
  if (env.HERDR_OPENCODE_DEBUG !== "1") return undefined;
  return (message: string) =>
    console.error(`[herdr-opencode] ${message}`);
}

function makeReporter(env: HerdrEnv = process.env): HerdrReporter | undefined {
  if (!isHerdrPane(env)) return undefined;
  return new HerdrReporter({ debug: makeDebug(env) });
}

function dispatch(
  reporter: HerdrReporter,
  tracker: SessionTracker,
  reports: readonly Report[],
): Promise<void> {
  applyReports(reports, tracker);
  let pending: Promise<void> = Promise.resolve();
  for (const report of reports) {
    pending = pending.then(() =>
      report.kind === "session"
        ? reporter.reportSession(report.sessionID, report.sessionStartSource)
        : reporter.reportState(report.state, report.sessionID),
    );
  }
  return pending;
}

/** v1 hook surface (also what `server()` returns). */
interface V1Hooks {
  event: (input: { event: HerdrEvent }) => Promise<void>;
}

async function server(): Promise<V1Hooks> {
  const reporter = makeReporter();
  if (!reporter) return { event: async () => {} };
  const tracker = createTracker();
  return {
    event: async ({ event }) => {
      try {
        await dispatch(reporter, tracker, classifyEvent(event, tracker));
      } catch {
        // Reporting must never break the host session.
      }
    },
  };
}

/** v2 setup: subscribe to the event bus until the plugin unloads. */
async function setup(ctx: {
  event: { subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<HerdrEvent> };
}): Promise<(() => void) | void> {
  const reporter = makeReporter();
  if (!reporter) return;

  const tracker = createTracker();
  const controller = new AbortController();

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          await dispatch(reporter, tracker, classifyEvent(event, tracker));
        } catch {
          // Single-event failures must not kill the subscription.
        }
      }
    } catch {
      // Subscription died (host shutting down); Herdr falls back to its
      // screen-manifest detection until the next session starts.
    }
  })();

  return () => controller.abort();
}

/**
 * The dual-host entrypoint. v1 (>= 1.18.29) invokes `server()`; v2 reads `id`
 * + `setup()`. Plain object on purpose: no runtime dependency on either
 * host's plugin SDK, so the package stays loadable by both.
 */
export default {
  id: "herdr-opencode",
  setup,
  server,
};

/** Named export for v1 hosts that discover plugins by scanning named exports. */
export const HerdrOpencodePlugin = server;
