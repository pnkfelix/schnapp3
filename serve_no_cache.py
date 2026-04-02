#!/usr/bin/env python3
# Local dev server with no-cache headers.
# Run: python serve_no_cache.py
# Prevents Safari from aggressively caching ES modules.

from http.server import HTTPServer, SimpleHTTPRequestHandler

class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

HTTPServer(('', 8000), NoCacheHandler).serve_forever()
