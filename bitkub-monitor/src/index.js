import path from 'node:path';
import { loadDotEnv, parseConfig, ROOT_DIR } from './config.js';
import { log } from './log.js';
import { Monitor } from './monitor.js';
import { createServer } from './server.js';
import { Telegram } from './telegram.js';

loadDotEnv();

let config;
try {
  config = parseConfig();
} catch (err) {
  log.error(`설정 오류: ${err.message}`);
  process.exit(1);
}

const telegram = new Telegram(config.telegram);
if (!telegram.enabled) {
  log.warn('TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID가 없어 알림은 콘솔에만 출력합니다');
}

const monitor = new Monitor(config, { telegram });
const server = createServer({
  getSnapshot: () => monitor.publicSnapshot(),
  publicDir: path.join(ROOT_DIR, 'public'),
});

const { host, port } = config.server;
server.on('error', (err) => {
  log.error(`대시보드 서버를 열 수 없습니다 (${host}:${port}): ${err.message}`);
  process.exit(1);
});
server.listen(port, host, () => {
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  log.info(`대시보드: http://${shown}:${server.address().port}`);
});

monitor.start().catch((err) => log.error(`모니터 시작 실패: ${err.message}`));

const shutdown = () => {
  log.info('종료합니다');
  monitor.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
