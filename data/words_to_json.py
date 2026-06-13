import pandas as pd
import json
from pathlib import Path

# Excel path
excel_file = r"C:\Users\guill\Desktop\Guillem\Github\shuazi\data\data.xlsx"

# Leer hoja
df = pd.read_excel(excel_file, sheet_name="words")

data = []

for _, row in df.iterrows():

    # Convertir "2, 42" -> [2, 42]
    chars = []
    if pd.notna(row["chars"]):
        chars = [
            int(x.strip())
            for x in str(row["chars"]).split(",")
            if x.strip()
        ]

    item = {
        "id": str(row["id"]),
        "pinyin": str(row["pinyin"]) if pd.notna(row["pinyin"]) else "",
        "meaning": str(row["meaning"]) if pd.notna(row["meaning"]) else "",
        "group": str(row["group"]) if pd.notna(row["group"]) else "",
        "chars": chars
    }

    data.append(item)

# Guardar JSON
excel_path = Path(excel_file)
output_file = excel_path.parent / "words.json"

with open(output_file, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print(f"JSON saved to: {output_file}")
print(f"Total records: {len(data)}")