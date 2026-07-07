// Headless, interactive live-login harness — run by the USER against a
// DISPOSABLE Kakao account (unofficial LOCO clients violate Kakao ToS; abuse can
// permanently ban the account). This is the ONLY way live login gets tested;
// the Advisor cannot run it (device registration needs a phone passcode).
//
//   KAKAO_EMAIL=you@example.com KAKAO_PASSWORD=secret \
//     [KAKAO_TEST_SEND="<roomId>::<text>"] npx tsx scripts/login-test.ts
//
// Missing env vars are prompted for. On first login on this device you'll be
// asked for the passcode Kakao texts to the account's phone.
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { NodeKakaoAuth } from '../src/kakao/auth.js';
import { NodeKakaoClient } from '../src/kakao/node-kakao.js';
import type { Message, Room } from '../src/kakao/client.js';

const LISTEN_MS = 30_000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const rl = createInterface({ input, output });
  const ask = async (q: string): Promise<string> => (await rl.question(q)).trim();

  try {
    const email = process.env.KAKAO_EMAIL || (await ask('카카오 이메일: '));
    const password = process.env.KAKAO_PASSWORD || (await ask('비밀번호: '));

    // --- 1. Auth (device registration + token persistence) -----------------
    const auth = new NodeKakaoAuth();
    console.log('\n로그인 시도 중...');
    const cred = await auth.login({
      email,
      password,
      onPasscodeNeeded: async () => {
        console.log(
          '\n이 기기는 아직 등록되지 않았습니다. 카카오가 휴대폰으로 패스코드를 보냈습니다.',
        );
        return ask('휴대폰으로 받은 패스코드 입력: ');
      },
    });
    console.log(`\n✓ 로그인 성공! userId=${cred.userId}`);
    console.log('  자격 증명을 auth.json에 저장했습니다 (다음 실행부터는 자동 로그인).');

    // --- 2. Connect the LOCO client ----------------------------------------
    const client = new NodeKakaoClient();
    client.on('error', (err: Error) => console.error('  [client error]', err.message));
    client.on('disconnected', (reason: string) =>
      console.log('  [disconnected]', reason),
    );

    console.log('\nLOCO 서버 연결 중...');
    await client.login(cred);
    console.log('✓ 연결됨.');

    // --- 3. List rooms ------------------------------------------------------
    const rooms: Room[] = await client.listRooms();
    console.log(`\n채팅방 ${rooms.length}개:`);
    rooms.forEach((r, i) => {
      const unread = r.unreadCount > 0 ? ` (안읽음 ${r.unreadCount})` : '';
      console.log(`  [${i}] ${r.type.padEnd(6)} ${r.name}  id=${r.id}${unread}`);
    });

    // --- 4. Optional one-shot send -----------------------------------------
    const sendSpec = process.env.KAKAO_TEST_SEND;
    if (sendSpec) {
      const sep = sendSpec.indexOf('::');
      if (sep <= 0) {
        console.log(
          `\n⚠ KAKAO_TEST_SEND 형식 오류: "<roomId>::<text>" 가 필요합니다 (받은 값: "${sendSpec}").`,
        );
      } else {
        const roomId = sendSpec.slice(0, sep);
        const text = sendSpec.slice(sep + 2);
        console.log(`\n메시지 전송 → room ${roomId}: "${text}"`);
        await client.sendMessage(roomId, text);
        console.log('✓ 전송 완료.');
      }
    }

    // --- 5. Listen for incoming messages ~30s ------------------------------
    console.log(`\n수신 메시지 대기 중 (${LISTEN_MS / 1000}초)... 다른 기기에서 이 계정으로 메시지를 보내보세요.`);
    client.on('chat', (m: Message) => {
      const when = new Date(m.at).toLocaleTimeString();
      const who = m.isMine ? `${m.senderName} (나)` : m.senderName;
      console.log(`  [${when}] (room ${m.roomId}) ${who}: ${m.text}`);
    });
    await delay(LISTEN_MS);

    // --- 6. Clean shutdown --------------------------------------------------
    console.log('\n연결 종료 중...');
    await client.disconnect();
    console.log('✓ 완료.');
  } finally {
    rl.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\n✗ 실패:', msg);
    console.error(
      '  (상태 코드가 보이면 node-kakao/LOCO 상태값입니다. -100=기기미등록, ' +
        '12=비밀번호오류, 30=로그인실패, -303=전송속도제한.)',
    );
    process.exit(1);
  });
