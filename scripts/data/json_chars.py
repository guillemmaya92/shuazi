import pandas as pd
import json
import os
from pathlib import Path

BASE_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
excel_file = BASE_DIR / 'data.xlsx'
output_file = BASE_DIR / '..' / '..' / 'public' / 'data' / 'characters.json'

df = pd.read_excel(excel_file, sheet_name="chars")

data = []
for _, row in df.iterrows():
    item = {
        "id":         int(row["id"]),
        "productive": int(row["productive"]),
        "char":       str(row["char"]),
        "pinyin":     str(row["pinyin"]),
        "meaning":    str(row["meaning"]),
        "radical":    str(row["radical"]),
        "stroke":     int(row["stroke"]),
        "hsk":        int(row["hsk"]),
        "coverage":   round(float(row["coverage"]), 4),
        "frequency":    int(row["frequency"]),
    }
    data.append(item)

with open(output_file, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"JSON saved to: {output_file.resolve()}")
print(f"Total records: {len(data)}")
