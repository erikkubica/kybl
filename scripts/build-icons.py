#!/usr/bin/env python3
"""Builds the Kybl icon sources (SVG) and renders them.

Run from the repo root:  python3 scripts/build-icons.py
Needs rsvg-convert (brew install librsvg) and pnpm. Writes src-tauri/icons/src/*.svg,
then every app icon size through `tauri icon`, and the menu-bar template icon (tray.png).
The drawing matches the brand book: enamel bucket, cast-iron rim, yellow grip, seven dots.
"""
import pathlib, shutil, subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
SRC = ICONS / "src"
IRON, RED, SUN = "#1e1a1a", "#d9381f", "#ffc93c"


def bucket(body=RED, inner="#8f1f0c", dot="#fff", line=IRON, grip=SUN):
    """Kyblík on a 200x200 grid."""
    dots = "".join(
        f'<circle cx="{x}" cy="{y}" r="5.2"/>'
        for x, y in [(62, 106), (138, 106), (66, 134), (134, 134), (76, 157), (100, 163), (124, 157)]
    )
    return f"""
  <path d="M40 76 C40 6 160 6 160 76" fill="none" stroke="{line}" stroke-width="7" stroke-linecap="round"/>
  <rect x="80" y="16" width="40" height="15" rx="7.5" fill="{grip}"/>
  <rect x="86" y="19" width="22" height="3.4" rx="1.7" fill="#fff" opacity="0.45"/>
  <path d="M38 76 L54 168 A46 12 0 0 0 146 168 L162 76 A62 16 0 0 1 38 76 Z" fill="{body}"/>
  <path d="M149 100 L139 162" fill="none" stroke="#000" stroke-opacity="0.12" stroke-width="13" stroke-linecap="round"/>
  <path d="M52 100 L57 130" fill="none" stroke="#fff" stroke-opacity="0.28" stroke-width="5" stroke-linecap="round"/>
  <path d="M54 168 A46 12 0 0 0 146 168" fill="none" stroke="{line}" stroke-width="4.5" stroke-linecap="round"/>
  <ellipse cx="100" cy="76" rx="66" ry="18" fill="{line}"/>
  <ellipse cx="100" cy="76" rx="56" ry="11.5" fill="{inner}"/>
  <path d="M44 70 A60 14 0 0 1 78 60" fill="none" stroke="#fff" stroke-opacity="0.35" stroke-width="2.6" stroke-linecap="round"/>
  <g fill="{dot}">{dots}</g>"""


FACE_ON_WHITE = f"""
  <ellipse cx="85" cy="115" rx="6.2" ry="7.8" fill="{IRON}"/><ellipse cx="115" cy="115" rx="6.2" ry="7.8" fill="{IRON}"/>
  <circle cx="87" cy="112.4" r="2" fill="#fff"/><circle cx="117" cy="112.4" r="2" fill="#fff"/>
  <path d="M89 133 Q100 144 111 133" fill="none" stroke="{IRON}" stroke-width="4.2" stroke-linecap="round"/>"""

FACE_ON_RED = f"""
  <ellipse cx="85" cy="114" rx="8.5" ry="10" fill="#fff"/><ellipse cx="115" cy="114" rx="8.5" ry="10" fill="#fff"/>
  <circle cx="86.5" cy="116" r="5" fill="{IRON}"/><circle cx="116.5" cy="116" r="5" fill="{IRON}"/>
  <circle cx="88.4" cy="113.8" r="1.8" fill="#fff"/><circle cx="118.4" cy="113.8" r="1.8" fill="#fff"/>
  <path d="M89 133 Q100 144 111 133" fill="none" stroke="{IRON}" stroke-width="4.2" stroke-linecap="round"/>"""

# macOS grid: an 824 px tile centered on a 1024 canvas, with room for its shadow.
APP_ICON = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f04e30"/><stop offset="1" stop-color="#c22b13"/></linearGradient>
    <filter id="tile-shadow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="14"/></filter>
    <filter id="ground" x="-40%" y="-200%" width="180%" height="500%"><feGaussianBlur stdDeviation="20"/></filter>
  </defs>
  <rect x="100" y="112" width="824" height="824" rx="185" fill="#000" opacity="0.28" filter="url(#tile-shadow)"/>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"/>
  <rect x="106" y="106" width="812" height="812" rx="179" fill="none" stroke="#fff" stroke-opacity="0.18" stroke-width="12"/>
  <ellipse cx="512" cy="772" rx="206" ry="33" fill="#4a0d02" opacity="0.55" filter="url(#ground)"/>
  <g transform="translate(198.9 190.6) scale(3.1312)">{bucket(body="#fff", inner="#cfc7c3", dot=RED)}{FACE_ON_WHITE}
  </g>
</svg>
"""

MASCOT = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="512" height="512">{bucket()}{FACE_ON_RED}
</svg>
"""

# Menu bar: one color (macOS tints template images). At 18 pt the old ellipse rim read as a lid, so
# this is a flat rim, a clear gap, a tapered body with one cut-out band and a bold, tall handle.
TRAY = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="44" height="44">
  <defs>
    <mask id="band"><rect width="64" height="64" fill="#fff"/><rect x="0" y="45.5" width="64" height="3.6" fill="#000"/></mask>
  </defs>
  <path d="M12.5 28 C12.5 2.5 51.5 2.5 51.5 28" fill="none" stroke="#000" stroke-width="6" stroke-linecap="round"/>
  <rect x="7" y="25.5" width="50" height="8.5" rx="4.25" fill="#000"/>
  <path mask="url(#band)" d="M11.5 37.5 H52.5 L47.8 57 Q47.2 60.5 43.7 60.5 H20.3 Q16.8 60.5 16.2 57 Z" fill="#000"/>
</svg>
"""


def main():
    SRC.mkdir(parents=True, exist_ok=True)
    for name, svg in [("app-icon.svg", APP_ICON), ("mascot.svg", MASCOT), ("tray.svg", TRAY)]:
        (SRC / name).write_text(svg)
    png = SRC / "app-icon.png"
    subprocess.run(["rsvg-convert", "-w", "1024", "-h", "1024", SRC / "app-icon.svg", "-o", png], check=True)
    subprocess.run(["rsvg-convert", "-w", "44", "-h", "44", SRC / "tray.svg", "-o", ICONS / "tray.png"], check=True)
    subprocess.run(["rsvg-convert", "-w", "512", "-h", "512", SRC / "mascot.svg", "-o", SRC / "mascot.png"], check=True)
    subprocess.run(["pnpm", "tauri", "icon", str(png)], cwd=ROOT, check=True)
    for mobile in ("android", "ios"):  # desktop-only app
        shutil.rmtree(ICONS / mobile, ignore_errors=True)


if __name__ == "__main__":
    main()
