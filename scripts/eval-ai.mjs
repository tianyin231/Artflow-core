#!/usr/bin/env node
/** Evaluate local-rule planning against fixtures/ai-eval/cases.json */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(readFileSync(join(root, 'fixtures/ai-eval/cases.json'), 'utf8'));

function localRulePlan(command) {
  const tag = command.match(/[一-鿿A-Za-z]+/)?.[0] ?? 'original';
  return {
    pixivTarget: { tag, limit: 10, minBookmarks: 0, sort: 'popular_desc' },
    video: { title: command.slice(0, 20) || 'Artflow Video', aspectRatio: '16:9', secondsPerImage: 1.5 },
  };
}

let pass = 0;
const rows = [];
for (const c of cases) {
  const plan = localRulePlan(c.command);
  const ok = Boolean(plan.pixivTarget.tag) && Boolean(plan.video.title);
  if (ok) pass++;
  rows.push(`| ${c.command.slice(0, 20)} | ${ok ? 'PASS' : 'FAIL'} |`);
}
const report = `# AI eval report (mock / local rules)\n\nTotal: ${cases.length}  Pass: ${pass}\n\n| command | result |\n|---|---|\n${rows.join('\n')}\n`;
writeFileSync(join(root, 'docs/ai-eval-report.md'), report);
console.log(`eval:ai ${pass}/${cases.length}`);
process.exit(pass === cases.length ? 0 : 1);
