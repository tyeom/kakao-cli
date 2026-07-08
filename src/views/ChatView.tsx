import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { KakaoClient, Message, Room } from '../kakao/client.js';

interface Props {
  client: KakaoClient;
  room: Room;
  focused?: boolean;
}

const VISIBLE = 12; // Ink에는 네이티브 스크롤이 없어서 렌더링할 메시지 행 수를 제한합니다.

const TYPE_LABEL: Record<Room['type'], string> = {
  direct: '[1:1]',
  group: '[그룹]',
  open: '[오픈]',
};

function messageLines(text: string): string[] {
  return text.split('\n');
}

function charLength(value: string): number {
  return Array.from(value).length;
}

function sliceChars(chars: string[], start: number, end?: number): string {
  return chars.slice(start, end).join('');
}

function insertAtCursor(value: string, cursor: number, input: string): { value: string; cursor: number } {
  const chars = Array.from(value);
  const safeCursor = Math.max(0, Math.min(cursor, chars.length));
  const nextInput = input.replace(/\r/g, '');
  return {
    value: `${sliceChars(chars, 0, safeCursor)}${nextInput}${sliceChars(chars, safeCursor)}`,
    cursor: safeCursor + charLength(nextInput),
  };
}

function deleteBeforeCursor(value: string, cursor: number): { value: string; cursor: number } {
  const chars = Array.from(value);
  const safeCursor = Math.max(0, Math.min(cursor, chars.length));
  if (safeCursor === 0) return { value, cursor: safeCursor };
  chars.splice(safeCursor - 1, 1);
  return { value: chars.join(''), cursor: safeCursor - 1 };
}

function deleteAtCursor(value: string, cursor: number): { value: string; cursor: number } {
  const chars = Array.from(value);
  const safeCursor = Math.max(0, Math.min(cursor, chars.length));
  if (safeCursor >= chars.length) return { value, cursor: safeCursor };
  chars.splice(safeCursor, 1);
  return { value: chars.join(''), cursor: safeCursor };
}

interface DraftLine {
  chars: string[];
  start: number;
}

function draftLines(value: string): DraftLine[] {
  const lines: DraftLine[] = [{ chars: [], start: 0 }];
  let cursor = 0;

  // 줄바꿈도 커서가 지나갈 수 있는 문자로 계산합니다.
  for (const char of Array.from(value)) {
    if (char === '\n') {
      lines.push({ chars: [], start: cursor + 1 });
    } else {
      lines[lines.length - 1].chars.push(char);
    }
    cursor += 1;
  }

  return lines;
}

function cursorLineColumn(value: string, cursor: number): { lineIndex: number; column: number; lines: DraftLine[] } {
  const lines = draftLines(value);
  const safeCursor = Math.max(0, Math.min(cursor, charLength(value)));

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (safeCursor >= lines[i].start) {
      return {
        lineIndex: i,
        column: Math.min(safeCursor - lines[i].start, lines[i].chars.length),
        lines,
      };
    }
  }

  return { lineIndex: 0, column: 0, lines };
}

function moveCursorVertical(value: string, cursor: number, delta: number): number {
  const current = cursorLineColumn(value, cursor);
  const nextLineIndex = Math.max(0, Math.min(current.lines.length - 1, current.lineIndex + delta));
  const nextLine = current.lines[nextLineIndex];
  return nextLine.start + Math.min(current.column, nextLine.chars.length);
}

function moveCursorToLineEdge(value: string, cursor: number, edge: 'start' | 'end'): number {
  const current = cursorLineColumn(value, cursor);
  const line = current.lines[current.lineIndex];
  return edge === 'start' ? line.start : line.start + line.chars.length;
}

function formatMessageTime(at: number): string {
  const date = new Date(at);
  const now = new Date();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');

  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return `${hh}:${mm}`;
  }

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}/${day} ${hh}:${mm}`;
}

export default function ChatView({ client, room, focused = true }: Props): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [draftCursor, setDraftCursor] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // 최신 메시지에 붙어 있는지 기록합니다. 붙어 있으면 새 메시지가 올 때 자동으로 아래로 이동합니다.
  const stick = useRef(true);

  const maxScroll = Math.max(0, messages.length - VISIBLE);

  // 방이 바뀌면 최근 대화를 다시 읽고, 처음에는 가장 아래 메시지를 보여줍니다.
  useEffect(() => {
    let alive = true;
    stick.current = true;
    void (async () => {
      try {
        setHistoryError(null);
        const history = await client.getMessages(room.id, { limit: 30 });
        if (alive) setMessages(history);
      } catch (err) {
        // 히스토리 조회 실패는 실시간 수신/전송과 별개이므로 화면만 유지합니다.
        if (alive) {
          setHistoryError(err instanceof Error ? err.message : String(err));
          setMessages([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, room.id]);

  // 현재 방으로 들어오는 실시간 메시지와 내 전송 echo만 대화 로그에 붙입니다.
  useEffect(() => {
    const onChat = (msg: Message): void => {
      if (msg.roomId !== room.id) return;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    };
    client.on('chat', onChat);
    return () => {
      client.off('chat', onChat);
    };
  }, [client, room.id]);

  // 사용자가 맨 아래를 보고 있을 때만 새 메시지를 따라 자동 스크롤합니다.
  useEffect(() => {
    if (stick.current) setScrollTop(Math.max(0, messages.length - VISIBLE));
  }, [messages.length]);

  useInput((_input, key) => {
    if (!focused) return;
    if (key.return && key.shift) {
      const next = insertAtCursor(draft, draftCursor, '\n');
      setDraft(next.value);
      setDraftCursor(next.cursor);
      return;
    }
    if (key.return) {
      send(draft);
      return;
    }
    if (key.leftArrow) {
      setDraftCursor((cursor) => Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      setDraftCursor((cursor) => Math.min(charLength(draft), cursor + 1));
      return;
    }
    if (key.home) {
      setDraftCursor((cursor) => moveCursorToLineEdge(draft, cursor, 'start'));
      return;
    }
    if (key.end) {
      setDraftCursor((cursor) => moveCursorToLineEdge(draft, cursor, 'end'));
      return;
    }
    if (key.backspace) {
      const next = deleteBeforeCursor(draft, draftCursor);
      setDraft(next.value);
      setDraftCursor(next.cursor);
      return;
    }
    if (key.delete) {
      const next = deleteAtCursor(draft, draftCursor);
      setDraft(next.value);
      setDraftCursor(next.cursor);
      return;
    }
    if (key.tab || key.escape || (key.ctrl && _input === 'c')) return;

    if (key.upArrow && draft.length > 0) {
      setDraftCursor((cursor) => moveCursorVertical(draft, cursor, -1));
    } else if (key.downArrow && draft.length > 0) {
      setDraftCursor((cursor) => moveCursorVertical(draft, cursor, 1));
    } else if (key.upArrow)
      setScrollTop((s) => {
        const n = Math.max(0, s - 1);
        stick.current = n >= maxScroll;
        return n;
      });
    else if (key.downArrow)
      setScrollTop((s) => {
        const n = Math.min(maxScroll, s + 1);
        stick.current = n >= maxScroll;
        return n;
      });
    else if (key.pageUp)
      setScrollTop((s) => {
        stick.current = false;
        return Math.max(0, s - VISIBLE);
      });
    else if (key.pageDown)
      setScrollTop((s) => {
        const n = Math.min(maxScroll, s + VISIBLE);
        stick.current = n >= maxScroll;
        return n;
      });
    else if (_input) {
      const next = insertAtCursor(draft, draftCursor, _input);
      setDraft(next.value);
      setDraftCursor(next.cursor);
    }
  });

  const send = (text: string): void => {
    const trimmed = text.trim();
    setDraft('');
    setDraftCursor(0);
    if (!trimmed) return;
    stick.current = true;
    setSendError(null);
    if (trimmed === '/paste-image' || trimmed === '/img') {
      if (!client.sendClipboardImage) {
        setSendError('클립보드 이미지 전송은 live 모드에서만 지원됩니다.');
        return;
      }
      void client.sendClipboardImage(room.id).catch((err) => {
        // 이미지 업로드 실패도 텍스트 전송 실패와 동일하게 현재 화면에만 표시합니다.
        setSendError(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    void client.sendMessage(room.id, trimmed).catch((err) => {
      // 전송 실패는 프로세스를 죽이지 않고 현재 채팅 화면에만 표시합니다.
      setSendError(err instanceof Error ? err.message : String(err));
    });
  };

  const visible = messages.slice(scrollTop, scrollTop + VISIBLE);
  const hiddenAbove = scrollTop;
  const hiddenBelow = Math.max(0, messages.length - (scrollTop + VISIBLE));
  const renderedDraftLines = draftLines(draft);
  const cursorInfo = cursorLineColumn(draft, draftCursor);

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="space-between">
        <Text bold color="yellow">
          {TYPE_LABEL[room.type]} {room.name}
        </Text>
        <Text color={focused ? 'green' : 'gray'}>{focused ? '활성' : '대기'}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} minHeight={VISIBLE}>
        {historyError ? <Text color="yellow">이전 메시지 로드 실패: {historyError}</Text> : null}
        {hiddenAbove > 0 ? <Text dimColor>↑ 이전 메시지 {hiddenAbove}개</Text> : null}
        {visible.map((m) => {
          const lines = messageLines(m.text);
          return (
            <Box key={m.id} flexDirection="column">
              <Text color={m.isMine ? 'green' : undefined}>
                <Text dimColor>[{formatMessageTime(m.at)}] </Text>
                <Text bold color={m.isMine ? 'green' : 'cyan'}>
                  {m.senderName}
                </Text>
                : {lines[0]}
              </Text>
              {lines.slice(1).map((line, index) => (
                <Text key={`${m.id}-${index}`} color={m.isMine ? 'green' : undefined}>
                  {'  '}
                  {line}
                </Text>
              ))}
            </Box>
          );
        })}
        {hiddenBelow > 0 ? <Text dimColor>↓ 이후 메시지 {hiddenBelow}개</Text> : null}
      </Box>

      <Box
        marginTop={1}
        borderStyle="round"
        borderColor={focused ? 'cyan' : 'gray'}
        paddingX={1}
        flexDirection="column"
      >
        {draft.length === 0 ? (
          <Box>
            <Text color={focused ? 'green' : 'gray'}>{'> '}</Text>
            {focused ? <Text inverse> </Text> : null}
            <Text dimColor>메시지 입력 후 Enter</Text>
          </Box>
        ) : (
          renderedDraftLines.map((line, index) => (
            <Box key={index}>
              <Text color={focused ? 'green' : 'gray'}>{index === 0 ? '> ' : '| '}</Text>
              {index === cursorInfo.lineIndex ? (
                <Text>
                  {sliceChars(line.chars, 0, cursorInfo.column)}
                  <Text inverse>{line.chars[cursorInfo.column] ?? ' '}</Text>
                  {sliceChars(line.chars, cursorInfo.column + 1)}
                </Text>
              ) : (
                <Text>{line.chars.join('') || ' '}</Text>
              )}
            </Box>
          ))
        )}
        <Text dimColor>Enter 전송 · Shift+Enter 줄바꿈 · ←/→ 커서</Text>
        <Text dimColor>Backspace/Delete 삭제 · /paste-image 이미지</Text>
      </Box>
      {sendError ? (
        <Box marginTop={1}>
          <Text color="red">전송 오류: {sendError}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
