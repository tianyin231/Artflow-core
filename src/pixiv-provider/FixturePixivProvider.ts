/**
 * Offline FixturePixivProvider — reads fixtures/pixiv/works.json and generates
 * local placeholder images. No network, no real accounts.
 */
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  DownloadResult,
  PixivAuthStatus,
  PixivProvider,
  PixivProviderError,
  PixivWork,
  WorkQuery,
} from './types';

interface FixtureWork extends PixivWork {
  imageFiles?: string[];
}

function fixtureDir(): string {
  return (
    process.env.ARTFLOW_FIXTURE_DIR ||
    join(__dirname, '..', '..', 'fixtures', 'pixiv')
  );
}

export function loadFixtureWorks(): FixtureWork[] {
  const path = join(fixtureDir(), 'works.json');
  if (!existsSync(path)) {
    throw new PixivProviderError('PROTOCOL', `Fixture works.json missing at ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureWork[];
}

/** Minimal RGB PNG writer (same approach as WorkflowManager placeholders). */
function writePng(filePath: string, width: number, height: number, rgb: [number, number, number]): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require('node:zlib') as typeof import('node:zlib');
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  let seed = 0x9e3779b9;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const n = seed & 0x1f;
      raw[o++] = (rgb[0] + ((x * 3) % 64) + n) & 0xff;
      raw[o++] = (rgb[1] + ((y * 2) % 64) + n) & 0xff;
      raw[o++] = (rgb[2] + ((x + y) % 48) + n) & 0xff;
    }
  }
  const idat = zlib.deflateSync(raw, { level: 1 });
  const crcTable: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, png);
}

const PALETTE: Array<[number, number, number]> = [
  [220, 90, 110],
  [90, 140, 220],
  [100, 190, 140],
  [230, 180, 80],
  [170, 110, 210],
  [80, 190, 200],
];

export class FixturePixivProvider implements PixivProvider {
  readonly id = 'fixture' as const;
  private works: FixtureWork[];

  constructor(works?: FixtureWork[]) {
    this.works = works ?? loadFixtureWorks();
  }

  async authStatus(): Promise<PixivAuthStatus> {
    return {
      authenticated: true,
      accounts: [{ userId: 'fixture-user', name: 'Fixture User', isDefault: true }],
    };
  }

  async *query(q: WorkQuery): AsyncIterable<PixivWork> {
    let list = [...this.works];
    if (q.kind === 'search' && q.word) {
      const word = q.word.toLowerCase();
      list = list.filter(
        (w) =>
          w.title.toLowerCase().includes(word) ||
          w.tags.some((t) => t.toLowerCase().includes(word))
      );
    }
    if (q.kind === 'user' && q.userId) {
      list = list.filter((w) => w.authorId === q.userId);
    }
    if (typeof q.minBookmarks === 'number') {
      list = list.filter((w) => (w.bookmarks ?? 0) >= q.minBookmarks!);
    }
    if (typeof q.maxBookmarks === 'number') {
      list = list.filter((w) => (w.bookmarks ?? 0) <= q.maxBookmarks!);
    }
    if (q.startDate) {
      const s = new Date(q.startDate).getTime();
      list = list.filter((w) => new Date(w.createdAt).getTime() >= s);
    }
    if (q.endDate) {
      const e = new Date(q.endDate).getTime();
      list = list.filter((w) => new Date(w.createdAt).getTime() <= e);
    }
    if (q.aiMode === 'exclude') {
      list = list.filter((w) => (w.aiType ?? 1) !== 2);
    } else if (q.aiMode === 'only') {
      list = list.filter((w) => w.aiType === 2);
    }
    const limit = Math.max(1, q.limit || 10);
    for (const w of list.slice(0, limit)) {
      yield w;
    }
  }

  async detail(id: string): Promise<PixivWork> {
    const w = this.works.find((x) => x.id === String(id));
    if (!w) throw new PixivProviderError('NOT_FOUND', `fixture work ${id} not found`);
    return w;
  }

  async download(
    works: PixivWork[] | string[],
    dir: string,
    _opts?: { quality?: string; pages?: string; ugoira?: 'gif' | 'apng' }
  ): Promise<DownloadResult> {
    mkdirSync(dir, { recursive: true });
    const files: DownloadResult['files'] = [];
    const failures: DownloadResult['failures'] = [];
    const warnings: string[] = [];

    for (const item of works) {
      const id = typeof item === 'string' ? item : item.id;
      let work: FixtureWork | undefined;
      try {
        work = typeof item === 'string' ? await this.detail(id) : (item as FixtureWork);
      } catch (e) {
        failures.push({ workId: String(id), code: 'NOT_FOUND', message: String(e) });
        continue;
      }
      const pages = Math.max(1, work.pageCount || 1);
      for (let p = 0; p < pages; p++) {
        const file = join(dir, `${work.id}_p${p}.png`);
        const color = PALETTE[(Number(work.id) + p) % PALETTE.length];
        const size = 640 + ((Number(work.id) + p) % 3) * 80;
        writePng(file, size, size, color);
        const stat = await fs.stat(file);
        files.push({
          path: file,
          workId: work.id,
          page: p,
          mime: 'image/png',
          size: stat.size,
        });
      }
    }
    return { files, failures, warnings };
  }
}
