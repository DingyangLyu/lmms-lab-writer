"""Builds the Y-Writer mark and wordmark SVGs; the text is converted to outlines.

The wordmark is set in Outfit (SIL Open Font License 1.1). Download its variable font
(https://github.com/google/fonts/raw/main/ofl/outfit/Outfit%5Bwght%5D.ttf), then:

    pip install fonttools uharfbuzz
    OUTFIT_TTF=/path/to/Outfit[wght].ttf python3 scripts/make-logo.py imgs

Copy the results to apps/desktop/public, apps/collaboration/public and imgs. The app icon
(app-icon.svg, rendered to a 1024 px PNG) feeds undefined
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "tauri" not found

Did you mean "pnpm tauri:dev"? in apps/desktop.
"""
import os, sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

TEAL_DARK, TEAL_LIGHT, AMBER = "#163d50", "#2f8099", "#f2b544"

def mark(size=1024, rounded=True, outline=False):
    """The app mark: a Y whose stem is a pen nib, white on a teal tile."""
    r = 228 if rounded else 0
    # On dark backgrounds a faint light rim keeps the tile from melting into them.
    outline_rect = f'<rect x="14" y="14" width="996" height="996" rx="{r - 14}" fill="none" stroke="#ffffff" stroke-opacity="0.28" stroke-width="28"/>' if outline else ""
    return f'''<defs><linearGradient id="yw-bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="{TEAL_LIGHT}"/><stop offset="1" stop-color="{TEAL_DARK}"/></linearGradient></defs>
<rect width="1024" height="1024" rx="{r}" fill="url(#yw-bg)"/>{outline_rect}
<g transform="translate(0 22)"><g fill="none" stroke="#fff" stroke-width="118" stroke-linecap="round" stroke-linejoin="round">
<path d="M318 252 L512 486 L706 252"/></g>
<path fill="#fff" d="M453 470 H571 V588 C571 640 552 690 528 742 L512 790 L496 742 C472 690 453 640 453 588 Z"/>
<path stroke="{TEAL_DARK}" stroke-width="14" stroke-linecap="round" d="M512 612 V752"/>
<circle cx="512" cy="590" r="30" fill="{AMBER}"/></g>'''

def text_path(text, weight, size):
    font = TTFont(os.environ.get("OUTFIT_TTF") or os.path.join(HERE, "Outfit.ttf"))
    inst = instantiateVariableFont(font, {"wght": weight}, inplace=False)
    path = os.path.join(OUT, f".outfit-{weight}.ttf"); inst.save(path)
    blob = hb.Blob.from_file_path(path); face = hb.Face(blob); hbfont = hb.Font(face)
    buf = hb.Buffer(); buf.add_str(text); buf.guess_segment_properties(); hb.shape(hbfont, buf, {"kern": True, "liga": True})
    upem = inst["head"].unitsPerEm; scale = size / upem
    glyphs = inst.getGlyphSet(); order = inst.getGlyphOrder()
    x = 0; parts = []
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        pen = SVGPathPen(glyphs)
        # Font units point up; SVG points down: flip and scale, baseline at y=0.
        glyphs[order[info.codepoint]].draw(TransformPen(pen, (scale, 0, 0, -scale, (x + pos.x_offset) * scale, -pos.y_offset * scale)))
        parts.append(pen.getCommands())
        x += pos.x_advance
    ascent = inst["hhea"].ascent * scale
    os.remove(path)
    return parts, x * scale, ascent

def wordmark(dark=False, height=120, gap_ratio=0.26):
    """Mark + "Y-Writer" on one line; `height` is the mark size."""
    ink, accent = ("#eef4f7", "#7cc4d8") if dark else ("#1b3644", TEAL_LIGHT)
    size = height * 0.78
    parts, width, ascent = text_path("Y-Writer", 600, size)
    cap = size * 0.70  # Outfit cap height ~ 0.7 em
    gap = height * gap_ratio
    tx = height + gap; baseline = height / 2 + cap / 2
    total = tx + width
    # First two glyphs ("Y-") take the accent colour.
    glyphs = "".join(f'<path fill="{accent if i < 2 else ink}" d="{d}"/>' for i, d in enumerate(parts))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total:.1f} {height}" width="{total:.1f}" height="{height}" role="img" aria-label="Y-Writer">'
            f'<g transform="scale({height/1024:.5f})">{mark(outline=dark)}</g>'
            f'<g transform="translate({tx:.1f} {baseline:.1f})">{glyphs}</g></svg>')

def standalone_mark(rounded=True):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="Y-Writer">{mark(rounded=rounded)}</svg>'

def write(name, svg):
    with open(os.path.join(OUT, name), "w") as f: f.write(svg + "\n")

write("mark.svg", standalone_mark())
# macOS app icon grid: the tile is 824 px inside a transparent 1024 canvas.
write("app-icon.svg", f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024"><g transform="translate(100 100) scale(0.8046875)">{mark()}</g></svg>')
write("logo-light.svg", wordmark(False, 120))
write("logo-dark.svg", wordmark(True, 120))
write("logo-small-light.svg", wordmark(False, 28, 0.32))
write("logo-small-dark.svg", wordmark(True, 28, 0.32))
print("written to", OUT)
