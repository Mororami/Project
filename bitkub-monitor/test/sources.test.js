import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchJson } from '../src/http.js';
import { fetchBithumbMarkets, fetchBithumbTickers } from '../src/sources/bithumb.js';
import { fetchBitkubSymbols, fetchBitkubTickers } from '../src/sources/bitkub.js';
import { fetchThbKrw } from '../src/sources/fx.js';

/** 가짜 fetch. handler(url) → { status, body } 또는 Error. 요청 URL을 기록한다. */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const out = handler(String(url), calls.length);
    if (out instanceof Error) throw out;
    const { status = 200, body = null, text } = out;
    return new Response(text ?? JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('fetchJson은 HTTP 오류에 상태 코드와 본문을 붙인다', async () => {
  const f = stubFetch(() => ({ status: 404, body: { error: { name: 404, message: 'Code not found' } } }));
  try {
    await assert.rejects(fetchJson('https://api.example.com/x'), (err) => {
      assert.match(err.message, /api.example.com\/x HTTP 404/);
      assert.equal(err.status, 404);
      assert.equal(err.body.error.message, 'Code not found');
      return true;
    });
    f.restore();
    const g = stubFetch(() => ({ text: 'not json' }));
    await assert.rejects(fetchJson('https://api.example.com/x'), /JSON이 아닙니다/);
    g.restore();
  } finally {
    f.restore();
  }
});

test('Bitkub ticker: 문자열 숫자를 변환하고 THB 마켓만 담고 호가를 남긴다', async () => {
  const f = stubFetch(() => ({
    body: [
      { symbol: 'BTC_THB', last: '3385000', percent_change: '2.69', quote_volume: '69080877.73', highest_bid: '3380000', lowest_ask: '3390000' },
      { symbol: 'ETH_USDT', last: '3000', percent_change: '1', quote_volume: '1' },
      { symbol: 'DEAD_THB', last: '0', percent_change: '0', quote_volume: '0' },
    ],
  }));
  try {
    const t = await fetchBitkubTickers();
    assert.deepEqual([...t.keys()], ['BTC']);
    assert.deepEqual(t.get('BTC'), { last: 3385000, bid: 3380000, ask: 3390000, changePct: 2.69, volumeThb: 69080877.73 });
    assert.match(f.calls[0], /api\.bitkub\.com\/api\/v3\/market\/ticker$/);
  } finally {
    f.restore();
  }
});

test('Bitkub symbols: 이름과 거래 정지 여부를 남기고 THB가 아닌 마켓은 뺀다', async () => {
  const f = stubFetch(() => ({
    body: {
      error: 0,
      result: [
        { symbol: 'BTC_THB', base_asset: 'BTC', quote_asset: 'THB', name: 'Bitcoin', status: 'active', freeze_buy: false, freeze_sell: false },
        { symbol: 'X_THB', base_asset: 'X', quote_asset: 'THB', name: 'X Coin', status: 'active', freeze_buy: true, freeze_sell: false },
        { symbol: 'ETH_USDT', base_asset: 'ETH', quote_asset: 'USDT', name: 'Ethereum' },
      ],
    },
  }));
  try {
    const s = await fetchBitkubSymbols();
    assert.deepEqual([...s.entries()], [['BTC', { name: 'Bitcoin', halted: false }], ['X', { name: 'X Coin', halted: true }]]);
  } finally {
    f.restore();
  }
  const g = stubFetch(() => ({ body: { error: 3 } }));
  try {
    await assert.rejects(fetchBitkubSymbols(), /error=3/);
  } finally {
    g.restore();
  }
});

test('Bithumb market/all: KRW 마켓만, 유의 종목 표시', async () => {
  const f = stubFetch(() => ({
    body: [
      { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin', market_warning: 'NONE' },
      { market: 'KRW-XYZ', korean_name: '엑스', english_name: 'Xyz', market_warning: 'CAUTION' },
      { market: 'BTC-ETH', korean_name: '이더리움', english_name: 'Ethereum', market_warning: 'NONE' },
    ],
  }));
  try {
    const m = await fetchBithumbMarkets();
    assert.deepEqual([...m.keys()], ['BTC', 'XYZ']);
    assert.equal(m.get('BTC').warning, null);
    assert.equal(m.get('XYZ').warning, 'CAUTION');
    assert.match(f.calls[0], /\/v1\/market\/all\?isDetails=true$/);
  } finally {
    f.restore();
  }
});

/** 가짜 Bithumb: 요청한 마켓 중 bad가 있으면 상태 코드 status로 거절, 아니면 시세 배열 */
function fakeBithumb(bad, status) {
  return (url) => {
    const markets = decodeURIComponent(url.split('markets=')[1]).split(',');
    if (markets.some((m) => bad.includes(m))) {
      return { status, body: { error: { name: status, message: 'Code not found' } } };
    }
    return { body: markets.map((m) => ({ market: m, trade_price: '100', signed_change_rate: '0.0123', acc_trade_price_24h: '5000000' })) };
  };
}

test('Bithumb ticker: 모르는 마켓이 4xx로 거절되면 나눠서 다시 묻고 그 마켓만 뺀다', async () => {
  const bases = Array.from({ length: 110 }, (_, i) => `C${i}`);
  for (const status of [404, 400, 200]) {
    const f = stubFetch(fakeBithumb(['KRW-C105'], status));
    const skipped = [];
    try {
      const t = await fetchBithumbTickers(bases, { onSkip: (m, why) => skipped.push(`${m}:${why}`) });
      assert.equal(t.size, 109, `status ${status}`);
      assert.equal(t.has('C105'), false);
      assert.deepEqual(skipped, ['KRW-C105:Code not found']);
      assert.deepEqual(t.get('C0'), { last: 100, changePct: 1.23, volumeKrw: 5_000_000 });
      // 100개 묶음 1회 + 10개 묶음 이분 탐색(10→5→3→2→1 수준)
      assert.ok(f.calls.length >= 6 && f.calls.length <= 12, `requests=${f.calls.length}`);
    } finally {
      f.restore();
    }
  }
});

test('Bithumb ticker: 한도 초과(429)·서버 오류는 나누지 않고 그대로 실패한다', async () => {
  for (const status of [429, 500, 503]) {
    const f = stubFetch(() => ({ status, body: { error: { name: status, message: 'Too Many Requests' } } }));
    try {
      await assert.rejects(fetchBithumbTickers(['BTC', 'ETH']), new RegExp(`HTTP ${status}`));
      assert.equal(f.calls.length, 1);
    } finally {
      f.restore();
    }
  }
});

test('환율: 앞 소스가 실패하면 다음 소스를 쓰고, 범위를 벗어난 값은 버린다', async () => {
  const f = stubFetch((url) => {
    if (url.includes('naver')) return { status: 500, text: 'oops' };
    if (url.includes('yahoo')) return { body: { chart: { result: [{ meta: { regularMarketPrice: 40.12, regularMarketTime: 1_700_000_000 } }] } } };
    return { body: { rates: { KRW: 39.9 }, time_last_update_unix: 1_700_000_000 } };
  });
  try {
    const fx = await fetchThbKrw(['naver', 'yahoo', 'erapi']);
    assert.equal(fx.source, 'yahoo');
    assert.equal(fx.rate, 40.12);
    assert.equal(fx.at, 1_700_000_000_000);
  } finally {
    f.restore();
  }
  const g = stubFetch(() => ({ body: { rates: { KRW: 0.025 }, time_last_update_unix: 1 } }));
  try {
    await assert.rejects(fetchThbKrw(['erapi']), /비정상 환율 값 0.025/);
  } finally {
    g.restore();
  }
});

test('Bithumb ticker: JSON 거절 형식이 아닌 4xx(HTML 오류 페이지)·네트워크 오류는 나누지 않고 실패한다', async () => {
  const bases = Array.from({ length: 100 }, (_, i) => `C${i}`);
  const html = stubFetch(() => ({ status: 404, text: '<html><body>404 Not Found</body></html>' }));
  const skipped = [];
  try {
    await assert.rejects(fetchBithumbTickers(bases, { onSkip: (m) => skipped.push(m) }), /HTTP 404: <html>/);
    assert.equal(html.calls.length, 1, '한 번만 묻고 포기한다');
    assert.deepEqual(skipped, []);
  } finally {
    html.restore();
  }
  const net = stubFetch(() => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }));
  try {
    await assert.rejects(fetchBithumbTickers(['BTC', 'ETH', 'XRP']), /요청 실패: ECONNRESET/);
    assert.equal(net.calls.length, 1);
  } finally {
    net.restore();
  }
});

test('Bithumb ticker: 요청한 마켓이 전부 거절되면 제외하지 않고 실패로 올린다 (엔드포인트 장애)', async () => {
  const bases = Array.from({ length: 30 }, (_, i) => `C${i}`);
  const f = stubFetch(() => ({ status: 404, body: { error: { name: 404, message: 'Code not found' } } }));
  const skipped = [];
  try {
    await assert.rejects(fetchBithumbTickers(bases, { onSkip: (m) => skipped.push(m) }), /마켓 30개의 시세를 모두 거절했습니다 \(Code not found\)/);
    assert.deepEqual(skipped, [], '전부 거절이면 onSkip을 부르지 않는다');
    // 차례로 나누므로 동시에 몰리지 않는다: 30 → 15+15 → ... 단일 30개까지 모두 한 번씩, 총 2N-1 = 59
    assert.equal(f.calls.length, 59);
  } finally {
    f.restore();
  }
});
