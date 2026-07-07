import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import Spinner from 'ink-spinner';
import type { AuthProvider, Credential, KakaoClient, Message, Room } from './kakao/client.js';
import { MockKakaoClient } from './kakao/mock.js';
import { MockAuthProvider } from './kakao/mock-auth.js';
import { ForgeKakaoClient } from './kakao/forge-client.js';
import { NodeKakaoAuth } from './kakao/auth.js';
import Login from './views/Login.js';
import RoomList from './views/RoomList.js';
import ChatView from './views/ChatView.js';

// UI가 사용할 백엔드 묶음을 만듭니다.
function getBackend(): { client: KakaoClient; auth: AuthProvider } {
  // KAKAO_BACKEND=live면 KakaoForge 방식의 QR/V2SL 백엔드를 사용하고, 아니면 안전한 mock을 사용합니다.
  if (process.env.KAKAO_BACKEND === 'live') {
    return { client: new ForgeKakaoClient(), auth: new NodeKakaoAuth() };
  }
  return { client: new MockKakaoClient(), auth: new MockAuthProvider() };
}

type View = 'login' | 'rooms' | 'chat' | 'room-switcher';

const ROOM_REFRESH_MS = 5_000;

function mergeRooms(current: Room[], updates: Room[]): Room[] {
  const byId = new Map(current.map((room) => [room.id, room]));
  for (const update of updates) {
    const prev = byId.get(update.id);
    byId.set(update.id, {
      id: update.id,
      name: update.name || prev?.name || `(채팅방 ${update.id})`,
      type: update.type || prev?.type || 'group',
      unreadCount: update.unreadCount ?? prev?.unreadCount ?? 0,
      lastMessage: update.lastMessage ?? prev?.lastMessage,
      lastAt: update.lastAt ?? prev?.lastAt,
    });
  }
  return [...byId.values()];
}

export default function App(): React.JSX.Element {
  const { exit } = useApp();
  // 백엔드 묶음은 앱 시작 시 한 번만 만듭니다.
  const [{ client, auth }] = useState(getBackend);

  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>('login');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [openRoomId, setOpenRoomId] = useState<string | null>(null);
  // 한 번만 등록되는 이벤트 리스너에서 현재 열린 방을 읽기 위한 mirror ref입니다.
  const openRoomIdRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef(false);

  // Credential이 준비되면 LOCO에 연결하고 방 목록/읽지 않음 초기값을 채웁니다.
  const enterRooms = async (cred: Credential): Promise<void> => {
    await client.login(cred);
    const list = await client.listRooms();
    setRooms(list);
    setUnread(Object.fromEntries(list.map((r) => [r.id, r.unreadCount])));
    setView('rooms');
  };

  // 시작 시 저장된 토큰이 있으면 먼저 자동 로그인을 시도합니다.
  // 실패하면 토큰을 지우고 로그인 화면으로 돌아가 QR 인증을 다시 시작하게 합니다.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const saved = await auth.loadSaved();
      if (!alive) return;
      if (saved) {
        try {
          await enterRooms(saved);
        } catch (err) {
          await auth.logout();
          if (!alive) return;
          setLoginError(
            `저장된 로그인 정보로 연결하지 못했습니다: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          setView('login');
        }
      }
      setBooting(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 클라이언트 이벤트는 한 번만 연결합니다. 읽지 않음 값은 UI state가 소유합니다.
  useEffect(() => {
    const onChat = (msg: Message): void => {
      if (!msg.isMine && msg.roomId !== openRoomIdRef.current) {
        setUnread((u) => ({ ...u, [msg.roomId]: (u[msg.roomId] ?? 0) + 1 }));
      }
    };
    const onRoomUpdate = (room: Room): void => {
      setRooms((rs) => mergeRooms(rs, [room]));
    };
    client.on('chat', onChat);
    client.on('room-update', onRoomUpdate);
    return () => {
      client.off('chat', onChat);
      client.off('room-update', onRoomUpdate);
      void client.disconnect();
    };
  }, [client]);

  useEffect(() => {
    if (view !== 'rooms' && view !== 'room-switcher') return undefined;
    let alive = true;

    const refreshRooms = async (): Promise<void> => {
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      try {
        const list = await client.listRooms();
        if (!alive) return;
        setRooms((rs) => mergeRooms(rs, list));
        setUnread((prev) => {
          const next = { ...prev };
          for (const room of list) {
            if (next[room.id] === undefined) next[room.id] = room.unreadCount;
          }
          return next;
        });
      } catch {
        // 목록 화면 보조 동기화 실패는 기존 실시간 이벤트 경로를 유지하고 조용히 넘어갑니다.
      } finally {
        refreshInFlightRef.current = false;
      }
    };

    void refreshRooms();
    const timer = setInterval(() => {
      void refreshRooms();
    }, ROOM_REFRESH_MS);

    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [client, view]);

  const openRoom = (roomId: string): void => {
    openRoomIdRef.current = roomId;
    setOpenRoomId(roomId);
    setUnread((u) => ({ ...u, [roomId]: 0 })); // 방을 열면 읽지 않음 카운트를 지웁니다.
    setView('chat');
  };

  const backToRooms = (): void => {
    openRoomIdRef.current = null;
    setOpenRoomId(null);
    setView('rooms');
  };

  const openRoomSwitcher = (): void => {
    if (!openRoomIdRef.current) return;
    setView('room-switcher');
  };

  const backToOpenChat = (): void => {
    setView(openRoomIdRef.current ? 'chat' : 'rooms');
  };

  // 전역 키: 로그인/목록에서는 q로 종료하고, 채팅에서는 Tab으로 방 전환 목록을 엽니다.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
    else if (view === 'login' && input === 'q') exit();
    else if (view === 'rooms' && input === 'q') exit();
    else if (view === 'chat' && key.tab) openRoomSwitcher();
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
    return (
      <Login
        auth={auth}
        initialError={loginError}
        onLoggedIn={(cred) => {
          setLoginError(null);
          void enterRooms(cred);
        }}
      />
    );
  }

  if (view === 'chat') {
    const room = rooms.find((r) => r.id === openRoomId);
    if (room) return <ChatView client={client} room={room} />;
  }

  if (view === 'room-switcher') {
    return (
      <RoomList
        rooms={rooms}
        unread={unread}
        onOpen={openRoom}
        title="방 전환"
        footer="↑/↓ 이동 · Enter 전환 · Esc 채팅으로"
        initialRoomId={openRoomId}
        activeRoomId={openRoomId}
        onCancel={backToOpenChat}
      />
    );
  }

  return <RoomList rooms={rooms} unread={unread} onOpen={openRoom} />;
}
