import pandas as pd
import json
import os
from pathlib import Path

BASE_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
excel_file = BASE_DIR / 'data.xlsx'
output_file = BASE_DIR / '..' / '..' / 'public' / 'data' / 'words.json'

df = pd.read_excel(excel_file, sheet_name="words")

data = []
for _, row in df.iterrows():
    chars = []
    if pd.notna(row["chars"]):
        chars = [int(x.strip()) for x in str(row["chars"]).split(",") if x.strip()]

    item = {
        "id":      str(row["id"]),
        "pinyin":  str(row["pinyin"])  if pd.notna(row["pinyin"])  else "",
        "meaning": str(row["meaning"]) if pd.notna(row["meaning"]) else "",
        "group":   str(row["group"])   if pd.notna(row["group"])   else "",
        "chars":   chars
    }
    data.append(item)

with open(output_file, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"JSON saved to: {output_file.resolve()}")
print(f"Total records: {len(data)}")
