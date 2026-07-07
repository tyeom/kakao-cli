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
//
// Unread is UI-owned: `Room.unreadCount` is the INITIAL server count at connect;
// after that the UI seeds from it, increments on 'chat' to a non-open room, and
// resets to 0 when the user opens that room. The client does not track unread.
export interface KakaoClient extends EventEmitter {
  login(cred: Credential): Promise<void>;
  listRooms(): Promise<Room[]>;
  getMessages(roomId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
  sendMessage(roomId: string, text: string): Promise<void>;
  disconnect(): Promise<void>;
}

// Auth is separated from the message client so the login UI can be built and
// tested against a mock provider. The real provider (node-kakao) performs
// device registration (passcode sent to the user's phone) and persists the
// credential to disk (auth.json) for silent re-login on later runs.
export interface AuthProvider {
  // A credential saved by a prior successful login, or null → show the login UI.
  loadSaved(): Promise<Credential | null>;
  // Interactive login. On a fresh device Kakao requires registration: the
  // provider requests a passcode (Kakao sends it to the user's phone), then
  // calls onPasscodeNeeded() to collect what the user types, then registers.
  login(input: {
    email: string;
    password: string;
    onPasscodeNeeded: () => Promise<string>;
  }): Promise<Credential>;
  // Clear the saved credential (sign out).
  logout(): Promise<void>;
}
