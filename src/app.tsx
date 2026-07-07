import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { KakaoClient } from './kakao/client.js';
import { MockKakaoClient } from './kakao/mock.js';

// Placeholder shell for Wave 1. It only proves that (a) ink renders and
// (b) the mock adapter connects and lists rooms. The real router
// (login → rooms → chat) is Worker U's job in Wave 2.
export default function App() {
  const [ready, setReady] = useState(false);
  const [roomCount, setRoomCount] = useState(0);

  useEffect(() => {
    // KAKAO_BACKEND is read only trivially here; Wave 2 wires the live adapter.
    const client: KakaoClient = new MockKakaoClient();
    let cancelled = false;

    void (async () => {
      await client.login({
        userId: 'mock',
        deviceUUID: 'mock',
        accessToken: 'mock',
        refreshToken: 'mock',
      });
      const rooms = await client.listRooms();
      if (!cancelled) {
        setRoomCount(rooms.length);
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
      void client.disconnect();
    };
  }, []);

  return (
    <Box flexDirection="column" padding={1}>
      {ready ? (
        <>
          <Text color="green">
            kakao-cli — connected, {roomCount} rooms
          </Text>
          <Text dimColor>(UI coming in Wave 2)</Text>
        </>
      ) : (
        <Text color="yellow">kakao-cli — connecting…</Text>
      )}
    </Box>
  );
}
