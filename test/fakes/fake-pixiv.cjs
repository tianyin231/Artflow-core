#!/usr/bin/env node
/**
 * Fake pixiv-cli binary for contract tests.
 * Scenarios via FAKE_PIXIV_SCENARIO=ok|unauth|ratelimit|partial|timeout
 */
const fs = require('fs');
const path = require('path');

const scenario = process.env.FAKE_PIXIV_SCENARIO || 'ok';
const argvLog = process.env.FAKE_PIXIV_ARGV_LOG;

if (argvLog) {
  fs.appendFileSync(argvLog, JSON.stringify({ argv: process.argv.slice(2) }) + '\n');
}

function out(obj) {
  process.stdout.write(typeof obj === 'string' ? obj : JSON.stringify(obj) + '\n');
}

function fail(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

const args = process.argv.slice(2);
const cmd = args[0];

function handleAuth() {
  const sub = args[1];
  if (sub === 'import') {
    let input = '';
    process.stdin.on('data', (c) => (input += c));
    process.stdin.on('end', () => {
      if (argvLog) {
        fs.appendFileSync(argvLog, JSON.stringify({ argv: args, stdin: input.trim() }) + '\n');
      }
      out({ ok: true, user: { id: '1', name: 'Fake User' } });
    });
    return true;
  }
  if (sub === 'list') {
    out([{ userId: '1', name: 'Fake User', isDefault: true }]);
    return true;
  }
  if (sub === 'use') {
    out({ ok: true });
    return true;
  }
  if (sub === 'check') {
    out({ authenticated: true });
    return true;
  }
  return false;
}

function handleQuery() {
  const n = scenario === 'partial' ? 2 : 5;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : n;
  const minIdx = args.indexOf('--bookmark-min');
  const minBm = minIdx >= 0 ? Number(args[minIdx + 1]) : 0;
  const lines = [];
  for (let i = 1; i <= n; i++) {
    const bm = 100 * i;
    if (bm < minBm) continue;
    if (lines.length >= limit) break;
    lines.push(
      JSON.stringify({
        id: String(90000 + i),
        type: 'illust',
        title: `Fake ${i}`,
        userId: '42',
        userName: 'Fake Author',
        tags: ['fake', 'test'],
        createDate: '2025-06-15T00:00:00+09:00',
        bookmarkCount: bm,
        viewCount: 1000 * i,
        pageCount: 1,
        xRestrict: 0,
        url: `https://www.pixiv.net/artworks/${90000 + i}`,
      })
    );
  }
  if (args.includes('--json') && cmd !== 'search') {
    out(lines.map((l) => JSON.parse(l)));
  } else {
    process.stdout.write(lines.join('\n') + '\n');
  }
  if (scenario === 'partial') {
    process.stderr.write('warning: 1 item failed\n');
  }
}

function handleDownload() {
  const pathArg = args[args.indexOf('--download-path') + 1] || '.';
  fs.mkdirSync(pathArg, { recursive: true });
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    const items = input.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    for (const item of items) {
      const file = path.join(pathArg, `${item.id}_p0.png`);
      fs.writeFileSync(
        file,
        Buffer.from(
          '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8ffff3f0005fe02feA5c1a4c80000000049454e44ae426082',
          'hex'
        )
      );
    }
    if (scenario === 'partial') {
      process.stderr.write('error: 1 download failed\n');
      process.exit(1);
    }
    process.exit(0);
  });
}

function main() {
  if (scenario === 'unauth') {
    fail(1, 'error: pixiv:auth: unauthorized: no pixiv account is authenticated');
  }
  if (scenario === 'timeout') {
    setTimeout(() => fail(1, 'error: pixiv:network: timeout'), 50);
    return;
  }
  if (scenario === 'ratelimit') {
    fail(1, 'error: pixiv:network: 429 Too Many Requests; retry-after: 2');
  }

  if (cmd === 'auth' && handleAuth()) return;
  if (cmd === 'search' || cmd === 'ranking' || cmd === 'user' || cmd === 'bookmark') {
    handleQuery();
    return;
  }
  if (cmd === 'download') {
    handleDownload();
    return;
  }
  if (cmd === 'illust') {
    out({
      id: args[1],
      type: 'illust',
      title: 'Fake detail',
      userId: '42',
      userName: 'Fake Author',
      tags: ['fake'],
      createDate: '2025-06-15T00:00:00+09:00',
      bookmarkCount: 50,
      pageCount: 1,
      url: `https://www.pixiv.net/artworks/${args[1]}`,
    });
    return;
  }
  fail(1, `error: unknown command ${cmd}`);
}

main();
