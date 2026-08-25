#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const templatesDir = path.join(__dirname, '../graph_agent/templates');
const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.html'));

let errors = 0;

for (const file of files) {
  const filePath = path.join(templatesDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const lineNum = index + 1;
    // Check for <style> tags
    if (/<style[\s>]/i.test(line)) {
      console.error(`[LINT ERROR] ${file}:${lineNum} - Local <style> tags are disallowed. Use Tailwind CSS utility classes instead.`);
      errors++;
    }
    // Check for inline style="..." attributes
    if (/\bstyle\s*=\s*["']/i.test(line)) {
      console.error(`[LINT ERROR] ${file}:${lineNum} - Inline style attribute is disallowed: "${line.trim()}". Use Tailwind CSS utility classes instead.`);
      errors++;
    }
  });
}

if (errors > 0) {
  console.error(`\n❌ Template lint failed with ${errors} error(s). Local styles and inline style attributes are disallowed.`);
  process.exit(1);
} else {
  console.log(`\n✅ Template lint passed! All templates strictly use Tailwind CSS utility classes with zero local styles.`);
  process.exit(0);
}
