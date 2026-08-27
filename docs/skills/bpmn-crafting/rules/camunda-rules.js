/**
 * Custom validation rules for Camunda 7 + SpiffWorkflow harness graphs in graph-agent.
 *
 * Checks engine-specific invariants that standard bpmnlint doesn't cover:
 * - ServiceTask harness configuration (harness_type, agent_role, command)
 * - Variable scoping (camunda:inputOutput parameters)
 * - ExclusiveGateway branch conditions
 * - UserTask FormJS compatibility
 * - CallActivity configuration
 */

function validateCamundaRules(rootElement, options = {}) {
  const issues = [];

  function addIssue(id, message, category = 'error', rule = 'camunda-harness') {
    issues.push({
      id,
      message,
      category,
      rule: `camunda/${rule}`
    });
  }

  // Find all processes
  const rootElements = rootElement.rootElements || [];
  const processes = rootElements.filter(el => el.$type === 'bpmn:Process');

  if (processes.length === 0) {
    addIssue(rootElement.id || 'definitions', 'No bpmn:Process found in definitions', 'error', 'executable-process');
    return issues;
  }

  for (const proc of processes) {
    if (proc.isExecutable === false || proc.isExecutable === undefined) {
      addIssue(proc.id, `Process <${proc.id}> must have isExecutable="true"`, 'warn', 'executable-process');
    }

    const flowElements = proc.flowElements || [];
    const elementsById = new Map();
    for (const el of flowElements) {
      if (el.id) elementsById.set(el.id, el);
    }

    for (const el of flowElements) {
      const type = el.$type;

      // ── 1. ServiceTask validation ──────────────────────────────────────────
      if (type === 'bpmn:ServiceTask') {
        const ext = el.extensionElements;
        const properties = getCamundaProperties(ext);
        const io = getCamundaInputOutput(ext);

        const harnessType = properties['harness_type'];
        if (!harnessType) {
          addIssue(
            el.id,
            `ServiceTask "${el.name || el.id}" is missing camunda:property "harness_type" (e.g. pi_agent, shell, sandbox_pi, mock_agent)`,
            'error',
            'service-task-harness'
          );
        } else {
          const validHarnesses = ['pi_agent', 'shell', 'sandbox_pi', 'sandbox_shell', 'mock_agent', 'graph_extend', 'mock'];
          if (!validHarnesses.includes(harnessType)) {
            addIssue(
              el.id,
              `ServiceTask "${el.name || el.id}" has unknown harness_type "${harnessType}". Valid: ${validHarnesses.join(', ')}`,
              'warn',
              'service-task-harness'
            );
          }

          if (harnessType === 'shell' || harnessType === 'sandbox_shell') {
            if (!properties['command'] && !properties['template']) {
              addIssue(
                el.id,
                `Shell ServiceTask "${el.name || el.id}" is missing required camunda:property "command" (or "template")`,
                'error',
                'service-task-command'
              );
            }
          }

          if (harnessType === 'pi_agent' || harnessType === 'sandbox_pi') {
            if (!properties['agent_role']) {
              addIssue(
                el.id,
                `Pi ServiceTask "${el.name || el.id}" is missing recommended camunda:property "agent_role" (e.g. planner, implementer, reviewer, assistant)`,
                'warn',
                'service-task-agent-role'
              );
            }
          }
        }

        // Variable scoping checks
        if (!io || io.outputParameters.length === 0) {
          addIssue(
            el.id,
            `ServiceTask "${el.name || el.id}" should declare camunda:outputParameters to scope published data (e.g. status, summary)`,
            'warn',
            'explicit-variable-scoping'
          );
        }

        // Check input parameters syntax
        if (io) {
          for (const param of io.inputParameters) {
            const val = param.value || param.name;
            if (val && typeof val === 'string' && val.includes('${')) {
              const matches = val.match(/\$\{([^}]+)\}/g);
              if (matches) {
                for (const m of matches) {
                  const expr = m.slice(2, -1).trim();
                  if (!/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)*$/.test(expr)) {
                    addIssue(
                      el.id,
                      `InputParameter "${param.name}" expression "${m}" uses invalid syntax. Only dotted path lookups (e.g. \${var.prop}) are supported.`,
                      'error',
                      'valid-input-expressions'
                    );
                  }
                }
              }
            }
          }
        }
      }

      // ── 2. ExclusiveGateway condition validation ───────────────────────────
      if (type === 'bpmn:ExclusiveGateway') {
        const outgoing = el.outgoing || [];
        const defaultFlowId = el.default ? (el.default.id || el.default) : null;

        if (outgoing.length > 1) {
          let conditionalCount = 0;
          for (const flow of outgoing) {
            const isDefault = flow.id === defaultFlowId;
            const hasCondition = flow.conditionExpression && flow.conditionExpression.body;

            if (!isDefault && !hasCondition) {
              addIssue(
                flow.id,
                `Outgoing sequence flow "${flow.name || flow.id}" from ExclusiveGateway "${el.name || el.id}" must have a conditionExpression or be the default flow`,
                'error',
                'gateway-conditions'
              );
            }
            if (hasCondition) conditionalCount++;
          }

          if (!defaultFlowId && conditionalCount < outgoing.length) {
            addIssue(
              el.id,
              `ExclusiveGateway "${el.name || el.id}" has ${outgoing.length} outgoing flows but no default flow designated`,
              'info',
              'gateway-default-flow'
            );
          }
        }
      }

      // ── 3. UserTask FormJS validation ──────────────────────────────────────
      if (type === 'bpmn:UserTask') {
        const ext = el.extensionElements;
        const formData = getCamundaFormData(ext);

        if (!formData || formData.fields.length === 0) {
          addIssue(
            el.id,
            `UserTask "${el.name || el.id}" has no camunda:formData fields defined for human interaction`,
            'warn',
            'user-task-form'
          );
        } else {
          const validTypes = ['string', 'text', 'long', 'double', 'boolean', 'enum', 'date', 'markdown', 'textarea'];
          for (const field of formData.fields) {
            if (field.type && !validTypes.includes(field.type)) {
              addIssue(
                el.id,
                `UserTask "${el.name || el.id}" field "${field.id}" uses unsupported type "${field.type}". Valid: ${validTypes.join(', ')}`,
                'warn',
                'user-task-form-type'
              );
            }
            if (!field.id) {
              addIssue(
                el.id,
                `UserTask "${el.name || el.id}" contains a formField without an id`,
                'error',
                'user-task-form-field'
              );
            }
          }
        }
      }

      // ── 4. CallActivity validation ─────────────────────────────────────────
      if (type === 'bpmn:CallActivity') {
        if (!el.calledElement) {
          addIssue(
            el.id,
            `CallActivity "${el.name || el.id}" must specify "calledElement" process id`,
            'error',
            'call-activity-called-element'
          );
        }
        const ext = el.extensionElements;
        const io = getCamundaInputOutput(ext);
        if (!io || (io.inputParameters.length === 0 && io.outputParameters.length === 0)) {
          addIssue(
            el.id,
            `CallActivity "${el.name || el.id}" should specify camunda:inputOutput to explicitly map child inputs/outputs`,
            'warn',
            'call-activity-scoping'
          );
        }
      }

      // ── 5. SequenceFlow directly from Task should not have condition ───────
      if (type === 'bpmn:SequenceFlow') {
        if (el.sourceRef && el.sourceRef.$type && el.sourceRef.$type.endsWith('Task')) {
          if (el.conditionExpression && el.conditionExpression.body) {
            addIssue(
              el.id,
              `Conditional sequence flow "${el.name || el.id}" originates directly from a task. Use an ExclusiveGateway instead.`,
              'error',
              'no-task-conditional-flows'
            );
          }
        }
      }
    }
  }

  return issues;
}

// ── Helpers to extract Camunda elements from Moddle ─────────────────────────

function getCamundaProperties(extensionElements) {
  const result = {};
  if (!extensionElements || !extensionElements.values) return result;

  for (const ext of extensionElements.values) {
    if (ext.$type === 'camunda:Properties' && ext.values) {
      for (const prop of ext.values) {
        if (prop.name) {
          result[prop.name] = prop.value || '';
        }
      }
    }
  }
  return result;
}

function getCamundaInputOutput(extensionElements) {
  if (!extensionElements || !extensionElements.values) return null;

  for (const ext of extensionElements.values) {
    if (ext.$type === 'camunda:InputOutput') {
      const inputParameters = (ext.inputParameters || []).map(p => ({
        name: p.name,
        value: p.value || (p.$children && p.$children[0] && p.$children[0].text) || ''
      }));
      const outputParameters = (ext.outputParameters || []).map(p => ({
        name: p.name,
        value: p.value || (p.$children && p.$children[0] && p.$children[0].text) || ''
      }));
      return { inputParameters, outputParameters };
    }
  }
  return null;
}

function getCamundaFormData(extensionElements) {
  if (!extensionElements || !extensionElements.values) return null;

  for (const ext of extensionElements.values) {
    if (ext.$type === 'camunda:FormData') {
      const fields = (ext.fields || []).map(f => ({
        id: f.id,
        label: f.label,
        type: f.type,
        defaultValue: f.defaultValue,
        values: (f.values || []).map(v => ({ id: v.id, name: v.name }))
      }));
      return { fields };
    }
  }
  return null;
}

module.exports = {
  validateCamundaRules,
  getCamundaProperties,
  getCamundaInputOutput,
  getCamundaFormData
};
