import { $ } from "../../js/lib/dom";
import { initResizer } from "../../js/lib/resizer";
import { fitDiagram, wireZoomControls } from "../../js/lib/bpmn-viewer-controls";
import type { BpmnDiagramInstance } from "../../js/lib/bpmn-types";
import { connectStudioEvents } from "./live";
import { mountShell } from "./shell";
import type { GraphSummary } from "../types";

let modeler: BpmnDiagramInstance | null = null;
let currentId = "";
/** The ETag `open()` loaded `currentId` at -- sent back as `If-Match` on save (issue #76), so overwriting a graph someone else just changed is refused rather than silent. Cleared whenever the name field no longer names what was loaded, e.g. a "Save As" under a fresh name has nothing to conflict with. */
let loadedEtag: string | null = null;

/** A new graph starts as one agent turn: the smallest thing that does something. */
const BLANK = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" id="Defs_new_graph" targetNamespace="http://graph-agent/bpmn">
  <bpmn:process id="new_graph" name="New graph" isExecutable="true">
    <bpmn:startEvent id="start" name="Start"><bpmn:outgoing>f1</bpmn:outgoing></bpmn:startEvent>
    <bpmn:sequenceFlow id="f1" sourceRef="start" targetRef="turn" />
    <bpmn:serviceTask id="turn" name="Agent turn">
      <bpmn:extensionElements>
        <zeebe:taskDefinition type="agent:turn" />
      </bpmn:extensionElements>
      <bpmn:incoming>f1</bpmn:incoming><bpmn:outgoing>f2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="f2" sourceRef="turn" targetRef="end" />
    <bpmn:endEvent id="end" name="Done"><bpmn:incoming>f2</bpmn:incoming></bpmn:endEvent>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="D"><bpmndi:BPMNPlane id="P" bpmnElement="new_graph">
    <bpmndi:BPMNShape id="start_di" bpmnElement="start"><dc:Bounds x="180" y="160" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="turn_di" bpmnElement="turn"><dc:Bounds x="270" y="138" width="120" height="80" /></bpmndi:BPMNShape>
    <bpmndi:BPMNShape id="end_di" bpmnElement="end"><dc:Bounds x="450" y="160" width="36" height="36" /></bpmndi:BPMNShape>
    <bpmndi:BPMNEdge id="f1_di" bpmnElement="f1"><di:waypoint x="216" y="178" /><di:waypoint x="270" y="178" /></bpmndi:BPMNEdge>
    <bpmndi:BPMNEdge id="f2_di" bpmnElement="f2"><di:waypoint x="390" y="178" /><di:waypoint x="450" y="178" /></bpmndi:BPMNEdge>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

function status(message: string, tone: "ok" | "error" | "none" = "none"): void {
  const host = $("save-msg");
  if (!host) return;
  host.classList.toggle("hidden", tone === "none");
  host.className =
    tone === "none"
      ? "hidden"
      : tone === "ok"
        ? "mb-2 p-2 rounded-md text-xs bg-accent-dim text-accent border border-accent-border"
        : "mb-2 p-2 rounded-md text-xs bg-danger-dim text-danger border border-danger-border";
  host.textContent = message;
}

async function loadList(selected?: string): Promise<void> {
  const select = $("graph-select") as HTMLSelectElement | null;
  if (!select) return;
  const res = await fetch("/api/graphs");
  if (!res.ok) return;
  const graphs: GraphSummary[] = await res.json();
  select.innerHTML = graphs
    .map((g) => `<option value="${g.id}">${g.name}${g.source === "bundled" ? " (bundled)" : ""}</option>`)
    .join("");
  if (selected) select.value = selected;
}

async function open(id: string): Promise<void> {
  if (!modeler) return;
  const res = await fetch(`/api/graphs/${encodeURIComponent(id)}`);
  if (!res.ok) return status(`Could not open ${id}`, "error");
  await modeler.importXML(await res.text());
  currentId = id;
  loadedEtag = res.headers.get("etag");
  const name = $("graph-name") as HTMLInputElement | null;
  if (name) name.value = id;
  fitDiagram(modeler);
  status("", "none");
}

async function save(): Promise<void> {
  if (!modeler) return;
  const name = ($("graph-name") as HTMLInputElement | null)?.value.trim() || currentId || "new_graph";
  const { xml } = await modeler.saveXML({ format: true });
  // Only the id actually loaded has an ETag to conflict against -- typing a
  // different name is a "Save As" into a graph nothing here has read yet.
  const ifMatch = name === currentId ? loadedEtag : null;
  const res = await fetch(`/api/graphs/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(ifMatch ? { "if-match": ifMatch } : {}) },
    body: JSON.stringify({ xml }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    status(`${body.error ?? "Cannot save: someone else's edit landed first"} Reopen it to reload it.`, "error");
    return;
  }
  if (!res.ok) return status(`Save failed: ${await res.text()}`, "error");
  const saved = (await res.json()) as { id: string; processIds: string[]; etag: string };
  currentId = saved.id;
  loadedEtag = saved.etag;
  // Saving a bundled graph writes a library copy that shadows it from now on.
  status(`Saved to your graph library as ${saved.id} (process ${saved.processIds.join(", ")})`, "ok");
  await loadList(saved.id);
}

async function init(): Promise<void> {
  await mountShell("graph");

  const ModelerCtor = window.BpmnModeler || window.BpmnJS;
  if (!ModelerCtor) return;
  modeler = new (
    ModelerCtor as new (options: {
      container: string;
      propertiesPanel?: { parent: string };
      additionalModules?: unknown[];
      moddleExtensions?: Record<string, unknown>;
      linting?: { bpmnlint: { config: { rules: Record<string, string> }; resolver: unknown }; active: boolean };
      elementTemplateIconRenderer?: { iconProperty: string };
    }) => BpmnDiagramInstance
  )({
    container: "#modeler",
    propertiesPanel: { parent: "#properties-panel" },
    additionalModules: [
      window.BpmnPropertiesPanelModule,
      window.BpmnPropertiesProviderModule,
      // The Cloud element-templates provider already includes the Zeebe property
      // groups itself, so it replaces ZeebePropertiesProviderModule rather than
      // sitting alongside it -- both together crash on render with a duplicate
      // group registration.
      window.ElementTemplatesPropertiesProviderModule,
      window.minimapModule,
      window.CreateAppendAnythingModule,
      window.CreateAppendElementTemplatesModule,
      window.TokenSimulationModule,
      window.BpmnlintModule,
      window.ElementTemplateChooserModule,
      window.ElementTemplateIconRendererModule,
      window.ElementTemplatesExtendModule,
      window.SupportedElementsRulesModule,
    ].filter(Boolean),
    moddleExtensions: { zeebe: window.zeebeModdleDescriptor || {} },
    linting: window.BpmnlintRecommendedConfig
      ? { bpmnlint: window.BpmnlintRecommendedConfig, active: true }
      : undefined,
    elementTemplateIconRenderer: { iconProperty: "zeebe:modelerTemplateIcon" },
  });

  // Exposed so scripts/verify-editor.mjs (and anything else driving the page)
  // can reach the modeler without scraping internals off the DOM.
  (window as unknown as { __modeler?: unknown }).__modeler = modeler;

  modeler.on("elementTemplates.errors", (event) => {
    const { errors } = event as { errors?: unknown[] };
    if (errors?.length) console.warn("Element template errors:", errors);
  });

  const wanted = new URLSearchParams(location.search).get("id");
  await modeler.importXML(BLANK);
  fitDiagram(modeler);
  await loadList(wanted ?? undefined);
  if (wanted) await open(wanted);

  try {
    const res = await fetch("/api/element-templates");
    if (res.ok) modeler.get("elementTemplatesLoader").setTemplates(await res.json());
  } catch {
    // element templates are optional; the editor works without them
  }

  const select = $("graph-select") as HTMLSelectElement | null;
  if (select) select.onchange = () => void open(select.value);
  const newBtn = $("new-btn");
  if (newBtn) {
    newBtn.onclick = async () => {
      if (!modeler) return;
      await modeler.importXML(BLANK);
      currentId = "";
      const name = $("graph-name") as HTMLInputElement | null;
      if (name) name.value = "new_graph";
      fitDiagram(modeler);
    };
  }
  const layoutBtn = $("layout-btn");
  if (layoutBtn) {
    layoutBtn.onclick = async () => {
      if (!modeler || !window.AutoLayout?.layoutProcess) return;
      const { xml } = await modeler.saveXML({ format: true });
      await modeler.importXML(await window.AutoLayout.layoutProcess(xml));
      fitDiagram(modeler);
    };
  }
  const saveBtn = $("save-btn");
  if (saveBtn) saveBtn.onclick = () => void save();
  const undoBtn = $("undo-btn");
  if (undoBtn) undoBtn.onclick = () => modeler?.get("commandStack").undo();
  const redoBtn = $("redo-btn");
  if (redoBtn) redoBtn.onclick = () => modeler?.get("commandStack").redo();

  wireZoomControls(() => modeler, {
    zoomIn: "ctrl-zoom-in",
    zoomOut: "ctrl-zoom-out",
    fit: "ctrl-zoom-fit",
    reset: "ctrl-zoom-reset",
    minimap: "ctrl-minimap",
  });

  const resizer = $("resizer");
  const properties = $("properties-container");
  if (resizer && properties) {
    initResizer(resizer, properties, {
      axis: "horizontal",
      min: 240,
      max: 720,
      invert: true,
      onResize: () => modeler?.get("canvas").resized(),
      onEnd: () => modeler?.get("canvas").resized(),
    });
  }

  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      void save();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      e.preventDefault();
      modeler?.get("commandStack").undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
      e.preventDefault();
      modeler?.get("commandStack").redo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
      e.preventDefault();
      fitDiagram(modeler);
    }
  });

  connectStudioEvents("/ws", (event) => {
    if (event.type === "graphs_changed") void loadList(currentId || undefined);
  });
}

void init();
