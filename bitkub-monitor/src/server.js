import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data), { 'cache-control': 'no-store' });
}

/** 대시보드 페이지와 스냅샷 API를 제공하는 HTTP 서버 */
export function createServer({ getSnapshot, publicDir }) {
  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { allow: 'GET, HEAD' });
      }
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/' || pathname === '/index.html') {
        const html = await readFile(path.join(publicDir, 'index.html'));
        return send(res, 200, 'text/html; charset=utf-8', html, { 'cache-control': 'no-cache' });
      }
      if (pathname === '/api/snapshot') {
        const snapshot = getSnapshot();
        return snapshot ? sendJson(res, 200, snapshot) : sendJson(res, 503, { error: '첫 시세를 수집하는 중입니다' });
      }
      if (pathname === '/healthz') return sendJson(res, 200, { ok: true });
      return send(res, 404, 'text/plain; charset=utf-8', 'Not Found');
    } catch (err) {
      return send(res, 500, 'text/plain; charset=utf-8', `Internal Error: ${err.message}`);
    }
  });
}
