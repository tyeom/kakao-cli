import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Room, RoomType } from '../kakao/client.js';

interface Props {
  rooms: Room[];
  unread: Record<string, number>;
  onOpen: (roomId: string) => void;
  focused?: boolean;
  title?: string;
  footer?: string;
  emptyText?: string;
  initialRoomId?: string | null;
  activeRoomId?: string | null;
  onCancel?: () => void;
}

const VISIBLE = 6; // 긴 목록에서 한 번에 렌더링할 행 수입니다.

// 방 타입은 짧은 한글 표식으로 구분합니다.
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

function clipText(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
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
  focused = true,
  title = '채팅',
  footer = '↑/↓ 이동 · Enter 열기 · q 종료',
  emptyText = '표시할 항목이 없습니다.',
  initialRoomId,
  activeRoomId,
  onCancel,
}: Props): React.JSX.Element {
  // 1단계: 최근 활동 순으로 정렬하고, 선택 인덱스가 목록 범위를 벗어나지 않게 보정합니다.
  const sorted = useMemo(() => [...rooms].sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)), [rooms]);
  const initialIndex = initialRoomId ? sorted.findIndex((room) => room.id === initialRoomId) : 0;
  const [index, setIndex] = useState(Math.max(0, initialIndex));
  const sel = Math.min(index, Math.max(0, sorted.length - 1));
  const totalUnread = rooms.reduce((sum, room) => sum + (unread[room.id] ?? 0), 0);

  useInput((_input, key) => {
    if (!focused || sorted.length === 0) return;
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

  // 2단계: 선택된 항목이 화면 안에 남도록 목록 윈도우를 이동합니다.
  const start = sorted.length === 0
    ? 0
    : Math.max(0, Math.min(sel - Math.floor(VISIBLE / 2), sorted.length - VISIBLE));
  const view = sorted.slice(Math.max(0, start), Math.max(0, start) + VISIBLE);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box justifyContent="space-between">
        <Text bold color="yellow">
          {title}
        </Text>
        {focused ? <Text color="green"> 활성</Text> : null}
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor>{rooms.length}개</Text>
        <Text color={totalUnread > 0 ? 'red' : 'gray'}>합계: {totalUnread} 읽지 않음</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {view.length === 0 ? <Text dimColor>{emptyText}</Text> : null}
        {view.map((room) => {
          const n = unread[room.id] ?? 0;
          const marker = typeMarker(room.type);
          const active = room.id === sorted[sel]?.id;
          const current = room.id === activeRoomId;
          const lastLine = [room.lastMessage, relTime(room.lastAt)].filter(Boolean).join(' · ');
          return (
            <Box key={room.id} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={active ? 'cyan' : undefined}>{active ? '> ' : '  '}</Text>
                {n > 0 ? (
                  <Text color="red">{clipText(`● ${n}`, 5).padEnd(5, ' ')}</Text>
                ) : (
                  <Text dimColor>{'     '}</Text>
                )}
                <Text color={marker.color}>{marker.label} </Text>
                <Text bold={active}>{clipText(room.name, 16)}</Text>
                {current ? <Text color="green"> 현재</Text> : null}
              </Box>
              <Text dimColor>    {clipText(lastLine, 34)}</Text>
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
