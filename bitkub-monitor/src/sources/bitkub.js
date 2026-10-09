import { fetchJson } from '../http.js';

const BASE_URL = 'https://api.bitkub.com';

/** THB 마켓 전체 시세. Map<심볼, 시세> (예: "BTC"). 숫자는 문자열로 오므로 변환한다. */
export async function fetchBitkubTickers() {
  const list = await fetchJson(`${BASE_URL}/api/v3/market/ticker`);
  if (!Array.isArray(list)) throw new Error('Bitkub ticker 응답 형식이 예상과 다릅니다');

  const tickers = new Map();
  for (const t of list) {
    const [base, quote] = String(t.symbol).split('_');
    const last = Number(t.last);
    if (quote !== 'THB' || !(last > 0)) continue;
    tickers.set(base, {
      last,
      // 급등 판정에 쓰는 호가. 없으면 0.
      bid: Number(t.highest_bid) || 0,
      ask: Number(t.lowest_ask) || 0,
      changePct: Number(t.percent_change) || 0,
      volumeThb: Number(t.quote_volume) || 0,
    });
  }
  return tickers;
}

/** THB 마켓 코인 이름과 거래 정지 여부. Map<심볼, { name, halted }> */
export async function fetchBitkubSymbols() {
  const res = await fetchJson(`${BASE_URL}/api/v3/market/symbols`);
  if (res?.error !== 0 || !Array.isArray(res.result)) {
    throw new Error(`Bitkub symbols 응답 오류 (error=${res?.error})`);
  }
  const symbols = new Map();
  for (const s of res.result) {
    if (s.quote_asset !== 'THB') continue;
    symbols.set(s.base_asset, {
      name: s.name || null,
      // 매수나 매도가 막힌 마켓은 마지막 체결가가 현재가와 다를 수 있다. 문서화된 불리언만 본다.
      halted: s.freeze_buy === true || s.freeze_sell === true,
    });
  }
  return symbols;
}
