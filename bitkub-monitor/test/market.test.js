import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSnapshot, median, premiumPct } from '../src/market.js';

const options = { outlierPct: 30, lowLiquidityThb: 100_000 };

function snapshot(fx = { rate: 40, at: 0, source: 'test', sourceLabel: 'test' }) {
  const bitkub = new Map([
    ['BTC', { last: 2_500_000, changePct: 1, volumeThb: 300_000_000 }],
    ['USDT', { last: 33, changePct: 0, volumeThb: 900_000_000 }],
    ['XYZ', { last: 10, changePct: 0, volumeThb: 1_000 }],
    ['BLAST', { last: 0.001, changePct: 0, volumeThb: 2_000_000 }],
    ['ONLYBK', { last: 5, changePct: 0, volumeThb: 2_000_000 }],
  ]);
  const bithumb = new Map([
    ['BTC', { last: 101_000_000, changePct: 0.5, volumeKrw: 5e10 }],
    ['USDT', { last: 1_340, changePct: 0, volumeKrw: 1e11 }],
    ['XYZ', { last: 396, changePct: 0, volumeKrw: 1e6 }],
    ['BLAST', { last: 0.3, changePct: 0, volumeKrw: 1e8 }],
  ]);
  const bithumbMarkets = new Map([
    ['BTC', { nameKo: '비트코인', nameEn: 'Bitcoin', warning: null }],
    ['USDT', { nameKo: '테더', nameEn: 'Tether', warning: null }],
    ['XYZ', { nameKo: null, nameEn: null, warning: 'CAUTION' }],
    ['BLAST', { nameKo: '블라스트', nameEn: 'Blast', warning: null }],
  ]);
  const bitkubSymbols = new Map([['XYZ', { name: 'Xyz Token' }]]);
  return buildSnapshot({ bitkub, bithumb, bitkubSymbols, bithumbMarkets, fx, options, now: 1 });
}

test('김프 계산식', () => {
  assert.equal(premiumPct(101, 2.5, 40), 1.0000000000000009);
  assert.equal(premiumPct(100, 0, 40), null);
  assert.equal(premiumPct(100, 2.5, null), null);
});

test('두 거래소 모두에 있는 코인만 비교하고 Bithumb 거래대금 순으로 정렬한다', () => {
  const snap = snapshot();
  assert.deepEqual(snap.rows.map((r) => r.base), ['USDT', 'BTC', 'BLAST', 'XYZ']);
  const btc = snap.rows.find((r) => r.base === 'BTC');
  assert.equal(btc.krwFromThb, 100_000_000);
  assert.ok(Math.abs(btc.premiumPct - 1) < 1e-9);
  assert.equal(btc.nameKo, '비트코인');
});

test('이상치와 저유동성을 표시하고 요약 통계에서 뺀다', () => {
  const snap = snapshot();
  const byBase = Object.fromEntries(snap.rows.map((r) => [r.base, r]));
  assert.equal(byBase.BLAST.outlier, true);
  assert.equal(byBase.XYZ.lowLiquidity, true);
  assert.equal(byBase.XYZ.warning, 'CAUTION');
  assert.equal(byBase.XYZ.nameEn, 'Xyz Token');
  assert.equal(snap.summary.outliers, 1);
  // BTC(+1%)와 USDT(1340 ÷ 1320 − 1 ≈ +1.52%)만 남는다.
  assert.equal(snap.summary.used, 2);
  const usdtPct = (1340 / (33 * 40) - 1) * 100;
  assert.ok(Math.abs(snap.summary.medianPct - (1 + usdtPct) / 2) < 1e-9);
  assert.equal(snap.summary.above, 2);
  assert.equal(snap.summary.below, 0);
});

test('USDT 교차 환율 = Bithumb USDT ÷ Bitkub USDT', () => {
  const snap = snapshot();
  assert.ok(Math.abs(snap.usdtCrossRate - 1340 / 33) < 1e-9);
});

test('환율이 없으면 원화 환산과 김프를 비워 둔다', () => {
  const snap = snapshot(null);
  assert.ok(snap.rows.every((r) => r.premiumPct === null && r.krwFromThb === null && !r.outlier));
  assert.equal(snap.summary.medianPct, null);
});

test('중앙값', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});
