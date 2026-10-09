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
