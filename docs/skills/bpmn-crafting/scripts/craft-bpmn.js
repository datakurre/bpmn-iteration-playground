#!/usr/bin/env node

/**
 * Programmatic BPMN 2.0 Harness Graph Generator.
 *
 * Crafts valid, clean, auto-layouted, and pre-linted BPMN 2.0 XML workflows
 * with Camunda 7 extensions for Pi agents, Shell tasks, User tasks, and Gateways.
 *
 * Usage:
 *   node craft-bpmn.js --spec <spec.json> --out <output.bpmn>
 *   node craft-bpmn.js --recipe <recipe-name> --id <process_id> --name <process_name> --out <output.bpmn>
 *
 * Supported Recipes:
 *   - single-agent: Start -> Pi Agent ServiceTask -> End
 *   - agent-human-gate: Start -> Pi Agent -> ExclusiveGateway -> Human Review / Fail End -> Done End
 *   - agent-shell-verify: Start -> Pi Agent -> Shell Verify -> ExclusiveGateway -> Human Review -> Done End
 *   - multi-agent-pipeline: Start -> Planner -> Implementer -> Reviewer -> Done End
 *   - parallel-eval: Start -> ParallelGateway Split -> 2 Agents -> ParallelGateway Join -> Done End
 */

const fs = require('fs');
const path = require('path');
const { layoutProcess } = require('bpmn-auto-layout');
const { lintBpmn } = require('./lint-bpmn');

/**
 * Escape XML special characters.
 */
function escapeXml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate BPMN 2.0 XML from a workflow graph specification.
 *
 * @param {object} spec Workflow graph specification
 * @returns {Promise<string>} Auto-layouted and verified BPMN XML
 */
async function craftBpmn(spec) {
  const processId = spec.id || 'custom_process';
  const processName = spec.name || 'Custom Process';
  const documentation = spec.documentation || '';

  const nodes = spec.nodes || [];
  const flows = spec.flows || [];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
                  id="Definitions_${processId}"
                  targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="${escapeXml(processId)}" name="${escapeXml(processName)}" isExecutable="true">
`;

  if (documentation) {
    xml += `    <bpmn:documentation>${escapeXml(documentation)}</bpmn:documentation>\n`;
  }

  // 1. Build flow index
  const incomingMap = new Map();
  const outgoingMap = new Map();
  for (const node of nodes) {
    incomingMap.set(node.id, []);
    outgoingMap.set(node.id, []);
  }

  let flowCount = 1;
  const normalizedFlows = [];
  for (const flow of flows) {
    const fromId = flow.from || flow.sourceRef;
    const toId = flow.to || flow.targetRef;
    const flowId = flow.id || `Flow_${flowCount++}`;
    normalizedFlows.push({
      id: flowId,
      name: flow.name,
      from: fromId,
      to: toId,
      condition: flow.condition
    });
    if (outgoingMap.has(fromId)) outgoingMap.get(fromId).push(flowId);
    if (incomingMap.has(toId)) incomingMap.get(toId).push(flowId);
  }

  // Helper to render incoming/outgoing tags
  function renderFlowRefs(nodeId) {
    let res = '';
    for (const inc of incomingMap.get(nodeId) || []) {
      res += `      <bpmn:incoming>${escapeXml(inc)}</bpmn:incoming>\n`;
    }
    for (const out of outgoingMap.get(nodeId) || []) {
      res += `      <bpmn:outgoing>${escapeXml(out)}</bpmn:outgoing>\n`;
    }
    return res;
  }

  // 2. Generate Nodes
  for (const node of nodes) {
    const type = node.type || 'serviceTask';
    const id = escapeXml(node.id);
    const name = escapeXml(node.name || id);
    const flowRefs = renderFlowRefs(node.id);

    switch (type) {
      case 'start':
      case 'startEvent':
        xml += `    <bpmn:startEvent id="${id}" name="${name}">\n${flowRefs}    </bpmn:startEvent>\n`;
        break;

      case 'end':
      case 'endEvent':
        xml += `    <bpmn:endEvent id="${id}" name="${name}">\n${flowRefs}    </bpmn:endEvent>\n`;
        break;

      case 'exclusiveGateway':
        const defaultAttr = node.default ? ` default="${escapeXml(node.default)}"` : '';
        xml += `    <bpmn:exclusiveGateway id="${id}" name="${name}"${defaultAttr}>\n${flowRefs}    </bpmn:exclusiveGateway>\n`;
        break;

      case 'parallelGateway':
        xml += `    <bpmn:parallelGateway id="${id}" name="${name}">\n${flowRefs}    </bpmn:parallelGateway>\n`;
        break;

      case 'serviceTask': {
        xml += `    <bpmn:serviceTask id="${id}" name="${name}">\n`;
        xml += `      <bpmn:extensionElements>\n`;

        // camunda:properties
        xml += `        <camunda:properties>\n`;
        const harnessType = node.harness_type || 'pi_agent';
        xml += `          <camunda:property name="harness_type" value="${escapeXml(harnessType)}" />\n`;

        if (harnessType === 'pi_agent' || harnessType === 'sandbox_pi') {
          if (node.agent_role) {
            xml += `          <camunda:property name="agent_role" value="${escapeXml(node.agent_role)}" />\n`;
          }
        }

        if (harnessType === 'shell' || harnessType === 'sandbox_shell') {
          if (node.command) {
            xml += `          <camunda:property name="command" value="${escapeXml(node.command)}" />\n`;
          }
          if (node.template) {
            xml += `          <camunda:property name="template" value="${escapeXml(node.template)}" />\n`;
          }
          if (node.fail_on_error !== undefined) {
            xml += `          <camunda:property name="fail_on_error" value="${escapeXml(String(node.fail_on_error))}" />\n`;
          }
          if (node.timeout) {
            xml += `          <camunda:property name="timeout" value="${escapeXml(String(node.timeout))}" />\n`;
          }
          if (node.artifacts) {
            xml += `          <camunda:property name="artifacts" value="${escapeXml(node.artifacts)}" />\n`;
          }
        }
        xml += `        </camunda:properties>\n`;

        // camunda:inputOutput
        xml += `        <camunda:inputOutput>\n`;
        if (node.inputs && typeof node.inputs === 'object') {
          for (const [inName, inExpr] of Object.entries(node.inputs)) {
            xml += `          <camunda:inputParameter name="${escapeXml(inName)}">${escapeXml(inExpr)}</camunda:inputParameter>\n`;
          }
        }
        if (node.outputs && typeof node.outputs === 'object') {
          for (const [outName, outExpr] of Object.entries(node.outputs)) {
            xml += `          <camunda:outputParameter name="${escapeXml(outName)}">${escapeXml(outExpr)}</camunda:outputParameter>\n`;
          }
        } else {
          // Default outputs
          xml += `          <camunda:outputParameter name="${escapeXml(node.id)}_status">\${status}</camunda:outputParameter>\n`;
          xml += `          <camunda:outputParameter name="${escapeXml(node.id)}_summary">\${summary}</camunda:outputParameter>\n`;
        }
        xml += `        </camunda:inputOutput>\n`;

        xml += `      </bpmn:extensionElements>\n`;
        xml += `${flowRefs}`;
        xml += `    </bpmn:serviceTask>\n`;
        break;
      }

      case 'userTask': {
        xml += `    <bpmn:userTask id="${id}" name="${name}">\n`;
        if (node.formFields && Array.isArray(node.formFields) && node.formFields.length > 0) {
          xml += `      <bpmn:extensionElements>\n`;
          xml += `        <camunda:formData>\n`;
          for (const field of node.formFields) {
            const fId = escapeXml(field.id);
            const fLabel = escapeXml(field.label || fId);
            const fType = escapeXml(field.type || 'string');
            const fDef = field.defaultValue ? ` defaultValue="${escapeXml(field.defaultValue)}"` : '';

            if (field.values && Array.isArray(field.values) && field.values.length > 0) {
              xml += `          <camunda:formField id="${fId}" label="${fLabel}" type="${fType}"${fDef}>\n`;
              for (const val of field.values) {
                xml += `            <camunda:value id="${escapeXml(val.id)}" name="${escapeXml(val.name || val.id)}" />\n`;
              }
              xml += `          </camunda:formField>\n`;
            } else {
              xml += `          <camunda:formField id="${fId}" label="${fLabel}" type="${fType}"${fDef} />\n`;
            }
          }
          xml += `        </camunda:formData>\n`;
          xml += `      </bpmn:extensionElements>\n`;
        }
        xml += `${flowRefs}`;
        xml += `    </bpmn:userTask>\n`;
        break;
      }

      case 'callActivity': {
        const calledElement = escapeXml(node.calledElement || node.called_element || '');
        xml += `    <bpmn:callActivity id="${id}" name="${name}" calledElement="${calledElement}">\n`;
        xml += `      <bpmn:extensionElements>\n`;
        xml += `        <camunda:inputOutput>\n`;
        if (node.inputs && typeof node.inputs === 'object') {
          for (const [inName, inExpr] of Object.entries(node.inputs)) {
            xml += `          <camunda:inputParameter name="${escapeXml(inName)}">${escapeXml(inExpr)}</camunda:inputParameter>\n`;
          }
        }
        if (node.outputs && typeof node.outputs === 'object') {
          for (const [outName, outExpr] of Object.entries(node.outputs)) {
            xml += `          <camunda:outputParameter name="${escapeXml(outName)}">${escapeXml(outExpr)}</camunda:outputParameter>\n`;
          }
        }
        xml += `        </camunda:inputOutput>\n`;
        xml += `      </bpmn:extensionElements>\n`;
        xml += `${flowRefs}`;
        xml += `    </bpmn:callActivity>\n`;
        break;
      }

      default:
        throw new Error(`Unsupported node type: ${type}`);
    }
  }

  // 3. Generate Flows
  for (const flow of normalizedFlows) {
    const fromId = escapeXml(flow.from);
    const toId = escapeXml(flow.to);
    const flowId = escapeXml(flow.id);
    const nameAttr = flow.name ? ` name="${escapeXml(flow.name)}"` : '';

    if (flow.condition) {
      xml += `    <bpmn:sequenceFlow id="${flowId}"${nameAttr} sourceRef="${fromId}" targetRef="${toId}">\n`;
      xml += `      <bpmn:conditionExpression>${escapeXml(flow.condition)}</bpmn:conditionExpression>\n`;
      xml += `    </bpmn:sequenceFlow>\n`;
    } else {
      xml += `    <bpmn:sequenceFlow id="${flowId}"${nameAttr} sourceRef="${fromId}" targetRef="${toId}" />\n`;
    }
  }

  xml += `  </bpmn:process>\n`;
  xml += `</bpmn:definitions>\n`;

  // 3. Apply auto-layout for DI positioning
  const layoutedXml = await layoutProcess(xml);

  // 4. Verify with linter
  const lintRes = await lintBpmn(layoutedXml);
  if (!lintRes.valid) {
    const errorDetails = lintRes.errors.map(e => `[${e.rule}] ${e.message} (${e.id})`).join('\n');
    throw new Error(`Generated BPMN failed lint validation:\n${errorDetails}`);
  }

  return layoutedXml;
}

/**
 * Recipes for common agentic harness graphs.
 */
const RECIPES = {
  'single-agent': (options = {}) => {
    const pid = options.id || 'single_agent_turn';
    const role = options.role || 'implementer';
    return {
      id: pid,
      name: options.name || 'Single Agent Turn',
      documentation: 'Single autonomous agent execution turn.',
      nodes: [
        { type: 'start', id: 'Start_Turn', name: 'Task Started' },
        {
          type: 'serviceTask',
          id: 'Task_Agent',
          name: options.taskName || 'Execute Agent Turn',
          harness_type: 'pi_agent',
          agent_role: role,
          inputs: { instructions: options.instructions || '${instructions}' },
          outputs: {
            agent_status: '${status}',
            agent_summary: '${summary}',
            agent_findings: '${findings}',
            agent_artifacts: '${artifacts}'
          }
        },
        { type: 'end', id: 'End_Done', name: 'Task Completed' }
      ],
      flows: [
        { from: 'Start_Turn', to: 'Task_Agent' },
        { from: 'Task_Agent', to: 'End_Done' }
      ]
    };
  },

  'agent-human-gate': (options = {}) => {
    const pid = options.id || 'agent_review_gate';
    const role = options.role || 'implementer';
    return {
      id: pid,
      name: options.name || 'Agent Turn with Human Gate',
      documentation: 'Agent turn followed by human review gate with fallback on failure.',
      nodes: [
        { type: 'start', id: 'Start_Gate', name: 'Request Received' },
        {
          type: 'serviceTask',
          id: 'Task_Agent',
          name: options.taskName || 'Agent Execution',
          harness_type: 'pi_agent',
          agent_role: role,
          inputs: { instructions: '${instructions}' },
          outputs: {
            agent_status: '${status}',
            agent_summary: '${summary}'
          }
        },
        {
          type: 'exclusiveGateway',
          id: 'GW_Check',
          name: 'Execution Succeeded?'
        },
        {
          type: 'userTask',
          id: 'Task_Signoff',
          name: 'Human Signoff',
          formFields: [
            { id: 'decision', label: 'Decision', type: 'enum', defaultValue: 'accepted', values: [{ id: 'accepted', name: 'Accept' }, { id: 'rejected', name: 'Reject' }] },
            { id: 'notes', label: 'Reviewer Feedback', type: 'textarea' }
          ]
        },
        { type: 'end', id: 'End_Done', name: 'Approved & Completed' },
        { type: 'end', id: 'End_Failed', name: 'Execution Failed' }
      ],
      flows: [
        { from: 'Start_Gate', to: 'Task_Agent' },
        { from: 'Task_Agent', to: 'GW_Check' },
        { from: 'GW_Check', to: 'Task_Signoff', name: 'Success', condition: "agent_status == 'success'" },
        { from: 'GW_Check', to: 'End_Failed', name: 'Failed', condition: "agent_status != 'success'" },
        { from: 'Task_Signoff', to: 'End_Done' }
      ]
    };
  },

  'agent-shell-verify': (options = {}) => {
    const pid = options.id || 'agent_shell_verify';
    return {
      id: pid,
      name: options.name || 'Agent Code Generation and Shell Verification',
      documentation: 'Agent generates code, shell harness compiles/tests, human signs off on result.',
      nodes: [
        { type: 'start', id: 'Start_Build', name: 'Build Requested' },
        {
          type: 'serviceTask',
          id: 'Task_Code',
          name: 'Generate Code',
          harness_type: 'pi_agent',
          agent_role: 'implementer',
          inputs: { prompt: '${prompt}' },
          outputs: { code_status: '${status}', code_summary: '${summary}' }
        },
        {
          type: 'serviceTask',
          id: 'Task_Verify',
          name: 'Verify Shell Build',
          harness_type: 'shell',
          command: options.command || 'make test',
          fail_on_error: false,
          outputs: { verify_status: '${status}', verify_log: '${log}' }
        },
        {
          type: 'exclusiveGateway',
          id: 'GW_Verify_Check',
          name: 'Build Passed?'
        },
        {
          type: 'userTask',
          id: 'Task_Review',
          name: 'Review Build',
          formFields: [
            { id: 'decision', label: 'Decision', type: 'enum', defaultValue: 'accepted', values: [{ id: 'accepted', name: 'Accept' }, { id: 'rejected', name: 'Reject' }] },
            { id: 'notes', label: 'Notes', type: 'textarea' }
          ]
        },
        { type: 'end', id: 'End_Passed', name: 'Build Verified' },
        { type: 'end', id: 'End_Failed', name: 'Build Broke' }
      ],
      flows: [
        { from: 'Start_Build', to: 'Task_Code' },
        { from: 'Task_Code', to: 'Task_Verify' },
        { from: 'Task_Verify', to: 'GW_Verify_Check' },
        { from: 'GW_Verify_Check', to: 'Task_Review', name: 'Passed', condition: "verify_status == 'success'" },
        { from: 'GW_Verify_Check', to: 'End_Failed', name: 'Failed', condition: "verify_status != 'success'" },
        { from: 'Task_Review', to: 'End_Passed' }
      ]
    };
  },

  'multi-agent-pipeline': (options = {}) => {
    const pid = options.id || 'multi_agent_pipeline';
    return {
      id: pid,
      name: options.name || 'Multi-Agent Pipeline',
      documentation: 'Plan -> Implement -> Review sequential pipeline.',
      nodes: [
        { type: 'start', id: 'Start_Pipeline', name: 'Task Ingested' },
        {
          type: 'serviceTask',
          id: 'Task_Plan',
          name: 'Plan Work',
          harness_type: 'pi_agent',
          agent_role: 'planner',
          inputs: { brief: '${brief}' },
          outputs: { plan_status: '${status}', plan_summary: '${summary}' }
        },
        {
          type: 'serviceTask',
          id: 'Task_Implement',
          name: 'Implement Work',
          harness_type: 'pi_agent',
          agent_role: 'implementer',
          inputs: { plan: '${plan_summary}' },
          outputs: { impl_status: '${status}', impl_summary: '${summary}' }
        },
        {
          type: 'serviceTask',
          id: 'Task_Review',
          name: 'Review Work',
          harness_type: 'pi_agent',
          agent_role: 'reviewer',
          inputs: { diff: '${impl_summary}' },
          outputs: { review_status: '${status}', review_summary: '${summary}' }
        },
        { type: 'end', id: 'End_Done', name: 'Pipeline Complete' }
      ],
      flows: [
        { from: 'Start_Pipeline', to: 'Task_Plan' },
        { from: 'Task_Plan', to: 'Task_Implement' },
        { from: 'Task_Implement', to: 'Task_Review' },
        { from: 'Task_Review', to: 'End_Done' }
      ]
    };
  },

  'parallel-fanout': (options = {}) => {
    const pid = options.id || 'parallel_eval';
    return {
      id: pid,
      name: options.name || 'Parallel Evaluation',
      documentation: 'Fan-out to parallel evaluators and join before completion.',
      nodes: [
        { type: 'start', id: 'Start_Eval', name: 'Evaluation Started' },
        { type: 'parallelGateway', id: 'GW_Split', name: 'Parallel Split' },
        {
          type: 'serviceTask',
          id: 'Task_Security',
          name: 'Security Audit',
          harness_type: 'pi_agent',
          agent_role: 'reviewer',
          inputs: { scope: '${code}' },
          outputs: { sec_status: '${status}', sec_findings: '${findings}' }
        },
        {
          type: 'serviceTask',
          id: 'Task_Performance',
          name: 'Performance Analysis',
          harness_type: 'pi_agent',
          agent_role: 'reviewer',
          inputs: { scope: '${code}' },
          outputs: { perf_status: '${status}', perf_findings: '${findings}' }
        },
        { type: 'parallelGateway', id: 'GW_Join', name: 'Parallel Join' },
        { type: 'end', id: 'End_Eval', name: 'Evaluation Complete' }
      ],
      flows: [
        { from: 'Start_Eval', to: 'GW_Split' },
        { from: 'GW_Split', to: 'Task_Security' },
        { from: 'GW_Split', to: 'Task_Performance' },
        { from: 'Task_Security', to: 'GW_Join' },
        { from: 'Task_Performance', to: 'GW_Join' },
        { from: 'GW_Join', to: 'End_Eval' }
      ]
    };
  }
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
BPMN Harness Graph Crafter

Usage:
  node craft-bpmn.js --spec <spec.json> [--out <output.bpmn>]
  node craft-bpmn.js --recipe <recipe> [--id <id>] [--name <name>] [--out <output.bpmn>]

Available Recipes:
  ${Object.keys(RECIPES).join(', ')}
`);
    process.exit(0);
  }

  let spec = null;
  const specIdx = args.indexOf('--spec');
  if (specIdx !== -1 && args[specIdx + 1]) {
    spec = JSON.parse(fs.readFileSync(args[specIdx + 1], 'utf-8'));
  }

  const recipeIdx = args.indexOf('--recipe');
  if (recipeIdx !== -1 && args[recipeIdx + 1]) {
    const recipeName = args[recipeIdx + 1];
    const factory = RECIPES[recipeName];
    if (!factory) {
      console.error(`Unknown recipe "${recipeName}". Available: ${Object.keys(RECIPES).join(', ')}`);
      process.exit(1);
    }
    const idIdx = args.indexOf('--id');
    const nameIdx = args.indexOf('--name');
    const roleIdx = args.indexOf('--role');
    const cmdIdx = args.indexOf('--command');
    spec = factory({
      id: idIdx !== -1 ? args[idIdx + 1] : undefined,
      name: nameIdx !== -1 ? args[nameIdx + 1] : undefined,
      role: roleIdx !== -1 ? args[roleIdx + 1] : undefined,
      command: cmdIdx !== -1 ? args[cmdIdx + 1] : undefined
    });
  }

  if (!spec) {
    console.error('Must provide either --spec <spec.json> or --recipe <recipe-name>');
    process.exit(1);
  }

  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

  try {
    const xml = await craftBpmn(spec);
    if (outFile) {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, xml, 'utf-8');
      console.log(`✅ Successfully crafted and verified BPMN workflow: ${outFile}`);
    } else {
      console.log(xml);
    }
  } catch (err) {
    console.error(`❌ BPMN crafting failed:`, err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  craftBpmn,
  RECIPES
};
