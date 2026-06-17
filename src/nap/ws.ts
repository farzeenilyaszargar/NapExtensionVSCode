import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';

export type WsMessageHandler = (message: string) => void;
export type WsCloseHandler = () => void;

export interface MinimalWsConnection {
  send(message: string): void;
  close(): void;
  onMessage(handler: WsMessageHandler): void;
  onClose(handler: WsCloseHandler): void;
}

type FrameHandler = (payload: string) => void;

export function attachWebSocketUpgrade(
  server: http.Server,
  options: {
    token: string;
    onConnection(connection: MinimalWsConnection): void;
  }
): void {
  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('token') !== options.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n'));

    options.onConnection(createSocketConnection(socket as net.Socket, false));
  });
}

export function connectWebSocket(port: number, token: string, host = '127.0.0.1'): Promise<MinimalWsConnection> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const key = crypto.randomBytes(16).toString('base64');
    let handshake = '';
    let resolved = false;

    socket.on('connect', () => {
      socket.write([
        `GET /?token=${encodeURIComponent(token)} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '\r\n'
      ].join('\r\n'));
    });

    const onHandshakeData = (chunk: Buffer) => {
      handshake += chunk.toString('binary');
      const headerEnd = handshake.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      socket.off('data', onHandshakeData);
      const headers = handshake.slice(0, headerEnd);
      if (!headers.startsWith('HTTP/1.1 101')) {
        socket.destroy();
        reject(new Error(`napd WebSocket handshake failed: ${headers.split('\r\n')[0]}`));
        return;
      }

      const connection = createSocketConnection(socket, true);
      const rest = Buffer.from(handshake.slice(headerEnd + 4), 'binary');
      if (rest.length > 0) {
        connectionBuffer(connection, rest);
      }
      resolved = true;
      resolve(connection);
    };

    socket.on('data', onHandshakeData);
    socket.on('error', error => {
      if (!resolved) {
        reject(error);
      }
    });
  });
}

function createSocketConnection(socket: net.Socket, maskOutgoing: boolean): MinimalWsConnection {
  const messageHandlers = new Set<WsMessageHandler>();
  const closeHandlers = new Set<WsCloseHandler>();
  let buffer: Buffer = Buffer.alloc(0);

  const parse = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    buffer = Buffer.from(parseFrames(buffer, payload => {
      for (const handler of messageHandlers) {
        handler(payload);
      }
    }));
  };

  socket.on('data', parse);
  socket.on('close', () => {
    for (const handler of closeHandlers) {
      handler();
    }
  });

  const connection: MinimalWsConnection = {
    send(message) {
      socket.write(encodeFrame(message, maskOutgoing));
    },
    close() {
      socket.end();
      socket.destroy();
    },
    onMessage(handler) {
      messageHandlers.add(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
    }
  };

  pendingBuffers.set(connection, parse);
  return connection;
}

const pendingBuffers = new WeakMap<MinimalWsConnection, (chunk: Buffer) => void>();

function connectionBuffer(connection: MinimalWsConnection, chunk: Buffer): void {
  pendingBuffers.get(connection)?.(chunk);
}

function parseFrames(buffer: Buffer, onFrame: FrameHandler): Buffer {
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (buffer.length - offset < 4) {
        break;
      }
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) {
        break;
      }
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('WebSocket frame too large.');
      }
      length = Number(bigLength);
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) {
      break;
    }

    if (opcode === 8) {
      return Buffer.alloc(0);
    }

    let payload = buffer.subarray(offset + headerLength + maskLength, offset + frameLength);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    if (opcode === 1) {
      onFrame(payload.toString('utf8'));
    }
    offset += frameLength;
  }
  return buffer.subarray(offset);
}

function encodeFrame(message: string, masked: boolean): Buffer {
  const payload = Buffer.from(message, 'utf8');
  const length = payload.length;
  const lengthBytes = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const maskBytes = masked ? 4 : 0;
  const header = Buffer.alloc(2 + lengthBytes + maskBytes);
  header[0] = 0x81;

  if (length < 126) {
    header[1] = length | (masked ? 0x80 : 0);
  } else if (length <= 0xffff) {
    header[1] = 126 | (masked ? 0x80 : 0);
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127 | (masked ? 0x80 : 0);
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  if (!masked) {
    return Buffer.concat([header, payload]);
  }

  const maskOffset = 2 + lengthBytes;
  const mask = crypto.randomBytes(4);
  mask.copy(header, maskOffset);
  const maskedPayload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([header, maskedPayload]);
}
