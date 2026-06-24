"""
Genera 5 frases de ejemplo (chino + inglés) para cada palabra de un CSV,
usando DeepSeek vía OpenRouter.

Requisitos:
    pip install openai

Variables de entorno (recomendado, en vez de hardcodear la key):
    Windows (PowerShell):  $env:OPENROUTER_API_KEY="tu_api_key"
    Linux/Mac:             export OPENROUTER_API_KEY="tu_api_key"

CSV de entrada esperado:
    word,hsk
    爱,1
    学习,1
    ...
La columna "hsk" es opcional.

Uso:
    python generar_frases.py
"""

import os
import csv
import json
import re
import time
from openai import OpenAI

# --- Config -----------------------------------------------------------------

client = OpenAI(
    base_url="https://openrouter.ai/api/v1",
    api_key=os.environ["OPENROUTER_API_KEY"],
)

MODEL = "deepseek/deepseek-v4-flash"   # revisa el slug exacto en openrouter.ai/models
BATCH_SIZE = 10
MAX_RETRIES = 3
TEMPERATURE = 0.7
TARGET_SENTENCES = 5
MIN_LEN = 6                        # caracteres chinos mínimos (sin contar puntuación)
MAX_LEN = 18                       # caracteres chinos máximos

BASE_DIR = r"C:\Users\guillem.maya\Desktop\test"
INPUT_CSV = os.path.join(BASE_DIR, "data.csv")
OUTPUT_JSON = os.path.join(BASE_DIR, "sentences.json")
PROGRESS_FILE = os.path.join(BASE_DIR, "sentences_progress.json")

WORD_COLUMN_CANDIDATES = ["word", "palabra", "hanzi", "character", "汉字", "zh", "chinese"]
HSK_COLUMN_CANDIDATES = ["hsk", "hsk_level", "nivel", "level"]

# --- CSV --------------------------------------------------------------------

def detect_column(fieldnames, candidates):
    normalized = {f.strip().lower(): f for f in fieldnames}
    for c in candidates:
        if c in normalized:
            return normalized[c]
    return None


def load_words(path):
    words = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []

        word_col = detect_column(fieldnames, WORD_COLUMN_CANDIDATES)
        if word_col is None:
            raise ValueError(
                f"No encontré una columna de palabra en el CSV. "
                f"Columnas disponibles: {fieldnames}. "
                f"Agrega el nombre real a WORD_COLUMN_CANDIDATES."
            )

        hsk_col = detect_column(fieldnames, HSK_COLUMN_CANDIDATES)
        print(f"Usando columna de palabra: '{word_col}'"
              + (f", columna HSK: '{hsk_col}'" if hsk_col else " (sin columna HSK)"))

        for row in reader:
            word = row[word_col].strip()
            if not word:
                continue
            words.append({
                "word": word,
                "hsk": row[hsk_col].strip() if hsk_col else "",
            })
    return words


def chunked(lst, n):
    for i in range(0, len(lst), n):
        yield lst[i:i + n]

# --- Prompt -----------------------------------------------------------------

def build_prompt(batch):
    lines = []
    for w in batch:
        hsk_tag = f" (HSK {w['hsk']})" if w["hsk"] else ""
        lines.append(f"- {w['word']}{hsk_tag}")
    word_list = "\n".join(lines)

    return f"""You are a native Mandarin Chinese speaker creating example sentences for a language learner.

For each word below, write EXACTLY {TARGET_SENTENCES} example sentences in Mandarin Chinese.

Requirements for every sentence:
1. Use natural, modern spoken Mandarin Chinese as used in everyday conversations. Avoid formal, literary, or textbook-style phrasing unless the HSK level explicitly requires it.
2. Vary the length across the {TARGET_SENTENCES} sentences: include some SHORT ones (around {MIN_LEN}-9 characters) and some LONGER ones (around 12-{MAX_LEN} characters). Don't make them all the same length.
3. At least 1 or 2 of the sentences should include natural ways of connecting ideas or clauses (such as conjunctions, transitional words, or other linking structures commonly used in Chinese). The rest of the sentences can remain simple and straightforward.”
4. It must contain the target word EXACTLY as written - same characters, no synonyms, no different forms.
5. The {TARGET_SENTENCES} sentences for a given word should show it in different everyday contexts (not near-identical sentences).
6. If an HSK level is given for the word, match the grammar and vocabulary difficulty of the sentence to that level.

Words:
{word_list}

Respond with ONLY a valid JSON object - no extra text, no explanations, no markdown code fences. The format must be exactly:

{{
  "word1": [
    {{"zh": "...", "en": "..."}},
    {{"zh": "...", "en": "..."}},
    {{"zh": "...", "en": "..."}},
    {{"zh": "...", "en": "..."}},
    {{"zh": "...", "en": "..."}}
  ],
  "word2": [...]
}}
"""

# --- Modelo -----------------------------------------------------------------

def clean_json(text):
    text = text.strip()
    text = re.sub(r"^```json\s*|^```\s*|```$", "", text, flags=re.MULTILINE).strip()
    return text


def call_model(batch):
    prompt = build_prompt(batch)
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = client.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user", "content": prompt}],
                temperature=TEMPERATURE,
            )
            raw = resp.choices[0].message.content
            cleaned = clean_json(raw)
            return json.loads(cleaned)
        except Exception as e:
            last_err = e
            print(f"  intento {attempt} falló: {e}")
            time.sleep(2 * attempt)
    print(f"  batch falló tras {MAX_RETRIES} intentos: {last_err}")
    return None

# --- Validación -------------------------------------------------------------

_CJK_RE = re.compile(r"[\u4e00-\u9fff]")

def cjk_length(text):
    return len(_CJK_RE.findall(text))


def validate_entry(word, sentences):
    """Descarta solo frases incompletas o que no contengan la palabra exacta.
    La longitud (MIN_LEN-MAX_LEN) es solo una preferencia que se pide en el
    prompt; si la frase contiene la palabra, se acepta aunque no la cumpla."""
    valid = []
    for s in sentences or []:
        zh = (s.get("zh") or "").strip()
        en = (s.get("en") or "").strip()
        if not zh or not en:
            continue
        if word not in zh:
            continue
        valid.append({"zh": zh, "en": en})
    return valid

# --- Persistencia -----------------------------------------------------------

def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_progress(results):
    with open(PROGRESS_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

# --- Main -------------------------------------------------------------------

def main():
    words = load_words(INPUT_CSV)
    results = load_progress()
    done_words = set(results.keys())
    pending = [w for w in words if w["word"] not in done_words]

    print(f"Total: {len(words)} | Ya procesadas: {len(done_words)} | Pendientes: {len(pending)}")

    failed_words = []

    for i, batch in enumerate(chunked(pending, BATCH_SIZE), start=1):
        print(f"Batch {i} ({len(batch)} palabras)...")
        data = call_model(batch)

        if data is None:
            failed_words.extend(w["word"] for w in batch)
            continue

        for w in batch:
            word = w["word"]
            sentences = data.get(word, [])
            valid = validate_entry(word, sentences)

            if len(valid) < TARGET_SENTENCES:
                print(f"  ⚠ '{word}': solo {len(valid)}/{TARGET_SENTENCES} frases válidas")
            if not valid:
                failed_words.append(word)
                continue

            results[word] = valid

        save_progress(results)

    if failed_words:
        print(f"\n{len(failed_words)} palabras fallaron, reintentando individualmente...")
        retry_targets = [w for w in words if w["word"] in failed_words]
        for w in retry_targets:
            data = call_model([w])
            if data:
                valid = validate_entry(w["word"], data.get(w["word"], []))
                if valid:
                    results[w["word"]] = valid
                    save_progress(results)
                else:
                    print(f"  ✗ '{w['word']}' sigue sin frases válidas")

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    print(f"\nListo. {len(results)}/{len(words)} palabras con frases guardadas en {OUTPUT_JSON}")


if __name__ == "__main__":
    main()