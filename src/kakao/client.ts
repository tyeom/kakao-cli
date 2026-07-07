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
// Events: 'chat'(Message) | 'unread'(roomId,count) | 'room-update'(Room)
//         | 'connected'() | 'disconnected'(reason) | 'error'(Error)
export interface KakaoClient extends EventEmitter {
  login(cred: Credential): Promise<void>;
  listRooms(): Promise<Room[]>;
  getMessages(roomId: string, opts?: { limit?: number; before?: string }): Promise<Message[]>;
  sendMessage(roomId: string, text: string): Promise<void>;
  getUnread(roomId: string): number;
  disconnect(): Promise<void>;
}
