import { EventEmitter } from 'node:events';
import { Long } from 'bson';
import type { Credential, KakaoClient, Message, Room, RoomType } from './client.js';
import {
  BookingClient,
  CarriageClient,
  TicketClient,
  idToString,
  toLong,
} from './forge-protocol.js';
import { readClipboardImageToTempFile } from './clipboard-image.js';
import { uploadPhotoFromPath } from './media-upload.js';

const DEFAULT_MESSAGE_LIMIT = 100;
const SEND_THROTTLE_MS = 400;
const WRITE_ACK_TIMEOUT_MS = 20_000;
const CLIENT_MSG_ID_MAX_MOD = 2_147_483_547;
const CLIENT_MSG_ID_STEP = 100;
const RECONNECT_MIN_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = Number(process.env.KAKAO_PING_INTERVAL_MS || 30_000);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface RoomCacheEntry extends Room {
  lastLogId?: string;
  lastLog?: any;
  openLinkId?: string;
}

interface ClientMsgIdState {
  deviceHash: number;
  lastId: number;
  lastGenId: number;
}

interface PendingWriteAck {
  roomId: string;
  text: string;
  resolve: (msg: Message) => void;
  timer: NodeJS.Timeout;
}

interface ChangedRoom {
  roomId: string;
  previousLastLogId: string;
  nextLastLogId: string;
}

export class ForgeKakaoClient extends EventEmitter implements KakaoClient {
  private carriage: CarriageClient | null = null;
  private credential: Credential | null = null;
  private myUserId = '';
  private lastSendAt = 0;
  private lastTokenId = '0';
  private lastChatId = '0';
  private openLinkSyncToken = '0';
  private msgIdState: ClientMsgIdState | null = null;
  private readonly rooms = new Map<string, RoomCacheEntry>();
  private readonly roomAliases = new Map<string, string>();
  private readonly serverRoomToUiRoom = new Map<string, string>();
  private readonly openLinkNames = new Map<string, string>();
  private readonly memberNames = new Map<string, Map<string, string>>();
  private readonly memberListFetches = new Map<string, Promise<string[]>>();
  private readonly pendingWriteAcks: PendingWriteAck[] = [];
  private readonly roomMsgIds = new Map<string, number>();
  private pushSyncInFlight = false;
  private chatListRefreshPromise: Promise<ChangedRoom[]> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private reconnectAttempt = 0;
  private disconnectRequested = false;

  async login(cred: Credential): Promise<void> {
    this.credential = cred;
    this.disconnectRequested = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.myUserId = cred.userId;
    this.msgIdState = createClientMsgIdState(cred.deviceUUID || cred.userId);

    await this.connectWithCredential(cred);
    queueMicrotask(() => this.emit('connected'));
  }

  private async connectWithCredential(cred: Credential): Promise<void> {
    const checkin = await this.checkin(cred.userId);
    if (!checkin.host || !checkin.port) {
      throw new Error(`CHECKIN failed: no host/port (status ${checkin.status})`);
    }

    const previous = this.carriage;
    this.carriage = null;
    if (previous) {
      previous.removeAllListeners();
      previous.disconnect();
    }

    const carriage = new CarriageClient();
    carriage.on('push', (packet) => this.handlePush(packet.method, packet.body));
    carriage.on('error', (err) => this.handleCarriageError(err instanceof Error ? err : new Error(String(err))));
    carriage.on('disconnected', () => this.handleCarriageDisconnected());

    await carriage.connect(checkin.host, checkin.port);
    const login = await carriage.loginList(cred);
    if (login.status !== 0) {
      carriage.removeAllListeners();
      carriage.disconnect();
      throw new Error(`LOGINLIST failed (status ${login.status})`);
    }

    this.carriage = carriage;
    this.applyChatList(login.body);
    await this.syncOpenLinks();
    await this.resolveMissingOpenLinkNames();
    this.applyOpenLinkNames();
    carriage.startPing(Number.isFinite(PING_INTERVAL_MS) && PING_INTERVAL_MS > 0 ? PING_INTERVAL_MS : 30_000);
  }

  async listRooms(): Promise<Room[]> {
    // 현재 캐시가 있으면 서버에 증분 목록을 요청하고, 실패 시 캐시를 그대로 보여줍니다.
    if (this.rooms.size > 0) {
      try {
        await this.refreshChatList();
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }

    await this.resolveFallbackRoomNames();
    return [...this.rooms.values()];
  }

  async getMessages(roomId: string, opts?: { limit?: number; before?: string }): Promise<Message[]> {
    if (!opts?.before && process.env.KAKAO_SYNC_HISTORY !== '1') {
      const cachedLog = this.rooms.get(roomId)?.lastLog;
      return cachedLog ? [this.chatLogToMessage(roomId, cachedLog)] : [];
    }

    const carriage = this.require();
    const serverRoomId = this.resolveRoomId(roomId);
    const limit = opts?.limit ?? DEFAULT_MESSAGE_LIMIT;
    // 화면 최초 진입은 "현재 lastLogId 이후"가 아니라 최근 로그 묶음을 받아야 하므로 0부터 동기화합니다.
    // before가 들어온 경우에만 호출자가 지정한 커서를 그대로 사용합니다.
    const cur = opts?.before || 0;
    const res = await carriage.syncMsg(serverRoomId, cur, limit);
    if (res.status !== 0) {
      throw new Error(`failed to load messages (status ${res.status})`);
    }

    const logs = extractChatLogs(res.body);
    if (logs.length === 0) {
      const cachedLog = this.rooms.get(roomId)?.lastLog;
      return cachedLog ? [this.chatLogToMessage(roomId, cachedLog)] : [];
    }

    const messages = logs.map((log) => this.chatLogToMessage(roomId, log));
    messages.sort((a, b) => compareId(a.id, b.id));
    return messages.slice(Math.max(0, messages.length - limit));
  }

  async sendMessage(roomId: string, text: string): Promise<void> {
    const serverRoomId = this.resolveRoomId(roomId);
    const msgId = this.nextRoomMsgId(serverRoomId);
    await this.sendMessageAttempt(roomId, text, msgId, true);
  }

  async sendClipboardImage(roomId: string): Promise<void> {
    const image = await readClipboardImageToTempFile();
    try {
      await this.sendImageFile(roomId, image.path, image.filename);
    } finally {
      await image.cleanup();
    }
  }

  private async sendImageFile(roomId: string, filePath: string, filename?: string): Promise<void> {
    const carriage = await this.requireConnected();
    const wait = this.lastSendAt + SEND_THROTTLE_MS - Date.now();
    if (wait > 0) await delay(wait);
    this.lastSendAt = Date.now();

    const serverRoomId = this.resolveRoomId(roomId);
    const result = await uploadPhotoFromPath({
      carriage,
      chatId: serverRoomId,
      userId: this.myUserId,
      filePath,
      filename,
    });

    const log = result.chatLog || result.complete?.chatLog || null;
    const msg = log
      ? this.chatLogToMessage(roomId, {
          ...log,
          chatId: roomId,
          authorId: log.authorId || this.myUserId,
          msg: log.msg || '[사진]',
        })
      : {
          id: `${Date.now()}-${result.accessKey}`,
          roomId,
          senderId: this.myUserId,
          senderName: '나',
          text: '[사진]',
          at: Date.now(),
          isMine: true,
        };

    this.updateRoomFromMessage(msg);
    this.emit('chat', msg);
  }

  private async sendMessageAttempt(roomId: string, text: string, msgId: number, allowRetry: boolean): Promise<void> {
    const carriage = await this.requireConnected();
    const wait = this.lastSendAt + SEND_THROTTLE_MS - Date.now();
    if (wait > 0) await delay(wait);
    this.lastSendAt = Date.now();

    const serverRoomId = this.resolveRoomId(roomId);

    const ack = this.waitForWriteAck(roomId, text);
    const write = carriage.write(serverRoomId, text, msgId, WRITE_ACK_TIMEOUT_MS);
    const writeResult = write.then(
      (packet) => ({ kind: 'write' as const, packet }),
      (err) => ({ kind: 'write-error' as const, err }),
    );
    const ackResult = ack.promise.then(
      (msg) => ({ kind: 'ack' as const, msg }),
      (err) => ({ kind: 'ack-error' as const, err }),
    );

    try {
      const result = await Promise.race([writeResult, ackResult]);
      if (result.kind === 'ack') return;
      if (result.kind === 'ack-error') {
        const writeOnly = await writeResult;
        if (writeOnly.kind === 'write-error') {
          if (allowRetry && isRequestTimeoutError(writeOnly.err)) {
            // WRITE 응답과 MSG echo가 모두 없으면 stale socket으로 보고 재연결 후 한 번만 재시도합니다.
            await this.reconnectNow(writeOnly.err);
            return this.sendMessageAttempt(roomId, text, msgId, false);
          }
          throw writeOnly.err;
        }
        this.handleWriteResponse(roomId, text, writeOnly.packet);
        return;
      }
      if (result.kind === 'write-error') {
        // 서버가 WRITE 응답을 누락해도 MSG push가 늦게 올 수 있어 짧게 한 번 더 기다립니다.
        const lateAck = await Promise.race([
          ackResult,
          delay(2_000).then(() => ({ kind: 'ack-grace-timeout' as const })),
        ]);
        if (lateAck.kind === 'ack') return;
        if (allowRetry && isRequestTimeoutError(result.err)) {
          // ACK grace 이후에도 아무 응답이 없을 때만 같은 msgId로 재시도해 중복 위험을 낮춥니다.
          await this.reconnectNow(result.err);
          return this.sendMessageAttempt(roomId, text, msgId, false);
        }
        throw result.err;
      }
      this.handleWriteResponse(roomId, text, result.packet);
    } finally {
      ack.cancel();
    }
  }

  private handleWriteResponse(
    roomId: string,
    text: string,
    res: Awaited<ReturnType<CarriageClient['write']>>,
  ): void {
    if (res.status !== 0) {
      throw new Error(res.status === -303 ? 'send failed: rate limited (status -303)' : `send failed (status ${res.status})`);
    }

    const log = res.body?.chatLog || res.body?.log || res.body;
    if (log) {
      const msg = this.chatLogToMessage(roomId, {
        ...log,
        msg: text,
        text,
        chatId: roomId,
        authorId: this.myUserId,
      });
      this.updateRoomFromMessage(msg);
      this.emit('chat', msg);
    }
  }

  async disconnect(): Promise<void> {
    this.disconnectRequested = true;
    this.clearReconnectTimer();
    const carriage = this.carriage;
    this.carriage = null;
    this.clearPendingWriteAcks();
    carriage?.disconnect();
    this.emit('disconnected', 'client disconnect');
  }

  private require(): CarriageClient {
    if (!this.carriage) throw new Error('not logged in - call login() first');
    return this.carriage;
  }

  private async requireConnected(): Promise<CarriageClient> {
    if (!this.carriage && !this.disconnectRequested && this.credential) {
      // 재연결 예약 대기 중 사용자가 바로 전송하면 예약 시간을 기다리지 않고 즉시 복구를 시도합니다.
      await this.reconnectNow(new Error('carriage not connected'));
    }
    return this.require();
  }

  private handleCarriageError(err: Error): void {
    this.emitError(err);
    if (isRequestTimeoutError(err)) this.scheduleReconnect(err);
  }

  private handleCarriageDisconnected(): void {
    this.carriage = null;
    this.emit('disconnected', 'carriage disconnected');
    this.scheduleReconnect(new Error('carriage disconnected'));
  }

  private scheduleReconnect(reason: unknown): void {
    if (this.disconnectRequested || !this.credential) return;
    if (this.reconnectTimer || this.reconnectPromise) return;

    this.reconnectAttempt += 1;
    const delayMs = Math.min(
      RECONNECT_MIN_DELAY_MS * 2 ** Math.max(0, this.reconnectAttempt - 1),
      RECONNECT_MAX_DELAY_MS,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectNow(reason).catch((err) => {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      });
    }, delayMs);
  }

  private async reconnectNow(reason?: unknown): Promise<void> {
    if (this.disconnectRequested || !this.credential) {
      throw new Error('not logged in - call login() first');
    }
    if (this.reconnectPromise) return this.reconnectPromise;

    this.clearReconnectTimer();
    const cred = this.credential;
    this.reconnectPromise = (async () => {
      try {
        await this.connectWithCredential(cred);
        this.reconnectAttempt = 0;
        this.emit('connected');
      } catch (err) {
        this.scheduleReconnect(err);
        throw err;
      }
    })().finally(() => {
      this.reconnectPromise = null;
    });

    return this.reconnectPromise;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async checkin(userId: string) {
    const booking = new BookingClient();
    await booking.connect();
    try {
      const conf = await booking.getConf(userId).catch(() => ({ hosts: [], ports: [] }));
      for (const host of conf.hosts) {
        for (const port of conf.ports) {
          const ticket = new TicketClient();
          try {
            await ticket.connect(host, port);
            const result = await ticket.checkin(userId);
            if (result.host && result.port) return result;
          } catch {
            // 다음 ticket endpoint를 시도합니다.
          } finally {
            ticket.disconnect();
          }
        }
      }
      return await booking.checkin(userId);
    } finally {
      booking.disconnect();
    }
  }

  private handlePush(method: string, body: any): void {
    if (method === 'MSG') {
      void this.handleMsgPush(body);
      return;
    }

    if (method === 'CHATINFO' || method === 'UPDATECHAT') {
      this.applyChatList({ chats: [body?.chatInfo || body?.chat || body?.chatRoom || body] });
      return;
    }

    if (method === 'BLSYNC') {
      void this.handleBLSync(body);
    }
  }

  private async handleMsgPush(body: any): Promise<void> {
    const serverRoomId = idToString(body?.chatId || body?.c || body?.chatLog?.chatId || body?.chatLog?.c);
    const roomId = this.toUiRoomId(serverRoomId);
    const log = body?.chatLog
      ? {
          ...body.chatLog,
          chatId: body.chatLog.chatId || body.chatId,
          authorNickname: body.chatLog.authorNickname || body.authorNickname,
          authorNickName: body.chatLog.authorNickName || body.authorNickName,
        }
      : body;
    if (!roomId || !log) return;

    await this.resolveMissingSenderName(roomId, log);
    const msg = this.chatLogToMessage(roomId, log);
    this.updateRoomFromMessage(msg);
    this.emit('chat', msg);
    this.resolveWriteAck(msg);
  }

  private async handleBLSync(body: any): Promise<void> {
    if (!this.carriage) return;

    const directLogs = extractChatLogs(body);
    for (const log of directLogs) {
      const serverRoomId = idToString(log?.chatId || log?.chatRoomId || log?.roomId || log?.c);
      if (!serverRoomId) continue;
      this.emitChatLog(this.toUiRoomId(serverRoomId), log);
    }

    if (this.pushSyncInFlight) return;
    this.pushSyncInFlight = true;
    try {
      await this.refreshChatList();
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.pushSyncInFlight = false;
    }
  }

  private async refreshChatList(): Promise<ChangedRoom[]> {
    if (this.chatListRefreshPromise) return this.chatListRefreshPromise;

    this.chatListRefreshPromise = this.refreshChatListNow().finally(() => {
      this.chatListRefreshPromise = null;
    });
    return this.chatListRefreshPromise;
  }

  private async refreshChatListNow(): Promise<ChangedRoom[]> {
    const carriage = this.require();
    const before = new Map<string, string>();
    const chatIds: Long[] = [];
    const maxIds: Long[] = [];

    for (const room of this.rooms.values()) {
      const lastLogId = room.lastLogId || '0';
      before.set(room.id, lastLogId);
      chatIds.push(toLong(room.id));
      maxIds.push(toLong(lastLogId));
    }

    const res = await carriage.lchatList(chatIds, maxIds, this.lastTokenId, this.lastChatId);
    if (res.status !== 0) return [];

    const lastLogs = this.collectChangedLastLogs(res.body, before);
    this.applyChatList(res.body);
    await this.syncOpenLinks();
    await this.resolveMissingOpenLinkNames();
    this.applyOpenLinkNames();

    const changedRooms: ChangedRoom[] = [];
    for (const room of this.rooms.values()) {
      const previousLastLogId = before.get(room.id) || '0';
      const nextLastLogId = room.lastLogId || '0';
      if (compareId(nextLastLogId, previousLastLogId) <= 0) continue;
      changedRooms.push({ roomId: room.id, previousLastLogId, nextLastLogId });
    }

    for (const { roomId, log } of lastLogs) {
      this.emitChatLog(roomId, log);
    }

    return changedRooms;
  }

  private collectChangedLastLogs(body: any, before: Map<string, string>): Array<{ roomId: string; log: any }> {
    const logs: Array<{ roomId: string; log: any }> = [];
    for (const chat of extractChatList(body)) {
      const roomId = idToString(chat?.chatId || chat?.id || chat?.roomId || chat?.chatRoomId || chat?.c);
      if (!roomId) continue;

      const log = lastLogOf(chat);
      if (!log) continue;

      const previousLastLogId = before.get(roomId) || '0';
      const nextLastLogId = idToString(log?.logId || log?.msgId || chat?.lastChatLogId || chat?.lastLogId || chat?.ll);
      if (!nextLastLogId || compareId(nextLastLogId, previousLastLogId) <= 0) continue;
      logs.push({ roomId, log });
    }
    return logs;
  }

  private emitChatLog(roomId: string, log: any): void {
    if (!roomId || !log) return;

    // BLSYNC/LCHATLIST/SYNCMSG는 같은 로그를 다른 형태로 줄 수 있어 Message id 기준 중복은 UI에서 제거합니다.
    const msg = this.chatLogToMessage(roomId, {
      ...log,
      chatId: roomId,
    });
    this.updateRoomFromMessage(msg);
    this.emit('chat', msg);
    this.resolveWriteAck(msg);
  }

  private applyChatList(body: any): void {
    const chats = extractChatList(body);
    for (const chat of chats) {
      const room = this.chatToRoom(chat);
      if (!room) continue;
      this.recordRoomAlias(room.id, room.id);
      this.rooms.set(room.id, { ...this.rooms.get(room.id), ...room });
      this.emit('room-update', room);
    }

    if (body?.lastTokenId !== undefined) this.lastTokenId = idToString(body.lastTokenId);
    if (body?.lastChatId !== undefined) this.lastChatId = idToString(body.lastChatId);
  }

  private chatToRoom(chat: any): RoomCacheEntry | null {
    const id = idToString(chat?.chatId || chat?.id || chat?.roomId || chat?.chatRoomId || chat?.c);
    if (!id) return null;

    this.cacheMembersFromChat(id, chat);
    const displayMembers = displayMemberNamesOf(chat);
    const rawTitle = titleOf(chat);
    const memberTitle = displayMembers.join(', ');
    const previousName = this.rooms.get(id)?.name || '';
    const type = roomTypeOf(chat, displayMembers.length);
    const openLinkId = openLinkIdOf(chat) || this.rooms.get(id)?.openLinkId || '';
    const openLinkName = openLinkId ? this.openLinkNames.get(openLinkId) || '' : '';
    const title =
      type === 'open'
        ? (rawTitle && !isFallbackRoomName(rawTitle, id) ? rawTitle : '') ||
          openLinkName ||
          (previousName && !isFallbackRoomName(previousName, id) && previousName !== memberTitle ? previousName : '') ||
          `(오픈채팅 ${id})`
        : (rawTitle && !isFallbackRoomName(rawTitle, id) ? rawTitle : '') ||
          memberTitle ||
          (previousName && !isFallbackRoomName(previousName, id) ? previousName : '') ||
          rawTitle ||
          `(채팅방 ${id})`;
    const lastLog = lastLogOf(chat);
    const lastAt = timestampOf(lastLog?.sendAt || lastLog?.createdAt || chat.updatedAt || chat.lastUpdatedAt);
    const unread = Number(chat.newMessageCount ?? chat.unreadCount ?? chat.newChatCount ?? 0);

    return {
      id,
      name: title,
      type,
      unreadCount: Number.isFinite(unread) ? unread : 0,
      lastMessage: textOf(lastLog),
      lastAt,
      lastLogId: idToString(lastLog?.logId || lastLog?.msgId || chat.lastChatLogId || chat.lastLogId || chat.ll),
      lastLog,
      openLinkId,
    };
  }

  private chatLogToMessage(roomId: string, log: any): Message {
    const senderId = senderIdOf(log);
    const senderName = this.resolveSenderName(roomId, log, senderId);
    return {
      id: idToString(log.logId || log.msgId || log.id || this.nextClientMsgId()),
      roomId,
      senderId,
      senderName,
      text: textOf(log),
      at: timestampOf(log.sendAt || log.createdAt || log.created_at || Date.now()) || Date.now(),
      isMine: senderId === this.myUserId,
    };
  }

  private updateRoomFromMessage(msg: Message): void {
    const prev = this.rooms.get(msg.roomId);
    const next: RoomCacheEntry = {
      id: msg.roomId,
      name: prev?.name || `(채팅방 ${msg.roomId})`,
      type: prev?.type || 'group',
      unreadCount: prev?.unreadCount || 0,
      lastMessage: msg.text,
      lastAt: msg.at,
      lastLogId: msg.id,
    };
    this.rooms.set(msg.roomId, next);
    this.emit('room-update', next);
  }

  private async resolveFallbackRoomNames(): Promise<void> {
    const carriage = this.carriage;
    if (!carriage) return;

    for (const room of this.rooms.values()) {
      if (!isFallbackRoomName(room.name, room.id)) continue;

      // 1단계: CHATINFO에는 title/chatMetas/displayMembers가 더 풍부하게 내려오는 경우가 있습니다.
      try {
        const info = await carriage.chatInfo(room.id);
        if (info.status === 0) {
          const chat = info.body?.chatInfo || info.body?.chat || info.body?.chatRoom || info.body;
          const enriched = this.chatToRoom({ ...chat, chatId: room.id });
          this.cacheMembersFromChat(room.id, chat);
          if (enriched && !isFallbackRoomName(enriched.name, room.id)) {
            const next = { ...room, ...enriched };
            this.rooms.set(room.id, next);
            this.emit('room-update', next);
            continue;
          }
        }
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }

      // 2단계: 1:1/그룹방은 MEMLIST의 멤버 이름만으로도 최소한 사람이 읽을 수 있는 이름을 만들 수 있습니다.
      if (room.type === 'open') continue;
      try {
        const names = await this.fetchMemberNames(room.id);
        if (names.length > 0) {
          const name = names.slice(0, 5).join(', ');
          const next = { ...room, name };
          this.rooms.set(room.id, next);
          this.emit('room-update', next);
        }
      } catch (err) {
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private async fetchMemberNames(roomId: string): Promise<string[]> {
    const key = this.resolveRoomId(roomId);
    const inFlight = this.memberListFetches.get(key);
    if (inFlight) return inFlight;

    const task = this.fetchMemberNamesNow(roomId).finally(() => {
      this.memberListFetches.delete(key);
    });
    this.memberListFetches.set(key, task);
    return task;
  }

  private async fetchMemberNamesNow(roomId: string): Promise<string[]> {
    const carriage = this.require();
    const names = new Set<string>();
    let token: string | number = 0;

    // KakaoForge와 같이 token 기반 페이지를 따르되, 터미널 목록 표시 목적이라 최대 5페이지로 제한합니다.
    for (let page = 0; page < 5; page += 1) {
      const res = await carriage.memList(roomId, token);
      if (res.status !== 0) break;
      const body = res.body || {};
      const members = body.members || body.memberList || body.memList || [];
      if (Array.isArray(members)) {
        this.cacheMembers(roomId, members);
        for (const member of members) {
          const userId = idToString(member?.userId || member?.id || member?.memberId || member?.user_id);
          if (userId && userId === this.myUserId) continue;
          const name = memberNameOf(member);
          if (name) names.add(name);
        }
      }

      const nextToken = idToString(body.token || body.nextToken || body.memberToken || 0);
      if (!nextToken || nextToken === '0' || nextToken === idToString(token)) break;
      token = nextToken;
    }

    return [...names];
  }

  private async resolveMissingSenderName(roomId: string, log: any): Promise<void> {
    const senderId = senderIdOf(log);
    if (!senderId || senderId === this.myUserId) return;
    if (rawSenderNameOf(log)) return;
    if (this.cachedMemberName(roomId, senderId)) return;

    const room = this.rooms.get(roomId);
    if (room?.type === 'direct' && !isFallbackRoomName(room.name, room.id)) return;

    try {
      // MSG 패킷에 이름이 없으면 방 멤버 목록에서 authorId -> 닉네임을 보강합니다.
      await this.fetchMemberNames(roomId);
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private resolveSenderName(roomId: string, log: any, senderId: string): string {
    const rawName = rawSenderNameOf(log);
    if (rawName) return rawName;

    const cached = senderId ? this.cachedMemberName(roomId, senderId) : '';
    if (cached) return cached;

    const room = this.rooms.get(roomId);
    if (senderId && senderId !== this.myUserId && room?.type === 'direct' && !isFallbackRoomName(room.name, room.id)) {
      return room.name;
    }

    return senderId === this.myUserId ? '나' : '(알 수 없음)';
  }

  private cacheMembersFromChat(roomId: string, chat: any): void {
    for (const key of ['displayMembers', 'members', 'memberList', 'memList', 'chatMembers']) {
      const members = chat?.[key];
      if (Array.isArray(members)) this.cacheMembers(roomId, members);
    }
  }

  private cacheMembers(roomId: string, members: any[]): void {
    for (const member of members) {
      const userId = idToString(member?.userId || member?.id || member?.memberId || member?.user_id);
      const name = memberNameOf(member);
      if (userId && name) this.cacheMemberName(roomId, userId, name);
    }
  }

  private cacheMemberName(roomId: string, userId: string, name: string): void {
    const cleanName = name.trim();
    if (!roomId || !userId || !cleanName) return;

    for (const key of this.memberCacheKeys(roomId)) {
      const map = this.memberNames.get(key) || new Map<string, string>();
      map.set(userId, cleanName);
      this.memberNames.set(key, map);
    }
  }

  private cachedMemberName(roomId: string, userId: string): string {
    if (!roomId || !userId) return '';
    for (const key of this.memberCacheKeys(roomId)) {
      const name = this.memberNames.get(key)?.get(userId);
      if (name) return name;
    }
    return '';
  }

  private memberCacheKeys(roomId: string): string[] {
    const ui = idToString(roomId);
    const server = this.resolveRoomId(ui);
    const mappedUi = this.toUiRoomId(server);
    return [...new Set([ui, server, mappedUi].filter(Boolean))];
  }

  private async syncOpenLinks(): Promise<void> {
    const carriage = this.carriage;
    if (!carriage) return;

    try {
      const res = await carriage.syncLink(this.openLinkSyncToken);
      if (res.status !== 0) return;
      this.cacheOpenLinks(res.body?.ols || res.body?.links || []);
      if (res.body?.ltk !== undefined) this.openLinkSyncToken = idToString(res.body.ltk);
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private applyOpenLinkNames(): void {
    for (const room of this.rooms.values()) {
      if (room.type !== 'open' || !room.openLinkId) continue;
      const name = this.openLinkNames.get(room.openLinkId);
      if (!name || room.name === name) continue;
      const next = { ...room, name };
      this.rooms.set(room.id, next);
      this.emit('room-update', next);
    }
  }

  private async resolveMissingOpenLinkNames(): Promise<void> {
    const carriage = this.carriage;
    if (!carriage) return;

    const missing = [...new Set(
      [...this.rooms.values()]
        .filter((room) => room.type === 'open' && room.openLinkId && !this.openLinkNames.has(room.openLinkId))
        .map((room) => room.openLinkId as string),
    )];
    if (missing.length === 0) return;

    try {
      const res = await carriage.infoLink(missing);
      if (res.status === 0) {
        this.cacheOpenLinks(res.body?.ols || res.body?.links || []);
      }
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private cacheOpenLinks(list: any[]): void {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const id = idToString(item?.li || item?.linkId || item?.id || item?.openLinkId);
      const name = String(item?.ln || item?.linkName || item?.name || item?.title || '').trim();
      if (id && name) this.openLinkNames.set(id, name);
    }
  }

  private recordRoomAlias(uiRoomId: string, serverRoomId: string): void {
    const ui = idToString(uiRoomId);
    const server = idToString(serverRoomId || uiRoomId);
    if (!ui || !server) return;

    this.roomAliases.set(ui, server);
    this.roomAliases.set(server, server);
    this.serverRoomToUiRoom.set(server, ui);

    // JS number로 변환되며 생기는 근사 문자열도 같은 방으로 매핑합니다.
    for (const id of [ui, server]) {
      if (!/^\d{16,}$/.test(id)) continue;
      const approx = String(Number(id));
      if (approx && approx !== id) {
        this.roomAliases.set(approx, server);
        this.serverRoomToUiRoom.set(approx, ui);
      }
    }
  }

  private resolveRoomId(roomId: string): string {
    const key = idToString(roomId);
    return this.roomAliases.get(key) || key;
  }

  private toUiRoomId(serverRoomId: string): string {
    const key = idToString(serverRoomId);
    return this.serverRoomToUiRoom.get(key) || key;
  }

  private nextClientMsgId(): number {
    if (!this.msgIdState) this.msgIdState = createClientMsgIdState(this.myUserId);
    const state = this.msgIdState;
    const gen = clientMsgBaseId(Date.now(), state.deviceHash);

    // Kakao Android client와 같은 32비트 범위 msgId를 유지합니다.
    // 너무 큰 Long을 보내면 WRITE 응답이 오지 않고 timeout으로 끝날 수 있습니다.
    if (gen <= state.lastId && gen >= state.lastGenId) {
      let next = state.lastId + CLIENT_MSG_ID_STEP;
      if (next > 2_147_483_647) next = clientMsgBaseId(next, state.deviceHash);
      state.lastId = next;
      state.lastGenId = gen;
      return state.lastId;
    }

    state.lastId = gen;
    state.lastGenId = gen;
    return state.lastId;
  }

  private nextRoomMsgId(roomId: string): number {
    const key = this.resolveRoomId(roomId);
    const next = (this.roomMsgIds.get(key) || 0) + 1;
    this.roomMsgIds.set(key, next);
    return next;
  }

  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  private waitForWriteAck(roomId: string, text: string): {
    promise: Promise<Message>;
    cancel: () => void;
  } {
    let entry: PendingWriteAck;
    const promise = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removePendingWriteAck(entry);
        reject(new Error('send ack timed out'));
      }, WRITE_ACK_TIMEOUT_MS);
      entry = { roomId, text, resolve, timer };
      this.pendingWriteAcks.push(entry);
    });

    return {
      promise,
      cancel: () => this.removePendingWriteAck(entry),
    };
  }

  private resolveWriteAck(msg: Message): void {
    if (!msg.isMine) return;
    const index = this.pendingWriteAcks.findIndex(
      (entry) => this.sameRoom(entry.roomId, msg.roomId) && entry.text === msg.text,
    );
    if (index < 0) return;
    const [entry] = this.pendingWriteAcks.splice(index, 1);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }

  private removePendingWriteAck(entry: PendingWriteAck | undefined): void {
    if (!entry) return;
    const index = this.pendingWriteAcks.indexOf(entry);
    if (index >= 0) this.pendingWriteAcks.splice(index, 1);
    clearTimeout(entry.timer);
  }

  private clearPendingWriteAcks(): void {
    for (const entry of this.pendingWriteAcks.splice(0)) {
      clearTimeout(entry.timer);
    }
  }

  private sameRoom(left: string, right: string): boolean {
    return this.resolveRoomId(left) === this.resolveRoomId(right);
  }
}

function extractChatList(body: any): any[] {
  if (!body) return [];
  if (Array.isArray(body.chatDatas)) return body.chatDatas;
  if (Array.isArray(body.chatInfos)) return body.chatInfos;
  if (Array.isArray(body.chats)) return body.chats;
  if (Array.isArray(body.chatRooms)) return body.chatRooms;
  if (Array.isArray(body.chatList)) return body.chatList;
  return [];
}

function extractChatLogs(body: any): any[] {
  if (!body) return [];
  if (body.chatLog && typeof body.chatLog === 'object') return [body.chatLog];
  if (body.log && typeof body.log === 'object') return [body.log];
  if (body.l && looksLikeChatLog(body.l)) return [body.l];
  for (const key of ['chatLogs', 'logs', 'msgs', 'messages', 'l']) {
    const value = body[key];
    if (!Array.isArray(value)) continue;
    const logs = value.filter(looksLikeChatLog);
    if (logs.length > 0) return logs;
  }
  return [];
}

function lastLogOf(chat: any): any {
  if (!chat || typeof chat !== 'object') return null;
  if (chat.lastChatLog) return chat.lastChatLog;
  if (chat.lastLog) return chat.lastLog;
  if (chat.chatLog) return chat.chatLog;
  return looksLikeChatLog(chat.l) ? chat.l : null;
}

function looksLikeChatLog(value: any): boolean {
  if (!value || typeof value !== 'object' || Long.isLong(value)) return false;
  return Boolean(
    value.logId ||
      value.msgId ||
      value.msg ||
      value.message ||
      value.text ||
      value.content ||
      value.authorId ||
      value.senderId ||
      value.userId,
  );
}

function titleOf(chat: any): string {
  const direct = chat?.title || chat?.roomName || chat?.name || chat?.subject;
  if (direct) return String(direct);
  const meta = chat?.meta;
  if (typeof meta === 'string') {
    try {
      const parsed = JSON.parse(meta);
      return String(parsed?.title || parsed?.name || parsed?.subject || '');
    } catch {
      return meta.length <= 100 ? meta : '';
    }
  }
  if (meta && typeof meta === 'object') {
    const title = meta.title || meta.name || meta.subject;
    if (title) return String(title);
  }
  if (Array.isArray(chat?.chatMetas)) {
    const titleMeta = chat.chatMetas.find((item: any) => item?.type === 3);
    const title = titleOfMeta(titleMeta?.content ?? titleMeta);
    if (title) return title;
    for (const item of chat.chatMetas) {
      const fallback = titleOfMeta(item?.content ?? item);
      if (fallback) return fallback;
    }
  }
  return '';
}

function titleOfMeta(meta: any): string {
  if (!meta) return '';
  if (typeof meta === 'string') {
    const trimmed = meta.trim();
    if (!trimmed) return '';
    try {
      const parsed = JSON.parse(trimmed);
      return String(parsed?.title || parsed?.name || parsed?.subject || '');
    } catch {
      return trimmed.length <= 100 ? trimmed : '';
    }
  }
  if (typeof meta === 'object') {
    return String(meta.title || meta.name || meta.subject || '');
  }
  return '';
}

function roomTypeOf(chat: any, displayMemberCount: number): RoomType {
  const typeText = String(chat?.type || chat?.t || '').toLowerCase();
  if (
    chat?.isOpenChat ||
    chat?.openChat === true ||
    chat?.isOpen === true ||
    openLinkIdOf(chat) ||
    chat?.openToken ||
    chat?.otk ||
    typeText === 'om' ||
    typeText === 'od' ||
    typeText.includes('open')
  ) {
    return 'open';
  }
  if (chat?.isGroupChat || displayMemberCount > 1 || typeText.includes('group')) return 'group';
  return 'direct';
}

function openLinkIdOf(chat: any): string {
  const direct = idToString(chat?.openLinkId || chat?.openChatId || chat?.li || chat?.openLink || chat?.openChat);
  if (direct) return direct;

  const meta = parseMaybeJson(chat?.meta);
  const fromMeta = idToString(meta?.openLinkId || meta?.openChatId || meta?.openLink?.linkId || meta?.openLink?.li);
  if (fromMeta) return fromMeta;

  if (Array.isArray(chat?.chatMetas)) {
    for (const item of chat.chatMetas) {
      const parsed = parseMaybeJson(item?.content ?? item);
      const value = idToString(parsed?.openLinkId || parsed?.openChatId || parsed?.openLink?.linkId || parsed?.openLink?.li);
      if (value) return value;
    }
  }

  return '';
}

function textOf(log: any): string {
  if (!log) return '';
  const text = String(log.message || log.msg || log.text || log.content || log.attachment?.text || '');
  if (text) return text;

  const type = Number(idToString(log.type || log.msgType || log.t || 0));
  const attachment = parseMaybeJson(log.attachment ?? log.attachments ?? log.extra);
  const mime = String(attachment?.mt || attachment?.mime || '').toLowerCase();
  if (type === 2 || mime.startsWith('image/')) return '[사진]';
  if (type === 3 || mime.startsWith('video/')) return '[동영상]';
  if (type === 5 || mime.startsWith('audio/')) return '[음성]';
  if (type === 18 || attachment?.name || attachment?.filename) return '[파일]';

  return '';
}

function displayMemberNamesOf(chat: any): string[] {
  const names: string[] = [];

  if (Array.isArray(chat?.displayMembers)) {
    for (const member of chat.displayMembers) {
      const name = memberNameOf(member);
      if (name) names.push(name);
    }
  }

  for (const key of ['displayNickNames', 'displayNicknames', 'displayNames']) {
    if (!Array.isArray(chat?.[key])) continue;
    for (const raw of chat[key]) {
      const name = String(raw || '').trim();
      if (name) names.push(name);
    }
  }

  return [...new Set(names)];
}

function parseMaybeJson(input: any): any {
  if (!input) return null;
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function timestampOf(value: unknown): number | undefined {
  const n = Number(idToString(value));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n > 10_000_000_000 ? n : n * 1000;
}

function compareId(a: string, b: string): number {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  } catch {
    return a.localeCompare(b);
  }
}

function memberNameOf(member: any): string {
  return String(
    member?.nickName ||
      member?.nickname ||
      member?.name ||
      member?.profileName ||
      member?.displayName ||
      '',
  ).trim();
}

function senderIdOf(log: any): string {
  return idToString(log?.authorId || log?.senderId || log?.userId || log?.writerId || log?.sender?.userId);
}

function rawSenderNameOf(log: any): string {
  // 수신 MSG는 닉네임이 chatLog 내부가 아니라 패킷 최상위 authorNickname으로 오는 경우가 있습니다.
  // 여기서는 패킷 자체에 들어있는 이름만 추출하고, 캐시/방 이름 fallback은 호출부에서 처리합니다.
  return String(
    log?.authorNickname ||
      log?.authorNickName ||
      log?.authorName ||
      log?.senderName ||
      log?.nickName ||
      log?.nickname ||
      log?.name ||
      log?.sender?.nickName ||
      log?.sender?.nickname ||
      log?.sender?.name ||
      log?.user?.nickName ||
      log?.user?.nickname ||
      log?.user?.name ||
      '',
  ).trim();
}

function isFallbackRoomName(name: string, roomId: string): boolean {
  const trimmed = String(name || '').trim();
  if (!trimmed) return true;
  if (trimmed === roomId) return true;
  if (trimmed === `(채팅방 ${roomId})`) return true;
  return /^채팅방\s+\d+$/.test(trimmed);
}

function isRequestTimeoutError(err: unknown): boolean {
  return err instanceof Error && /^Request .+ timed out$/.test(err.message);
}

function createClientMsgIdState(seed: string): ClientMsgIdState {
  const deviceHash = javaStringHash(seed || '') % 100;
  const initial = clientMsgBaseId(Date.now(), deviceHash);
  return {
    deviceHash,
    lastId: initial,
    lastGenId: initial,
  };
}

function javaStringHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return hash;
}

function clientMsgBaseId(timeMillis: number, deviceHash: number): number {
  const base = Math.floor((timeMillis % CLIENT_MSG_ID_MAX_MOD) / CLIENT_MSG_ID_STEP) * CLIENT_MSG_ID_STEP;
  return base + deviceHash;
}
