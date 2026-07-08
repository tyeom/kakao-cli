#!/usr/bin/env node
type BackendMode = 'live' | 'mock';

const DEFAULT_API_PORT = 8880;

// 실행 옵션을 앱 내부에서 쓰는 환경변수로 정규화합니다.
// 예: pnpm run start:live -> tsx src/cli.tsx --live -> KAKAO_BACKEND=live
const args = process.argv.slice(2);
const apiPort = parseApiModePort(args);

if (apiPort !== null) {
  const { startApiMode } = await import('./api/server.js');
  await startApiMode({
    port: apiPort,
    mode: resolveBackendMode(args, true),
  });
} else {
  if (args.includes('--live')) {
    process.env.KAKAO_BACKEND = 'live';
  }

  const [{ render }, { default: App }] = await Promise.all([
    import('ink'),
    import('./app.js'),
  ]);
  render(<App />);
}

function resolveBackendMode(args: string[], apiMode: boolean): BackendMode {
  if (args.includes('--mock')) return 'mock';
  if (args.includes('--live')) return 'live';
  // API 서버는 카카오 기능 제공이 목적이라 별도 지정이 없으면 live로 둡니다.
  return apiMode ? 'live' : 'mock';
}

function parseApiModePort(args: string[]): number | null {
  const eqArg = args.find((arg) => arg.startsWith('--api-mode='));
  if (eqArg) return parsePort(eqArg.slice('--api-mode='.length) || String(DEFAULT_API_PORT));

  const flagIndex = args.findIndex((arg) => arg === '--api-mode' || arg === 'api-mode');
  if (flagIndex < 0) return null;

  const rawPort = args[flagIndex + 1];
  if (!rawPort || rawPort.startsWith('-')) return DEFAULT_API_PORT;
  return parsePort(rawPort);
}

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid api-mode port: ${raw}`);
  }
  return port;
}
