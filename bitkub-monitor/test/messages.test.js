import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig, parseSurgeRules } from '../src/config.js';
import { formatKrwCompact, formatPct, formatPrice } from '../src/format.js';
import { formatReport, formatStartMessage, formatSurgeMessage } from '../src/messages.js';
import { splitMessage } from '../src/telegram.js';

const fx = { rate: 40, at: 0, source: 'naver', sourceLabel: '하나은행 고시' };

test('숫자 형식', () => {
  assert.equal(formatPrice(2772743.24), '2,772,743');
  assert.equal(formatPrice(149.56), '149.6');
  assert.equal(formatPrice(46.513), '46.51');
  assert.equal(formatPrice(0.000007804), '0.000007804');
  assert.equal(formatPct(1.584), '+1.58%');
  assert.equal(formatPct(-0.001), '0.00%');
  assert.equal(formatPct(-3.2), '-3.20%');
  assert.equal(formatKrwCompact(53_752_138_148), '538억');
  assert.equal(formatKrwCompact(250_000_000), '2.5억');
  assert.equal(formatKrwCompact(1.2e12), '1.2조');
  assert.equal(formatKrwCompact(35_000_000), '3,500만');
});

test('급등 메시지는 THB·원화 가격, 저점, 김프를 담고 이름을 이스케이프한다', () => {
  const [rule] = parseSurgeRules('5m:3');
  const now = 10 * 60_000;
  const events = [{
    base: 'ABC',
    price: 10.5,
    t: now,
    repeat: false,
    hits: [{ rule, low: { p: 10, t: now - 4 * 60_000 }, risePct: 5 }],
  }];
  const tickers = new Map([['ABC', { last: 10.5, changePct: 8, volumeThb: 1_000_000 }]]);
  const rowsByBase = new Map([['ABC', { nameKo: '<에이>', bithumb: { last: 430 }, premiumPct: 2.38 }]]);
  const text = formatSurgeMessage(events, { tickers, rowsByBase, fx, now });
  assert.match(text, /\[급등 알림\]/);
  assert.match(text, /<b>ABC<\/b> &lt;에이&gt;/);
  assert.match(text, /5분 저점 대비 <b>\+5\.00%<\/b>/);
  assert.match(text, /현재 ฿10\.5 ≈ ₩420/);
  assert.match(text, /저점 ฿10 \(4분 전\)/);
  assert.match(text, /거래대금 ₩4,000만/);
  assert.match(text, /빗썸 ₩430 · 김프 \+2\.38%/);
});

test('정기 시세 메시지', () => {
  const snap = {
    fx,
    summary: { medianPct: 1.2, btcPct: 1.5, usdtPct: 1.4 },
    rows: [{ base: 'BTC', nameKo: '비트코인', bithumb: { last: 101_500_000 }, premiumPct: 1.5 }],
  };
  const tickers = new Map([['BTC', { last: 2_500_000, changePct: -0.5, volumeThb: 1 }]]);
  const text = formatReport(snap, { tickers, symbols: ['BTC', 'NOPE'] });
  assert.match(text, /환율 1 THB = 40\.00 KRW \(하나은행 고시\)/);
  assert.match(text, /김프 중앙값 \+1\.20%/);
  assert.match(text, /<b>BTC<\/b> 비트코인 ฿2,500,000 ≈ ₩100,000,000\n24h -0\.50% · 빗썸 ₩101,500,000 \(김프 \+1\.50%\)/);
  assert.match(text, /<b>NOPE<\/b> Bitkub THB 마켓에 없음/);
});

test('시작 메시지는 현재 설정을 요약한다', () => {
  const text = formatStartMessage(parseConfig({ WATCHLIST: 'BTC,ETH' }));
  assert.match(text, /급등 규칙: 5분 \+3% · 30분 \+7% \(재알림 대기 30분\)/);
  assert.match(text, /대상: BTC, ETH/);
  assert.match(text, /정기 시세: 60분마다/);
});

test('긴 메시지는 블록 경계에서 나눈다', () => {
  const block = 'x'.repeat(1500);
  const parts = splitMessage([block, block, block].join('\n\n'), 4000);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], `${block}\n\n${block}`);
  assert.ok(parts.every((p) => p.length <= 4000));
  assert.deepEqual(splitMessage('short'), ['short']);
});
