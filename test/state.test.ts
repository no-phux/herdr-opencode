import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyReports,
  classifyEvent,
  createTracker,
  stateFromSessionStatus,
  type HerdrEvent,
} from "../src/state.js";

function rootEvent(type: string, extra: Record<string, unknown> = {}): HerdrEvent {
  return {
    type,
    properties: { sessionID: "ses_root", ...extra },
  };
}

describe("stateFromSessionStatus", () => {
  it("maps status objects and strings onto herdr states", () => {
    assert.equal(stateFromSessionStatus({ type: "busy" }), "working");
    assert.equal(stateFromSessionStatus("streaming"), "working");
    assert.equal(stateFromSessionStatus("idle"), "idle");
    assert.equal(stateFromSessionStatus(undefined), undefined);
    assert.equal(stateFromSessionStatus({ type: "mysterious" }), undefined);
  });
});

describe("classifyEvent", () => {
  it("reports a new root session on session.created", () => {
    const tracker = createTracker();
    assert.deepEqual(classifyEvent(rootEvent("session.created"), tracker), [
      { kind: "session", sessionID: "ses_root", sessionStartSource: "new" },
    ]);
  });

  it("maps session.status onto working/idle", () => {
    const tracker = createTracker();
    assert.deepEqual(
      classifyEvent(rootEvent("session.status", { status: { type: "busy" } }), tracker),
      [{ kind: "state", state: "working", sessionID: "ses_root" }],
    );
    assert.deepEqual(
      classifyEvent(rootEvent("session.status", { status: { type: "idle" } }), tracker),
      [{ kind: "state", state: "idle", sessionID: "ses_root" }],
    );
  });

  it("falls back to a bare session report for unknown statuses", () => {
    const tracker = createTracker();
    assert.deepEqual(
      classifyEvent(rootEvent("session.status", { status: { type: "quantum" } }), tracker),
      [{ kind: "session", sessionID: "ses_root" }],
    );
  });

  it("maps tool/permission lifecycle onto working and blocked", () => {
    const tracker = createTracker();
    assert.deepEqual(classifyEvent(rootEvent("tool.execute.before"), tracker), [
      { kind: "state", state: "working", sessionID: "ses_root" },
    ]);
    assert.deepEqual(classifyEvent(rootEvent("permission.asked"), tracker), [
      { kind: "state", state: "blocked", sessionID: "ses_root" },
    ]);
    assert.deepEqual(classifyEvent(rootEvent("session.idle"), tracker), [
      { kind: "state", state: "idle", sessionID: "ses_root" },
    ]);
    assert.deepEqual(classifyEvent(rootEvent("session.deleted"), tracker), []);
  });

  it("ignores unrecognized events and malformed payloads", () => {
    const tracker = createTracker();
    assert.deepEqual(classifyEvent({ type: "vibes.detected" }, tracker), []);
    assert.deepEqual(classifyEvent({}, tracker), []);
    assert.deepEqual(classifyEvent(undefined as unknown as HerdrEvent, tracker), []);
  });

  // Regression for herdr#2548 defect 2: OpenCode 1.18+ echoes info.id ===
  // sessionID (or omits parentID) on ROOT sessions. The stock integration
  // treated any info.id+parentID pair as a child and swallowed every event.
  it("does not classify root sessions as children", () => {
    const tracker = createTracker();
    const mirrored = rootEvent("session.status", {
      status: { type: "busy" },
      info: { id: "ses_root", parentID: "ses_root" },
    });
    assert.equal(classifyEvent(mirrored, tracker).length, 1);

    const parentless = rootEvent("session.created", {
      info: { id: "ses_root" },
    });
    assert.equal(classifyEvent(parentless, tracker).length, 1);
  });

  it("tracks real child sessions and only projects their permission states", () => {
    const tracker = createTracker();
    const created = classifyEvent(
      rootEvent("session.created", {
        sessionID: "ses_child",
        info: { id: "ses_child", parentID: "ses_root" },
      }),
      tracker,
    );
    assert.deepEqual(created, []); // child creates are dropped
    assert.ok(tracker.childSessions.has("ses_child"));

    assert.deepEqual(
      classifyEvent(rootEvent("session.status", { status: { type: "busy" }, sessionID: "ses_child" }), tracker),
      [], // child status must not replace the pane's root session
    );
    assert.deepEqual(
      classifyEvent({ type: "permission.asked", properties: { sessionID: "ses_child" } }, tracker),
      [{ kind: "state", state: "blocked" }], // no session id attached
    );
  });

  it("only re-reports the session on session.updated when it changed", () => {
    const tracker = createTracker();
    const status = classifyEvent(rootEvent("session.status", { status: { type: "busy" } }), tracker);
    applyReports(status, tracker);

    assert.deepEqual(classifyEvent(rootEvent("session.updated"), tracker), []);
    assert.deepEqual(classifyEvent(rootEvent("session.status", { status: { type: "busy" } }), tracker), [
      { kind: "state", state: "working", sessionID: "ses_root" },
    ]);

    // A genuinely new root id gets a bare session report (not "new").
    const switched = classifyEvent(
      rootEvent("session.updated", { sessionID: "ses_other" }),
      tracker,
    );
    assert.deepEqual(switched, [{ kind: "session", sessionID: "ses_other" }]);
  });
});
