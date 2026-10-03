/**
 * Wallpaper Engine web-type wallpaper generator (F2-M8).
 */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface WebWallpaperOptions {
  title: string;
  images: string[];
  speed?: number;
  showAuthor?: boolean;
  author?: string;
  outDir: string;
}

export interface WebWallpaperResult {
  dir: string;
  indexPath: string;
  projectJsonPath: string;
}

export function generateWebWallpaper(opts: WebWallpaperOptions): WebWallpaperResult {
  mkdirSync(opts.outDir, { recursive: true });
  const speed = opts.speed ?? 1;
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 3) throw new Error('Wallpaper speed must be between 0.1 and 3');
  const showAuthor = opts.showAuthor ?? true;
  const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
  const images = opts.images.map((source, index) => {
    const relativePath = `assets/${index}-${basename(source)}`;
    mkdirSync(join(opts.outDir, 'assets'), { recursive: true });
    copyFileSync(source, join(opts.outDir, relativePath));
    return relativePath;
  });
  const imageUrls = images.map((path) => path.split('/').map(encodeURIComponent).join('/'));
  const imageJson = JSON.stringify(imageUrls).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const indexHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(opts.title)}</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:#000}
  .slide{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;transition:opacity 1s}
  .slide.active{opacity:1}
  .author{position:absolute;right:16px;bottom:12px;color:#fff;font:14px sans-serif;opacity:.8}
</style></head>
<body>
<div id="stage"></div>
${opts.author ? `<div class="author"${showAuthor ? '' : ' style="display:none"'}>${escapeHtml(opts.author)}</div>` : ''}
<script>
  var images = ${imageJson};
  var speed = ${speed};
  var stage = document.getElementById('stage');
  var slides = images.map(function(src, i) {
    var d = document.createElement('div');
    d.className = 'slide';
    d.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
    if (i === 0) d.classList.add('active');
    stage.appendChild(d);
    return d;
  });
  var idx = 0;
  var timer;
  function startTimer() {
    if (timer !== undefined) clearInterval(timer);
    if (slides.length < 2) return;
    timer = setInterval(function() {
      slides[idx].classList.remove('active');
      idx = (idx + 1) % slides.length;
      slides[idx].classList.add('active');
    }, 4000 / speed);
  }
  startTimer();

  // WE property listener
  window.wallpaperPropertyListener = {
    applyUserProperties: function(props) {
      if (props.speed && Number.isFinite(Number(props.speed.value)) && Number(props.speed.value) > 0) {
        speed = Math.min(3, Math.max(0.1, Number(props.speed.value)));
        startTimer();
      }
      if (props.showAuthor && props.showAuthor.value !== undefined) {
        var a = document.querySelector('.author');
        if (a) a.style.display = props.showAuthor.value ? 'block' : 'none';
      }
    }
  };
</script>
</body></html>`;
  const indexPath = join(opts.outDir, 'index.html');
  writeFileSync(indexPath, indexHtml);

  const project = {
    type: 'web',
    file: 'index.html',
    ...(images[0] ? { preview: images[0] } : {}),
    title: opts.title,
    description: opts.title,
    tags: ['Anime'],
    contentrating: 'Everyone',
    visibility: 'public',
    general: {
      properties: {
        speed: { type: 'slider', value: speed, min: 0.1, max: 3, step: 0.1, text: 'Speed' },
        showAuthor: { type: 'bool', value: showAuthor, text: 'Show author' },
      },
    },
  };
  const projectJsonPath = join(opts.outDir, 'project.json');
  writeFileSync(projectJsonPath, JSON.stringify(project, null, 2));
  return { dir: opts.outDir, indexPath, projectJsonPath };
}
