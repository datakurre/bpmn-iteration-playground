// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudio, type Studio } from "./server.ts";
import { ensurePaths, paths as resolvePaths, type Paths } from "../agent/paths.ts";
import { SessionStore } from "../agent/session-store.ts";
import { runGraph } from "../agent/engine.ts";
import { ok } from "../agent/harness.ts";

let paths: Paths;
let studio: Studio;
const project = "/tmp/some-project";

const NS =
  'xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

const graph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_session" ${NS}>
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <bpmn:userTask id="gate" name="Gate">
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="f2" sourceRef="gate" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** Same graph, plus a service task spliced between gate and end -- additive, no live element touched. */
const graphWithSplice = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_session" ${NS}>
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <bpmn:userTask id="gate" name="Gate">
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="f2" sourceRef="gate" targetRef="shell_check" />
    <bpmn:serviceTask id="shell_check" name="Check">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="shell" />
        <zeebe:taskHeaders><zeebe:header key="command" value="true" /></zeebe:taskHeaders>
      </bpmn:extensionElements>
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f3" sourceRef="shell_check" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f3</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

/** Removes "gate" (deleting an unvisited element is fine) but keeps "start" reachable. */
const graphWithoutGate = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_session" ${NS}>
  <bpmn:process id="session" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f1</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

function createSession(id: string, live: string[] = [], sessionProject: string = project): SessionStore {
  const store = new SessionStore(paths, id);
  store.create(sessionProject);
  store.appendGraph(graph, "started", []);
  store.update((meta) => {
    meta.visited = live;
  });
  return store;
}

beforeEach(async () => {
  const home = mkdtempSync(join(tmpdir(), "graph-agent-studio-"));
  paths = ensurePaths(
    resolvePaths({ XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") } as NodeJS.ProcessEnv),
  );
  studio = await startStudio({ paths, project, port: 0 });
});

afterEach(async () => {
  await studio.close();
});

describe("GET /api/sessions", () => {
  it("returns all sessions across projects by default", async () => {
    createSession("s1", [], project);
    createSession("s2", [], "/tmp/other-project");

    const res = await fetch(`${studio.url}/api/sessions`);
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as Array<{ id: string; project: string }>;
    expect(sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("filters to project when scope=project is requested", async () => {
    createSession("s1", [], project);
    createSession("s2", [], "/tmp/other-project");

    const res = await fetch(`${studio.url}/api/sessions?scope=project`);
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as Array<{ id: string; project: string }>;
    expect(sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("returns all sessions when scope=all is requested", async () => {
    createSession("s1", [], project);
    createSession("s2", [], "/tmp/other-project");

    const res = await fetch(`${studio.url}/api/sessions?scope=all`);
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as Array<{ id: string; project: string }>;
    expect(sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });
});

describe("GET /api/sessions/:id/graph", () => {
  it("returns the session's current graph XML", async () => {
    createSession("s1");
    const res = await fetch(`${studio.url}/api/sessions/s1/graph`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(graph);
  });

  it("404s for an unknown session", async () => {
    const res = await fetch(`${studio.url}/api/sessions/nope/graph`);
    expect(res.status).toBe(404);
  });

  it("carries an ETag naming the current revision count (issue #76)", async () => {
    createSession("s1b");
    const res = await fetch(`${studio.url}/api/sessions/s1b/graph`);
    expect(res.headers.get("etag")).toBe("1");
  });
});

describe("PUT /api/sessions/:id/graph (issue #46)", () => {
  it("accepts an additive edit and appends a revision", async () => {
    const store = createSession("s2");
    const res = await fetch(`${studio.url}/api/sessions/s2/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithSplice }),
    });
    expect(res.status).toBe(200);
    expect(store.readMeta().revisions).toHaveLength(2);
    expect(store.readMeta().revisions[1]?.reason).toBe("studio edit");
    expect(store.currentGraph()).toBe(graphWithSplice);
  });

  it("accepts deleting an element the token has never reached", async () => {
    createSession("s3", []);
    const res = await fetch(`${studio.url}/api/sessions/s3/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithoutGate }),
    });
    expect(res.status).toBe(200);
  });

  it("409s when the edit removes an element that carries live state", async () => {
    createSession("s4", ["gate"]);
    const res = await fetch(`${studio.url}/api/sessions/s4/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithoutGate }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; removed: string[] };
    expect(body.removed).toEqual(["gate"]);
    expect(body.error).toMatch(/live state/);
  });

  it("409s on a rename from an earlier pass, not just the most recent one (issue #59)", async () => {
    // Mirrors what runner.ts's onTokens now does across a splice re-entry:
    // two separate calls, each merging its own pass's tokens into
    // meta.visited rather than replacing it. Before the fix, the second call
    // would have replaced ["gate"] with ["shell_check"] outright, and this
    // PUT would have been wrongly accepted.
    const store = createSession("s4b", []);
    store.markVisited(["gate"]);
    store.markVisited(["shell_check"]);
    const res = await fetch(`${studio.url}/api/sessions/s4b/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithoutGate }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; removed: string[] };
    expect(body.removed).toEqual(["gate"]);
  });

  /** start -> call (callActivity) -> gate2 (parks) -> end; callee: c_start -> c_turn -> c_end. */
  const graphWithCompletedCallee = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_migration" ${NS}>
  <bpmn:process id="p" isExecutable="true">
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="call" />
    <bpmn:callActivity id="call" calledElement="callee">
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:callActivity>
    <bpmn:sequenceFlow id="f2" sourceRef="call" targetRef="gate2" />
    <bpmn:userTask id="gate2" name="Gate 2">
      <bpmn:incoming>f2</bpmn:incoming><bpmn:outgoing>f3</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="f3" sourceRef="gate2" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f3</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
  <bpmn:process id="callee" isExecutable="false">
    <bpmn:startEvent id="c_start"><bpmn:outgoing>cf1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="cf1" sourceRef="c_start" targetRef="c_turn" />
    <bpmn:serviceTask id="c_turn">
      <bpmn:extensionElements><zeebe:taskDefinition type="agent:turn" /></bpmn:extensionElements>
      <bpmn:incoming>cf1</bpmn:incoming><bpmn:outgoing>cf2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="cf2" sourceRef="c_turn" targetRef="c_end" />
    <bpmn:endEvent id="c_end"><bpmn:incoming>cf2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

  /** Removes c_turn -- fine once callee has completed and returned. */
  const graphWithCompletedCalleeMinusCTurn = graphWithCompletedCallee
    .replace('<bpmn:sequenceFlow id="cf1" sourceRef="c_start" targetRef="c_turn" />', '<bpmn:sequenceFlow id="cf1" sourceRef="c_start" targetRef="c_end" />')
    .replace(
      /<bpmn:serviceTask id="c_turn">[\s\S]*?<\/bpmn:serviceTask>\s*<bpmn:sequenceFlow id="cf2" sourceRef="c_turn" targetRef="c_end" \/>\s*/,
      "",
    );

  /** Removes gate2 -- rejected: it is where the run is actually parked. */
  const graphWithCompletedCalleeMinusGate2 = graphWithCompletedCallee
    .replace('<bpmn:sequenceFlow id="f2" sourceRef="call" targetRef="gate2" />', '<bpmn:sequenceFlow id="f2" sourceRef="call" targetRef="end" />')
    .replace(
      /<bpmn:userTask id="gate2" name="Gate 2">[\s\S]*?<\/bpmn:userTask>\s*<bpmn:sequenceFlow id="f3" sourceRef="gate2" targetRef="end" \/>\s*/,
      "",
    );

  it("derives live state from the engine snapshot, not cumulative meta.visited (issue #70)", async () => {
    // callee (and c_turn inside it) has already run to completion and
    // returned by the time this run parks on gate2 -- bpmn-elements removes a
    // called process from its own running set the moment it ends, so a fresh
    // snapshot no longer carries c_turn as live, even though the session as a
    // whole ("p") is merely parked, not completed.
    const result = await runGraph(graphWithCompletedCallee, {
      harnesses: { "agent:turn": async () => ok("done") },
      onWait: () => undefined,
    });
    expect(result.outcome).toBe("stopped");

    const store = new SessionStore(paths, "s6");
    store.create(project);
    store.appendGraph(graphWithCompletedCallee, "started", []);
    store.writeEngineState(result.state);
    store.update((meta) => {
      meta.status = "wait";
      meta.tokens = ["gate2"];
      // A stale, over-broad cumulative record on purpose: proves this PUT
      // consults the snapshot instead, not meta.visited.
      meta.visited = ["start", "call", "c_start", "c_turn", "c_end"];
    });

    const removingCTurn = await fetch(`${studio.url}/api/sessions/s6/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithCompletedCalleeMinusCTurn }),
    });
    expect(removingCTurn.status).toBe(200);

    // Restore the graph the snapshot actually matches before the next PUT.
    store.appendGraph(graphWithCompletedCallee, "restore for next check", []);

    const removingGate2 = await fetch(`${studio.url}/api/sessions/s6/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "3" },
      body: JSON.stringify({ xml: graphWithCompletedCalleeMinusGate2 }),
    });
    expect(removingGate2.status).toBe(409);
    const body = (await removingGate2.json()) as { error: string; removed: string[] };
    expect(body.removed).toEqual(["gate2"]);
  });

  it("lets a completed session's graph be edited freely, regardless of what it ever visited (issue #70)", async () => {
    const store = createSession("s6b", ["gate"]);
    store.update((meta) => {
      meta.status = "completed";
      meta.tokens = [];
    });

    const res = await fetch(`${studio.url}/api/sessions/s6b/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithoutGate }),
    });
    expect(res.status).toBe(200);
  });

  it("409s (via checkMigration's job-type contract) on an unregistered job type", async () => {
    createSession("s5");
    const withBadJobType = graphWithSplice.replace('type="shell"', 'type="shell:exec"');
    const res = await fetch(`${studio.url}/api/sessions/s5/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: withBadJobType }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/shell:exec/);
  });

  it("404s for an unknown session", async () => {
    const res = await fetch(`${studio.url}/api/sessions/nope/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xml: graph }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/sessions/:id/graph optimistic concurrency (issue #76)", () => {
  it("400s without an If-Match header", async () => {
    createSession("c1");
    const res = await fetch(`${studio.url}/api/sessions/c1/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xml: graphWithSplice }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/If-Match/);
  });

  it("two sequential PUTs from the same loaded revision: the first succeeds, the second gets 409 naming the current revision", async () => {
    const store = createSession("c2");
    const first = await fetch(`${studio.url}/api/sessions/c2/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithSplice }),
    });
    expect(first.status).toBe(200);
    expect((await first.json()) as { revisions: number }).toEqual({ revisions: 2 });

    // A second editor who loaded the graph at the same revision -- before
    // the first PUT landed -- tries to save with the same stale If-Match.
    const second = await fetch(`${studio.url}/api/sessions/c2/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithoutGate }),
    });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: string; revision: number; conflict: string; removed?: string[] };
    expect(body.revision).toBe(2);
    expect(body.conflict).toBe("stale");
    // Never silently applied: still the first editor's revision.
    expect(store.currentGraph()).toBe(graphWithSplice);
    expect(store.readMeta().revisions).toHaveLength(2);
  });

  it("rejects a stale If-Match distinctly from a migration rejection", async () => {
    createSession("c3", ["gate"]);
    const res = await fetch(`${studio.url}/api/sessions/c3/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithoutGate }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { conflict: string };
    expect(body.conflict).toBe("migration");
  });

  it("accepts an edit to a session with a live driving process, and says so", async () => {
    const store = createSession("c4");
    store.update((meta) => {
      // This test process itself is alive for the whole run, so this is a
      // real, live pid rather than a stand-in.
      meta.pid = process.pid;
      meta.status = "running";
    });
    const res = await fetch(`${studio.url}/api/sessions/c4/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithSplice }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { revisions: number; note?: string };
    expect(body.note).toMatch(/pick.*up automatically/);
  });

  it("does not claim a pickup note for a session with no live process", async () => {
    createSession("c5");
    const res = await fetch(`${studio.url}/api/sessions/c5/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": "1" },
      body: JSON.stringify({ xml: graphWithSplice }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { note?: string };
    expect(body.note).toBeUndefined();
  });
});

const graphWithForm = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_session" ${NS}>
  <bpmn:process id="session" isExecutable="true">
    <bpmn:extensionElements>
      <zeebe:userTaskForm id="intent_form">{"components":[{"key":"intent","type":"textfield"}]}</zeebe:userTaskForm>
    </bpmn:extensionElements>
    <bpmn:startEvent id="start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="gate" />
    <bpmn:userTask id="gate" name="What next?">
      <bpmn:documentation>Say what you want done.</bpmn:documentation>
      <bpmn:extensionElements>
        <zeebe:userTask />
        <zeebe:formDefinition formId="intent_form" />
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="f2" sourceRef="gate" targetRef="end" />
    <bpmn:endEvent id="end"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
</bpmn:definitions>`;

function createParkedSession(id: string): SessionStore {
  const store = new SessionStore(paths, id);
  store.create(project);
  store.appendGraph(graphWithForm, "started", []);
  store.update((meta) => {
    meta.tokens = ["gate"];
    meta.visited = ["start"];
  });
  return store;
}

describe("GET /api/sessions/:id/pending (issue #51)", () => {
  it("describes a parked user task's form", async () => {
    createParkedSession("p1");
    const res = await fetch(`${studio.url}/api/sessions/p1/pending`);
    expect(res.status).toBe(200);
    const gates = (await res.json()) as Array<{ id: string; name?: string; form?: { formId: string; schema: string } }>;
    expect(gates).toHaveLength(1);
    expect(gates[0]?.id).toBe("gate");
    expect(gates[0]?.name).toBe("What next?");
    expect(gates[0]?.form?.formId).toBe("intent_form");
  });

  it("reports a queued answer as already answered", async () => {
    const store = createParkedSession("p2");
    store.queueAnswer("gate", { intent: "do the thing" });
    const res = await fetch(`${studio.url}/api/sessions/p2/pending`);
    const gates = (await res.json()) as Array<{ id: string; answered: boolean }>;
    expect(gates[0]?.answered).toBe(true);
  });

  it("is empty when nothing is parked", async () => {
    const store = new SessionStore(paths, "p3");
    store.create(project);
    store.appendGraph(graphWithForm, "started", []);
    const res = await fetch(`${studio.url}/api/sessions/p3/pending`);
    expect(await res.json()).toEqual([]);
  });

  it("404s for an unknown session", async () => {
    const res = await fetch(`${studio.url}/api/sessions/nope/pending`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sessions/:id/answer (issue #51)", () => {
  it("queues an answer the running graph can pick up", async () => {
    const store = createParkedSession("a1");
    const res = await fetch(`${studio.url}/api/sessions/a1/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityId: "gate", payload: { intent: "do the thing" } }),
    });
    expect(res.status).toBe(200);
    expect(store.takeAnswer("gate")).toEqual({ intent: "do the thing" });
    // Consumed, not left behind for a second consumer.
    expect(store.takeAnswer("gate")).toBeUndefined();
  });

  it("400s without activityId or payload", async () => {
    createParkedSession("a2");
    const res = await fetch(`${studio.url}/api/sessions/a2/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityId: "gate" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s for an unknown session", async () => {
    const res = await fetch(`${studio.url}/api/sessions/nope/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ activityId: "gate", payload: {} }),
    });
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/graphs/:id optimistic concurrency (issue #76)", () => {
  const libraryGraph = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions id="Defs_lib" ${NS}>
  <bpmn:process id="lib" isExecutable="true">
    <bpmn:startEvent id="start" />
  </bpmn:process>
</bpmn:definitions>`;

  it("GET carries an ETag; a PUT with a matching If-Match succeeds", async () => {
    writeFileSync(join(paths.workflowsDir, "lib.bpmn"), libraryGraph);
    const got = await fetch(`${studio.url}/api/graphs/lib`);
    const etag = got.headers.get("etag");
    expect(etag).toBeTruthy();

    const res = await fetch(`${studio.url}/api/graphs/lib`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": etag as string },
      body: JSON.stringify({ xml: libraryGraph.replace("lib", "lib2") }),
    });
    expect(res.status).toBe(200);
  });

  it("409s a stale If-Match rather than overwriting someone else's write", async () => {
    writeFileSync(join(paths.workflowsDir, "lib2.bpmn"), libraryGraph);
    const got = await fetch(`${studio.url}/api/graphs/lib2`);
    const staleEtag = got.headers.get("etag") as string;

    // Someone else's write lands first.
    await fetch(`${studio.url}/api/graphs/lib2`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": staleEtag },
      body: JSON.stringify({ xml: libraryGraph.replace("lib", "libx") }),
    });

    const res = await fetch(`${studio.url}/api/graphs/lib2`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": staleEtag },
      body: JSON.stringify({ xml: libraryGraph.replace("lib", "liby") }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; etag: string; conflict: string };
    expect(body.conflict).toBe("stale");
    expect(body.etag).not.toBe(staleEtag);
  });

  it("allows a PUT with no If-Match at all -- lower stakes than a session's own graph", async () => {
    const res = await fetch(`${studio.url}/api/graphs/brand_new`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xml: libraryGraph.replace("lib", "brand_new") }),
    });
    expect(res.status).toBe(200);
  });
});
