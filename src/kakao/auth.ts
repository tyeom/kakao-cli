import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { resolve } from 'node:path';
import qrcodeTerminal from 'qrcode-terminal';
import type { AuthProvider, Credential } from './client.js';
import {
  extractQrId,
  KAKAO_MODEL_NAME,
  generateDeviceUuid,
  qrGenerate,
  qrPollLogin,
  subDeviceAllowList,
} from './forge-protocol.js';

const DEFAULT_AUTH_PATH = resolve(process.cwd(), 'auth.json');
const DEFAULT_DEVICE_UUID_PATH = resolve(process.cwd(), '.device-uuid');

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * QR 로그인에 사용할 안정적인 디바이스 UUID를 가져옵니다.
 * KakaoForge 기준으로 생성한 값은 Android sub-device의 d_id 역할을 합니다.
 */
export function getOrCreateDeviceUUID(path = DEFAULT_DEVICE_UUID_PATH): string {
  if (existsSync(path)) {
    const saved = readFileSync(path, 'utf8').trim();
    if (saved) return saved;
  }
  const uuid = generateDeviceUuid();
  writeFileSync(path, uuid, 'utf8');
  return uuid;
}

/** 저장된 Credential을 읽습니다. 예전/새 auth.json 키 이름을 모두 허용합니다. */
export function loadCredential(path = DEFAULT_AUTH_PATH): Credential | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<
      Credential & { deviceUuid: string; oauthToken: string }
    >;
    const deviceUUID = parsed.deviceUUID || parsed.deviceUuid;
    const accessToken = parsed.accessToken || parsed.oauthToken;
    if (
      parsed &&
      typeof parsed.userId === 'string' &&
      typeof deviceUUID === 'string' &&
      typeof accessToken === 'string' &&
      typeof parsed.refreshToken === 'string'
    ) {
      return {
        userId: parsed.userId,
        deviceUUID,
        accessToken,
        refreshToken: parsed.refreshToken,
      };
    }
    if (
      parsed &&
      typeof parsed.userId === 'number' &&
      typeof deviceUUID === 'string' &&
      typeof accessToken === 'string'
    ) {
      return {
        userId: String(parsed.userId),
        deviceUUID,
        accessToken,
        refreshToken: parsed.refreshToken || '',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 토큰은 민감 정보라 POSIX에서는 0600 권한으로 저장합니다. */
export function saveCredential(cred: Credential, path = DEFAULT_AUTH_PATH): void {
  const payload = {
    ...cred,
    deviceUuid: cred.deviceUUID,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8');
  if (process.platform !== 'win32') {
    try {
      chmodSync(path, 0o600);
    } catch {
      // chmod를 지원하지 않는 파일시스템에서는 저장만 보장합니다.
    }
  }
}

/** 저장된 인증 정보만 삭제하고, 디바이스 UUID는 유지합니다. */
export function clearCredential(path = DEFAULT_AUTH_PATH): void {
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // 이미 삭제되었거나 잠긴 경우는 로그아웃 관점에서 무시합니다.
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
    onQrCode: (qr: string) => void;
    onPasscode: (passcode: string) => void;
    onStatus?: (status: string) => void;
  }): Promise<Credential> {
    const deviceUUID = getOrCreateDeviceUUID(this.uuidPath);

    // QR sub-device 모델이 현재 서버 allowlist에 있는지 먼저 확인합니다.
    // 이 단계가 실패해도 실제 QR 생성이 성공할 수 있으므로 로그인 자체는 계속 진행합니다.
    input.onStatus?.('QR 허용 모델 확인 중');
    try {
      const allow = await subDeviceAllowList(KAKAO_MODEL_NAME);
      input.onStatus?.(
        allow?.allowlisted === false
          ? 'QR 허용 모델 확인 실패 - QR 생성 계속'
          : 'QR 허용 모델 확인 완료',
      );
    } catch {
      input.onStatus?.('QR 허용 모델 확인 실패 - QR 생성 계속');
    }

    input.onStatus?.('QR 생성 중');
    const qr = await qrGenerate(deviceUUID);
    input.onQrCode(renderQr(qr.url));

    const qrId = extractQrId(qr.url);
    const startedAt = Date.now();
    const timeoutMs = Math.max(30, qr.remainingSeconds || 180) * 1000;
    let intervalMs = 2_000;
    let passcodeShown = false;

    input.onStatus?.('카카오톡 앱에서 QR 스캔 대기 중');

    while (Date.now() - startedAt < timeoutMs) {
      await delay(intervalMs);
      const poll = await qrPollLogin(deviceUUID, qrId);

      if (poll.nextRequestIntervalInSeconds) {
        intervalMs = Math.max(1, poll.nextRequestIntervalInSeconds) * 1000;
      }

      // QR 스캔 뒤 휴대폰 화면에 같은 코드가 보이는지 확인하게 하는 단계입니다.
      if (poll.passcode && !passcodeShown) {
        passcodeShown = true;
        input.onPasscode(poll.passcode);
        input.onStatus?.('휴대폰에서 확인 코드 승인 대기 중');
      }

      if (poll.accessToken) {
        const cred: Credential = {
          userId: String(poll.user?.userId || ''),
          deviceUUID,
          accessToken: poll.accessToken,
          refreshToken: poll.refreshToken || '',
        };
        if (!cred.userId) throw new Error('QR login succeeded without userId');
        saveCredential(cred, this.authPath);
        input.onStatus?.('QR 인증 완료');
        return cred;
      }

      if (!poll.nextRequestIntervalInSeconds && poll.status && poll.status !== 0) {
        throw new Error(`QR login failed: status=${poll.status}`);
      }
    }

    throw new Error('QR login timed out');
  }

  async logout(): Promise<void> {
    clearCredential(this.authPath);
  }
}

function renderQr(content: string): string {
  let rendered = content;
  qrcodeTerminal.generate(content, { small: true }, (qr) => {
    rendered = qr;
  });
  return rendered;
}
