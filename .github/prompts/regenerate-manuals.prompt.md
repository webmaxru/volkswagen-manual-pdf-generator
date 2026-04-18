---
description: Regenerate the VW PDF manuals for every language that already has a subfolder under manual/ (currently the VW ID.4 example set).
---

# Regenerate existing manuals

Goal: refresh every language manual that is already present in this repo, so the PDFs reflect Volkswagen's latest published edition.

Steps:

1. List the subdirectories of `manual/`. Each directory name is a BCP-47 short code (e.g. `nb`, `en`, `de`) — one language per folder. If `manual/` does not exist or is empty, stop and tell the user there's nothing to regenerate and suggest `npm run fetch:<lang>` to create a first one.
2. For each language folder found:
   - If `package.json` already declares a matching `fetch:<lang>` script, run `npm run fetch:<lang>`.
   - Otherwise fall back to the generic form using the defaults documented in `README.md` and `AGENTS.md`:
     `node fetch_manual.js --lang <lang> --market NO --locale nb-NO --region RDW --ownersManualTerm "<localized-title>" --landing https://www.volkswagen.no/no/min-volkswagen/digital-instruksjonsbok-innhold.html`
     Do **not** pass `--out` — the script auto-derives the unified filename `<brand>_<model>_<partnumber>_<lang>.pdf` (lowercase) under `manual/<lang>/`. Consult `AGENTS.md` ("When adding a language") for how to look up `ownersManualTerm` if it isn't obvious. Always keep `--landing` on `volkswagen.no`.
3. Run the regenerations sequentially (not in parallel) — each run drives a headless Chromium and they share the same browser cache on disk.
4. After each run, verify:
   - `manual/<lang>/<brand>_<model>_<partnumber>_<lang>.pdf` exists and is between **~10 and ~30 MB** (post-optimization). If it is **>40 MB**, the mandatory `optimize_pdf.py` post-processing step did not run — investigate before continuing (most likely cause: missing `pikepdf`/`Pillow`; install with `pip install pikepdf Pillow`).
   - The run log contains both an `[optimize_pdf] image bytes:` line and an `[optimize_pdf] file: …MB -> …MB (saved …%)` line. If those are absent the post-processing step was skipped.
   - At least ~500 topics fetched with <5 failures.
   - Spot-check that raster images in the final PDF are JPEG-encoded:
     `python -c "import fitz, sys; d=fitz.open(sys.argv[1]); exts={d.extract_image(i[0])['ext'] for p in d for i in p.get_images(full=True)}; print(exts)" manual/<lang>/<brand>_<model>_<partnumber>_<lang>.pdf`
     The set should contain `'jpeg'` (and may contain `'png'` only for ~36 small icons that JPEG can't shrink). If you see PNG entries that are megabytes large, post-processing didn't run — do **not** ship the PDF.
   If a run fails, do **not** retry blindly — follow the "Debugging workflow" in `AGENTS.md`.
5. Report back a short summary: for each language, the PDF path, the `[optimize_pdf] file:` savings line from the run log, the inline `[fetch] Images:` savings line if present, and any topic-fetch failures worth noting.

Constraints:

- Do not edit `fetch_manual.js`, `optimize_pdf.py`, or the scripts in `package.json` as part of this task — only run them. Edits are only warranted if step 4 surfaces a real backend-contract regression or a missing dependency, and in that case follow `AGENTS.md`.
- `optimize_pdf.py` is mandatory — never skip it, never replace it with "advisory" wording. The user has explicitly required JPEG-only raster streams in the final PDF.
- Final PDFs **are** committed (they are the deliverable). Scratch JSON/HTML are auto-deleted at the end of a successful run and gitignored as defense-in-depth.
- Do not delete any existing manual before the new one succeeds; on failure the user keeps the previous edition.
- Norwegian-market only: never change `--landing` to a non-`volkswagen.no` host, never machine-translate.
