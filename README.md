<img width="602" height="86" alt="image" src="https://arong.info/UploadImages/20260708115539_image.png" />

> KakaoTalk CLI brings support to otherwise unsupported operating systems, such as Ubuntu.

# kakao-cli

This is a terminal-based (CUI) KakaoTalk client powered by the LOCO protocol.

## Features

- Login
- Chat & Open Chat List
- Split chat list / active chat room UI
- Real-time message transmission & reception (text)
- Real-time unread count

---

**This is an unofficial client that utilizes the LOCO/QR authentication flow.**

**[한글]**
- 카카오 서비스 약관(ToS) 위반이며, 사용 시 계정이 영구 정지될 수 있습니다.
- 반드시 일회용 계정으로만 사용하세요. 주 계정을 쓰지 마세요.
- 토큰(`auth.json`)과 기기 UUID(`.device-uuid`)는 민감 정보입니다. 공유하거나 커밋하지 마세요.

## Requirements

Node.js >= 22. Ink 7 is ESM-only.

## Install

```bash
npm i -g @arooong/kakao-cli
```

After installation, the executable command is `kakao-cli`.

## Running - Mock Mode

Mock mode is the default. It does not connect to the actual server and does not require an account.

```bash
kakao-cli
```

## Running - Live Mode

Live mode starts QR login if no saved credentials (`auth.json`) are found.

```bash
kakao-cli --live
```

**[English]**
- Scan the QR code displayed in the terminal using your KakaoTalk app.
- After scanning, check if the verification code shown on your phone matches the one in the terminal.
- Once authenticated, your credentials will be saved to `auth.json`.
- If the saved credentials expire or authentication fails, the app will delete `auth.json` and return to the login screen.

**[한글]**
- 터미널에 표시된 QR을 카카오톡 앱에서 스캔하세요.
- QR 스캔 뒤 휴대폰에 확인 코드가 표시되면 터미널의 코드와 같은지 확인하세요.
- 인증이 끝나면 자격 증명이 `auth.json`에 저장됩니다.
- 저장된 인증 정보가 만료되었거나 실패하면 `auth.json`을 지우고 다시 로그인 화면으로 돌아갑니다.

## Controls

| Key | Action |
|----|------|
| `↑` / `↓` | Navigate list or message log |
| `Enter` | Open selected chat room or send message |
| `Shift+Enter` | Insert newline while composing a message |
| `←` / `→` | Move message input cursor |
| `Home` / `End` | Move cursor to start/end of current input line |
| `Backspace` / `Delete` | Delete text while composing |
| `Tab` | Switch focus between left list and right chat pane |
| `Shift+Tab` | Toggle chat list / friend list while left pane is active |
| `Esc` | Move focus from right chat pane back to left list |
| `PageUp` / `PageDown` | Scroll message log |
| `q` / `Ctrl+C` | Quit |

## Development

```bash
pnpm install
pnpm run start       # mock mode
pnpm run start:live  # live mode
```

Validation:

```bash
pnpm run typecheck
pnpm run smoke
pnpm run check:protocol
pnpm run check:ui
```

## npm Publish

The npm package is bundled into `dist/cli.js` with esbuild and obfuscated with `javascript-obfuscator`. The tarball includes `dist/cli.js`, `README.md`, `THIRD_PARTY_NOTICES.md`, and `package.json`.

```bash
pnpm run build
npm pack --dry-run
pnpm run publish:npm
```

If your npm account uses browser or biometric authentication, press Enter at the OTP prompt and complete the npm browser flow.

If you use an authenticator app OTP:

```bash
pnpm run publish:npm -- --otp 123456
```

If you use an automation token, create a granular access token with `Read and write` permission and `Bypass two-factor authentication` enabled:

```bash
NPM_TOKEN=npm_xxx pnpm run publish:npm
```

Already published versions cannot be published again. Bump `package.json` version before each new npm release.

## Limitations & Risks

**[English]**
- Connection stability is not guaranteed. Kakao may change the unofficial LOCO/QR authentication flow at any time.
- There is a risk of permanent account suspension.
- Text-only support. Deep history paging is not supported.

**[한글]**
- 연결이 안 될 수 있습니다. 카카오는 비공식 LOCO/QR 인증 흐름을 언제든 변경할 수 있습니다.
- 계정 영구 정지 위험이 있습니다.
- 텍스트 메시지 전용입니다. 깊은 히스토리 페이징은 미지원입니다.

## License

This library is for non-commercial use only.<br/>
Any use for spam, fraud, or other malicious purposes is strictly prohibited.
