#!/usr/bin/env python3
"""
Descarga complete-hsk-vocabulary (JSON) y lo exporta a CSV.
Una fila por cada 'form' (la mayoría de entradas tienen solo una).
"""

import csv
import json
import urllib.request

URL = "https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/refs/heads/main/complete.json"
OUTPUT = "hsk_vocabulary.csv"

SEP = "|"  # separador para listas (classifiers)
MEANINGS_SEP = ","  # separador para meanings

COLUMNS = ["simplified", "radical", "level", "frequency", "pos", "pinyin", "meanings", "count"]


MEANINGS_MAX_LEN = 120


def truncate_meanings(text: str, limit: int = MEANINGS_MAX_LEN) -> str:
    if len(text) <= limit:
        return text
    cut = text[:limit]
    last_sep = cut.rfind(MEANINGS_SEP)
    if last_sep == -1:
        return cut
    return cut[:last_sep]


def fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def flatten(entries):
    rows = []
    for e in entries:
        simplified = e.get("simplified", "")
        radical = e.get("radical", "")
        level_list = e.get("level", []) or []
        level_raw = level_list[0] if level_list else ""
        level = "".join(ch for ch in level_raw if ch.isdigit())
        frequency = e.get("frequency", "")
        pos_list = e.get("pos", []) or []
        pos = pos_list[0] if pos_list else ""

        forms = e.get("forms") or [{}]
        for f in forms:
            transcriptions = f.get("transcriptions", {}) or {}
            row = {
                "simplified": simplified,
                "traditional": f.get("traditional", ""),
                "radical": radical,
                "level": level,
                "frequency": frequency,
                "pos": pos,
                "pinyin": transcriptions.get("pinyin", ""),
                "numeric": transcriptions.get("numeric", ""),
                "wadegiles": transcriptions.get("wadegiles", ""),
                "bopomofo": transcriptions.get("bopomofo", ""),
                "romatzyh": transcriptions.get("romatzyh", ""),
                "meanings": truncate_meanings(MEANINGS_SEP.join(f.get("meanings", []) or [])),
                "classifiers": SEP.join(f.get("classifiers", []) or []),
            }
            rows.append(row)
    return rows


def dedupe_with_count(rows):
    from collections import Counter

    counts = Counter(r["simplified"] for r in rows)

    seen = set()
    result = []
    for r in rows:
        s = r["simplified"]
        if s in seen:
            continue
        seen.add(s)
        r["count"] = counts[s]
        result.append(r)
    return result


def main():
    print(f"Descargando {URL} ...")
    data = fetch_json(URL)
    print(f"{len(data)} entradas encontradas. Procesando...")

    rows = flatten(data)
    rows = dedupe_with_count(rows)

    with open(OUTPUT, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    print(f"Listo: {OUTPUT} ({len(rows)} filas)")


if __name__ == "__main__":
    main()