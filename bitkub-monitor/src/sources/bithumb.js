import { fetchJson } from '../http.js';

const BASE_URL = 'https://api.bithumb.com';
// 한 번에 너무 많은 마켓을 넣으면 URL 길이 초과(414)가 난다.
const CHUNK_SIZE = 100;

/** KRW 마켓 목록. Map<심볼, { nameKo, nameEn, warning }> */
export async function fetchBithumbMarkets() {
  const list = await fetchJson(`${BASE_URL}/v1/market/all?isDetails=true`);
  if (!Array.isArray(list)) throw new Error('Bithumb market/all 응답 형식이 예상과 다릅니다');

  const markets = new Map();
  for (const m of list) {
    if (!String(m.market).startsWith('KRW-')) continue;
    markets.set(m.market.slice(4), {
      nameKo: m.korean_name || null,
      nameEn: m.english_name || null,
      warning: m.market_warning && m.market_warning !== 'NONE' ? m.market_warning : null,
    });
  }
  return markets;
}

/**
 * 지정한 코인들의 KRW 시세. Map<심볼, 시세>
 * 묶음 안에 모르는 마켓이 하나라도 있으면 Bithumb는 묶음 전체를 거절하므로,
 * 그런 묶음은 반씩 나눠 다시 요청해 문제 마켓만 빼내고 onSkip으로 알린다.
 */
export async function fetchBithumbTickers(bases, { onSkip } = {}) {
  const markets = [...bases].map((b) => `KRW-${b}`);
  const chunks = [];
  for (let i = 0; i < markets.length; i += CHUNK_SIZE) chunks.push(markets.slice(i, i + CHUNK_SIZE));

  const results = await Promise.all(chunks.map((chunk) => fetchChunk(chunk, onSkip)));
  const tickers = new Map();
  for (const t of results.flat()) {
    const last = Number(t.trade_price);
    if (!(last > 0)) continue;
    tickers.set(String(t.market).slice(4), {
      last,
      // Bithumb 변동률은 거래소가 제공하는 전일 종가 대비
      changePct: Number(t.signed_change_rate) * 100 || 0,
      volumeKrw: Number(t.acc_trade_price_24h) || 0,
    });
  }
  return tickers;
}

async function fetchChunk(markets, onSkip) {
  if (!markets.length) return [];
  let data;
  try {
    data = await fetchJson(`${BASE_URL}/v1/ticker?markets=${markets.join(',')}`);
  } catch (err) {
    // 모르는 마켓이 섞이면 HTTP 400/404와 {error:{name,message}}로 거절한다. 그 경우만 나눠서 다시 묻는다.
    // 한도 초과(429)·서버 장애·네트워크 오류는 나눠 봐야 요청만 늘어나므로 그대로 올린다.
    if (err.status !== 400 && err.status !== 404) throw err;
    data = err.body ?? { error: { message: `HTTP ${err.status}` } };
  }
  if (Array.isArray(data)) return data;
  if (markets.length === 1) {
    onSkip?.(markets[0], data?.error?.message ?? '알 수 없는 응답');
    return [];
  }
  const mid = Math.ceil(markets.length / 2);
  const [a, b] = await Promise.all([fetchChunk(markets.slice(0, mid), onSkip), fetchChunk(markets.slice(mid), onSkip)]);
  return [...a, ...b];
}
