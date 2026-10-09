import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { Monitor } from '../src/monitor.js';

const silent = { info() {}, warn() {}, error() {} };

function setup(env = {}) {
  const prices = { bitkub: { BTC: 2_500_000, ETH: 80_000 }, fail: {} };
  const sources = {
    async bitkubSymbols() {
      return new Map([['BTC', { name: 'Bitcoin' }], ['ETH', { name: 'Ethereum' }]]);
    },
    async bithumbMarkets() {
      return new Map([['BTC', { nameKo: '비트코인', nameEn: 'Bitcoin', warning: null }]]);
    },
    async bitkubTickers() {
      if (prices.fail.bitkub) throw new Error('bitkub down');
      return new Map(Object.entries(prices.bitkub).map(([b, last]) => [b, { last, changePct: 0, volumeThb: 1e9 }]));
    },
    async bithumbTickers(bases) {
      if (prices.fail.bithumb) throw new Error('bithumb down');
      assert.deepEqual(bases, ['BTC']);
      return new Map([['BTC', { last: 101_000_000, changePct: 0, volumeKrw: 1e10 }]]);
    },
    async thbKrw() {
      return { rate: 40, at: 0, source: 'test', sourceLabel: 'test' };
    },
  };
  const sent = [];
  const telegram = { enabled: true, async send(html) { sent.push(html); } };
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
  assert.equal(sent.length, 1);
  assert.match(sent[0], /<b>ETH<\/b> Ethereum/);
  assert.match(sent[0], /5분 저점 대비 <b>\+3\.75%<\/b>/);
  assert.equal(monitor.recentAlerts[0].base, 'ETH');
  assert.equal(monitor.recentAlerts[0].priceKrw, 83_000 * 40);

  // 대기 시간 안에서 추가 상승이 없으면 다시 보내지 않는다.
  await monitor.tick();
  assert.equal(sent.length, 1);
});

test('WATCHLIST에 없는 코인과 거래대금이 적은 코인은 알리지 않는다', async () => {
  const { monitor, prices, sent } = setup({ WATCHLIST: 'BTC' });
  await monitor.prime();
  prices.bitkub.ETH = 90_000;
  await monitor.tick();
  assert.equal(sent.length, 0);

  const low = setup({ SURGE_MIN_VOLUME_THB: '2000000000' });
  await low.monitor.prime();
  low.prices.bitkub.BTC = 2_700_000;
  await low.monitor.tick();
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
