import os
import csv
import logging
import jieba
from pypinyin import pinyin, Style

jieba.setLogLevel(logging.WARNING)  # silencia el mensaje de "Building prefix dict..."

BASE_DIR = r"C:\Users\guill\Desktop\Guillem\Github\shuazi\scripts\data\etl\pinyin"
INPUT_CSV = os.path.join(BASE_DIR, "pinyin.csv")
OUTPUT_CSV = os.path.join(BASE_DIR, "pinyin_output.csv")

# Nombre de la columna del CSV de entrada que contiene el texto en chino.
# Cambia esto si tu columna se llama distinto (p.ej. "zh", "word", "sentence").
ZH_COLUMN = "zh"

# Style.TONE  -> marcas de tono: nǐ hǎo
# Style.TONE3 -> número de tono:  ni3 hao3
# Style.NORMAL-> sin tono:        ni hao
PINYIN_STYLE = Style.TONE


def to_pinyin(text):
    """Convierte una frase china a pinyin con cada sílaba separada por
    espacio (我们 -> wǒ men). La puntuación se descarta."""
    out = []
    for word in jieba.cut(text):
        syllables = pinyin(word, style=PINYIN_STYLE, heteronym=False, errors="default")
        for s in syllables:
            if s and any(c.isalnum() for c in s[0]):  # descarta 。，！？ etc.
                out.append(s[0])
    return " ".join(out)


def main():
    with open(INPUT_CSV, encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        if ZH_COLUMN not in fieldnames:
            raise ValueError(
                f"No se encontró la columna '{ZH_COLUMN}' en el CSV. "
                f"Columnas disponibles: {fieldnames}"
            )
        rows = list(reader)

    out_fieldnames = fieldnames + ["pinyin"]

    total_rows = 0
    for row in rows:
        zh = row.get(ZH_COLUMN, "") or ""
        row["pinyin"] = to_pinyin(zh)
        total_rows += 1

    with open(OUTPUT_CSV, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=out_fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Listo. {total_rows} filas procesadas.")
    print(f"Guardado en {OUTPUT_CSV}")


if __name__ == "__main__":
    main()