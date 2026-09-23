#!/usr/bin/env python3
"""Serves the game for development, telling the browser never to cache anything.

  python3 tools/serve.py [port]        # default 8000

python3 -m http.server sends no cache headers at all, so browsers guess — and they guess wrong in a
way that is hard to spot: you edit js/audio.js, reload, and the browser quietly keeps the old file
while taking the new index.html. The game then fails somewhere unrelated. This sends no-store for
everything, so a reload is always a real reload.

Vercel does the right thing in production (index.html and js/css revalidate, and every script carries
a content hash from tools/stamp.py), so this is only for working locally.
"""
import os, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class NoCache(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()
    def log_message(self, fmt, *args):
        if '404' in (fmt % args):
            sys.stderr.write('  404  %s\n' % (fmt % args))

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
print('Table is at http://localhost:%d  (nothing is cached; every reload is a real one)' % port)
print('Serving %s — Ctrl+C to stop' % ROOT)
ThreadingHTTPServer(('0.0.0.0', port), NoCache).serve_forever()
