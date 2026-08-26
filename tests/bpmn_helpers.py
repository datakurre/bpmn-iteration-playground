from __future__ import annotations


def minimal_bpmn(
    process_id: str = "Process_1",
    tasks: list[tuple[str, str]] | None = None,
) -> str:
    """Build a minimal valid BPMN XML string with sequence flows connecting start -> tasks -> end."""
    if tasks is None:
        tasks = [("Task_1", "bpmn:serviceTask")]

    task_xml_parts: list[str] = []
    flow_xml_parts: list[str] = []

    prev_node = "StartEvent_1"
    flow_counter = 1

    for task_id, task_type in tasks:
        tag = task_type if ":" in task_type else f"bpmn:{task_type}"
        flow_id = f"Flow_{flow_counter}"
        flow_counter += 1
        flow_xml_parts.append(
            f'<bpmn:sequenceFlow id="{flow_id}" sourceRef="{prev_node}" targetRef="{task_id}" />'
        )
        task_xml_parts.append(
            f'<{tag} id="{task_id}" name="{task_id}">'
            f"<bpmn:incoming>{flow_id}</bpmn:incoming>"
            f"<bpmn:outgoing>Flow_{flow_counter}</bpmn:outgoing>"
            f"</{tag}>"
        )
        prev_node = task_id

    final_flow_id = f"Flow_{flow_counter}"
    flow_xml_parts.append(
        f'<bpmn:sequenceFlow id="{final_flow_id}" sourceRef="{prev_node}" targetRef="EndEvent_1" />'
    )

    tasks_str = "\n    ".join(task_xml_parts)
    flows_str = "\n    ".join(flow_xml_parts)

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="{process_id}" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    {tasks_str}
    <bpmn:endEvent id="EndEvent_1">
      <bpmn:incoming>{final_flow_id}</bpmn:incoming>
    </bpmn:endEvent>
    {flows_str}
  </bpmn:process>
</bpmn:definitions>
"""


def linear_bpmn(
    process_id: str = "Process_1",
    tasks: list[tuple[str, str] | tuple[str, str, dict[str, str]]] | None = None,
) -> str:
    """Build Start -> task1 -> task2 -> ... -> End BPMN.

    Each task: (bpmn_id, element_type) or (bpmn_id, element_type, camunda_properties).
    element_type: 'userTask', 'serviceTask', etc.
    """
    if tasks is None:
        tasks = [("Task_1", "serviceTask", {"harness_type": "pi_agent", "agent_role": "reviewer"})]

    task_xml_parts: list[str] = []
    flow_xml_parts: list[str] = []

    prev_node = "StartEvent_1"
    flow_counter = 1

    for item in tasks:
        if len(item) == 2:
            task_id, task_type = item
            properties: dict[str, str] = {}
        else:
            task_id, task_type, properties = item  # type: ignore[assignment]
        tag = task_type if ":" in task_type else f"bpmn:{task_type}"
        flow_id = f"Flow_{flow_counter}"
        flow_counter += 1
        flow_xml_parts.append(
            f'<bpmn:sequenceFlow id="{flow_id}" sourceRef="{prev_node}" targetRef="{task_id}" />'
        )

        props_xml = [
            f'<camunda:property name="{k}" value="{v}" />'
            for k, v in properties.items()
        ]
        ext_str = (
            f"<bpmn:extensionElements><camunda:properties>{''.join(props_xml)}</camunda:properties></bpmn:extensionElements>"
            if props_xml
            else ""
        )

        next_flow_id = f"Flow_{flow_counter}"
        task_xml_parts.append(
            f'<{tag} id="{task_id}" name="{task_id}">'
            f"{ext_str}"
            f"<bpmn:incoming>{flow_id}</bpmn:incoming>"
            f"<bpmn:outgoing>{next_flow_id}</bpmn:outgoing>"
            f"</{tag}>"
        )
        prev_node = task_id

    final_flow_id = f"Flow_{flow_counter}"
    flow_xml_parts.append(
        f'<bpmn:sequenceFlow id="{final_flow_id}" sourceRef="{prev_node}" targetRef="EndEvent_1" />'
    )

    tasks_str = "\n    ".join(task_xml_parts)
    flows_str = "\n    ".join(flow_xml_parts)

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="{process_id}" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    {tasks_str}
    <bpmn:endEvent id="EndEvent_1">
      <bpmn:incoming>{final_flow_id}</bpmn:incoming>
    </bpmn:endEvent>
    {flows_str}
  </bpmn:process>
</bpmn:definitions>
"""


def bpmn_with_orphan_task(process_id: str = "Process_1") -> str:
    """Build a BPMN XML string with an orphan (disconnected) task."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="{process_id}" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="Task_1" name="Task 1">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:serviceTask id="Orphan_Task" name="Orphan Task" />
    <bpmn:endEvent id="EndEvent_1">
      <bpmn:incoming>Flow_2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="EndEvent_1" />
  </bpmn:process>
</bpmn:definitions>
"""


def bpmn_with_camunda_service_task(
    process_id: str = "Process_1",
    task_id: str = "Task_Agent",
    harness_type: str = "pi_agent",
    agent_role: str = "reviewer",
    input_params: dict[str, str] | None = None,
    output_params: dict[str, str] | None = None,
) -> str:
    """Build a BPMN XML string containing a ServiceTask with Camunda extension elements."""
    if input_params is None:
        input_params = {"prompt": "Analyze code"}
    if output_params is None:
        output_params = {"status": "${status}", "summary": "${summary}"}

    props_xml = []
    if harness_type:
        props_xml.append(f'<camunda:property name="harness_type" value="{harness_type}" />')
    if agent_role:
        props_xml.append(f'<camunda:property name="agent_role" value="{agent_role}" />')

    props_str = "\n          ".join(props_xml)

    inputs_xml = [
        f'<camunda:inputParameter name="{k}">{v}</camunda:inputParameter>'
        for k, v in input_params.items()
    ]
    outputs_xml = [
        f'<camunda:outputParameter name="{k}">{v}</camunda:outputParameter>'
        for k, v in output_params.items()
    ]
    io_str = "\n          ".join(inputs_xml + outputs_xml)

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="{process_id}" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="{task_id}" name="Agent Task">
      <bpmn:extensionElements>
        <camunda:properties>
          {props_str}
        </camunda:properties>
        <camunda:inputOutput>
          {io_str}
        </camunda:inputOutput>
      </bpmn:extensionElements>
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="EndEvent_1">
      <bpmn:incoming>Flow_2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="{task_id}" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="{task_id}" targetRef="EndEvent_1" />
  </bpmn:process>
</bpmn:definitions>
"""


def bpmn_with_bare_service_task(
    process_id: str = "Process_1",
    task_id: str = "Task_Bare",
) -> str:
    """Build a BPMN XML string with a ServiceTask having no Camunda properties."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="{process_id}" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1">
      <bpmn:outgoing>Flow_1</bpmn:outgoing>
    </bpmn:startEvent>
    <bpmn:serviceTask id="{task_id}" name="Bare Service Task">
      <bpmn:incoming>Flow_1</bpmn:incoming>
      <bpmn:outgoing>Flow_2</bpmn:outgoing>
    </bpmn:serviceTask>
    <bpmn:endEvent id="EndEvent_1">
      <bpmn:incoming>Flow_2</bpmn:incoming>
    </bpmn:endEvent>
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="{task_id}" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="{task_id}" targetRef="EndEvent_1" />
  </bpmn:process>
</bpmn:definitions>
"""
