# kakao-cli

카카오톡 LOCO 프로토콜 기반 **터미널(CUI) 클라이언트**. Node.js + [ink](https://github.com/vadimdemedes/ink)(React for CLI)로 만들었습니다.

기능: 로그인 · 채팅/오픈채팅 목록 · 채팅방 실시간 메시지 송수신(텍스트) · 실시간 안읽은 수.

---

## ⚠️ 경고 — 반드시 읽어주세요

이 클라이언트는 **비공식**이며 KakaoForge 계열의 카카오 역공학 LOCO/QR 인증 흐름을 사용합니다.

- **카카오 서비스 약관(ToS) 위반**이며, 사용 시 **계정이 영구 정지될 수 있습니다.** 이 위험은 실제이고 되돌릴 수 없습니다.
- 반드시 **일회용(버리는) 계정**으로만 사용하세요. 주 계정을 쓰지 마세요.
- 토큰(`auth.json`)과 기기 UUID(`.device-uuid`)는 민감 정보입니다. 공유·커밋하지 마세요(`.gitignore`에 이미 제외됨).

## 요구사항

- **Node.js ≥ 22** (개발/검증은 v25.9). ink 7은 ESM 전용입니다.
- 빌드 단계 없음 — TypeScript를 `tsx`로 바로 실행합니다.

## 설치

```
pnpm install
```

## 실행 — 목업(mock) 모드 (기본, 계정 불필요)

실제 서버에 연결하지 않고 가짜 데이터로 UI를 확인합니다. 안전하며 계정이 필요 없습니다.

```
pnpm run dev      # 파일 변경 감지(개발용)
pnpm run start    # 1회 실행
```

## 실행 — 실제 연결(live) 모드

앱을 live 모드로 실행하면 저장된 인증 정보(`auth.json`)가 없을 때 QR 로그인을 시작합니다.

```
pnpm run start:live
```

- 터미널에 표시된 QR을 카카오톡 앱에서 스캔하세요.
- QR 스캔 뒤 휴대폰에 확인 코드가 표시되면 터미널의 코드와 같은지 확인하세요.
- 인증이 끝나면 자격 증명이 `auth.json`에 저장됩니다(다음부터는 자동 로그인).
- 저장된 인증 정보가 만료되었거나 실패하면 `auth.json`을 지우고 다시 로그인 화면으로 돌아갑니다.

로그인/프로토콜 연결만 먼저 확인하려면 아래 점검 스크립트를 실행하세요. 이 스크립트도 QR 로그인을 사용합니다.

```
pnpm run login
```

## 조작법

| 키 | 동작 |
|----|------|
| `↑` / `↓` (또는 `j` / `k`) | 목록/메시지 이동 |
| `Enter` | 채팅방 열기 · 메시지 전송 |
| `Esc` | 채팅방 → 목록으로 뒤로가기 |
| `PageUp` / `PageDown` | 메시지 로그 스크롤 |
| `q` / `Ctrl+C` | 종료 |

## 범위

지원: 로그인(기기 등록 포함), 채팅방·오픈채팅 목록, 채팅방 메시지 조회 및 실시간 송수신(텍스트), 실시간 안읽은 수.

**의도적 미지원**(요구사항 밖): 파일/미디어 송수신, 답장/스레드, 리액션.

## 구조

UI와 프로토콜은 하나의 인터페이스(`KakaoClient`)로 분리되어 있습니다.

```
ink UI  ↔  KakaoClient / AuthProvider (src/kakao/client.ts)  ↔  백엔드 어댑터
                                                                 ├─ mock       (기본)
                                                                 └─ QR + V2SL LOCO (live)
```

백엔드는 `KAKAO_BACKEND` 환경변수로 선택합니다(`live` = QR + V2SL LOCO, 그 외 = mock). 설계 상세는 [`PLAN.md`](./PLAN.md) 참고.

## 검증

```
pnpm run typecheck        # 타입 검사
pnpm run smoke            # 목업 어댑터 자체 점검
pnpm run check:protocol   # 프로토콜/인증 지속성 (네트워크 불필요)
pnpm run check:ui         # ink UI (ink-testing-library)
```

## 알려진 한계 / 위험

- **연결이 안 될 수 있음.** 카카오는 비공식 LOCO/QR 인증 흐름을 언제든 변경할 수 있습니다. live 로그인이 실패하면 QR 인증 또는 V2SL/CHECKIN/LOGINLIST 변경 때문일 수 있습니다.
- **계정 영구 정지 위험** (위 경고 참고).
- 텍스트 메시지 전용. 깊은 히스토리 페이징은 미지원(최근 창만 조회).

## 라이선스

KakaoForge 참고 구현: Non-Commercial / No Abuse License. 자세한 고지는 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) 참고.
본 프로젝트: 미정.
