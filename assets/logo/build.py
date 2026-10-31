"""Writes every Wattamax logo SVG into assets/, the link preview image, and the outlines the GPS drawings follow."""
from pathlib import Path

import cairosvg

from icon import icon
from outlines import js, stroke
from wordmark import wordmark, tt_alone

OUT = Path(__file__).parent.parent


def inner(svg):
    """The drawing of one of our SVGs, without its <svg> and <title> lines."""
    return "".join(svg.splitlines(keepends=True)[2:-1])


def preview(icon_svg, wordmark_svg, w=1200, h=630, size=180):
    """Link preview (og:image): the light icon above the wordmark, centred on white.
    They fit in the middle square, because Google crops the image to a square in its results."""
    ratio = float(wordmark_svg.split('viewBox="0 0 ')[1].split()[0]) / 100
    width = size * 2.2
    height = width / ratio
    gap = size / 4
    top = (h - size - gap - height) / 2
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}">\n<rect width="{w}" height="{h}" fill="#FFFFFF"/>\n'
            f'<svg x="{(w - size) / 2}" y="{top}" width="{size}" height="{size}" viewBox="0 0 100 100">\n{inner(icon_svg)}</svg>\n'
            f'<svg x="{(w - width) / 2}" y="{top + size + gap}" width="{width}" height="{height}" viewBox="0 0 {ratio * 100} 100">\n'
            f'{inner(wordmark_svg)}</svg>\n</svg>\n')


files = {"wattamax-tt.svg": tt_alone()}
files |= {f"wattamax-icon{suffix}.svg": svg for suffix, svg in icon().items()}
files |= {f"wattamax-wordmark{suffix}.svg": svg for suffix, svg in wordmark().items()}
for name, svg in files.items():
    (OUT / name).write_text(svg)
    print(OUT / name)

cairosvg.svg2png(bytestring=preview(files["wattamax-icon-light.svg"], files["wattamax-wordmark.svg"]).encode(),
                 write_to=str(OUT / "wattamax-og.png"))
print(OUT / "wattamax-og.png")

outlines = Path(__file__).parents[2] / "js" / "outlines.js"
outlines.write_text(js({"TT": stroke(files["wattamax-tt.svg"]), "ICON": stroke(files["wattamax-icon.svg"]),
                        "WORDMARK": stroke(files["wattamax-wordmark.svg"])}))
print(outlines)
