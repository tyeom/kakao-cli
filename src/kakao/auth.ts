import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { resolve } from 'node:path';
// node-kakao is CommonJS; use the default-import interop (see node-kakao.ts) so
// every value resolves at runtime regardless of cjs-module-lexer detection.
import kakao from 'node-kakao';
import type { AuthProvider, Credential } from './client.js';
import { DEVICE_NAME, PROTOCOL_CONFIG } from './node-kakao.js';

const { AuthApiClient, KnownAuthStatusCode, util } = kakao;

// ---------------------------------------------------------------------------
// NodeKakaoAuth — real AuthProvider over node-kakao's AuthApiClient, plus small
// separately-testable persistence helpers.
//
// Two things are persisted, on purpose in TWO files:
//  - auth.json (default, project root, gitignored): the Credential (tokens).
//    Cleared on logout.
//  - .device-uuid (default, project root, gitignored): a STABLE per-install
//    device UUID. It must survive logout — changing it forces Kakao to
//    re-register the device (another phone passcode), so it can't live in
//    auth.json which logout deletes.
// ---------------------------------------------------------------------------

const DEFAULT_AUTH_PATH = resolve(process.cwd(), 'auth.json');
const DEFAULT_DEVICE_UUID_PATH = resolve(process.cwd(), '.device-uuid');

/**
 * Return a stable device UUID, creating + persisting one on first use.
 * node-kakao's util.randomWin32DeviceUUID() generates a PC-client-shaped UUID.
 */
export function getOrCreateDeviceUUID(path = DEFAULT_DEVICE_UUID_PATH): string {
  if (existsSync(path)) {
    const saved = readFileSync(path, 'utf8').trim();
    if (saved) return saved;
  }
  const uuid = util.randomWin32DeviceUUID();
  writeFileSync(path, uuid, 'utf8');
  return uuid;
}

/** Load a saved Credential, or null if absent/unreadable/malformed. */
export function loadCredential(path = DEFAULT_AUTH_PATH): Credential | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Credential>;
    if (
      parsed &&
      typeof parsed.userId === 'string' &&
      typeof parsed.deviceUUID === 'string' &&
      typeof parsed.accessToken === 'string' &&
      typeof parsed.refreshToken === 'string'
    ) {
      return {
        userId: parsed.userId,
        deviceUUID: parsed.deviceUUID,
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist a Credential. chmod 600 on POSIX (tokens are sensitive); plain write on Windows. */
export function saveCredential(cred: Credential, path = DEFAULT_AUTH_PATH): void {
  writeFileSync(path, JSON.stringify(cred, null, 2), 'utf8');
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // best-effort: some filesystems reject chmod; the token is still written.
    }
  }
}

/** Delete the saved Credential (sign out). Leaves the device UUID intact. */
export function clearCredential(path = DEFAULT_AUTH_PATH): void {
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // ignore — already gone / locked.
    }
  }
}

export class NodeKakaoAuth implements AuthProvider {
  constructor(
    private readonly authPath: string = DEFAULT_AUTH_PATH,
    private readonly uuidPath: string = DEFAULT_DEVICE_UUID_PATH,
  ) {}

  async loadSaved(): Promise<Credential | null> {
    return loadCredential(this.authPath);
  }

  async login(input: {
    email: string;
    password: string;
    onPasscodeNeeded: () => Promise<string>;
  }): Promise<Credential> {
    const { email, password, onPasscodeNeeded } = input;
    const deviceUUID = getOrCreateDeviceUUID(this.uuidPath);
    const api = await AuthApiClient.create(DEVICE_NAME, deviceUUID, PROTOCOL_CONFIG);
    // LoginForm is { email, password }; not a top-level export, so inline it.
    const form = { email, password };

    // forced=true (2nd positional arg) → log in even if another device is on.
    let res = await api.login(form, true);

    // -100: this device isn't registered yet. Kakao's flow: request a passcode
    // (Kakao texts it to the account's phone), collect it, register the device
    // permanently, then log in again.
    if (!res.success && res.status === KnownAuthStatusCode.DEVICE_NOT_REGISTERED) {
      const passcodeReq = await api.requestPasscode(form);
      if (!passcodeReq.success) {
        throw new Error(
          `passcode request failed (status ${passcodeReq.status})`,
        );
      }
      const passcode = await onPasscodeNeeded();
      const register = await api.registerDevice(form, passcode, true); // permanent
      if (!register.success) {
        throw new Error(
          `device registration failed (status ${register.status}) — ` +
            `wrong passcode? (mismatch is status -111)`,
        );
      }
      res = await api.login(form, true);
    }

    if (!res.success) {
      throw new Error(
        `login failed (status ${res.status}). Common: -100 device-not-registered, ` +
          `12 wrong password, 30 login failed, 27/-997 account restricted.`,
      );
    }

    const cred: Credential = {
      userId: res.result.userId.toString(), // Long -> string (64-bit safe)
      deviceUUID,
      accessToken: res.result.accessToken,
      refreshToken: res.result.refreshToken,
    };
    saveCredential(cred, this.authPath);
    return cred;
  }

  async logout(): Promise<void> {
    clearCredential(this.authPath);
  }
}
