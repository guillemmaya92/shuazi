"""
Migrate words.json to Supabase words table.

Run AFTER executing supabase_words.sql in the Supabase SQL Editor.

Usage:
    python scripts/migrate_words.py

Requires: pip install requests
"""

import json
import time
import sys
import os
import requests

SUPA_URL = 'https://coysmojauucqgdhhxyrz.supabase.co'
SUPA_KEY = (
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    '.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNveXNtb2phdXVjcWdkaGh4eXJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzODAxOTMsImV4cCI6MjA5Njk1NjE5M30'
    '.JO6U0TyW5gcnmJMJAvvzSh_ZiMdCKCEtRSz_N8h8adM'
)

HEADERS = {
    'apikey': SUPA_KEY,
    'Authorization': f'Bearer {SUPA_KEY}',
    'Content-Type': 'application/json',
    'Prefer': 'resolution=merge-duplicates',
}

WORDS_PATH = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'words.json')
BATCH_SIZE = 500


def load_words():
    print(f'Loading {WORDS_PATH} ...')
    with open(WORDS_PATH, encoding='utf-8') as f:
        raw = json.load(f)
    rows = [
        {
            'word':     w['id'],
            'pinyin':   w['pinyin'],
            'meaning':  w['meaning'],
            'grp':      int(w['group']),
            'char_ids': w['chars'],
        }
        for w in raw
    ]
    print(f'  {len(rows):,} words loaded')
    return rows


def upload(rows):
    total = len(rows)
    for start in range(0, total, BATCH_SIZE):
        batch = rows[start:start + BATCH_SIZE]
        resp = requests.post(
            f'{SUPA_URL}/rest/v1/words',
            headers=HEADERS,
            json=batch,
            timeout=30,
        )
        end = start + len(batch)
        if resp.status_code in (200, 201):
            print(f'  {end:,}/{total:,} OK')
        else:
            print(f'  {end:,}/{total:,} ERROR {resp.status_code}: {resp.text[:200]}')
            sys.exit(1)
        time.sleep(0.05)


if __name__ == '__main__':
    rows = load_words()
    print(f'Uploading {len(rows):,} rows in batches of {BATCH_SIZE} ...')
    upload(rows)
    print('Done.')
