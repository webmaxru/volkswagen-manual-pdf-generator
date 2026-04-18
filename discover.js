// Discovery script: loads the VW digital manual page, captures network requests,
// and dumps the final DOM + interesting JSON responses to help us reverse-engineer the API.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = 'https://www.volkswagen.no/no/min-volkswagen/digital-instruksjonsbok-innhold.html?part-number-app=11A012777AR&brand-pattern-app=WVW';

(async () => {
  const outDir = path.join(__dirname, 'discover_out');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'no-NO' });
  const page = await context.newPage();

  const requests = [];
  const responses = [];

  page.on('request', (req) => {
    requests.push({ url: req.url(), method: req.method(), resourceType: req.resourceType() });
  });

  page.on('response', async (res) => {
    const url = res.url();
    const ct = res.headers()['content-type'] || '';
    const entry = { url, status: res.status(), contentType: ct };
    if (/json|xml|text\/plain/i.test(ct) && !/\.(woff2?|css|png|jpe?g|svg)$/i.test(url)) {
      try {
        const body = await res.text();
        entry.bodyLength = body.length;
        // Save json-ish bodies
        if (body.length < 2_000_000) {
          const safeName = url.replace(/[^a-z0-9]+/gi, '_').slice(0, 180) + '.txt';
          fs.writeFileSync(path.join(outDir, safeName), body);
          entry.savedAs = safeName;
        }
      } catch (_) {}
    }
    responses.push(entry);
  });

  console.log('Navigating...');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // Give app time to render & fetch content
  await page.waitForTimeout(20000);

  const html = await page.content();
  fs.writeFileSync(path.join(outDir, 'page.html'), html);

  fs.writeFileSync(path.join(outDir, 'requests.json'), JSON.stringify(requests, null, 2));
  fs.writeFileSync(path.join(outDir, 'responses.json'), JSON.stringify(responses, null, 2));

  // Try to locate a table-of-contents list
  const tocSnippet = await page.evaluate(() => {
    const el = document.querySelector('[data-testid*="toc" i], nav, aside, [class*="toc" i]');
    return el ? el.outerHTML.slice(0, 5000) : null;
  });
  if (tocSnippet) fs.writeFileSync(path.join(outDir, 'toc_snippet.html'), tocSnippet);

  console.log('Done. Output dir:', outDir);
  await browser.close();
})();
