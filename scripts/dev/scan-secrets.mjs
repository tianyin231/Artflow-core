#!/usr/bin/env node
/**
 * Scan workspace, fixture data, logs, reports, and git history for secret leaks.
 * Sentinel values injected during tests must never appear in output or history.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Artflow-core repo root (this file lives in scripts/dev/); studio via env or sibling dir.
const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STUDIO = path.resolve(process.env.ARTFLOW_STUDIO_DIR || path.join(CORE, '..', 'Artflow-studio'));
const DEV_DIR = path.resolve(process.env.ARTFLOW_DEV_DIR || path.join(CORE, '.artflow-dev'));
// Git ref whose history is scanned (default HEAD; e.g. ARTFLOW_SCAN_REF=--all).
const SCAN_REF = process.env.ARTFLOW_SCAN_REF || 'HEAD';
const SENTINELS = ['SENTINEL_rt_7f3a9c', 'SENTINEL_at_2b8e41', 'SENTINEL_secret_c0ffee'];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.venv',
  'coverage',
  'playwright-report',
  'test-results',
  'upstream',
  '.cache',
  'android',
  'ios',
  'electron',
  'prepackaged-app',
]);

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.log',
  '.yml', '.yaml', '.sh', '.html', '.css', '.scss', '.py', '.env', '.example',
  '.csv', '.xml', '.vdf', '.snap',
]);

// G6 scan targets: two repos workspace (minus node_modules), fixture data,
// logs, test-results, playwright-report, jest snapshots, and git history.
// docs/ and this script intentionally contain the sentinel *names* as specs.
const targets = [CORE, STUDIO, DEV_DIR];

const ALWAYS_SKIP_FILES = new Set([
  path.join(CORE, 'scripts', 'dev', 'scan-secrets.mjs'),
]);
// Test sources intentionally *construct* sentinel values at runtime.
// They must not appear in logs, reports, fixture data, or non-test git history.
function isTestSource(file) {
  return file.includes('/__tests__/') || file.includes('/e2e/') || file.includes('.test.') || file.includes('.spec.');
}

const findings = [];
const errors = [];

function isTextFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  const base = path.basename(file);
  return base === 'Dockerfile' || base.startsWith('.env');
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full);
      continue;
    }
    if (!ent.isFile()) continue;
    if (ALWAYS_SKIP_FILES.has(full)) continue;
    if (!isTextFile(full)) continue;
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (isTestSource(full)) continue;
    for (const sentinel of SENTINELS) {
      if (content.includes(sentinel)) {
        findings.push({ kind: 'file', path: full, sentinel });
      }
    }
  }
}

function scanGitHistory(repoDir, label) {
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    errors.push(`${label}: git checkout missing at ${repoDir}`);
    return;
  }
  const res = spawnSync(
    'git',
    ['-C', repoDir, 'log', '-p', '--no-color', SCAN_REF],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  if (res.error || res.status !== 0) {
    errors.push(`${label}: git history scan failed (check ARTFLOW_SCAN_REF)`);
    return;
  }
  const out = `${res.stdout || ''}`;
  // Split into per-file patches; ignore test sources (sentinel injection points).
  const chunks = out.split(/^diff --git /m);
  for (const chunk of chunks) {
    const fileMatch = chunk.match(/^a\/(\S+)/);
    const filePath = fileMatch ? fileMatch[1] : '';
    // The scanner itself lists the sentinel names.
    if (filePath === 'scripts/dev/scan-secrets.mjs') continue;
    if (filePath.includes('__tests__/') || filePath.includes('/e2e/') || filePath.includes('.test.') || filePath.includes('.spec.')) {
      continue;
    }
    for (const sentinel of SENTINELS) {
      if (chunk.includes(sentinel)) {
        findings.push({ kind: 'git-history', path: `${label}:${filePath}`, sentinel });
      }
    }
  }
}

for (const t of targets) walk(t);

// Scan common log/report locations that may not be under targets
const extraLogs = [
  path.join(CORE, 'test-results'),
  path.join(STUDIO, 'test-results'),
  path.join(STUDIO, 'playwright-report'),
  path.join(CORE, 'coverage'),
];
for (const d of extraLogs) walk(d);

scanGitHistory(CORE, 'Artflow-core');
scanGitHistory(STUDIO, 'Artflow-studio');

if (findings.length === 0 && errors.length === 0) {
  console.log('scan-secrets: OK — 0 sentinel leaks');
  process.exit(0);
}

console.error('scan-secrets: FAILED — sentinel leaks found:');
for (const error of errors) console.error(`  [scan-error] ${error}`);
for (const f of findings) {
  // Do not reproduce the leaked value in the scan log itself.
  console.error(`  [${f.kind}] ${f.path}: sentinel #${SENTINELS.indexOf(f.sentinel) + 1}`);
}
process.exit(1);
