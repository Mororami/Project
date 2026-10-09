// 숫자·시간 표시 형식. Telegram 메시지와 로그에서 함께 쓴다.

// 서버(로그)의 현지 시간대를 따른다.
const timeFormatter = new Intl.DateTimeFormat('en-GB', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** 가격: 클수록 소수점을 줄이고, 1 미만은 유효숫자 4자리 */
export function formatPrice(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  const options =
    abs >= 1000 ? { maximumFractionDigits: 0 }
    : abs >= 100 ? { maximumFractionDigits: 1 }
    : abs >= 1 ? { maximumFractionDigits: 2 }
    : { maximumSignificantDigits: 4 };
  return value.toLocaleString('en-US', options);
}

/** 부호 있는 퍼센트: +1.58% / -0.42% */
export function formatPct(value, digits = 2) {
  if (value == null || !Number.isFinite(value)) return '-';
  if (Math.abs(value) < 0.5 * 10 ** -digits) return `${(0).toFixed(digits)}%`;
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

/** 원화 금액을 조·억·만 단위로 줄여 표시 */
export function formatKrwCompact(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toLocaleString('en-US', { maximumFractionDigits: 1 })}조`;
  if (abs >= 1e8) return `${(value / 1e8).toLocaleString('en-US', { maximumFractionDigits: abs >= 1e10 ? 0 : 1 })}억`;
  if (abs >= 1e4) return `${Math.round(value / 1e4).toLocaleString('en-US')}만`;
  return Math.round(value).toLocaleString('en-US');
}

/** 영문 단위 축약: 303.1M */
export function formatCompact(value) {
  if (value == null || !Number.isFinite(value)) return '-';
  return value.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });
}

/** 밀리초 → "5분", "1시간 30분" */
export function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h && `${h}시간`, m && `${m}분`, s && `${s}초`].filter(Boolean).join(' ') || '0초';
}

/** 현지 시각: "20:01", 옵션에 따라 "10/09 20:01:15" */
export function formatTime(ts, { date = false, seconds = false } = {}) {
  const p = Object.fromEntries(timeFormatter.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const time = seconds ? `${p.hour}:${p.minute}:${p.second}` : `${p.hour}:${p.minute}`;
  return date ? `${p.month}/${p.day} ${time}` : time;
}

/** 경과 시간: "45초 전", "4분 전" */
export function formatAgo(ms) {
  return ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}초 전` : `${Math.round(ms / 60_000)}분 전`;
}

/** Telegram HTML parse_mode용 이스케이프 */
export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
