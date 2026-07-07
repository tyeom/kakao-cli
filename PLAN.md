# KakaoTalk CLI (LOCO) — Implementation Plan

> Role split: **Advisor** (main session) writes this plan, delegates coding to **Worker** (Opus subagents), and verifies every result with diffs + builds/tests. Workers do all implementation.

## Context

Goal: a terminal (CUI) KakaoTalk client in Node.js using **ink** (React for CLI). Features required:
- User login
- Chat + open-chat room list
- Per-room message history, real-time send/receive of text
- Real-time unread counts

Out of scope (explicitly): file send/receive, replies/threads, reactions, media.

### The reference is dead — what changed the plan
The live backend now follows the `play2fly/KakaoForge` QR + Android sub-device + V2SL LOCO flow. The older `node-kakao` PC flow was removed because it uses obsolete PC auth/version and the older secure-layer handshake.

### Decisions (defaults chosen while user was AFK — recommended options)
1. **Protocol backend: QR auth + direct V2SL LOCO adapter**, based on KakaoForge behavior.
2. **Testing: disposable Kakao account, user runs live QR login.** QR approval happens on the user's phone, so live auth cannot be fully verified by Advisor.
3. **Language: TypeScript**, run via `tsx` (no build step).

**Account-ban risk is real and permanent.** Unofficial LOCO clients violate Kakao ToS; abuse → permanent restriction. Use a throwaway account, stable persisted `deviceUUID`, human-paced sends (server returns `-303` when too fast).

## Architecture

The UI is **decoupled from the protocol** behind one interface (`KakaoClient`). This lets the ink UI be built + tested against a **mock** in parallel with the real QR/V2SL adapter, and lets us swap backends via an env var without touching the UI.

```
kakao-cli/
├─ package.json        # type:module, tsx scripts, ink7/react19.2, bson, qrcode-terminal
├─ tsconfig.json       # ESNext, moduleResolution NodeNext, jsx react-jsx, strict
├─ .npmrc             # strict-peer-dependencies=false (ink add-ons declare older peers)
├─ .gitignore          # node_modules, auth.json, .env
├─ scripts/
│  ├─ mock-smoke.ts    # assert-based self-check of the mock adapter
│  └─ login-test.ts    # headless login harness the USER runs w/ real account
└─ src/
   ├─ cli.tsx          # entry (#!/usr/bin/env node) → render(<App/>); picks backend
   ├─ app.tsx          # view router (login→rooms→chat) + KakaoClient context/state
   ├─ kakao/
   │  ├─ client.ts     # KakaoClient + AuthProvider interfaces + Room/Message/Credential (CONTRACT)
   │  ├─ mock.ts       # MockKakaoClient — fake rooms/messages + timer-emitted events [Wave 1]
   │  ├─ mock-auth.ts  # MockAuthProvider — accepts any creds; drives login UI on mock [Worker U]
   │  ├─ forge-client.ts    # ForgeKakaoClient — QR/V2SL LOCO adapter
   │  ├─ forge-protocol.ts  # QR auth helpers + LOCO packet/V2SL/checkin clients
   │  └─ auth.ts            # NodeKakaoAuth — deviceUUID + token persistence; QR login
   └─ views/
      ├─ Login.tsx     # QR login display
      ├─ RoomList.tsx  # rooms + open chats, unread badges (ink-select-input)
      └─ ChatView.tsx  # windowed message log + composer (ink-text-input)
```

### The contract (`src/kakao/client.ts`) — both adapters implement this
```ts
import type { EventEmitter } from 'node:events';

export type RoomType = 'direct' | 'group' | 'open';

export interface Room {
  id: string;            // channelId as string — 64-bit-safe, never a JS number
  name: string;
  type: RoomType;
  unreadCount: number;
  lastMessage?: string;
  lastAt?: number;       // epoch ms
}
export interface Message {
  id: string;            // logId as string
  roomId: string;
  senderId: string;
  senderName: string;
  text: string;
  at: number;            // epoch ms
  isMine: boolean;
}
export interface Credential {
  userId: string;
  deviceUUID: string;
  accessToken: string;
  refreshToken: string;
}
// Events: 'chat'(Message) | 'room-update'(Room)
//         | 'connected'() | 'disconnected'(reason) | 'error'(Error)
export interface KakaoClient extends EventEmitter {
  login(cred: Credential): Promise<void>;
  listRooms(): Promise<Room[]>;
  getMessages(roomId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
  sendMessage(roomId: string, text: string): Promise<void>;
  disconnect(): Promise<void>;
}
export interface AuthProvider {           // login seam (mock-auth.ts | auth.ts)
  loadSaved(): Promise<Credential | null>;
  login(input: { onQrCode: (qr: string) => void;
                 onPasscode: (passcode: string) => void;
                 onStatus?: (status: string) => void }): Promise<Credential>;
  logout(): Promise<void>;
}
```

**Unread is UI-owned** (not on the client): `Room.unreadCount` is the initial server count at connect; the UI seeds from it, increments on `'chat'` to a non-open room, resets to 0 on open. (Refined at the Wave-1 gate — removed `getUnread`/`'unread'` to kill a two-sources-of-truth ambiguity.)

Backend selection in `app.tsx` (a `getBackend()` returning a `{client, auth}` pair): `KAKAO_BACKEND=live` or `pnpm run start:live` → QR/V2SL LOCO, else mock (default).

## Delegation plan (waves, with Advisor verification gates)

**Wave 1 — Foundation (1 Worker).** Scaffold + `client.ts` contract + working `mock.ts` + minimal `cli.tsx`/`app.tsx` placeholder + `scripts/mock-smoke.ts`.
→ *Gate:* Advisor runs `pnpm install`, `pnpm run typecheck`, `pnpm run dev` (renders), `pnpm exec tsx scripts/mock-smoke.ts` (passes).

**Wave 2 — Parallel (2 Workers), both against the Wave-1 contract + mock.**
- **Worker U (UI):** `app.tsx` router + `views/Login.tsx`, `RoomList.tsx`, `ChatView.tsx`. Navigable rooms→chat, send appends, unread badges, live mock messages appear.
- **Protocol:** `kakao/forge-client.ts` + `kakao/forge-protocol.ts` + `kakao/auth.ts` + `scripts/login-test.ts`. Handles QR login, token persistence, CHECKIN, LOGINLIST, LCHATLIST/SYNCMSG/WRITE.
→ *Gate:* Advisor verifies typecheck + UI runs on mock end-to-end; auth token-persistence unit self-check; **live login is user-run** (documented, not Advisor-verified).

**Integration (Advisor, minor).** Wire `KAKAO_BACKEND=live` branch in `cli.tsx`; write README with the live-login run steps + risk warning.

## QR/V2SL integration notes
- **QR login flow:** `qrCodeLogin/generate` → display terminal QR → poll `qrCodeLogin/login` → save `userId`, `deviceUUID`, `accessToken`, `refreshToken`.
- **LOCO flow:** booking `GETCONF` → ticket/booking `CHECKIN` → V2SL handshake → `LOGINLIST`.
- **Contract mapping:** chat list payloads → Room[]; `MSG` pushes and `SYNCMSG` logs → Message[]; `WRITE` sends text.
- **64-bit IDs:** always `.toString()` channel/log/user IDs — never coerce to number.

## Verification plan
Advisor verifies directly (never trusts Worker's report):
- `pnpm install` clean; `pnpm run typecheck` (`tsc --noEmit`) passes.
- `pnpm run dev` renders without crashing the terminal frame.
- `pnpm exec tsx scripts/mock-smoke.ts` — asserts mock lists rooms + receives ≥1 timer-emitted message.
- UI on mock: navigate room list → open room → see history → send (appends) → incoming mock message appears live → unread badge updates.
- Auth self-check: token save→load round-trips; QR UI is covered by the mock provider.

**User-run (Advisor cannot do):** live login with disposable account via `pnpm run start:live` (or protocol-only check via `pnpm run login`). Confirms the protocol actually connects in 2026; if it fails, capture the error/status for a targeted patch brief.

## Risks
- **QR/V2SL may drift** if Kakao changes private endpoints or packet formats. Mitigation: protocol code is isolated in `forge-protocol.ts`.
- **Account ban.** Mitigation: disposable account, stable deviceUUID, paced sends.
- **Peer-dep/ESM friction** (ink7/react19.2 vs add-ons' older peers). Mitigation: `.npmrc strict-peer-dependencies=false`.
- **Node v25 is non-LTS.** ink7 needs ≥22 → fine; ignore tooling LTS warnings.
```
