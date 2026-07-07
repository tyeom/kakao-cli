import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { AuthProvider, Credential, KakaoClient, Message, Room } from './kakao/client.js';
import { MockKakaoClient } from './kakao/mock.js';
import { MockAuthProvider } from './kakao/mock-auth.js';
import { NodeKakaoClient } from './kakao/node-kakao.js';
import { NodeKakaoAuth } from './kakao/auth.js';
import Login from './views/Login.js';
import RoomList from './views/RoomList.js';
import ChatView from './views/ChatView.js';

// Returns the {client, auth} backend pair the UI drives.
function getBackend(): { client: KakaoClient; auth: AuthProvider } {
  // KAKAO_BACKEND=live → real node-kakao (needs a logged-in auth.json); else mock.
  if (process.env.KAKAO_BACKEND === 'live') {
    return { client: new NodeKakaoClient(), auth: new NodeKakaoAuth() };
  }
  return { client: new MockKakaoClient(), auth: new MockAuthProvider() };
}

type View = 'login' | 'rooms' | 'chat';

export default function App(): React.JSX.Element {
  const { exit } = useApp();
  // Backend pair is created exactly once (lazy state initializer).
  const [{ client, auth }] = useState(getBackend);

  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>('login');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  // Mirror of openRoomId for use inside the (once-bound) event listeners.
  const openRoomIdRef = useRef<string | null>(null);

  // After a credential exists, connect and seed rooms + unread.
  const enterRooms = async (cred: Credential): Promise<void> => {
    await client.login(cred);
    const list = await client.listRooms();
    setRooms(list);
    setUnread(Object.fromEntries(list.map((r) => [r.id, r.unreadCount])));
    setView('rooms');
  };

  // On mount: try a saved credential (silent re-login); else show Login.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const saved = await auth.loadSaved();
      if (!alive) return;
      if (saved) await enterRooms(saved);
      setBooting(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire client events ONCE. Unread is UI-owned (functional setState).
  useEffect(() => {
    const onChat = (msg: Message): void => {
      if (!msg.isMine && msg.roomId !== openRoomIdRef.current) {
        setUnread((u) => ({ ...u, [msg.roomId]: (u[msg.roomId] ?? 0) + 1 }));
      }
    };
    const onRoomUpdate = (room: Room): void => {
      setRooms((rs) =>
        rs.map((r) =>
          r.id === room.id
            ? { ...r, name: room.name, lastMessage: room.lastMessage, lastAt: room.lastAt }
            : r,
        ),
      );
    };
    client.on('chat', onChat);
    client.on('room-update', onRoomUpdate);
    return () => {
      client.off('chat', onChat);
      client.off('room-update', onRoomUpdate);
      void client.disconnect();
    };
  }, [client]);

  const openRoom = (roomId: string): void => {
    openRoomIdRef.current = roomId;
    setOpenRoomId(roomId);
    setUnread((u) => ({ ...u, [roomId]: 0 })); // opening clears unread
    setView('chat');
  };

  const backToRooms = (): void => {
    openRoomIdRef.current = null;
    setOpenRoomId(null);
    setView('rooms');
  };

  // Global keys: q (from the list) or Ctrl+C quits; Esc leaves chat.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
    else if (view === 'rooms' && input === 'q') exit();
    else if (view === 'chat' && key.escape) backToRooms();
  });

  if (booting) {
    return (
      <Box padding={1}>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text> 연결 중…</Text>
      </Box>
    );
  }

  if (view === 'login') {
    return <Login auth={auth} onLoggedIn={(cred) => void enterRooms(cred)} />;
  }

  if (view === 'chat') {
    const room = rooms.find((r) => r.id === openRoomId);
    if (room) return <ChatView client={client} room={room} />;
  }

  return <RoomList rooms={rooms} unread={unread} onOpen={openRoom} />;
}
