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
The user pointed at `aodjo/KakaoForge` as the LOCO reference. Research found it **archived, source-deleted, and npm-unpublished (March 2026)** — unrecoverable, and non-commercially licensed anyway. The only usable MIT LOCO reference is **`storycraft/node-kakao`**, which is itself **deprecated (last release Nov 2021)** and may not connect to live 2026 servers without protocol patching (Kakao rotated the RSA key + changed the handshake enum 12→16 in Feb 2026).

### Decisions (defaults chosen while user was AFK — recommended options)
1. **Protocol backend: reuse `node-kakao`**, patch only if live login breaks. Fastest, laziest; the other options (vendor / reimplement) start from the same place.
2. **Testing: disposable Kakao account, user runs live login.** Device registration needs an interactive passcode sent to the user's phone — Advisor cannot run live login. All non-live parts are verified against a mock.
3. **Language: TypeScript**, run via `tsx` (no build step).

**Account-ban risk is real and permanent.** Unofficial LOCO clients violate Kakao ToS; abuse → permanent restriction. Use a throwaway account, stable persisted `deviceUUID`, human-paced sends (server returns `-303` when too fast).

## Architecture

The UI is **decoupled from the protocol** behind one interface (`KakaoClient`). This lets the ink UI be built + tested against a **mock** in parallel with the real node-kakao adapter, and lets us swap backends via an env var without touching the UI.

```
kakao-cli/
├─ package.json        # type:module, tsx scripts, ink7/react19.2/node-kakao
├─ tsconfig.json       # ESNext, moduleResolution NodeNext, jsx react-jsx, strict
├─ .npmrc             # legacy-peer-deps=true (ink add-ons declare older peers)
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
   │  ├─ node-kakao.ts # NodeKakaoClient — real adapter over node-kakao TalkClient [Worker P]
   │  └─ auth.ts       # NodeKakaoAuth — deviceUUID + token persistence; device registration [Worker P]
   └─ views/
      ├─ Login.tsx     # email/password + passcode entry
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
  login(input: { email: string; password: string;
                 onPasscodeNeeded: () => Promise<string> }): Promise<Credential>;
  logout(): Promise<void>;
}
```

**Unread is UI-owned** (not on the client): `Room.unreadCount` is the initial server count at connect; the UI seeds from it, increments on `'chat'` to a non-open room, resets to 0 on open. (Refined at the Wave-1 gate — removed `getUnread`/`'unread'` to kill a two-sources-of-truth ambiguity.)

Backend selection in `app.tsx` (a `getBackend()` returning a `{client, auth}` pair): `KAKAO_BACKEND=live` → node-kakao, else mock (default). Worker U wires the mock pair; Advisor adds the live pair at integration (keeps U's typecheck independent of Worker P's files).

## Delegation plan (waves, with Advisor verification gates)

**Wave 1 — Foundation (1 Worker).** Scaffold + `client.ts` contract + working `mock.ts` + minimal `cli.tsx`/`app.tsx` placeholder + `scripts/mock-smoke.ts`.
→ *Gate:* Advisor runs `npm install`, `npm run typecheck`, `npm run dev` (renders), `tsx scripts/mock-smoke.ts` (passes).

**Wave 2 — Parallel (2 Workers), both against the Wave-1 contract + mock.**
- **Worker U (UI):** `app.tsx` router + `views/Login.tsx`, `RoomList.tsx`, `ChatView.tsx`. Navigable rooms→chat, send appends, unread badges, live mock messages appear.
- **Worker P (Protocol):** `kakao/node-kakao.ts` adapter + `kakao/auth.ts` + `scripts/login-test.ts`. Handles device registration (`-100` → `requestPasscode` → `registerDevice`) + token persistence.
→ *Gate:* Advisor verifies typecheck + UI runs on mock end-to-end; auth token-persistence unit self-check; **live login is user-run** (documented, not Advisor-verified).

**Integration (Advisor, minor).** Wire `KAKAO_BACKEND=live` branch in `cli.tsx`; write README with the live-login run steps + risk warning.

## node-kakao integration notes (for Worker P)
- **ESM/CJS interop:** node-kakao is CJS. Import as `import kakao from 'node-kakao'; const { TalkClient, AuthApiClient, util } = kakao;` if named ESM imports fail.
- **Login flow:** `AuthApiClient.create(DEVICE_NAME, deviceUUID)` → `api.login({email,password}, /*forced*/true)`; on `-100` → `api.requestPasscode(form)` → `api.registerDevice(form, passcode, /*permanent*/true)` → login again. Then `new TalkClient()`, `client.login(loginRes.result)`.
- **Persist together:** `userId`, `deviceUUID`, `accessToken`, `refreshToken` in `auth.json` (chmod-restrict; gitignored). `deviceUUID` must be stable (`util.randomWin32DeviceUUID()` once).
- **Map to contract:** `client.channelList.all()` → Room[] (open chats are `TalkOpenChannel` → type 'open'); `channel.getDisplayName()`, unread via channel info/watermarks + `chat_read` event; `client.on('chat', (d,ch)=>…)` → emit 'chat'; `channel.sendChat(text)`.
- **64-bit IDs:** always `.toString()` channel/log/user IDs — never coerce to number.
- **Hot-swappable config:** RSA pubkey / booking+checkin hosts / handshake enum live in one config spot (Kakao rotates these).

## Verification plan
Advisor verifies directly (never trusts Worker's report):
- `npm install` clean; `npm run typecheck` (`tsc --noEmit`) passes.
- `npm run dev` renders without crashing the terminal frame.
- `tsx scripts/mock-smoke.ts` — asserts mock lists rooms + receives ≥1 timer-emitted message.
- UI on mock: navigate room list → open room → see history → send (appends) → incoming mock message appears live → unread badge updates.
- Auth self-check: token save→load round-trips; device-registration state machine (mocked API) hits `-100`→passcode→register→success.

**User-run (Advisor cannot do):** live login with disposable account via `npm run login`, then `KAKAO_BACKEND=live npm start`. Confirms the protocol actually connects in 2026; if it fails, capture the error/status for a targeted patch brief.

## Risks
- **node-kakao may not connect** (protocol drift). Mitigation: config-isolate the rotating bits; if broken, patch narrowly rather than reimplement.
- **Account ban.** Mitigation: disposable account, stable deviceUUID, paced sends.
- **Peer-dep/ESM friction** (ink7/react19.2 vs add-ons' older peers; node-kakao CJS). Mitigation: `.npmrc legacy-peer-deps=true`, default-import interop.
- **Node v25 is non-LTS.** ink7 needs ≥22 → fine; ignore tooling LTS warnings.
```
