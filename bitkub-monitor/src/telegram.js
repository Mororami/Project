import { log } from './log.js';

// Telegram 메시지 한 건의 최대 길이는 4096자. 여유를 두고 자른다.
const MESSAGE_LIMIT = 4000;
const MAX_ATTEMPTS = 3;
// 429의 retry_after가 아무리 길어도 이보다 오래 기다리지 않는다.
const MAX_RETRY_WAIT_MS = 60_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Telegram {
  constructor({ token, chatIds = [], apiBase = 'https://api.telegram.org', sleep = defaultSleep }) {
    this.token = token;
    this.chatIds = chatIds;
    this.apiBase = apiBase;
    this.sleep = sleep;
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
      const e = new Error(`Telegram ${method} 연결 실패: ${err.name === 'TimeoutError' ? '시간 초과' : (err.cause?.code ?? err.message)}`);
      e.retryable = true;
      throw e;
    }
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      const err = new Error(`Telegram ${method} 실패: ${data?.description ?? `HTTP ${res.status}`}`);
      err.status = res.status;
      // 서버 오류나 JSON이 아닌 응답은 잠시 뒤 다시 보낼 만하다. 잘못된 요청(4xx)은 다시 보내도 같다.
      err.retryable = !data || res.status >= 500;
      err.retryAfter = data?.parameters?.retry_after;
      err.migrateToChatId = data?.parameters?.migrate_to_chat_id;
      throw err;
    }
    return data.result;
  }

  /**
   * 설정된 모든 채팅방에 HTML 메시지를 보낸다. 길면 나눠 보낸다.
   * 한 채팅방이 실패해도 나머지에는 보내고, 끝에 실패한 곳을 모아 던진다.
   */
  async send(html) {
    if (!this.enabled) return false;
    const parts = splitMessage(html);
    const failed = [];
    const reasons = [];
    for (const chatId of this.chatIds) {
      try {
        // 보내는 중에 채팅 ID가 바뀌면(슈퍼그룹 전환) 나머지 조각은 새 ID로 보낸다.
        let id = chatId;
        for (const part of parts) id = await this.sendOne(id, part);
      } catch (err) {
        failed.push(`채팅 ${chatId}: ${err.message}`);
        reasons.push(err.message);
      }
    }
    if (failed.length) {
      const err = new Error(failed.join(' / '));
      err.failedCount = failed.length;
      err.sentCount = this.chatIds.length - failed.length;
      // 대시보드처럼 바깥에 보이는 곳에는 채팅 ID가 없는 요약을 쓴다.
      err.summary = `${failed.length}/${this.chatIds.length} 채팅 전송 실패: ${[...new Set(reasons)].join(' / ')}`;
      throw err;
    }
    return true;
  }

  /** 메시지 하나를 보내고, 실제로 보낸 chat_id를 돌려준다. */
  async sendOne(chatId, text, attempt = 1) {
    try {
      await this.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
      return chatId;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      // 일반 그룹이 슈퍼그룹으로 바뀌면 chat_id가 바뀐다(-NNN → -100NNN). 새 ID로 보내고 이번 실행 동안 기억한다.
      if (err.migrateToChatId) {
        const newId = String(err.migrateToChatId);
        log.warn(`Telegram 채팅 ${chatId}이(가) 슈퍼그룹 ${newId}(으)로 바뀌었습니다. .env의 TELEGRAM_CHAT_ID를 ${newId}(으)로 바꾸세요`);
        this.chatIds = this.chatIds.map((id) => (String(id) === String(chatId) ? newId : id));
        return this.sendOne(newId, text, attempt + 1);
      }
      // 전송 한도 초과(429)면 안내받은 시간만큼, 서버·네트워크 오류면 잠시 기다렸다가 다시 보낸다.
      if (err.retryAfter != null || err.retryable) {
        const wait = err.retryAfter != null ? Math.min(Number(err.retryAfter) * 1000, MAX_RETRY_WAIT_MS) : 2000 * attempt;
        await this.sleep(wait);
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
