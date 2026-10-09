// 현재 시세를 한 번 모아 설정된 채팅방에 테스트 메시지를 보낸다.
import { loadDotEnv, parseConfig } from '../config.js';
import { formatReport } from '../messages.js';
import { Monitor } from '../monitor.js';
import { Telegram } from '../telegram.js';

loadDotEnv();
const config = parseConfig();
const telegram = new Telegram(config.telegram);
if (!telegram.enabled) {
  console.error('.env에 TELEGRAM_BOT_TOKEN과 TELEGRAM_CHAT_ID를 먼저 설정하세요.');
  process.exit(1);
}

const monitor = new Monitor(config, { telegram });
await monitor.prime();
if (!monitor.bitkub.size) {
  console.error('Bitkub 시세를 가져오지 못했습니다. 네트워크 상태를 확인하세요.');
  process.exit(1);
}

const message = formatReport(monitor.snapshot, {
  tickers: monitor.bitkub,
  symbols: monitor.reportSymbols(),
  names: monitor.bitkubSymbols,
  title: '[테스트] Bitkub 시세 모니터 연결 확인',
  status: monitor.status,
});
try {
  await telegram.send(message);
  console.log(`전송 완료: ${config.telegram.chatIds.join(', ')}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
