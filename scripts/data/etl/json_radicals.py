import pandas as pd
import json
import os
from pathlib import Path
 
BASE_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
excel_file = BASE_DIR / 'data.xlsx'
output_file = BASE_DIR / '..' / '..' / 'public' / 'data' / 'radicals.json'
 
df = pd.read_excel(excel_file, sheet_name="radicals")
 
data = []
for _, row in df.iterrows():
    item = {
        "id":          str(int(row["id"])) if pd.notna(row["id"]) else "",
        "radical":     str(row["radical"])     if pd.notna(row["radical"])     else "",
        "traditional": str(row["traditional"]) if pd.notna(row["traditional"]) else "",
        "meaning":     str(row["meaning"])     if pd.notna(row["meaning"])     else "",
        "pinyin":      str(row["pinyin"])      if pd.notna(row["pinyin"])      else "",
        "stroke":      str(int(row["stroke"])) if pd.notna(row["stroke"])      else "",
        "productive":   str(int(row["productive"])) if pd.notna(row["productive"]) else "",
        "coverage":   str(int(row["coverage"])) if pd.notna(row["coverage"]) else "",
    }
    data.append(item)
 
output_file.parent.mkdir(parents=True, exist_ok=True)
 
with open(output_file, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
 
print(f"JSON saved to: {output_file.resolve()}")
print(f"Total records: {len(data)}")