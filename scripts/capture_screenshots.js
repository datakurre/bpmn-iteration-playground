const puppeteer = require('puppeteer-core');

async function capture() {
  console.log('Launching headless browser via puppeteer-core...');
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_BIN || 'chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('1. Capturing Homepage...');
  await page.goto('http://127.0.0.1:8000', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: 'homepage_verification.png', fullPage: true });
  console.log('Saved homepage_verification.png');

  console.log('2. Capturing Admin Page...');
  await page.goto('http://127.0.0.1:8000/admin', { waitUntil: 'networkidle0' });
  await page.screenshot({ path: 'admin_verification.png', fullPage: true });
  console.log('Saved admin_verification.png');

  console.log('3. Starting workflow instance to verify Form-JS and BPMN diagram UI...');
  const response = await page.evaluate(async () => {
    const r = await fetch('/workflow/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bpmn_path: 'bpmn_agent/data/workflows/contract_review.bpmn',
        variables: { contract: 'Visual inspection test for BPMN + form-js pipeline.' }
      })
    });
    return await r.json();
  });

  console.log('Workflow instance started:', response.workflow_id);
  if (response.workflow_id) {
    await page.goto(`http://127.0.0.1:8000/instance/${response.workflow_id}`, { waitUntil: 'networkidle0' });
    await new Promise(r => setTimeout(r, 2000));
    await page.screenshot({ path: 'instance_verification.png', fullPage: true });
    console.log('Saved instance_verification.png');
  }

  await browser.close();
  console.log('Visual verification screenshots completed successfully!');
}

capture().catch(err => {
  console.error('Error capturing screenshots:', err);
  process.exit(1);
});
