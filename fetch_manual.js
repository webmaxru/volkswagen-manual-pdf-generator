// Fetch full manual (topictree + topics + stylesheet + figures) via Playwright and emit a single HTML file + PDF.
// Works for any Volkswagen model whose digital manual is published on volkswagen.no — pass the
// car's part number via --partNumber and override --brand / --model to control the output filename.
// Usage: node fetch_manual.js [--lang nb] [--partNumber 11A012777AR] [--brandPattern WVW] \
//                             [--brand volkswagen] [--model id.4] [--out manual/nb/<basename>]
// Defaults below describe a Norwegian VW ID.4 / ID.4 GTX as a working example.

const { chromium } = require('playwright');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------- arg parsing ----------
function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
}

// Defaults match a Norwegian VW ID.4 / ID.4 GTX. Override via CLI for any other model.
const PART = arg('partNumber', '11A012777AR');
const BRAND = arg('brandPattern', 'WVW');
const BRAND_NAME = arg('brand', 'volkswagen');   // Used only for the output filename and cover page.
const MODEL_NAME = arg('model', 'id.4');         // Used only for the output filename and cover page.
const LANG_SHORT = arg('lang', 'nb');        // BCP-47 short, e.g. nb, en, de, sv, fi, fr, es, it, nl, pl, cs, sk, hu, pt, da, ro, bg, el, tr, ru, uk, sr, hr, sl, et, lt, lv, ar, he, ko, ja, zh ...
const MARKET = arg('market', 'NO');          // ISO country used on VW portal
const REGION = arg('region', 'RDW');         // region for consumer token
const TENANT = arg('tenant', 'default');
const LOCALE = arg('locale', 'nb-NO');
const OWNERS_MANUAL_TERM = arg('ownersManualTerm', 'Instruksjonsbok'); // Set per language when auto-detection fails
const LANDING_BASE = arg('landing', 'https://www.volkswagen.no/no/min-volkswagen/digital-instruksjonsbok-innhold.html');
// Unified PDF naming: <brand>_<model>_<partnumber>_<lang>.pdf, all lowercase.
// Example: volkswagen_id.4_11a012777ar_nb.pdf — same scheme for every language.
const DEFAULT_BASENAME = `${BRAND_NAME}_${MODEL_NAME}_${PART}_${LANG_SHORT}`.toLowerCase();
const OUT_BASE = arg('out', path.join('manual', LANG_SHORT, DEFAULT_BASENAME));
const CONCURRENCY = parseInt(arg('concurrency', '8'), 10);
const JPEG_QUALITY = parseInt(arg('jpegQuality', '80'), 10);
const JPEG_MAX_WIDTH = parseInt(arg('jpegMaxWidth', '1600'), 10);

// Hard rule: this project only scrapes from the Norwegian-market portal. Always scrape from volkswagen.no
// — every language is served from the same RDW backend regardless of landing, so there is no reason
// to point at any other VW national portal. Refusing here keeps future runs honest.
{
  let host;
  try { host = new URL(LANDING_BASE).hostname.toLowerCase(); } catch { host = ''; }
  if (host !== 'www.volkswagen.no' && host !== 'volkswagen.no') {
    console.error(`[fetch] Refusing to run: --landing must be on volkswagen.no, got "${host || LANDING_BASE}".`);
    console.error('[fetch] See AGENTS.md ("Landing rule") — every language is served by the same RDW backend, so the Norwegian landing works for all of them.');
    process.exit(2);
  }
}

const BASE_BFF = 'https://prod-a.dima.fan.vwapps.run/public/bff-digitalmanual';
const BASE_TOPIC = 'https://userguide.volkswagen.de';
const OUT_DIR = path.resolve(path.dirname(OUT_BASE) || '.');
fs.mkdirSync(OUT_DIR, { recursive: true });

function log(...a) { console.log('[fetch]', ...a); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ locale: LOCALE });
  const page = await ctx.newPage();
  const landing = `${LANDING_BASE}?part-number-app=${encodeURIComponent(PART)}&brand-pattern-app=${encodeURIComponent(BRAND)}`;
  log('Opening landing:', landing);
  await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(4000);
  try { await page.click('#onetrust-accept-btn-handler', { timeout: 4000 }); log('Cookie banner accepted'); } catch {}
  await page.waitForTimeout(3000);

  // Step 1: fetch everything inside page context (CORS-safe)
  const bundle = await page.evaluate(async (p) => {
    const fanHeaders = { 'x-fan-market': p.MARKET, 'x-fan-lang': p.LANG_SHORT, accept: 'application/json, text/plain, */*' };
    const tokenObj = { partnumber: p.PART, brandPattern: p.BRAND, market: p.REGION, tokenType: 'partnumber', version: 3 };
    const consumerToken = btoa(JSON.stringify(tokenObj));
    const tokHeaders = { 'x-consumer-token': consumerToken };

    // editions (best effort — gives us title/version/model even if it ever 400s, we still proceed)
    let edition = null;
    try {
      const r = await fetch(`${p.BASE_BFF}/digitalmanual/editions/${p.TENANT}?partNumber=${p.PART}&brandPattern=${p.BRAND}&language=${p.LANG_SHORT}_${p.MARKET}&ownersManualTerms=${encodeURIComponent(p.OWNERS_MANUAL_TERM)}`, { headers: fanHeaders });
      if (r.ok) edition = await r.json();
    } catch {}

    // availability to get exact topicId for language (derive if editions failed)
    let availability = null;
    try {
      const r = await fetch(`${p.BASE_BFF}/digitalmanual/availabilityCheck?partNumber=${p.PART}&brandPattern=${p.BRAND}`, { headers: fanHeaders });
      if (r.ok) availability = await r.json();
    } catch {}

    // resolve topicId
    let topicId = edition?.results?.[0]?.topicId;
    if (!topicId) {
      // best-effort build (pattern observed: {hash}_1_{lang}_{MARKET}) — but hash unknown without editions; rely on editions
      throw new Error('Cannot resolve topicId for this language. Set --ownersManualTerm properly for the language.');
    }
    const editionVersion = edition?.editionVersion || '';
    const modelName = edition?.modelName || '';
    const ownersManualTitle = edition?.results?.[0]?.title || p.OWNERS_MANUAL_TERM;

    // topic tree
    const treeRes = await fetch(`${p.BASE_BFF}/digitalmanual/topictree/${p.TENANT}/${topicId}?partNumber=${p.PART}&brandPattern=${p.BRAND}`, { headers: fanHeaders });
    if (!treeRes.ok) throw new Error(`topictree failed: ${treeRes.status}`);
    const tree = await treeRes.json();

    // stylesheet
    const stRes = await fetch(`${p.BASE_TOPIC}/${p.TENANT}/api/consumer/V4/stylesheet`, { headers: tokHeaders });
    const stylesheet = stRes.ok ? await stRes.text() : '';

    // collect nodes in order (DFS), only those with targetTopicId
    const nodes = [];
    (function walk(n, depth, path) {
      if (!n) return;
      const title = n.title || '';
      const here = [...path, title];
      if (n.targetTopicId) nodes.push({ nodeId: n.nodeId, topicId: n.targetTopicId, title, depth, path: here });
      if (Array.isArray(n.children)) n.children.forEach(c => walk(c, depth + 1, here));
    })(tree.rootNode, 0, []);

    // dedupe by topicId preserving order
    const seen = new Set();
    const ordered = [];
    for (const n of nodes) {
      if (seen.has(n.topicId)) continue;
      seen.add(n.topicId);
      ordered.push(n);
    }

    // fetch topics concurrently
    async function pool(items, conc, fn) {
      const results = new Array(items.length);
      let idx = 0;
      async function worker() {
        while (true) {
          const i = idx++;
          if (i >= items.length) return;
          try { results[i] = await fn(items[i], i); }
          catch (e) { results[i] = { error: String(e) }; }
        }
      }
      await Promise.all(Array.from({ length: conc }, worker));
      return results;
    }

    const topics = await pool(ordered, p.CONCURRENCY, async (n) => {
      const r = await fetch(`${p.BASE_TOPIC}/${p.TENANT}/api/consumer/V4/topic/${n.topicId}`, { headers: tokHeaders });
      if (!r.ok) return { topicId: n.topicId, status: r.status, error: await r.text() };
      const j = await r.json();
      return { topicId: n.topicId, bodyHtml: j.bodyHtml };
    });

    return { topicId, editionVersion, modelName, ownersManualTitle, availability, tree, stylesheet, ordered, topics, consumerToken };
  }, { BASE_BFF, BASE_TOPIC, PART, BRAND, TENANT, MARKET, REGION, LANG_SHORT, OWNERS_MANUAL_TERM, CONCURRENCY });

  log(`Edition: "${bundle.ownersManualTitle}" ${bundle.editionVersion} (${bundle.modelName})`);
  log(`Topics: ${bundle.ordered.length} ordered, fetched ${bundle.topics.filter(t => t.bodyHtml).length} / ${bundle.topics.length}`);
  const failed = bundle.topics.filter(t => !t.bodyHtml);
  if (failed.length) log('Failed topics:', failed.slice(0, 5));

  // Save raw data for the current run (used by the inliner + PDF render below).
  // These _tree.json / _topics.json files are deleted at the end of a successful
  // run — they're scratch artifacts, not deliverables. See AGENTS.md "Output policy".
  fs.writeFileSync(path.join(OUT_DIR, path.basename(OUT_BASE) + '_tree.json'), JSON.stringify(bundle.tree, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, path.basename(OUT_BASE) + '_topics.json'), JSON.stringify({
    topicId: bundle.topicId,
    editionVersion: bundle.editionVersion,
    modelName: bundle.modelName,
    ownersManualTitle: bundle.ownersManualTitle,
    ordered: bundle.ordered,
    topics: bundle.topics,
  }, null, 2));

  // Step 2: inline every referenced image as data-URI (we need to hit userguide with consumer token).
  // Raster images are recompressed to JPEG via sharp here mainly to keep the intermediate composite
  // HTML small (~140 MB -> ~60 MB) so Chromium can ingest it quickly. The data-URI JPEG encoding
  // does NOT survive into the final PDF — Chromium re-rasterizes everything as FlateDecode/PNG —
  // so a second JPEG pass on the produced PDF is mandatory (see Step 4b / AGENTS.md).
  // SVGs are left as-is (vector, tiny, lossless rendering).
  log(`Inlining images (JPEG q=${JPEG_QUALITY}, max width=${JPEG_MAX_WIDTH}px, SVGs kept as vector)...`);
  const imageCache = new Map();
  const imgStats = { fetched: 0, optimized: 0, skipped: 0, failed: 0, bytesIn: 0, bytesOut: 0 };
  async function inlineImage(url) {
    if (imageCache.has(url)) return imageCache.get(url);
    const abs = url.startsWith('http') ? url : `${BASE_TOPIC}/${TENANT}${url.startsWith('/') ? '' : '/'}${url}`;
    const raw = await page.evaluate(async ({ abs, token }) => {
      try {
        const r = await fetch(abs, { headers: { 'x-consumer-token': token } });
        if (!r.ok) return null;
        const buf = await r.arrayBuffer();
        const ct = r.headers.get('content-type') || 'image/png';
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
        return { ct, b64: btoa(bin) };
      } catch { return null; }
    }, { abs, token: bundle.consumerToken });
    if (!raw) { imgStats.failed++; imageCache.set(url, null); return null; }
    imgStats.fetched++;
    const inputBuf = Buffer.from(raw.b64, 'base64');
    imgStats.bytesIn += inputBuf.length;
    let dataUri;
    if (/svg/i.test(raw.ct)) {
      // SVG: keep verbatim (vector, perfect at any scale, already small).
      imgStats.skipped++;
      dataUri = `data:${raw.ct};base64,${raw.b64}`;
      imgStats.bytesOut += inputBuf.length;
    } else {
      try {
        const out = await sharp(inputBuf)
          .rotate() // honor EXIF orientation
          .resize({ width: JPEG_MAX_WIDTH, withoutEnlargement: true })
          .flatten({ background: '#ffffff' }) // strip alpha onto white (JPEG has no alpha)
          .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, chromaSubsampling: '4:2:0' })
          .toBuffer();
        // Only keep the JPEG if it actually shrank — otherwise fall back to the original encoding.
        if (out.length < inputBuf.length) {
          imgStats.optimized++;
          imgStats.bytesOut += out.length;
          dataUri = `data:image/jpeg;base64,${out.toString('base64')}`;
        } else {
          imgStats.skipped++;
          imgStats.bytesOut += inputBuf.length;
          dataUri = `data:${raw.ct};base64,${raw.b64}`;
        }
      } catch (e) {
        imgStats.skipped++;
        imgStats.bytesOut += inputBuf.length;
        dataUri = `data:${raw.ct};base64,${raw.b64}`;
      }
    }
    imageCache.set(url, dataUri);
    return dataUri;
  }

  // rewrite html: collect all src/href with userguide urls or relative api/consumer paths
  async function rewrite(html) {
    if (!html) return '';
    const urlRe = /(src|href)="([^"]*?(?:userguide\.volkswagen\.de|\/api\/consumer\/V4\/(?:figure|image|picture|resource|asset|download))[^"]*)"/gi;
    const urls = new Set();
    let m; while ((m = urlRe.exec(html))) urls.add(m[2]);
    for (const u of urls) {
      const du = await inlineImage(u);
      if (du) html = html.split(`"${u}"`).join(`"${du}"`);
    }
    return html;
  }

  let topicIdx = 0;
  for (const t of bundle.topics) {
    if (t.bodyHtml) t.bodyHtml = await rewrite(t.bodyHtml);
    if (++topicIdx % 20 === 0) log(`  processed ${topicIdx}/${bundle.topics.length}`);
  }

  // Step 3: build composite HTML
  log('Composing HTML...');
  const lang = LANG_SHORT;
  const displayBrand = (BRAND_NAME || '').replace(/\b\w/g, c => c.toUpperCase());
  const displayModel = (MODEL_NAME || '').toUpperCase();
  const vehicleLabel = [displayBrand, displayModel].filter(Boolean).join(' ');
  const title = `${vehicleLabel} — ${bundle.ownersManualTitle}${bundle.editionVersion ? ' (' + bundle.editionVersion + ')' : ''}`;

  function tocHtml(node, depth = 0) {
    if (!node) return '';
    const kids = Array.isArray(node.children) ? node.children : [];
    const id = 't_' + (node.targetTopicId || node.nodeId);
    const label = node.title || '';
    const line = node.targetTopicId
      ? `<li><a href="#${id}">${escapeHtml(label)}</a>${kids.length ? `<ul>${kids.map(c => tocHtml(c, depth + 1)).join('')}</ul>` : ''}</li>`
      : `<li><span>${escapeHtml(label)}</span>${kids.length ? `<ul>${kids.map(c => tocHtml(c, depth + 1)).join('')}</ul>` : ''}</li>`;
    return line;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // Strip outer <html><head>...<body>...</body></html> from topic bodies; keep the inner content only.
  function extractBody(html) {
    if (!html) return '';
    const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return m ? m[1] : html;
  }

  // Build per-topic sections
  const idByTopic = new Map();
  for (const n of bundle.ordered) idByTopic.set(n.topicId, n);

  const articles = bundle.topics.map(t => {
    const n = idByTopic.get(t.topicId);
    if (!n) return '';
    const anchor = 't_' + t.topicId;
    const titleTag = `h${Math.min(6, Math.max(1, n.depth + 1))}`;
    const breadcrumb = n.path.slice(0, -1).join(' › ');
    const body = extractBody(t.bodyHtml);
    return `
<section class="dm-topic" id="${anchor}">
  ${breadcrumb ? `<div class="dm-crumb">${escapeHtml(breadcrumb)}</div>` : ''}
  <${titleTag} class="dm-topic-title">${escapeHtml(n.title)}</${titleTag}>
  <div class="topic-content">${body || '<p class="dm-missing">[Innhold mangler]</p>'}</div>
</section>`;
  }).join('\n');

  const finalHtml = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<base href="${BASE_TOPIC}/${TENANT}/" />
<style>
  @page { size: A4; margin: 18mm 14mm 18mm 14mm; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif; color: #111; line-height: 1.45; }
  .dm-cover { page-break-after: always; padding: 30mm 10mm; text-align: center; }
  .dm-cover h1 { font-size: 28pt; margin: 0 0 8mm; }
  .dm-cover p { color: #555; margin: 2mm 0; }
  .dm-toc { page-break-after: always; }
  .dm-toc h2 { font-size: 18pt; border-bottom: 2px solid #001e50; padding-bottom: 4px; }
  .dm-toc ul { list-style: none; padding-left: 12px; }
  .dm-toc > ul { padding-left: 0; }
  .dm-toc a { color: #001e50; text-decoration: none; }
  .dm-topic { page-break-inside: auto; margin-bottom: 8mm; }
  .dm-topic-title { color: #001e50; margin: 6mm 0 2mm; page-break-after: avoid; }
  .dm-crumb { color: #7a7a7a; font-size: 9pt; margin-top: 4mm; }
  h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
  img, figure, table { max-width: 100%; }
  figure { page-break-inside: avoid; margin: 3mm 0; }
  table { border-collapse: collapse; }
  .dm-missing { color: #a00; }
</style>
<style>
  /* Vendor stylesheet */
  ${bundle.stylesheet}
</style>
</head>
<body>
  <section class="dm-cover">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(bundle.modelName || vehicleLabel)}</p>
    <p>${escapeHtml(bundle.editionVersion || '')}</p>
    <p>Part number: ${escapeHtml(PART)} · Brand: ${escapeHtml(BRAND)} · Language: ${escapeHtml(lang)}</p>
    <p style="margin-top:10mm;color:#888;font-size:9pt">Scraped from volkswagen.no Digital Manual (DIMA). Source URL:<br/>
    <code>${escapeHtml(landing)}</code></p>
  </section>
  <nav class="dm-toc">
    <h2>Innholdsfortegnelse</h2>
    <ul>${tocHtml(bundle.tree.rootNode)}</ul>
  </nav>
  ${articles}
</body>
</html>`;

  // The HTML composite is only a build artefact for `page.pdf()`; written to OS tmp so it never
  // pollutes manual/.
  const htmlPath = path.join(require('os').tmpdir(), `dima_${LANG_SHORT}_${process.pid}.html`);
  fs.writeFileSync(htmlPath, finalHtml);
  log('Composed intermediate HTML:', htmlPath, `(${Math.round(finalHtml.length / 1024)} KB)`);

  // Step 4: render to PDF
  log('Rendering PDF...');
  const pdfPath = path.join(OUT_DIR, path.basename(OUT_BASE) + '.pdf');
  const pdfPage = await ctx.newPage();
  await pdfPage.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 180000 });
  await pdfPage.waitForTimeout(2000);
  await pdfPage.emulateMedia({ media: 'print' });
  await pdfPage.pdf({
    path: pdfPath,
    format: 'A4',
    margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: `<div style="font-size:8pt;color:#999;width:100%;text-align:center;">${escapeHtml(title)}</div>`,
    footerTemplate: `<div style="font-size:8pt;color:#999;width:100%;text-align:center;">Side <span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
  });
  log('Wrote PDF:', pdfPath, `(${Math.round(fs.statSync(pdfPath).size / 1024)} KB)`);

  // Step 4b: post-process PDF — re-encode raster image streams as JPEG.
  // Chromium's page.pdf() rasterizes embedded <img> elements and emits them as
  // FlateDecode (PNG) regardless of the source data-URI encoding, so the in-page
  // mozjpeg pass above does NOT survive into the final PDF without this step.
  // See AGENTS.md "PDF image optimization (mandatory)".
  log(`Optimizing PDF images (JPEG q=${JPEG_QUALITY}, max width=${JPEG_MAX_WIDTH}px)...`);
  const pythonExe = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const optScript = path.join(__dirname, 'optimize_pdf.py');
  const optRes = spawnSync(pythonExe, [
    optScript, pdfPath,
    '--quality', String(JPEG_QUALITY),
    '--max-width', String(JPEG_MAX_WIDTH),
  ], { stdio: 'inherit' });
  if (optRes.status !== 0) {
    console.error('[fetch] PDF optimization failed (status=' + optRes.status + '). The PDF was kept unoptimized.');
    console.error('[fetch] Install requirements: pip install pikepdf Pillow');
    process.exitCode = 1;
  } else {
    log('Final PDF:', pdfPath, `(${Math.round(fs.statSync(pdfPath).size / 1024)} KB)`);
  }

  // Image optimization summary
  if (imgStats.fetched > 0) {
    const saved = imgStats.bytesIn - imgStats.bytesOut;
    const pct = imgStats.bytesIn ? Math.round((saved / imgStats.bytesIn) * 100) : 0;
    log(`Images: ${imgStats.fetched} fetched, ${imgStats.optimized} re-encoded as JPEG, ${imgStats.skipped} kept as-is, ${imgStats.failed} failed.`);
    log(`Image bytes: ${(imgStats.bytesIn / 1024 / 1024).toFixed(1)} MB → ${(imgStats.bytesOut / 1024 / 1024).toFixed(1)} MB (saved ${pct}%).`);
  }

  // Drop the intermediate HTML — only the final PDF is kept in manual/<lang>/.
  try { fs.unlinkSync(htmlPath); } catch {}

  // Drop the intermediate JSON dumps too — they're only useful for debugging the
  // current run and would dominate the repo size if committed.
  try { fs.unlinkSync(path.join(OUT_DIR, path.basename(OUT_BASE) + '_tree.json')); } catch {}
  try { fs.unlinkSync(path.join(OUT_DIR, path.basename(OUT_BASE) + '_topics.json')); } catch {}

  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
