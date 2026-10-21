"""Regenerate with: uv run --with 'fonttools[woff]==4.60.1' python packages/ui/script/subset-remote-fonts.py"""

import hashlib
import json
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[1] / "src/assets"
SOURCE = ROOT / "fonts"
OUTPUT = ROOT / "fonts-remote"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def private(code):
    return any(start <= code <= end for start, end in [(0xE000, 0xF8FF), (0xF0000, 0xFFFFD), (0x100000, 0x10FFFD)])


def main():
    check = "--check" in sys.argv
    if not check:
        OUTPUT.mkdir(exist_ok=True)
    records = {}
    for source in sorted(SOURCE.glob("*.woff2")):
        # IBM is the shared icon fallback. Fira is also used standalone by the
        # Claude theme; Iosevka has its own non-Nerd private glyphs. Keep these intact.
        if source.is_symlink() or not ("NerdFontMono" in source.name):
            continue
        if source.name.startswith(("BlexMono", "FiraCode")):
            continue
        weight = "Bold" if "Bold" in source.name else "Medium" if "Medium" in source.name else "Regular"
        fallback = SOURCE / f"BlexMonoNerdFontMono-{weight}.woff2"
        with TTFont(source, recalcTimestamp=False) as font, TTFont(fallback) as base:
            original = set(font.getBestCmap())
            shared = {code for code in original & set(base.getBestCmap()) if private(code)}
            keep = original - shared
            target = OUTPUT / source.name
            if not check:
                options = subset.Options()
                options.layout_features = ["*"]
                options.name_IDs = ["*"]
                options.name_languages = ["*"]
                shrink = subset.Subsetter(options=options)
                shrink.populate(unicodes=keep)
                shrink.subset(font)
                font.save(target)
            with TTFont(target) as compact:
                actual = set(compact.getBestCmap())
                assert actual == keep, f"Unexpected character coverage: {source.name}"
                assert original <= actual | set(base.getBestCmap()), f"Missing fallback glyph: {source.name}"
            records[source.name] = {
                "source": digest(source),
                "output": digest(target),
                "fallback": fallback.name,
                "before": source.stat().st_size,
                "after": target.stat().st_size,
                "sharedGlyphs": len(shared),
            }
            print(f"[remote-fonts] font={source.name} before={source.stat().st_size} after={target.stat().st_size} shared={len(shared)}")
    manifest = OUTPUT / "manifest.json"
    if check:
        assert json.loads(manifest.read_text()) == records, "Stale remote fonts; regenerate them"
    else:
        manifest.write_text(json.dumps(records, indent=2) + "\n")
    print(f"[remote-fonts] verified={len(records)} before={sum(r['before'] for r in records.values())} after={sum(r['after'] for r in records.values())}")


if __name__ == "__main__":
    main()
