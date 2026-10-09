import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Telegram } from '../src/telegram.js';

/** 가짜 Bot API. handler(method, payload, 호출 횟수) → { status, body } 또는 Error */
function stubBotApi(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/').pop();
    const payload = JSON.parse(init.body);
    calls.push({ method, payload });
    const out = handler(method, payload, calls.length);
    if (out instanceof Error) throw out;
    return new Response(JSON.stringify(out.body ?? { ok: true, result: {} }), { status: out.status ?? 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const sleeps = [];
const make = (chatIds) => new Telegram({ token: 'SECRET-TOKEN', chatIds, sleep: async (ms) => { sleeps.push(ms); } });

test('한 채팅방이 실패해도 나머지에는 보내고 실패를 모아 던진다', async () => {
  const api = stubBotApi((m, p) => (p.chat_id === '1' ? { status: 403, body: { ok: false, description: 'Forbidden: bot was blocked by the user' } } : {}));
  try {
    await assert.rejects(make(['1', '2']).send('<b>hi</b>'), (err) => {
      assert.match(err.message, /채팅 1: Telegram sendMessage 실패: Forbidden/);
      assert.equal(err.failedCount, 1);
      assert.equal(err.sentCount, 1);
      return true;
    });
    assert.deepEqual(api.calls.map((c) => c.payload.chat_id), ['1', '2']);
    assert.equal(api.calls[1].payload.parse_mode, 'HTML');
  } finally {
    api.restore();
  }
});

test('서버 오류·연결 실패는 잠시 뒤 다시 보내고, 429는 안내받은 시간만큼 기다린다', async () => {
  sleeps.length = 0;
  const api = stubBotApi((m, p, n) => {
    if (n === 1) return { status: 502, body: { ok: false, description: 'Bad Gateway' } };
    if (n === 2) return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return {};
  });
  try {
    assert.equal(await make(['7']).send('x'), true);
    assert.equal(api.calls.length, 3);
    assert.deepEqual(sleeps, [2000, 4000]);
  } finally {
    api.restore();
  }

  sleeps.length = 0;
  const limited = stubBotApi((m, p, n) => (n === 1 ? { status: 429, body: { ok: false, description: 'Too Many Requests', parameters: { retry_after: 5 } } } : {}));
  try {
    assert.equal(await make(['7']).send('x'), true);
    assert.deepEqual(sleeps, [5000]);
  } finally {
    limited.restore();
  }

  // 잘못된 요청(400)은 다시 보내지 않는다.
  const bad = stubBotApi(() => ({ status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }));
  try {
    await assert.rejects(make(['7']).send('x'), /chat not found/);
    assert.equal(bad.calls.length, 1);
  } finally {
    bad.restore();
  }
});

test('그룹이 슈퍼그룹으로 바뀌면 새 chat_id로 다시 보내고 기억한다', async () => {
  const api = stubBotApi((m, p) =>
    p.chat_id === '-4123'
      ? { status: 400, body: { ok: false, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -1004123 } } }
      : {});
  const original = console.warn;
  console.warn = () => {};
  try {
    const tg = make(['-4123', '9']);
    assert.equal(await tg.send('x'), true);
    assert.deepEqual(api.calls.map((c) => c.payload.chat_id), ['-4123', '-1004123', '9']);
    assert.deepEqual(tg.chatIds, ['-1004123', '9']);
  } finally {
    console.warn = original;
    api.restore();
  }
});

test('오류 메시지에 봇 토큰이 들어가지 않는다', async () => {
  const api = stubBotApi(() => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
  try {
    await assert.rejects(make(['1']).call('getMe'), (err) => {
      assert.doesNotMatch(err.message, /SECRET-TOKEN/);
      assert.match(err.message, /ENOTFOUND/);
      return true;
    });
  } finally {
    api.restore();
  }
});
