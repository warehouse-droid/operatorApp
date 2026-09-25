"""Loopback-only access to the isolated Docker review app (no production network)."""
import socket, socketserver, selectors
class Proxy(socketserver.BaseRequestHandler):
    def handle(self):
        with socket.create_connection(('172.29.0.3',3000),timeout=10) as upstream:
            upstream.settimeout(None)
            with selectors.DefaultSelector() as selector:
                selector.register(self.request,selectors.EVENT_READ,upstream)
                selector.register(upstream,selectors.EVENT_READ,self.request)
                while True:
                    for key,_ in selector.select(timeout=30):
                        data=key.fileobj.recv(65536)
                        if not data:return
                        key.data.sendall(data)
class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address=True
    daemon_threads=True
with Server(('127.0.0.1',39124),Proxy) as server:
    print('Isolated Special workflow review: http://127.0.0.1:39124',flush=True)
    server.serve_forever()
