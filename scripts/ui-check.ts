// UI regression check — drives the REAL <App/> on the mock via
// ink-testing-library (no TTY needed) and asserts each of the four flows.
// Run with: tsx scripts/ui-check.ts
import assert from 'node:assert';
import React from 'react';
import { render } from 'ink-testing-library';
import App from '../src/app.js';
import { MockKakaoClient } from '../src/kakao/mock.js';

const ENTER = '\r';
const TAB = '\t';
const ESC = String.fromCharCode(27); // 0x1B
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ink-testing-library flushes React's passive effects asynchronously, so the
// FIRST key delivered to a just-mounted view can land before that view's
// useInput listener is attached and be dropped. A single Tab is a no-op for
// every listener here (ink-text-input, the room/scroll handlers, the global
// keys, and ink's focus manager), so we send one to absorb that dropped event
// before the meaningful key. (Not a real-terminal issue — human-paced input
// always arrives well after effects settle.)
function warmup(stdin: { write: (s: string) => void }): void {
  stdin.write(TAB);
}

function show(title: string, frame: string | undefined): void {
  console.log(`\n===== ${title} =====`);
  console.log(frame ?? '(no frame)');
  console.log('-'.repeat(60));
}

function totalUnread(frame: string | undefined): number {
  const m = frame?.match(/합계:\s*(\d+)/);
  return m ? Number(m[1]) : Number.NaN;
}

async function main(): Promise<void> {
  // A throwaway mock client gives us the SAME deterministic (seeded) rooms and
  // history the App's own mock client will produce, so we can assert on exact
  // room name + last history line without hard-coding them.
  const probe = new MockKakaoClient();
  const probeRooms = (await probe.listRooms()).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const topRoom = probeRooms[0]; // RoomList sorts the same way; index 0 is opened
  const topHistory = await probe.getMessages(topRoom.id);
  const lastLine = topHistory[topHistory.length - 1].text;

  const { stdin, lastFrame } = render(React.createElement(App));
  await delay(120); // boot (loadSaved → null) → Login

  // (a) Login view shows the email prompt.
  let frame = lastFrame();
  show('(a) Login', frame);
  assert(frame?.includes('이메일'), 'Login should show the email prompt');

  // Submit mock credentials.
  stdin.write('tester@example.com');
  await delay(40);
  stdin.write(ENTER); // email → password
  await delay(40);
  stdin.write('secret');
  await delay(40);
  stdin.write(ENTER); // password → auth.login → passcode requested
  await delay(120);

  frame = lastFrame();
  show('(a→b) Passcode prompt', frame);
  assert(frame?.includes('인증번호'), 'passcode field should appear during login');

  stdin.write('000000');
  await delay(40);
  stdin.write(ENTER); // passcode → login resolves → RoomList
  await delay(150);

  // (b) RoomList shows mock rooms, an unread badge, and the open-chat marker.
  frame = lastFrame();
  show('(b) Room list', frame);
  assert(frame?.includes('김민준'), 'room list should show 김민준');
  assert(frame?.includes('가족 단톡방'), 'room list should show 가족 단톡방');
  assert(frame?.includes(String(topRoom.name)), `room list should show ${topRoom.name}`);
  assert(frame?.includes('●'), 'room list should show at least one unread badge');
  assert(frame?.includes('[오픈]'), 'room list should show the open-chat marker');

  // (c) Opening the top room shows its history + the composer.
  warmup(stdin);
  await delay(40);
  stdin.write(ENTER); // open selected room (index 0)
  await delay(180);
  frame = lastFrame();
  show('(c) Chat view', frame);
  assert(frame?.includes('코딩 오픈챗'), 'chat header should show the room name');
  assert(frame?.includes('입력'), 'chat should show the composer placeholder');
  assert(frame?.includes(lastLine), `chat should show last history line "${lastLine}"`);

  // (d) Typing a line + Enter shows my sent message in the log.
  const mine = '테스트메시지ABC';
  warmup(stdin);
  await delay(40);
  stdin.write(mine);
  await delay(60);
  stdin.write(ENTER);
  await delay(180);
  frame = lastFrame();
  show('(d) After sending', frame);
  assert(frame?.includes(mine), 'sent message should appear in the log');
  assert(frame?.includes('나'), 'sent message should be attributed to 나');

  // (e) Back to the list, then a mock incoming chat bumps unread.
  stdin.write(ESC); // chat → rooms (handled by the App-level global key handler)
  await delay(120);
  frame = lastFrame();
  show('(e) Back to list', frame);
  const before = totalUnread(frame);
  assert(Number.isFinite(before), 'status line total should be readable');

  // The mock emits an incoming (non-mine) chat every 4s; in list view that
  // increments the target room's unread. Poll until the total grows.
  let after = before;
  const deadline = Date.now() + 14000;
  while (Date.now() < deadline) {
    await delay(500);
    const f = lastFrame();
    const n = totalUnread(f);
    if (Number.isFinite(n) && n > before) {
      after = n;
      frame = f;
      break;
    }
  }
  show('(e) After incoming chat', frame);
  assert(after > before, `unread total should grow (before=${before}, after=${after})`);

  console.log(`\nui-check OK — unread ${before} → ${after}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nui-check FAILED:', err);
  process.exit(1);
});
