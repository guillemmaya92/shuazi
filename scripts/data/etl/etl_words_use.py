"""
Descarga internet-zh.num del repo ernop/anki-chinese-word-frequency
y lo convierte a un CSV con columnas: rank, permillion, word.

Formato del archivo original (confirmado en add_frequency_info.py del repo):
    cada línea = "<rango> <frecuencia_por_millon> <palabra_hanzi>"
"""

import csv
import os
import sys
import urllib.request

RAW_URL = "https://raw.githubusercontent.com/ernop/anki-chinese-word-frequency/master/internet-zh.num"

# Carpeta donde está este script (no el directorio desde donde se ejecuta)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_CSV = os.path.join(SCRIPT_DIR, "internet-zh.csv")


def descargar_texto(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req) as resp:
        return resp.read().decode("utf-8")


def parsear_lineas(texto: str):
    filas = []
    for num_linea, linea in enumerate(texto.splitlines(), start=1):
        linea = linea.strip()
        if not linea:
            continue
        partes = linea.split(maxsplit=2)
        if len(partes) != 3:
            print(f"[aviso] línea {num_linea} con formato inesperado, se omite: {linea!r}")
            continue
        rank, permillion, word = partes
        filas.append((rank, permillion, word))
    return filas


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else RAW_URL
    salida = sys.argv[2] if len(sys.argv) > 2 else OUTPUT_CSV

    print(f"Descargando {url} ...")
    texto = descargar_texto(url)

    print("Parseando líneas...")
    filas = parsear_lineas(texto)
    print(f"Total de palabras parseadas: {len(filas)}")

    print(f"Escribiendo {salida} ...")
    # utf-8-sig para que Excel detecte bien los caracteres chinos
    with open(salida, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(["rank", "permillion", "word"])
        writer.writerows(filas)

    print("Listo.")


if __name__ == "__main__":
    main()