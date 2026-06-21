import http.server
import socketserver
import socket
import ssl
import os
import subprocess

DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
CERT_DIR  = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.certs')
CERT_FILE = os.path.join(CERT_DIR, 'cert.pem')
KEY_FILE  = os.path.join(CERT_DIR, 'key.pem')
PORT = 8000

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js':   'application/javascript',
        '.mjs':  'application/javascript',
        '.json': 'application/json',
        '.css':  'text/css',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

def get_local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

def ensure_cert(ip):
    """Generate a self-signed cert (valid for localhost and the LAN IP) via
    openssl if one doesn't already exist. Returns True on success."""
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

ip = get_local_ip()
https = ensure_cert(ip)

with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
    scheme = 'http'
    if https:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile=CERT_FILE, keyfile=KEY_FILE)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = 'https'

    print("Servidor activo:")
    print(f"Local: {scheme}://localhost:{PORT}")
    print(f"En movil: {scheme}://{ip}:{PORT}")
    if https:
        print("(certificado autofirmado: acepta el aviso de seguridad en el movil una vez)")
    else:
        print("(openssl no disponible -> sirviendo por HTTP; el microfono no funcionara en movil)")
    print("Ctrl + C para parar el servidor")
    httpd.serve_forever()
