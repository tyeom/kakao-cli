// 계정이 필요한 live 로그인 점검 스크립트입니다.
// 비공식 LOCO 클라이언트는 카카오 약관 위반 소지가 있으므로 버리는 계정으로만 실행하세요.
//
//   pnpm run login
//
// QR을 카카오톡 앱에서 스캔하면 auth.json에 토큰이 저장되고, 바로 LOCO 연결까지 확인합니다.
// 선택 환경변수:
//   KAKAO_TEST_SEND="<roomId>::<text>" pnpm run login
import { NodeKakaoAuth } from '../src/kakao/auth.js';
import { ForgeKakaoClient } from '../src/kakao/forge-client.js';
import type { Message, Room } from '../src/kakao/client.js';

const LISTEN_MS = 30_000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const auth = new NodeKakaoAuth();

  console.log('\nQR 로그인 준비 중...');
  const cred = await auth.login({
    onStatus: (status) => console.log(`  ${status}`),
    onQrCode: (qr) => {
      console.log('\n카카오톡 앱에서 아래 QR을 스캔하세요.\n');
      console.log(qr);
    },
    onPasscode: (passcode) => {
      console.log(`\n휴대폰 확인 코드: ${passcode}`);
      console.log('카카오톡 앱의 QR 로그인 확인 화면에서 같은 코드인지 확인하세요.');
    },
  });

  console.log(`\n✓ QR 인증 성공! userId=${cred.userId}`);
  console.log('  자격 증명을 auth.json에 저장했습니다 (다음 실행부터는 자동 로그인).');

  const client = new ForgeKakaoClient();
  client.on('error', (err: Error) => console.error('  [client error]', err.message));
  client.on('disconnected', (reason: string) => console.log('  [disconnected]', reason));

  console.log('\nLOCO 서버 연결 중...');
  await client.login(cred);
  console.log('✓ 연결됨.');

  const rooms: Room[] = await client.listRooms();
  console.log(`\n채팅방 ${rooms.length}개:`);
  rooms.forEach((r, i) => {
    const unread = r.unreadCount > 0 ? ` (안읽음 ${r.unreadCount})` : '';
    console.log(`  [${i}] ${r.type.padEnd(6)} ${r.name}  id=${r.id}${unread}`);
  });

  const sendSpec = process.env.KAKAO_TEST_SEND;
  if (sendSpec) {
    const sep = sendSpec.indexOf('::');
    if (sep <= 0) {
      console.log(`\nKAKAO_TEST_SEND 형식 오류: "<roomId>::<text>" 가 필요합니다.`);
    } else {
      const roomId = sendSpec.slice(0, sep);
      const text = sendSpec.slice(sep + 2);
      console.log(`\n메시지 전송 -> room ${roomId}: "${text}"`);
      await client.sendMessage(roomId, text);
      console.log('✓ 전송 완료.');
    }
  }

  console.log(`\n수신 메시지 대기 중 (${LISTEN_MS / 1000}초)... 다른 기기에서 이 계정으로 메시지를 보내보세요.`);
  client.on('chat', (m: Message) => {
    const when = new Date(m.at).toLocaleTimeString();
    const who = m.isMine ? `${m.senderName} (나)` : m.senderName;
    console.log(`  [${when}] (room ${m.roomId}) ${who}: ${m.text}`);
  });
  await delay(LISTEN_MS);

  console.log('\n연결 종료 중...');
  await client.disconnect();
  console.log('✓ 완료.');
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('\n✗ 실패:', msg);
    process.exit(1);
  });
