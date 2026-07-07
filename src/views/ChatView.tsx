import { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { KakaoClient, Message, Room } from '../kakao/client.js';

interface Props {
  client: KakaoClient;
  room: Room;
}

const VISIBLE = 12; // rendered message rows (ink has no native scroll)

const TYPE_LABEL: Record<Room['type'], string> = {
  direct: '[1:1]',
  group: '[그룹]',
  open: '[오픈]',
};

export default function ChatView({ client, room }: Props): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // Whether the view is pinned to the newest message (autoscroll on incoming).
  const stick = useRef(true);

  const maxScroll = Math.max(0, messages.length - VISIBLE);

  // Load history when the room changes, then pin to the bottom.
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

  // Live incoming/echoed messages for THIS room append to the log.
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

  // Keep the newest message visible while stuck to the bottom.
  useEffect(() => {
    if (stick.current) setScrollTop(Math.max(0, messages.length - VISIBLE));
  }, [messages.length]);

  useInput((_input, key) => {
    if (key.upArrow)
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
  });

  const send = (text: string): void => {
    const trimmed = text.trim();
    setDraft('');
    if (!trimmed) return;
    stick.current = true;
    setSendError(null);
    void client.sendMessage(room.id, trimmed).catch((err) => {
      // 전송 실패는 프로세스를 죽이지 않고 현재 채팅 화면에만 표시합니다.
      setSendError(err instanceof Error ? err.message : String(err));
    });
  };

  const visible = messages.slice(scrollTop, scrollTop + VISIBLE);
  const hiddenAbove = scrollTop;
  const hiddenBelow = Math.max(0, messages.length - (scrollTop + VISIBLE));

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="space-between">
        <Text bold color="yellow">
          {TYPE_LABEL[room.type]} {room.name}
        </Text>
        <Text dimColor>Tab 방 전환 · Esc 뒤로 · ↑/↓ 스크롤</Text>
      </Box>

      <Box flexDirection="column" marginTop={1} minHeight={VISIBLE}>
        {historyError ? <Text color="yellow">이전 메시지 로드 실패: {historyError}</Text> : null}
        {hiddenAbove > 0 ? <Text dimColor>↑ 이전 메시지 {hiddenAbove}개</Text> : null}
        {visible.map((m) => (
          <Text key={m.id} color={m.isMine ? 'green' : undefined}>
            <Text bold color={m.isMine ? 'green' : 'cyan'}>
              {m.senderName}
            </Text>
            : {m.text}
          </Text>
        ))}
        {hiddenBelow > 0 ? <Text dimColor>↓ 이후 메시지 {hiddenBelow}개</Text> : null}
      </Box>

      <Box marginTop={1}>
        <Text color="green">{'> '}</Text>
        <TextInput
          value={draft}
          onChange={setDraft}
          onSubmit={send}
          focus
          placeholder="메시지 입력 후 Enter"
        />
      </Box>
      {sendError ? (
        <Box marginTop={1}>
          <Text color="red">전송 오류: {sendError}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
