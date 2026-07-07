// Assert-based self-check of the mock adapter — no test framework.
// 실행: pnpm run smoke   (tsx scripts/mock-smoke.ts)
import assert from 'node:assert';
import { MockKakaoClient } from '../src/kakao/mock.js';
import type { Message } from '../src/kakao/client.js';

async function main(): Promise<void> {
  const client = new MockKakaoClient();

  await client.login({
    userId: 'mock',
    deviceUUID: 'mock',
    accessToken: 'mock',
    refreshToken: 'mock',
  });

  // Rooms: at least one, and at least one open chat.
  const rooms = await client.listRooms();
  assert(rooms.length >= 1, 'expected at least one room');
  assert(
    rooms.some((r) => r.type === 'open'),
    'expected at least one open-chat room',
  );
  console.log(
    `rooms: ${rooms.length} (types: ${[...new Set(rooms.map((r) => r.type))].join(', ')})`,
  );

  // History: non-empty and ascending by time.
  const first = rooms[0];
  const msgs = await client.getMessages(first.id);
  assert(msgs.length > 0, 'expected non-empty message history');
  for (let i = 1; i < msgs.length; i++) {
    assert(msgs[i].at >= msgs[i - 1].at, 'messages must be in ascending time order');
  }
  console.log(`messages in "${first.name}": ${msgs.length}`);

  // Realtime: prove the timer emits a 'chat' event (or fail after ~6s).
  const incoming = await new Promise<Message>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('chat', onChat);
      reject(new Error('timed out waiting for a realtime chat event'));
    }, 6000);
    function onChat(m: Message): void {
      clearTimeout(timer);
      client.off('chat', onChat);
      resolve(m);
    }
    client.on('chat', onChat);
  });
  assert(
    typeof incoming.text === 'string' && incoming.text.length > 0,
    'chat event must carry text',
  );
  assert(
    typeof incoming.roomId === 'string' && incoming.roomId.length > 0,
    'chat event must carry roomId',
  );
  console.log(`realtime chat in room ${incoming.roomId}: "${incoming.text}"`);

  await client.disconnect();
  console.log('mock-smoke OK');
  process.exit(0);
}

main().catch((err) => {
  console.error('mock-smoke FAILED:', err);
  process.exit(1);
});
