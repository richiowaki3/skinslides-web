import http.server
import socketserver
import os

PORT = 8000

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # CORS 許可ヘッダーを追加
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        # プリフライトリクエスト用
        self.send_response(200, "ok")
        self.end_headers()

def run_server():
    # 二重起動を避けるため、再利用可能なポート設定を有効化
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), CORSRequestHandler) as httpd:
        print(f"\n=======================================================")
        print(f" skinslides Local HTTP Server (CORS Enabled)")
        print(f" Serving at: http://localhost:{PORT}/")
        print(f" Local Network IP: http://192.168.11.x:{PORT}/")
        print(f"=======================================================\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")

if __name__ == "__main__":
    run_server()
