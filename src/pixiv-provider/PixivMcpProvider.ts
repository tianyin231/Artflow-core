/**
 * PixivMcpProvider — stdio JSON-RPC client for `pixiv mcp`.
 * Lightweight protocol (no external MCP SDK required for tests).
 */
import { spawn, ChildProcess } from 'node:child_process';
import {
  DownloadResult,
  PixivAuthStatus,
  PixivProvider,
  PixivProviderError,
  PixivWork,
  WorkQuery,
} from './types';

export interface McpProviderOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  idleTimeoutMs?: number;
  maxQueue?: number;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export class PixivMcpProvider implements PixivProvider {
  readonly id = 'mcp' as const;
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private queue: Array<() => void> = [];
  private running = 0;
  private idleTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly opts: McpProviderOptions) {}

  private ensureChild(): ChildProcess {
    if (this.disposed) throw new PixivProviderError('PROTOCOL', 'provider disposed');
    if (this.child && !this.child.killed) return this.child;
    this.child = spawn(this.opts.command, this.opts.args ?? ['mcp'], {
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', (d) => this.onData(String(d)));
    this.child.stderr?.on('data', () => {
      /* diagnostics ignored */
    });
    this.child.on('exit', () => {
      this.child = undefined;
      for (const [, p] of this.pending) {
        p.reject(new PixivProviderError('PROTOCOL', 'mcp process exited'));
      }
      this.pending.clear();
    });
    return this.child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(Number(msg.id))) {
          const p = this.pending.get(Number(msg.id))!;
          this.pending.delete(Number(msg.id));
          if (msg.error) p.reject(new PixivProviderError('PROTOCOL', msg.error.message));
          else p.resolve(msg.result);
          this.bumpIdle();
        }
      } catch {
        /* skip */
      }
    }
  }

  private bumpIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idle = this.opts.idleTimeoutMs ?? 0;
    if (idle > 0) {
      this.idleTimer = setTimeout(() => {
        void this.dispose();
      }, idle);
    }
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.running >= (this.opts.maxQueue ?? 8)) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.running++;
    try {
      const child = this.ensureChild();
      const id = this.nextId++;
      const payload = {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: tool, arguments: args },
      };
      const result = await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        child.stdin?.write(JSON.stringify(payload) + '\n');
      });
      return result;
    } finally {
      this.running--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  async authStatus(): Promise<PixivAuthStatus> {
    try {
      const r = (await this.call('auth_status', {})) as {
        content?: { text?: string }[];
        authenticated?: boolean;
      };
      const text = r?.content?.[0]?.text;
      const parsed = text ? JSON.parse(text) : r;
      return {
        authenticated: Boolean(parsed?.authenticated),
        accounts: parsed?.accounts ?? [],
      };
    } catch {
      return { authenticated: false, accounts: [] };
    }
  }

  async *query(q: WorkQuery): AsyncIterable<PixivWork> {
    const tool =
      q.kind === 'ranking'
        ? 'illust_ranking'
        : q.kind === 'user'
          ? 'user_artworks'
          : q.kind === 'bookmarks'
            ? 'user_bookmarks'
            : 'search_illust';
    const r = (await this.call(tool, { ...q })) as { content?: { text?: string }[] };
    const text = r?.content?.[0]?.text ?? '[]';
    const list = JSON.parse(text) as PixivWork[];
    for (const w of list.slice(0, q.limit || 10)) yield w;
  }

  async detail(id: string): Promise<PixivWork> {
    const r = (await this.call('illust_detail', { id })) as { content?: { text?: string }[] };
    return JSON.parse(r?.content?.[0]?.text ?? '{}') as PixivWork;
  }

  async download(
    works: PixivWork[] | string[],
    dir: string
  ): Promise<DownloadResult> {
    const ids = works.map((w) => (typeof w === 'string' ? w : w.id));
    const r = (await this.call('download', { ids, dir, delivery: 'local_path' })) as {
      content?: { text?: string }[];
    };
    const parsed = JSON.parse(r?.content?.[0]?.text ?? '{}') as DownloadResult;
    return {
      files: parsed.files ?? [],
      failures: parsed.failures ?? [],
      warnings: parsed.warnings ?? [],
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.child) {
      this.child.kill();
      this.child = undefined;
    }
  }
}
