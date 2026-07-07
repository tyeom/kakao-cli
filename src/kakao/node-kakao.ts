import { EventEmitter } from 'node:events';
// node-kakao is CommonJS. Its named ESM exports are NOT all detectable by Node's
// cjs-module-lexer (enums/re-exports like KnownChatType, getOriginalType are
// missed at runtime), so `import { KnownChatType } from 'node-kakao'` throws
// "does not provide an export named 'KnownChatType'" under Node's ESM loader.
// The reliable interop is the DEFAULT import (= the whole module.exports, which
// carries every value at runtime) + destructure. Type-only imports are erased,
// so they're taken by name below without issue.
import kakao from 'node-kakao';
import type {
  OAuthCredential,
  TalkClient,
  TalkChannel,
  Chatlog,
  ChatType,
  ClientConfig,
} from 'node-kakao';

// Values via the default import; TalkClient is used only as a type here (its
// one runtime use is `new kakao.TalkClient(...)`), so it stays a type import.
const { Long, KnownChatType, getOriginalType } = kakao;
import type {
  Credential,
  KakaoClient,
  Message,
  Room,
  RoomType,
} from './client.js';

// ---------------------------------------------------------------------------
// NodeKakaoClient — the real KakaoClient adapter over node-kakao's TalkClient.
//
// Quirks that drove this code (verified against the installed .d.ts / .js):
//  - node-kakao (v4.5.0, unmaintained since 2021) is CJS with no usable named
//    ESM exports — every runtime value comes via the default import (see the
//    interop note at the top of this file); type-only imports are by name.
//  - 64-bit ids (channel/log/user) are bson `Long`; ALWAYS `.toString()` for our
//    string ids and rebuild with `Long.fromString()` — never coerce to number.
//  - `Chatlog.sendAt` is ALREADY epoch **ms**: node-kakao's structToChatlog does
//    `sendAt: struct.sendAt * 1000` (the wire value is seconds). No conversion.
//  - node-kakao's async ops return a `CommandResult` discriminated union
//    (`{ success:false, status } | { success:true, status, result }`), NOT throws.
// ---------------------------------------------------------------------------

// Shared with auth.ts. The device name shown in Kakao's registered-device list.
export const DEVICE_NAME = 'kakao-cli';

// Single patch point for Kakao's rotating protocol constants. node-kakao ships
// its own defaults (LOCO RSA public key `locoPEMPublicKey`, booking/checkin
// hosts, client `appVersion`/`agent`, handshake) in its internal
// `DefaultConfiguration`; we intentionally hardcode NONE of them here. If live
// login breaks in 2026 because Kakao rotated the RSA key / bumped the required
// app version / changed the handshake, override ONLY the changed fields in this
// object — it is passed to both TalkClient and AuthApiClient.create (auth.ts).
export const PROTOCOL_CONFIG: Partial<ClientConfig> = {
  // e.g. locoPEMPublicKey: '-----BEGIN PUBLIC KEY----- ...',
  // e.g. appVersion: '3.x.x', agent: 'win32',
};

// Human-paced sends: Kakao returns status -303 (CHAT_SPAM_LIMIT) when messages
// are sent too fast. Keep at least this gap between our sends.
const SEND_THROTTLE_MS = 400;

// How many recent messages getMessages() returns when no limit is given.
const DEFAULT_MESSAGE_LIMIT = 100;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Map a chat type to display text. Text-bearing types return their text; media /
// sticker / file types return a Korean placeholder (we don't render media). The
// type is unmasked with getOriginalType() first so deleted messages still resolve
// to their base type rather than a garbage (bit-masked) value.
function chatText(type: ChatType, text: string | undefined): string {
  switch (getOriginalType(type)) {
    case KnownChatType.TEXT:
    case KnownChatType.REPLY:
      return text ?? '';
    case KnownChatType.PHOTO:
    case KnownChatType.MULTIPHOTO:
      return '[사진]';
    case KnownChatType.VIDEO:
      return '[동영상]';
    case KnownChatType.AUDIO:
      return '[음성메시지]';
    case KnownChatType.FILE:
      return '[파일]';
    case KnownChatType.STICKER:
    case KnownChatType.STICKERANI:
    case KnownChatType.STICKERGIF:
    case KnownChatType.DITEMEMOTICON:
    case KnownChatType.ACTIONCON:
      return '[이모티콘]';
    case KnownChatType.MAP:
      return '[지도]';
    case KnownChatType.CONTACT:
      return '[연락처]';
    case KnownChatType.FEED:
      return text && text.length > 0 ? text : '[알림]';
    default:
      return text && text.length > 0 ? text : '[메시지]';
  }
}

export class NodeKakaoClient extends EventEmitter implements KakaoClient {
  private client: TalkClient | null = null;
  private myUserId = '';
  private lastSendAt = 0;

  async login(cred: Credential): Promise<void> {
    // Rebuild node-kakao's OAuthCredential; userId must be a Long again.
    const oauthCred: OAuthCredential = {
      userId: Long.fromString(cred.userId),
      deviceUUID: cred.deviceUUID,
      accessToken: cred.accessToken,
      refreshToken: cred.refreshToken,
    };

    const client = new kakao.TalkClient(PROTOCOL_CONFIG);
    // login() performs LOGINLIST and populates client.channelList + clientUser.
    const res = await client.login(oauthCred);
    if (!res.success) {
      throw new Error(
        `node-kakao login failed (status ${res.status}). The saved token may be ` +
          `expired/invalid, or the protocol may have drifted (re-run login-test).`,
      );
    }

    this.client = client;
    this.myUserId = cred.userId;
    this.attachListeners(client);
    // Deferred so a caller attaching 'connected' right after `await login()`
    // still observes it.
    queueMicrotask(() => this.emit('connected'));
  }

  async listRooms(): Promise<Room[]> {
    const client = this.require();
    const rooms: Room[] = [];
    // channelList.all() chains the normal + open sub-lists into one iterator.
    for (const channel of client.channelList.all()) {
      rooms.push(this.channelToRoom(channel));
    }
    return rooms;
  }

  async getMessages(
    roomId: string,
    opts?: { limit?: number; before?: string },
  ): Promise<Message[]> {
    const client = this.require();
    const channel = client.channelList.get(Long.fromString(roomId));
    if (!channel) throw new Error(`room not found: ${roomId}`);

    // Pull a recent window from the server (MCHATLOGS). node-kakao's local
    // chatListStore is not backfilled on login, so a server fetch is the
    // reliable source of history.
    // NOTE (unverified without a live account): the exact size/ordering of the
    // window MCHATLOGS returns for `since 0` is a node-kakao/server detail; we
    // defensively sort by logId and take the newest `limit`. `before` paginates
    // WITHIN this fetched window only — deep history paging is out of scope.
    const res = await channel.getChatListFrom();
    if (!res.success) {
      throw new Error(`failed to load messages (status ${res.status})`);
    }

    let logs: Chatlog[] = [...res.result];
    if (opts?.before) {
      const beforeId = Long.fromString(opts.before);
      logs = logs.filter((log) => log.logId.lessThan(beforeId));
    }
    logs.sort((a, b) => a.logId.compare(b.logId)); // oldest -> newest

    const limit = opts?.limit ?? DEFAULT_MESSAGE_LIMIT;
    const window = logs.slice(Math.max(0, logs.length - limit));
    return window.map((log) => this.chatlogToMessage(log, channel));
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    const client = this.require();
    const channel = client.channelList.get(Long.fromString(roomId));
    if (!channel) throw new Error(`room not found: ${roomId}`);

    // Throttle to stay under Kakao's send rate limit (-303).
    const wait = this.lastSendAt + SEND_THROTTLE_MS - Date.now();
    if (wait > 0) await delay(wait);
    this.lastSendAt = Date.now();

    const res = await channel.sendChat(text);
    if (!res.success) {
      throw new Error(
        res.status === -303
          ? 'send failed: rate limited (status -303) — slow down'
          : `send failed (status ${res.status})`,
      );
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) {
      // Drop our node-kakao listeners so the discarded client can't re-emit,
      // then close the LOCO session (stops the ping task + socket).
      client.removeAllListeners();
      try {
        client.close();
      } catch {
        // node-kakao's close() throws "Session is not created" if the session
        // was already torn down (e.g. after a server kickout). Ignore on teardown.
      }
    }
    this.emit('disconnected', 'client disconnect');
  }

  // --- internals ----------------------------------------------------------

  private require(): TalkClient {
    if (!this.client) throw new Error('not logged in — call login() first');
    return this.client;
  }

  // Re-emit node-kakao's events mapped onto OUR contract's events.
  private attachListeners(client: TalkClient): void {
    client.on('chat', (data, channel) => {
      this.emit('chat', this.chatlogToMessage(data.chat, channel));
      // Keep the room list fresh (new last message / bumped time), mirroring
      // the mock. Unread stays UI-owned — the UI increments on 'chat' itself.
      this.emit('room-update', this.channelToRoom(channel));
    });

    // Server kicked us (KickoutType: another logon, account deleted, etc.).
    client.on('disconnected', (reason) => {
      this.emit('disconnected', `kicked out (reason ${reason})`);
    });

    client.on('error', (err) => {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    // A channel was added or (re)joined -> surface it as a room update.
    client.on('channel_added', (channel) => {
      this.emit('room-update', this.channelToRoom(channel));
    });
    client.on('channel_join', (channel) => {
      this.emit('room-update', this.channelToRoom(channel));
    });
  }

  private channelToRoom(channel: TalkChannel): Room {
    const info = channel.info;
    const last = info.lastChatLog;
    return {
      id: channel.channelId.toString(),
      name: channel.getDisplayName(),
      type: this.roomTypeOf(channel),
      // Initial server-side unread; newChatCountInvalid means the count is stale.
      unreadCount: info.newChatCountInvalid ? 0 : info.newChatCount,
      lastMessage: last ? chatText(last.type, last.text) : undefined,
      lastAt: last ? last.sendAt : undefined, // already epoch ms
    };
  }

  private roomTypeOf(channel: TalkChannel): RoomType {
    // Open channels live in the open sub-list; look it up by id.
    if (this.require().channelList.open.get(channel.channelId)) return 'open';
    // Normal channel: 1:1 (<=2 users incl. me) is direct, otherwise group.
    return channel.userCount <= 2 ? 'direct' : 'group';
  }

  private chatlogToMessage(
    log: Readonly<Chatlog>,
    channel: TalkChannel,
  ): Message {
    const sender = channel.getUserInfo(log.sender);
    return {
      id: log.logId.toString(),
      roomId: channel.channelId.toString(),
      senderId: log.sender.userId.toString(),
      senderName: sender?.nickname ?? '(알 수 없음)',
      text: chatText(log.type, log.text),
      at: log.sendAt, // already epoch ms (structToChatlog multiplies secs*1000)
      isMine: log.sender.userId.toString() === this.myUserId,
    };
  }
}
