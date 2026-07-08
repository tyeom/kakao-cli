// 실제 프로토콜 레이어의 shape/persistence를 확인하는 self-check입니다.
// 네트워크와 계정 없이 실행되므로 live 로그인 전에도 안전하게 돌릴 수 있습니다.
// 실행: tsx scripts/protocol-selfcheck.ts
//
// 확인 항목:
//  1. ForgeKakaoClient가 EventEmitter와 KakaoClient 메서드를 노출하는지 확인합니다.
//  2. TEMP 파일로 Credential 저장/로드와 device UUID 안정성을 확인합니다.
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { ForgeKakaoClient } from '../src/kakao/forge-client.js';
import {
  NodeKakaoAuth,
  getOrCreateDeviceUUID,
  loadCredential,
  saveCredential,
  clearCredential,
} from '../src/kakao/auth.js';
import type { Credential } from '../src/kakao/client.js';

async function main(): Promise<void> {
  // --- 1. 클라이언트 생성 + shape -----------------------------------------
  const client = new ForgeKakaoClient();
  assert(client instanceof EventEmitter, 'ForgeKakaoClient must be an EventEmitter');
  const methods = ['login', 'listRooms', 'getMessages', 'sendMessage', 'sendClipboardImage', 'disconnect'] as const;
  for (const m of methods) {
    assert(typeof client[m] === 'function', `ForgeKakaoClient missing method: ${m}`);
  }
  console.log('client: EventEmitter + KakaoClient methods (login/listRooms/getMessages/sendMessage/sendClipboardImage/disconnect) OK');

  // --- 2. TEMP 파일 기반 인증 persistence --------------------------------
  const stamp = `${process.pid}-${Date.now()}`;
  const authPath = join(tmpdir(), `kakao-cli-auth-${stamp}.json`);
  const uuidPath = join(tmpdir(), `kakao-cli-uuid-${stamp}`);
  const cleanup = (): void => {
    for (const p of [authPath, uuidPath]) {
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  };

  try {
    const auth = new NodeKakaoAuth(authPath, uuidPath);

    assert.strictEqual(await auth.loadSaved(), null, 'loadSaved() should be null before any save');

    const fake: Credential = {
      userId: '9876543210123',
      deviceUUID: 'selfcheck-device-uuid',
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
    };
    saveCredential(fake, authPath);
    assert.deepStrictEqual(loadCredential(authPath), fake, 'loadCredential() must deep-equal what was saved');
    assert.deepStrictEqual(await auth.loadSaved(), fake, 'loadSaved() must return the saved credential');

    const uuid1 = getOrCreateDeviceUUID(uuidPath);
    const uuid2 = getOrCreateDeviceUUID(uuidPath);
    assert(typeof uuid1 === 'string' && uuid1.length > 0, 'device UUID must be a non-empty string');
    assert.strictEqual(uuid1, uuid2, 'getOrCreateDeviceUUID() must be stable across calls');

    clearCredential(authPath);
    assert.strictEqual(await auth.loadSaved(), null, 'loadSaved() should be null after clearCredential()');

    console.log('auth: null -> save -> round-trip -> stable UUID -> clear -> null OK');
  } finally {
    cleanup();
  }

  console.log('protocol-selfcheck OK');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('protocol-selfcheck FAILED:', err);
  process.exit(1);
});
