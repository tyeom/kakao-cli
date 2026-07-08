import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { API_SAMPLE_HTML } from './sample-html.js';
import type { AuthProvider, Credential, KakaoClient, Message, Room, RoomType } from '../kakao/client.js';
import { ForgeKakaoClient } from '../kakao/forge-client.js';
import { MockKakaoClient } from '../kakao/mock.js';
import { NodeKakaoAuth } from '../kakao/auth.js';
import { MockAuthProvider } from '../kakao/mock-auth.js';

export type ApiBackendMode = 'live' | 'mock';

export interface ApiServerOptions {
  port: number;
  host?: string;
  mode: ApiBackendMode;
  client: KakaoClient;
}

export interface ApiModeOptions {
  port: number;
  host?: string;
  mode: ApiBackendMode;
}

export interface ApiServerHandle {
  port: number;
  host: string;
  close(): Promise<void>;
}

interface ApiRoom {
  id: string;
  name: string;
  type: RoomType;
  typeLabel: '1:1' | 'Group' | '오픈';
  unreadCount: number;
  lastMessage?: string;
  lastAt?: number;
}

interface ApiMessage {
  id: string;
  roomId: string;
  roomType: ApiRoom['typeLabel'];
  timestamp: number;
  time: string;
  nickname: string;
  message: string;
  senderId: string;
  isMine: boolean;
}

interface WebSocketReadyPayload {
  type: 'ready';
  room: ApiRoom;
}

interface WebSocketMessagePayload {
  type: 'message';
  room: ApiRoom;
  message: ApiMessage;
}

const DEFAULT_API_HOST = '127.0.0.1';
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class WebSocketPeer {
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(
    private readonly socket: Socket,
    readonly roomId: string,
    private readonly onClose: (peer: WebSocketPeer) => void,
  ) {
    this.socket.setKeepAlive(true);
    this.socket.on('data', (chunk) => this.handleData(chunk));
    this.socket.on('close', () => this.markClosed());
    this.socket.on('error', () => this.markClosed());
  }

  sendJson(payload: unknown): void {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(payload), 'utf8'));
  }

  close(): void {
    if (this.closed) return;
    this.sendFrame(0x8, Buffer.alloc(0));
    this.socket.end();
    this.markClosed();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        const bigLength = this.buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.close();
          return;
        }
        payloadLength = Number(bigLength);
        offset += 8;
      }

      const maskLength = masked ? 4 : 0;
      const frameLength = offset + maskLength + payloadLength;
      if (this.buffer.length < frameLength) return;

      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
      this.buffer = this.buffer.subarray(frameLength);

      if (mask) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] = payload[i]! ^ mask[i % 4]!;
        }
      }

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
      }
      // 현재 샘플 HTML은 클라이언트 -> 서버 메시지를 WebSocket으로 보내지 않습니다.
      // 텍스트 전송은 중복 ACK 처리를 피하기 위해 HTTP POST만 사용합니다.
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;

    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    this.socket.write(Buffer.concat([header, payload]));
  }
}

export async function startApiMode(options: ApiModeOptions): Promise<ApiServerHandle> {
  const mode = options.mode;
  const { client, auth } = createBackend(mode);

  await loginForApiMode(client, auth, mode);
  const handle = await startApiServer({
    port: options.port,
    host: options.host || process.env.KAKAO_API_HOST || DEFAULT_API_HOST,
    mode,
    client,
  });

  console.log(`API 서버 실행 중: http://${handle.host}:${handle.port}`);
  console.log(`샘플 HTML: http://${handle.host}:${handle.port}/`);
  console.log('종료: Ctrl+C');

  const shutdown = (): void => {
    void handle.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return handle;
}

export async function startApiServer(options: ApiServerOptions): Promise<ApiServerHandle> {
  const host = options.host || DEFAULT_API_HOST;
  const roomCache = new Map<string, Room>();
  const peersByRoom = new Map<string, Set<WebSocketPeer>>();

  const updateRooms = (rooms: Room[]): void => {
    for (const room of rooms) {
      const prev = roomCache.get(room.id);
      roomCache.set(room.id, { ...prev, ...room });
    }
  };

  const rooms = await options.client.listRooms();
  updateRooms(rooms);

  const broadcast = (roomId: string, payload: WebSocketMessagePayload): void => {
    const peers = peersByRoom.get(roomId);
    if (!peers) return;
    for (const peer of peers) peer.sendJson(payload);
  };

  const onChat = (msg: Message): void => {
    const room = roomCache.get(msg.roomId) || fallbackRoom(msg.roomId);
    const apiRoom = toApiRoom(room);
    broadcast(msg.roomId, {
      type: 'message',
      room: apiRoom,
      message: toApiMessage(msg, apiRoom),
    });
  };

  const onRoomUpdate = (room: Room): void => {
    updateRooms([room]);
  };

  options.client.on('chat', onChat);
  options.client.on('room-update', onRoomUpdate);

  const server = createServer(async (req, res) => {
    try {
      await handleHttpRequest(req, res, options.client, roomCache, updateRooms, options.mode);
    } catch (err) {
      sendError(res, err);
    }
  });

  server.on('upgrade', (req, socket) => {
    try {
      handleWebSocketUpgrade(req, socket as Socket, roomCache, peersByRoom);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
    }
  });

  await listen(server, options.port, host);
  const address = server.address() as AddressInfo;

  return {
    host,
    port: address.port,
    async close(): Promise<void> {
      for (const peers of peersByRoom.values()) {
        for (const peer of peers) peer.close();
      }
      options.client.off('chat', onChat);
      options.client.off('room-update', onRoomUpdate);
      await closeServer(server);
      await options.client.disconnect();
    },
  };
}

function createBackend(mode: ApiBackendMode): { client: KakaoClient; auth: AuthProvider } {
  if (mode === 'mock') {
    return { client: new MockKakaoClient(), auth: new MockAuthProvider() };
  }
  return { client: new ForgeKakaoClient(), auth: new NodeKakaoAuth() };
}

async function loginForApiMode(client: KakaoClient, auth: AuthProvider, mode: ApiBackendMode): Promise<void> {
  const saved = await auth.loadSaved();
  if (saved) {
    try {
      await client.login(saved);
      console.log(mode === 'live' ? '저장된 auth.json으로 live 연결 완료' : 'mock 인증 완료');
      return;
    } catch (err) {
      console.error(
        `저장된 로그인 정보로 연결하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`,
      );
      await auth.logout();
    }
  }

  console.log(mode === 'live' ? '저장된 auth.json이 없어 QR 로그인을 시작합니다.' : 'mock 로그인을 시작합니다.');
  const cred = await auth.login({
    onQrCode: (qr) => {
      console.log(qr);
    },
    onPasscode: (passcode) => {
      console.log(`휴대폰 확인 코드: ${passcode}`);
    },
    onStatus: (status) => {
      console.log(`[login] ${status}`);
    },
  });
  await client.login(cred);
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  client: KakaoClient,
  roomCache: Map<string, Room>,
  updateRooms: (rooms: Room[]) => void,
  mode: ApiBackendMode,
): Promise<void> {
  applyCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const segments = splitPath(url.pathname);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    sendHtml(res, API_SAMPLE_HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, mode });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    const rooms = await client.listRooms();
    updateRooms(rooms);
    sendJson(res, 200, { rooms: rooms.map(toApiRoom) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/friends') {
    const rooms = await client.listRooms();
    updateRooms(rooms);
    // 현재 LOCO 클라이언트에는 독립 친구 목록 API가 없으므로 1:1 대화방을 친구 항목으로 노출합니다.
    const friends = rooms.filter((room) => room.type === 'direct').map((room) => ({
      id: room.id,
      roomId: room.id,
      nickname: room.name,
      name: room.name,
      type: room.type,
      typeLabel: roomTypeLabel(room.type),
      unreadCount: room.unreadCount,
      lastMessage: room.lastMessage,
      lastAt: room.lastAt,
    }));
    sendJson(res, 200, { friends });
    return;
  }

  if (segments[0] === 'api' && segments[1] === 'rooms' && segments[2] && segments[3] === 'messages') {
    const roomId = segments[2];
    if (req.method === 'GET') {
      const limit = clampLimit(Number(url.searchParams.get('limit') || 30), 1, 100);
      const before = url.searchParams.get('before') || undefined;
      const messages = await client.getMessages(roomId, { limit, before });
      const room = roomCache.get(roomId) || fallbackRoom(roomId);
      const apiRoom = toApiRoom(room);
      sendJson(res, 200, { messages: messages.map((msg) => toApiMessage(msg, apiRoom)) });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const message = messageTextOf(body);
      if (!message.trim()) throw new HttpError(400, 'EMPTY_MESSAGE', 'message 또는 text 값이 필요합니다.');

      await client.sendMessage(roomId, message);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  throw new HttpError(404, 'NOT_FOUND', '요청 경로를 찾을 수 없습니다.');
}

function handleWebSocketUpgrade(
  req: IncomingMessage,
  socket: Socket,
  roomCache: Map<string, Room>,
  peersByRoom: Map<string, Set<WebSocketPeer>>,
): void {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const segments = splitPath(url.pathname);
  const roomId = segments[0] === 'ws' && segments[1] === 'rooms' ? segments[2] : url.searchParams.get('roomId');
  if (!roomId) throw new Error('missing roomId');

  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') throw new Error('missing websocket key');

  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );

  const peer = new WebSocketPeer(socket, roomId, (closed) => {
    const peers = peersByRoom.get(closed.roomId);
    if (!peers) return;
    peers.delete(closed);
    if (peers.size === 0) peersByRoom.delete(closed.roomId);
  });

  const peers = peersByRoom.get(roomId) || new Set<WebSocketPeer>();
  peers.add(peer);
  peersByRoom.set(roomId, peers);

  const room = toApiRoom(roomCache.get(roomId) || fallbackRoom(roomId));
  const ready: WebSocketReadyPayload = { type: 'ready', room };
  peer.sendJson(ready);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new HttpError(413, 'BODY_TOO_LARGE', '요청 본문이 너무 큽니다.');
    }
    chunks.push(buf);
  }

  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'JSON 본문을 파싱할 수 없습니다.');
  }
}

function messageTextOf(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  const value = record.message ?? record.text;
  return typeof value === 'string' ? value : '';
}

function toApiRoom(room: Room): ApiRoom {
  return {
    id: room.id,
    name: room.name,
    type: room.type,
    typeLabel: roomTypeLabel(room.type),
    unreadCount: room.unreadCount,
    lastMessage: room.lastMessage,
    lastAt: room.lastAt,
  };
}

function toApiMessage(msg: Message, room: ApiRoom): ApiMessage {
  return {
    id: msg.id,
    roomId: msg.roomId,
    roomType: room.typeLabel,
    timestamp: msg.at,
    time: new Date(msg.at).toISOString(),
    nickname: msg.senderName,
    message: msg.text,
    senderId: msg.senderId,
    isMine: msg.isMine,
  };
}

function fallbackRoom(roomId: string): Room {
  return {
    id: roomId,
    name: `(채팅방 ${roomId})`,
    type: 'group',
    unreadCount: 0,
  };
}

function roomTypeLabel(type: RoomType): ApiRoom['typeLabel'] {
  if (type === 'direct') return '1:1';
  if (type === 'open') return '오픈';
  return 'Group';
}

function splitPath(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function clampLimit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function applyCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }

  const statusCode = err instanceof HttpError ? err.statusCode : 500;
  const code = err instanceof HttpError ? err.code : 'INTERNAL_ERROR';
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, statusCode, {
    error: {
      code,
      message,
    },
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
