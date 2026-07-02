import http.server
import socketserver
import os

PORT = 8000

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Fallback headers for standard requests
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        # プリフライトリクエスト用
        self.send_response(200, "ok")
        self.end_headers()

    def send_head(self):
        # 動画のストリーミング再生（HTTP 206 Range リクエスト）をサポートするためのオーバーライド
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()
            
        ctype = self.guess_type(path)
        try:
            f = open(path, 'rb')
        except OSError:
            self.send_error(404, "File not found")
            return None

        range_header = self.headers.get('Range')
        if not range_header or not range_header.startswith('bytes='):
            return super().send_head()

        # Rangeリクエストを処理
        try:
            size = os.path.getsize(path)
            parts = range_header.split('=')[1].split('-')
            start = int(parts[0])
            end = int(parts[1]) if parts[1] else size - 1
            
            if start >= size:
                self.send_error(416, "Requested range not satisfiable")
                f.close()
                return None
            
            end = min(end, size - 1)
            length = end - start + 1
            
            self.send_response(206)
            self.send_header('Content-Type', ctype)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(length))
            # CORSヘッダーを206レスポンスにも明示的に適用
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', '*')
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.end_headers()
            
            # 指定位置までシーク
            f.seek(start)
            
            # 部分応答用のファイルラッパー
            class RangeFile:
                def __init__(self, file_obj, limit):
                    self.file_obj = file_obj
                    self.limit = limit
                    self.read_so_far = 0
                def read(self, size=-1):
                    if self.read_so_far >= self.limit:
                        return b''
                    to_read = self.limit - self.read_so_far
                    if size > 0:
                        to_read = min(to_read, size)
                    data = self.file_obj.read(to_read)
                    self.read_so_far += len(data)
                    return data
                def close(self):
                    self.file_obj.close()
            
            return RangeFile(f, length)
        except Exception as e:
            self.send_error(500, f"Internal server error: {e}")
            f.close()
            return None

def run_server():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), CORSRequestHandler) as httpd:
        print(f"\n=======================================================")
        print(f" skinslides Local HTTP Server (CORS & Range Requests Enabled)")
        print(f" Serving at: http://localhost:{PORT}/")
        print(f" Local Network IP: http://192.168.11.x:{PORT}/")
        print(f"=======================================================\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")

if __name__ == "__main__":
    run_server()
