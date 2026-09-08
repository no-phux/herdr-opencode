// Event classification: OpenCode bus events → Herdr reports.
//
// Pure and host-agnostic. Both OpenCode v1 (`event` hook) and v2
// (`ctx.event.subscribe()`) deliver the same bus-event shape:
//   { type: string, properties: { sessionID?, info?: {id, parentID?}, status? } }
// so one classifier serves both hosts. This is also where the two defects in
// Herdr's stock opencode integration (herdr#2548) are fixed:
//   1. Root sessions were misclassified as children when `parentID` mirrored
//      `id`, so the early return swallowed every event.
//   2. Child-state reports dropped the parent association cleanly instead of
//      never reporting at all.

import type { HerdrState } from "./socket.js";

export interface HerdrEvent {
  type?: string;
  properties?: {
    sessionID?: unknown;
    info?: { id?: unknown; parentID?: unknown };
    status?: unknown;
    [key: string]: unknown;
  };
}

/** A report destined for the Herdr socket. */
export type Report =
  | { kind: "state"; state: HerdrState; sessionID?: string }
  | { kind: "session"; sessionID: string; sessionStartSource?: "new" };

/** Mutable classification state, one instance per plugin lifetime. */
export interface SessionTracker {
  childSessions: Set<string>;
  reportedRootSessionID?: string;
}

export function createTracker(): SessionTracker {
  return { childSessions: new Set() };
}

function sessionIDFrom(properties: HerdrEvent["properties"]): string | undefined {
  return typeof properties?.sessionID === "string" && properties.sessionID
    ? properties.sessionID
    : undefined;
}

/**
 * A session is a child (subagent) only when its info carries a parent that is
 * a different session. OpenCode 1.18+ echoes `info.id === sessionID` on root
 * sessions — treating that as a parent link was the bug in herdr#2548.
 */
function isChildSession(info: HerdrEvent["properties"] extends undefined ? never : NonNullable<HerdrEvent["properties"]>["info"]): boolean {
  return (
    typeof info?.id === "string" &&
    info.id.length > 0 &&
    typeof info.parentID === "string" &&
    info.parentID.length > 0 &&
    info.parentID !== info.id
  );
}

const SESSION_STATE_BY_STATUS: ReadonlyMap<string, HerdrState> = new Map([
  ["idle", "idle"],
  ["active", "working"],
  ["busy", "working"],
  ["pending", "working"],
  ["retry", "working"],
  ["running", "working"],
  ["streaming", "working"],
  ["working", "working"],
]);

export function stateFromSessionStatus(status: unknown): HerdrState | undefined {
  const kind = typeof status === "string" ? status : (status as { type?: unknown })?.type;
  return typeof kind === "string"
    ? SESSION_STATE_BY_STATUS.get(kind.toLowerCase())
    : undefined;
}

/** Child-session prompts still project state, without attaching the child id. */
const CHILD_EVENT_STATES: ReadonlyMap<string, HerdrState> = new Map([
  ["permission.asked", "blocked"],
  ["question.asked", "blocked"],
  ["permission.replied", "working"],
  ["question.replied", "working"],
  ["question.rejected", "working"],
]);

const ROOT_WORKING_EVENTS = new Set([
  "tool.execute.before",
  "tool.execute.after",
  "permission.replied",
  "question.replied",
  "question.rejected",
  "session.compacted",
]);

const ROOT_BLOCKED_EVENTS = new Set(["permission.asked", "question.asked", "session.error"]);

/**
 * Classify one bus event into zero or more Herdr reports. Never throws; an
 * unrecognized event classifies to [].
 */
export function classifyEvent(event: HerdrEvent, tracker: SessionTracker): Report[] {
  const type = typeof event?.type === "string" ? event.type : undefined;
  if (!type) return [];

  const properties = event.properties ?? {};
  const sessionID = sessionIDFrom(properties);

  const info = properties.info;
  if (isChildSession(info) && typeof info?.id === "string") {
    tracker.childSessions.add(info.id);
  }

  if (sessionID && tracker.childSessions.has(sessionID)) {
    const state = CHILD_EVENT_STATES.get(type);
    return state ? [{ kind: "state", state }] : [];
  }

  switch (type) {
    case "session.created":
      // A genuine new root session: `new` tells Herdr to replace the pane's
      // prior session id instead of treating the change as cross-talk.
      return sessionID
        ? [{ kind: "session", sessionID, sessionStartSource: "new" }]
        : [];
    case "session.updated":
      return sessionID && sessionID !== tracker.reportedRootSessionID
        ? [{ kind: "session", sessionID }]
        : [];
    case "session.status": {
      const state = stateFromSessionStatus(properties.status);
      if (state) return [{ kind: "state", state, sessionID }];
      return sessionID ? [{ kind: "session", sessionID }] : [];
    }
    case "session.idle":
      return [{ kind: "state", state: "idle", sessionID }];
    case "session.deleted":
      return [];
    default:
      if (ROOT_WORKING_EVENTS.has(type)) {
        return [{ kind: "state", state: "working", sessionID }];
      }
      if (ROOT_BLOCKED_EVENTS.has(type)) {
        return [{ kind: "state", state: "blocked", sessionID }];
      }
      return [];
  }
}

/** Record the side effects of dispatching reports so later events compare correctly. */
export function applyReports(reports: readonly Report[], tracker: SessionTracker): void {
  for (const report of reports) {
    // Faithful to Herdr's stock integration: only state reports carrying a
    // session id advance the reported root; bare session reports do not.
    if (report.kind === "state" && report.sessionID) {
      tracker.reportedRootSessionID = report.sessionID;
    }
  }
}
