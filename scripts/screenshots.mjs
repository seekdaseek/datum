#!/usr/bin/env node
//
// scripts/screenshots.mjs — regenerate the deck PNGs from the built frontend.
//
//   npm run build:web && node scripts/screenshots.mjs [--network undeployed]
//
// Serves frontend-dist/ on an ephemeral port and captures three element-clipped
// PNGs at 2x for a deck. Deck images are regenerable from the real page rather
// than hand-captured, so they cannot drift from what the page actually renders.
//
// Output: docs/screenshots/*.png (gitignored — the script is the artifact).
//
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'frontend-dist');
const OUT = resolve(ROOT, 'docs/screenshots');

const netIdx = process.argv.indexOf('--network');
const NETWORK = netIdx >= 0 ? process.argv[netIdx + 1] : null;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml',
};

// Each shot names the section to frame and what it is for.
const SHOTS = [
  {
    file: '1-headline-comparison.png',
    what: 'marked vs realisable, with the hypothetical-size framing',
    // header + the gap card, so the "NOT THE ATTESTED BOOK" banner is always in frame
    selector: '#app',
    clipTo: '.gapcard',
    includeHeader: true,
  },
  { file: '2-verify-match.png', what: 'client-side venuesHash recompute', selector: '#app > section:last-of-type' },
  // Frame the whole card, not the bare <table>: the heading and the padding-slot
  // footnote are the context that makes the table readable.
  { file: '3-venue-array.png', what: 'the published venue state', selector: '#app > section:nth-of-type(3)' },
];

const main = async () => {
  if (!existsSync(DIST)) {
    console.error(`No build at ${DIST}. Run: npm run build:web`);
    process.exit(1);
  }
  await mkdir(OUT, { recursive: true });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname === '/' ? '/index.html' : url.pathname;
      const body = await readFile(resolve(DIST, `.${p}`));
      res.writeHead(200, { 'Content-Type': MIME[extname(p)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/${NETWORK ? `?network=${NETWORK}` : ''}`;

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 2 });
    page.on('console', (m) => {
      // favicon 404s are browser-initiated noise, not page errors
      const t = m.text();
      // favicon 404s are browser-initiated noise, not page errors
      if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(t)) console.error(`  page error: ${t}`);
    });
    page.on('requestfailed', () => {});

    await page.goto(base, { waitUntil: 'networkidle0', timeout: 60_000 });

    // The verify indicator resolves asynchronously; wait for a real verdict
    // rather than capturing the pending state.
    await page.waitForFunction(
      () => {
        const s = document.querySelector('.vstatus');
        return s && (s.classList.contains('match') || s.classList.contains('mismatch'));
      },
      { timeout: 60_000 },
    );

    for (const shot of SHOTS) {
      const target = shot.clipTo ?? shot.selector;
      const box = await page.$eval(target, (elm) => {
        const r = elm.getBoundingClientRect();
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
      });
      // Frame the card, not the bare element, and always include the page header
      // on the headline shot so the banner is inseparable from the numbers.
      const pad = shot.padCard ? 26 : 0;
      const clip = shot.includeHeader
        ? { x: 0, y: 0, width: 1400, height: box.y + box.height + 24 }
        : { x: box.x - pad, y: box.y - pad, width: box.width + pad * 2, height: box.height + pad * 2 };

      await page.screenshot({ path: resolve(OUT, shot.file), clip, captureBeyondViewport: true });
      console.log(`  ${shot.file.padEnd(28)} ${Math.round(clip.width)}x${Math.round(clip.height)}  ${shot.what}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\nWrote ${SHOTS.length} PNGs to docs/screenshots/`);
};

main().catch((e) => {
  console.error('screenshots failed:', e.message);
  process.exit(1);
});
