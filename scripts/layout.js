const fs = require('fs');
const { layoutProcess } = require('bpmn-auto-layout');

async function run() {
  const xml = fs.readFileSync('workflows/contract_review.bpmn', 'utf8');
  try {
    const layoutedXml = await layoutProcess(xml);
    fs.writeFileSync('workflows/contract_review.bpmn', layoutedXml);
    console.log('Layout applied.');
  } catch (err) {
    console.error('Error applying layout:', err);
    process.exit(1);
  }
}

run();
