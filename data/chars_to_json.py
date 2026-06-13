import pandas as pd
import json
from pathlib import Path

# Excel path
excel_file = r"C:\Users\guill\Desktop\Guillem\Github\shuazi\data\data.xlsx"

# Sheet name
df = pd.read_excel(excel_file, sheet_name="chars")

# JSON data list
data = []

for _, row in df.iterrows():
    item = {
        "id": int(row["id"]),
        "productive": int(row["productive"]),
        "char": str(row["char"]),
        "pinyin": str(row["pinyin"]),
        "meaning": str(row["meaning"]),
        "radical": str(row["radical"]),
        "stroke": int(row["stroke"]),
        "hsk": int(row["hsk"]),
        "coverage": round(float(row["coverage"]), 4),
        "appears": int(row["appears"]),
    }
    data.append(item)

# Save JSON to file
excel_path = Path(excel_file)
output_file = excel_path.parent / "chars.json"

with open(output_file, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"JSON saved to: {output_file}")
print(f"Total records: {len(data)}")