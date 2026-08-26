from __future__ import annotations

import re
import uuid
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from lxml import etree
from SpiffWorkflow.bpmn.parser.BpmnParser import BpmnParser
from SpiffWorkflow.bpmn.workflow import BpmnWorkflow
from SpiffWorkflow.task import TaskState

from graph_agent.xml_utils import safe_fromstring_xml

if TYPE_CHECKING:
    from graph_agent.engine import WorkflowRunner

BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL"
CAMUNDA_NS = "http://camunda.org/schema/1.0/bpmn"

KNOWN_HARNESS_TYPES: set[str] = {
    "pi_agent",
    "shell",
    "mock",
    "mock_agent",
    "sandbox_pi",
    "sandbox_shell",
}

KNOWN_OUTPUT_SOURCES: set[str] = {
    # JSON result contract keys
    "status",
    "summary",
    "findings",
    "artifacts",
    "next_action",
    # Telemetry and harness verdict keys
    "agent_status",
    "agent_text",
    "agent_output",
    "agent_exit_code",
    "failure_reason",
    # Shell adapter keys
    "command",
    "exit_code",
    "stdout",
    "stderr",
    "log",
    "template",
}

FLOW_NODE_TAGS: set[str] = {
    "task",
    "serviceTask",
    "userTask",
    "manualTask",
    "scriptTask",
    "businessRuleTask",
    "sendTask",
    "receiveTask",
    "callActivity",
    "subProcess",
    "transaction",
    "adHocSubProcess",
    "startEvent",
    "endEvent",
    "intermediateCatchEvent",
    "intermediateThrowEvent",
    "boundaryEvent",
    "exclusiveGateway",
    "parallelGateway",
    "inclusiveGateway",
    "complexGateway",
    "eventBasedGateway",
}

_NESTED_EXPR_RE = re.compile(r"\$\{[^}]*\$\{")


@dataclass
class ValidationResult:
    valid: bool
    process_ids: list[str] = field(default_factory=list)
    task_ids: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class BpmnNode:
    """A node to insert into a BPMN graph."""

    bpmn_id: str
    name: str
    element_type: str  # 'serviceTask', 'userTask', 'exclusiveGateway', etc.
    properties: dict[str, str] = field(default_factory=dict)
    input_params: dict[str, str] = field(default_factory=dict)
    output_params: dict[str, str] = field(default_factory=dict)
    form_fields: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class InsertionSpec:
    """Describes what to insert and where."""

    after: str
    nodes: list[BpmnNode]
    after_flow: str | None = None


def _local_tag(elem: ET.Element[Any] | etree._Element) -> str:
    """Return local XML tag without namespace."""
    tag = elem.tag
    if isinstance(tag, str) and "}" in tag:
        return tag.split("}", 1)[1]
    return str(tag)


def _extract_properties(task: ET.Element[Any], ns: dict[str, str]) -> dict[str, str]:
    """Extract camunda:properties declared on a task element."""
    properties: dict[str, str] = {}
    for prop in task.findall(".//camunda:property", ns):
        name = prop.get("name")
        if name:
            properties[name] = prop.get("value", "")
    if not properties:
        for elem in task.iter():
            if _local_tag(elem) == "property":
                name = elem.get("name")
                if name:
                    properties[name] = elem.get("value", "")
    return properties


def _validate_service_task(task: ET.Element[Any], ns: dict[str, str]) -> tuple[list[str], list[str]]:
    """Check a single ServiceTask element for Camunda extension conventions."""
    warnings: list[str] = []
    errors: list[str] = []
    task_id = task.get("id") or "unnamed_task"
    properties = _extract_properties(task, ns)

    harness_type = properties.get("harness_type")
    if not harness_type:
        warnings.append(
            f"ServiceTask '{task_id}' has no harness_type property (defaults to pi_agent)"
        )
        effective_harness = "pi_agent"
    else:
        effective_harness = harness_type
        if harness_type not in KNOWN_HARNESS_TYPES:
            errors.append(
                f"ServiceTask '{task_id}' has unknown harness_type '{harness_type}'"
            )

    if effective_harness in ("pi_agent", "sandbox_pi") and not properties.get("agent_role"):
        warnings.append(
            f"ServiceTask '{task_id}' has no agent_role property (prompt will be generic)"
        )

    # Check inputParameters for nested ${} injection risk
    for inp in task.findall(".//camunda:inputParameter", ns):
        param_name = inp.get("name") or "unnamed"
        val = inp.text or inp.get("value") or ""
        if _NESTED_EXPR_RE.search(val):
            errors.append(
                f"inputParameter '{param_name}' in task '{task_id}' contains nested ${{}} (injection risk): {val}"
            )

    # Check outputParameters for unknown source keys
    for out in task.findall(".//camunda:outputParameter", ns):
        param_name = out.get("name") or "unnamed"
        val = (out.text or out.get("value") or "").strip()
        if not val:
            continue
        source_key = (
            val[2:-1].strip()
            if val.startswith("${") and val.endswith("}")
            else val
        )
        root_key = source_key.split(".")[0]
        if root_key not in KNOWN_OUTPUT_SOURCES:
            warnings.append(
                f"outputParameter '{param_name}' in task '{task_id}' references unknown source key '{source_key}'"
            )

    return warnings, errors


def _check_camunda_extensions(root: ET.Element[Any]) -> tuple[list[str], list[str]]:
    """Inspect Camunda extensions across all elements and separate warnings from errors."""
    warnings: list[str] = []
    errors: list[str] = []
    ns = {"bpmn": BPMN_NS, "camunda": CAMUNDA_NS}

    for elem in root.iter():
        if _local_tag(elem) == "serviceTask":
            task_warns, task_errs = _validate_service_task(elem, ns)
            warnings.extend(task_warns)
            errors.extend(task_errs)

    return warnings, errors


def validate_extensions(xml: str) -> list[str]:
    """Check that Camunda extensions follow graph-agent conventions.

    Warnings (not errors):
    - ServiceTask without harness_type property (will default to pi_agent)
    - ServiceTask without agent_role property (prompt will be generic)
    - outputParameter referencing unknown source keys

    Errors:
    - inputParameter with nested ${} (injection risk)
    - harness_type value not in known set (pi_agent, shell, mock, sandbox_pi, sandbox_shell)
    """
    try:
        root = safe_fromstring_xml(xml)
    except Exception as exc:
        return [f"XML parse error: {exc}"]

    warnings, errors = _check_camunda_extensions(root)
    return warnings + errors


def _collect_task_specs(parser: BpmnParser, process_ids: list[str]) -> tuple[list[str], list[str]]:
    """Retrieve all parsed task specs from the parser for each process."""
    task_ids: list[str] = []
    errors: list[str] = []

    for pid in process_ids:
        try:
            spec = parser.get_spec(pid)
            if spec is not None and hasattr(spec, "task_specs"):
                for tid in spec.task_specs:
                    if tid not in task_ids:
                        task_ids.append(tid)
        except Exception as exc:
            errors.append(f"Failed to build spec for process '{pid}': {exc}")

        try:
            sub_specs = parser.get_subprocess_specs(pid) or {}
            for _sub_pid, sub_spec in sub_specs.items():
                if sub_spec is not None and hasattr(sub_spec, "task_specs"):
                    for tid in sub_spec.task_specs:
                        if tid not in task_ids:
                            task_ids.append(tid)
        except Exception:
            pass

    return task_ids, errors


def _check_flow_node_connectivity(
    elem: ET.Element[Any],
    sources: set[str],
    targets: set[str],
) -> list[str]:
    """Check incoming and outgoing connectivity for a single flow node."""
    node_id = elem.get("id") or "unnamed"
    tag_name = _local_tag(elem)
    errors: list[str] = []

    has_incoming = (
        node_id in targets
        or elem.find(f".//{{{BPMN_NS}}}incoming") is not None
        or tag_name in ("startEvent", "boundaryEvent")
    )
    has_outgoing = (
        node_id in sources
        or elem.find(f".//{{{BPMN_NS}}}outgoing") is not None
        or tag_name in ("endEvent",)
    )

    if not has_incoming and not has_outgoing:
        errors.append(
            f"Element '{node_id}' ({tag_name}) has no incoming or outgoing sequence flows"
        )
    elif not has_incoming and tag_name not in ("startEvent", "boundaryEvent"):
        errors.append(
            f"Element '{node_id}' ({tag_name}) has no incoming sequence flow"
        )
    elif not has_outgoing and tag_name not in ("endEvent", "boundaryEvent"):
        errors.append(
            f"Element '{node_id}' ({tag_name}) has no outgoing sequence flow"
        )

    return errors


def _validate_flow_nodes(root: ET.Element[Any], task_ids: list[str]) -> list[str]:
    """Validate that declared flow nodes are reachable and properly connected."""
    sources: set[str] = set()
    targets: set[str] = set()
    for elem in root.iter():
        if _local_tag(elem) == "sequenceFlow":
            s = elem.get("sourceRef")
            t = elem.get("targetRef")
            if s:
                sources.add(s)
            if t:
                targets.add(t)

    errors: list[str] = []
    for elem in root.iter():
        tag_name = _local_tag(elem)
        if tag_name not in FLOW_NODE_TAGS:
            continue
        node_id = elem.get("id")
        if not node_id:
            continue

        if node_id not in task_ids:
            errors.append(
                f"Element '{node_id}' ({tag_name}) is disconnected or unreachable in process"
            )
            continue

        errors.extend(_check_flow_node_connectivity(elem, sources, targets))

    return errors


def validate_bpmn(xml: str) -> ValidationResult:
    """Parse BPMN XML and verify SpiffWorkflow can build specs from it.

    Does NOT instantiate a BpmnWorkflow (no task tree, no engine steps).
    Only validates that BpmnParser can parse the XML and produce specs.
    """
    # 1. Parse XML safely with defusedxml
    try:
        root = safe_fromstring_xml(xml)
    except Exception as exc:
        return ValidationResult(
            valid=False,
            process_ids=[],
            task_ids=[],
            errors=[f"XML parse error: {exc}"],
            warnings=[],
        )

    # 2. Extract process IDs from <bpmn:process> elements
    process_ids: list[str] = [
        elem.get("id", "")
        for elem in root.iter()
        if _local_tag(elem) == "process" and elem.get("id")
    ]

    if not process_ids:
        return ValidationResult(
            valid=False,
            process_ids=[],
            task_ids=[],
            errors=["No <bpmn:process> element found in XML"],
            warnings=[],
        )

    # 3. Feed to BpmnParser via add_bpmn_xml
    parser = BpmnParser()
    try:
        xml_bytes = xml.encode("utf-8") if isinstance(xml, str) else xml
        parser.add_bpmn_xml(etree.fromstring(xml_bytes))
    except Exception as exc:
        return ValidationResult(
            valid=False,
            process_ids=process_ids,
            task_ids=[],
            errors=[f"SpiffWorkflow parse error: {exc}"],
            warnings=[],
        )

    # 4. Collect task specs
    task_ids, errors = _collect_task_specs(parser, process_ids)

    # 5. Check for disconnected / unreachable flow nodes
    errors.extend(_validate_flow_nodes(root, task_ids))

    # 6. Check Camunda extension errors and collect warnings
    ext_warnings, ext_errors = _check_camunda_extensions(root)
    errors.extend(ext_errors)

    return ValidationResult(
        valid=len(errors) == 0,
        process_ids=process_ids,
        task_ids=task_ids,
        errors=errors,
        warnings=ext_warnings,
    )


def _attach_extensions_to_specs(root: ET.Element[Any], specs: list[Any]) -> None:
    """Attach Camunda extension elements from root XML onto loaded TaskSpec objects."""
    ns = {"bpmn": BPMN_NS, "camunda": CAMUNDA_NS}
    for element in root.findall(".//bpmn:*", ns):
        bpmn_id = element.get("id")
        if not bpmn_id:
            continue
        target_specs = [spec for spec in specs if bpmn_id in spec.task_specs]
        if not target_specs:
            continue

        properties = {
            prop.get("name"): prop.get("value", "")
            for prop in element.findall("./bpmn:extensionElements/camunda:properties/camunda:property", ns)
            if prop.get("name")
        }

        fields: list[dict[str, Any]] = []
        for field_elem in element.findall("./bpmn:extensionElements/camunda:formData/camunda:formField", ns):
            field_data: dict[str, Any] = {
                "id": field_elem.get("id"),
                "label": field_elem.get("label"),
                "type": field_elem.get("type", "string"),
            }
            values = [
                {"id": v.get("id"), "name": v.get("name", v.get("id"))}
                for v in field_elem.findall("camunda:value", ns)
            ]
            if values:
                field_data["values"] = values
            fields.append(field_data)

        input_params = {
            param.get("name"): (param.text or param.get("value") or "").strip()
            for param in element.findall("./bpmn:extensionElements/camunda:inputOutput/camunda:inputParameter", ns)
            if param.get("name")
        }
        output_params = {
            param.get("name"): (param.text or param.get("value") or "").strip()
            for param in element.findall("./bpmn:extensionElements/camunda:inputOutput/camunda:outputParameter", ns)
            if param.get("name")
        }

        for spec in target_specs:
            spec.task_specs[bpmn_id].extensions = {
                "properties": properties,
                "form": {"fields": fields},
                "inputParameters": input_params,
                "outputParameters": output_params,
            }


def _repoint_tasks(
    workflow: BpmnWorkflow,
    new_task_specs: dict[str, Any],
    warnings: list[str],
) -> None:
    """Walk the runtime task tree and repoint each task to the new spec."""
    for task in list(workflow.get_tasks()):
        if task.state in (TaskState.FUTURE, TaskState.MAYBE, TaskState.LIKELY):
            continue

        bpmn_id = getattr(task.task_spec, "bpmn_id", None) or task.task_spec.name
        new_spec = new_task_specs.get(bpmn_id)
        if new_spec is None and task.task_spec.name in new_task_specs:
            new_spec = new_task_specs[task.task_spec.name]

        if new_spec is not None:
            task.task_spec = new_spec
        elif task.state in (TaskState.COMPLETED, TaskState.CANCELLED):
            warnings.append(f"Completed task '{bpmn_id}' not in new spec (history only)")
        else:
            raise ValueError(
                f"Active task '{bpmn_id}' (state={TaskState.get_name(task.state)}) "
                f"not found in new BPMN spec. Cannot migrate."
            )

        # Drop predicted children so SpiffWorkflow re-predicts from new outputs
        for child in list(task.children):
            if (
                child.state in (TaskState.FUTURE, TaskState.MAYBE, TaskState.LIKELY)
                and not child.triggered
                and child.id in workflow.tasks
            ):
                workflow._remove_task(child.id)


def replace_spec(
    workflow: BpmnWorkflow,
    new_xml: str,
    runner: WorkflowRunner | None = None,
) -> tuple[BpmnWorkflow, list[str]]:
    """Replace a workflow's BPMN spec, preserving execution state.

    Returns (workflow, warnings) where warnings lists any non-fatal issues.
    """
    # 1. Validate new_xml
    val_result = validate_bpmn(new_xml)
    if not val_result.valid:
        raise ValueError(f"Invalid BPMN XML: {'; '.join(val_result.errors)}")

    # 2. Parse new spec
    root = safe_fromstring_xml(new_xml)
    parser = BpmnParser()
    xml_bytes = new_xml.encode("utf-8") if isinstance(new_xml, str) else new_xml
    parser.add_bpmn_xml(etree.fromstring(xml_bytes))

    # 3. Identify process ID
    process_id = getattr(workflow.spec, "name", None)
    all_pids = parser.get_process_ids()
    if not process_id or process_id not in all_pids:
        process_id = all_pids[0]

    new_spec = parser.get_spec(process_id)
    new_subprocess_specs = parser.get_subprocess_specs(process_id) or {}

    # 4. Attach Camunda extensions
    all_specs = [new_spec, *new_subprocess_specs.values()]
    _attach_extensions_to_specs(root, all_specs)

    # 5. Build task spec lookup
    new_task_specs: dict[str, Any] = dict(new_spec.task_specs)
    for sub in new_subprocess_specs.values():
        new_task_specs.update(sub.task_specs)

    # 6. Repoint runtime tasks and drop predicted children
    warnings: list[str] = []
    _repoint_tasks(workflow, new_task_specs, warnings)

    # 7. Update workflow references
    workflow.spec = new_spec
    workflow.subprocess_specs = new_subprocess_specs
    workflow._bpmn_xml = new_xml

    # 8. Re-predict future tasks from active tasks
    workflow._predict()

    return workflow, warnings


def _build_extensions(node: BpmnNode) -> etree._Element | None:
    """Build <bpmn:extensionElements> for a BpmnNode."""
    if not node.properties and not node.input_params and not node.output_params and not node.form_fields:
        return None

    ext = etree.Element(f"{{{BPMN_NS}}}extensionElements")
    if node.properties:
        props = etree.SubElement(ext, f"{{{CAMUNDA_NS}}}properties")
        for k, v in node.properties.items():
            etree.SubElement(
                props,
                f"{{{CAMUNDA_NS}}}property",
                attrib={"name": str(k), "value": str(v)},
            )

    if node.form_fields:
        form = etree.SubElement(ext, f"{{{CAMUNDA_NS}}}formData")
        for f in node.form_fields:
            field_attrib = {
                "id": str(f.get("id", "")),
                "label": str(f.get("label", "")),
                "type": str(f.get("type", "string")),
            }
            form_field = etree.SubElement(form, f"{{{CAMUNDA_NS}}}formField", attrib=field_attrib)
            for v in f.get("values", []):
                etree.SubElement(
                    form_field,
                    f"{{{CAMUNDA_NS}}}value",
                    attrib={"id": str(v.get("id", "")), "name": str(v.get("name", ""))},
                )

    if node.input_params or node.output_params:
        io = etree.SubElement(ext, f"{{{CAMUNDA_NS}}}inputOutput")
        for k, v in node.input_params.items():
            p = etree.SubElement(io, f"{{{CAMUNDA_NS}}}inputParameter", attrib={"name": str(k)})
            p.text = str(v)
        for k, v in node.output_params.items():
            p = etree.SubElement(io, f"{{{CAMUNDA_NS}}}outputParameter", attrib={"name": str(k)})
            p.text = str(v)

    return ext


def _find_target_flow(
    process_elem: etree._Element,
    after_id: str,
    after_flow: str | None,
    ns: dict[str, str],
) -> etree._Element:
    """Find matching outgoing sequence flow for after_id."""
    matching_flows = process_elem.findall(
        f".//bpmn:sequenceFlow[@sourceRef='{after_id}']", ns
    )
    if not matching_flows:
        raise ValueError(f"Target node '{after_id}' has no outgoing sequence flow")

    if len(matching_flows) > 1:
        if after_flow:
            target_flow = next(
                (f for f in matching_flows if f.get("id") == after_flow), None
            )
            if target_flow is None:
                raise ValueError(
                    f"Specified flow '{after_flow}' not found among outgoing flows of '{after_id}'"
                )
            return target_flow
        raise ValueError(
            f"Target node '{after_id}' has multiple outgoing sequence flows; specify after_flow"
        )
    return matching_flows[0]


def _splice_nodes(
    process_elem: etree._Element,
    spec_nodes: list[BpmnNode],
    prev_node_id: str,
    prev_node_elem: etree._Element,
    target_node_elem: etree._Element | None,
    orig_target_id: str,
) -> None:
    """Insert new node elements and wire sequence flows."""
    for node in spec_nodes:
        elem_tag = node.element_type
        if elem_tag.startswith("bpmn:"):
            elem_tag = elem_tag[5:]

        new_elem = etree.SubElement(
            process_elem,
            f"{{{BPMN_NS}}}{elem_tag}",
            attrib={"id": node.bpmn_id, "name": node.name},
        )

        ext_elem = _build_extensions(node)
        if ext_elem is not None:
            new_elem.append(ext_elem)

        # Wire flow from prev_node to this node
        flow_id = f"Flow_{uuid.uuid4().hex[:8]}"
        etree.SubElement(
            process_elem,
            f"{{{BPMN_NS}}}sequenceFlow",
            attrib={"id": flow_id, "sourceRef": prev_node_id, "targetRef": node.bpmn_id},
        )

        out_ref = etree.SubElement(prev_node_elem, f"{{{BPMN_NS}}}outgoing")
        out_ref.text = flow_id

        in_ref = etree.SubElement(new_elem, f"{{{BPMN_NS}}}incoming")
        in_ref.text = flow_id

        prev_node_id = node.bpmn_id
        prev_node_elem = new_elem

    # Final sequence flow from last inserted node to orig_target_id
    final_flow_id = f"Flow_{uuid.uuid4().hex[:8]}"
    etree.SubElement(
        process_elem,
        f"{{{BPMN_NS}}}sequenceFlow",
        attrib={"id": final_flow_id, "sourceRef": prev_node_id, "targetRef": orig_target_id},
    )

    out_ref = etree.SubElement(prev_node_elem, f"{{{BPMN_NS}}}outgoing")
    out_ref.text = final_flow_id

    if target_node_elem is not None:
        in_ref = etree.SubElement(target_node_elem, f"{{{BPMN_NS}}}incoming")
        in_ref.text = final_flow_id


def insert_nodes(base_xml: str, spec: InsertionSpec) -> str:
    """Insert nodes into BPMN XML after the specified element.

    Returns the updated BPMN XML string.
    Raises ValueError if:
    - spec.after is not found in the XML
    - spec.after has no outgoing sequence flow
    - spec.after has multiple outgoing sequence flows and spec.after_flow is not specified
    - The resulting XML fails validate_bpmn()
    """
    if not spec.nodes:
        return base_xml

    xml_bytes = base_xml.encode("utf-8") if isinstance(base_xml, str) else base_xml
    try:
        root = etree.fromstring(xml_bytes)
    except Exception as exc:
        raise ValueError(f"Failed to parse base BPMN XML: {exc}") from exc

    ns = {"bpmn": BPMN_NS, "camunda": CAMUNDA_NS}

    # Find the target element 'after'
    node_elem = root.find(f".//*[@id='{spec.after}']")
    if node_elem is None:
        raise ValueError(f"Target node '{spec.after}' not found in BPMN XML")

    process_elem = node_elem.getparent()
    if process_elem is None:
        raise ValueError(f"Parent process element for '{spec.after}' not found")

    target_flow = _find_target_flow(process_elem, spec.after, spec.after_flow, ns)
    orig_flow_id = target_flow.get("id")
    orig_target_id = target_flow.get("targetRef")
    if not orig_target_id:
        raise ValueError(f"Outgoing sequence flow '{orig_flow_id}' has no targetRef")

    target_node_elem = root.find(f".//*[@id='{orig_target_id}']")

    # Remove the existing sequence flow
    process_elem.remove(target_flow)

    # Clean up incoming/outgoing tags referring to orig_flow_id if present
    for out_elem in node_elem.findall("bpmn:outgoing", ns):
        if out_elem.text == orig_flow_id:
            node_elem.remove(out_elem)

    if target_node_elem is not None:
        for in_elem in target_node_elem.findall("bpmn:incoming", ns):
            if in_elem.text == orig_flow_id:
                target_node_elem.remove(in_elem)

    _splice_nodes(
        process_elem=process_elem,
        spec_nodes=spec.nodes,
        prev_node_id=spec.after,
        prev_node_elem=node_elem,
        target_node_elem=target_node_elem,
        orig_target_id=orig_target_id,
    )

    result_xml = etree.tostring(
        root, encoding="utf-8", xml_declaration=True, pretty_print=True
    ).decode("utf-8")

    # Validate output
    val_result = validate_bpmn(result_xml)
    if not val_result.valid:
        raise ValueError(f"Resulting BPMN XML is invalid: {'; '.join(val_result.errors)}")

    return str(result_xml)



