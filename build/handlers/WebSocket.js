const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { URL } = require('node:url');
const { Buffer } = require('node:buffer');

let nativeWs = null;
if (process.isBun) nativeWs = require('ws');
const frameHeaderPool = Buffer.alloc(10);


class BufferPool {
  constructor(initialSize = 8192) {
    this.buffer = Buffer.allocUnsafe(initialSize);
    this.used = 0;
  }

  append(data) {
    const dataLength = data.length;
    if (this.used + dataLength > this.buffer.length) {
      const newSize = Math.max(this.buffer.length * 2, this.used + dataLength);
      const newBuffer = Buffer.allocUnsafe(newSize);
      this.buffer.copy(newBuffer, 0, 0, this.used);
      this.buffer = newBuffer;
    }
    data.copy(this.buffer, this.used);
    this.used += dataLength;
  }

  consume(bytes) {
    if (bytes === this.used) {
      this.used = 0;
      return;
    }
    
    this.buffer.copy(this.buffer, 0, bytes, this.used);
    this.used -= bytes;
  }

  get data() {
    return this.buffer.subarray(0, this.used);
  }
}

class WebSocket extends EventEmitter {
  constructor(url, options = {}) {
    super();
    this.url = url;
    this.options = options;
    this.socket = null;
    this.bufferPool = new BufferPool();
    this.frameInfo = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.baseReconnectDelay = options.baseReconnectDelay || 1000; // 1 second
    this.connect();
  }

  connect() {
    const { hostname, protocol, port, pathname, search } = new URL(this.url);
    const isSecure = protocol === 'wss:';
    const agent = isSecure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');

    const request = agent.request({
      hostname,
      port: port || (isSecure ? 443 : 80),
      path: pathname + search,
      timeout: this.options.timeout || 30000,
      headers: {
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': 13,
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        ...this.options.headers
      },
      method: 'GET'
    });

    request.once('error', (err) => this._handleError(err));
    request.once('upgrade', (res, socket, head) => this._handleUpgrade(res, socket, head, key));
    request.end();
  }

  _handleUpgrade(res, socket, head, key) {
    if (res.headers.upgrade.toLowerCase() !== 'websocket') {
      return socket.destroy();
    }

    const expectedAccept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    if (res.headers['sec-websocket-accept'] !== expectedAccept) {
      return socket.destroy();
    }

    this.reconnectAttempts = 0;
    
    this.socket = socket;
    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true);
    this.socket.on('data', (data) => this._processData(data));
    this.socket.once('close', () => this._handleClose(1006));
    this.socket.once('error', (err) => this._handleError(err));
    if (head.length) this._processData(head);
    this.emit('open');
  }

  _processData(data) {
    this.bufferPool.append(data);
    
    while (this.bufferPool.used >= 2) {
      const bufferData = this.bufferPool.data;
      const lengthByte = bufferData[1] & 127;
      let headerSize = 2 + ((bufferData[1] & 128) ? 4 : 0);
      if (lengthByte === 126) headerSize += 2;
      else if (lengthByte === 127) headerSize += 8;
      if (this.bufferPool.used < headerSize) return;
      
      const frame = this._parseFrame();
      if (!frame) return;
      this._handleFrame(frame);
    }
  }

  _parseFrame() {
    const bufferData = this.bufferPool.data;
    if (bufferData.length < 2) return null;
  
    const fin = (bufferData[0] & 128) !== 0;
    const opcode = bufferData[0] & 15;
    let payloadLength = bufferData[1] & 127;
    let offset = 2;
  
    if (payloadLength === 126) {
      if (bufferData.length < offset + 2) return null;
      payloadLength = bufferData.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (bufferData.length < offset + 8) return null;
      payloadLength = Number(bufferData.readBigUInt64BE(offset));
      offset += 8;
    }
  
    const hasMask = (bufferData[1] & 128) !== 0;
    const mask = hasMask ? bufferData.subarray(offset, offset + 4) : null;
    offset += hasMask ? 4 : 0;
  
    if (bufferData.length < offset + payloadLength) return null;
  
    let payload = Buffer.from(bufferData.subarray(offset, offset + payloadLength));
  
    if (mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] = payload[i] ^ mask[i % 4];
      }
    }
  
    const totalFrameSize = offset + payloadLength;
    this.bufferPool.consume(totalFrameSize);
  
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) return this._handleClose(payload.length >= 2 ? payload.readUInt16BE(0) : 1006);
    if (opcode === 0x9) return this._sendFrame(0xA, payload);
    if (opcode === 0xA) return this.emit('pong', payload);
    if (!fin) return;
    
    if (opcode === 0x1) {
      this.emit('message', payload.toString('utf-8'));
    } else {
      this.emit('message', payload);
    }
  }

  _sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (!this.socket || this.socket.destroyed) return;
    const length = payload.length;
    let headerSize = length < 126 ? 2 : length < 65536 ? 4 : 10;
  
    frameHeaderPool[0] = 0x80 | opcode;
    if (length < 126) {
      frameHeaderPool[1] = length;
    } else if (length < 65536) {
      frameHeaderPool[1] = 126;
      frameHeaderPool.writeUInt16BE(length, 2);
    } else {
      frameHeaderPool[1] = 127;
      frameHeaderPool.writeBigUInt64BE(BigInt(length), 2);
    }
  
    this.socket.write(frameHeaderPool.subarray(0, headerSize));
    this.socket.write(payload);
  }

  send(data) {
    if (typeof data === 'string') {
      data = Buffer.from(data, 'utf-8');
    } else if (!Buffer.isBuffer(data)) {
      throw new Error('Data must be a string or Buffer');
    }
    this._sendFrame(0x1, data);
  }

  ping(data = '') {
    const pingData = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    this._sendFrame(0x9, pingData);
  }

  close(code = 1000) {
    const codeBuffer = Buffer.allocUnsafe(2);
    codeBuffer.writeUInt16BE(code, 0);
    this._sendFrame(0x8, codeBuffer);
    setTimeout(() => this._handleClose(code), 100);
  }

  _handleClose(code) {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.bufferPool = new BufferPool();
    this.emit('close', code);
  }

  _handleError(err) {
    if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = Math.min(
          this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
          30000
        );
        
        const jitter = Math.random() * 0.3 * delay;
        const reconnectDelay = delay + jitter;
        
        setTimeout(() => this.connect(), reconnectDelay);
        this.emit('reconnecting', { 
          attempt: this.reconnectAttempts, 
          delay: reconnectDelay,
          error: err
        });
      } else {
        this.emit('error', new Error(`Maximum reconnection attempts (${this.maxReconnectAttempts}) exceeded: ${err.message}`));
        this._handleClose(1006);
      }
    } else {
      this.emit('error', err);
      this._handleClose(1006);
    }
  }
}

module.exports = nativeWs || WebSocket;