import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { Monitor } from '../src/monitor.js';

const silent = { info() {}, warn() {}, error() {} };

function setup(env = {}) {
  const prices = { bitkub: { BTC: 2_500_000, ETH: 80_000 }, volume: { BTC: 1e9, ETH: 1e9 }, book: {}, fail: {}, requested: [] };
  const sources = {
    async bitkubSymbols() {
      if (prices.fail.bitkubSymbols) throw new Error('symbols down');
      return new Map([['BTC', { name: 'Bitcoin' }], ['ETH', { name: 'Ethereum' }]]);
    },
    async bithumbMarkets() {
      return new Map([['BTC', { nameKo: '비트코인', nameEn: 'Bitcoin', warning: null }], ['ETH', { nameKo: '이더리움', nameEn: 'Ethereum', warning: null }]]);
    },
    async bitkubTickers() {
      if (prices.fail.bitkub) throw new Error('bitkub down');
      // 호가는 기본적으로 체결가를 중심으로 대칭이라 중간값 = 체결가다.
      return new Map(Object.entries(prices.bitkub).map(([b, last]) => [b, { last, bid: prices.book[b]?.bid ?? last - 100, ask: prices.book[b]?.ask ?? last + 100, changePct: 0, volumeThb: prices.volume[b] ?? 1e9 }]));
    },
    async bithumbTickers(bases, { onSkip } = {}) {
      if (prices.fail.bithumb) throw new Error('bithumb down');
      prices.requested.push([...bases]);
      // ETH는 Bithumb가 시세를 거절하는 마켓으로 둔다.
      if (bases.includes('ETH')) onSkip?.('KRW-ETH', 'Code not found');
      return new Map([['BTC', { last: 101_000_000, changePct: 0, volumeKrw: 1e10 }]]);
    },
    async thbKrw() {
      if (prices.fail.fx) throw new Error('fx down');
      return { rate: 40, at: 0, source: 'test', sourceLabel: 'test' };
    },
  };
  const sent = [];
  const telegram = { enabled: true, async send(html) { if (prices.fail.telegram) throw new Error('chat not found'); sent.push(html); } };
  const config = parseConfig({ SURGE_RULES: '5m:3', REPORT_SYMBOLS: 'BTC,ETH', ...env });
  const monitor = new Monitor(config, { telegram, sources, log: silent });
  return { monitor, prices, sent };
}

test('첫 수집으로 스냅샷을 만들고 공통 코인만 비교한다', async () => {
  const { monitor } = setup();
  await monitor.prime();
  const snap = monitor.publicSnapshot();
  assert.deepEqual(snap.rows.map((r) => r.base), ['BTC']);
  assert.ok(Math.abs(snap.rows[0].premiumPct - 1) < 1e-9);
  assert.equal(snap.status.bitkub.ok, true);
  assert.deepEqual(snap.options.surgeRules, ['5분 +3%']);
});

test('급등을 감지하면 Telegram으로 보내고 최근 알림에 남긴다', async () => {
  const { monitor, prices, sent } = setup();
  await monitor.prime();
  prices.bitkub.ETH = 83_000; // +3.75%
  await monitor.tick();
  await monitor.flushNotifications();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /<b>ETH<\/b> Ethereum/);
  assert.match(sent[0], /5분 저점 대비 <b>\+3\.75%<\/b>/);
  assert.equal(monitor.recentAlerts[0].base, 'ETH');
  assert.equal(monitor.recentAlerts[0].priceKrw, 83_000 * 40);

  // 대기 시간 안에서 추가 상승이 없으면 다시 보내지 않는다.
  await monitor.tick();
  await monitor.flushNotifications();
  assert.equal(sent.length, 1);
  assert.equal(monitor.status.telegram.ok, true);
});

test('WATCHLIST에 없는 코인과 거래대금이 적은 코인은 알리지 않는다', async () => {
  const { monitor, prices, sent } = setup({ WATCHLIST: 'BTC' });
  await monitor.prime();
  prices.bitkub.ETH = 90_000;
  await monitor.tick();
  await monitor.flushNotifications();
  assert.equal(sent.length, 0);

  const low = setup({ SURGE_MIN_VOLUME_THB: '2000000000' });
  await low.monitor.prime();
  low.prices.bitkub.BTC = 2_700_000;
  await low.monitor.tick();
  await low.monitor.flushNotifications();
  assert.equal(low.sent.length, 0);
});

test('소스 하나가 실패해도 마지막 데이터로 계속 보여주고 상태에 오류를 남긴다', async () => {
  const { monitor, prices } = setup();
  await monitor.prime();
  prices.fail.bithumb = true;
  prices.bitkub.BTC = 2_525_000;
  await monitor.tick();
  const snap = monitor.publicSnapshot();
  assert.equal(snap.status.bithumb.ok, false);
  assert.equal(snap.status.bithumb.error, 'bithumb down');
  assert.ok(snap.status.bithumb.lastOkAt > 0);
  // Bithumb는 이전 가격, Bitkub는 새 가격으로 계산한다.
  assert.equal(snap.rows[0].bithumb.last, 101_000_000);
  assert.equal(snap.rows[0].bitkub.last, 2_525_000);

  prices.fail.bithumb = false;
  await monitor.tick();
  assert.equal(monitor.publicSnapshot().status.bithumb.ok, true);
});

test('정기 시세는 지정한 코인을 담아 보낸다', async () => {
  const { monitor, sent } = setup();
  await monitor.prime();
  await monitor.sendReport();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /<b>BTC<\/b> 비트코인 ฿2,500,000 ≈ ₩100,000,000/);
  assert.match(sent[0], /<b>ETH<\/b> Ethereum ฿80,000 ≈ ₩3,200,000/);
});

test('Bithumb가 거절한 마켓은 다음 목록 갱신까지 요청에서 뺀다', async () => {
  const { monitor, prices } = setup();
  await monitor.prime();
  assert.deepEqual(prices.requested, [['BTC', 'ETH']]);
  assert.deepEqual([...monitor.bithumbSkipped], ['ETH']);
  await monitor.tick();
  assert.deepEqual(prices.requested[1], ['BTC']);
  // 주기 안의 목록 재시도는 거절 목록을 지우지 않는다. 정기(1시간) 갱신만 지운다.
  await monitor.refreshMeta({ resetSkipped: false });
  assert.deepEqual([...monitor.bithumbSkipped], ['ETH']);
  await monitor.refreshMeta();
  await monitor.tick();
  assert.deepEqual(prices.requested[2], ['BTC', 'ETH']);
});

test('시세 갱신이 실패하면 스냅샷 시각이 멈추고 메시지에 언제 값인지 붙는다', async () => {
  const { monitor, prices, sent } = setup();
  await monitor.prime();
  const okAt = monitor.publicSnapshot().updatedAt;
  prices.fail.bithumb = true;
  prices.fail.fx = true;
  await monitor.refreshFx();
  prices.bitkub.BTC = 2_600_000; // +4%
  await monitor.tick();
  await monitor.flushNotifications();
  const snap = monitor.publicSnapshot();
  assert.equal(snap.updatedAt, okAt, 'Bithumb가 실패한 주기에는 갱신 시각을 당기지 않는다');
  assert.ok(snap.serverNow >= okAt);
  assert.equal(snap.status.fx.ok, false);
  assert.match(sent[0], /빗썸 ₩101,000,000 · 김프 -2\.88% \(갱신 실패, \d+초 전 값\)/);
  assert.match(sent[0], /환율 1 THB = 40\.00 KRW \(test\) \(갱신 실패, \d+초 전 값\)/);
  await monitor.sendReport();
  assert.match(sent[1], /\(갱신 실패, \d+초 전 값\)/);
  assert.equal(monitor.health().ok, true, 'Bitkub 시세는 정상이다');

  prices.fail.bithumb = false;
  prices.fail.fx = false;
  await monitor.refreshFx();
  await new Promise((r) => setTimeout(r, 5)); // Date.now()가 반드시 앞으로 가도록
  await monitor.tick();
  await monitor.sendReport();
  assert.doesNotMatch(sent[2], /갱신 실패/);
  assert.ok(monitor.publicSnapshot().updatedAt > okAt);

  const lastOkBefore = monitor.status.bitkub.lastOkAt;
  const staleMs = Math.max(60_000, monitor.config.pollIntervalMs * 4);
  prices.fail.bitkub = true;
  await monitor.tick();
  assert.equal(monitor.status.bitkub.ok, false);
  assert.equal(monitor.status.bitkub.lastOkAt, lastOkBefore, '실패한 주기는 lastOkAt을 당기지 않는다');
  assert.equal(monitor.health().ok, true, '아직 신선하다');
  assert.equal(monitor.health(lastOkBefore + staleMs).ok, true);
  assert.equal(monitor.health(lastOkBefore + staleMs + 1).ok, false, 'Bitkub 시세가 오래 끊기면 실패다');
});

test('한 번도 성공하지 못한 소스는 스냅샷 시각 계산에서 뺀다', async () => {
  const { monitor, prices } = setup();
  prices.fail.bithumb = true;
  await monitor.prime();
  const first = monitor.publicSnapshot().updatedAt;
  assert.ok(first > 0);
  prices.fail.bitkub = true;
  await new Promise((r) => setTimeout(r, 5));
  await monitor.tick();
  assert.equal(monitor.publicSnapshot().updatedAt, first, '둘 다 실패하면 이전 시각을 유지한다');
  assert.equal(monitor.publicSnapshot().status.bithumb.error, 'bithumb down');
});

test('Bitkub 코인 목록이 실패해도 Bithumb 요청은 시세 목록으로 만들고 상태에 남긴다', async () => {
  const { monitor, prices } = setup();
  prices.fail.bitkubSymbols = true;
  await monitor.prime();
  assert.equal(monitor.publicSnapshot().status.bitkubSymbols.ok, false);
  assert.equal(monitor.publicSnapshot().status.bithumb.ok, true);
  assert.deepEqual(monitor.publicSnapshot().rows.map((r) => r.base), ['BTC']);
});

test('정기 시세는 all · common · top:N 을 현재 시세로 푼다', async () => {
  const { monitor, prices } = setup({ REPORT_SYMBOLS: 'top:1,common,XRP' });
  prices.volume.ETH = 5e9;
  await monitor.prime();
  assert.deepEqual(monitor.reportSymbols(), ['ETH', 'BTC', 'XRP']);
  const all = setup({ REPORT_SYMBOLS: 'all' });
  await all.monitor.prime();
  assert.deepEqual(all.monitor.reportSymbols(), ['BTC', 'ETH']);
  await all.monitor.sendReport();
  assert.match(all.sent[0], /<b>BTC<\/b> 비트코인[\s\S]*<b>ETH<\/b> Ethereum/);
});

test('시작 경고: 없는 심볼과 거래대금 기준에 걸리는 WATCHLIST 코인을 알린다', async () => {
  const { monitor } = setup({ WATCHLIST: 'BTC,XYZ', REPORT_SYMBOLS: 'BTC,NOPE,top:5', SURGE_MIN_VOLUME_THB: '2000000000' });
  await monitor.prime();
  const warnings = monitor.startupWarnings();
  assert.match(warnings[0], /없는 심볼: XYZ, NOPE/);
  assert.match(warnings[1], /급등 알림에서 제외: BTC/);
  assert.match(warnings[2], /사실상 꺼져/);
  assert.deepEqual(setup().monitor.startupWarnings(), [], 'Bitkub 시세가 없으면 확인할 수 없다');
  const ok = setup({ REPORT_SYMBOLS: 'BTC,ETH,top:5' });
  await ok.monitor.prime();
  assert.deepEqual(ok.monitor.startupWarnings(), [], '선택자는 심볼로 보지 않는다');
});

test('Telegram 전송 실패는 상태에 남고 다음 알림은 계속 보낸다', async () => {
  const { monitor, prices, sent } = setup();
  await monitor.prime();
  prices.fail.telegram = true;
  await monitor.sendReport();
  assert.equal(monitor.publicSnapshot().status.telegram.ok, false);
  assert.match(monitor.publicSnapshot().status.telegram.error, /chat not found/);
  prices.fail.telegram = false;
  await monitor.sendReport();
  assert.equal(sent.length, 1);
  assert.equal(monitor.publicSnapshot().status.telegram.ok, true);
});

test('급등 판정은 호가 중간값으로 한다 (체결가 튐은 거르고, 호가가 같이 오르면 잡는다)', async () => {
  const a = setup();
  await a.monitor.prime();
  a.prices.book.ETH = { bid: 79_920, ask: 80_080 }; // 호가는 그대로, 체결가만 튐
  a.prices.bitkub.ETH = 83_000;
  await a.monitor.tick();
  await a.monitor.flushNotifications();
  assert.equal(a.sent.length, 0);

  const b = setup();
  await b.monitor.prime();
  b.prices.book.ETH = { bid: 83_000, ask: 83_400 };
  b.prices.bitkub.ETH = 83_000;
  await b.monitor.tick();
  await b.monitor.flushNotifications();
  assert.equal(b.sent.length, 1);
  assert.equal(b.monitor.recentAlerts[0].price, 83_200);
  assert.match(b.sent[0], /현재 ฿83,200/);

  // 호가가 없으면 체결가로 판정한다.
  const c = setup();
  await c.monitor.prime();
  c.prices.book.ETH = { bid: 0, ask: 0 };
  c.prices.bitkub.ETH = 83_000;
  await c.monitor.tick();
  await c.monitor.flushNotifications();
  assert.equal(c.sent.length, 1);
});

test('알림 전송은 시세 조회를 막지 않고, 순서대로 보내며, 실패해도 다음 알림을 이어 보낸다', async () => {
  const { monitor, prices } = setup();
  await monitor.prime();
  const pending = [];
  monitor.telegram = { enabled: true, send(html) { return new Promise((res, rej) => pending.push({ html, res, rej })); } };
  prices.bitkub.ETH = 83_000;
  const outcome = await Promise.race([monitor.tick().then(() => 'done'), new Promise((r) => setTimeout(() => r('blocked'), 300))]);
  assert.equal(outcome, 'done', '전송이 끝나기 전에 주기가 끝난다');
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 1);
  const report = monitor.sendReport();
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.length, 1, '앞 알림이 끝나기 전에는 다음 알림을 보내지 않는다');
  pending[0].rej(new Error('boom'));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(pending.length, 2, '실패해도 다음 알림을 이어 보낸다');
  assert.match(pending[0].html, /급등 알림/);
  assert.match(pending[1].html, /\[시세\] Bitkub/);
  assert.equal(monitor.status.telegram.ok, false);
  pending[1].res();
  await report;
  assert.equal(monitor.status.telegram.ok, true);
});

test('많이 늦어진 알림에는 감지 당시 값임을 표시한다', async () => {
  const { monitor, sent } = setup({ POLL_INTERVAL_SEC: '3' });
  await monitor.prime();
  await monitor.deliver('<b>x</b>', '급등 알림', Date.now() - 61_000);
  assert.match(sent[0], /^<i>전송 1분 1초 지연 \(감지 당시 값\)<\/i>\n\n<b>x<\/b>$/);
  await monitor.deliver('<b>y</b>', '급등 알림', Date.now() - 5_000);
  assert.equal(sent[1], '<b>y</b>');
});
