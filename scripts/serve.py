import http.server
import socketserver
import socket
import os

DIRECTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
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

with socketserver.TCPServer(("0.0.0.0", PORT), Handler) as httpd:
    ip = get_local_ip()
    print(f"Servidor activo:")
    print(f"Local: http://localhost:{PORT}")
    print(f"En móvil: http://{ip}:{PORT}")
    print("Ctrl + C para parar el servidor")
    httpd.serve_forever()
