import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadDotEnv, parseConfig, parseSurgeRules } from '../src/config.js';

test('급등 규칙 해석', () => {
  const rules = parseSurgeRules('30m:7, 5m:3%, 1h:+10, 90s:1.5');
  assert.deepEqual(
    rules.map((r) => [r.windowMs, r.pct, r.label]),
    [
      [90_000, 1.5, '1분 30초'],
      [300_000, 3, '5분'],
      [1_800_000, 7, '30분'],
      [3_600_000, 10, '1시간'],
    ],
  );
  assert.throws(() => parseSurgeRules('5:3'), /형식 오류/);
  assert.throws(() => parseSurgeRules('5m:0'), /0보다 커야/);
});

test('기본값', () => {
  const c = parseConfig({});
  assert.equal(c.pollIntervalMs, 15_000);
  assert.deepEqual(c.surge.rules.map((r) => r.label), ['5분', '30분']);
  assert.deepEqual(c.fx.providers, ['naver', 'yahoo', 'erapi']);
  assert.equal(c.fx.fixedRate, null);
  assert.deepEqual(c.surge.watchlist, []);
  assert.equal(c.server.host, '127.0.0.1');
  assert.equal(c.server.port, 8080);
});

test('값 해석과 검증', () => {
  const c = parseConfig({
    TELEGRAM_CHAT_ID: '123, -100456',
    WATCHLIST: 'btc,eth',
    SURGE_RULES: 'off',
    FX_THB_KRW: '40.5',
    REPORT_INTERVAL_MIN: '0',
  });
  assert.deepEqual(c.telegram.chatIds, ['123', '-100456']);
  assert.deepEqual(c.surge.watchlist, ['BTC', 'ETH']);
  assert.deepEqual(c.surge.rules, []);
  assert.equal(c.fx.fixedRate, 40.5);
  assert.equal(c.report.intervalMin, 0);
  assert.throws(() => parseConfig({ POLL_INTERVAL_SEC: '1' }), /POLL_INTERVAL_SEC/);
  assert.throws(() => parseConfig({ FX_PROVIDERS: 'naver,google' }), /google/);
});

test('.env 로더는 주석과 따옴표를 처리하고 기존 값을 덮어쓰지 않는다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bkm-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, [
    '# 주석',
    'A=1',
    'B="hello world" # 설명',
    "C='x#y'",
    'D=   # 값 없음',
    'export E=5',
    'KEEP=new',
  ].join('\n'));
  const env = { KEEP: 'old' };
  assert.equal(loadDotEnv(file, env), true);
  assert.deepEqual(env, { KEEP: 'old', A: '1', B: 'hello world', C: 'x#y', D: '', E: '5' });
  assert.equal(loadDotEnv(path.join(dir, 'missing.env'), env), false);
});
