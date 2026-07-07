import { EventEmitter } from 'node:events';
import type { Credential, KakaoClient, Message, Room } from './client.js';

// ---------------------------------------------------------------------------
// MockKakaoClient — an in-memory stand-in for the real QR/V2SL LOCO adapter.
// The ink UI (Wave 2, Worker U) is developed and tested entirely against this,
// so it deliberately exercises every UI path: mixed room types, unread badges,
// stable per-room history, live incoming messages, and outgoing echoes.
//
// Emits the same events as the contract:
//   'chat'(Message) | 'room-update'(Room)
//   'connected'() | 'disconnected'(reason)
// Unread is UI-owned; the mock only carries each room's INITIAL unreadCount.
// ---------------------------------------------------------------------------

interface Participant {
  id: string;
  name: string;
}

const ME: Participant = { id: 'me', name: '나' };

const GROUP_MEMBERS: Participant[] = [
  { id: 'u-minjun', name: '김민준' },
  { id: 'u-seoyeon', name: '이서연' },
  { id: 'u-jiho', name: '박지호' },
  { id: 'u-hayoon', name: '최하윤' },
  { id: 'u-doyun', name: '정도윤' },
];

const OPEN_MEMBERS: Participant[] = [
  { id: 'o-dev01', name: '자바초보' },
  { id: 'o-dev02', name: '리액트마스터' },
  { id: 'o-dev03', name: '코드리뷰어' },
  { id: 'o-dev04', name: '야근요정' },
  { id: 'o-dev05', name: '커피중독' },
];

const CHAT_LINES: string[] = [
  '안녕하세요!',
  '넵 확인했습니다.',
  '지금 한번 확인해볼게요.',
  '오 그거 좋네요 👍',
  '내일 몇 시에 만날까요?',
  '점심 뭐 드셨어요?',
  '방금 푸시했습니다.',
  '빌드 통과했어요 🎉',
  '그 부분은 제가 처리할게요.',
  '조금만 기다려 주세요.',
  'ㅋㅋㅋㅋ 진짜요?',
  '감사합니다 :)',
  '고생 많으셨습니다!',
  '회의 링크 공유드릴게요.',
  '이 에러 혹시 보신 적 있나요?',
  '재현이 잘 안 되네요...',
  '로그 한번 확인 부탁드려요.',
  '오늘 오후에 배포 예정입니다.',
  '주말 잘 보내세요~',
  '넵 알겠습니다.',
];

// FNV-1a hash → 32-bit unsigned; used to derive a per-room RNG seed.
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 — tiny deterministic PRNG so each room's history is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildRooms(): Room[] {
  const now = Date.now();
  const min = 60_000;
  return [
    {
      id: '100001',
      name: '김민준',
      type: 'direct',
      unreadCount: 0,
      lastMessage: '내일 회의 몇 시였죠?',
      lastAt: now - 8 * min,
    },
    {
      id: '100002',
      name: '가족 단톡방',
      type: 'group',
      unreadCount: 3,
      lastMessage: '엄마: 저녁은 먹었니?',
      lastAt: now - 3 * min,
    },
    {
      id: '100003',
      name: '프로젝트 A 팀',
      type: 'group',
      unreadCount: 0,
      lastMessage: '배포 완료했습니다 🚀',
      lastAt: now - 42 * min,
    },
    {
      id: '100004',
      name: '☕ 코딩 오픈챗',
      type: 'open',
      unreadCount: 7,
      lastMessage: '이 에러 어떻게 해결하나요?',
      lastAt: now - 1 * min,
    },
    {
      id: '100005',
      name: '이서연',
      type: 'direct',
      unreadCount: 1,
      lastMessage: '넵 감사합니다!',
      lastAt: now - 20 * min,
    },
  ];
}

function membersFor(room: Room | undefined): Participant[] {
  if (!room) return GROUP_MEMBERS;
  if (room.type === 'direct') return [{ id: `${room.id}-peer`, name: room.name }];
  if (room.type === 'open') return OPEN_MEMBERS;
  return GROUP_MEMBERS;
}

export class MockKakaoClient extends EventEmitter implements KakaoClient {
  private readonly rooms: Room[] = buildRooms();
  private readonly logs = new Map<string, Message[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private runtimeSeq = 0;

  async login(_cred: Credential): Promise<void> {
    this.startRealtime();
    // Defer so a caller that attaches the listener right after `await login()`
    // still observes the event.
    queueMicrotask(() => this.emit('connected'));
  }

  async listRooms(): Promise<Room[]> {
    return this.rooms.map((room) => ({ ...room }));
  }

  async getMessages(
    roomId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<Message[]> {
    const log = this.ensureLog(roomId);

    let slice = log;
    if (opts?.before) {
      const idx = log.findIndex((m) => m.id === opts.before);
      slice = idx >= 0 ? log.slice(0, idx) : log;
    }
    const limit = opts?.limit ?? slice.length;
    return slice.slice(Math.max(0, slice.length - limit)).map((m) => ({ ...m }));
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    const log = this.ensureLog(roomId);
    const msg: Message = {
      id: `${roomId}-rt${++this.runtimeSeq}`,
      roomId,
      senderId: ME.id,
      senderName: ME.name,
      text,
      at: Date.now(),
      isMine: true,
    };
    log.push(msg);
    const room = this.rooms.find((r) => r.id === roomId);
    if (room) {
      room.lastMessage = text;
      room.lastAt = msg.at;
    }
    // Echo on the next tick, mirroring an async server round-trip.
    queueMicrotask(() => {
      this.emit('chat', msg);
      if (room) this.emit('room-update', { ...room });
    });
  }

  async disconnect(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emit('disconnected', 'client disconnect');
  }

  // --- internals ----------------------------------------------------------

  private ensureLog(roomId: string): Message[] {
    let log = this.logs.get(roomId);
    if (!log) {
      log = this.generateLog(roomId);
      this.logs.set(roomId, log);
    }
    return log;
  }

  private generateLog(roomId: string): Message[] {
    const room = this.rooms.find((r) => r.id === roomId);
    const rand = mulberry32(hashString(roomId));
    const members = membersFor(room);
    const count = 25;
    const messages: Message[] = [];
    // Walk time forward so the log ends near "now" in ascending order.
    let at = Date.now() - count * 90_000;
    for (let i = 0; i < count; i++) {
      const mine = rand() < 0.4;
      const sender = mine ? ME : members[Math.floor(rand() * members.length)];
      const text = CHAT_LINES[Math.floor(rand() * CHAT_LINES.length)];
      at += 30_000 + Math.floor(rand() * 120_000);
      messages.push({
        id: `${roomId}-h${i}`,
        roomId,
        senderId: sender.id,
        senderName: sender.name,
        text,
        at,
        isMine: mine,
      });
    }
    return messages;
  }

  private startRealtime(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 4000);
  }

  private tick(): void {
    const room = this.rooms[Math.floor(Math.random() * this.rooms.length)];
    const members = membersFor(room);
    const sender = members[Math.floor(Math.random() * members.length)];
    const msg: Message = {
      id: `${room.id}-rt${++this.runtimeSeq}`,
      roomId: room.id,
      senderId: sender.id,
      senderName: sender.name,
      text: CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)],
      at: Date.now(),
      isMine: false,
    };
    this.ensureLog(room.id).push(msg);
    room.lastMessage = msg.text;
    room.lastAt = msg.at;
    this.emit('chat', msg);
    this.emit('room-update', { ...room });
  }
}
