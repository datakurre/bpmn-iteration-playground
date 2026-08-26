#!/usr/bin/env node

/**
 * Automated Layout CLI & Module for BPMN files.
 *
 * Uses bpmn-auto-layout to generate or repair DI coordinates (<bpmndi:BPMNDiagram>)
 * ensuring diagrams can be visually inspected in Workflow Studio and are properly positioned.
 *
 * Usage:
 *   node layout-bpmn.js <input.bpmn> [output.bpmn]
 *   node layout-bpmn.js --in-place <file.bpmn>
 */

const fs = require('fs');
const path = require('path');
const { layoutProcess } = require('bpmn-auto-layout');

/**
 * Automatically layout a BPMN XML string.
 *
 * @param {string} xml BPMN 2.0 XML
 * @returns {Promise<string>} BPMN 2.0 XML with layouted DI elements
 */
async function autoLayoutBpmn(xml) {
  return await layoutProcess(xml);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
BPMN Auto-Layout Utility

Usage:
  node layout-bpmn.js <input.bpmn> [output.bpmn]
  node layout-bpmn.js --in-place <file.bpmn>
`);
    process.exit(0);
  }

  const inPlace = args.includes('--in-place');
  const filteredArgs = args.filter(a => a !== '--in-place');

  if (filteredArgs.length === 0) {
    console.error('No input file specified.');
    process.exit(1);
  }

  const inputFile = filteredArgs[0];
  const outputFile = inPlace ? inputFile : (filteredArgs[1] || inputFile);

  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  const xml = fs.readFileSync(inputFile, 'utf-8');
  try {
    const layouted = await autoLayoutBpmn(xml);
    fs.writeFileSync(outputFile, layouted, 'utf-8');
    console.log(`✅ Successfully auto-layouted: ${outputFile}`);
  } catch (err) {
    console.error(`❌ Layout failed:`, err.message);
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
  autoLayoutBpmn
};
