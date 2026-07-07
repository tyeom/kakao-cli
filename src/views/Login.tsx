import { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import type { AuthProvider, Credential } from '../kakao/client.js';

type Step = 'email' | 'password' | 'submitting' | 'passcode';

interface Props {
  auth: AuthProvider;
  onLoggedIn: (cred: Credential) => void;
}

// Login screen: email + password, then a passcode field if the auth flow asks
// for one (device registration). Only the focused field accepts input; move
// between fields with Enter or Tab.
export default function Login({ auth, onLoggedIn }: Props): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passcode, setPasscode] = useState('');
  const [step, setStep] = useState<Step>('email');
  const [passcodeAsked, setPasscodeAsked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resolver for the passcode promise handed to auth.login().
  const passcodeResolve = useRef<((code: string) => void) | null>(null);

  const doLogin = async (emailVal: string, passwordVal: string): Promise<void> => {
    setError(null);
    setStep('submitting');
    try {
      const cred = await auth.login({
        email: emailVal,
        password: passwordVal,
        onPasscodeNeeded: () =>
          new Promise<string>((resolve) => {
            passcodeResolve.current = resolve;
            setPasscodeAsked(true);
            setStep('passcode');
          }),
      });
      onLoggedIn(cred);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep('password');
    }
  };

  // Tab advances between fields (Enter is handled per-field via onSubmit).
  useInput((_input, key) => {
    if (!key.tab) return;
    if (step === 'email') setStep('password');
    else if (step === 'password') setStep('email');
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="yellow">
        카카오톡 로그인
      </Text>
      <Box marginTop={1}>
        <Text>이메일: </Text>
        <TextInput
          value={email}
          onChange={setEmail}
          onSubmit={() => setStep('password')}
          focus={step === 'email'}
          placeholder="you@example.com"
        />
      </Box>
      <Box>
        <Text>비밀번호: </Text>
        <TextInput
          value={password}
          onChange={setPassword}
          onSubmit={(val) => void doLogin(email, val)}
          focus={step === 'password'}
          mask="*"
          placeholder="********"
        />
      </Box>
      {passcodeAsked ? (
        <Box>
          <Text>인증번호: </Text>
          <TextInput
            value={passcode}
            onChange={setPasscode}
            onSubmit={(val) => {
              passcodeResolve.current?.(val);
              setStep('submitting');
            }}
            focus={step === 'passcode'}
            placeholder="휴대폰으로 전송된 코드"
          />
        </Box>
      ) : null}
      {step === 'submitting' ? (
        <Box marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text> 로그인 중…</Text>
        </Box>
      ) : null}
      {error ? (
        <Box marginTop={1}>
          <Text color="red">오류: {error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>Enter/Tab 로 이동 · q 로 종료</Text>
      </Box>
    </Box>
  );
}
