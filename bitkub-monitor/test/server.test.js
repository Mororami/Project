import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { createServer } from '../src/server.js';

const silent = { info() {}, warn() {}, error() {} };

async function withServer(options, fn) {
  const server = createServer({ log: silent, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('대시보드 서버: 페이지, 스냅샷, 상태 점검, 오류 응답', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bkm-pub-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title>');
  let snapshot = null;
  let health = { ok: false, status: {} };
  await withServer({ publicDir: dir, getSnapshot: () => snapshot, getHealth: () => health }, async (base) => {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);

    assert.equal((await fetch(`${base}/api/snapshot`)).status, 503);
    assert.equal((await fetch(`${base}/healthz`)).status, 503);

    snapshot = { rows: [], updatedAt: 1 };
    health = { ok: true, status: {} };
    const snap = await fetch(`${base}/api/snapshot`);
    assert.equal(snap.status, 200);
    assert.equal(snap.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await snap.json(), snapshot);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);

    assert.equal((await fetch(`${base}/nope`)).status, 404);
    const post = await fetch(`${base}/api/snapshot`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
  });
});

test('내부 오류는 경로 같은 세부 정보를 응답에 싣지 않는다', async () => {
  const errors = [];
  await withServer({ publicDir: '/nonexistent/dir', getSnapshot: () => null, log: { ...silent, error: (m) => errors.push(m) } }, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'Internal Error');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /nonexistent/);
  });
});

test('잘못된 URL은 400으로 응답하고 오류 로그를 남기지 않는다', async () => {
  const errors = [];
  await withServer({ publicDir: '/tmp', getSnapshot: () => null, log: { ...silent, error: (m) => errors.push(m) } }, async (base) => {
    const { port } = new URL(base);
    const res = await new Promise((resolve, reject) => {
      http.request({ host: '127.0.0.1', port, path: 'http://[::1', method: 'GET' }, resolve).on('error', reject).end();
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    res.resume();
    await new Promise((r) => res.on('end', r));
    assert.deepEqual(errors, []);
  });
});
