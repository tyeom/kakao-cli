import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { AuthProvider, Credential } from '../kakao/client.js';

interface Props {
  auth: AuthProvider;
  initialError?: string | null;
  onLoggedIn: (cred: Credential) => void;
}

// QR 로그인 화면: 앱은 QR과 휴대폰 확인용 패스코드만 보여줍니다.
// 이메일/비밀번호를 터미널에 입력하지 않으므로 비밀값이 로컬 화면에 남지 않습니다.
export default function Login({ auth, initialError = null, onLoggedIn }: Props): React.JSX.Element {
  const [qrCode, setQrCode] = useState('');
  const [passcode, setPasscode] = useState<string | null>(null);
  const [status, setStatus] = useState('QR 인증 준비 중');
  const [error, setError] = useState<string | null>(initialError);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        setError(null);
        const cred = await auth.login({
          onQrCode: (qr) => {
            if (alive) setQrCode(qr);
          },
          onPasscode: (code) => {
            if (alive) setPasscode(code);
          },
          onStatus: (nextStatus) => {
            if (alive) setStatus(nextStatus);
          },
        });
        if (alive) onLoggedIn(cred);
      } catch (err) {
        if (alive) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus('QR 인증 실패');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [auth, onLoggedIn]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="yellow">
        카카오톡 QR 로그인
      </Text>
      <Box marginTop={1}>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text> {status}</Text>
      </Box>
      {qrCode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>카카오톡 앱에서 아래 QR을 스캔하세요.</Text>
          <Text>{qrCode}</Text>
        </Box>
      ) : null}
      {passcode ? (
        <Box marginTop={1}>
          <Text color="green">휴대폰 확인 코드: {passcode}</Text>
        </Box>
      ) : null}
      {error ? (
        <Box marginTop={1}>
          <Text color="red">오류: {error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>q 또는 Ctrl+C 로 종료</Text>
      </Box>
    </Box>
  );
}
