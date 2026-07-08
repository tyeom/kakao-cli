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
const SHIFT_TAB = '\u001B[Z';
const SHIFT_ENTER = '\u001B[13;2u'; // Kitty 키보드 프로토콜의 Shift+Return 시퀀스입니다.
const ESC = String.fromCharCode(27); // ESC 키
const UP = '\u001B[A';
const DOWN = '\u001B[B';
const LEFT = '\u001B[D';
const DELETE = '\u001B[3~';
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ink-testing-library에서는 React effect 연결보다 첫 키 입력이 먼저 도착할 수 있습니다.
// 의미 있는 키를 보내기 전에 no-op에 가까운 Tab을 한 번 보내서 테스트 타이밍을 안정화합니다.
function warmup(stdin: { write: (s: string) => void }): void {
  stdin.write(UP);
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

  // (b) 좌측 채팅 목록과 우측 현재 대화방이 동시에 보입니다.
  frame = lastFrame();
  show('(b) Split room view', frame);
  assert(frame?.includes('Kakao Talk CLI'), 'brand header should show Kakao Talk CLI');
  assert(frame?.includes('활성 영역: 좌측 채팅'), 'left room list should start focused');
  assert(frame?.includes('김민준'), 'room list should show 김민준');
  assert(frame?.includes('가족 단톡방'), 'room list should show 가족 단톡방');
  assert(frame?.includes(String(topRoom.name)), `room list should show ${topRoom.name}`);
  assert(frame?.includes('입력'), 'right chat panel should show the composer placeholder');
  assert(frame?.includes('●'), 'room list should show at least one unread badge');
  assert(frame?.includes('[오픈]'), 'room list should show the open-chat marker');

  // (c) Tab으로 우측 대화방을 활성화하면 입력이 가능해집니다.
  warmup(stdin);
  await delay(40);
  stdin.write(TAB);
  await delay(180);
  frame = lastFrame();
  show('(c) Chat pane focused', frame);
  assert(frame?.includes('활성 영역: 우측 대화방'), 'Tab should focus the chat pane');
  assert(frame?.includes('코딩 오픈챗'), 'chat header should show the room name');
  assert(frame?.includes('입력'), 'chat should show the composer placeholder');
  assert(frame?.includes(lastLine), `chat should show last history line "${lastLine}"`);
  assert(/\[\d{2}:\d{2}\]/.test(frame ?? ''), 'chat messages should show HH:mm timestamps');

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

  // (d2) Shift+Enter는 전송하지 않고 입력 버퍼에 줄바꿈을 추가합니다.
  const multiLineA = '멀티라인A';
  const multiLineB = '멀티라인B';
  stdin.write(multiLineA);
  await delay(60);
  stdin.write(SHIFT_ENTER);
  await delay(60);
  stdin.write(multiLineB);
  await delay(60);
  stdin.write(ENTER);
  await delay(180);
  frame = lastFrame();
  show('(d2) After multiline sending', frame);
  assert(frame?.includes(`나: ${multiLineA}`), 'multiline first line should be sent');
  assert(frame?.includes(multiLineB), 'multiline second line should be rendered');

  // (d3) 방향키로 커서를 중간으로 옮긴 뒤 Delete/삽입 편집이 가능합니다.
  stdin.write('ABCD');
  await delay(60);
  stdin.write(LEFT);
  await delay(40);
  stdin.write(LEFT);
  await delay(40);
  stdin.write(DELETE);
  await delay(40);
  stdin.write('X');
  await delay(60);
  stdin.write(ENTER);
  await delay(180);
  frame = lastFrame();
  show('(d3) After cursor editing', frame);
  assert(frame?.includes('나: ABXD'), 'cursor edit should delete C and insert X in the middle');

  // (e) Tab으로 좌측 패널을 활성화하고, Shift+Tab으로 친구 목록으로 전환합니다.
  stdin.write(TAB);
  await delay(160);
  frame = lastFrame();
  show('(e) Back to left list', frame);
  assert(frame?.includes('활성 영역: 좌측 채팅'), 'Tab should focus the left room list');

  stdin.write(SHIFT_TAB);
  await delay(160);
  frame = lastFrame();
  show('(e2) Friend list', frame);
  assert(frame?.includes('활성 영역: 좌측 친구'), 'Shift+Tab should toggle to the friend list');
  assert(frame?.includes('김민준'), 'friend list should show direct chat 김민준');

  // (f) 친구 목록에서 Enter를 누르면 해당 1:1 대화방이 우측에 열립니다.
  stdin.write(ENTER);
  await delay(180);
  frame = lastFrame();
  show('(f) After opening friend chat', frame);
  assert(frame?.includes('활성 영역: 우측 대화방'), 'opening a friend chat should focus the chat pane');
  assert(frame?.includes('[1:1] 김민준'), 'chat header should switch to 김민준');
  assert(frame?.includes('입력'), 'switched chat should show the composer placeholder');

  // (g) 전체 채팅 목록으로 돌아간 뒤 mock 수신 메시지가 읽지 않음 합계를 증가시킵니다.
  stdin.write(TAB); // chat → left friend list
  await delay(80);
  stdin.write(SHIFT_TAB); // friend list → room list
  await delay(120);
  frame = lastFrame();
  show('(g) Back to room list', frame);
  assert(frame?.includes('활성 영역: 좌측 채팅'), 'room list should be active again');
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
