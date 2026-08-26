#!/usr/bin/env node

/**
 * BPMN Linter and Validator for graph-agent BPMN crafting skill.
 *
 * Runs opinionated bpmnlint rules + custom Camunda 7 / SpiffWorkflow validation.
 *
 * Usage:
 *   node lint-bpmn.js <file.bpmn> [options]
 *   node lint-bpmn.js --glob "graph_agent/data/workflows/*.bpmn"
 *
 * Options:
 *   --json          Emit results as JSON
 *   --fix-layout    Auto-layout the diagram if missing DI or layout errors
 *   --strict        Treat warnings as errors (exit code 1)
 *   --config <file> Use custom bpmnlint config JSON
 */

const fs = require('fs');
const path = require('path');
const { BpmnModdle } = require('bpmn-moddle');
const camundaModdle = require('camunda-bpmn-moddle/resources/camunda');
const { Linter } = require('bpmnlint');
const NodeResolver = require('bpmnlint/lib/resolver/node-resolver');
const { layoutProcess } = require('bpmn-auto-layout');
const { validateCamundaRules } = require('../rules/camunda-rules');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../config/bpmnlintrc.json');

/**
 * Lint a BPMN XML string against opinionated rules and Camunda extensions.
 *
 * @param {string} xml BPMN XML content
 * @param {object} options Options { config, strict }
 * @returns {Promise<{ valid: boolean, errors: Array, warnings: Array, info: Array, allIssues: Array }>}
 */
async function lintBpmn(xml, options = {}) {
  const moddle = new BpmnModdle({ camunda: camundaModdle });
  let rootElement, parseWarnings;

  try {
    const parseRes = await moddle.fromXML(xml);
    rootElement = parseRes.rootElement;
    parseWarnings = parseRes.warnings || [];
  } catch (err) {
    return {
      valid: false,
      errors: [{ id: 'parser', message: `XML Parse Error: ${err.message}`, category: 'error', rule: 'syntax/xml' }],
      warnings: [],
      info: [],
      allIssues: [{ id: 'parser', message: `XML Parse Error: ${err.message}`, category: 'error', rule: 'syntax/xml' }]
    };
  }

  // 1. Run bpmnlint
  let config = options.config;
  if (!config) {
    if (fs.existsSync(DEFAULT_CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf-8'));
    } else {
      config = { extends: 'bpmnlint:recommended' };
    }
  }

  const linter = new Linter({ resolver: new NodeResolver() });
  const lintReports = await linter.lint(rootElement, config);

  const errors = [];
  const warnings = [];
  const info = [];

  // Add bpmnlint reports
  for (const [ruleName, reports] of Object.entries(lintReports)) {
    for (const rep of reports) {
      const issue = {
        id: rep.id || 'diagram',
        message: rep.message,
        category: rep.category || 'warn',
        rule: `bpmnlint/${ruleName}`
      };
      if (rep.category === 'error' || rep.category === 'rule-error') {
        errors.push(issue);
      } else if (rep.category === 'warn') {
        warnings.push(issue);
      } else {
        info.push(issue);
      }
    }
  }

  // 2. Run custom Camunda validation rules
  const camundaIssues = validateCamundaRules(rootElement, options);
  for (const issue of camundaIssues) {
    if (issue.category === 'error') {
      errors.push(issue);
    } else if (issue.category === 'warn') {
      warnings.push(issue);
    } else {
      info.push(issue);
    }
  }

  const allIssues = [...errors, ...warnings, ...info];
  const valid = options.strict ? (errors.length === 0 && warnings.length === 0) : (errors.length === 0);

  return {
    valid,
    errors,
    warnings,
    info,
    allIssues
  };
}

// ── CLI Runner ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
BPMN Linter & Validator for graph-agent

Usage:
  node lint-bpmn.js <file.bpmn> [options]
  node lint-bpmn.js --glob "<pattern>"

Options:
  --json          Output JSON format
  --fix-layout    Auto-layout the diagram and overwrite file
  --strict        Fail on warnings
  --config <path> Use custom bpmnlint JSON config
`);
    process.exit(0);
  }

  const jsonMode = args.includes('--json');
  const fixLayout = args.includes('--fix-layout');
  const strictMode = args.includes('--strict');

  let configOverride = null;
  const configIdx = args.indexOf('--config');
  if (configIdx !== -1 && args[configIdx + 1]) {
    configOverride = JSON.parse(fs.readFileSync(args[configIdx + 1], 'utf-8'));
  }

  const files = [];
  const globIdx = args.indexOf('--glob');
  if (globIdx !== -1 && args[globIdx + 1]) {
    const globPattern = args[globIdx + 1];
    const dir = path.dirname(globPattern);
    const pattern = path.basename(globPattern);
    if (fs.existsSync(dir)) {
      const matched = fs.readdirSync(dir).filter(f => {
        if (pattern.startsWith('*')) return f.endsWith(pattern.slice(1));
        return f === pattern;
      }).map(f => path.join(dir, f));
      files.push(...matched);
    }
  } else {
    for (const arg of args) {
      if (!arg.startsWith('--') && (arg.endsWith('.bpmn') || arg.endsWith('.xml'))) {
        files.push(arg);
      }
    }
  }

  if (files.length === 0) {
    console.error('No .bpmn files specified.');
    process.exit(1);
  }

  let totalErrors = 0;
  let totalWarnings = 0;
  const results = {};

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`File not found: ${file}`);
      totalErrors++;
      continue;
    }

    let xml = fs.readFileSync(file, 'utf-8');

    if (fixLayout) {
      try {
        xml = await layoutProcess(xml);
        fs.writeFileSync(file, xml, 'utf-8');
        if (!jsonMode) console.log(`✓ Auto-layout applied to ${file}`);
      } catch (err) {
        console.error(`Layout error on ${file}:`, err.message);
      }
    }

    const res = await lintBpmn(xml, { config: configOverride, strict: strictMode });
    results[file] = res;
    totalErrors += res.errors.length;
    totalWarnings += res.warnings.length;

    if (!jsonMode) {
      console.log(`\n📄 Checking ${file}:`);
      if (res.allIssues.length === 0) {
        console.log('   ✅ Passed all checks!');
      } else {
        for (const issue of res.errors) {
          console.log(`   ❌ [ERROR] ${issue.rule} (${issue.id}): ${issue.message}`);
        }
        for (const issue of res.warnings) {
          console.log(`   ⚠️  [WARN]  ${issue.rule} (${issue.id}): ${issue.message}`);
        }
        for (const issue of res.info) {
          console.log(`   ℹ️  [INFO]  ${issue.rule} (${issue.id}): ${issue.message}`);
        }
      }
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(`\n========================================`);
    console.log(`Summary: ${files.length} file(s) checked. Errors: ${totalErrors}, Warnings: ${totalWarnings}`);
    console.log(`========================================`);
  }

  const failed = strictMode ? (totalErrors > 0 || totalWarnings > 0) : (totalErrors > 0);
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal lint error:', err);
    process.exit(1);
  });
}

module.exports = {
  lintBpmn
};
