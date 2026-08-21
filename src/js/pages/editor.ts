import { $ } from "../lib/dom";
import { initResizer } from "../lib/resizer";
import { fitDiagram, wireZoomControls } from "../lib/bpmn-viewer-controls";
import type { BpmnDiagramInstance } from "../lib/bpmn-types";

interface TemplateSummary {
  id: string;
  name: string;
}

let modeler: BpmnDiagramInstance | null = null;

const blankBPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:camunda="http://camunda.org/schema/1.0/bpmn" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="new_process" name="New Process" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" name="Start">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="ServiceTask_1" />
    <bpmn:serviceTask id="ServiceTask_1" name="AI Task">
      <bpmn:extensionElements>
        <camunda:properties>
          <camunda:property name="harness_type" value="pi_agent" />
          <camunda:property name="agent_role" value="assistant" />
        </camunda:properties>
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="ServiceTask_1" targetRef="EndEvent_1" />
    <bpmn:endEvent id="EndEvent_1" name="End">
      <bpmn:incoming>Flow_2</bpmn:incoming>
    </bpmn:endEvent>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="new_process">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="180" y="160" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="ServiceTask_1_di" bpmnElement="ServiceTask_1">
        <dc:Bounds x="270" y="138" width="120" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="EndEvent_1_di" bpmnElement="EndEvent_1">
        <dc:Bounds x="450" y="160" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="216" y="178" />
        <di:waypoint x="270" y="178" />
      </bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2">
        <di:waypoint x="390" y="178" />
        <di:waypoint x="450" y="178" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

async function init(): Promise<void> {
  const ModelerCtor = window.BpmnModeler || window.BpmnJS;
  if (!ModelerCtor) return;
  modeler = new (
    ModelerCtor as new (options: {
      container: string;
      propertiesPanel?: { parent: string };
      additionalModules?: unknown[];
      moddleExtensions?: Record<string, unknown>;
    }) => BpmnDiagramInstance
  )({
    container: "#modeler",
    propertiesPanel: {
      parent: "#properties-panel",
    },
    additionalModules: [window.BpmnPropertiesPanelModule, window.BpmnPropertiesProviderModule, window.CamundaPlatformPropertiesProviderModule, window.minimapModule].filter(Boolean),
    moddleExtensions: {
      camunda: window.camundaModdleDescriptor || {},
    },
  });

  await modeler.importXML(blankBPMN);
  fitDiagram(modeler);
  void loadTemplatesList();
  setupResizer();
  setupShortcuts();
}

async function loadTemplatesList(): Promise<void> {
  try {
    const res = await fetch("/api/templates");
    if (res.ok) {
      const templates: TemplateSummary[] = await res.json();
      const select = $("template-select") as HTMLSelectElement | null;
      templates.forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = `${t.name} (${t.id})`;
        select?.appendChild(opt);
      });
    }
  } catch {
    // template list is optional; the blank-diagram option remains usable
  }
}

const loadBtn = $("load-btn");
if (loadBtn) {
  loadBtn.onclick = async () => {
    if (!modeler) return;
    const select = $("template-select") as HTMLSelectElement | null;
    const nameInput = $("workflow-name") as HTMLInputElement | null;
    const selected = select?.value;
    if (!selected) {
      await modeler.importXML(blankBPMN);
      if (nameInput) nameInput.value = "new_workflow";
      fitDiagram(modeler);
      return;
    }
    try {
      const res = await fetch(`/api/templates/${selected}/xml`);
      if (res.ok) {
        const xml = await res.text();
        await modeler.importXML(xml);
        if (nameInput) nameInput.value = selected;
        fitDiagram(modeler);
      }
    } catch (e) {
      alert("Failed to load template: " + e);
    }
  };
}

const newBtn = $("new-btn");
if (newBtn) {
  newBtn.onclick = async () => {
    if (!modeler) return;
    if (confirm("Create new blank diagram? Any unsaved edits will be cleared.")) {
      await modeler.importXML(blankBPMN);
      const nameInput = $("workflow-name") as HTMLInputElement | null;
      if (nameInput) nameInput.value = "new_workflow";
      fitDiagram(modeler);
    }
  };
}

const layoutBtn = $("layout-btn");
if (layoutBtn) {
  layoutBtn.onclick = async () => {
    if (!modeler) return;
    try {
      const { xml } = await modeler.saveXML({ format: true });
      if (window.AutoLayout?.layoutProcess) {
        const newXml = await window.AutoLayout.layoutProcess(xml);
        await modeler.importXML(newXml);
        fitDiagram(modeler);
      }
    } catch (e) {
      alert("Auto-layout error: " + (e instanceof Error ? e.message : e));
    }
  };
}

const undoBtn = $("undo-btn");
if (undoBtn) {
  undoBtn.onclick = () => {
    try {
      modeler?.get("commandStack").undo();
    } catch {
      // nothing to undo
    }
  };
}
const redoBtn = $("redo-btn");
if (redoBtn) {
  redoBtn.onclick = () => {
    try {
      modeler?.get("commandStack").redo();
    } catch {
      // nothing to redo
    }
  };
}

wireZoomControls(() => modeler, {
  zoomIn: "ctrl-zoom-in",
  zoomOut: "ctrl-zoom-out",
  fit: "ctrl-zoom-fit",
  reset: "ctrl-zoom-reset",
  minimap: "ctrl-minimap",
});

function toggleProperties(): void {
  const panel = $("properties-container");
  if (!panel) return;
  const isCollapsed = panel.classList.toggle("collapsed");
  if (isCollapsed) {
    panel.classList.add("!w-0", "!min-w-0", "!border-l-0");
    $("resizer")?.classList.add("hidden");
  } else {
    panel.classList.remove("!w-0", "!min-w-0", "!border-l-0");
    $("resizer")?.classList.remove("hidden");
  }
  $("toggle-properties-btn")?.classList.toggle("active", !isCollapsed);
  if (modeler) {
    try {
      modeler.get("canvas").resized();
    } catch {
      // canvas not ready yet
    }
  }
}

const togglePropertiesBtn = $("toggle-properties-btn");
if (togglePropertiesBtn) togglePropertiesBtn.onclick = toggleProperties;
const closePropertiesBtn = $("close-properties-btn");
if (closePropertiesBtn) closePropertiesBtn.onclick = toggleProperties;

function setupResizer(): void {
  const resizer = $("resizer");
  const propContainer = $("properties-container");
  if (!resizer || !propContainer) return;
  initResizer(resizer, propContainer, {
    axis: "horizontal",
    min: 220,
    max: 800,
    invert: true,
    onResize: () => {
      if (modeler) {
        try {
          modeler.get("canvas").resized();
        } catch {
          // canvas not ready yet
        }
      }
    },
    onEnd: () => {
      if (modeler) {
        try {
          modeler.get("canvas").resized();
        } catch {
          // canvas not ready yet
        }
      }
    },
  });
}

const downloadBtn = $("download-btn");
if (downloadBtn) {
  downloadBtn.onclick = async () => {
    if (!modeler) return;
    try {
      const { xml } = await modeler.saveXML({ format: true });
      const nameInput = $("workflow-name") as HTMLInputElement | null;
      const name = (nameInput?.value.trim() || "workflow") + ".bpmn";
      const blob = new Blob([xml], { type: "application/xml" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert("Failed to export XML: " + e);
    }
  };
}

const openFileBtn = $("open-file-btn");
const fileInput = $("file-input") as HTMLInputElement | null;
if (openFileBtn && fileInput) {
  openFileBtn.onclick = () => fileInput.click();
  fileInput.onchange = (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      if (!modeler) return;
      try {
        await modeler.importXML(evt.target?.result as string);
        const nameInput = $("workflow-name") as HTMLInputElement | null;
        if (nameInput) nameInput.value = file.name.replace(/\.(bpmn|xml)$/, "");
        fitDiagram(modeler);
      } catch (err) {
        alert("Failed to load BPMN file: " + (err instanceof Error ? err.message : err));
      }
    };
    reader.readAsText(file);
    (e.target as HTMLInputElement).value = "";
  };
}

const saveBtn = $("save-btn") as HTMLButtonElement | null;
if (saveBtn) {
  saveBtn.onclick = async () => {
    if (!modeler) return;
    saveBtn.disabled = true;
    try {
      const res = await modeler.saveXML({ format: true });
      const xml = res.xml;
      const nameInput = $("workflow-name") as HTMLInputElement | null;
      const name = nameInput?.value.trim() || "workflow";
      const response = await fetch("/api/workflows/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, xml }),
      });
      const msg = $("save-msg");
      msg?.classList.remove("hidden");
      if (response.ok) {
        const data = await response.json();
        if (msg) {
          msg.className = "mb-2 p-2 rounded-md text-xs bg-[#142823] text-accent border border-accent";
          msg.textContent = `Saved workflow successfully to ${data.path} (Processes: ${data.process_ids.join(", ")})`;
        }
      } else if (msg) {
        msg.className = "mb-2 p-2 rounded-md text-xs bg-danger-dim text-danger border border-danger-border";
        msg.textContent = `Save failed: ${await response.text()}`;
      }
    } catch (e) {
      alert("Save error: " + e);
    } finally {
      saveBtn.disabled = false;
    }
  };
}

function setupShortcuts(): void {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    if ((e.ctrlKey || e.metaKey) && e.key === "z") {
      e.preventDefault();
      $("undo-btn")?.click();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.shiftKey && e.key === "z"))) {
      e.preventDefault();
      $("redo-btn")?.click();
    } else if (e.altKey && (e.key === "p" || e.key === "P")) {
      e.preventDefault();
      toggleProperties();
    } else if (e.key === "m" || e.key === "M") {
      $("ctrl-minimap")?.click();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
      e.preventDefault();
      fitDiagram(modeler);
    } else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      $("save-btn")?.click();
    }
  });
}

void init();
