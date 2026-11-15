import { createHash, randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';

export interface ParsedWsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

export const WS_MAX_MESSAGE_BYTES = 1 * 1024 * 1024;

export function wsAccept(key: string): string {
  return createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

export function wsSendFrame(socket: NodeJS.WritableStream, opcode: number, payload: Buffer): void {
  const len = payload.byteLength;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

export function wsSendText(socket: NodeJS.WritableStream, text: string): void {
  wsSendFrame(socket, 0x1, Buffer.from(text));
}

/** Send a masked client-to-server WebSocket frame (required by RFC 6455). */
export function wsSendMaskedFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  if (socket.destroyed) return;
  const len = payload.byteLength;
  const mask = randomBytes(4);
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) {
    masked[i] = payload[i] ^ mask[i & 3];
  }
  socket.write(Buffer.concat([header, mask, masked]));
}

export function wsSendMaskedText(socket: Duplex, text: string): void {
  wsSendMaskedFrame(socket, 0x1, Buffer.from(text, 'utf8'));
}

/** 带跨 chunk 缓冲的 WS 帧解析器。 */
export class WsFrameParser {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): ParsedWsFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    if (this.buf.byteLength > WS_MAX_MESSAGE_BYTES * 2) {
      throw new Error('websocket buffer too large');
    }
    const out: ParsedWsFrame[] = [];
    for (;;) {
      const frame = this.tryParse();
      if (!frame) break;
      out.push(frame);
    }
    return out;
  }

  private tryParse(): ParsedWsFrame | null {
    const b = this.buf;
    if (b.byteLength < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.byteLength < 4) return null;
      len = b.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (b.byteLength < 10) return null;
      const n = b.readBigUInt64BE(2);
      if (n > BigInt(WS_MAX_MESSAGE_BYTES)) throw new Error('websocket frame too large');
      len = Number(n);
      offset = 10;
    }
    if (len > WS_MAX_MESSAGE_BYTES) throw new Error('websocket frame too large');
    const maskOffset = offset;
    if (masked) offset += 4;
    if (b.byteLength < offset + len) return null;
    let payload = b.subarray(offset, offset + len);
    if (masked) {
      const mask = b.subarray(maskOffset, maskOffset + 4);
      payload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
    }
    this.buf = b.subarray(offset + len);
    return { fin, opcode, payload };
  }
}
