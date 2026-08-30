// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudio, type Studio } from "./server.ts";
import { ensurePaths, paths as resolvePaths, type Paths } from "../agent/paths.ts";
import { SessionStore } from "../agent/session-store.ts";

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

function createSession(id: string, live: string[] = []): SessionStore {
  const store = new SessionStore(paths, id);
  store.create(project);
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
});

describe("PUT /api/sessions/:id/graph (issue #46)", () => {
  it("accepts an additive edit and appends a revision", async () => {
    const store = createSession("s2");
    const res = await fetch(`${studio.url}/api/sessions/s2/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
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
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xml: graphWithoutGate }),
    });
    expect(res.status).toBe(200);
  });

  it("409s when the edit removes an element that carries live state", async () => {
    createSession("s4", ["gate"]);
    const res = await fetch(`${studio.url}/api/sessions/s4/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xml: graphWithoutGate }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; removed: string[] };
    expect(body.removed).toEqual(["gate"]);
    expect(body.error).toMatch(/live state/);
  });

  it("409s (via checkMigration's job-type contract) on an unregistered job type", async () => {
    createSession("s5");
    const withBadJobType = graphWithSplice.replace('type="shell"', 'type="shell:exec"');
    const res = await fetch(`${studio.url}/api/sessions/s5/graph`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
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
