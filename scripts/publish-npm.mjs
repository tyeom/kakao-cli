import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const passthrough = [];
let otp = process.env.NPM_CONFIG_OTP || process.env.NPM_OTP || '';
const npmToken = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN || '';

// pnpm run publish:npm -- --otp 123456 형태와 NPM_CONFIG_OTP 환경변수를 모두 지원합니다.
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];

  if (arg === '--') {
    continue;
  }

  if (arg === '--otp') {
    otp = args[i + 1] || '';
    i += 1;
    continue;
  }

  if (arg.startsWith('--otp=')) {
    otp = arg.slice('--otp='.length);
    continue;
  }

  passthrough.push(arg);
}

const isDryRun = passthrough.some((arg) => arg === '--dry-run' || arg === '--dry-run=true');

await run('pnpm', ['run', 'build']);

if (!otp && !npmToken && !isDryRun && input.isTTY && output.isTTY) {
  const rl = createInterface({ input, output });
  try {
    // OTP가 없으면 npm CLI의 브라우저/생체인식 인증 흐름으로 넘깁니다.
    otp = (await rl.question('npm OTP 6자리 입력 또는 Enter로 브라우저/생체인식 인증 사용: ')).trim();
  } finally {
    rl.close();
  }
}

if (npmToken) {
  console.log('NPM_TOKEN 감지됨: OTP 입력 없이 token 기반 publish를 시도합니다.');
} else if (!otp && !isDryRun) {
  console.log('OTP 없이 npm 브라우저/생체인식 인증 흐름을 사용합니다.');
}

// build는 위에서 직접 수행했으므로 npm publish 단계의 prepack 재실행은 막습니다.
const publishArgs = [
  'publish',
  '--access',
  'public',
  '--ignore-scripts',
  ...passthrough,
];

if (otp) publishArgs.push(`--otp=${otp}`);

const { env, cleanup } = await npmPublishEnv(npmToken);
const useInteractiveNpmAuth = !otp && !npmToken && !isDryRun;
try {
  await run('npm', publishArgs, { env, captureOutput: !useInteractiveNpmAuth });
} catch (err) {
  const outputText = getRunOutput(err);

  if (useInteractiveNpmAuth) {
    console.error('');
    console.error('npm 브라우저/생체인식 인증 publish가 실패했습니다.');
    console.error('- npm이 표시한 URL을 브라우저에서 열고 인증을 완료한 뒤 터미널 흐름을 끝까지 진행하세요.');
    console.error('- 계속 실패하면 OTP 방식으로 실행하세요: pnpm run publish:npm -- --otp 123456');
    console.error('- 또는 Bypass 2FA가 켜진 granular token을 사용하세요: NPM_TOKEN=npm_xxx pnpm run publish:npm');
  } else if (/package name too similar|too similar to existing package/i.test(outputText)) {
    console.error('');
    console.error('npm 패키지명이 기존 패키지와 너무 유사해서 거부되었습니다.');
    console.error("- package.json의 name은 '@arooong/kakao-cli' 같은 scoped 이름을 사용하세요.");
    console.error("- bin 이름은 그대로 'kakao-cli'로 둘 수 있으므로 설치 후 실행 명령은 kakao-cli입니다.");
  } else if (/code EOTP|one-time password|requires a one-time password/i.test(outputText)) {
    console.error('');
    console.error('npm publish에 OTP가 필요합니다.');
    console.error('- 프롬프트에서 Enter만 누르지 말고 인증 앱의 6자리 코드를 입력하세요.');
    console.error('- 다시 실행: pnpm run publish:npm -- --otp 123456');
    console.error('- 이메일 코드가 아니라 npm 2FA 인증 앱 또는 보안키 인증 흐름의 코드입니다.');
  } else if (/cannot publish over the previously published versions|previously published versions/i.test(outputText)) {
    console.error('');
    console.error('이미 npm에 배포된 버전입니다.');
    console.error('- 같은 package name + version 조합은 다시 publish할 수 없습니다.');
    console.error('- 다음 배포는 package.json의 version을 올린 뒤 실행하세요. 예: 0.1.1');
  } else if (/two-factor authentication|bypass 2fa/i.test(outputText) && npmToken) {
    console.error('');
    console.error('NPM_TOKEN publish가 거부되었습니다.');
    console.error('- 토큰이 Read and write 권한인지 확인하세요.');
    console.error('- 토큰 생성 시 Bypass two-factor authentication을 체크했는지 확인하세요.');
    console.error('- Bypass 2FA는 기존 토큰에서 수정하는 값이 아니라 새 토큰 생성 시 정해집니다.');
    console.error('- 토큰을 채팅/로그에 노출했다면 npm 웹에서 즉시 revoke 후 새로 만드세요.');
  } else if (/two-factor authentication|bypass 2fa/i.test(outputText)) {
    console.error('');
    console.error('npm publish가 2FA 요구로 거부되었습니다.');
    console.error('- npm 계정 2FA를 다시 켜고 인증 앱 OTP로 배포하거나,');
    console.error('- Bypass 2FA가 켜진 granular access token을 NPM_TOKEN으로 전달하세요.');
  } else {
    console.error('');
    console.error('npm publish가 실패했습니다. 위 npm error 내용을 기준으로 원인을 확인하세요.');
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}

async function npmPublishEnv(token) {
  if (!token) {
    return {
      env: process.env,
      cleanup: async () => {},
    };
  }

  const dir = await mkdtemp(join(tmpdir(), 'kakao-cli-npm-'));
  const userconfig = join(dir, '.npmrc');
  await writeFile(
    userconfig,
    [
      'registry=https://registry.npmjs.org/',
      `//registry.npmjs.org/:_authToken=${token}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  return {
    env: {
      ...process.env,
      NPM_CONFIG_USERCONFIG: userconfig,
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function getRunOutput(err) {
  return typeof err?.output === 'string' ? err.output : String(err?.message || '');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const captureOutput = Boolean(options.captureOutput);
    const child = spawn(command, args, {
      stdio: captureOutput ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      env: options.env || process.env,
    });
    let outputText = '';

    if (captureOutput) {
      // npm이 같은 E403 코드로 여러 원인을 반환하므로 출력 내용을 보존해서 원인을 구분합니다.
      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        outputText += text;
        process.stdout.write(chunk);
      });
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        outputText += text;
        process.stderr.write(chunk);
      });
    }

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const err = new Error(`${command} ${args.join(' ')} failed with exit code ${code}`);
      err.output = outputText;
      reject(err);
    });
  });
}
