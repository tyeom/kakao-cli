export const API_SAMPLE_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Kakao CLI API Test</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f2;
      --panel: #ffffff;
      --line: #d8d4c8;
      --text: #202124;
      --muted: #6b6f76;
      --yellow: #fee500;
      --blue: #1d73d4;
      --green: #0b7a55;
      --red: #c0392b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      padding: 18px 22px 12px;
      border-bottom: 1px solid var(--line);
      background: var(--yellow);
    }
    pre {
      margin: 0;
      font-size: 12px;
      line-height: 1.1;
      white-space: pre-wrap;
    }
    main {
      display: grid;
      grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
      min-height: calc(100vh - 118px);
    }
    aside, section {
      padding: 14px;
      min-width: 0;
    }
    aside {
      border-right: 1px solid var(--line);
      background: #fbfaf5;
    }
    label {
      display: block;
      margin: 0 0 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    input, textarea, button, select {
      font: inherit;
    }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      background: #fff;
      color: var(--text);
    }
    textarea {
      min-height: 76px;
      resize: vertical;
    }
    button {
      border: 1px solid #bdb7a9;
      border-radius: 6px;
      padding: 8px 10px;
      background: #fff;
      color: var(--text);
      cursor: pointer;
    }
    button.primary {
      border-color: #d6c000;
      background: var(--yellow);
      font-weight: 700;
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
    }
    .row > * {
      min-width: 0;
    }
    .row input {
      flex: 1;
    }
    .tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 12px 0;
    }
    .tabs button.active {
      border-color: var(--blue);
      color: var(--blue);
      font-weight: 700;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: var(--panel);
      cursor: pointer;
    }
    .item.active {
      border-color: var(--blue);
      box-shadow: inset 0 0 0 1px var(--blue);
    }
    .item-title {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-weight: 700;
    }
    .item-meta, .status {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .chat-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      margin-bottom: 12px;
    }
    .messages {
      min-height: 360px;
      max-height: calc(100vh - 330px);
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 12px;
    }
    .msg {
      border-bottom: 1px solid #efede7;
      padding: 8px 0;
    }
    .msg:last-child {
      border-bottom: 0;
    }
    .msg.mine .nick {
      color: var(--green);
    }
    .nick {
      color: var(--blue);
      font-weight: 700;
    }
    .time {
      margin-left: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .body {
      margin-top: 3px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .error {
      color: var(--red);
    }
    @media (max-width: 820px) {
      main {
        grid-template-columns: 1fr;
      }
      aside {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
    }
  </style>
</head>
<body>
  <header>
<pre> _  __     _              _____     _ _      ____ _     ___
| |/ /__ _| | ____ _  ___|_   _|_ _| | | __ / ___| |   |_ _|
| ' // _\` | |/ / _\` |/ _ \ | |/ _\` | | |/ /| |   | |    | |
| . \ (_| |   < (_| | (_) || | (_| | |   < | |___| |___ | |
|_|\_\__,_|_|\_\__,_|\___/ |_|\__,_|_|_|\_\ \____|_____|___|
== Kakao Talk CLI API Test ==</pre>
  </header>
  <main>
    <aside>
      <label for="baseUrl">API 서버</label>
      <div class="row">
        <input id="baseUrl" />
        <button id="refreshBtn" class="primary">새로고침</button>
      </div>
      <div class="tabs">
        <button id="roomsTab" class="active">채팅방</button>
        <button id="friendsTab">친구</button>
      </div>
      <div id="status" class="status">대기 중</div>
      <div id="list" class="list"></div>
    </aside>
    <section>
      <div class="chat-head">
        <div>
          <strong id="roomTitle">대화방을 선택하세요</strong>
          <div id="roomMeta" class="status"></div>
        </div>
        <button id="connectBtn" disabled>WebSocket 연결</button>
      </div>
      <div id="messages" class="messages"></div>
      <div class="row" style="margin-top: 12px;">
        <textarea id="messageInput" placeholder="전송할 메시지"></textarea>
      </div>
      <div class="row">
        <button id="sendBtn" class="primary" disabled>메시지 전송</button>
        <button id="clearBtn">로그 지우기</button>
      </div>
    </section>
  </main>

  <script>
    const $ = (id) => document.getElementById(id);
    const state = {
      mode: 'rooms',
      rooms: [],
      friends: [],
      selected: null,
      ws: null,
    };

    $('baseUrl').value = location.protocol === 'file:' ? 'http://localhost:8880' : location.origin;

    function apiBase() {
      return $('baseUrl').value.replace(/\/+$/, '');
    }

    function wsBase() {
      const url = new URL(apiBase());
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.toString().replace(/\/+$/, '');
    }

    function setStatus(text, isError = false) {
      $('status').textContent = text;
      $('status').className = isError ? 'status error' : 'status';
    }

    function formatTime(value) {
      if (!value) return '';
      return new Date(value).toLocaleString();
    }

    function roomLabel(room) {
      return room.typeLabel || room.roomType || room.type || '';
    }

    function renderList() {
      const list = state.mode === 'rooms' ? state.rooms : state.friends;
      $('list').innerHTML = '';
      for (const item of list) {
        const roomId = item.roomId || item.id;
        const el = document.createElement('div');
        el.className = 'item' + (state.selected && state.selected.id === roomId ? ' active' : '');
        el.innerHTML = '<div class="item-title"><span></span><small></small></div><div class="item-meta"></div>';
        el.querySelector('span').textContent = item.name || item.nickname || roomId;
        el.querySelector('small').textContent = roomLabel(item);
        el.querySelector('.item-meta').textContent = item.lastMessage || '';
        el.onclick = () => selectRoom(roomId);
        $('list').appendChild(el);
      }
      if (list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'status';
        empty.textContent = '목록이 비어 있습니다.';
        $('list').appendChild(empty);
      }
    }

    function selectedRoom() {
      if (!state.selected) return null;
      return state.rooms.find((room) => room.id === state.selected.id) || state.selected;
    }

    async function request(path, options = {}) {
      const res = await fetch(apiBase() + path, {
        ...options,
        headers: {
          'content-type': 'application/json',
          ...(options.headers || {}),
        },
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(payload.error?.message || payload.message || res.statusText);
      }
      return payload;
    }

    async function refresh() {
      try {
        setStatus('목록 요청 중...');
        const [roomsRes, friendsRes] = await Promise.all([
          request('/api/rooms'),
          request('/api/friends'),
        ]);
        state.rooms = roomsRes.rooms || [];
        state.friends = friendsRes.friends || [];
        setStatus('목록 갱신 완료');
        renderList();
      } catch (err) {
        setStatus(err.message, true);
      }
    }

    async function selectRoom(roomId) {
      const room = state.rooms.find((item) => item.id === roomId) || { id: roomId, name: roomId };
      state.selected = room;
      $('roomTitle').textContent = room.name || room.id;
      $('roomMeta').textContent = roomLabel(room) + ' · ' + room.id;
      $('connectBtn').disabled = false;
      $('sendBtn').disabled = false;
      renderList();
      $('messages').innerHTML = '';
      addSystem('최근 대화 요청 중...');
      try {
        const res = await request('/api/rooms/' + encodeURIComponent(room.id) + '/messages?limit=30');
        $('messages').innerHTML = '';
        for (const msg of res.messages || []) addMessage(msg);
      } catch (err) {
        addSystem('최근 대화 요청 실패: ' + err.message, true);
      }
      connectWs();
    }

    function connectWs() {
      const room = selectedRoom();
      if (!room) return;
      if (state.ws) state.ws.close();
      const ws = new WebSocket(wsBase() + '/ws/rooms/' + encodeURIComponent(room.id));
      state.ws = ws;
      addSystem('WebSocket 연결 중...');
      ws.onopen = () => addSystem('WebSocket 연결됨');
      ws.onclose = () => addSystem('WebSocket 연결 종료');
      ws.onerror = () => addSystem('WebSocket 오류', true);
      ws.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === 'message') addMessage(payload.message);
        else if (payload.type === 'ready') addSystem('수신 준비 완료: ' + payload.room.name);
        else if (payload.type === 'error') addSystem(payload.message, true);
      };
    }

    function addSystem(text, isError = false) {
      const el = document.createElement('div');
      el.className = isError ? 'msg error' : 'msg';
      el.textContent = text;
      $('messages').appendChild(el);
      $('messages').scrollTop = $('messages').scrollHeight;
    }

    function addMessage(msg) {
      const el = document.createElement('div');
      el.className = 'msg' + (msg.isMine ? ' mine' : '');
      const nick = document.createElement('span');
      nick.className = 'nick';
      nick.textContent = msg.nickname || '(알 수 없음)';
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = formatTime(msg.timestamp || msg.time);
      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = msg.message || '';
      el.append(nick, time, body);
      $('messages').appendChild(el);
      $('messages').scrollTop = $('messages').scrollHeight;
    }

    async function sendMessage() {
      const room = selectedRoom();
      const text = $('messageInput').value;
      if (!room || !text.trim()) return;
      try {
        await request('/api/rooms/' + encodeURIComponent(room.id) + '/messages', {
          method: 'POST',
          body: JSON.stringify({ message: text }),
        });
        $('messageInput').value = '';
      } catch (err) {
        addSystem('전송 실패: ' + err.message, true);
      }
    }

    $('refreshBtn').onclick = refresh;
    $('connectBtn').onclick = connectWs;
    $('sendBtn').onclick = sendMessage;
    $('clearBtn').onclick = () => $('messages').innerHTML = '';
    $('roomsTab').onclick = () => {
      state.mode = 'rooms';
      $('roomsTab').className = 'active';
      $('friendsTab').className = '';
      renderList();
    };
    $('friendsTab').onclick = () => {
      state.mode = 'friends';
      $('friendsTab').className = 'active';
      $('roomsTab').className = '';
      renderList();
    };
    $('messageInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) sendMessage();
    });

    refresh();
  </script>
</body>
</html>`;
