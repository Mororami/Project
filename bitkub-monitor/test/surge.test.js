import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSurgeRules } from '../src/config.js';
import { SurgeDetector } from '../src/surge.js';

const MIN = 60_000;

function detector(rules = '5m:3,30m:7', cooldownMin = 30) {
  return new SurgeDetector({ rules: parseSurgeRules(rules), cooldownMs: cooldownMin * MIN });
}

test('구간 저점 대비 상승률이 기준 이상이면 급등으로 판정한다', () => {
  const d = detector();
  assert.equal(d.update('BTC', 100, 0), null);
  assert.equal(d.update('BTC', 98, 1 * MIN), null);
  assert.equal(d.update('BTC', 100.5, 2 * MIN), null);
  const event = d.update('BTC', 101, 3 * MIN);
  assert.ok(event);
  assert.equal(event.hits.length, 1);
  assert.equal(event.hits[0].rule.label, '5분');
  assert.equal(event.hits[0].low.p, 98);
  assert.ok(Math.abs(event.hits[0].risePct - (101 / 98 - 1) * 100) < 1e-9);
});

test('구간을 벗어난 오래된 저점은 쓰지 않는다', () => {
  const d = detector('5m:3');
  d.update('ETH', 90, 0);
  d.update('ETH', 100, 1 * MIN);
  // 6분 뒤에는 90이 5분 구간 밖이다.
  assert.equal(d.update('ETH', 102, 6 * MIN), null);
});

test('긴 구간 규칙은 짧은 구간에서 놓친 완만한 급등을 잡는다', () => {
  const d = detector();
  let price = 100;
  let event = null;
  for (let m = 0; m <= 25; m++) {
    event = d.update('SOL', price, m * MIN) ?? event;
    price *= 1.004; // 분당 0.4%: 5분 2%, 25분 약 10.5%
  }
  assert.ok(event);
  assert.deepEqual(event.hits.map((h) => h.rule.label), ['30분']);
});

test('재알림 대기 중에는 같은 코인을 다시 알리지 않고, 추가 상승하면 다시 알린다', () => {
  const d = detector('5m:3', 30);
  d.update('XRP', 100, 0);
  const first = d.update('XRP', 104, 1 * MIN);
  assert.ok(d.accept(first));
  assert.equal(first.repeat, false);

  d.update('XRP', 103, 2 * MIN);
  // 5분 저점 100 대비 +5%지만, 직전 알림 104 대비 +3% 미만이면 막는다.
  const second = d.update('XRP', 105, 3 * MIN);
  assert.ok(second);
  assert.equal(d.accept(second), false);

  // 직전 알림 104 대비 +3% 이상이면 추가 상승으로 다시 알린다.
  const third = d.update('XRP', 107.2, 4 * MIN);
  assert.ok(d.accept(third));
  assert.equal(third.repeat, true);
});

test('재알림 대기 시간이 지나면 다시 알린다', () => {
  const d = detector('5m:3', 10);
  d.update('DOGE', 100, 0);
  assert.ok(d.accept(d.update('DOGE', 104, 1 * MIN)));
  d.update('DOGE', 100, 20 * MIN);
  const again = d.update('DOGE', 104, 21 * MIN);
  assert.ok(d.accept(again));
  assert.equal(again.repeat, false);
});

test('prune은 시세가 끊긴 코인의 기록을 지운다', () => {
  const d = detector('5m:3', 10);
  d.update('OLD', 1, 0);
  d.update('NEW', 1, 20 * MIN);
  d.prune(20 * MIN);
  assert.equal(d.history.has('OLD'), false);
  assert.equal(d.history.has('NEW'), true);
});

test('대기 시간이 지나도 저점이 직전 알림 이전 그대로면(같은 상승의 연장) 더 올라야 알린다', () => {
  // 규칙 구간(1시간)보다 짧은 대기 시간(30분). 100 → 108 뒤 가격이 그대로다.
  const d = detector('5m:3,1h:7', 30);
  d.update('ARB', 100, 0);
  const first = d.update('ARB', 108, 1 * MIN);
  assert.ok(d.accept(first));
  let again = null;
  for (let m = 2; m <= 45; m++) again = d.update('ARB', 108, m * MIN) ?? again;
  assert.ok(again, '1시간 규칙은 계속 만족한다');
  assert.equal(d.accept(again), false, '같은 급등을 두 번 알리지 않는다');

  // 대기 시간 0이어도 매 주기 반복해서 알리지 않는다.
  const zero = detector('5m:3', 0);
  zero.update('OP', 100, 0);
  assert.ok(zero.accept(zero.update('OP', 104, 1 * MIN)));
  assert.equal(zero.accept(zero.update('OP', 104.5, 1.25 * MIN)), false);
  const more = zero.update('OP', 107.5, 1.5 * MIN);
  assert.ok(zero.accept(more));
  assert.equal(more.repeat, true);
});

test('직전 알림의 저점보다 더 낮은 새 저점에서 다시 오르면 대기 중이라도 새 급등으로 알린다', () => {
  const d = detector('5m:3,30m:7', 30);
  d.update('X', 100, 0);
  assert.ok(d.accept(d.update('X', 110, 1 * MIN)));
  // 95까지 밀렸다가 4분 만에 112로 급등: 저점 95는 직전 저점 100보다 3% 넘게 낮다.
  d.update('X', 95, 12 * MIN);
  d.update('X', 95, 15 * MIN);
  const fresh = d.update('X', 112, 16 * MIN);
  assert.ok(fresh);
  assert.ok(d.accept(fresh));
  assert.equal(fresh.repeat, false);

  // 살짝 눌렸다가(99) 다시 오르는 건 새 급등이 아니다: 직전 알림가(103.5)보다 3% 더 올라야 한다.
  const e = detector('5m:3', 30);
  e.update('Y', 100, 0);
  assert.ok(e.accept(e.update('Y', 103.5, 1 * MIN)));
  e.update('Y', 99, 4 * MIN);
  const dip = e.update('Y', 103.5, 7 * MIN);
  assert.ok(dip);
  assert.equal(e.accept(dip), false);
});

test('시계가 뒤로 돌아가면 기록을 비우고 새로 쌓는다', () => {
  const d = detector('5m:3', 30);
  d.update('Z', 100, 10 * MIN);
  d.update('Z', 101, 11 * MIN);
  // NTP 보정으로 3분 뒤로 간 뒤의 상승은 이전 기록과 비교하지 않는다.
  assert.equal(d.update('Z', 104, 8 * MIN), null);
  assert.equal(d.history.get('Z').length, 1);
});

test('하락 중의 반등은 직전 저점을 넘지 못하므로 새 급등으로 알리지 않는다', () => {
  const d = detector('5m:3,30m:7', 30);
  d.update('DUMP', 100, 0);
  assert.ok(d.accept(d.update('DUMP', 110, 1 * MIN)));
  // 8% 떨어졌다가 3.5% 반등하는 계단식 하락
  let price = 110;
  let t = 2;
  let alerts = 0;
  for (let leg = 0; leg < 5; leg++) {
    price *= 0.92;
    for (let i = 0; i < 3; i++) d.update('DUMP', price, t++ * MIN);
    price *= 1.035;
    const e = d.update('DUMP', price, t++ * MIN);
    if (e && d.accept(e)) alerts++;
  }
  assert.equal(alerts, 0);
  assert.ok(price < 100);
});
