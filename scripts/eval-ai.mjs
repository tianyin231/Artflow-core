#!/usr/bin/env node
/** Evaluate local-rule planning against fixtures/ai-eval/cases.json */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localRulePlan, validatePlan } from '../dist/ai/plan-schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(readFileSync(join(root, 'fixtures/ai-eval/cases.json'), 'utf8'));

let pass = 0;
const rows = [];
for (const c of cases) {
  const plan = localRulePlan(c.command);
  const expected = c.expect;
  const ok = validatePlan(plan).ok
    && (expected.tagPresent === undefined || Boolean(plan.pixivTarget.tag) === expected.tagPresent)
    && (expected.hasTitle === undefined || Boolean(plan.video.title) === expected.hasTitle)
    && (expected.tag === undefined || plan.pixivTarget.tag === expected.tag)
    && (expected.minBookmarks === undefined || plan.pixivTarget.minBookmarks === expected.minBookmarks);
  if (ok) pass++;
  rows.push(`| ${c.command.slice(0, 20)} | ${ok ? 'PASS' : 'FAIL'} |`);
}
const report = `# AI eval report (mock / local rules)\n\nTotal: ${cases.length}  Pass: ${pass}\n\n| command | result |\n|---|---|\n${rows.join('\n')}\n`;
writeFileSync(join(root, 'docs/ai-eval-report.md'), report);
console.log(`eval:ai ${pass}/${cases.length}`);
process.exit(pass === cases.length ? 0 : 1);
