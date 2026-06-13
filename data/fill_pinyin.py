"""
fill_pinyin.py — Rellena la columna 'pinyin' del Excel con pypinyin.
 
Uso:
    pip install pypinyin openpyxl pandas
    python fill_pinyin.py
"""
 
import pandas as pd
from pypinyin import lazy_pinyin, Style
 
INPUT_FILE  = r"C:\Users\guill\Desktop\Guillem\Github\shuazi\data\pinyin.xlsx"
OUTPUT_FILE = r"C:\Users\guill\Desktop\Guillem\Github\shuazi\data\pinyin.xlsx"
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