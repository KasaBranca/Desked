/**
 * Minimal Ogg page parser that extracts Opus packets from FFmpeg's Ogg output.
 *
 * Only packet boundaries matter here, so the CRC and granule position are
 * ignored. The first packet (OpusHead) is reported via onHeader; OpusTags is
 * skipped; every following packet is an audio packet.
 */
'use strict';

const OGG_CAPTURE = Buffer.from('OggS');

class OggOpusParser {
  constructor({ onHeader, onPacket, onError } = {}) {
    this.onHeader = onHeader || null;
    this.onPacket = onPacket || null;
    this.onError = onError || null;
    this._buf = Buffer.alloc(0);
    this._packet = null;
    this._headerSeen = false;
    this._tagsSeen = false;
  }

  reset() {
    this._buf = Buffer.alloc(0);
    this._packet = null;
    this._headerSeen = false;
    this._tagsSeen = false;
  }

  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    try {
      while (this._parseOne()) {
        // keep going while whole pages are available
      }
    } catch (err) {
      if (typeof this.onError === 'function') this.onError(err);
    }
    // Do not retain an unbounded tail when the stream is not Ogg.
    if (this._buf.length > 4 * 1024 * 1024) this._buf = Buffer.alloc(0);
  }

  _parseOne() {
    if (this._buf.length < 27) return false;
    const start = this._buf.indexOf(OGG_CAPTURE);
    if (start < 0) {
      // Keep the last 3 bytes in case "OggS" straddles a chunk boundary.
      this._buf = this._buf.subarray(Math.max(0, this._buf.length - 3));
      return false;
    }
    if (start > 0) this._buf = this._buf.subarray(start);
    if (this._buf.length < 27) return false;

    const segCount = this._buf[26];
    const headerLen = 27 + segCount;
    if (this._buf.length < headerLen) return false;
    const segTable = this._buf.subarray(27, headerLen);

    let dataLen = 0;
    for (let i = 0; i < segCount; i++) dataLen += segTable[i];
    if (this._buf.length < headerLen + dataLen) return false;

    const page = this._buf.subarray(headerLen, headerLen + dataLen);
    this._buf = this._buf.subarray(headerLen + dataLen);

    let offset = 0;
    for (let i = 0; i < segCount; i++) {
      const segLen = segTable[i];
      const piece = page.subarray(offset, offset + segLen);
      offset += segLen;
      this._packet = this._packet ? Buffer.concat([this._packet, piece]) : Buffer.from(piece);
      if (segLen < 255) {
        const packet = this._packet;
        this._packet = null;
        this._emit(packet);
      }
    }
    return true;
  }

  _emit(packet) {
    if (packet.length === 0) return;
    if (!this._headerSeen) {
      this._headerSeen = true;
      if (this.onHeader) this.onHeader(packet);
      return;
    }
    if (!this._tagsSeen) {
      this._tagsSeen = true;
      return;
    }
    if (this.onPacket) this.onPacket(packet);
  }
}

module.exports = { OggOpusParser };
