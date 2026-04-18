#!/usr/bin/env python3
"""
Recompress every non-JPEG raster image in a PDF as JPEG (mozjpeg-equivalent quality).

Why this exists: Chromium's `page.pdf()` re-rasterizes embedded `<img>` elements and
emits them as Flate-compressed PNG (FlateDecode) regardless of the source data-URI
encoding. The data-URI-side mozjpeg pass in `fetch_manual.js` therefore does NOT
survive into the final PDF — image bytes balloon ~3-5x. Running this script on the
finished PDF restores the JPEG savings.

Skipped:
  - Streams already encoded with /DCTDecode (JPEG) — left alone.
  - Streams used as image masks (/ImageMask true) — kept as-is.
  - Tiny images (< 4 KB) — JPEG overhead would make them larger.
  - JPEG2000 / CCITT / JBIG2 streams — left alone.

Alpha is flattened onto white. Soft masks (/SMask) are dropped — JPEG has no alpha.

Usage:
  python optimize_pdf.py INPUT.pdf [--out OUTPUT.pdf] [--quality 80] [--max-width 1600]

If --out is omitted the input is replaced in place (via a temp file + atomic rename).
"""
from __future__ import annotations

import argparse
import io
import os
import sys
import tempfile
from typing import Iterable

import pikepdf
from pikepdf import Name, Pdf, PdfImage
from PIL import Image


KEEP_FILTERS = {"/DCTDecode", "/JPXDecode", "/CCITTFaxDecode", "/JBIG2Decode"}


def _filters(stream: pikepdf.Stream) -> list[str]:
    f = stream.get("/Filter")
    if f is None:
        return []
    if isinstance(f, pikepdf.Array):
        return [str(x) for x in f]
    return [str(f)]


def _iter_images(pdf: Pdf) -> Iterable[tuple[pikepdf.Stream, str]]:
    """Yield (stream, source_label) for every image XObject in the PDF, deduped by objgen."""
    seen: set[tuple[int, int]] = set()
    for pidx, page in enumerate(pdf.pages):
        try:
            images = page.images
        except Exception:
            continue
        for name, raw in images.items():
            key = raw.objgen
            if key in seen:
                continue
            seen.add(key)
            yield raw, f"page{pidx + 1}:{name}"


def _flatten_to_jpeg_mode(pil: Image.Image) -> Image.Image:
    """Drop alpha onto white, end up in 'RGB' or 'L'."""
    if pil.mode in ("RGB", "L"):
        return pil
    if pil.mode == "P":
        pil = pil.convert("RGBA" if "transparency" in pil.info else "RGB")
    if pil.mode in ("RGBA", "LA"):
        bg = Image.new("RGB", pil.size, (255, 255, 255))
        bg.paste(pil, mask=pil.split()[-1])
        return bg
    if pil.mode == "CMYK":
        return pil.convert("RGB")
    if pil.mode == "1":
        return pil.convert("L")
    return pil.convert("RGB")


def recompress(
    in_path: str,
    out_path: str,
    quality: int = 80,
    max_width: int = 1600,
    min_bytes: int = 4 * 1024,
) -> dict:
    stats = {
        "total": 0,
        "replaced": 0,
        "skipped_jpeg": 0,
        "skipped_mask": 0,
        "skipped_tiny": 0,
        "skipped_nogain": 0,
        "skipped_unsupported": 0,
        "errors": 0,
        "bytes_in": 0,
        "bytes_out": 0,
    }

    with Pdf.open(in_path) as pdf:
        for raw, label in _iter_images(pdf):
            stats["total"] += 1
            try:
                if raw.get("/ImageMask"):
                    stats["skipped_mask"] += 1
                    continue
                filters = _filters(raw)
                if any(f in KEEP_FILTERS for f in filters):
                    if "/DCTDecode" in filters:
                        stats["skipped_jpeg"] += 1
                    else:
                        stats["skipped_unsupported"] += 1
                    continue

                try:
                    pil = PdfImage(raw).as_pil_image()
                except Exception as e:
                    stats["errors"] += 1
                    print(f"  ! decode failed {label}: {e}", file=sys.stderr)
                    continue

                old_len = len(raw.read_raw_bytes())
                if old_len < min_bytes:
                    stats["skipped_tiny"] += 1
                    continue

                w, h = pil.size
                if w > max_width:
                    pil = pil.resize((max_width, max(1, round(h * max_width / w))), Image.LANCZOS)

                pil = _flatten_to_jpeg_mode(pil)

                buf = io.BytesIO()
                save_kwargs = dict(
                    format="JPEG",
                    quality=quality,
                    optimize=True,
                    progressive=False,
                )
                if pil.mode == "RGB":
                    save_kwargs["subsampling"] = "4:2:0"
                pil.save(buf, **save_kwargs)
                jpeg_bytes = buf.getvalue()

                if len(jpeg_bytes) >= old_len * 0.95:
                    stats["skipped_nogain"] += 1
                    continue

                raw.write(jpeg_bytes, filter=Name.DCTDecode)
                raw.ColorSpace = Name.DeviceRGB if pil.mode == "RGB" else Name.DeviceGray
                raw.BitsPerComponent = 8
                raw.Width = pil.size[0]
                raw.Height = pil.size[1]
                for k in ("/SMask", "/Mask", "/DecodeParms", "/Decode"):
                    if k in raw:
                        del raw[k]

                stats["replaced"] += 1
                stats["bytes_in"] += old_len
                stats["bytes_out"] += len(jpeg_bytes)
            except Exception as e:
                stats["errors"] += 1
                print(f"  ! error on {label}: {e}", file=sys.stderr)

        # Atomic write: pikepdf rewrites via QPDF; orphaned objects (e.g. dropped /SMask
        # streams) are excluded because QPDF only writes reachable objects.
        pdf.save(out_path, linearize=False)

    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", help="Input PDF path")
    ap.add_argument("--out", help="Output PDF path (default: replace input in place)")
    ap.add_argument("--quality", type=int, default=80, help="JPEG quality 1-100 (default: 80)")
    ap.add_argument("--max-width", type=int, default=1600, help="Max image width in pixels (default: 1600)")
    args = ap.parse_args()

    in_path = args.input
    if not os.path.isfile(in_path):
        print(f"Input not found: {in_path}", file=sys.stderr)
        return 2

    in_size = os.path.getsize(in_path)
    in_place = args.out is None
    if in_place:
        fd, tmp_out = tempfile.mkstemp(prefix="optpdf_", suffix=".pdf", dir=os.path.dirname(os.path.abspath(in_path)))
        os.close(fd)
        out_path = tmp_out
    else:
        out_path = args.out
        os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)

    try:
        stats = recompress(in_path, out_path, quality=args.quality, max_width=args.max_width)
    except Exception as e:
        if in_place:
            try: os.unlink(out_path)
            except OSError: pass
        print(f"Optimization failed: {e}", file=sys.stderr)
        return 1

    out_size = os.path.getsize(out_path)
    saved = in_size - out_size
    pct = (100.0 * saved / in_size) if in_size else 0.0
    print(
        f"[optimize_pdf] images: {stats['total']} total, "
        f"{stats['replaced']} re-encoded as JPEG, "
        f"{stats['skipped_jpeg']} already JPEG, "
        f"{stats['skipped_mask']} masks, "
        f"{stats['skipped_tiny']} tiny, "
        f"{stats['skipped_nogain']} no-gain, "
        f"{stats['skipped_unsupported']} unsupported, "
        f"{stats['errors']} errors."
    )
    if stats["bytes_in"]:
        print(
            f"[optimize_pdf] image bytes: {stats['bytes_in']/1024/1024:.1f} MB -> "
            f"{stats['bytes_out']/1024/1024:.1f} MB."
        )
    print(f"[optimize_pdf] file: {in_size/1024/1024:.2f} MB -> {out_size/1024/1024:.2f} MB (saved {pct:.1f}%).")

    if in_place:
        if out_size > in_size:
            os.unlink(out_path)
            print("[optimize_pdf] Output larger than input — keeping original.", file=sys.stderr)
            return 0
        os.replace(out_path, in_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
