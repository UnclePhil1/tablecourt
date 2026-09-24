#!/usr/bin/env python3
"""Checks the project is fit to deploy. Run it before pushing:  python3 tools/preflight.py

It looks for the mistakes that are easy to make in a project with no build step: a file referenced
but not shipped, the client and the database drifting apart, a secret key pasted into config, or a
stray innerHTML opening an XSS hole in text that other players control.
"""
import json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
problems, notes = [], []
def read(*p): return open(os.path.join(ROOT, *p), encoding='utf-8').read()

# 1. every file index.html asks for is actually there
html = read('index.html')
refs = re.findall(r'(?:src|href)="(?!https?:|data:|#)([^"]+)"', html)
refs = [r.split('?')[0] for r in refs]        # drop the cache-busting stamp before looking on disk
for r in refs:
    if not os.path.exists(os.path.join(ROOT, r)):
        problems.append('index.html references %s, which does not exist' % r)
notes.append('%d local files referenced by index.html, all present' % len(refs))

# 2. the client's expected schema version matches the schema file
sv = re.search(r"'version',\s*(\d+)", read('supabase', 'schema.sql'))
jv = re.search(r'WANT_VERSION = (\d+)', read('js', 'auth.js'))
if not sv or not jv:
    problems.append('could not find the schema version in schema.sql or auth.js')
elif sv.group(1) != jv.group(1):
    problems.append('schema.sql is version %s but auth.js expects %s' % (sv.group(1), jv.group(1)))
else:
    notes.append('schema version %s matches on both sides' % sv.group(1))

# 3. nothing that writes HTML from a string
for name in sorted(os.listdir(os.path.join(ROOT, 'js'))):
    if not name.endswith('.js'):
        continue
    src = read('js', name)
    for bad in ('innerHTML', 'outerHTML', 'document.write', 'insertAdjacentHTML', 'eval('):
        if bad in src:
            problems.append('js/%s uses %s — player names and match titles reach the DOM, so build nodes instead' % (name, bad))
notes.append('no innerHTML/eval in js/ — every node is built with textContent')

# 4. only the public key belongs in config.js
cfg = read('js', 'config.js')
# strip comments first: config.js *warns* about the service_role key, which is not the same as holding one
code = re.sub(r'/\*.*?\*/', '', cfg, flags=re.S)
code = re.sub(r'(?m)//.*$', '', code)
if re.search(r'service_role|sb_secret_', code, re.I):
    problems.append('js/config.js looks like it holds a secret key — only the anon/publishable key is safe in browser code')
role = re.search(r'"role"\s*:\s*"(\w+)"', cfg)
m = re.search(r"SUPABASE_ANON_KEY:\s*'([^']+)'", cfg)
if m:
    import base64
    try:
        body = m.group(1).split('.')[1]
        body += '=' * (-len(body) % 4)
        claim = json.loads(base64.urlsafe_b64decode(body)).get('role')
        if claim != 'anon':
            problems.append('the key in js/config.js has role "%s"; it must be anon' % claim)
        else:
            notes.append('config.js holds an anon key, which is safe to publish')
    except Exception:
        notes.append('config.js key is not a JWT (a sb_publishable_ key is fine too)')

# 4b. the preconnect hint must point at the same database as config.js
pre = re.search(r'<link rel="preconnect" href="([^"]+)"', html)
url = re.search(r"SUPABASE_URL: '([^']+)'", cfg)
if pre and url and pre.group(1).rstrip('/') != url.group(1).rstrip('/'):
    problems.append('index.html preconnects to %s but config.js points at %s' % (pre.group(1), url.group(1)))
elif pre:
    notes.append('preconnect hint matches SUPABASE_URL')

# 4c. errors go through one place, and the page can show them
if 'js/errors.js' not in html:
    problems.append('index.html does not load js/errors.js, so nothing catches uncaught errors')
for el in ('problem', 'problemText', 'problemFix', 'problemTech', 'problemDetails', 'problemClose'):
    if 'id="%s"' % el not in html:
        problems.append('index.html is missing the #%s element the error banner needs' % el)
raw = [n for n in sorted(os.listdir(os.path.join(ROOT, 'js')))
       if n.endswith('.js') and n != 'errors.js' and 'console.warn(' in read('js', n)]
if raw:
    problems.append('these still log errors straight to the console instead of Err.log: %s' % ', '.join(raw))
notes.append('every error path goes through js/errors.js')

# 4d. sharing metadata, since invite links get pasted into chat apps
for tag in ('og:title', 'og:description', 'og:image', 'twitter:card'):
    if tag not in html:
        problems.append('index.html is missing the %s tag, so shared invites will look bare' % tag)
og = re.search(r'property="og:image" content="([^"]+)"', html)
if og and not os.path.exists(os.path.join(ROOT, og.group(1))):
    problems.append('og:image points at %s, which does not exist' % og.group(1))
elif og:
    notes.append('share card image present (%s)' % og.group(1))

# 4e. the audio manifest matches what is actually on disk
try:
    man = json.loads(read('assets', 'audio', 'manifest.json'))
    missing = [v for v in man.get('sfx', {}).values() if not os.path.exists(os.path.join(ROOT, v))]
    if missing:
        problems.append('the audio manifest lists files that are not there: %s' % ', '.join(missing))
    on_disk = {f for f in os.listdir(os.path.join(ROOT, 'assets', 'audio', 'sfx'))
               if f.lower().endswith(('.wav', '.mp3', '.ogg', '.m4a'))}
    listed = {os.path.basename(v) for v in man.get('sfx', {}).values()}
    stray = on_disk - listed
    if stray:
        problems.append('these sounds are on disk but not in the manifest, so they will never play: %s '
                        '(run tools/make_audio_manifest.py)' % ', '.join(sorted(stray)))
    notes.append('%d sound effects and %d music tracks in the manifest' % (len(man.get('sfx', {})), len(man.get('music', []))))
    if not man.get('music'):
        notes.append('no music yet: drop files in assets/audio/music/ and rerun tools/make_audio_manifest.py')
except FileNotFoundError:
    problems.append('assets/audio/manifest.json is missing (run tools/make_audio_manifest.py)')
except ValueError as e:
    problems.append('assets/audio/manifest.json is not valid JSON: %s' % e)

# 4f. cache-busting stamps are current, so a browser can never mix old and new scripts
try:
    sys.path.insert(0, os.path.join(ROOT, 'tools'))
    import stamp as stamp_mod
    stale, _absent = stamp_mod.stamp(check_only=True)
    if stale:
        problems.append('these are not stamped with their current contents, so a cached copy could be '
                        'paired with a fresh index.html: %s (run python3 tools/stamp.py)' % ', '.join(stale))
    else:
        notes.append('every script and stylesheet is stamped with its contents')
except Exception as e:
    problems.append('could not check the cache-busting stamps: %s' % e)

# 4g. only one side of a call may lay out the media lines
# When both peers created their own audio and video transceivers, two simultaneous offers interleaved
# the two sets: each side ended up with four media lines instead of two, and a camera switched on at
# one end streamed into a line the other end had negotiated as inactive. Nothing errored; the picture
# simply never arrived. tools/rtc-loopback.html is the live test for this; this is the cheap guard.
vid_lines = read('js', 'video.js').split('\n')
loose = []
for n, line in enumerate(vid_lines):
    if 'addTransceiver' not in line:
        continue
    before = [l.strip() for l in vid_lines[:n] if l.strip()]
    enclosing = next((re.match(r'(?:async )?function (\w+)', l).group(1)
                      for l in reversed(before) if re.match(r'(?:async )?function \w+', l)), '')
    inside_slot = enclosing == 'slot'
    guarded = any('if (!polite)' in l for l in before[-5:])
    if not (inside_slot or guarded):
        loose.append(n + 1)
if loose:
    problems.append('js/video.js line(s) %s create a transceiver on either side; only the impolite side '
                    'may lay out the media lines (if (!polite)), or two simultaneous offers give each peer '
                    'four media lines and media goes nowhere'
                    % ', '.join(str(n) for n in loose))
else:
    notes.append('js/video.js lays out media lines on one side only')

# 5. vercel.json sane, and the server-only files are not shipped
try:
    v = json.load(open(os.path.join(ROOT, 'vercel.json')))
    hdrs = [h['key'] for block in v.get('headers', []) for h in block['headers']]
    for need in ('Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy'):
        if need not in hdrs:
            problems.append('vercel.json is missing the %s header' % need)
    notes.append('vercel.json sets %d headers' % len(hdrs))
except FileNotFoundError:
    problems.append('vercel.json is missing')
except ValueError as e:
    problems.append('vercel.json is not valid JSON: %s' % e)

try:
    ignored = read('.vercelignore')
    for d in ('supabase/', 'tools/', 'table-bet/'):
        if d not in ignored:
            problems.append('.vercelignore should exclude %s from the deployment' % d)
    notes.append('.vercelignore keeps supabase/, tools/ and table-bet/ off the public site')
except FileNotFoundError:
    problems.append('.vercelignore is missing, so schema.sql would be downloadable')

for line in notes:
    print('  ok    ' + line)
for line in problems:
    print('  FAIL  ' + line)
print('\n' + ('PASS  ready to deploy' if not problems else 'FAIL  %d problem(s)' % len(problems)))
sys.exit(1 if problems else 0)
