# kakao-cli

카카오톡 LOCO 프로토콜 기반 **터미널(CUI) 클라이언트**. Node.js + [ink](https://github.com/vadimdemedes/ink)(React for CLI)로 만들었습니다.

기능: 로그인 · 채팅/오픈채팅 목록 · 채팅방 실시간 메시지 송수신(텍스트) · 실시간 안읽은 수.

---

## ⚠️ 경고 — 반드시 읽어주세요

이 클라이언트는 **비공식**이며 카카오 역공학 프로토콜(node-kakao)을 사용합니다.

- **카카오 서비스 약관(ToS) 위반**이며, 사용 시 **계정이 영구 정지될 수 있습니다.** 이 위험은 실제이고 되돌릴 수 없습니다.
- 반드시 **일회용(버리는) 계정**으로만 사용하세요. 주 계정을 쓰지 마세요.
- 토큰(`auth.json`)과 기기 UUID(`.device-uuid`)는 민감 정보입니다. 공유·커밋하지 마세요(`.gitignore`에 이미 제외됨).

## 요구사항

- **Node.js ≥ 22** (개발/검증은 v25.9). ink 7은 ESM 전용입니다.
- 빌드 단계 없음 — TypeScript를 `tsx`로 바로 실행합니다.

## 설치

```
npm install
```

## 실행 — 목업(mock) 모드 (기본, 계정 불필요)

실제 서버에 연결하지 않고 가짜 데이터로 UI를 확인합니다. 안전하며 계정이 필요 없습니다.

```
npm run dev      # 파일 변경 감지(개발용)
npm start        # 1회 실행
```

## 실행 — 실제 연결(live) 모드

**1단계 — 최초 1회: 로그인 + 기기 등록**

```
# PowerShell
$env:KAKAO_EMAIL="you@example.com"; $env:KAKAO_PASSWORD="비밀번호"; npm run login

# bash
KAKAO_EMAIL=you@example.com KAKAO_PASSWORD=비밀번호 npm run login
```

- 이 기기의 첫 로그인에서는 카카오가 **휴대폰으로 패스코드**를 보냅니다. 프롬프트에 입력하면 기기가 등록되고 자격 증명이 `auth.json`에 저장됩니다(다음부터는 자동 로그인).
- 방 목록이 출력되고, 30초간 수신 메시지를 대기합니다. 한 번 보내보려면 `KAKAO_TEST_SEND="<roomId>::<보낼 텍스트>"`를 함께 지정하세요.

**2단계 — 앱을 live 모드로 실행**

```
# PowerShell
$env:KAKAO_BACKEND="live"; npm start

# bash
KAKAO_BACKEND=live npm start
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
                                                                 └─ node-kakao (live)
```

백엔드는 `KAKAO_BACKEND` 환경변수로 선택합니다(`live` = node-kakao, 그 외 = mock). 설계 상세는 [`PLAN.md`](./PLAN.md) 참고.

## 검증

```
npm run typecheck        # 타입 검사
npm run smoke            # 목업 어댑터 자체 점검
npm run check:protocol   # 프로토콜/인증 지속성 (네트워크 불필요)
npm run check:ui         # ink UI (ink-testing-library)
```

## 알려진 한계 / 위험

- **연결이 안 될 수 있음.** node-kakao는 2021년 이후 미유지보수이고, 카카오는 2026년 초 RSA 키·핸드셰이크를 교체했습니다. live 로그인이 실패하면 프로토콜 변경 때문일 수 있으며, 유일한 패치 지점은 `src/kakao/node-kakao.ts`의 `PROTOCOL_CONFIG`입니다.
- **계정 영구 정지 위험** (위 경고 참고).
- 텍스트 메시지 전용. 깊은 히스토리 페이징은 미지원(최근 창만 조회).

## 라이선스

node-kakao: MIT. 본 프로젝트: 미정.
