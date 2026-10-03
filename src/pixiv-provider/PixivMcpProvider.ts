import { spawn, ChildProcess } from 'node:child_process';
import { mkdir, copyFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { PixivCliProvider } from './PixivCliProvider';
import { normalizeWork } from './protocol';
import { DownloadResult, PixivAuthStatus, PixivProvider, PixivProviderError, PixivWork, WorkQuery } from './types';

export interface McpProviderOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  idleTimeoutMs?: number;
  timeoutMs?: number;
  maxQueue?: number;
  authStatus?: () => Promise<PixivAuthStatus>;
}

interface ToolResult {
  content?: { type?: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export class PixivMcpProvider implements PixivProvider {
  readonly id = 'mcp' as const;
  private child?: ChildProcess;
  private initialized?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private queue: Array<() => void> = [];
  private running = 0;
  private idleTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly opts: McpProviderOptions) {}

  private rejectPending(error: Error): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }

  private ensureChild(): ChildProcess {
    if (this.disposed) throw new PixivProviderError('PROTOCOL', 'provider disposed');
    if (this.child) return this.child;
    const child = spawn(this.opts.command, this.opts.args ?? ['mcp'], {
      env: { ...process.env, ...this.opts.env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.buffer = '';
    child.stdout?.on('data', (data) => this.onData(String(data)));
    child.stderr?.on('data', () => undefined);
    child.stdin?.on('error', (error) => this.rejectPending(error));
    child.on('error', (error) => this.rejectPending(error));
    child.on('exit', () => {
      if (this.child === child) { this.child = undefined; this.initialized = undefined; }
      this.rejectPending(new PixivProviderError('PROTOCOL', 'mcp process exited'));
    });
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message: string } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === undefined) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new PixivProviderError('PROTOCOL', msg.error.message));
      else p.resolve(msg.result);
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PixivProviderError('TIMEOUT', `MCP ${method} timed out`));
      }, this.opts.timeoutMs ?? 30000);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  private initialize(): Promise<void> {
    this.ensureChild();
    if (!this.initialized) {
      this.initialized = this.request('initialize', {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Artflow', version: '1.0' },
      }).then(() => {
        this.child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      });
    }
    return this.initialized;
  }

  private async call(tool: string, args: Record<string, unknown>, allowPartial = false): Promise<Record<string, unknown>> {
    if (this.running >= (this.opts.maxQueue ?? 8)) await new Promise<void>((next) => this.queue.push(next));
    this.running++;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      await this.initialize();
      const r = await this.request('tools/call', { name: tool, arguments: args }) as ToolResult;
      const text = r.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n') ?? '';
      if (r.isError && !(allowPartial && r.structuredContent)) throw new PixivProviderError('PROTOCOL', text || 'MCP tool failed');
      if (r.structuredContent) return r.structuredContent;
      try { return JSON.parse(text); } catch { throw new PixivProviderError('PROTOCOL', 'MCP tool did not return structured data'); }
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
      else if (this.running === 0 && this.opts.idleTimeoutMs) this.idleTimer = setTimeout(() => { void this.dispose(); }, this.opts.idleTimeoutMs);
    }
  }

  async authStatus(): Promise<PixivAuthStatus> {
    // pixiv mcp has no auth_status tool; account state belongs to the CLI.
    return this.opts.authStatus ? this.opts.authStatus() : new PixivCliProvider({ cliPath: this.opts.command, env: this.opts.env }).authStatus();
  }

  async *query(q: WorkQuery): AsyncIterable<PixivWork> {
    const tools = { search: 'search_illust', ranking: 'illust_ranking', user: 'user_artworks', bookmarks: 'user_bookmarks', recommended: 'illust_recommended' };
    const args: Record<string, unknown> = { limit: q.limit };
    if (q.kind === 'search') Object.assign(args, { word: q.word ?? '', search_target: q.searchBy, start_date: q.startDate, end_date: q.endDate, bookmark_min: q.minBookmarks, bookmark_max: q.maxBookmarks, ai_mode: q.aiMode });
    if (q.kind === 'ranking') Object.assign(args, { mode: q.mode, date: q.date });
    if (q.userId) args.user_id = Number(q.userId);
    const r = await this.call(tools[q.kind], args);
    for (const w of (r.records as Record<string, unknown>[]).slice(0, q.limit)) yield normalizeWork(w);
  }

  async detail(id: string): Promise<PixivWork> {
    const r = await this.call('illust_detail', { illust_id: Number(id) });
    const work = (r.records as Record<string, unknown>[])[0];
    if (!work) throw new PixivProviderError('NOT_FOUND', `Artwork ${id} not found`);
    return normalizeWork(work);
  }

  async download(works: PixivWork[] | string[], dir: string, opts?: { quality?: string; pages?: string; ugoira?: 'gif' | 'apng' }): Promise<DownloadResult> {
    const r = await this.call('download', { srcs: works.map((w) => typeof w === 'string' ? w : w.url), quality: opts?.quality, pages: opts?.pages, ugoira_mode: opts?.ugoira, delivery: 'local_path' }, true);
    await mkdir(dir, { recursive: true });
    const files: DownloadResult['files'] = [];
    for (const f of (r.files ?? []) as { path: string; illust_id: number; page?: number; mime_type?: string; size_bytes?: number }[]) {
      const destination = join(dir, basename(f.path));
      if (resolve(destination) !== resolve(f.path)) await copyFile(f.path, destination);
      files.push({ path: destination, workId: String(f.illust_id), page: f.page ?? 0, mime: f.mime_type, size: f.size_bytes });
    }
    return { files,
      failures: ((r.failures ?? []) as { illust_id: number; type: string; message: string }[]).map((f) => ({ workId: String(f.illust_id), code: f.type, message: f.message })),
      warnings: ((r.warnings ?? []) as { message: string }[]).map((w) => w.message),
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.rejectPending(new PixivProviderError('PROTOCOL', 'provider disposed'));
    this.child?.kill();
    this.child = undefined;
  }
}
