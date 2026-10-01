import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateWebWallpaper } from '../../renderer/we-web';

describe('WE web wallpaper', () => {
  it('generates index.html and project.json with listener', () => {
    const dir = mkdtempSync(join(tmpdir(), 'we-web-'));
    const r = generateWebWallpaper({
      title: 'Test Web',
      images: ['a.jpg', 'b.jpg'],
      author: 'Author',
      speed: 1.5,
      outDir: dir,
    });
    expect(existsSync(r.indexPath)).toBe(true);
    const html = readFileSync(r.indexPath, 'utf8');
    expect(html).toContain('wallpaperPropertyListener');
    expect(html).toContain('a.jpg');
    const project = JSON.parse(readFileSync(r.projectJsonPath, 'utf8'));
    expect(project.type).toBe('web');
    expect(project.general.properties.speed.value).toBe(1.5);
  });
});
