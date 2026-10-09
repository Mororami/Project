import { formatTime } from './format.js';

const stamp = () => `[${formatTime(Date.now(), { date: true, seconds: true })}]`;

export const log = {
  info: (...args) => console.log(stamp(), ...args),
  warn: (...args) => console.warn(stamp(), '경고:', ...args),
  error: (...args) => console.error(stamp(), '오류:', ...args),
};
