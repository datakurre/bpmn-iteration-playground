from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Any

from lxml import etree
from SpiffWorkflow.bpmn.parser.BpmnParser import BpmnParser

from graph_agent.xml_utils import safe_fromstring_xml

BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL"
CAMUNDA_NS = "http://camunda.org/schema/1.0/bpmn"

KNOWN_HARNESS_TYPES: set[str] = {
    "pi_agent",
    "shell",
    "mock",
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
