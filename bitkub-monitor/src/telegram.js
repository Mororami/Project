// Telegram 메시지 한 건의 최대 길이는 4096자. 여유를 두고 자른다.
const MESSAGE_LIMIT = 4000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Telegram {
  constructor({ token, chatIds = [], apiBase = 'https://api.telegram.org' }) {
    this.token = token;
    this.chatIds = chatIds;
    this.apiBase = apiBase;
  }

  get enabled() {
    return Boolean(this.token && this.chatIds.length);
  }

  /** Bot API 호출. 오류 메시지에 토큰이 들어가지 않도록 URL은 노출하지 않는다. */
  async call(method, payload = {}) {
    let res;
    try {
      res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new Error(`Telegram ${method} 연결 실패: ${err.name === 'TimeoutError' ? '시간 초과' : (err.cause?.code ?? err.message)}`);
    }
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      const err = new Error(`Telegram ${method} 실패: ${data?.description ?? `HTTP ${res.status}`}`);
      err.retryAfter = data?.parameters?.retry_after;
      throw err;
    }
    return data.result;
  }

  /** 설정된 모든 채팅방에 HTML 메시지를 보낸다. 길면 나눠 보낸다. */
  async send(html) {
    if (!this.enabled) return false;
    for (const chatId of this.chatIds) {
      for (const part of splitMessage(html)) await this.sendOne(chatId, part);
    }
    return true;
  }

  async sendOne(chatId, text, attempt = 0) {
    try {
      await this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    } catch (err) {
      // 전송 한도 초과(429)면 안내받은 시간만큼 기다렸다가 다시 보낸다.
      if (err.retryAfter && attempt < 2) {
        await sleep(err.retryAfter * 1000);
        return this.sendOne(chatId, text, attempt + 1);
      }
      throw err;
    }
  }
}

/** 빈 줄로 나뉜 블록 단위로, 블록이 너무 길면 줄 단위로 메시지를 나눈다. */
export function splitMessage(text, limit = MESSAGE_LIMIT) {
  if (text.length <= limit) return [text];
  const parts = [];
  let current = '';
  const push = (piece, sep) => {
    if (current && current.length + sep.length + piece.length > limit) {
      parts.push(current);
      current = '';
    }
    current = current ? current + sep + piece : piece;
  };
  for (const block of text.split('\n\n')) {
    if (block.length <= limit) {
      push(block, '\n\n');
      continue;
    }
    for (const line of block.split('\n')) {
      for (let i = 0; i < line.length; i += limit) push(line.slice(i, i + limit), '\n');
    }
  }
  if (current) parts.push(current);
  return parts;
}
