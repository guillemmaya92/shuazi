"""
Genera y guarda en Supabase el audio de los textos (lector de "Texto").

Para cada texto:
  1. Lo divide en frases con las MISMAS reglas que el lector
     (public/js/texts.js: paragraphsOf / sentencesOf / startListen), detecta el
     personaje de cada línea ("玛丽：…") y le asigna su voz fija.
  2. Por cada frase, asegura que existe el clip en Storage:
        tts/v1/<sha256(voz|velocidad|texto)>.mp3
     Si falta, lo sintetiza con la Edge Function `tts` y lo sube.
  3. Sube el manifiesto tts/texts/<id>.json  (frase -> clip).
  4. Guarda su URL pública en texts.audio_url.

El lector descarga el manifiesto y los clips directamente: no llama a ninguna
API mientras los clips existan.

Requisitos: solo la biblioteca estándar de Python 3.
Antes, una vez: ejecuta scripts/supabase_tts_cache.sql (crea el bucket `tts`).

Uso (PowerShell):
    $env:SUPABASE_SERVICE_ROLE_KEY = "<service_role key>"
    python scripts/build_text_audio.py --dry-run        # solo muestra qué haría
    python scripts/build_text_audio.py                  # todos los textos
    python scripts/build_text_audio.py --ids 1,2,26     # solo algunos
    python scripts/build_text_audio.py --force          # re-sintetiza los clips

IMPORTANTE: SPEAKER_VOICES, LISTEN_RATE y DEFAULT_VOICE deben coincidir con
public/js/texts.js (y DEFAULT_VOICE con supabase/functions/tts.js). Si cambias
una voz o editas un texto, vuelve a ejecutar este script: solo genera lo nuevo.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── Must match public/js/texts.js ─────────────────────────────────────────────
LISTEN_RATE = 0.75
DEFAULT_VOICE = "cmn-CN-Wavenet-A"   # also the Edge Function's default
V = {
    "WA": "cmn-CN-Wavenet-A", "WB": "cmn-CN-Wavenet-B",
    "WC": "cmn-CN-Wavenet-C", "WD": "cmn-CN-Wavenet-D",
    "SA": "cmn-CN-Standard-A", "SB": "cmn-CN-Standard-B",
    "SC": "cmn-CN-Standard-C", "SD": "cmn-CN-Standard-D",
}
SPEAKER_VOICES = {
    "玛丽": V["WA"], "张红": V["WD"], "大卫": V["WB"], "李军": V["WC"],
    "中村": V["SB"],
    "刘老师": V["SA"], "老师": V["SA"], "王老师": V["SD"],
    "安娜": V["SD"], "妈妈": V["SA"], "售货员": V["SD"],
    "警察": V["SC"], "画家": V["SC"], "工作人员": V["SC"], "工人": V["SB"],
    "学生": V["SC"], "学生A": V["SD"], "学生B": V["SC"], "同学": V["SC"],
}
ZH_END = set("。！？!?…")
CLOSERS = set("”’」』）)》]\"'")
SEP = "|"
HAN_RE = re.compile(r"[\u3400-\u9fff\uf900-\ufaff\U00020000-\U0003134f]")
CJK_RE = re.compile(r"[\u3400-\u9fff]")   # the reader's "has Chinese" test
PARA_SPLIT = re.compile(r"(?:\r?\n|\\n|\u2028|\u2029)+")


def js_number(x):
    """Formats a number like JavaScript's String(n): 0.75 -> '0.75', 1 -> '1'."""
    return format(x, "g")


def clip_path(voice, rate, text):
    """Must match cachePath() in public/js/translator.js."""
    r = min(2.0, max(0.5, float(rate) if rate else 0.9))
    key = f"{voice or DEFAULT_VOICE}|{js_number(r)}|{text}"
    return "v1/" + hashlib.sha256(key.encode("utf-8")).hexdigest() + ".mp3"


def paragraphs_of(s):
    return [p.strip() for p in PARA_SPLIT.split(str(s or "")) if p.strip()]


def sentences_of(paragraph):
    """Char-level version of sentencesOf(): boundaries only depend on punctuation."""
    chars = list(paragraph.replace(SEP, "")) if SEP in paragraph else list(paragraph)
    out, cur, ended = [], [], False
    for ch in chars:
        if ended and ch not in CLOSERS and ch not in ZH_END:
            out.append(cur)
            cur, ended = [], False
        cur.append(ch)
        if ch in ZH_END:
            ended = True
    if cur:
        out.append(cur)
    return out


def build_lines(text, extra_speakers=None):
    """Mirror of the line building in startListen() (texts.js).

    `extra_speakers` ({name: voice}) are speakers outside SPEAKER_VOICES that the app's
    `text-audio` function chose for a text; they come from that text's manifest.
    """
    extra_speakers = extra_speakers or {}
    voice_of = lambda label: SPEAKER_VOICES.get(label) or extra_speakers.get(label)
    lines, voice = [], None
    for pi, p in enumerate(paragraphs_of(text)):
        for si, s in enumerate(sentences_of(p)):
            skip = 0
            if si == 0:
                if s and s[0] in "（(":
                    close = next((i for i in range(1, len(s)) if s[i] in "）)"), -1)
                    if close > 0:
                        skip = close + 1
                colon = next((i for i in range(skip, len(s)) if s[i] in "：:"), -1)
                label = "".join(s[skip:colon]).strip() if colon > skip else ""
                says = colon >= 0 and any(HAN_RE.match(c) for c in s[colon + 1:])
                if label and voice_of(label) and says:
                    voice = voice_of(label)
                    skip = colon + 1
            line = re.sub(r"\s+", "", "".join(s[skip:])).strip()
            if not CJK_RE.search(line):
                continue
            lines.append({"p": pi, "s": si, "voice": voice or DEFAULT_VOICE, "text": line})
    return lines


# ── HTTP helpers ──────────────────────────────────────────────────────────────
def http(method, url, headers=None, body=None, timeout=60):
    req = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def read_supa_url():
    url = os.environ.get("SUPABASE_URL")
    if url:
        return url.rstrip("/")
    with open(os.path.join(ROOT, "public", "js", "config.js"), encoding="utf-8") as f:
        m = re.search(r"SUPA_URL\s*=\s*'([^']+)'", f.read())
    if not m:
        sys.exit("No encuentro SUPA_URL en public/js/config.js; define SUPABASE_URL.")
    return m.group(1).rstrip("/")


def main():
    ap = argparse.ArgumentParser(description="Genera el audio de los textos en Supabase.")
    ap.add_argument("--ids", help="ids separados por comas (por defecto, todos)")
    ap.add_argument("--dry-run", action="store_true", help="no sube ni modifica nada")
    ap.add_argument("--force", action="store_true", help="vuelve a sintetizar clips existentes")
    args = ap.parse_args()

    supa = read_supa_url()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not key:
        sys.exit("Define SUPABASE_SERVICE_ROLE_KEY (Project Settings > API > service_role).")
    auth = {"apikey": key, "Authorization": f"Bearer {key}"}
    public = f"{supa}/storage/v1/object/public/tts/"

    q = "select=id,title,text&order=id"
    if args.ids:
        ids = ",".join(str(int(x)) for x in args.ids.split(",") if x.strip())
        q += f"&id=in.({ids})"
    st, body = http("GET", f"{supa}/rest/v1/texts?{q}", auth)
    if st != 200:
        sys.exit(f"No se pudieron leer los textos ({st}): {body[:300]!r}")
    texts = json.loads(body)
    print(f"{len(texts)} textos{' (dry-run)' if args.dry_run else ''}\n")

    made = reused = failed = 0
    for t in texts:
        # Keep the voices the app already chose for speakers outside the fixed cast.
        st, prev = http("GET", f"{public}texts/{t['id']}.json", timeout=30)
        try:
            extra = (json.loads(prev).get("speakers") or {}) if st == 200 else {}
        except (ValueError, AttributeError):
            extra = {}
        lines = build_lines(t.get("text") or "", extra)
        if not lines:
            print(f"[{t['id']}] {t['title']}: sin frases, se omite")
            continue
        new_here = 0
        for ln in lines:
            ln["path"] = clip_path(ln["voice"], LISTEN_RATE, ln["text"])
            exists = False
            if not args.force:
                st, _ = http("HEAD", public + ln["path"], timeout=30)
                exists = st == 200
            if exists:
                reused += 1
                continue
            if args.dry_run:
                new_here += 1
                continue
            # Synthesize through the Edge Function (keeps the Google key server-side).
            st, res = http("POST", f"{supa}/functions/v1/tts",
                           {**auth, "Content-Type": "application/json"},
                           json.dumps({"text": ln["text"], "voice": ln["voice"],
                                       "rate": LISTEN_RATE}).encode("utf-8"), timeout=90)
            data = json.loads(res or b"{}") if st == 200 else {}
            if not data.get("audio"):
                failed += 1
                print(f"  ! [{t['id']}] p{ln['p']}s{ln['s']} TTS {st}: {res[:200]!r}")
                continue
            mp3 = base64.b64decode(data["audio"])
            st, res = http("POST", f"{supa}/storage/v1/object/tts/{ln['path']}",
                           {**auth, "Content-Type": "audio/mpeg", "x-upsert": "true",
                            "Cache-Control": "max-age=31536000"}, mp3)
            if st not in (200, 201):
                failed += 1
                print(f"  ! [{t['id']}] subida del clip {st}: {res[:200]!r}")
                continue
            new_here += 1
            time.sleep(0.15)   # be gentle with the TTS quota
        made += new_here

        manifest = {
            "version": 1,
            "text_id": t["id"],
            "rate": LISTEN_RATE,
            **({"speakers": extra} if extra else {}),
            "lines": [{k: ln[k] for k in ("p", "s", "voice", "text", "path")} for ln in lines],
        }
        raw = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        ver = hashlib.sha256(raw).hexdigest()[:12]
        audio_url = f"{public}texts/{t['id']}.json?v={ver}"
        voices = sorted({ln["voice"].replace("cmn-CN-", "") for ln in lines})
        print(f"[{t['id']}] {t['title']}: {len(lines)} frases, {new_here} nuevas, voces {', '.join(voices)}")
        if args.dry_run:
            continue

        st, res = http("POST", f"{supa}/storage/v1/object/tts/texts/{t['id']}.json",
                       {**auth, "Content-Type": "application/json", "x-upsert": "true",
                        "Cache-Control": "no-cache"}, raw)
        if st not in (200, 201):
            failed += 1
            print(f"  ! manifiesto {st}: {res[:200]!r}")
            continue
        st, res = http("PATCH", f"{supa}/rest/v1/texts?id=eq.{t['id']}",
                       {**auth, "Content-Type": "application/json", "Prefer": "return=minimal"},
                       json.dumps({"audio_url": audio_url}).encode("utf-8"))
        if st not in (200, 204):
            failed += 1
            print(f"  ! audio_url {st}: {res[:200]!r}")

    print(f"\nClips nuevos: {made} · reutilizados: {reused} · errores: {failed}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
