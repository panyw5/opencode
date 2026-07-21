"""
Post-install patch for ghostty-web's compiled CanvasRenderer.

Three fixes are injected:

1. renderPowerlineGlyph()
   The bundled font's PUA powerline glyphs (U+E0B0..U+E0B6) render at
   font ascent/descent metrics, which are noticeably shorter than the cell
   box. We replace the font fillText call for those codepoints with hand-
   drawn vector triangles/curves filling the entire cell rect, so the
   chevrons match cell background extents exactly.

2. Cell metrics use fontBoundingBox* instead of actualBoundingBox*
   The original measureFont() derives metrics.height from
   actualBoundingBoxAscent/Descent of "Mg", i.e. the pixel bounding box of
   that exact string. That's just the rendered M and g extents and omits
   the font's designed leading. Cell backgrounds + powerline glyphs draw
   at metrics.height, so the colored prompt segments end up looking
   "topped" relative to native terminals (wezterm/iterm) that use the em
   box. We prefer fontBoundingBoxAscent/Descent first; the font-designed
   ascent/descent restores the missing breathing room above and below
   text without changing any other layout assumption.

3. Extra vertical padding around each cell
   On top of the font box, add CELL_PAD_TOP px above and CELL_PAD_BOTTOM
   px below every cell. This expands the colored prompt segments visually
   without affecting per-row character placement (the baseline shifts
   down by CELL_PAD_TOP so text stays centered relative to its row).

Idempotent: the patch is a no-op if renderPowerlineGlyph already exists.

All match patterns use regex with back-references so the patch survives
minified variable-name changes across ghostty-web rebuilds.
"""

import re
import sys

# Tweakable: extra pixels added to each cell's ascent and descent. 2/2
# matches the visual breathing room of native macOS terminals at 14px.
CELL_PAD_TOP = 2
CELL_PAD_BOTTOM = 2

if len(sys.argv) < 2:
    print("usage: patch_powerline.py <path-to-ghostty-web.js>", file=sys.stderr)
    sys.exit(1)

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    src = f.read()

PAD_MARKER = f"/* opencode-pad {CELL_PAD_TOP}/{CELL_PAD_BOTTOM} */"
already_padded = PAD_MARKER in src
if "renderPowerlineGlyph" in src and already_padded:
    print("already patched, skipping")
    sys.exit(0)

# -----------------------------------------------------------------------------
# Patch 1: prefer fontBoundingBox* over actualBoundingBox* in measureFont()
# -----------------------------------------------------------------------------
# The metrics line contains actualBoundingBoxAscent/Descent with a specific
# fallback chain. Variable names change on every minified rebuild, so we
# locate the region by string search and extract names with a simple regex.

ANCHOR_ASCENT = ".actualBoundingBoxAscent || "
ANCHOR_FONT_SIZE = "this.fontSize * 0.8"

metrics_start = src.find(ANCHOR_ASCENT)
if metrics_start > 0:
    # Walk back to find the assignment start: "<s> = <w>.actualBoundingBox...".
    # In newer ghostty-web builds this follows another const binding on the
    # same line, e.g. "const o = ..., G = o.actualBoundingBoxAscent ...".
    line_start = src.rfind("\n", 0, metrics_start)
    comma_start = src.rfind(",", 0, metrics_start)
    if comma_start > line_start:
        assign_start = comma_start + 1
        while assign_start < len(src) and src[assign_start].isspace():
            assign_start += 1
    else:
        assign_start = line_start + 1
    metrics_end = src.find("this.fontSize * 0.2", metrics_start)
    if metrics_end > 0:
        metrics_end += len("this.fontSize * 0.2")
    metrics_region = src[assign_start:metrics_end] if metrics_end > 0 else ""
else:
    metrics_region = ""

if metrics_region and not already_padded:
    # Extract variable names: <s> = <w>.actualBoundingBoxAscent || ... || <C>.actualBoundingBoxAscent || <g>.actualBoundingBoxAscent
    m = re.match(
        r'(\w+)\s*=\s*(\w+)\.actualBoundingBoxAscent\s*\|\|\s*(?:\2\.fontBoundingBoxAscent\s*\|\|\s*)?'
        r'(\w+)\.actualBoundingBoxAscent[^|]*\|\|\s*(\w+)\.actualBoundingBoxAscent',
        metrics_region,
    )
    if m:
        s, w, C, g = m.group(1), m.group(2), m.group(3), m.group(4)
        # Extract descent var: <h> = <w>.actualBoundingBoxDescent ...
        h_m = re.search(r',\s*(\w+)\s*=\s*\w+\.actualBoundingBoxDescent', metrics_region)
        h = h_m.group(1) if h_m else None
        if h:
            replacement = (
                f"{s} = {w}.fontBoundingBoxAscent || {w}.actualBoundingBoxAscent || "
                f"{C}.fontBoundingBoxAscent || {C}.actualBoundingBoxAscent || {g}.actualBoundingBoxAscent || this.fontSize * 0.8, "
                f"{h} = {w}.fontBoundingBoxDescent || {w}.actualBoundingBoxDescent || "
                f"{C}.fontBoundingBoxDescent || {C}.actualBoundingBoxDescent || {g}.actualBoundingBoxDescent || this.fontSize * 0.2"
            )
            src = src[:assign_start] + replacement + src[metrics_end:]
            print("patched measureFont metrics to prefer fontBoundingBox*")
        else:
            print("ERROR: could not extract descent variable", file=sys.stderr)
            sys.exit(1)
    else:
        print("ERROR: could not parse measureFont metrics region", file=sys.stderr)
        print(f"DEBUG: metrics_start={metrics_start} assign_start={assign_start} metrics_end={metrics_end}", file=sys.stderr)
        print(f"DEBUG: metrics_region={metrics_region[:500]!r}", file=sys.stderr)
        print(f"DEBUG: anchor_context={src[max(0, metrics_start - 200):metrics_start + 500]!r}", file=sys.stderr)
        sys.exit(1)
elif "renderPowerlineGlyph" not in src and not metrics_region:
    print("ERROR: could not find measureFont metrics line", file=sys.stderr)
    sys.exit(1)
else:
    print("measureFont metrics already patched")

# -----------------------------------------------------------------------------
# Patch 3: add per-cell vertical padding via Math.ceil(...) bumps
# -----------------------------------------------------------------------------
# Match: <k> = Math.ceil(<s>), <N> = Math.ceil(<h>), <t> = <k> + <N>;

ceil_anchor = "Math.ceil("
ceil_idx = src.find(ceil_anchor, metrics_end if metrics_region else 0)
if ceil_idx > 0 and not already_padded:
    # Get the three assignment segment for parsing.
    ceil_start = src.rfind(",", 0, ceil_idx)
    ceil_start = ceil_start + 1 if ceil_start >= 0 else max(0, ceil_idx - 60)
    while ceil_start < len(src) and src[ceil_start].isspace():
        ceil_start += 1
    ceil_end = src.find(";", ceil_idx)
    ceil_end = ceil_end + 1 if ceil_end >= 0 else ceil_idx + 100
    ceil_region = src[ceil_start:ceil_end]

    cm = re.match(
        r'(\w+)\s*=\s*Math\.ceil\((\w+)\),\s*(\w+)\s*=\s*Math\.ceil\((\w+)\),\s*(\w+)\s*=\s*\1\s*\+\s*\3;',
        ceil_region.strip(),
    )
    if cm:
        k, sv, N, hv, t = cm.group(1), cm.group(2), cm.group(3), cm.group(4), cm.group(5)
        old = ceil_region.strip()
        new = (
            f"{k} = Math.ceil({sv}) + {CELL_PAD_TOP} {PAD_MARKER}, "
            f"{N} = Math.ceil({hv}) + {CELL_PAD_BOTTOM}, "
            f"{t} = {k} + {N};"
        )
        src = src[:ceil_start] + src[ceil_start:].replace(old, new, 1)
        print(f"added cell padding: top={CELL_PAD_TOP} bottom={CELL_PAD_BOTTOM}")
    else:
        print("ERROR: could not find ceil/sum line", file=sys.stderr)
        print(f"DEBUG: ceil_idx={ceil_idx} ceil_start={ceil_start} ceil_end={ceil_end}", file=sys.stderr)
        print(f"DEBUG: ceil_region={ceil_region[:500]!r}", file=sys.stderr)
        sys.exit(1)
elif not already_padded:
    print("ERROR: could not find ceil/sum line", file=sys.stderr)
    sys.exit(1)

# -----------------------------------------------------------------------------
# Patch 2: inject renderPowerlineGlyph + dispatch in renderCellText
# -----------------------------------------------------------------------------

lines = src.splitlines(keepends=True)

powerline_method = """  renderPowerlineGlyph(cp, x, y, w, h) {
    const c = this.ctx;
    switch (cp) {
      case 57520:
        c.beginPath(), c.moveTo(x, y), c.lineTo(x + w, y + h / 2), c.lineTo(x, y + h), c.closePath(), c.fill();
        return !0;
      case 57522:
        c.beginPath(), c.moveTo(x + w, y), c.lineTo(x, y + h / 2), c.lineTo(x + w, y + h), c.closePath(), c.fill();
        return !0;
      case 57521:
        c.beginPath(), c.moveTo(x, y), c.lineTo(x + w, y + h / 2), c.lineTo(x, y + h), c.lineWidth = 1, c.strokeStyle = c.fillStyle, c.stroke();
        return !0;
      case 57523:
        c.beginPath(), c.moveTo(x + w, y), c.lineTo(x, y + h / 2), c.lineTo(x + w, y + h), c.lineWidth = 1, c.strokeStyle = c.fillStyle, c.stroke();
        return !0;
      case 57524:
        c.beginPath(), c.moveTo(x, y), c.quadraticCurveTo(x + w, y, x + w, y + h / 2), c.quadraticCurveTo(x + w, y + h, x, y + h), c.closePath(), c.fill();
        return !0;
      case 57526:
        c.beginPath(), c.moveTo(x + w, y), c.quadraticCurveTo(x, y, x, y + h / 2), c.quadraticCurveTo(x, y + h, x + w, y + h), c.closePath(), c.fill();
        return !0;
      default:
        return !1;
    }
  }
"""

if "renderPowerlineGlyph" not in src:
    # Find the renderCellText comment header to anchor the insertion.
    target = None
    for i, line in enumerate(lines):
        if "renderCellText(" in line and target is None:
            # Walk back to the /** comment block start.
            j = i
            while j > 0 and "/**" not in lines[j]:
                j -= 1
            target = j
            break

    if target is None:
        print("ERROR: could not locate renderCellText anchor", file=sys.stderr)
        sys.exit(1)

    lines.insert(target, powerline_method)
    print(f"injected renderPowerlineGlyph at line {target + 1}")

    # Now find the renderCellText body where text is composed and dispatch
    # powerline codepoints before fillText.
    # Match: const <wvar> = <xvar>, <hvar> = <yvar> + this.metrics.baseline;
    body_pat = re.compile(
        r'const\s+(\w+)\s*=\s*(\w+),\s*(\w+)\s*=\s*(\w+)\s*\+\s*this\.metrics\.baseline;'
    )

    target_line = None
    for i, line in enumerate(lines):
        if i > target and body_pat.search(line):
            target_line = i
            break

    if target_line is None:
        print("ERROR: could not locate renderCellText body anchor", file=sys.stderr)
        sys.exit(1)

    bm = body_pat.search(lines[target_line])
    wvar, xvar, hvar, yvar = bm.group(1), bm.group(2), bm.group(3), bm.group(4)

    # Find the FAINT flag enum variable from the same scope.
    faint_var = None
    for i in range(target_line, min(target_line + 20, len(lines))):
        fm = re.search(r'(\w+)\.FAINT', lines[i])
        if fm:
            faint_var = fm.group(1)
            break

    if faint_var is None:
        print("ERROR: could not locate FAINT flag variable", file=sys.stderr)
        sys.exit(1)

    print(f"dispatching powerline codepoints before fillText at line {target_line + 1}")
    print(f"  vars: w={wvar} x={xvar} h={hvar} y={yvar} faint={faint_var}")
    lines.insert(target_line + 1, f"    const cp = A.codepoint || 0;\n")
    lines.insert(
        target_line + 2,
        f"    if (cp >= 57520 && cp <= 57526 && this.renderPowerlineGlyph(cp, {xvar}, {yvar}, {wvar}, this.metrics.height)) {{\n",
    )
    lines.insert(target_line + 3, f"      A.flags & {faint_var}.FAINT && (this.ctx.globalAlpha = 1);\n")
    lines.insert(target_line + 4, "      return;\n")
    lines.insert(target_line + 5, "    }\n")

with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)

print("done")
