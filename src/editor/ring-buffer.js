'use strict';
class RingBuffer {
  constructor(size) { this._size = size; this._buf = []; }
  push(v) { this._buf.push(v); if (this._buf.length > this._size) this._buf.shift(); }
  values() { return this._buf.slice(); }
}
module.exports = RingBuffer;
