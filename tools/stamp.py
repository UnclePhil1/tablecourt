#!/usr/bin/env python3
"""Stamps every local script and stylesheet in index.html with a hash of its contents.

  python3 tools/stamp.py

Without this, a browser can pair a fresh index.html with a stale js/audio.js it still had cached,
and the game dies on the first call into the part that changed. Stamping makes each version its own
URL, so a mixed set is impossible: either the browser has that exact file or it fetches it.

Only files whose contents changed get a new stamp, so everything else stays cached.
"""
import hashlib, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, 'index.html')
ATTR = re.compile(r'(\s(?:src|href)=")([^"]+?)(?:\?v=[0-9a-f]+)?(")')

def local(url):
    return not url.startswith(('http:', 'https:', 'data:', '#', '//'))

def digest(path):
    with open(path, 'rb') as f:
        return hashlib.sha1(f.read()).hexdigest()[:8]

def stamp(check_only=False):
    html = open(HTML, encoding='utf-8').read()
    changed, missing = [], []

    def sub(m):
        head, url, tail = m.group(1), m.group(2), m.group(3)
        if not local(url) or not url.lower().endswith(('.js', '.css')):
            return m.group(0)
        path = os.path.join(ROOT, url)
        if not os.path.exists(path):
            missing.append(url)
            return m.group(0)
        want = url + '?v=' + digest(path)
        had = m.group(0)[len(head):-len(tail)]
        if had != want:
            changed.append(url)
        return head + want + tail

    out = ATTR.sub(sub, html)

    # Files fetched at runtime rather than through a tag, listed in the TABLE_LAZY manifest. They get
    # the same guarantee as everything else: the hash travels in index.html, so a browser can never pair
    # a cached copy of one with a newer script that expects the new one.
    LAZY = re.compile(r"""(['"])([^'"]+\.(?:js|css))\1(\s*:\s*)(['"])\?v=[0-9a-f]+\4""")

    def one(m):
        url = m.group(2)
        path = os.path.join(ROOT, url)
        if not os.path.exists(path):
            missing.append(url)
            return m.group(0)
        q = m.group(1)
        want = q + url + q + m.group(3) + m.group(4) + '?v=' + digest(path) + m.group(4)
        if want != m.group(0):
            changed.append(url)
        return want

    out = LAZY.sub(one, out)

    if missing:
        print('  these are referenced but not on disk: %s' % ', '.join(missing))
    if check_only:
        return changed, missing
    if out != html:
        open(HTML, 'w', encoding='utf-8').write(out)
    return changed, missing

if __name__ == '__main__':
    changed, missing = stamp('--check' in sys.argv)
    if '--check' in sys.argv:
        if changed:
            print('  out of date: %s' % ', '.join(changed))
            print('\nFAIL  run python3 tools/stamp.py')
            sys.exit(1)
        print('  every script and stylesheet is stamped with its current contents')
    else:
        for c in changed:
            print('  restamped %s' % c)
        print('\n%d file(s) restamped' % len(changed) if changed else '\nnothing to do, all stamps current')
    sys.exit(1 if missing else 0)
