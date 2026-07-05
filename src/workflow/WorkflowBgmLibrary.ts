import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { ProxyAgent, type Dispatcher } from 'undici';
import { NetworkConfig } from '../config';

export interface WorkflowBgmCandidate {
  path: string;
  name: string;
  directory: string;
  extension: string;
  size: number;
}

export interface WorkflowBgmDownloadResult {
  path: string;
  sourceUrl: string;
  title: string;
  creator?: string;
}

interface InternetArchiveSearchDoc {
  identifier?: string;
  title?: string;
  creator?: string | string[];
  downloads?: number;
}

interface InternetArchiveMetadataFile {
  name?: string;
  format?: string;
  size?: string;
}

const BGM_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
const BGM_DIRECTORIES = ['bgm', 'music', 'assets/bgm', 'assets/music'];
const MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024;

export function listWorkflowBgmCandidates(rootDir = process.cwd(), maxFiles = 80): WorkflowBgmCandidate[] {
  const candidates: WorkflowBgmCandidate[] = [];
  for (const relativeDir of BGM_DIRECTORIES) {
    const dir = resolve(rootDir, relativeDir);
    if (!existsSync(dir)) continue;
    collectAudioFiles(dir, dir, candidates, maxFiles);
    if (candidates.length >= maxFiles) break;
  }
  return candidates;
}

export function isSupportedWorkflowBgmPath(path: string): boolean {
  return BGM_EXTENSIONS.has(extname(path).toLowerCase());
}

export async function downloadWorkflowBgmFromInternet(input: {
  query: string;
  queries?: string[];
  outputDir: string;
  maxResults?: number;
  network?: NetworkConfig;
}): Promise<WorkflowBgmDownloadResult | null> {
  const query = input.query.trim();
  if (!query) return null;

  mkdirSync(input.outputDir, { recursive: true });
  const dispatcher = createFetchDispatcher(input.network);
  const options: BgmFetchOptions = {
    dispatcher,
    retries: Math.max(input.network?.retries ?? 2, 1),
  };
  try {
    const queries = Array.from(new Set([
      ...(input.queries ?? []),
      query,
      `${query} OST`,
      `${query} soundtrack`,
      `${query} character theme`,
      `${query} remix`,
      `${query} cover`,
      `${query} instrumental`,
    ].map((item) => item.trim()).filter(Boolean)));

    for (const searchQuery of queries) {
      let docs: InternetArchiveSearchDoc[] = [];
      try {
        docs = await searchInternetArchiveAudio(searchQuery, input.maxResults ?? 8, options);
      } catch {
        continue;
      }
      for (const doc of docs) {
        if (!doc.identifier) continue;
        try {
          const result = await tryDownloadInternetArchiveItem(doc, input.outputDir, searchQuery, options);
          if (result) return result;
        } catch {
          continue;
        }
      }
    }
    return null;
  } finally {
    await closeDispatcher(dispatcher);
  }
}

interface BgmFetchOptions {
  dispatcher?: Dispatcher;
  retries: number;
}

async function searchInternetArchiveAudio(query: string, rows: number, options: BgmFetchOptions): Promise<InternetArchiveSearchDoc[]> {
  const safeTerms = query
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((term) => isUsefulSearchTerm(term))
    .slice(0, 8);
  const requiredTerms = pickRequiredTerms(safeTerms);
  const textQuery = requiredTerms.length ? requiredTerms.map((term) => `"${term}"`).join(' AND ') : '"OST"';
  const blockedTerms = [
    'audiobook',
    'audio book',
    'librivox',
    'podcast',
    'lecture',
    'sermon',
    'speech',
    'reading',
    'story',
    'stories',
    'english',
    'listening',
    'lesson',
  ];
  const searchQuery = `mediatype:audio AND (${textQuery}) AND NOT (${blockedTerms.map((term) => `"${term}"`).join(' OR ')})`;
  const url = new URL('https://archive.org/advancedsearch.php');
  url.searchParams.set('q', searchQuery);
  url.searchParams.set('fl[]', 'identifier');
  url.searchParams.append('fl[]', 'title');
  url.searchParams.append('fl[]', 'creator');
  url.searchParams.append('fl[]', 'downloads');
  url.searchParams.set('sort[]', 'downloads desc');
  url.searchParams.set('rows', String(rows));
  url.searchParams.set('output', 'json');

  const response = await fetchWithRetry(url, 15000, options);
  if (!response.ok) {
    throw new Error(`Internet Archive search failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { response?: { docs?: InternetArchiveSearchDoc[] } };
  return body.response?.docs ?? [];
}

async function tryDownloadInternetArchiveItem(
  doc: InternetArchiveSearchDoc,
  outputDir: string,
  query: string,
  options: BgmFetchOptions
): Promise<WorkflowBgmDownloadResult | null> {
  const identifier = doc.identifier;
  if (!identifier) return null;
  const itemText = [identifier, doc.title, doc.creator].flat().filter(Boolean).join(' ');
  if (isProbablySpokenAudio(itemText)) return null;
  if (!isThemeRelevant(itemText, query)) return null;

  const metadataResponse = await fetchWithRetry(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, 15000, options);
  if (!metadataResponse.ok) return null;
  const metadata = (await metadataResponse.json()) as { files?: InternetArchiveMetadataFile[] };
  const file = (metadata.files ?? []).find((item) => {
    const name = item.name ?? '';
    const format = item.format ?? '';
    if (isProbablySpokenAudio(`${name} ${format}`)) return false;
    const extension = extname(name).toLowerCase();
    const size = Number(item.size ?? 0);
    return extension === '.mp3' && size > 256 * 1024 && size <= MAX_DOWNLOAD_BYTES;
  });
  if (!file?.name) return null;

  const sourceUrl = `https://archive.org/download/${encodeURIComponent(identifier)}/${file.name
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
  const audioResponse = await fetchWithRetry(sourceUrl, 45000, options);
  if (!audioResponse.ok) return null;
  const contentLength = Number(audioResponse.headers.get('content-length') ?? 0);
  if (contentLength > MAX_DOWNLOAD_BYTES) return null;

  const buffer = Buffer.from(await audioResponse.arrayBuffer());
  if (buffer.length < 256 * 1024 || buffer.length > MAX_DOWNLOAD_BYTES) return null;

  const title = cleanFilePart(Array.isArray(doc.title) ? doc.title[0] : doc.title || identifier);
  const fileName = `${title || identifier}-${Date.now()}.mp3`;
  const outputPath = join(outputDir, fileName);
  writeFileSync(outputPath, buffer);
  return {
    path: outputPath,
    sourceUrl,
    title: Array.isArray(doc.title) ? doc.title[0] : doc.title || identifier,
    creator: Array.isArray(doc.creator) ? doc.creator[0] : doc.creator,
  };
}

function isProbablySpokenAudio(value: string): boolean {
  return /\b(audiobook|audio\s*book|librivox|podcast|lecture|sermon|speech|spoken|reading|story|stories|english\s*listening|listening\s*test|lesson|course|chapter)\b/i.test(value);
}

function isUsefulSearchTerm(term: string): boolean {
  if (term.length < 3) return false;
  return !/^(the|and|with|for|from|music|song|track|theme|ost|soundtrack|instrumental|official|cover|remix|background|cinematic|ambient|epic|electronic|game|anime)$/i.test(term);
}

function pickRequiredTerms(terms: string[]): string[] {
  const unique = Array.from(new Set(terms));
  return unique.slice(0, Math.min(unique.length, 4));
}

function isThemeRelevant(value: string, query: string): boolean {
  const haystack = normalizeForMatch(value);
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((term) => isUsefulSearchTerm(term));
  if (!terms.length) return false;
  const matched = terms.filter((term) => haystack.includes(normalizeForMatch(term)));
  return matched.length >= Math.min(2, terms.length);
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ');
}

async function fetchWithRetry(input: string | URL, timeoutMs: number, options: BgmFetchOptions): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await fetch(input, {
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: options.dispatcher,
      } as RequestInit & { dispatcher?: Dispatcher });
    } catch (error) {
      lastError = error;
      if (attempt < options.retries) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 800 * (attempt + 1)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function createFetchDispatcher(network?: NetworkConfig): Dispatcher | undefined {
  const configuredProxy = network?.proxy?.enabled ? buildProxyUrl(network.proxy) : undefined;
  const envProxy = process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const proxyUrl = configuredProxy || envProxy;
  if (!proxyUrl || !/^https?:\/\//i.test(proxyUrl)) return undefined;
  return new ProxyAgent(proxyUrl);
}

function buildProxyUrl(proxy: NonNullable<NetworkConfig['proxy']>): string | undefined {
  const protocol = proxy.protocol || 'http';
  if (protocol !== 'http' && protocol !== 'https') return undefined;
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}${proxy.password ? `:${encodeURIComponent(proxy.password)}` : ''}@`
    : '';
  return `${protocol}://${auth}${proxy.host}:${proxy.port}`;
}

async function closeDispatcher(dispatcher?: Dispatcher): Promise<void> {
  await (dispatcher as { close?: () => Promise<void> } | undefined)?.close?.();
}

function cleanFilePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function collectAudioFiles(
  rootDir: string,
  currentDir: string,
  candidates: WorkflowBgmCandidate[],
  maxFiles: number,
  depth = 0
): void {
  if (depth > 3 || candidates.length >= maxFiles) return;
  for (const item of readdirSync(currentDir)) {
    if (candidates.length >= maxFiles) return;
    const fullPath = join(currentDir, item);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      collectAudioFiles(rootDir, fullPath, candidates, maxFiles, depth + 1);
      continue;
    }
    if (!stats.isFile()) continue;
    const extension = extname(item).toLowerCase();
    if (!BGM_EXTENSIONS.has(extension)) continue;
    candidates.push({
      path: fullPath,
      name: basename(item, extension),
      directory: currentDir.replace(rootDir, '').replace(/^[\\/]/, '') || '.',
      extension,
      size: stats.size,
    });
  }
}
