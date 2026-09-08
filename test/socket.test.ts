import assert from "node:assert/strict";
import * as net from "node:net";
import { after, describe, it } from "node:test";
import { join } from "node:path";
import { rmSync } from "node:fs";

import { buildRequest, HerdrReporter, isHerdrPane } from "../src/socket.js";

describe("isHerdrPane", () => {
  it("requires all three herdr markers", () => {
    assert.equal(isHerdrPane({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "p" }), true);
    assert.equal(isHerdrPane({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s" }), false);
    assert.equal(isHerdrPane({ HERDR_ENV: "0", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "p" }), false);
    assert.equal(isHerdrPane({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "", HERDR_PANE_ID: "p" }), false);
  });
});

describe("buildRequest", () => {
  it("stamps pane id, source, agent, and seq", () => {
    const request = buildRequest("pane.report_agent", { state: "working" }, {
      paneId: "pane-1",
      seq: 42,
      now: 1_000,
    });
    assert.equal(request.method, "pane.report_agent");
    assert.match(request.id, /^herdr:opencode:1000:\d{6}$/);
    assert.deepEqual(request.params, {
      pane_id: "pane-1",
      source: "herdr:opencode",
      agent: "opencode",
      seq: 42,
      state: "working",
    });
  });

  it("lets callers override source/agent and merge extra params", () => {
    const request = buildRequest(
      "pane.report_agent_session",
      { agent_session_id: "ses_1", session_start_source: "new" },
      { paneId: "p", source: "herdr:opencode", agent: "opencode", seq: 1, now: 5 },
    );
    assert.deepEqual(request.params, {
      pane_id: "p",
      source: "herdr:opencode",
      agent: "opencode",
      seq: 1,
      agent_session_id: "ses_1",
      session_start_source: "new",
    });
  });
});

describe("HerdrReporter", () => {
  // macOS caps unix socket paths at ~104 chars; the default tmpdir is longer,
  // so test sockets live directly under /tmp with short names.
  const dir = "/tmp";
  after(() => {
    for (const file of ["herdr-oc-test.sock", "herdr-oc-missing.sock"]) {
      rmSync(join("/tmp", file), { force: true });
    }
  });

  it("is inactive without a socket path", async () => {
    const reporter = new HerdrReporter({ paneId: "p", env: {} });
    assert.equal(reporter.active, false);
    // Inactive reporters resolve without touching the network.
    await reporter.reportState("idle");
  });

  it("writes line-delimited JSON requests in order to the herdr socket", async () => {
    const socketPath = join(dir, "herdr-oc-test.sock");
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim()) received.push(line);
        }
        socket.write('{"ok":true}\n'); // herdr answers; the reporter hangs up
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const reporter = new HerdrReporter({ socketPath, paneId: "pane-9", timeoutMs: 2_000 });
    assert.equal(reporter.active, true);

    await Promise.all([
      reporter.reportState("working", "ses_a"),
      reporter.reportState("blocked"),
      reporter.reportSession("ses_b", "new"),
    ]);

    assert.equal(received.length, 3);
    const parsed = received.map((line) => JSON.parse(line));
    assert.deepEqual(
      parsed.map((request) => request.method),
      ["pane.report_agent", "pane.report_agent", "pane.report_agent_session"],
    );
    assert.equal(parsed[0].params.pane_id, "pane-9");
    assert.equal(parsed[0].params.source, "herdr:opencode");
    assert.equal(parsed[0].params.agent, "opencode");
    assert.equal(parsed[0].params.state, "working");
    assert.equal(parsed[0].params.agent_session_id, "ses_a");
    assert.ok(parsed[1].params.seq > parsed[0].params.seq, "seq is monotonic");
    assert.deepEqual(parsed[2].params, {
      pane_id: "pane-9",
      source: "herdr:opencode",
      agent: "opencode",
      seq: parsed[2].params.seq,
      agent_session_id: "ses_b",
      session_start_source: "new",
    });

    server.close();
  });

  it("resolves even when the socket is gone (reporting never breaks the host)", async () => {
    const reporter = new HerdrReporter({
      socketPath: join(dir, "herdr-oc-missing.sock"),
      paneId: "pane-x",
      timeoutMs: 100,
    });
    await reporter.reportState("idle"); // must resolve, not reject
  });
});
