// Assert-based self-check for the real protocol layer — NO network, NO account.
// This is what the Advisor runs to verify Worker P without a live login.
// Run with: tsx scripts/protocol-selfcheck.ts
//
// It proves:
//  1. node-kakao's CJS import + NodeKakaoClient wiring construct without crashing,
//     and expose the KakaoClient surface (EventEmitter + the 5 methods).
//  2. The auth persistence helpers round-trip and the device UUID is stable,
//     using TEMP files so the project's real auth.json/.device-uuid are untouched.
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { NodeKakaoClient } from '../src/kakao/node-kakao.js';
import {
  NodeKakaoAuth,
  getOrCreateDeviceUUID,
  loadCredential,
  saveCredential,
  clearCredential,
} from '../src/kakao/auth.js';
import type { Credential } from '../src/kakao/client.js';

async function main(): Promise<void> {
  // --- 1. Client construction + shape ------------------------------------
  const client = new NodeKakaoClient();
  assert(client instanceof EventEmitter, 'NodeKakaoClient must be an EventEmitter');
  const methods = ['login', 'listRooms', 'getMessages', 'sendMessage', 'disconnect'] as const;
  for (const m of methods) {
    assert(typeof client[m] === 'function', `NodeKakaoClient missing method: ${m}`);
  }
  console.log('client: EventEmitter + KakaoClient methods (login/listRooms/getMessages/sendMessage/disconnect) OK');

  // --- 2. Auth persistence against TEMP files ----------------------------
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
