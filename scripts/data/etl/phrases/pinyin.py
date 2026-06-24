"""
Lee el JSON generado por generar_frases.py y añade el pinyin de cada frase china.
Las palabras de dos o más sílabas llevan su pinyin UNIDO (家人 -> jiārén),
usando jieba para segmentar la frase en palabras.

Requisitos:
    pip install pypinyin jieba

Entrada (sentences.json):
    {
      "爱": [
        {"zh": "我爱我的家人。", "en": "I love my family."},
        ...
      ],
      ...
    }

Salida (sentences_pinyin.json): igual, pero cada frase con un campo "pinyin":
    {
      "爱": [
        {"zh": "我爱我的家人。", "en": "I love my family.", "pinyin": "wǒ ài wǒ de jiārén"},
        ...
      ],
      ...
    }

Uso:
    python add_pinyin.py
"""

import os
import json
import logging
import jieba
from pypinyin import pinyin, Style

jieba.setLogLevel(logging.WARNING)  # silencia el mensaje de "Building prefix dict..."

BASE_DIR = r"C:\Users\guillem.maya\Desktop\test"
INPUT_JSON = os.path.join(BASE_DIR, "sentences.json")
OUTPUT_JSON = os.path.join(BASE_DIR, "sentences_pinyin.json")

# Style.TONE  -> marcas de tono: nǐ hǎo
# Style.TONE3 -> número de tono:  ni3 hao3
# Style.NORMAL-> sin tono:        ni hao
PINYIN_STYLE = Style.TONE


def to_pinyin(text):
    """Convierte una frase china a pinyin separado por palabras.
    Las sílabas de una misma palabra van unidas (家人 -> jiārén); las
    distintas palabras se separan con espacio. La puntuación se descarta."""
    out = []
    for word in jieba.cut(text):
        # pinyin por carácter dentro de la palabra
        syllables = pinyin(word, style=PINYIN_STYLE, heteronym=False, errors="default")
        joined = "".join(
            s[0] for s in syllables
            if s and any(c.isalnum() for c in s[0])  # descarta 。，！？ etc.
        )
        if joined:
            out.append(joined)
    return " ".join(out)


def main():
    with open(INPUT_JSON, encoding="utf-8") as f:
        data = json.load(f)

    total_words = 0
    total_sentences = 0

    for word, sentences in data.items():
        total_words += 1
        for s in sentences:
            zh = s.get("zh", "")
            s["pinyin"] = to_pinyin(zh)
            total_sentences += 1

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"Listo. {total_sentences} frases de {total_words} palabras con pinyin.")
    print(f"Guardado en {OUTPUT_JSON}")


if __name__ == "__main__":
    main()