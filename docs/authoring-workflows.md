# Authoring BPMN Workflows

All executable workflows are standard BPMN 2.0 XML files placed in `graph_agent/data/workflows/`.

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

### Input Parameters — feeding data into a prompt

`camunda:inputParameter` builds the values an agent turn sees. Values are resolved by
`resolve_input()` (`graph_agent/engine.py`), a plain dict/list lookup with string interpolation —
**no `eval`, no script engine**, so nothing in workflow data can execute.

```xml
<bpmn:serviceTask id="Task_Revise" name="Revise Draft">
  <bpmn:extensionElements>
    <camunda:inputOutput>
      <camunda:inputParameter name="brief">${topic}</camunda:inputParameter>
      <camunda:inputParameter name="first_finding">${qa_findings.0}</camunda:inputParameter>
      <camunda:inputParameter name="author">${reviewer.profile.name}</camunda:inputParameter>
      <camunda:inputParameter name="header">Revision of "${topic}" for ${reviewer.profile.name}</camunda:inputParameter>
    </camunda:inputOutput>
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

| Form | Resolves to |
| :--- | :--- |
| `${name}` | `workflow.data["name"]`, **preserving its type** — an int stays an int, a list stays a list |
| `${a.b.c}` | Dotted path through nested dicts |
| `${findings.0.title}` | Numeric segments index into lists |
| `Text ${a} and ${b}` | Mixed strings interpolate; the result is always a string |
| `literal` | No `${…}`, so passed through untouched |

Any miss along a path — a missing key, an out-of-range index, or a path running into a
non-container — yields `None` rather than raising, and an interpolated miss contributes an
empty string instead of leaking `${…}` into the prompt.

Arithmetic, comparisons, function calls and filters are deliberately **not** supported.

### Output Parameters — scoping what a task publishes

A service task publishes its result to the workflow only through declared
`camunda:outputParameter` entries, so gateways route on task-scoped names and parallel agent
turns cannot overwrite one another:

```xml
<camunda:outputParameter name="draft_status">status</camunda:outputParameter>
<camunda:outputParameter name="draft_summary">summary</camunda:outputParameter>
<camunda:outputParameter name="draft_artifacts">artifacts</camunda:outputParameter>
```

The gateway then routes on `draft_status == 'success'` rather than a shared `agent_status`.

### CallActivity — scoping what a called process sees and publishes

A `callActivity` gets the same explicit scoping as a service task: declare `camunda:inputOutput`
directly on the `callActivity` element, not on the called process's start event.

```xml
<bpmn:callActivity id="CallActivity_Review" calledElement="agent_review_cycle">
  <bpmn:extensionElements>
    <camunda:inputOutput>
      <camunda:inputParameter name="subject">${subject}</camunda:inputParameter>
      <camunda:outputParameter name="cycle_decision">${cycle_decision}</camunda:outputParameter>
      <camunda:outputParameter name="cycle_summary">${cycle_summary}</camunda:outputParameter>
    </camunda:inputOutput>
  </bpmn:extensionElements>
</bpmn:callActivity>
```

Without it, the called process starts with an **empty** scope — there is no fallback to the
caller's data, so a called process that expects `${subject}` and gets nothing is a missing
`inputParameter` on the call activity, not a bug in the called process. Output works the same
way in reverse: only the called process's own declared `outputParameter`s (from its own tasks)
are visible to `outputParameter`s on the call activity, resolved against the called process's
instance-wide data. `graph_agent/data/workflows/composed_delivery.bpmn` calling `graph_agent/data/workflows/agent_review_cycle.bpmn`
is the worked example. See `docs/variable-scoping-plan.md` for the full model, including which
element types this does *not* yet cover (embedded/event subprocesses).

### Spawning children from a long-running process

A `subProcess` with `triggeredByEvent="true"` and a message start event spawns one child
instance per message received, while the parent stays open:

```xml
<bpmn:message id="Message_Spawn_Requested" name="spawn_requested" />

<bpmn:subProcess id="Spawn" name="Spawn Child Task" triggeredByEvent="true">
  <bpmn:startEvent id="Spawn_Start" name="Spawn Requested">
    <bpmn:messageEventDefinition messageRef="Message_Spawn_Requested" />
  </bpmn:startEvent>
  <!-- … the child's own tasks … -->
</bpmn:subProcess>
```

Deliver a spawn with `POST /instance/{id}/message/spawn_requested` and a JSON `payload`; the
payload lands on the new child's data. `graph_agent/data/workflows/project.bpmn` is a working example.

### Putting a build tool in the loop

A `shell` task runs a command declared in the diagram, so a compiler or converter is a node
rather than something the agent is trusted to have run:

```xml
<bpmn:serviceTask id="Task_Build" name="Build PDF">
  <bpmn:extensionElements>
    <camunda:properties>
      <camunda:property name="harness_type" value="shell" />
      <camunda:property name="command" value="make pdf" />
      <camunda:property name="fail_on_error" value="false" />
    </camunda:properties>
    <camunda:inputOutput>
      <camunda:outputParameter name="build_status">${status}</camunda:outputParameter>
      <camunda:outputParameter name="build_log">${log}</camunda:outputParameter>
    </camunda:inputOutput>
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

`fail_on_error="false"` is what makes the failure branchable: the turn completes even on a
non-zero exit, publishing `build_status = 'failed'`, so a gateway can route on it instead of
parking the instance in `failed`. `graph_agent/data/workflows/beamer_slides.bpmn` is a working example — a
LaTeX error reaches a human diagnosis gate holding `${build_log}`, who either hands it back
to the slide agent or abandons the deck, and the human deck review is only reached by a deck
that compiled.

Note the shape of that bound. Condition expressions here are dict lookups and comparisons,
not a scripting language, so a workflow cannot count its own iterations; putting a person on
the failure branch is how a repair loop terminates without one. See
[Extending Adapters](extending-adapters.md) for every property the shell harness accepts.

### FormJS Field Types
- `string`, `text` $\rightarrow$ textfield
- `long`, `double` $\rightarrow$ number
- `boolean` $\rightarrow$ checkbox
- `enum` $\rightarrow$ select dropdown
- `date` $\rightarrow$ date picker
