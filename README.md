<img width="602" height="86" alt="image" src="https://github.com/user-attachments/assets/43db3f96-bf95-498a-a65b-27e4de1880b4" />


> KakaoTalk CLI brings support to otherwise unsupported operating systems, such as Ubuntu.

# kakao-cli

This is a terminal-based (CUI) KakaoTalk client powered by the LOCO protocol.

## Features

- Login
- Chat & Open Chat List
- Real-time message transmission & reception (Text)
- Real-time unread count

---

**This is an unofficial client that utilizes the LOCO/QR authentication flow.**

## Requirements
Node.js ≥ 22 (Developed and tested on v25.9). Ink 7 is ESM-only.

## Install

```
npm i -g @arooong/kakao-cli
```

## Running — Mock Mode (Default, No Account Required)

without connecting to the actual server. It is safe and does not require an account.

```
kakao-cli
```

## Running — Live Mode (Actual Connection)

Running the app in live mode will initiate the QR login process if no saved credentials (`auth.json`) are found.

```
kakao-cli --live
```

**[English]**
- Scan the QR code displayed in the terminal using your KakaoTalk app.
- After scanning, check if the verification code shown on your phone matches the one in the terminal.
- Once authenticated, your credentials will be saved to `auth.json` (enabling automatic login next time).
- If the saved credentials expire or authentication fails, the app will delete `auth.json` and return to the login screen.

**[한글]**
- 터미널에 표시된 QR을 카카오톡 앱에서 스캔하세요.
- QR 스캔 뒤 휴대폰에 확인 코드가 표시되면 터미널의 코드와 같은지 확인하세요.
- 인증이 끝나면 자격 증명이 `auth.json`에 저장됩니다(다음부터는 자동 로그인).
- 저장된 인증 정보가 만료되었거나 실패하면 `auth.json`을 지우고 다시 로그인 화면으로 돌아갑니다.

## Controls

| Key | Action |
|----|------|
| `↑` / `↓` (Or `j` / `k`) | Navigate lists/messages |
| `Enter` | Navigate lists/messages |
| `Esc` | Navigate lists/messages |
| `PageUp` / `PageDown` | Navigate lists/messages |
| `q` / `Ctrl+C` | Quit |


## Limitations & Risks

**[English]**
- **Connection stability is not guaranteed.** Kakao may change the unofficial LOCO/QR authentication flow at any time. If live login fails, it could be due to changes in the QR authentication or V2SL/CHECKIN/LOGINLIST protocols.
- **Risk of permanent account suspension**
- **Text-only support.** Deep history paging is not supported (only recent messages in the current window are viewable).

**[한글]**
- **연결이 안 될 수 있음.** 카카오는 비공식 LOCO/QR 인증 흐름을 언제든 변경할 수 있습니다. live 로그인이 실패하면 QR 인증 또는 V2SL/CHECKIN/LOGINLIST 변경 때문일 수 있습니다.
- **계정 영구 정지 위험**
- 텍스트 메시지 전용. 깊은 히스토리 페이징은 미지원(최근 창만 조회).

## License

This library is for non-commercial use only.<br/>
Any use for spam, fraud, or other malicious purposes is strictly prohibited.
