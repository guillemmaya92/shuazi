"""
Segmenta un texto chino con "|" entre palabras, listo para guardar en
`texts.body` (o en public/js/texts.js).

Usa el mismo algoritmo que el cliente (maxima coincidencia hacia delante contra
la tabla `words` de Supabase), asi que el resultado es un buen punto de partida:
revisalo y corrige a mano lo que haga falta (une o separa con "|").

Uso:
    python scripts/segment_text.py texto.txt
    python scripts/segment_text.py texto.txt --names 小电,大晴
    python scripts/segment_text.py texto.txt -o segmentado.txt   # recomendado en Windows
    type texto.txt | python scripts/segment_text.py -
    python scripts/segment_text.py texto.txt --refresh     # vuelve a bajar `words`

- Cada linea no vacia del archivo es un parrafo; la salida separa parrafos
  con una linea en blanco.
- --names: palabras (nombres propios, etc.) que se mantienen como un solo trozo
  aunque no esten en `words`.
- Los caracteres chinos que no estan en `words` salen sueltos, uno por trozo.
- La URL y la clave anonima de Supabase se leen de public/js/config.js.
"""

import argparse
import json
import os
import re
import sys
import urllib.request

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
CONFIG_JS  = os.path.abspath(os.path.join(BASE_DIR, '..', 'public', 'js', 'config.js'))
CACHE_FILE = os.path.join(BASE_DIR, '.words_cache.json')
PAGE       = 1000

HAN   = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U0002ebef]')
ALNUM = re.compile(r'[0-9A-Za-z]+')


def read_supabase_config():
    src = open(CONFIG_JS, encoding='utf-8').read()
    url = re.search(r"SUPA_URL\s*=\s*'([^']+)'", src).group(1)
    key = re.search(r"SUPA_KEY\s*=\s*'([^']+)'", src).group(1)
    return url, key


def fetch_words():
    url, key = read_supabase_config()
    words, start = [], 0
    while True:
        req = urllib.request.Request(
            f'{url}/rest/v1/words?select=word&order=id',
            headers={
                'apikey': key,
                'Authorization': f'Bearer {key}',
                'Range-Unit': 'items',
                'Range': f'{start}-{start + PAGE - 1}',
            },
        )
        with urllib.request.urlopen(req) as resp:
            rows = json.load(resp)
        words.extend(r['word'] for r in rows if r.get('word'))
        if len(rows) < PAGE:
            return words
        start += PAGE


def load_words(refresh):
    if not refresh and os.path.exists(CACHE_FILE):
        with open(CACHE_FILE, encoding='utf-8') as f:
            return json.load(f)
    words = fetch_words()
    with open(CACHE_FILE, 'w', encoding='utf-8') as f:
        json.dump(words, f, ensure_ascii=False)
    return words


def segment(line, vocab, max_len):
    out, i = [], 0
    while i < len(line):
        ch = line[i]
        if HAN.match(ch):
            for n in range(min(max_len, len(line) - i), 0, -1):
                cand = line[i:i + n]
                if cand in vocab:
                    out.append(cand)
                    i += n
                    break
            else:
                out.append(ch)   # caracter chino que no esta en `words`
                i += 1
            continue
        m = ALNUM.match(line, i)
        if m:                    # numeros / letras latinas: un solo trozo
            out.append(m.group())
            i = m.end()
            continue
        if not ch.isspace():     # puntuacion: un trozo por simbolo
            out.append(ch)
        i += 1
    return '|'.join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('file', help="archivo de texto plano, o '-' para stdin")
    ap.add_argument('--names', default='', help='palabras extra separadas por comas')
    ap.add_argument('--refresh', action='store_true', help='vuelve a descargar la tabla words')
    ap.add_argument('-o', '--out', help='escribe el resultado en este archivo (UTF-8) en vez de stdout')
    args = ap.parse_args()

    text = sys.stdin.read() if args.file == '-' else open(args.file, encoding='utf-8').read()
    vocab = set(load_words(args.refresh))
    vocab.update(n.strip() for n in args.names.split(',') if n.strip())
    max_len = max(len(w) for w in vocab)

    paragraphs = [segment(p.strip(), vocab, max_len) for p in text.splitlines() if p.strip()]
    result = '\n\n'.join(paragraphs)
    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(result + '\n')
    else:
        sys.stdout.reconfigure(encoding='utf-8')
        print(result)


if __name__ == '__main__':
    main()
