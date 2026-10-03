import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { generateWebWallpaper } from '../../renderer/we-web';

describe('WE web wallpaper', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'we-web-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function makeImages() {
    return ['a.jpg', 'b.jpg'].map((name) => {
      const path = join(dir, name);
      writeFileSync(path, Buffer.from([1, 2, 3]));
      return path;
    });
  }

  function loadScript(html: string) {
    const setInterval = jest.fn().mockReturnValue(1);
    const clearInterval = jest.fn();
    const element = () => ({ style: {}, classList: { add: jest.fn(), remove: jest.fn() }, appendChild: jest.fn() });
    const author = element();
    const window: { wallpaperPropertyListener?: { applyUserProperties(props: unknown): void } } = {};
    runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)![1], {
      window, document: { getElementById: () => element(), createElement: element, querySelector: () => author },
      setInterval, clearInterval,
    });
    return { window, setInterval, clearInterval, author };
  }

  it('copies its assets and declares an entry file that Wallpaper Engine can load', () => {
    const r = generateWebWallpaper({ title: 'Test Web', images: makeImages(), author: 'Author', speed: 1.5, outDir: join(dir, 'export') });
    const project = JSON.parse(readFileSync(r.projectJsonPath, 'utf8'));
    expect(project.type).toBe('web');
    expect(existsSync(join(r.dir, project.file))).toBe(true);
    expect(existsSync(join(r.dir, project.preview))).toBe(true);
    expect(readFileSync(join(r.dir, 'assets/1-b.jpg'))).toEqual(Buffer.from([1, 2, 3]));
    expect(project.general.properties.speed.value).toBe(1.5);
  });

  it('reschedules the slideshow when speed changes and keeps the author toggle available', () => {
    const r = generateWebWallpaper({ title: 'Test', images: makeImages(), author: 'Author', showAuthor: false, outDir: join(dir, 'export') });
    const html = readFileSync(r.indexPath, 'utf8');
    expect(html).toContain('style="display:none"');
    const runtime = loadScript(html);
    expect(runtime.setInterval).toHaveBeenLastCalledWith(expect.any(Function), 4000);
    runtime.window.wallpaperPropertyListener!.applyUserProperties({ speed: { value: 2 }, showAuthor: { value: true } });
    expect(runtime.clearInterval).toHaveBeenCalledWith(1);
    expect(runtime.setInterval).toHaveBeenLastCalledWith(expect.any(Function), 2000);
    expect(runtime.author.style).toMatchObject({ display: 'block' });
  });

  it('escapes artwork metadata so it cannot inject markup or a second script', () => {
    const r = generateWebWallpaper({ title: '</title><script>throw 1</script>', images: makeImages(), author: '<img src=x onerror="throw 1">', outDir: join(dir, 'export') });
    const html = readFileSync(r.indexPath, 'utf8');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;/title&gt;');
    expect(() => loadScript(html)).not.toThrow();
  });

  it('supports an empty slideshow without starting a crashing interval', () => {
    const r = generateWebWallpaper({ title: 'Empty', images: [], outDir: dir });
    const runtime = loadScript(readFileSync(r.indexPath, 'utf8'));
    expect(runtime.setInterval).not.toHaveBeenCalled();
  });

  it('encodes image filenames as URLs while preserving their copied filesystem paths', () => {
    const image = join(dir, 'art#tag%20.jpg');
    writeFileSync(image, Buffer.from([1, 2, 3]));
    const r = generateWebWallpaper({ title: 'Special name', images: [image], outDir: join(dir, 'export') });
    const html = readFileSync(r.indexPath, 'utf8');
    const imageUrls = JSON.parse(html.match(/var images = (.*);/)![1]) as string[];
    const url = new URL(imageUrls[0], 'https://wallpaper.local/');
    expect(url.hash).toBe('');
    expect(existsSync(join(r.dir, decodeURIComponent(url.pathname)))).toBe(true);
  });
});
