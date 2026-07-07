// ink-testing-library로 실제 <App/>을 mock 백엔드에서 구동하는 UI 회귀 테스트입니다.
// TTY 없이 QR 로그인, 방 목록, 채팅, 전송, 읽지 않음 갱신 흐름을 확인합니다.
// 실행: tsx scripts/ui-check.ts
import assert from 'node:assert';
import React from 'react';
import { render } from 'ink-testing-library';
import App from '../src/app.js';
import { MockKakaoClient } from '../src/kakao/mock.js';

const ENTER = '\r';
const TAB = '\t';
const ESC = String.fromCharCode(27); // ESC 키
const DOWN = '\u001B[B';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ink-testing-library에서는 React effect 연결보다 첫 키 입력이 먼저 도착할 수 있습니다.
// 의미 있는 키를 보내기 전에 no-op에 가까운 Tab을 한 번 보내서 테스트 타이밍을 안정화합니다.
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
  // throwaway mock client로 App 내부 mock과 같은 deterministic 방/히스토리를 얻습니다.
  // 하드코딩 대신 실제 mock 데이터에서 기대값을 뽑아 검증합니다.
  const probe = new MockKakaoClient();
  const probeRooms = (await probe.listRooms()).sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0));
  const topRoom = probeRooms[0]; // RoomList도 같은 정렬을 사용하므로 index 0이 첫 선택입니다.
  const topHistory = await probe.getMessages(topRoom.id);
  const lastLine = topHistory[topHistory.length - 1].text;

  const { stdin, lastFrame } = render(React.createElement(App));
  await delay(120); // boot(loadSaved → null) 후 Login 화면 진입

  // (a) 로그인 화면이 QR 흐름을 보여준 뒤 mock-auth가 자동 완료됩니다.
  let frame = lastFrame();
  show('(a) Login', frame);
  assert(frame?.includes('QR 로그인'), 'Login should show the QR login prompt');

  await delay(80);
  frame = lastFrame();
  show('(a→b) QR prompt', frame);
  assert(frame?.includes('mock QR'), 'mock QR should appear during login');

  await delay(180); // mock QR/passcode → login 완료 → RoomList

  // (b) RoomList가 mock 방, 읽지 않음 배지, 오픈채팅 표시를 보여줍니다.
  frame = lastFrame();
  show('(b) Room list', frame);
  assert(frame?.includes('김민준'), 'room list should show 김민준');
  assert(frame?.includes('가족 단톡방'), 'room list should show 가족 단톡방');
  assert(frame?.includes(String(topRoom.name)), `room list should show ${topRoom.name}`);
  assert(frame?.includes('●'), 'room list should show at least one unread badge');
  assert(frame?.includes('[오픈]'), 'room list should show the open-chat marker');

  // (c) 첫 방을 열면 히스토리와 입력창이 보입니다.
  warmup(stdin);
  await delay(40);
  stdin.write(ENTER); // 선택된 첫 방을 엽니다.
  await delay(180);
  frame = lastFrame();
  show('(c) Chat view', frame);
  assert(frame?.includes('코딩 오픈챗'), 'chat header should show the room name');
  assert(frame?.includes('입력'), 'chat should show the composer placeholder');
  assert(frame?.includes(lastLine), `chat should show last history line "${lastLine}"`);

  // (d) 메시지 입력 후 Enter를 누르면 내 메시지가 로그에 표시됩니다.
  const mine = '테스트메시지ABC';
  await delay(40);
  stdin.write(mine);
  await delay(60);
  stdin.write(ENTER);
  await delay(180);
  frame = lastFrame();
  show('(d) After sending', frame);
  assert(frame?.includes(mine), 'sent message should appear in the log');
  assert(frame?.includes('나'), 'sent message should be attributed to 나');

  // (e) 채팅 중 Tab으로 방 전환 목록을 열고, 다른 방으로 바로 전환합니다.
  const switchTarget = probeRooms[1];
  stdin.write(TAB);
  await delay(160);
  frame = lastFrame();
  show('(e) Room switcher', frame);
  assert(frame?.includes('방 전환'), 'room switcher should open from chat');
  assert(frame?.includes('현재'), 'room switcher should mark the current room');

  stdin.write(DOWN);
  await delay(80);
  stdin.write(ENTER);
  await delay(180);
  frame = lastFrame();
  show('(f) After switching room', frame);
  assert(frame?.includes(String(switchTarget.name)), `chat header should switch to ${switchTarget.name}`);
  assert(frame?.includes('입력'), 'switched chat should show the composer placeholder');

  // (g) 목록으로 돌아간 뒤 mock 수신 메시지가 읽지 않음 합계를 증가시킵니다.
  stdin.write(ESC); // chat → rooms
  await delay(120);
  frame = lastFrame();
  show('(g) Back to list', frame);
  const before = totalUnread(frame);
  assert(Number.isFinite(before), 'status line total should be readable');

  // mock은 4초마다 타인 메시지를 발생시키므로 합계가 증가할 때까지 polling합니다.
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
  show('(g) After incoming chat', frame);
  assert(after > before, `unread total should grow (before=${before}, after=${after})`);

  console.log(`\nui-check OK — unread ${before} → ${after}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('\nui-check FAILED:', err);
  process.exit(1);
});
