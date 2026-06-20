"""
export_tatoeba_pairs.py

Descarga el dump oficial completo de Tatoeba y genera un CSV con TODOS los
pares de frases chino (cmn) - inglés (eng) enlazados como traducción.

Salida (tatoeba_cn_en.csv):
    cmn_id ; sentence_zh ; eng_id ; sentence_en

Uso:
    python export_tatoeba_pairs.py

Nota de licencia: las frases de Tatoeba son CC-BY (algunas CC0). Si las usas
de cara al usuario final en shuazi, requieren atribución a tatoeba.org.
"""

import bz2
import csv
import re
import tarfile
import urllib.request
from pathlib import Path

import jieba
import opencc
from pypinyin import Style, pinyin

# Conversor de chino tradicional a simplificado
_T2S = opencc.OpenCC("t2s")

# Rango de caracteres Han (CJK Unified Ideographs + extensión A)
HANZI_RE = re.compile(r"[㐀-䶿一-鿿]")
# Una "palabra" para el pinyin: hanzi, dígito o letra latina
WORD_RE = re.compile(r"[0-9A-Za-z㐀-䶿一-鿿]")

# Tabla para pasar dígitos/letras de ancho completo (fullwidth) y el espacio
# ideográfico a su forma ASCII normal: ６→6, １８→18, Ａ→A, U+3000→espacio.
_FULLWIDTH = {0x3000: 0x20}
for _i in range(0xFF10, 0xFF1A):  # ０-９
    _FULLWIDTH[_i] = _i - 0xFEE0
for _i in range(0xFF21, 0xFF3B):  # Ａ-Ｚ
    _FULLWIDTH[_i] = _i - 0xFEE0
for _i in range(0xFF41, 0xFF5B):  # ａ-ｚ
    _FULLWIDTH[_i] = _i - 0xFEE0


def normalize(text: str) -> str:
    """Convierte dígitos y letras de ancho completo a ASCII."""
    return text.translate(_FULLWIDTH)


def to_pinyin(tokens: list[str]) -> str:
    """Pinyin agrupado por palabra; la puntuación se pega sin espacio."""
    out = ""
    for tok in tokens:
        chunk = "".join(syl[0] for syl in pinyin(tok, style=Style.TONE))
        if WORD_RE.search(tok):
            out += (" " + chunk) if out else chunk
        else:
            out += chunk  # puntuación: sin espacio delante
    return out


def count_hanzi(text: str) -> int:
    return len(HANZI_RE.findall(text))

# ---------------- CONFIG ----------------
BASE_DIR = Path(__file__).parent

CMN_URL = "https://downloads.tatoeba.org/exports/per_language/cmn/cmn_sentences.tsv.bz2"
ENG_URL = "https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences.tsv.bz2"
LINKS_URL = "https://downloads.tatoeba.org/exports/links.tar.bz2"

DATA_DIR = BASE_DIR / "tatoeba_data"
CMN_FILE = DATA_DIR / "cmn_sentences.tsv.bz2"
ENG_FILE = DATA_DIR / "eng_sentences.tsv.bz2"
LINKS_FILE = DATA_DIR / "links.tar.bz2"

OUTPUT_CSV = BASE_DIR / "raw_phrases.csv"
# -----------------------------------------


def download(url: str, dest: Path):
    if dest.exists():
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Descargando {dest.name} ...")
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    )
    with urllib.request.urlopen(req) as resp, open(dest, "wb") as out:
        out.write(resp.read())


def load_sentences(path: Path) -> dict[int, str]:
    """Lee un export per_language de Tatoeba: id \\t lang \\t texto."""
    result: dict[int, str] = {}
    with bz2.open(path, "rt", encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3:
                result[int(parts[0])] = parts[2]
    return result


def main():
    download(CMN_URL, CMN_FILE)
    download(ENG_URL, ENG_FILE)
    download(LINKS_URL, LINKS_FILE)

    print("Cargando frases en chino...")
    cmn = load_sentences(CMN_FILE)
    print(f"  {len(cmn)} frases cmn")

    print("Cargando frases en inglés...")
    eng = load_sentences(ENG_FILE)
    print(f"  {len(eng)} frases eng")

    print("Recorriendo enlaces y escribiendo pares...")
    n_pairs = 0
    with tarfile.open(LINKS_FILE, "r:bz2") as tar, \
            open(OUTPUT_CSV, "w", newline="", encoding="utf-8-sig") as out:
        writer = csv.writer(out, delimiter=";")
        writer.writerow(["phrase", "pinyin", "meaning", "count", "tokenization"])

        f = tar.extractfile(tar.getmember("links.csv"))
        for raw in f:
            a, _, b = raw.decode("utf-8").rstrip("\n").partition("\t")
            if not b:
                continue
            cmn_id = int(a)
            zh = cmn.get(cmn_id)
            if zh is None:
                continue  # el origen no es una frase china
            eng_id = int(b)
            en = eng.get(eng_id)
            if en is None:
                continue  # el destino no es una frase inglesa

            zh = _T2S.convert(normalize(zh))
            en = normalize(en)
            tokens = list(jieba.cut(zh))
            writer.writerow([
                zh, to_pinyin(tokens), en, count_hanzi(zh), " ".join(tokens),
            ])
            n_pairs += 1

    print(f"\nGuardado: {OUTPUT_CSV.name}")
    print(f"  Pares cn-en escritos: {n_pairs}")


if __name__ == "__main__":
    main()
