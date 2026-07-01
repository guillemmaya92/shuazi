#!/usr/bin/env python3
"""
add_meaning_es.py

Añade una columna 'meaning_es' (traducción al español de 'meaning') a un CSV
de caracteres chinos, usando OpenRouter con DeepSeek V4 Flash.

Uso:
    python add_meaning_es.py --input data.csv --output data_es.csv

Requisitos:
    pip install pandas requests

Variable de entorno requerida:
    OPENROUTER_API_KEY   (tu API key de openrouter.ai)

Características:
    - Traduce en lotes (batch_size configurable) para minimizar llamadas.
    - Pide a la API un JSON con {index, meaning_es} para evitar desalineación
      si el modelo se salta o reordena algún elemento.
    - Guarda checkpoint tras cada lote -> si se corta, puedes relanzar y
      solo se traduce lo que falte (usa --output como checkpoint).
    - Reintentos con backoff si falla una llamada o el JSON viene mal formado.
    - Deduplica: si el mismo 'char' aparece varias veces, se traduce una sola vez.
"""

import argparse
import json
import os
import sys
import time

import pandas as pd
import requests

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

# NOTA: verifica el slug exacto del modelo en https://openrouter.ai/models
# antes de correr el script; los nombres de modelo en OpenRouter cambian.
MODEL = "deepseek/deepseek-v4-flash"

SYSTEM_PROMPT = (
    "Eres un traductor experto de chino a español, especializado en "
    "diccionarios de caracteres (hanzi) y vocabulario HSK. "
    "Se te da una lista de entradas, cada una con un 'char' (carácter chino) "
    "y su 'meaning' en inglés (glosa de diccionario). "
    "Tu tarea es traducir cada 'meaning' al español, de forma natural y "
    "concisa, manteniendo el estilo de glosa de diccionario (separando "
    "acepciones con punto y coma si el original las separa así). "
    "NO traduzcas el carácter chino en sí, solo su significado. "
    "Responde EXCLUSIVAMENTE con un JSON válido: una lista de objetos "
    '[{"index": <int>, "meaning_es": "<string>"}, ...], '
    "un objeto por cada entrada recibida, en el mismo orden, sin texto "
    "adicional, sin markdown, sin explicaciones."
)


def build_batches(items, batch_size):
    for i in range(0, len(items), batch_size):
        yield items[i:i + batch_size]


def call_openrouter(batch, api_key, max_retries=4):
    """
    batch: lista de dicts [{"index": i, "char": ..., "meaning": ...}, ...]
    devuelve: dict {index: meaning_es}
    """
    user_payload = [
        {"index": item["index"], "char": item["char"], "meaning": item["meaning"]}
        for item in batch
    ]

    body = {
        "model": MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ],
        "temperature": 0.3,
        "max_tokens": 4000,
        # Ayuda a evitar que OpenRouter enrute a un provider que ignore
        # parámetros como temperature/max_tokens (mismo issue que en translate-zh).
        "provider": {"require_parameters": True},
    }

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    last_err = None
    for attempt in range(1, max_retries + 1):
        try:
            resp = requests.post(OPENROUTER_URL, headers=headers, json=body, timeout=90)
            resp.raise_for_status()
            data = resp.json()

            content = data["choices"][0]["message"]["content"]

            # Por si el modo "thinking" mete el contenido en otro campo
            # o el texto viene envuelto en ```json ... ```
            content = content.strip()
            if content.startswith("```"):
                content = content.strip("`")
                if content.lower().startswith("json"):
                    content = content[4:].strip()

            parsed = json.loads(content)

            result = {}
            for entry in parsed:
                result[int(entry["index"])] = entry["meaning_es"]
            return result

        except Exception as e:
            last_err = e
            wait = 2 ** attempt
            print(f"  [WARN] intento {attempt}/{max_retries} falló: {e}. "
                  f"Reintentando en {wait}s...", file=sys.stderr)
            time.sleep(wait)

    raise RuntimeError(f"No se pudo traducir el batch tras {max_retries} intentos: {last_err}")


def load_input(path):
    # Soporta Excel (.xlsx/.xls) o CSV/TSV, según la extensión del archivo.
    ext = os.path.splitext(path)[1].lower()

    if ext in (".xlsx", ".xls"):
        return pd.read_excel(path)

    # Detecta separador automáticamente (coma o tabulador)
    with open(path, "r", encoding="utf-8") as f:
        first_line = f.readline()
    sep = "\t" if "\t" in first_line else ","

    try:
        return pd.read_csv(path, sep=sep, encoding="utf-8")
    except pd.errors.ParserError:
        # El archivo tiene comas (o tabs) sueltos dentro del campo 'meaning'
        # sin comillas que los protejan, así que el parser estándar falla
        # al contar columnas. Fallback: nos fiamos del header para saber
        # cuántas columnas hay, y todo lo que sobre en la línea se queda
        # pegado a la última columna (normalmente 'meaning' o 'meaning_es').
        print("  [INFO] CSV con delimitadores sin comillas detectado, usando parseo manual...")
        with open(path, "r", encoding="utf-8") as f:
            lines = [line.rstrip("\n") for line in f if line.strip()]
        header = [c.strip() for c in lines[0].split(sep)]
        n = len(header)
        rows = []
        for line in lines[1:]:
            parts = line.split(sep, maxsplit=n - 1)
            while len(parts) < n:
                parts.append("")
            rows.append(parts[:n])
        return pd.DataFrame(rows, columns=header)


def main():
    # Valores por defecto: así puedes ejecutar el script directamente
    # (ej. desde el botón "Run" del editor, o con `python translation.py`)
    # sin tener que pasar argumentos por línea de comandos.
    # Se resuelven relativos a la carpeta donde está este script, no al
    # directorio desde el que lo lances (cwd), para que funcione igual
    # aunque lo ejecutes desde C:\Users\willy o desde donde sea.
    SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
    DEFAULT_INPUT = os.path.join(SCRIPT_DIR, "char_english.xlsx")
    DEFAULT_OUTPUT = os.path.join(SCRIPT_DIR, "char_english_es.csv")

    parser = argparse.ArgumentParser(description="Añade meaning_es a un CSV de hanzi vía OpenRouter/DeepSeek.")
    parser.add_argument("--input", default=DEFAULT_INPUT, help=f"CSV de entrada (default: {DEFAULT_INPUT})")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help=f"CSV de salida / checkpoint (default: {DEFAULT_OUTPUT})")
    parser.add_argument("--batch-size", type=int, default=15, help="Entradas por llamada a la API (default 15)")
    parser.add_argument("--sleep", type=float, default=0.5, help="Pausa entre llamadas en segundos (default 0.5)")
    args = parser.parse_args()

    print(f"Input:  {args.input}")
    print(f"Output: {args.output}")

    api_key = "yourapikey"
    if not api_key:
        print("ERROR: define la variable de entorno OPENROUTER_API_KEY", file=sys.stderr)
        sys.exit(1)

    df = load_input(args.input)

    if "char" not in df.columns or "meaning" not in df.columns:
        print(f"ERROR: el CSV debe tener columnas 'char' y 'meaning'. Columnas encontradas: {list(df.columns)}",
              file=sys.stderr)
        sys.exit(1)

    # Checkpoint: si ya existe output con meaning_es parcial, retomamos
    if os.path.exists(args.output):
        existing = load_input(args.output)
        if "meaning_es" in existing.columns:
            df["meaning_es"] = df["char"].map(
                dict(zip(existing["char"], existing["meaning_es"]))
            )
    if "meaning_es" not in df.columns:
        df["meaning_es"] = None

    # Deduplicar por 'char': traducimos una sola vez por carácter único
    pending_mask = df["meaning_es"].isna() | (df["meaning_es"].astype(str).str.strip() == "")
    unique_chars = df.loc[pending_mask, ["char", "meaning"]].drop_duplicates(subset=["char"])

    if unique_chars.empty:
        print("Nada que traducir, ya está completo.")
        df.to_csv(args.output, index=False, encoding="utf-8")
        return

    items = [
        {"index": i, "char": row["char"], "meaning": row["meaning"]}
        for i, row in enumerate(unique_chars.to_dict("records"))
    ]

    print(f"Traduciendo {len(items)} entradas únicas en lotes de {args.batch_size}...")

    translations = {}  # index -> meaning_es
    batches = list(build_batches(items, args.batch_size))

    for b_num, batch in enumerate(batches, 1):
        print(f"[Batch {b_num}/{len(batches)}] {len(batch)} entradas...")
        result = call_openrouter(batch, api_key)
        translations.update(result)

        # Aplicar traducciones obtenidas hasta ahora al DataFrame completo
        idx_to_char = {item["index"]: item["char"] for item in batch}
        char_to_es = {idx_to_char[i]: es for i, es in result.items() if i in idx_to_char}
        for char, es in char_to_es.items():
            df.loc[df["char"] == char, "meaning_es"] = es

        # Checkpoint incremental
        df.to_csv(args.output, index=False, encoding="utf-8")
        print(f"  -> checkpoint guardado en {args.output}")

        time.sleep(args.sleep)

    still_missing = df["meaning_es"].isna().sum()
    print(f"\nListo. {len(df) - still_missing}/{len(df)} filas traducidas.")
    if still_missing:
        print(f"  {still_missing} filas quedaron sin traducir; vuelve a correr el script para reintentarlas.")


if __name__ == "__main__":
    main()