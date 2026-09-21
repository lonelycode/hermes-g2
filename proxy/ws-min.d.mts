import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
export function acceptKey(key: string): string
export function handshake(req: IncomingMessage, socket: Socket, protocol?: string): boolean
export const OPCODE: { CONTINUATION: 0; TEXT: 1; BINARY: 2; CLOSE: 8; PING: 9; PONG: 10 }
export function encodeFrame(payload: string | Uint8Array, opcode?: number, opts?: { mask?: boolean }): Buffer
export class FrameDecoder {
  feed(chunk: Uint8Array): Array<{ opcode: number; payload: Buffer; fin: boolean }>
}
export function wrapSocket(
  socket: Socket,
  handlers: { onMessage?(data: string | Buffer, isBinary: boolean): void; onClose?(): void; onError?(err: Error): void },
): { send(payload: string | Uint8Array, opcode?: number): void; close(code?: number, reason?: string): void; readonly closed: boolean }
