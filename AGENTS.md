# AGENTS.md — notes for the next AI agent that touches this project

Read this in full before writing any code. Everything below was learned the hard way while reverse-engineering the Volkswagen Digital Manual (DIMA) for part number `11A012777AR` (VW ID.4 / ID.4 GTX). The notes apply to any VW model that uses the same DIMA feature-app.

## What this project does

`fetch_manual.js` scrapes the DIMA backend and produces a single searchable PDF with embedded illustrations. It is parameterised for language/market and is meant to be re-run whenever the user wants an updated edition or a different language.

Do **not** replace the fetch-via-browser approach with a pure Node/axios approach (see "Why in-browser" below) and do **not** try to use the async-download endpoint (see "Broken endpoints").

## Entry points

- `fetch_manual.js` — the only script end-users run. Keep it self-contained.
- `optimize_pdf.py` — Python post-processor invoked automatically by `fetch_manual.js` after `page.pdf()`. Re-encodes PNG-encoded image streams in the produced PDF as JPEG. Mandatory; do not bypass. See "Image optimization" below.
- `package.json` — declares `playwright` and the `fetch:*` npm scripts.
- `README.md` — end-user instructions only. Keep agent-level detail out of it.
- `discover.js` — Playwright probe that drives the VW landing page and dumps every network request it sees. Run this first whenever the backend contract seems to have changed.
- `discover_out/` and `probe_out/` — local scratch dirs produced by `discover.js` and earlier probe runs. **Gitignored** (they contain VW's proprietary SPA bundle + API payloads and shouldn't be redistributed). Regenerate on demand with `node discover.js`. The decompiled SPA bundle under `probe_out/…digitalmanual.js…_attempt_1.txt` is the single most useful reference when hunting for header/token changes; it can also be pulled directly by fetching `https://cdn.dima.fan.vwapps.run/feature-apps/dima-frontend/digitalmanual/4.2.0-0001/js/digitalmanual.js` (URL version bumps over time — grab the current one from a fresh `discover.js` log).
- `manual/<lang>/` — generated artefacts, one subfolder per language (e.g. `manual/nb/`, `manual/en/`). Each contains exactly one PDF, named `<brand>_<model>_<partnumber>_<lang>.pdf` (all lowercase, e.g. `volkswagen_id.4_11a012777ar_nb.pdf`). The naming scheme is unified across languages — only the `<lang>` segment changes. Scratch artefacts (`*_tree.json`, `*_topics.json`, composite HTML) are written and deleted within a single run; do not commit them.

## Environment

- Windows, Node 22, Python 3.12 available.
- Playwright + chromium-headless-shell already installed under `node_modules/`. Running `npm install` in a fresh clone is enough.
- Python deps for `optimize_pdf.py`: `pikepdf` and `Pillow`. Install once with `pip install pikepdf Pillow`. The script is invoked automatically at the end of every `fetch_manual.js` run; if Python or those modules are missing, the script reports the failure and exits non-zero so it can't silently regress.
- No credentials, cookies or account are required. The manual is public.

## URL surface (DIMA backend)

All endpoints are public and need no Authorization header.

| Endpoint | Purpose |
|---|---|
| `GET https://prod-a.dima.fan.vwapps.run/public/bff-digitalmanual/digitalmanual/availabilityCheck?partNumber=&brandPattern=` | `{contentAvailable, availableLanguages[], tenant}`. 44 languages today. Use this to enumerate supported languages. |
| `GET .../bff-digitalmanual/digitalmanual/editions/{tenant}?partNumber=&brandPattern=&language=<short>_<MARKET>&ownersManualTerms=<localized>` | `{results:[{topicId,title,category}], modelName, editionVersion}`. `topicId` here is the **root topic-tree id**. |
| `GET .../bff-digitalmanual/digitalmanual/topictree/{tenant}/{topicId}?partNumber=&brandPattern=` | Full TOC tree of `{nodeId, title, targetTopicId, children[]}`. Non-leaf nodes may lack `targetTopicId`. |
| `GET https://userguide.volkswagen.de/{tenant}/api/consumer/V4/topic/{targetTopicId}` | `{topicId, bodyHtml}`. `bodyHtml` is a self-contained `<html>` document with inline markup + external image `src`s. |
| `GET https://userguide.volkswagen.de/{tenant}/api/consumer/V4/stylesheet` | Shared CSS for `bodyHtml`. |
| `GET https://userguide.volkswagen.de/{tenant}/api/consumer/V4/figure/...` etc. | Figure / image / resource assets referenced from `bodyHtml`. Must be fetched with the consumer token too. |

`tenant` has been `default` for every model tried. The `availabilityCheck` response tells you for sure.

## Required headers — gotcha #1

The SPA source code calls two helpers `addMarketHeader()` / `addLanguageHeader()` that **look** like they emit `market` / `language`. The backend actually rejects those names and wants:

- `x-fan-market: <MARKET>`  (e.g. `NO`, `GB`, `DE`)
- `x-fan-lang: <short>`     (e.g. `nb`, `en`, `de`)

Without those, BFF endpoints return `TPC400 INVALID_PARAMETER`.

`userguide.volkswagen.de` does not need `x-fan-*`; it only needs the consumer token (see next gotcha).

## Consumer token — gotcha #2 (the biggest)

The browser generates a base64(JSON) token:

```js
btoa(JSON.stringify({
  partnumber:   PART,    // e.g. "11A012777AR"
  brandPattern: BRAND,   // first three chars of VIN, e.g. "WVW"
  market:       REGION,  // note: REGION code, not ISO country. For Norway: "RDW".
  tokenType:    "partnumber",
  version:      3
}));
```

**Key order matters.** The backend re-encodes and hash-compares, so any reordering breaks it. Use `JSON.stringify` on a literal object — never `ConvertTo-Json` from PowerShell (it alphabetises keys and fails).

**Omit the `vin` field entirely.** The decompiled `createTopicPilotConsumerToken` builds the object as `{vin: e.vin, partnumber, brandPattern, market, tokenType, version}`, and in the part-number flow `e.vin` is `null`. If you literally emit `"vin": null` in the JSON, the topic endpoint returns `403 ERR_04_008_TP`. Skipping the field makes it `200`. Do not "improve" the script by adding the field back.

**`market` in the token ≠ `x-fan-market` in the headers.** Token wants the internal region code (`RDW` for Norway, `EUR` for some EU markets, etc). Read it from the merged author config:

```
https://cdn.dima.fan.vwapps.run/author-config/prod-a/live/VW/<MARKET>/merged_VW_<MARKET>_DIMA_DigitalManual.json
```

The `region` field inside is what goes into the token.

## Why in-browser (Playwright) — gotcha #3

A pure Node/axios/fetch call to the BFF from a developer machine intermittently returns `400` on `editions` even with perfectly-crafted headers. The backend likely checks Origin/Referer and other platform-level signals stamped by the CDN. Running `page.evaluate(fetch(...))` inside a real Playwright context on a `volkswagen.*` origin bypasses this because the same-origin CORS envelope is already in place. This is also why we can fetch binary images with the consumer token inside the page — CORS is already satisfied.

Mandatory setup inside the page before fetching:

1. `page.goto(<landing URL on volkswagen.XX>)` — any VW market page that embeds the DIMA feature-app works.
2. Wait ~4 s for the SPA to initialise.
3. Click `#onetrust-accept-btn-handler` (wrap in try/catch; the banner is sometimes not shown).
4. Wait ~3 s for OneTrust to release the iframes.

After that, any `fetch()` inside `page.evaluate` works.

## Broken endpoints — do not use

- `POST .../bff-digitalmanual/async/task/download` then poll `.../async/task/{taskId}/download`. In theory returns a single combined HTML; in practice the task transitions `NEW → PROCESSING → FAILED` with `BHA500 UNKNOWN_SERVER_ERROR` every time. The SPA itself hits this endpoint when you use its built-in "download" button and the same error is visible in the browser network panel. Do not spend time on it.
- `digitalmanual/editions/default` — occasionally returns `TPC400` from an already-initialised Playwright page even when headers are correct (probably a short-lived dedupe cache server-side). Handle this defensively: if editions fails, fall back to `availabilityCheck` and derive the `topicId` another way, or retry after 30 s. In the current script we only hit editions once and early; if it fails we abort with a clear error. Leave it that way — masking this with retries will hide real problems.

## Fetch order (implemented by `fetch_manual.js`)

1. Open landing URL in Playwright, accept cookies.
2. `editions/{tenant}` → resolve root `topicId`, human-readable `editionVersion` + `modelName`.
3. `topictree/{tenant}/{topicId}` → depth-first flatten to an ordered array of `{topicId, title, depth, path}`.
4. `stylesheet` once.
5. For each leaf `targetTopicId`: `topic/{id}` (8-way parallel). The root node's `targetTopicId` equals its `nodeId` and returns 404 — expected, skip it silently.
6. Walk every `bodyHtml`, find URLs matching `userguide.volkswagen.de` or `/api/consumer/V4/{figure,image,picture,resource,asset,download}`, fetch them with the consumer token, base64-encode into `data:` URIs, and substitute back into the HTML.
7. Compose one big HTML: cover page → TOC built from the tree → `<section>` per topic (stripped of outer `<html>/<head>/<body>`) → embed both the vendor stylesheet and our print CSS.
8. Open the composed HTML in Playwright with `waitUntil: 'load'` and `page.pdf({ format: 'A4', displayHeaderFooter: true, printBackground: true })`.

## Expected output (per language, Sept 2025 edition)

- Tree: ~518 nodes total; ~517 successful topic fetches, 1 expected 404 (root id `f86e6feace…_1_<lang>_<MARKET>`).
- Composite HTML ~16-17 MB. PDF after `page.pdf()` ~73-76 MB; **after `optimize_pdf.py` (mandatory) ~12-15 MB**, ~450 pages A4.
- End-to-end runtime: 3-7 min on a fast connection (incl. ~10–20 s for the optimization pass).
- Norwegian, English (GB) and Russian have all been verified end-to-end with these numbers.
- Text is Unicode-clean across scripts (Latin, Cyrillic, Greek, etc.) — `page.pdf()` embeds the bundled DIMA stylesheet and the Chromium font fallbacks render every script we've tried so far.

If counts drift by more than ±5 topics between runs that's fine — VW re-edits the manual. If they drop by >20 %, suspect a backend regression and inspect `manual/<lang>/<name>_topics.json` for unexpected `error` fields.

## When adding a language

**Cheat sheet first.** Before going on a hunt, open the captured `probe_out/…merged_VW_NO_DIMA_DigitalManual_json.txt` (Norwegian config) — it contains:

- The full `ownersManualTerms` array for **every language served by the RDW region** (all of Europe + RoW). For example `ru_RU` → `Руководство по эксплуатации`, `pl_PL` → `Instrukcja obsługi`, `cs_CZ` → `Návod k obsluze`. This file alone covers ~30 of the 44 supported languages — no per-market lookup needed.
- The `regionTenantMapping`: there are only **two regions**, `RDW` (Europe + RoW) and `NAR` (North America). Only `en_US` and `fr_CA` go through `NAR`; everything else is `RDW`.
- For `en_US` / `fr_CA` you'll also need `--brandPattern WVG` (NAR pattern) instead of `WVW` per the `modelSelectorBrandConfig` block.

The `availabilityCheck` response lists every supported `<short>_<MARKET>` short code. For a new one, gather:

1. `market` — the ISO country part of the `<short>_<MARKET>` pair from `availabilityCheck` (e.g. for Russian `ru_RU` → market `RU`, even if VW Russia's portal is offline).
2. `region` — RDW for almost everything; NAR only for `en_US` and `fr_CA`.
3. `ownersManualTerm` — copy verbatim from the NO config above. If it's missing there (NAR-only languages or a brand-new addition), the per-market merged config is at `https://cdn.dima.fan.vwapps.run/author/config/prod_a/live/VW_<MARKET>/merged_VW_<MARKET>_DIMA_DigitalManual.json`. Wrong term → `editions` returns an empty `results` array.
4. `landing` — any VW market page that hosts the DIMA feature-app. **The Norwegian landing works for every language**, including ones whose own market portal is unreachable (we use it for Russian for exactly this reason). UK and DE landings also work. The cookie-banner accept happens on whatever landing you point at — language doesn't matter, only that the page loads and OneTrust resolves.
5. `locale` — only affects the OneTrust banner language; any valid BCP-47 locale works. Use the language's natural locale for tidiness.

Add a new `fetch:<lang>` script in `package.json` and mention it in `README.md`.

### Windows/PowerShell encoding gotcha

Non-Latin `ownersManualTerm` values (Russian, Greek, Bulgarian, Ukrainian, Hebrew, Arabic, Chinese, Japanese, Korean, etc.) **cannot** be passed directly on the PowerShell command line — `cmd`/`pwsh` argv encoding mangles them before Node sees them and the `editions` filter then misses. The reliable path is:

- Define the script in `package.json` (npm reads the string verbatim from the JSON file as UTF-8, bypasses argv mojibake) and run via `npm run fetch:<lang>`.
- The terminal will *display* the term garbled in the echoed command line — that's purely cosmetic. Verify it actually worked by checking the `[fetch] Edition:` log line and the topic count (≈518) is non-zero.

## Output naming (unified across languages)

There is **one** filename scheme. Every PDF in this repo is named:

```
manual/<lang>/<brand>_<model>_<partnumber>_<lang>.pdf      (all lowercase)
```

With the project defaults that resolves to `manual/<lang>/volkswagen_id.4_11a012777ar_<lang>.pdf` — e.g. `volkswagen_id.4_11a012777ar_nb.pdf`. The scheme is identical for every language; only the trailing `<lang>` segment changes. Don't introduce per-language names like `Instruksjonsbok` / `OwnersManual` / `Betriebsanleitung` — that's exactly what we removed.

Implementation: `fetch_manual.js` derives `DEFAULT_BASENAME = ` `${BRAND_NAME}_${MODEL_NAME}_${PART}_${LANG_SHORT}`.toLowerCase()` and uses it as `OUT_BASE` unless the caller passes `--out`. The `--brand` and `--model` flags exist solely to feed this filename — they are not sent to the backend. `package.json` `fetch:*` scripts must therefore **not** pass `--out`; they only set per-language flags (`--lang`, `--market`, `--locale`, `--ownersManualTerm`, `--landing`).

If you ever need to bump the model (e.g. ID.5) or the part number, change those defaults in one place (`fetch_manual.js`) and every script keeps working.

## Image optimization

The user has explicitly asked that **every raster image embedded in the final PDF must be JPEG** (no PNG/Flate-encoded raster streams). This is a hard requirement — do not regress it. The pipeline has two separate JPEG passes; both are needed.

### Pass 1 — in-page sharp re-encoding (size: HTML)

Before the composite HTML is handed to Chromium, `fetch_manual.js` re-encodes every fetched raster via [`sharp`](https://sharp.pixelplumbing.com/) and inlines it as `data:image/jpeg;base64,…`:

| Image type | What we do | Why |
|---|---|---|
| `image/svg+xml` | Pass through unchanged. | SVGs are already small + crisp at any zoom; re-rasterizing hurts. |
| Anything else (PNG, JPEG, WebP, …) | `sharp().rotate().resize({width:JPEG_MAX_WIDTH, withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:JPEG_QUALITY, mozjpeg:true, chromaSubsampling:'4:2:0'})` → embed as `data:image/jpeg;base64,…`. | Mozjpeg yields ~30–50 % smaller files than libjpeg-turbo at the same quality; downscaling caps oversized line drawings; flatten on white avoids alpha issues since JPEG has no alpha; chroma subsampling halves chroma bytes (text/illustrations are luma-dominant). |
| Sharp throws / JPEG output is *bigger* than the original | Fall back to original bytes with the original MIME type. | Cheap fallback; some assets are already heavily-optimized JPEGs. |

This pass exists primarily to keep the **intermediate composite HTML small** (~140 MB → ~60 MB) so Chromium can parse and lay it out quickly. It does **not** by itself shrink the PDF — see Pass 2.

### Pass 2 — PDF post-processing with `optimize_pdf.py` (mandatory)

**This is the gotcha the in-line comment in `fetch_manual.js` warns about:** Chromium's `page.pdf()` re-rasterizes every embedded `<img>` and writes the resulting bitmap into the PDF as **FlateDecode (PNG)**, regardless of whether the source `<img src="data:…">` was JPEG. Without remediation, all 257 illustrations come out as ~270 KB PNGs and a regenerated `manual/<lang>/…pdf` weighs ~73 MB.

After `page.pdf()` finishes, the script spawns `python optimize_pdf.py <pdf>` (Python 3 + `pikepdf` + `Pillow`). For every image XObject in the file:

- `/DCTDecode` (JPEG), `/JPXDecode`, `/CCITTFaxDecode`, `/JBIG2Decode` → left untouched.
- Image masks (`/ImageMask true`) → left untouched.
- Tiny images (<4 KB raw stream) → skipped (JPEG framing overhead would make them larger).
- Everything else → decode with `pikepdf.PdfImage.as_pil_image()` → flatten alpha onto white → optionally downscale to `--max-width` → re-encode with Pillow as JPEG (`quality=80`, `subsampling=4:2:0`, `optimize=True`) → write back with `Filter=/DCTDecode`, `ColorSpace=/DeviceRGB|/DeviceGray`, drop `/SMask`/`/Mask`/`/DecodeParms`/`/Decode`. If the JPEG isn't at least 5 % smaller than the original stream, the original is kept.

Soft masks become unreferenced and are dropped automatically when QPDF rewrites the file on `pdf.save()`. The save is atomic (temp file + `os.replace`) so a partially-optimized PDF can never overwrite the input.

Expected output for the ID.4 manual (any language): **73 MB → ~13 MB**, ~83 % saved, 218 of 257 images re-encoded.

CLI tunables (forwarded by `fetch_manual.js`): `--jpegQuality` (default `80`, range `1`–`100`) and `--jpegMaxWidth` (default `1600` px, no upscaling). You can also run `python optimize_pdf.py PDF [--out OUT] [--quality N] [--max-width N]` standalone on any existing PDF.

The script logs a one-line savings summary at the end of each run:
```
[fetch] Wrote PDF: …\volkswagen_id.4_11a012777ar_nb.pdf (75161 KB)
[fetch] Optimizing PDF images (JPEG q=80, max width=1600px)...
[optimize_pdf] images: 257 total, 218 re-encoded as JPEG, 0 already JPEG, 0 masks, 3 tiny, 36 no-gain, 0 unsupported, 0 errors.
[optimize_pdf] image bytes: 68.8 MB -> 8.1 MB.
[optimize_pdf] file: 73.40 MB -> 12.62 MB (saved 82.8%).
[fetch] Final PDF: …\volkswagen_id.4_11a012777ar_nb.pdf (12919 KB)
```

**Don't be tempted to:**
- Upscale anything — `withoutEnlargement: true` is intentional. Originals are already higher-res than what Chromium needs at A4.
- Use lossless formats (PNG, WebP-lossless). The illustrations are anti-aliased line art with photographic gradients in places; mozjpeg q=80 is visually indistinguishable and 5–10× smaller.
- Skip `flatten({background:'#ffffff'})`. PNGs with alpha re-encoded straight to JPEG come out with black backgrounds.
- Move sharp into the page context. `sharp` is a native Node addon — it must run in Node, after the in-page `fetch()` returned `{ct, b64}`.
- **Skip Pass 2**, "trust the data-URI JPEG", or remove the `python optimize_pdf.py` call from `fetch_manual.js`. It will silently 5x the PDF size. Verify with `python -c "import fitz; d=fitz.open('manual/<lang>/…pdf'); print({p.get('ext') for x in (d.extract_image(i[0]) for page in d for i in page.get_images(full=True)) for p in [x]})"` — the set should be `{'jpeg'}` (plus `'png'` for the ~36 small icons that JPEG doesn't shrink). If you see PNGs in the megabytes, Pass 2 didn't run.
- Try to fix the Chromium re-encoding upstream by tweaking CSS / using `image-rendering` / disabling `printBackground`. None of those are reliable; `printing.print_pdf_as_image` flags don't exist in headless. Post-processing is the only stable solution we've found.
- Replace `pikepdf`/`Pillow` with Ghostscript or ImageMagick. Both are external native deps that aren't installed on this Windows dev box; `pip install pikepdf Pillow` works portably.
- Re-encode JPEGs that are already in the PDF (the `/DCTDecode` short-circuit). Generation loss is real and the input quality from VW's CDN already varies.

## Output policy

A successful run leaves **only the PDF** behind in `manual/<lang>/`:

| Artifact | Where it goes | Lifetime |
|---|---|---|
| `…_tree.json`, `…_topics.json` | Written next to the PDF, read by the renderer, deleted at end of run. | Run-scoped. Never committed. |
| Composite HTML | `os.tmpdir()/dima_<lang>_<pid>.html` — never written into `manual/`. | Deleted at end of run. |
| Final PDF | `manual/<lang>/…pdf` | Permanent, committed. |

`.gitignore` has belt-and-suspenders rules (`manual/**/*.json`, `manual/**/*.html`, top-level `*.html`) so even an aborted run can't accidentally commit scratch files. If you add another scratch artifact, gitignore it *and* `unlinkSync` it at the end of `(async () => { … })()`.



1. Re-run `node discover.js` to capture the SPA's own network traffic at current state of the backend. Output: `discover_out/log.json` and per-URL body dumps.
2. Open the resulting `log.json` and compare request URLs + header sets against what `fetch_manual.js` sends. The most common drift is a renamed header or a new required query-param.
3. If topic fetches fail but everything else works, the token format has probably changed. Search the current bundle (under `probe_out/…digitalmanual.js…txt` or re-pull it) for `createTopicPilotConsumerToken`, `consumer-token`, and `tokenType:` to reconfirm the shape.
4. If images go missing, check the URL regex in `rewrite()` — DIMA occasionally adds new asset paths (historically: `figure`, `image`, `picture`, `resource`, `asset`, `download`).

## Things to avoid

- Adding retries or long sleeps to "fix" intermittent 400s. Fix the real problem instead (wrong header, wrong token, wrong key order).
- Adding the `vin` field back into the token object.
- Replacing the in-browser fetch with Node fetch.
- Using the async-download endpoint.
- Normalising / reformatting the token JSON (no indentation, no reordering).
- Emitting anything other than UTF-8 — the `bodyHtml` includes characters that will mojibake if written as latin-1.
- **Removing or bypassing `optimize_pdf.py`**, or downgrading it back to "advisory". The user has explicitly required JPEG-only raster streams in the final PDF; PNG image streams in `manual/<lang>/…pdf` are a regression. Verify with `pdfimages` / PyMuPDF (see "Image optimization").

## Preserving scratch captures

`discover_out/` and `probe_out/` are **gitignored** — they hold VW's SPA bundle and raw API payloads and must not be pushed to a public repo. Keep them locally; they are the fastest reference when the backend contract drifts:

- The decompiled SPA bundle (`probe_out/…digitalmanual.js…_attempt_1.txt`, ~4 MB). Search this first when the API changes.
- A captured `dy-topic` web-component source — documents exactly how topics and stylesheets are loaded.
- Early successful raw responses for `availabilityCheck`, `editions/default` and `topictree/...`, useful as schema references without having to re-hit the backend.
- **The Norwegian merged config** (`probe_out/…merged_VW_NO_DIMA_DigitalManual_json.txt`) — single source of truth for `region`, `regionTenantMapping`, `modelSelectorBrandConfig`, and the full `ownersManualTerms` table for every RDW language. See "When adding a language" above.

To regenerate from scratch: `node discover.js` (repopulates `discover_out/`; also logs the current SPA bundle URL so you can refill `probe_out/` manually if needed).
