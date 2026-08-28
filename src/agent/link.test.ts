// @vitest-environment node
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Engine } from "bpmn-engine";
import { calledElements, indexLibrary, linkGraph, LinkError, type LibraryIndex } from "./link.ts";
import { MODDLE_OPTIONS, toSourceContext, type EngineConstructor } from "./graph.ts";
import { BpmnModdle } from "bpmn-moddle";

const NS =
  'xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';

const parent = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_parent" ${NS}>
  <process id="parent" isExecutable="true">
    <startEvent id="p_start" /><sequenceFlow id="pf1" sourceRef="p_start" targetRef="call" />
    <callActivity id="call" calledElement="child" />
    <sequenceFlow id="pf2" sourceRef="call" targetRef="p_end" /><endEvent id="p_end" />
  </process>
</definitions>`;

const child = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_child" ${NS}>
  <process id="child" isExecutable="true">
    <startEvent id="c_start" /><sequenceFlow id="cf1" sourceRef="c_start" targetRef="c_task" />
    <task id="c_task" />
    <sequenceFlow id="cf2" sourceRef="c_task" targetRef="c_end" /><endEvent id="c_end" />
  </process>
</definitions>`;

/** child that itself calls a third graph */
const childCallingGrandchild = child
  .replace('<task id="c_task" />', '<callActivity id="c_task" calledElement="grandchild" />');

const grandchild = `<?xml version="1.0" encoding="UTF-8"?>
<definitions id="Defs_grandchild" ${NS}>
  <process id="grandchild" isExecutable="true">
    <startEvent id="g_start" /><sequenceFlow id="gf1" sourceRef="g_start" targetRef="g_end" />
    <endEvent id="g_end" />
  </process>
</definitions>`;

async function library(files: Array<{ source: string; xml: string }>): Promise<LibraryIndex> {
  return indexLibrary(files);
}

async function processesIn(xml: string): Promise<Array<{ id: string; isExecutable: unknown }>> {
  const { rootElement } = await new BpmnModdle(MODDLE_OPTIONS).fromXML(xml);
  return ((rootElement as unknown as { rootElements: Array<Record<string, unknown>> }).rootElements ?? [])
    .filter((e) => e.$type === "bpmn:Process")
    .map((e) => ({ id: String(e.id), isExecutable: e.isExecutable }));
}

describe("indexLibrary", () => {
  it("indexes by process id, since that is what calledElement names", async () => {
    const index = await library([{ source: "craft-graph.bpmn", xml: child }]);
    expect([...index.keys()]).toEqual(["child"]);
  });

  it("lets a later file shadow an earlier one", async () => {
    const index = await library([
      { source: "bundled.bpmn", xml: child },
      { source: "user.bpmn", xml: child },
    ]);
    expect(index.get("child")?.source).toBe("user.bpmn");
  });

  it("skips a file that does not parse rather than failing the session", async () => {
    const index = await library([
      { source: "broken.bpmn", xml: "<not-bpmn>" },
      { source: "ok.bpmn", xml: child },
    ]);
    expect([...index.keys()]).toEqual(["child"]);
  });
});

describe("calledElements", () => {
  it("finds call activities anywhere in the tree", async () => {
    const { rootElement } = await new BpmnModdle(MODDLE_OPTIONS).fromXML(parent);
    expect(calledElements(rootElement as never)).toEqual(["child"]);
  });
});

describe("linkGraph", () => {
  it("appends the called process into the definition", async () => {
    const result = await linkGraph(parent, await library([{ source: "child.bpmn", xml: child }]));
    expect(result.linked).toEqual(["child"]);
    expect((await processesIn(result.xml)).map((p) => p.id).sort()).toEqual(["child", "parent"]);
  });

  it("marks a linked process non-executable so it is not also auto-started", async () => {
    // Left executable, bpmn-engine runs the callee as a top-level process AND
    // through the call, so its body executes twice.
    const result = await linkGraph(parent, await library([{ source: "child.bpmn", xml: child }]));
    const found = await processesIn(result.xml);
    expect(found.find((p) => p.id === "parent")?.isExecutable).toBe(true);
    expect(found.find((p) => p.id === "child")?.isExecutable).toBe(false);
  });

  it("resolves transitively", async () => {
    const result = await linkGraph(
      parent,
      await library([
        { source: "child.bpmn", xml: childCallingGrandchild },
        { source: "grandchild.bpmn", xml: grandchild },
      ]),
    );
    expect(result.linked).toEqual(["child", "grandchild"]);
    expect((await processesIn(result.xml)).map((p) => p.id).sort()).toEqual(["child", "grandchild", "parent"]);
  });

  it("leaves a graph with no call activities untouched", async () => {
    const result = await linkGraph(child, await library([]));
    expect(result.linked).toEqual([]);
    expect(result.xml).toBe(child);
  });

  it("refuses a calledElement nothing in the library defines", async () => {
    await expect(linkGraph(parent, await library([]))).rejects.toBeInstanceOf(LinkError);
    await expect(linkGraph(parent, await library([]))).rejects.toThrow(/no graph in the library defines a process 'child'/);
  });

  it("refuses a link that would duplicate an element id", async () => {
    // Recovery replays child state by element id, so a collision is unrecoverable.
    const colliding = child.replace('<task id="c_task" />', '<task id="p_end" />');
    await expect(
      linkGraph(parent, await library([{ source: "collide.bpmn", xml: colliding }])),
    ).rejects.toThrow(/duplicate element id/);
  });

  it("terminates on a call graph that loops back", async () => {
    // parent -> child -> parent. Each process is linked at most once, so the
    // second call finds parent already present and linking stops. Whether such a
    // graph recurses forever at *runtime* is the model's problem, not the
    // linker's.
    const selfCalling = child.replace('<task id="c_task" />', '<callActivity id="c_task" calledElement="parent" />');
    const result = await linkGraph(parent, await library([{ source: "child.bpmn", xml: selfCalling }]));
    expect(result.linked).toEqual(["child"]);
    expect((await processesIn(result.xml)).map((p) => p.id).sort()).toEqual(["child", "parent"]);
  });

  it("leaves an expression calledElement alone and reports it", async () => {
    const dynamicParent = parent.replace('calledElement="child"', 'calledElement="=next_graph"');
    const result = await linkGraph(dynamicParent, await library([{ source: "child.bpmn", xml: child }]));
    expect(result.linked).toEqual([]);
    expect(result.dynamic).toEqual(["=next_graph"]);
  });
});

describe("a linked graph on the real engine", () => {
  it("runs the called process exactly once", async () => {
    const result = await linkGraph(parent, await library([{ source: "child.bpmn", xml: child }]));
    const ended: string[] = [];
    const engine = new (Engine as unknown as EngineConstructor)({
      name: "linked",
      sourceContext: await toSourceContext(result.xml),
      moddleOptions: MODDLE_OPTIONS,
    });
    const listener = new EventEmitter();
    listener.on("activity.end", (api: { id: string }) => ended.push(api.id));
    const done = engine.waitFor("end");
    await engine.execute({ listener });
    await done;

    expect(ended).toContain("call");
    // exactly one run of the callee's body, not two
    expect(ended.filter((id) => id === "c_task")).toHaveLength(1);
    expect(ended.filter((id) => id === "c_end")).toHaveLength(1);
  });
});
