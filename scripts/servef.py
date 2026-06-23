"""
Servidor de desarrollo HTTPS para la PWA shuazi.

Sirve los archivos estaticos de /public con un certificado autofirmado,
para poder probar en contexto seguro (microfono, Service Worker, etc.)
tanto en localhost como desde el movil, en la misma red local.

Requisitos:
    pip install flask
"""

import os
import socket
import subprocess
import mimetypes

from flask import Flask, send_from_directory, abort

# --- Configuracion -------------------------------------------------------

BASE_DIR  = os.path.dirname(os.path.abspath(__file__))
DIRECTORY = os.path.abspath(os.path.join(BASE_DIR, '..', 'public'))
CERT_DIR  = os.path.join(BASE_DIR, '.certs')
CERT_FILE = os.path.join(CERT_DIR, 'cert.pem')
KEY_FILE  = os.path.join(CERT_DIR, 'key.pem')
PORT = 8000

# Fuerza los tipos MIME correctos en cualquier sistema (en Windows,
# por ejemplo, .js a veces se sirve como text/plain y rompe los
# modulos ES y el registro del Service Worker).
mimetypes.add_type('application/javascript', '.js')
mimetypes.add_type('application/javascript', '.mjs')
mimetypes.add_type('application/json', '.json')
mimetypes.add_type('text/css', '.css')
mimetypes.add_type('application/manifest+json', '.webmanifest')

# Archivos que el navegador NUNCA debe cachear: si no, el movil se
# queda pegado a una version vieja del Service Worker o el manifest
# y los cambios no se reflejan hasta limpiar cache a mano.
NO_CACHE_FILES = {'sw.js', 'service-worker.js', 'manifest.json', 'manifest.webmanifest'}

app = Flask(__name__, static_folder=None)


@app.route('/', defaults={'filename': ''})
@app.route('/<path:filename>')
def serve_static(filename):
    full_path = os.path.join(DIRECTORY, filename)

    # Si es un directorio (o la raiz), busca index.html dentro
    if filename == '' or os.path.isdir(full_path):
        filename = os.path.join(filename, 'index.html')
        full_path = os.path.join(DIRECTORY, filename)

    if not os.path.isfile(full_path):
        abort(404)

    # conditional=True (valor por defecto en send_from_directory) habilita
    # Range requests: imprescindible para que el audio TTS se pueda
    # reproducir/saltar sin tener que descargarlo entero primero.
    response = send_from_directory(DIRECTORY, filename)

    base = os.path.basename(filename)
    if base in NO_CACHE_FILES:
        response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        response.headers['Pragma'] = 'no-cache'

    return response


# --- Certificado autofirmado ----------------------------------------------

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    """Genera un certificado autofirmado (valido para localhost y la IP
    de la LAN) via openssl si todavia no existe. Devuelve True si al
    final hay certificado disponible."""
    if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
        return True
    os.makedirs(CERT_DIR, exist_ok=True)
    try:
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048',
            '-keyout', KEY_FILE, '-out', CERT_FILE,
            '-days', '365', '-nodes', '-subj', '/CN=shuazi',
            '-addext', f'subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost',
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


if __name__ == '__main__':
    ip = get_local_ip()
    https_ok = ensure_cert(ip)

    ssl_context = (CERT_FILE, KEY_FILE) if https_ok else None
    scheme = 'https' if https_ok else 'http'

    print("Servidor activo:")
    print(f"  Local:  {scheme}://localhost:{PORT}")
    print(f"  Movil:  {scheme}://{ip}:{PORT}")
    if https_ok:
        print("  (certificado autofirmado: acepta el aviso de seguridad en el movil una vez)")
    else:
        print("  (openssl no disponible -> sirviendo solo por HTTP; el microfono no funcionara en movil)")
    print("Ctrl+C para detener")

    app.run(host='0.0.0.0', port=PORT, ssl_context=ssl_context, threaded=True, debug=False)