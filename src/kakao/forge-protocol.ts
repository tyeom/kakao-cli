import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as zlib from 'node:zlib';
import { BSON, Long } from 'bson';

export const KAKAO_APP_VERSION = '26.1.2';
export const KAKAO_OS = 'android';
export const KAKAO_LANG = 'ko';
export const KAKAO_MCCMNC = '45005';
export const KAKAO_MODEL_NAME = 'SM-T733';
export const KAKAO_OS_VERSION = '14';

const KATALK_HOST = 'katalk.kakao.com';
const BOOKING_HOST = 'booking-loco.kakao.com';
const BOOKING_PORT = 443;
const QR_USER_AGENT = 'okhttp/4.12.0';
const METHOD_LENGTH = 11;
const HEADER_SIZE = 22;
const AES_KEY_SIZE = 16;
const AES_IV_SIZE = 12;
const ENCRYPTION_TYPE_AES_GCM128 = 3;
const MAX_V2SL_BLOCK_SIZE = 131_068;
const DEBUG_LOCO = process.env.KAKAO_DEBUG_LOCO === '1';

// KakaoForge(play2fly) V2SL 구현에서 확인한 현재 LOCO RSA 공개키입니다.
const RSA_MODULUS = Buffer.from(
  'A3B076E8C445851F19A670C231AAC6DB42EFD09717D06048A5CC56906CD1AB27' +
    'B9DF37FFD5017E7C13A1405B5D1C3E4879A6A499D3C618A72472B0B50CA5EF1E' +
    'F6EEA70369D9413FE662D8E2B479A9F72142EE70CEE6C2AD12045D52B25C4A20' +
    '4A28968E37F0BA6A49EE3EC9F2AC7A65184160F22F62C43A4067CD8D2A6F13D9' +
    'B8298AB002763D236C9D1879D7FCE5B8FA910882B21E15247E0D0A24791308E5' +
    '1983614402E9FA03057C57E9E178B1CC39FE67288EFC461945CBCAA11D1FCC12' +
    '3E750B861F0D447EBE3C115F411A42DC95DDB21DA42774A5BCB1DDF7FA5F1062' +
    '8010C74F36F31C40EFCFE289FD81BABA44A6556A6C301210414B6023C3F46371',
  'hex',
);

export interface QrGenerateResult {
  url: string;
  remainingSeconds: number;
}

export interface QrPollResult {
  status?: number;
  nextRequestIntervalInSeconds?: number;
  remainingSeconds?: number;
  passcode?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  user?: { userId?: number | string };
}

export interface CheckinResult {
  host: string;
  port: number;
  status: number;
}

export function buildAHeader(appVer = KAKAO_APP_VERSION): string {
  return `${KAKAO_OS}/${appVer}/${KAKAO_LANG}`;
}

export function buildUserAgent(appVer = KAKAO_APP_VERSION): string {
  return `KT/${appVer} An/${KAKAO_OS_VERSION} ${KAKAO_LANG}`;
}

export function buildDeviceId(deviceUuid: string): string {
  if (!deviceUuid) throw new Error('deviceUuid is required');
  if (/^[a-f0-9]{40,64}$/i.test(deviceUuid)) return deviceUuid;
  const seed = `dkljleskljfeisflssljeif ${deviceUuid}`;
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
}

export function generateDeviceUuid(): string {
  return buildDeviceId(`${crypto.randomUUID()}-${Date.now()}`);
}

export function extractQrId(qrUrlOrId: string): string {
  const match = qrUrlOrId.match(/[?&]id=([^&]+)/);
  const id = match ? match[1] : qrUrlOrId;
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export function toLong(value: number | string | Long | bigint): Long {
  if (Long.isLong(value)) return value;
  if (typeof value === 'bigint') return Long.fromString(value.toString());
  if (typeof value === 'number') return Long.fromNumber(Number.isFinite(value) ? value : 0);
  const text = String(value || '0');
  return Long.fromString(text);
}

export function idToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Long.isLong(value)) return value.toString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object' && value && 'toString' in value) return String(value);
  return String(value);
}

export async function httpsPostJson(
  host: string,
  path: string,
  jsonData: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number | undefined; body: any }> {
  const body = JSON.stringify(jsonData);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port: 443,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body).toString(),
          'Accept-Encoding': 'gzip',
          Connection: 'Keep-Alive',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
        stream.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function httpsGetJson(
  host: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number | undefined; body: any }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port: 443,
        path,
        method: 'GET',
        headers: {
          Accept: '*/*',
          'Accept-Language': KAKAO_LANG,
          'Accept-Encoding': 'gzip',
          Connection: 'keep-alive',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
        stream.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export async function subDeviceAllowList(modelName = KAKAO_MODEL_NAME): Promise<any> {
  const path = `/android/account/allowlist.json?model_name=${encodeURIComponent(modelName)}`;
  const res = await httpsGetJson(KATALK_HOST, path, {
    'User-Agent': buildUserAgent(),
    A: buildAHeader(),
  });

  if (res.status !== 200) throw new Error(`allowlist HTTP error: ${res.status}`);
  return res.body;
}

export async function qrGenerate(deviceUuid: string): Promise<QrGenerateResult> {
  const res = await httpsPostJson(
    KATALK_HOST,
    '/android/account/qrCodeLogin/generate',
    {
      device: {
        name: KAKAO_MODEL_NAME,
        uuid: deviceUuid,
        model: KAKAO_MODEL_NAME,
        osVersion: KAKAO_OS_VERSION,
      },
    },
    {
      'User-Agent': QR_USER_AGENT,
      A: buildAHeader(),
    },
  );

  if (res.status !== 200) throw new Error(`QR generate HTTP error: ${res.status}`);
  if (res.body?.status && res.body.status !== 0) {
    throw new Error(`QR generate failed: status=${res.body.status}`);
  }
  return {
    url: String(res.body.url || ''),
    remainingSeconds: Number(res.body.remainingSeconds || 180),
  };
}

export async function qrPollLogin(deviceUuid: string, qrId: string): Promise<QrPollResult> {
  const res = await httpsPostJson(
    KATALK_HOST,
    '/android/account/qrCodeLogin/login',
    {
      device: { uuid: deviceUuid },
      id: extractQrId(qrId),
    },
    {
      'User-Agent': QR_USER_AGENT,
      A: buildAHeader(),
    },
  );

  if (res.status !== 200) throw new Error(`QR poll HTTP error: ${res.status}`);
  return res.body as QrPollResult;
}

class LocoPacket {
  constructor(
    readonly packetId: number,
    readonly status: number,
    readonly method: string,
    readonly body: any = {},
  ) {}

  serialize(): Buffer {
    const body = BSON.serialize(this.body);
    const header = Buffer.alloc(HEADER_SIZE);
    header.writeInt32LE(this.packetId, 0);
    header.writeInt16LE(this.status, 4);

    // LOCO method는 11바이트 고정 영역에 null padding으로 기록합니다.
    const method = Buffer.alloc(METHOD_LENGTH, 0);
    Buffer.from(this.method, 'utf8').copy(method, 0, 0, METHOD_LENGTH);
    method.copy(header, 6);
    header.writeUInt8(0, 17);
    header.writeInt32LE(body.length, 18);
    return Buffer.concat([header, body]);
  }

  static fromBuffer(buffer: Buffer): LocoPacket {
    const packetId = buffer.readInt32LE(0);
    const status = buffer.readInt16LE(4);
    const methodRaw = buffer.subarray(6, 17);
    const nullIndex = methodRaw.indexOf(0);
    const method = methodRaw.subarray(0, nullIndex === -1 ? METHOD_LENGTH : nullIndex).toString('utf8');
    const bodyLength = buffer.readInt32LE(18);
    const body = bodyLength > 0 ? BSON.deserialize(buffer.subarray(HEADER_SIZE, HEADER_SIZE + bodyLength)) : {};
    return new LocoPacket(packetId, status, method, body);
  }
}

class V2SLCrypto {
  private readonly aesKey = crypto.randomBytes(AES_KEY_SIZE);

  buildHandshake(): Buffer {
    const encryptedKey = crypto.publicEncrypt(
      {
        key: crypto.createPublicKey({
          key: {
            kty: 'RSA',
            n: RSA_MODULUS.toString('base64url'),
            e: Buffer.from([0x03]).toString('base64url'),
          },
          format: 'jwk',
        }),
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha1',
      },
      this.aesKey,
    );

    const header = Buffer.alloc(12);
    header.writeInt32LE(encryptedKey.length, 0);
    header.writeInt32LE(AES_KEY_SIZE, 4);
    header.writeInt32LE(ENCRYPTION_TYPE_AES_GCM128, 8);
    return Buffer.concat([header, encryptedKey]);
  }

  encrypt(plaintext: Buffer): Buffer {
    const iv = crypto.randomBytes(AES_IV_SIZE);
    const cipher = crypto.createCipheriv('aes-128-gcm', this.aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(4);
    header.writeInt32LE(AES_IV_SIZE + encrypted.length, 0);
    return Buffer.concat([header, iv, encrypted]);
  }

  decrypt(block: Buffer): Buffer {
    const blockSize = block.readInt32LE(0);
    if (blockSize > MAX_V2SL_BLOCK_SIZE) throw new Error(`V2SL block too large: ${blockSize}`);
    const iv = block.subarray(4, 4 + AES_IV_SIZE);
    const payload = block.subarray(4 + AES_IV_SIZE, 4 + blockSize);
    const tagStart = payload.length - 16;
    const decipher = crypto.createDecipheriv('aes-128-gcm', this.aesKey, iv);
    decipher.setAuthTag(payload.subarray(tagStart));
    return Buffer.concat([decipher.update(payload.subarray(0, tagStart)), decipher.final()]);
  }

  static blockTotalSize(buffer: Buffer): number | null {
    if (buffer.length < 4) return null;
    return buffer.readInt32LE(0) + 4;
  }
}

abstract class LocoRequestClient extends EventEmitter {
  protected pending = new Map<number, {
    method: string;
    resolve: (packet: LocoPacket) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  protected packetId = 0;

  protected nextPacketId(): number {
    this.packetId += 1;
    return this.packetId;
  }

  protected finishPacket(packet: LocoPacket): void {
    debugLoco('recv', packet.method, packet.packetId, packet.status, packet.body);
    const pending = this.pending.get(packet.packetId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(packet.packetId);
      pending.resolve(packet);
      return;
    }

    // 일부 LOCO 응답은 packetId가 기대값과 다르게 내려올 수 있어 method 기준으로 한 번 더 매칭합니다.
    // 특히 WRITE timeout을 진단/방어하기 위한 보수적 fallback이며, push 성격의 MSG와는 섞지 않습니다.
    for (const [packetId, candidate] of this.pending) {
      if (candidate.method !== packet.method) continue;
      clearTimeout(candidate.timer);
      this.pending.delete(packetId);
      candidate.resolve(packet);
      return;
    }

    this.emit('push', packet);
  }

  protected rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }
}

export class BookingClient extends LocoRequestClient {
  private socket: tls.TLSSocket | null = null;
  private recvBuffer = Buffer.alloc(0);

  connect(host = BOOKING_HOST, port = BOOKING_PORT): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(port, host, { rejectUnauthorized: true });
      this.socket = socket;
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
      socket.on('data', (data) => this.onData(data));
      socket.on('close', () => this.rejectAll(new Error('Booking disconnected')));
    });
  }

  request(method: string, body: any = {}, timeoutMs = 10_000): Promise<LocoPacket> {
    if (!this.socket) return Promise.reject(new Error('Booking not connected'));
    const packetId = this.nextPacketId();
    const packet = new LocoPacket(packetId, 0, method, body);
    debugLoco('send', method, packetId, 0, body);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(packetId);
        reject(new Error(`Request ${method} timed out`));
      }, timeoutMs);
      this.pending.set(packetId, { method, resolve, reject, timer });
      this.socket?.write(packet.serialize());
    });
  }

  async getConf(userId: string): Promise<{ hosts: string[]; ports: number[] }> {
    const packet = await this.request('GETCONF', {
      userId: toLong(userId),
      mccmnc: KAKAO_MCCMNC,
      os: KAKAO_OS,
      appVer: KAKAO_APP_VERSION,
    });
    const ticket = packet.body.ticket || packet.body.ticketInfo || {};
    const wifi = packet.body.wifi || packet.body.connInfoForWifi || {};
    const cell = packet.body['3g'] || packet.body.connInfoForCellular || {};
    return {
      hosts: uniqueStrings([...(ticket.lsl || []), ...(ticket.lsl6 || [])]),
      ports: uniqueNumbers([...(wifi.ports || []), ...(cell.ports || []), 443]),
    };
  }

  async checkin(userId: string): Promise<CheckinResult> {
    const packet = await this.request('CHECKIN', checkinBody(userId));
    return checkinResult(packet);
  }

  disconnect(): void {
    this.socket?.destroy();
    this.socket = null;
    this.rejectAll(new Error('Booking disconnected'));
  }

  private onData(data: Buffer): void {
    this.recvBuffer = Buffer.concat([this.recvBuffer, data]);
    while (this.recvBuffer.length >= HEADER_SIZE) {
      const bodyLength = this.recvBuffer.readInt32LE(18);
      const total = HEADER_SIZE + bodyLength;
      if (this.recvBuffer.length < total) return;
      const raw = this.recvBuffer.subarray(0, total);
      this.recvBuffer = this.recvBuffer.subarray(total);
      this.finishPacket(LocoPacket.fromBuffer(raw));
    }
  }
}

export class CarriageClient extends LocoRequestClient {
  private socket: net.Socket | null = null;
  private readonly crypto = new V2SLCrypto();
  private recvBuffer = Buffer.alloc(0);
  private decryptedBuffer = Buffer.alloc(0);
  private pingTimer: NodeJS.Timeout | null = null;

  connect(host: string, port: number, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      this.socket = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection to ${host}:${port} timed out`));
      }, timeoutMs);
      socket.connect(port, host, () => {
        clearTimeout(timer);
        socket.write(this.crypto.buildHandshake(), (err) => (err ? reject(err) : resolve()));
      });
      socket.on('data', (data) => this.onData(data));
      socket.on('error', (err) => this.emit('error', err));
      socket.on('close', () => {
        this.stopPing();
        this.rejectAll(new Error('Carriage disconnected'));
        this.emit('disconnected');
      });
    });
  }

  request(method: string, body: any = {}, timeoutMs = 10_000): Promise<LocoPacket> {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      return Promise.reject(new Error('Carriage not connected'));
    }
    const packetId = this.nextPacketId();
    const packet = new LocoPacket(packetId, 0, method, body);
    const encrypted = this.crypto.encrypt(packet.serialize());
    const socket = this.socket;
    debugLoco('send', method, packetId, 0, body);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(packetId);
        const err = new Error(`Request ${method} timed out`);
        reject(err);
        // LOCO는 소켓이 half-open 상태가 되면 다음 요청도 연쇄 timeout이 납니다.
        // timeout이 확인되면 현재 연결을 닫아 상위 클라이언트가 재연결하게 합니다.
        if (this.socket === socket && !socket.destroyed) socket.destroy();
      }, timeoutMs);
      this.pending.set(packetId, { method, resolve, reject, timer });
      socket.write(encrypted, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(packetId);
        reject(err);
        if (this.socket === socket && !socket.destroyed) socket.destroy();
      });
    });
  }

  writeEncrypted(data: Buffer): Promise<void> {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      return Promise.reject(new Error('Carriage not connected'));
    }
    const encrypted = this.crypto.encrypt(data);
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      socket.write(encrypted, (err) => {
        if (err) {
          reject(err);
          if (this.socket === socket && !socket.destroyed) socket.destroy();
          return;
        }
        resolve();
      });
    });
  }

  end(timeoutMs = 5_000): Promise<void> {
    this.stopPing();
    const socket = this.socket;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.socket === socket) {
          socket.destroy();
          this.socket = null;
        }
        resolve();
      }, timeoutMs);
      socket.once('close', () => {
        clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        resolve();
      });
      socket.end();
    });
  }

  loginList(cred: { userId: string; deviceUUID: string; accessToken: string }): Promise<LocoPacket> {
    return this.request('LOGINLIST', {
      os: KAKAO_OS,
      appVer: KAKAO_APP_VERSION,
      prtVer: '1',
      lang: KAKAO_LANG,
      ntype: 0,
      duuid: cred.deviceUUID,
      oauthToken: cred.accessToken,
      chatIds: [],
      maxIds: [],
      lastTokenId: toLong(0),
      lbk: 0,
      bg: false,
    });
  }

  lchatList(chatIds: Long[], maxIds: Long[], lastTokenId: string | number, lastChatId: string | number): Promise<LocoPacket> {
    return this.request('LCHATLIST', {
      chatIds,
      maxIds,
      lastTokenId: toLong(lastTokenId),
      lastChatId: toLong(lastChatId),
    });
  }

  chatInfo(chatId: string): Promise<LocoPacket> {
    return this.request('CHATINFO', {
      chatId: toLong(chatId),
    });
  }

  memList(chatId: string, token: string | number = 0): Promise<LocoPacket> {
    return this.request('MEMLIST', {
      chatId: toLong(chatId),
      token: toLong(token),
      excludeMe: false,
    });
  }

  infoLink(linkIds: Array<string | number | Long>): Promise<LocoPacket> {
    return this.request('INFOLINK', {
      lis: linkIds.map((id) => toLong(id)),
    });
  }

  syncLink(lastToken: string | number = 0): Promise<LocoPacket> {
    return this.request('SYNCLINK', {
      ltk: toLong(lastToken),
    });
  }

  chatOnRoom(chatId: string, token: string | number = 0, opt: string | number = 0): Promise<LocoPacket> {
    return this.request('CHATONROOM', {
      chatId: toLong(chatId),
      token: toLong(token),
      opt: toLong(opt),
    });
  }

  syncMsg(chatId: string, cur: string | number, cnt: number): Promise<LocoPacket> {
    return this.request('SYNCMSG', {
      chatId: toLong(chatId),
      cur: toLong(cur),
      max: toLong(0),
      cnt,
    });
  }

  write(chatId: string, text: string, msgId?: number | string | Long, timeoutMs = 20_000): Promise<LocoPacket> {
    const body: Record<string, unknown> = {
      chatId: toLong(chatId),
      msgId: Number(idToString(msgId || 1)),
      type: 1,
      noSeen: true,
    };
    if (text) body.msg = text;

    if (process.env.KAKAO_WRITE_STYLE === 'forge') {
      body.noSeen = false;
      body.scope = 1;
      body.silence = false;
    }

    return this.request('WRITE', body, timeoutMs);
  }

  startPing(intervalMs = 60_000): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      void this.request('PING', {}).catch((err) => {
        this.emit('error', err);
        // PING 실패는 장시간 무응답 연결을 조기에 감지하기 위한 신호입니다.
        // 소켓을 닫아야 disconnected 이벤트와 재연결 흐름이 이어집니다.
        this.socket?.destroy();
      });
    }, intervalMs);
  }

  disconnect(): void {
    this.stopPing();
    this.socket?.destroy();
    this.socket = null;
    this.rejectAll(new Error('Carriage disconnected'));
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private onData(data: Buffer): void {
    this.recvBuffer = Buffer.concat([this.recvBuffer, data]);
    while (this.recvBuffer.length >= 4) {
      const total = V2SLCrypto.blockTotalSize(this.recvBuffer);
      if (!total || this.recvBuffer.length < total) break;
      const block = this.recvBuffer.subarray(0, total);
      this.recvBuffer = this.recvBuffer.subarray(total);
      this.decryptedBuffer = Buffer.concat([this.decryptedBuffer, this.crypto.decrypt(block)]);
    }

    while (this.decryptedBuffer.length >= HEADER_SIZE) {
      const bodyLength = this.decryptedBuffer.readInt32LE(18);
      const total = HEADER_SIZE + bodyLength;
      if (this.decryptedBuffer.length < total) return;
      const raw = this.decryptedBuffer.subarray(0, total);
      this.decryptedBuffer = this.decryptedBuffer.subarray(total);
      this.finishPacket(LocoPacket.fromBuffer(raw));
    }
  }
}

export class TicketClient extends CarriageClient {
  async checkin(userId: string): Promise<CheckinResult> {
    const packet = await this.request('CHECKIN', checkinBody(userId));
    return checkinResult(packet);
  }
}

function checkinBody(userId: string): Record<string, unknown> {
  return {
    userId: toLong(userId),
    os: KAKAO_OS,
    ntype: 0,
    appVer: KAKAO_APP_VERSION,
    lang: KAKAO_LANG,
    useSub: true,
    MCCMNC: KAKAO_MCCMNC,
  };
}

function checkinResult(packet: LocoPacket): CheckinResult {
  return {
    host: String(packet.body.host || ''),
    port: Number(packet.body.port || 0),
    status: packet.status,
  };
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

function uniqueNumbers(values: unknown[]): number[] {
  return [
    ...new Set(
      values
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0),
    ),
  ];
}

function debugLoco(
  direction: 'send' | 'recv',
  method: string,
  packetId: number,
  status: number,
  body: any,
): void {
  if (!DEBUG_LOCO) return;
  const summary: Record<string, unknown> = {
    direction,
    method,
    packetId,
    status,
    keys: body && typeof body === 'object' ? Object.keys(body) : [],
  };

  if (method === 'WRITE') {
    summary.chatId = idToString(body?.chatId);
    summary.type = body?.type;
    summary.noSeen = body?.noSeen;
    summary.scope = body?.scope;
    summary.silence = body?.silence;
    summary.msgLength = typeof body?.msg === 'string' ? body.msg.length : undefined;
    summary.hasMsgId = body?.msgId !== undefined;
    summary.msgId = body?.msgId !== undefined ? idToString(body.msgId) : undefined;
    summary.logId = body?.logId !== undefined ? idToString(body.logId) : undefined;
  } else if (method === 'SYNCMSG') {
    summary.chatId = idToString(body?.chatId);
    summary.cur = body?.cur !== undefined ? idToString(body.cur) : undefined;
    summary.max = body?.max !== undefined ? idToString(body.max) : undefined;
    summary.cnt = body?.cnt;
    summary.bodyStatus = body?.status;
  } else if (method === 'CHATONROOM') {
    summary.chatId = idToString(body?.chatId || body?.c);
    summary.c = body?.c !== undefined ? idToString(body.c) : undefined;
    summary.t = body?.t;
    summary.li = body?.li !== undefined ? idToString(body.li) : undefined;
    summary.otk = body?.otk !== undefined ? idToString(body.otk) : undefined;
  } else if (method === 'MSG') {
    const chatLog = body?.chatLog || body;
    summary.chatId = idToString(body?.chatId || body?.c || chatLog?.chatId || chatLog?.c);
    summary.authorId = idToString(chatLog?.authorId || chatLog?.senderId || chatLog?.userId);
    summary.logId = idToString(chatLog?.logId || chatLog?.msgId);
    summary.msgLength = typeof chatLog?.msg === 'string' ? chatLog.msg.length : undefined;
    summary.hasAuthorNickname = Boolean(
      body?.authorNickname ||
        body?.authorNickName ||
        chatLog?.authorNickname ||
        chatLog?.authorNickName,
    );
  } else if (method === 'CHECKIN') {
    summary.host = body?.host;
    summary.port = body?.port;
    summary.cshost = body?.cshost;
    summary.csport = body?.csport;
  } else if (method === 'LOGINLIST' || method === 'LCHATLIST') {
    summary.chatDatas = Array.isArray(body?.chatDatas) ? body.chatDatas.length : undefined;
    summary.delChatIds = Array.isArray(body?.delChatIds) ? body.delChatIds.length : undefined;
    summary.lastTokenId = body?.lastTokenId !== undefined ? idToString(body.lastTokenId) : undefined;
    summary.lastChatId = body?.lastChatId !== undefined ? idToString(body.lastChatId) : undefined;
  } else if (method === 'BLSYNC') {
    // BLSYNC는 "새 로그가 있으니 동기화하라"는 신호와 실제 로그 배열이 섞여 내려올 수 있습니다.
    // 값 전체를 찍으면 개인정보가 노출될 수 있어 타입/개수/주요 id만 요약합니다.
    for (const key of ['r', 'f', 'l', 'ts', 'pr', 'pf', 'pl', 'pts']) {
      if (body?.[key] === undefined) continue;
      summary[key] = summarizeDebugValue(body[key]);
    }
  }

  console.error(`[loco:${direction}] ${JSON.stringify(summary)}`);
}

function summarizeDebugValue(value: unknown): unknown {
  if (Long.isLong(value)) return idToString(value);
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      first: value.length > 0 ? summarizeDebugValue(value[0]) : undefined,
    };
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {
      type: 'object',
      keys: Object.keys(record),
    };
    for (const key of ['chatId', 'c', 'logId', 'msgId', 'authorId', 'senderId']) {
      if (record[key] !== undefined) out[key] = idToString(record[key]);
    }
    return out;
  }
  return value;
}
