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

type View = 'login' | 'main';
type ActivePane = 'list' | 'chat';
type LeftMode = 'rooms' | 'friends';

const ROOM_REFRESH_MS = 5_000;
const BRAND_LINES = [
  ' _  __     _              _____     _ _      ____ _     ___ ',
  '| |/ /__ _| | ____ _  ___|_   _|_ _| | | __ / ___| |   |_ _|',
  "| ' // _` | |/ / _` |/ _ \\ | |/ _` | | |/ /| |   | |    | | ",
  '| . \\ (_| |   < (_| | (_) || | (_| | |   < | |___| |___ | | ',
  '|_|\\_\\__,_|_|\\_\\__,_|\\___/ |_|\\__,_|_|_|\\_\\ \\____|_____|___|',
];

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

function sortRoomsByActivity(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
}

function toggleLeftMode(mode: LeftMode): LeftMode {
  return mode === 'rooms' ? 'friends' : 'rooms';
}

function BrandHeader(): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {BRAND_LINES.map((line, index) => (
        <Text key={line} color={index % 2 === 0 ? 'yellow' : 'cyan'} bold>
          {line}
        </Text>
      ))}
      <Text color="magenta" bold>
        == Kakao Talk CLI ==
      </Text>
    </Box>
  );
}

function EmptyChat(): React.JSX.Element {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="yellow">
        대화방을 선택하세요
      </Text>
      <Text dimColor>좌측 목록에서 Enter를 누르면 우측에 대화가 열립니다.</Text>
    </Box>
  );
}

export default function App(): React.JSX.Element {
  const { exit } = useApp();
  // 백엔드 묶음은 앱 시작 시 한 번만 만듭니다.
  const [{ client, auth }] = useState(getBackend);

  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>('login');
  const [activePane, setActivePane] = useState<ActivePane>('list');
  const [leftMode, setLeftMode] = useState<LeftMode>('rooms');
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
    const firstRoom = sortRoomsByActivity(list)[0];
    setRooms(list);
    setUnread(Object.fromEntries(list.map((r) => [r.id, firstRoom?.id === r.id ? 0 : r.unreadCount])));
    openRoomIdRef.current = firstRoom?.id ?? null;
    setOpenRoomId(firstRoom?.id ?? null);
    setActivePane('list');
    setView('main');
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
    if (view !== 'main') return undefined;
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

  const selectRoom = (roomId: string): void => {
    openRoomIdRef.current = roomId;
    setOpenRoomId(roomId);
    setUnread((u) => ({ ...u, [roomId]: 0 })); // 방을 열면 읽지 않음 카운트를 지웁니다.
    setActivePane('chat');
  };

  // 전역 키는 "현재 포커스가 어느 패널인지"만 결정합니다.
  // 각 패널 내부의 이동/전송 키는 해당 컴포넌트가 focused 상태일 때만 처리합니다.
  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
    else if (view === 'login' && input === 'q') exit();
    else if (view === 'main' && key.tab && key.shift && activePane === 'list') {
      setLeftMode((mode) => toggleLeftMode(mode));
    } else if (view === 'main' && key.tab) {
      setActivePane((pane) => (pane === 'list' && openRoomIdRef.current ? 'chat' : 'list'));
    } else if (view === 'main' && key.escape && activePane === 'chat') {
      setActivePane('list');
    } else if (view === 'main' && activePane === 'list' && input === 'q') {
      exit();
    }
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

  const activeRoom = rooms.find((r) => r.id === openRoomId) ?? null;
  const leftRooms = leftMode === 'friends' ? rooms.filter((room) => room.type === 'direct') : rooms;
  const leftTitle = leftMode === 'friends' ? '친구' : '채팅';
  const leftFooter =
    activePane === 'list'
      ? leftMode === 'friends'
        ? '↑/↓ 이동 · Enter 대화 · Tab 대화창 · Shift+Tab 채팅'
        : '↑/↓ 이동 · Enter 열기 · Tab 대화창 · Shift+Tab 친구'
      : 'Tab 목록 활성화';

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <BrandHeader />
      <Box justifyContent="space-between" marginBottom={1}>
        <Text color={activePane === 'list' ? 'green' : 'gray'}>
          활성 영역: {activePane === 'list' ? `좌측 ${leftTitle}` : '우측 대화방'}
        </Text>
        <Text dimColor>Tab 영역 전환 · Shift+Tab 목록 토글 · Ctrl+C 종료</Text>
      </Box>
      <Box flexDirection="row">
        <Box
          width={46}
          minHeight={18}
          marginRight={1}
          borderStyle="round"
          borderColor={activePane === 'list' ? 'yellow' : 'gray'}
          flexDirection="column"
        >
          <RoomList
            key={leftMode}
            rooms={leftRooms}
            unread={unread}
            onOpen={selectRoom}
            focused={activePane === 'list'}
            title={leftTitle}
            footer={leftFooter}
            emptyText={leftMode === 'friends' ? '1:1 대화방이 없습니다.' : '채팅방이 없습니다.'}
            initialRoomId={openRoomId}
            activeRoomId={openRoomId}
          />
        </Box>
        <Box
          flexGrow={1}
          minHeight={18}
          borderStyle="round"
          borderColor={activePane === 'chat' ? 'yellow' : 'gray'}
          flexDirection="column"
        >
          {activeRoom ? (
            <ChatView client={client} room={activeRoom} focused={activePane === 'chat'} />
          ) : (
            <EmptyChat />
          )}
        </Box>
      </Box>
    </Box>
  );
}
