#!/usr/bin/env python3
"""Lists what is in assets/audio/ so the game can find it.  python3 tools/make_audio_manifest.py

A static site cannot read a directory, so "every file in the music folder" has to be written down
somewhere. Drop tracks into assets/audio/music/, run this, and they join the playlist.

Each path carries a hash of that file's contents. Audio is served with a week-long cache and no
revalidation, which is right for a file that never changes — but a sound dropped in under a name that
already existed would otherwise go unheard for a week, with the game quietly using its generated
stand-in and nothing anywhere saying why. The hash changes when the bytes change, so the browser sees
a new address and fetches it.
"""
import hashlib, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO = os.path.join(ROOT, 'assets', 'audio')
PLAYABLE = ('.mp3', '.ogg', '.m4a', '.wav', '.webm', '.opus', '.aac', '.flac')

def stamp(path):
    with open(path, 'rb') as f:
        return hashlib.sha1(f.read()).hexdigest()[:8]

def listing(folder):
    d = os.path.join(AUDIO, folder)
    os.makedirs(d, exist_ok=True)
    return sorted(f for f in os.listdir(d) if f.lower().endswith(PLAYABLE))

def url(folder, f):
    return 'assets/audio/%s/%s?v=%s' % (folder, f, stamp(os.path.join(AUDIO, folder, f)))

sfx = {os.path.splitext(f)[0]: url('sfx', f) for f in listing('sfx')}
music = [url('music', f) for f in listing('music')]

out = os.path.join(AUDIO, 'manifest.json')
with open(out, 'w', encoding='utf-8') as f:
    json.dump({'sfx': sfx, 'music': music}, f, indent=2, sort_keys=True)
    f.write('\n')

print('wrote', os.path.relpath(out, ROOT))
print('  %d sound effects: %s' % (len(sfx), ', '.join(sorted(sfx)) or 'none'))
print('  %d music tracks: %s' % (len(music), ', '.join(os.path.basename(m) for m in music) or 'none yet'))
if not music:
    print('\n  Music folder is empty. Put .mp3 or .ogg files in assets/audio/music/ and run this again;')
    print('  the game plays whatever is listed here, shuffled, and loops for ever.')
