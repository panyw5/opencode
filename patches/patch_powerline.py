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
# Newer ghostty-web builds already prefer fontBoundingBox* in the fallback
# chain, in which case this is a no-op. On older builds we locate the minified
# metrics assignment by string search and rewrite the fallback chain; variable
# names change on every rebuild, so we match structurally.

if not already_padded:
    if "fontBoundingBoxAscent" in src and "fontBoundingBoxDescent" in src:
        print("measureFont already prefers fontBoundingBox*, skipping metrics patch")
    else:
        ANCHOR_ASCENT = ".actualBoundingBoxAscent || "
        metrics_start = src.find(ANCHOR_ASCENT)
        metrics_region = ""
        metrics_end = 0
        if metrics_start > 0:
            # Walk back to find the assignment start: "<s> = <w>.actualBoundingBox...".
            # In newer ghostty-web builds this follows another const binding on
            # the same line, e.g. "const o = ..., G = o.actualBoundingBox...".
            line_start = src.rfind("\n", 0, metrics_start)
            comma_start = src.rfind(",", 0, metrics_start)
            if comma_start > line_start:
                assign_start = comma_start + 1
                while assign_start < len(src) and src[assign_start].isspace():
                    assign_start += 1
            else:
                assign_start = line_start + 1
            # The descent fallback ends with "this.fontSize * <scale> * 0.2";
            # <scale> is a font-scale variable on newer builds.
            end_m = re.search(r"this\.fontSize\s*\*\s*[\w.]+\s*\*\s*0\.2", src[metrics_start:])
            if end_m:
                metrics_end = metrics_start + end_m.end()
                metrics_region = src[assign_start:metrics_end]
        if metrics_region:
            # Extract names: <s> = <w>.actualBoundingBoxAscent || ... || <C>.actualBoundingBoxAscent || <g>.actualBoundingBoxAscent
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
                    print("WARN: could not extract descent variable; skipping metrics patch", file=sys.stderr)
            else:
                print("WARN: could not parse measureFont metrics region; skipping metrics patch", file=sys.stderr)
        else:
            print("WARN: could not locate measureFont metrics region; skipping metrics patch", file=sys.stderr)

# -----------------------------------------------------------------------------
# Patch 3: add per-cell vertical padding
# -----------------------------------------------------------------------------
# Rewrite measureFont()'s returned metrics so every cell gains CELL_PAD_TOP px
# above the baseline and CELL_PAD_BOTTOM px below it. Targeting the return
# object keeps this resilient to the intermediate minified math changing.
# Match: return { width: <w>, height: <h>, baseline: <b>, ascent: <a> };

return_pat = re.compile(
    r"return \{ width: (\w+), height: (\w+), baseline: (\w+), ascent: (\w+) \};"
)

if not already_padded:
    rm = return_pat.search(src)
    if rm:
        W, H, B, A = rm.group(1), rm.group(2), rm.group(3), rm.group(4)
        new_return = (
            f"return {{ width: {W}, height: {H} + {CELL_PAD_TOP} + {CELL_PAD_BOTTOM} "
            f"{PAD_MARKER}, baseline: {B} + {CELL_PAD_TOP}, ascent: {A} + {CELL_PAD_TOP} }};"
        )
        src = src[: rm.start()] + new_return + src[rm.end():]
        print(f"added cell padding: top={CELL_PAD_TOP} bottom={CELL_PAD_BOTTOM}")
    else:
        print("WARN: could not locate measureFont return object; skipping cell padding", file=sys.stderr)

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
    # Find the renderCellText *definition* (not a call site) and its comment
    # header, then insert the powerline method just before the comment.
    def_pat = re.compile(r"renderCellText\((\w+),\s*(\w+),\s*(\w+),\s*(\w+)\)\s*\{")
    target = None
    method_line = None
    cell_var = None
    for i, line in enumerate(lines):
        dm = def_pat.search(line)
        if dm:
            # Walk back to the /** comment block start.
            j = i
            while j > 0 and "/**" not in lines[j]:
                j -= 1
            target = j
            method_line = i
            cell_var = dm.group(1)
            break

    if target is None or method_line is None:
        print("WARN: could not locate renderCellText anchor; skipping powerline injection", file=sys.stderr)
    else:
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

        # Find the FAINT flag enum variable from the same scope.
        faint_var = None
        if target_line is not None:
            for i in range(target_line, min(target_line + 20, len(lines))):
                fm = re.search(r'(\w+)\.FAINT', lines[i])
                if fm:
                    faint_var = fm.group(1)
                    break

        if target_line is None or faint_var is None:
            print("WARN: could not locate renderCellText dispatch anchors; skipping dispatch", file=sys.stderr)
        else:
            bm = body_pat.search(lines[target_line])
            wvar, xvar, hvar, yvar = bm.group(1), bm.group(2), bm.group(3), bm.group(4)

            print(f"dispatching powerline codepoints before fillText at line {target_line + 1}")
            print(f"  vars: x={xvar} y={yvar} faint={faint_var} cell={cell_var}")
            lines.insert(target_line + 1, f"    const cp = {cell_var}.codepoint || 0;\n")
            lines.insert(
                target_line + 2,
                # The glyph must fill the whole cell rect. {wvar} from the body
                # anchor is an alias of the x coordinate, not the width, so the
                # width is taken from the cell's own column span.
                f"    if (cp >= 57520 && cp <= 57526 && this.renderPowerlineGlyph(cp, {xvar}, {yvar}, this.metrics.width * {cell_var}.width, this.metrics.height)) {{\n",
            )
            lines.insert(target_line + 3, f"      {cell_var}.flags & {faint_var}.FAINT && (this.ctx.globalAlpha = 1);\n")
            lines.insert(target_line + 4, "      return;\n")
            lines.insert(target_line + 5, "    }\n")

with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)

print("done")
