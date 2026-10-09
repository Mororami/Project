const USER_AGENT = 'Mozilla/5.0 (compatible; bitkub-monitor/1.0)';

/** JSON GET 요청. 실패 시 어느 요청이 왜 실패했는지 담은 Error를 던진다. */
export async function fetchJson(url, { timeoutMs = 10_000, headers = {} } = {}) {
  const { host, pathname } = new URL(url);
  const name = `${host}${pathname}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? '시간 초과' : (err.cause?.code ?? err.message);
    throw new Error(`${name} 요청 실패: ${reason}`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}: ${text.slice(0, 160)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} 응답이 JSON이 아닙니다`);
  }
}
