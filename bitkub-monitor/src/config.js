import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDuration } from './format.js';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FX_PROVIDER_IDS = ['naver', 'yahoo', 'erapi'];

const DEFAULT_SURGE_RULES = '5m:3,30m:7';
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 };
const SYMBOL = /^[A-Z0-9]+$/;
// REPORT_SYMBOLS에서 코인 대신 쓸 수 있는 선택자: all(Bitkub THB 전체), common(빗썸에도 있는 코인), top:N(거래대금 상위 N)
export const REPORT_SELECTOR = /^(ALL|COMMON|TOP:[1-9]\d*)$/;

/** .env 파일을 읽어 env에 채운다. 이미 설정된 값은 덮어쓰지 않는다. */
export function loadDotEnv(file = path.join(ROOT_DIR, '.env'), env = process.env) {
  if (!existsSync(file)) return false;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    const rest = line.slice(eq + 1).trim();
    const quoted = rest.match(/^(["'])(.*?)\1(\s+#.*)?$/);
    const value = quoted ? quoted[2] : rest.replace(/(^|\s)#.*$/, '').trim();
    if (env[key] === undefined) env[key] = value;
  }
  return true;
}

/**
 * 급등 규칙 문자열을 해석한다. "5m:3,30m:7" → 5분 안에 +3%, 30분 안에 +7%
 * 단위는 s(초)·m(분)·h(시간). 짧은 구간 순으로 정렬해 돌려준다.
 */
export function parseSurgeRules(text) {
  const rules = String(text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^(\d+(?:\.\d+)?)\s*([smh])\s*:\s*\+?(\d+(?:\.\d+)?)\s*%?$/i);
      if (!m) throw new Error(`SURGE_RULES 형식 오류: "${part}" (예: 5m:3,30m:7)`);
      const windowMs = Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
      const pct = Number(m[3]);
      if (!(windowMs > 0) || !(pct > 0)) throw new Error(`SURGE_RULES 값은 0보다 커야 합니다: "${part}"`);
      return { windowMs, pct, label: formatDuration(windowMs) };
    });
  if (!rules.length) throw new Error('SURGE_RULES가 비어 있습니다');
  return rules.sort((a, b) => a.windowMs - b.windowMs);
}

/** "krw-btc", "BTC_THB", " btc " → "BTC" */
export function normalizeSymbol(text) {
  return String(text).trim().toUpperCase().replace(/^KRW-/, '').replace(/[_-]THB$/, '');
}

function readNumber(env, key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    const range =
      min !== -Infinity && max !== Infinity ? `${min}~${max}`
      : min !== -Infinity ? `${min} 이상`
      : max !== Infinity ? `${max} 이하`
      : '숫자';
    throw new Error(`${key} 값이 올바르지 않습니다: "${raw}" (허용: ${range})`);
  }
  return n;
}

function readList(env, key, fallback = []) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

export function parseConfig(env = process.env) {
  const symbols = (key, fallback) => readList(env, key, fallback).map(normalizeSymbol);

  const fxProviders = readList(env, 'FX_PROVIDERS', FX_PROVIDER_IDS).map((s) => s.toLowerCase());
  for (const id of fxProviders) {
    if (!FX_PROVIDER_IDS.includes(id)) {
      throw new Error(`FX_PROVIDERS에 알 수 없는 값: "${id}" (사용 가능: ${FX_PROVIDER_IDS.join(', ')})`);
    }
  }

  const pollIntervalMs = readNumber(env, 'POLL_INTERVAL_SEC', 15, { min: 3 }) * 1000;

  const surgeText = String(env.SURGE_RULES ?? '').trim();
  const rules = /^off$/i.test(surgeText) ? [] : parseSurgeRules(surgeText || DEFAULT_SURGE_RULES);
  // 조회 간격보다 짧거나 같은 구간은 비교할 이전 가격이 없어 절대 맞지 않는다.
  const dead = rules.filter((r) => r.windowMs <= pollIntervalMs);
  if (dead.length) {
    throw new Error(
      `SURGE_RULES 구간은 조회 간격(POLL_INTERVAL_SEC=${pollIntervalMs / 1000}초)보다 길어야 합니다: ${dead.map((r) => `${r.label} +${r.pct}%`).join(', ')}`,
    );
  }

  const watchlist = symbols('WATCHLIST', []);
  for (const s of watchlist) {
    if (!SYMBOL.test(s)) throw new Error(`WATCHLIST 형식 오류: "${s}" (예: BTC,ETH)`);
  }
  const reportSymbols = symbols('REPORT_SYMBOLS', ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'USDT']);
  for (const s of reportSymbols) {
    if (!SYMBOL.test(s) && !REPORT_SELECTOR.test(s)) {
      throw new Error(`REPORT_SYMBOLS 형식 오류: "${s}" (예: BTC,ETH 또는 all, common, top:20)`);
    }
  }

  return {
    telegram: {
      token: String(env.TELEGRAM_BOT_TOKEN ?? '').trim(),
      chatIds: readList(env, 'TELEGRAM_CHAT_ID'),
      apiBase: String(env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, ''),
    },
    pollIntervalMs,
    fx: {
      refreshMs: readNumber(env, 'FX_REFRESH_SEC', 60, { min: 10 }) * 1000,
      providers: fxProviders,
      fixedRate: readNumber(env, 'FX_THB_KRW', null, { min: 0.0001 }),
    },
    surge: {
      rules,
      cooldownMs: readNumber(env, 'SURGE_COOLDOWN_MIN', 30, { min: 0 }) * 60_000,
      minVolumeThb: readNumber(env, 'SURGE_MIN_VOLUME_THB', 500_000, { min: 0 }),
      watchlist,
    },
    report: {
      // 1주(10080분)를 넘는 간격은 타이머 한도와 쓸모를 생각해 막는다.
      intervalMin: readNumber(env, 'REPORT_INTERVAL_MIN', 60, { min: 0, max: 10080 }),
      symbols: reportSymbols,
    },
    market: {
      outlierPct: readNumber(env, 'OUTLIER_PCT', 30, { min: 1 }),
      lowLiquidityThb: readNumber(env, 'LOW_LIQUIDITY_THB', 100_000, { min: 0 }),
      lowLiquidityKrw: readNumber(env, 'LOW_LIQUIDITY_KRW', 4_000_000, { min: 0 }),
    },
    server: {
      host: String(env.DASHBOARD_HOST ?? '').trim() || '127.0.0.1',
      port: readNumber(env, 'DASHBOARD_PORT', 8080, { min: 0, max: 65535 }),
    },
  };
}
