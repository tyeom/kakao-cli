import type { AuthProvider, Credential } from './client.js';

// MockAuthProvider — a stand-in for the real node-kakao AuthProvider.
// loadSaved() always returns null so the login UI is exercised on the mock.
// login() accepts ANY credentials, calls onPasscodeNeeded() once to drive the
// passcode UI (any code is accepted), then resolves a fake Credential.
export class MockAuthProvider implements AuthProvider {
  async loadSaved(): Promise<Credential | null> {
    return null;
  }

  async login(input: {
    email: string;
    password: string;
    onPasscodeNeeded: () => Promise<string>;
  }): Promise<Credential> {
    // Exercise the passcode screen once; the entered code is accepted as-is.
    await input.onPasscodeNeeded();
    return { userId: 'mock', deviceUUID: 'mock', accessToken: 'mock', refreshToken: 'mock' };
  }

  async logout(): Promise<void> {
    // no-op
  }
}
