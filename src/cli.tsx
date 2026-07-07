#!/usr/bin/env node
import { render } from 'ink';
import App from './app.js';

// 실행 옵션을 앱 내부에서 쓰는 환경변수로 정규화합니다.
// 예: pnpm run start:live -> tsx src/cli.tsx --live -> KAKAO_BACKEND=live
if (process.argv.includes('--live')) {
  process.env.KAKAO_BACKEND = 'live';
}

render(<App />);
