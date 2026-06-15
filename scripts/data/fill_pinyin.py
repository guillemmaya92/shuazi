"""
fill_pinyin.py — Rellena la columna 'pinyin' del Excel con pypinyin.

Uso:
    pip install pypinyin openpyxl pandas
    python fill_pinyin.py
"""

import pandas as pd
import os
from pathlib import Path
from pypinyin import lazy_pinyin, Style

BASE_DIR    = Path(os.path.dirname(os.path.abspath(__file__)))
INPUT_FILE  = BASE_DIR / 'pinyin.xlsx'
OUTPUT_FILE = INPUT_FILE
SHEET       = "words"


def to_pinyin(text: str) -> str:
    return " ".join(lazy_pinyin(str(text), style=Style.TONE))


def main():
    print(f"Leyendo {INPUT_FILE} (pestaña: {SHEET})...")
    df = pd.read_excel(INPUT_FILE, sheet_name=SHEET, dtype=str)

    mask = df["pinyin"].isna() | (df["pinyin"].str.strip() == "")
    total = mask.sum()
    print(f"Rellenando {total} filas...")

    df.loc[mask, "pinyin"] = df.loc[mask, "id"].map(to_pinyin)

    with pd.ExcelWriter(OUTPUT_FILE, engine="openpyxl", mode="a", if_sheet_exists="replace") as writer:
        df.to_excel(writer, sheet_name=SHEET, index=False)

    print(f"Listo. Fichero guardado: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
