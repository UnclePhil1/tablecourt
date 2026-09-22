"""Builds ONE self-contained HTML file (all scripts, fonts and images inside) for quick previews.
Usage: python3 tools/build_preview.py table-preview.html"""
import base64, re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
out = sys.argv[1] if len(sys.argv) > 1 else 'table-preview.html'
b64 = lambda p, mime: f"data:{mime};base64," + base64.b64encode((root / p).read_bytes()).decode()
html = (root / 'index.html').read_text()

css = (root / 'css/style.css').read_text()
css = re.sub(r'url\(\.\./(vendor/fonts/[^)]+\.woff2)\)', lambda m: f"url({b64(m.group(1), 'font/woff2')})", css)
html = html.replace('<link rel="stylesheet" href="css/style.css">', f'<style>{css}</style>')

def inline(m):
    src = m.group(1); code = (root / src).read_text()
    assert '</script' not in code, src
    return f'<script>{code}</script>'
html = re.sub(r'<script src="([^"]+)"></script>', inline, html)

html = re.sub(r'(src|href)="(assets/[^"]+\.(png|ico))"', lambda m: f'{m.group(1)}="{b64(m.group(2), "image/png" if m.group(3)=="png" else "image/x-icon")}"', html)
(root / out).write_text(html)
print(out, round(len(html) / 1024), 'KB')
