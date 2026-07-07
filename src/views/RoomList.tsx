import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Room, RoomType } from '../kakao/client.js';

interface Props {
  rooms: Room[];
  unread: Record<string, number>;
  onOpen: (roomId: string) => void;
  title?: string;
  footer?: string;
  initialRoomId?: string | null;
  activeRoomId?: string | null;
  onCancel?: () => void;
}

const VISIBLE = 8; // window cap for long lists

// A short room-type marker; open chats are visually distinct.
function typeMarker(type: RoomType): { label: string; color: string } {
  switch (type) {
    case 'open':
      return { label: '[오픈]', color: 'magenta' };
    case 'group':
      return { label: '[그룹]', color: 'cyan' };
    default:
      return { label: '[1:1]', color: 'gray' };
  }
}

function relTime(at?: number): string {
  if (!at) return '';
  const diff = Date.now() - at;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

export default function RoomList({
  rooms,
  unread,
  onOpen,
  title = '채팅',
  footer = '↑/↓ 이동 · Enter 열기 · q 종료',
  initialRoomId,
  activeRoomId,
  onCancel,
}: Props): React.JSX.Element {
  // Sort by most-recent activity; clamp selection into range.
  const sorted = useMemo(() => [...rooms].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)), [rooms]);
  const initialIndex = initialRoomId ? sorted.findIndex((room) => room.id === initialRoomId) : 0;
  const [index, setIndex] = useState(Math.max(0, initialIndex));
  const sel = Math.min(index, Math.max(0, sorted.length - 1));
  const totalUnread = Object.values(unread).reduce((sum, n) => sum + n, 0);

  useInput((_input, key) => {
    if (key.upArrow) setIndex((i) => Math.max(0, Math.min(i, sorted.length - 1) - 1));
    else if (key.downArrow)
      setIndex((i) => Math.min(sorted.length - 1, Math.min(i, sorted.length - 1) + 1));
    else if (key.return) {
      const room = sorted[sel];
      if (room) onOpen(room.id);
    } else if (key.escape && onCancel) {
      onCancel();
    }
  });

  // Window the visible slice so the selected row stays on screen.
  const start = Math.max(0, Math.min(sel - Math.floor(VISIBLE / 2), sorted.length - VISIBLE));
  const view = sorted.slice(Math.max(0, start), Math.max(0, start) + VISIBLE);

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="space-between">
        <Text bold color="yellow">
          {title}
        </Text>
        <Text color={totalUnread > 0 ? 'red' : 'gray'}>합계: {totalUnread} 읽지 않음</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {view.map((room) => {
          const n = unread[room.id] ?? 0;
          const marker = typeMarker(room.type);
          const active = room.id === sorted[sel]?.id;
          const current = room.id === activeRoomId;
          return (
            <Box key={room.id}>
              <Text color={active ? 'cyan' : undefined}>{active ? '❯ ' : '  '}</Text>
              {n > 0 ? (
                <Text color="red">● {n} </Text>
              ) : (
                <Text dimColor>{'    '}</Text>
              )}
              <Text color={marker.color}>{marker.label} </Text>
              <Text bold={active}>{room.name}</Text>
              {current ? <Text color="green"> 현재</Text> : null}
              <Text dimColor>
                {'  '}
                {room.lastMessage ?? ''} · {relTime(room.lastAt)}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{footer}</Text>
      </Box>
    </Box>
  );
}
