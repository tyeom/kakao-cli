import type { AuthProvider, Credential } from './client.js';

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// MockAuthProvider — 실제 QR AuthProvider를 대신하는 테스트용 구현입니다.
// loadSaved()는 항상 null을 반환해서 mock 실행에서도 로그인 화면을 먼저 거칩니다.
// login()은 QR과 확인 코드를 보여준 뒤, UI가 프레임을 그릴 시간을 조금 남기고 완료합니다.
export class MockAuthProvider implements AuthProvider {
  async loadSaved(): Promise<Credential | null> {
    return null;
  }

  async login(input: {
    onQrCode: (qr: string) => void;
    onPasscode: (passcode: string) => void;
    onStatus?: (status: string) => void;
  }): Promise<Credential> {
    input.onStatus?.('QR 인증 준비 중');
    await delay(50);
    input.onQrCode('[mock QR]\n카카오톡 앱에서 QR을 스캔하는 화면입니다.');
    input.onStatus?.('QR 스캔 대기 중');
    await delay(120);
    input.onPasscode('000000');
    input.onStatus?.('휴대폰 승인 대기 중');
    await delay(120);
    return { userId: 'mock', deviceUUID: 'mock', accessToken: 'mock', refreshToken: 'mock' };
  }

  async logout(): Promise<void> {
    // no-op
  }
}
