// 봇에게 최근 메시지를 보낸 채팅방의 chat_id를 찾아 출력한다.
import { loadDotEnv, parseConfig } from '../config.js';
import { Telegram } from '../telegram.js';

loadDotEnv();
const { telegram: settings } = parseConfig();
if (!settings.token) {
  console.error('.env에 TELEGRAM_BOT_TOKEN을 먼저 설정하세요.');
  process.exit(1);
}

const telegram = new Telegram(settings);
try {
  const me = await telegram.call('getMe');
  const updates = await telegram.call('getUpdates', { timeout: 0 });
  const chats = new Map();
  for (const u of updates) {
    const chat = (u.message ?? u.edited_message ?? u.channel_post ?? u.my_chat_member)?.chat;
    if (chat) chats.set(chat.id, chat);
  }

  console.log(`봇: @${me.username}`);
  if (!chats.size) {
    console.log(`@${me.username}에게 아무 메시지나 보낸 뒤 다시 실행하세요.`);
    console.log('그룹에서 받으려면 봇을 그룹에 초대한 직후 실행하거나, 그룹에서 /start 를 보낸 뒤 다시 실행하세요 (봇은 기본 설정에서 그룹의 일반 메시지를 받지 못합니다).');
    process.exit(0);
  }
  console.log('최근 메시지를 보낸 채팅방:');
  for (const chat of chats.values()) {
    const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '';
    console.log(`  ${chat.id}\t${chat.type}\t${name}`);
  }
  console.log('\n.env에 TELEGRAM_CHAT_ID=<위 숫자>를 넣으세요. 여러 곳이면 쉼표로 구분합니다.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
