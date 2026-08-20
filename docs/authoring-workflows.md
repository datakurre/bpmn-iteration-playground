# Authoring BPMN Workflows

All executable workflows are standard BPMN 2.0 XML files placed in `workflows/`.

## Workflow Anatomy

```xml
<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  id="Definitions_1"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="custom_analysis" name="Custom Analysis" isExecutable="true">
    <bpmn:documentation>Template description shown in Studio UI.</bpmn:documentation>

    <bpmn:startEvent id="StartEvent_1" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Task_Agent" />

    <!-- AI Service Task -->
    <bpmn:serviceTask id="Task_Agent" name="AI Analysis Task">
      <bpmn:extensionElements>
        <camunda:properties>
          <camunda:property name="harness_type" value="pi_agent" />
          <camunda:property name="agent_role" value="researcher" />
        </camunda:properties>
      </bpmn:extensionElements>
    </bpmn:serviceTask>
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_Agent" targetRef="GW_Check" />

    <!-- Gateways evaluate agent_status -->
    <bpmn:exclusiveGateway id="GW_Check" name="Success?">
      <bpmn:outgoing>Flow_OK</bpmn:outgoing>
      <bpmn:outgoing>Flow_Fail</bpmn:outgoing>
    </bpmn:exclusiveGateway>

    <bpmn:sequenceFlow id="Flow_OK" name="OK" sourceRef="GW_Check" targetRef="Task_Human">
      <bpmn:conditionExpression>agent_status == 'success'</bpmn:conditionExpression>
    </bpmn:sequenceFlow>

    <bpmn:sequenceFlow id="Flow_Fail" name="Fail" sourceRef="GW_Check" targetRef="End_Fail">
      <bpmn:conditionExpression>agent_status != 'success'</bpmn:conditionExpression>
    </bpmn:sequenceFlow>

    <!-- User Task with Form Fields -->
    <bpmn:userTask id="Task_Human" name="Human Review">
      <bpmn:extensionElements>
        <camunda:formData>
          <camunda:formField id="decision" label="Review Decision" type="string" />
          <camunda:formField id="notes" label="Notes" type="string" />
        </camunda:formData>
      </bpmn:extensionElements>
    </bpmn:userTask>
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Task_Human" targetRef="End_OK" />

    <bpmn:endEvent id="End_OK" name="Approved" />
    <bpmn:endEvent id="End_Fail" name="Failed" />
  </bpmn:process>
</bpmn:definitions>
```

## Supported Extensions

### Camunda Properties
- `harness_type`: Adapter to dispatch (`pi_agent`, `mock_agent`, or custom).
- `agent_role`: Role prompt identifier passed to the AI harness.

### FormJS Field Types
- `string`, `text` $\rightarrow$ textfield
- `long`, `double` $\rightarrow$ number
- `boolean` $\rightarrow$ checkbox
- `enum` $\rightarrow$ select dropdown
- `date` $\rightarrow$ date picker
