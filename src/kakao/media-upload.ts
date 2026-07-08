import { createReadStream, openSync, closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, basename } from 'node:path';
import { Long } from 'bson';
import {
  CarriageClient,
  KAKAO_APP_VERSION,
  KAKAO_MCCMNC,
  KAKAO_OS,
  idToString,
  toLong,
} from './forge-protocol.js';

const MESSAGE_TYPE_PHOTO = 2;
const UPLOAD_TIMEOUT_MS = 20_000;

export interface PhotoUploadResult {
  accessKey: string;
  chatLog?: any;
  complete?: any;
  post?: any;
  attachment: Record<string, unknown>;
}

interface PhotoUploadOptions {
  carriage: CarriageClient;
  chatId: string;
  userId: string;
  filePath: string;
  filename?: string;
  timeoutMs?: number;
  onProgress?: (sent: number, total: number) => void;
}

interface ImageSize {
  width: number;
  height: number;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

export async function uploadPhotoFromPath(opts: PhotoUploadOptions): Promise<PhotoUploadResult> {
  const timeoutMs = opts.timeoutMs || UPLOAD_TIMEOUT_MS;
  const stat = statSync(opts.filePath);
  if (!stat.isFile()) throw new Error(`이미지 파일이 아닙니다: ${opts.filePath}`);

  const checksum = await sha1FileHex(opts.filePath);
  const ext = extname(opts.filePath).replace('.', '').toLowerCase();
  const mime = guessMime(opts.filePath, 'image/png');
  const imageSize = readImageSize(opts.filePath);

  const shipBody: Record<string, unknown> = {
    c: toLong(opts.chatId),
    s: toLong(stat.size),
    t: MESSAGE_TYPE_PHOTO,
    cs: checksum,
  };
  if (ext) shipBody.e = ext;

  const ship = await opts.carriage.request('SHIP', shipBody, timeoutMs);
  if (ship.status !== 0) throw new Error(`이미지 업로드 준비 실패: SHIP status ${ship.status}`);

  const shipBodyRes = ship.body || {};
  const token = shipBodyRes.k || shipBodyRes.key || shipBodyRes.token;
  if (!token) {
    throw new Error(`이미지 업로드 준비 실패: SHIP token 없음 (${JSON.stringify(shipBodyRes).slice(0, 300)})`);
  }

  let host = String(shipBodyRes.vh || shipBodyRes.host || '');
  let port = Number(idToString(shipBodyRes.p || shipBodyRes.port || 0));
  if (!host || !port) {
    const trailer = await opts.carriage.request('GETTRAILER', { k: token, t: MESSAGE_TYPE_PHOTO }, timeoutMs);
    if (trailer.status !== 0) throw new Error(`이미지 업로드 서버 조회 실패: GETTRAILER status ${trailer.status}`);
    host = host || String(trailer.body?.vh || trailer.body?.host || '');
    port = port || Number(idToString(trailer.body?.p || trailer.body?.port || 0));
  }
  if (!host || !port) throw new Error('이미지 업로드 서버 정보가 없습니다.');

  const uploadClient = new CarriageClient();
  let post: any = null;
  let completePacket: any = null;
  let completeWait: { promise: Promise<any>; cancel: () => void } | null = null;

  try {
    await uploadClient.connect(host, port, timeoutMs);

    const postBody: Record<string, unknown> = {
      k: token,
      s: toLong(stat.size),
      f: opts.filename || basename(opts.filePath),
      t: MESSAGE_TYPE_PHOTO,
      c: toLong(opts.chatId),
      // KakaoForge의 현재 photo upload 흐름과 동일하게 POST의 media id는 1로 둡니다.
      mid: toLong(1),
      ns: true,
      u: toLong(opts.userId),
      os: KAKAO_OS,
      av: KAKAO_APP_VERSION,
      nt: 0,
      mm: KAKAO_MCCMNC,
    };
    if (imageSize) {
      postBody.w = imageSize.width;
      postBody.h = imageSize.height;
    }

    completeWait = waitForPushMethod(uploadClient, 'COMPLETE', timeoutMs);
    post = await uploadClient.request('POST', postBody, timeoutMs);
    if (post.status !== 0) throw new Error(`이미지 업로드 POST 실패: status ${post.status}`);

    const offset = safeNumber(post.body?.o, 0);
    if (offset < stat.size) {
      await streamEncryptedFile(uploadClient, opts.filePath, offset, stat.size, opts.onProgress);
    }

    completePacket = await completeWait.promise;
    const completeBody = completePacket.body || {};
    if (typeof completeBody.status === 'number' && completeBody.status !== 0) {
      throw new Error(`이미지 업로드 완료 실패: COMPLETE status ${completeBody.status}`);
    }
    await uploadClient.end();
  } finally {
    if (completeWait) completeWait.cancel();
    uploadClient.disconnect();
  }

  const postBodyRes = post?.body || {};
  const completeBody = completePacket?.body || {};
  const attachment: Record<string, unknown> = {
    k: idToString(token),
    cs: postBodyRes.cs || checksum,
    s: postBodyRes.s ?? stat.size,
    mt: postBodyRes.mt || mime,
  };
  const width = postBodyRes.w ?? imageSize?.width;
  const height = postBodyRes.h ?? imageSize?.height;
  if (width) attachment.w = width;
  if (height) attachment.h = height;

  return {
    accessKey: idToString(token),
    chatLog: completeBody.chatLog || completeBody.chatlog,
    complete: completeBody,
    post: postBodyRes,
    attachment,
  };
}

async function sha1FileHex(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
  });
}

async function streamEncryptedFile(
  client: CarriageClient,
  filePath: string,
  startOffset: number,
  totalSize: number,
  onProgress?: (sent: number, total: number) => void,
): Promise<void> {
  const stream = createReadStream(filePath, {
    start: startOffset > 0 ? startOffset : 0,
    highWaterMark: 64 * 1024,
  });
  let sent = startOffset > 0 ? startOffset : 0;

  // 업로드 소켓은 일반 LOCO packet이 아니라 파일 chunk 자체를 V2SL로 감싸서 보냅니다.
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    await client.writeEncrypted(buffer);
    sent += buffer.length;
    if (onProgress) onProgress(sent, totalSize);
  }
}

function waitForPushMethod(client: CarriageClient, method: string, timeoutMs: number): { promise: Promise<any>; cancel: () => void } {
  let settled = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveFn: (packet: any) => void = () => {};
  let rejectFn: (err: Error) => void = () => {};

  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    client.off('push', onPush);
    client.off('error', onError);
    client.off('disconnected', onClose);
  };
  const onPush = (packet: any): void => {
    if (packet?.method !== method) return;
    cleanup();
    resolveFn(packet);
  };
  const onError = (err: Error): void => {
    cleanup();
    rejectFn(err);
  };
  const onClose = (): void => {
    cleanup();
    rejectFn(new Error(`이미지 업로드 연결이 ${method} 전에 닫혔습니다.`));
  };

  const promise = new Promise<any>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
    client.on('push', onPush);
    client.on('error', onError);
    client.on('disconnected', onClose);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`이미지 업로드 ${method} 대기 시간이 초과되었습니다.`));
    }, timeoutMs);
  });

  return { promise, cancel: cleanup };
}

function guessMime(filePath: string, fallback: string): string {
  const ext = extname(filePath || '').toLowerCase();
  return MIME_BY_EXT[ext] || fallback;
}

function readImageSize(filePath: string): ImageSize | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const stat = fstatSync(fd);
    const length = Math.min(stat.size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    return readPngSize(buffer) || readGifSize(buffer) || readJpegSize(buffer);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function readPngSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 24) return null;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width && height ? { width, height } : null;
}

function readGifSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 10 || buffer.toString('ascii', 0, 3) !== 'GIF') return null;
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  return width && height ? { width, height } : null;
}

function readJpegSize(buffer: Buffer): ImageSize | null {
  if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1];
    while (marker === 0xff && offset + 2 < buffer.length) {
      offset += 1;
      marker = buffer[offset + 1];
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 4 >= buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;
    if (isJpegSof(marker)) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width && height ? { width, height } : null;
    }
    offset += 2 + segmentLength;
  }
  return null;
}

function isJpegSof(marker: number): boolean {
  return (
    marker === 0xc0 ||
    marker === 0xc1 ||
    marker === 0xc2 ||
    marker === 0xc3 ||
    marker === 0xc5 ||
    marker === 0xc6 ||
    marker === 0xc7 ||
    marker === 0xc9 ||
    marker === 0xca ||
    marker === 0xcb ||
    marker === 0xcd ||
    marker === 0xce ||
    marker === 0xcf
  );
}

function safeNumber(value: unknown, fallback = 0): number {
  if (Long.isLong(value)) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
