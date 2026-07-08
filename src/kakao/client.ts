import type { EventEmitter } from 'node:events';

export type RoomType = 'direct' | 'group' | 'open';

export interface Room {
  id: string;            // channelId는 64비트 안전성을 위해 항상 string으로 다룹니다.
  name: string;
  type: RoomType;
  unreadCount: number;
  lastMessage?: string;
  lastAt?: number;       // epoch ms
}
export interface Message {
  id: string;            // logId도 number로 변환하지 않고 string으로 유지합니다.
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
// 이벤트: 'chat'(Message) | 'room-update'(Room)
//        | 'connected'() | 'disconnected'(reason) | 'error'(Error)
//
// 읽지 않음 카운트는 UI가 관리합니다. 연결 직후 서버의 초기값만 Room.unreadCount로 받고,
// 이후에는 UI가 새 메시지 이벤트에서 증가시키고 사용자가 방을 열면 0으로 초기화합니다.
export interface KakaoClient extends EventEmitter {
  login(cred: Credential): Promise<void>;
  listRooms(): Promise<Room[]>;
  getMessages(roomId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
  sendMessage(roomId: string, text: string): Promise<void>;
  // live client 전용입니다. mock client는 구현하지 않아도 UI가 기능 지원 여부를 확인합니다.
  sendClipboardImage?(roomId: string): Promise<void>;
  disconnect(): Promise<void>;
}

// 인증은 메시지 클라이언트와 분리합니다.
// 이렇게 하면 QR 로그인 UI를 mock provider로 검증하고, live에서는 auth.json 토큰으로 재연결할 수 있습니다.
export interface AuthProvider {
  // 이전 로그인에서 저장된 Credential입니다. null이면 로그인 UI를 보여줍니다.
  loadSaved(): Promise<Credential | null>;
  // QR 로그인 흐름입니다. UI는 QR과 휴대폰 확인 코드만 보여주고 비밀값은 수집하지 않습니다.
  login(input: {
    onQrCode: (qr: string) => void;
    onPasscode: (passcode: string) => void;
    onStatus?: (status: string) => void;
  }): Promise<Credential>;
  // 저장된 Credential을 삭제합니다.
  logout(): Promise<void>;
}
