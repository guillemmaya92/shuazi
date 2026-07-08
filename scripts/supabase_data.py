"""
Migrate local JSON/Excel data to Supabase for all tables.

Tables: components, component_char, radicals, chars, char_word, words, slang

Usage:
    python migrate_all.py [--tables components radicals chars words component_char char_word slang]
    python migrate_all.py --tables chars words   # migrate only specific tables

Data sources (edit DATA_SOURCES to match your project layout):
    - OR an Excel file  data/data.xlsx  with one sheet per table

Requires: pip install requests openpyxl pandas
"""

import argparse
import os
import sys
import time

import requests

# ---------------------------------------------------------------------------
# Supabase config
# ---------------------------------------------------------------------------
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

BATCH_SIZE = 500

# ---------------------------------------------------------------------------
# Data root (relative to this script)
# ---------------------------------------------------------------------------
DATA_DIR = os.path.join(os.path.dirname(__file__), 'data')
EXCEL_FILE = os.path.join(DATA_DIR, 'data.xlsx')

# ---------------------------------------------------------------------------
# Table definitions
# ---------------------------------------------------------------------------

def _sheet(sheet_name):
    """Read a sheet from data.xlsx into a list of row dicts."""
    import pandas as pd
    df = pd.read_excel(EXCEL_FILE, sheet_name=sheet_name)
    df = df.where(df.notna(), other=None)
    return df.to_dict(orient='records')


# ---------------------------------------------------------------------------
# Row transformers
# ---------------------------------------------------------------------------

def load_components():
    rows = _sheet('components')
    return [
        {
            'id':         int(r['id']),
            'component':  r['component'],
            'pinyin':     r['pinyin'],
            'meaning':    r['meaning'],
            'meaning_es':    r['meaning_es'],
            'stroke':     int(r['stroke']) if r['stroke'] is not None else None,
            'productive': int(r['productive']) if r['productive'] is not None else None,
            'frequency':  float(r['frequency']) if r['frequency'] is not None else None,
        }
        for r in rows
    ]


def load_component_char():
    rows = _sheet('component_char')
    seen = set()
    result = []
    for r in rows:
        key = (int(r['id_component']), int(r['id_char']))
        if key not in seen:
            seen.add(key)
            result.append({'id_component': key[0], 'id_char': key[1]})
    return result


def load_radicals():
    rows = _sheet('radicals')
    return [
        {
            'id':          int(r['id']),
            'radical':     r['radical'],
            'traditional': r.get('traditional'),
            'pinyin':      r['pinyin'],
            'meaning':     r['meaning'],
            'meaning_es':     r['meaning_es'],
            'stroke':      int(r['stroke']) if r['stroke'] is not None else None,
            'productive':  int(r['productive']) if r['productive'] is not None else None,
            'frequency':   float(r['frequency']) if r['frequency'] is not None else None,
        }
        for r in rows
    ]


def load_chars():
    rows = _sheet('chars')
    return [
        {
            'id':         int(r['id']),
            'char':       r['char'],
            'pinyin':     r['pinyin'],
            'meaning':    r['meaning'],
            'meaning_es': r['meaning_es'],
            'radical':    r.get('radical'),
            'pos':        r.get('pos'),
            'hsk':        int(r['hsk']) if r.get('hsk') is not None else None,
            'stroke':     int(r['stroke']) if r.get('stroke') is not None else None,
            'productive': int(r['productive']) if r.get('productive') is not None else None,
            'frequency':  float(r['frequency']) if r.get('frequency') is not None else None,
        }
        for r in rows
    ]


def load_char_word():
    rows = _sheet('char_word')
    seen = set()
    result = []
    for r in rows:
        key = (int(r['id_char']), int(r['id_word']))
        if key not in seen:
            seen.add(key)
            result.append({'id_char': key[0], 'id_word': key[1]})
    return result


def load_words():
    rows = _sheet('words')
    return [
        {
            'id':      int(r['id']),
            'word':    r['word'],
            'pinyin':  r['pinyin'],
            'meaning': r['meaning'],
            'meaning_es': r['meaning_es'],
            'hsk':     int(r['hsk']) if r.get('hsk') is not None else None,
            'radical': r['radical'],
            'pos':     r['pos'],
            'stroke':  int(r['stroke']) if r.get('stroke') is not None else None,
            'productive':  int(r['productive']) if r.get('productive') is not None else None,
            'frequency': float(r['frequency']) if r.get('frequency') is not None else None,
        }
        for r in rows
    ]

def load_word_phrase():
    rows = _sheet('word_phrase')
    seen = set()
    result = []
    for r in rows:
        key = (int(r['id_word']), int(r['id_phrase']))
        if key not in seen:
            seen.add(key)
            result.append({'id_word': key[0], 'id_phrase': key[1]})
    return result

def load_phrases():
    rows = _sheet('phrases')
    return [
        {
            'id':      int(r['id']),
            'phrase':  r['phrase'],
            'pinyin':  r['pinyin'],
            'meaning': r['meaning'],
            'meaning_es': r['meaning_es'],
            'count':   int(r['count']) if r.get('count') is not None else None,
        }
        for r in rows
    ]

def load_slang():
    rows = _sheet('slang')
    return [
        {
            'id':      int(r['id']),
            'slang':   r['slang'],
            'pinyin':  r.get('pinyin'),
            'literal': r.get('literal'),
            'meaning': r.get('meaning'),
            'origin':  r.get('origin'),
            'literal_es': r.get('literal_es'),
            'meaning_es': r.get('meaning_es'),
            'origin_es':  r.get('origin_es'),
            'image':   r.get('image'),
        }
        for r in rows
    ]


TABLE_LOADERS = {
    'components':     load_components,
    'component_char': load_component_char,
    'radicals':       load_radicals,
    'chars':          load_chars,
    'char_word':      load_char_word,
    'words':          load_words,
    'word_phrase':    load_word_phrase,
    'phrases':        load_phrases,
    'slang':          load_slang,
}

DEFAULT_ORDER = ['components', 'radicals', 'chars', 'words', 'phrases', 'component_char', 'char_word', 'word_phrase', 'slang']


# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

def upload(table: str, rows: list):
    total = len(rows)
    for start in range(0, total, BATCH_SIZE):
        batch = rows[start:start + BATCH_SIZE]
        end = start + len(batch)
        for attempt in range(1, 4):
            try:
                resp = requests.post(
                    f'{SUPA_URL}/rest/v1/{table}',
                    headers=HEADERS,
                    json=batch,
                    timeout=60,
                )
                if resp.status_code in (200, 201):
                    print(f'    {end:,}/{total:,} OK')
                    break
                else:
                    print(f'    {end:,}/{total:,} ERROR {resp.status_code}: {resp.text[:300]}')
                    sys.exit(1)
            except requests.exceptions.ConnectionError as e:
                if attempt < 3:
                    print(f'    {end:,}/{total:,} connection error, retrying ({attempt}/3)...')
                    time.sleep(5 * attempt)
                else:
                    print(f'    {end:,}/{total:,} FAILED after 3 attempts: {e}')
                    sys.exit(1)
        time.sleep(0.3)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Migrate data to Supabase')
    parser.add_argument(
        '--tables', nargs='+',
        choices=list(TABLE_LOADERS.keys()),
        default=DEFAULT_ORDER,
        metavar='TABLE',
        help=f'Tables to migrate (default: all in order). Choices: {", ".join(DEFAULT_ORDER)}',
    )
    args = parser.parse_args()

    tables = [t for t in DEFAULT_ORDER if t in args.tables]

    for table in tables:
        print(f'\n[{table}]')
        try:
            rows = TABLE_LOADERS[table]()
        except FileNotFoundError as e:
            print(f'  SKIP — source file not found: {e}')
            continue
        except Exception as e:
            print(f'  SKIP — failed to load: {e}')
            continue

        print(f'  {len(rows):,} rows loaded — uploading in batches of {BATCH_SIZE} …')
        upload(table, rows)
        print(f'  Done.')

    print('\nAll done.')


if __name__ == '__main__':
    main()