<img width="602" height="86" alt="image" src="https://arong.info/UploadImages/20260708115539_image.png" />

[![npm version](https://img.shields.io/npm/v/%40arooong%2Fkakao-cli?logo=npm)](https://www.npmjs.com/package/@arooong/kakao-cli)
[![npm downloads](https://img.shields.io/npm/dm/%40arooong%2Fkakao-cli?logo=npm)](https://www.npmjs.com/package/@arooong/kakao-cli)

> KakaoTalk CLI brings support to otherwise unsupported operating systems, such as Ubuntu.

# kakao-cli

This is a terminal-based (CUI) KakaoTalk client powered by the LOCO protocol.

## Screenshot
<img style="width: 50%;" alt="image" src="https://arong.info/UploadImages/20260708123140_image.png" />

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

Global install:

```bash
npm i -g @arooong/kakao-cli
```

After installation, the executable command is `kakao-cli`.

Local project install:

```bash
npm i @arooong/kakao-cli
npx kakao-cli
```

`npm kakao-cli` is not a valid npm command, and `npm run kakao-cli` only works if your own `package.json` defines that script.

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

## Running - API Mode

API mode starts an HTTP/WebSocket server. It uses live mode by default because the API is intended to expose real KakaoTalk access.

```bash
kakao-cli --api-mode 8880
```

Mock API server for local tests:

```bash
kakao-cli --api-mode 8880 --mock
```

By default the API server binds to `127.0.0.1`. To expose it on another interface:

```bash
KAKAO_API_HOST=0.0.0.0 kakao-cli --api-mode 8880
```

Sample HTML:

- Served from the API server root: `http://localhost:8880/`
- Included file: `examples/api-test.html`

### API

Health:

```http
GET /api/health
```

Friend list:

```http
GET /api/friends
```

The current client does not have a separate LOCO contacts API, so this returns 1:1 chat rooms as friend entries.

Chat room list:

```http
GET /api/rooms
```

Recent messages:

```http
GET /api/rooms/{roomId}/messages?limit=30
```

Send text message:

```http
POST /api/rooms/{roomId}/messages
Content-Type: application/json

{ "message": "hello" }
```

WebSocket real-time messages:

```text
ws://localhost:8880/ws/rooms/{roomId}
```

Message event shape:

```json
{
  "type": "message",
  "room": {
    "id": "123",
    "name": "Room",
    "type": "direct",
    "typeLabel": "1:1"
  },
  "message": {
    "roomType": "1:1",
    "time": "2026-07-08T00:00:00.000Z",
    "timestamp": 1783440000000,
    "nickname": "홍길동",
    "message": "hello"
  }
}
```

`typeLabel` / `roomType` values are `1:1`, `Group`, or `오픈`.

## Controls

| Key | Action |
|----|------|
| `↑` / `↓` | Navigate list or message log |
| `Enter` | Open selected chat room or send message |
| `Shift+Enter` | Insert newline while composing a message |
| `←` / `→` | Move message input cursor |
| `Home` / `End` | Move cursor to start/end of current input line |
| `Backspace` / `Delete` | Delete text while composing |
| `/paste-image` or `/img` | Send the image currently in the OS clipboard (live mode only) |
| `Tab` | Switch focus between left list and right chat pane |
| `Shift+Tab` | Toggle chat list / friend list while left pane is active |
| `Esc` | Move focus from right chat pane back to left list |
| `PageUp` / `PageDown` | Scroll message log |
| `q` / `Ctrl+C` | Quit |

Clipboard image support uses OS-specific clipboard access:

- macOS: built-in AppKit/JXA
- Windows: built-in PowerShell/.NET Clipboard
- Ubuntu/Linux: `wl-paste`, `xclip`, or `xsel` must be available depending on Wayland/X11

## Limitations & Risks

**[English]**
- Connection stability is not guaranteed. Kakao may change the unofficial LOCO/QR authentication flow at any time.
- There is a risk of permanent account suspension.
- Text chat support and clipboard image sending are implemented. Deep history paging is limited.

**[한글]**
- 연결이 안 될 수 있습니다. 카카오는 비공식 LOCO/QR 인증 흐름을 언제든 변경할 수 있습니다.
- 계정 영구 정지 위험이 있습니다.
- 텍스트 채팅과 클립보드 이미지 전송을 지원합니다. 깊은 히스토리 페이징은 제한적입니다.

## License

This library is for non-commercial use only.<br/>
Any use for spam, fraud, or other malicious purposes is strictly prohibited.
