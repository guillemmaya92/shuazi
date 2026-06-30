"""
generate_chars.py — Enriquece chars.xlsx con columnas para cada carácter chino:
    pinyin, meaning (inglés), radical, stroke (nº de trazos)

Fuentes de datos:
    - pinyin  -> pypinyin (lectura más común, con tono), igual que fill_pinyin.py
    - meaning -> makemeahanzi/dictionary.txt (definition)
    - radical -> makemeahanzi/dictionary.txt (radical Kangxi)
    - stroke  -> makemeahanzi/graphics.txt (len de la lista de trazos)

makemeahanzi se descarga una sola vez en memoria (dos ficheros), sin llamadas
por carácter ni límites de rate.

Requisitos:
    pip install pandas openpyxl pypinyin

Uso:
    python generate_chars.py
"""

import json
import os
import urllib.request
from pathlib import Path

import pandas as pd
from pypinyin import lazy_pinyin, Style

# --- Config -----------------------------------------------------------------

BASE_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
EXCEL_FILE = BASE_DIR / "chars.xlsx"
SHEET = "words"

DICTIONARY_URL = "https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt"
GRAPHICS_URL = "https://raw.githubusercontent.com/skishore/makemeahanzi/master/graphics.txt"

# Columnas que se añaden/sobrescriben (se respeta el esquema de la tabla `chars`)
NEW_COLUMNS = ["pinyin", "meaning", "radical", "stroke"]

# --- makemeahanzi -----------------------------------------------------------

def _download_jsonlines(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        for line in resp:
            line = line.strip()
            if line:
                yield json.loads(line)


def load_makemeahanzi():
    """Devuelve dos dicts indexados por carácter: info (meaning/radical) y strokes."""
    print(f"Descargando {DICTIONARY_URL} ...")
    info = {}
    for entry in _download_jsonlines(DICTIONARY_URL):
        info[entry["character"]] = entry

    print(f"Descargando {GRAPHICS_URL} ...")
    strokes = {}
    for entry in _download_jsonlines(GRAPHICS_URL):
        strokes[entry["character"]] = len(entry.get("strokes", []))

    print(f"  dictionary: {len(info)} caracteres | graphics: {len(strokes)} caracteres")
    return info, strokes


# --- Enriquecido por carácter ----------------------------------------------

def to_pinyin(char):
    return " ".join(lazy_pinyin(char, style=Style.TONE))


def clean_meaning(definition):
    """Limpia la definición de makemeahanzi (separadas por ';' o ',')."""
    if not definition:
        return ""
    # Primer sentido, recortado
    first = definition.split(";")[0].strip()
    return first


def enrich(char, info, strokes):
    entry = info.get(char, {})
    return {
        "pinyin": to_pinyin(char),
        "meaning": clean_meaning(entry.get("definition")),
        "radical": entry.get("radical", ""),
        "stroke": strokes.get(char, ""),
    }


# --- Main -------------------------------------------------------------------

def main():
    print(f"Leyendo {EXCEL_FILE} (pestaña: {SHEET}) ...")
    df = pd.read_excel(EXCEL_FILE, sheet_name=SHEET, dtype=str)

    # La primera columna contiene el hanzi (la cabecera puede venir mal etiquetada).
    char_col = df.columns[0]
    if char_col != "char":
        df = df.rename(columns={char_col: "char"})
    df["char"] = df["char"].astype(str).str.strip()

    info, strokes = load_makemeahanzi()

    rows = [enrich(c, info, strokes) for c in df["char"]]
    enriched = pd.DataFrame(rows, index=df.index)

    for col in NEW_COLUMNS:
        df[col] = enriched[col]

    # Reordena: char primero, luego las columnas nuevas, luego el resto
    ordered = ["char"] + NEW_COLUMNS + [c for c in df.columns if c not in (["char"] + NEW_COLUMNS)]
    df = df[ordered]

    missing = df.loc[df["radical"].eq("") & df["stroke"].eq(""), "char"].tolist()
    if missing:
        print(f"\n⚠ {len(missing)} caracteres no encontrados en makemeahanzi: {''.join(missing)}")

    with pd.ExcelWriter(EXCEL_FILE, engine="openpyxl", mode="a", if_sheet_exists="replace") as writer:
        df.to_excel(writer, sheet_name=SHEET, index=False)

    print(f"\nListo. {len(df)} caracteres enriquecidos en {EXCEL_FILE}")


if __name__ == "__main__":
    main()
