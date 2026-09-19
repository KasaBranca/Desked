/**
 * H.264 Annex B helpers: NAL extraction, AU grouping (IDR-first), avcC builder, AVCC payload.
 */

function findStartCode(buf, from = 0) {
  const n = buf.length;
  for (let i = from; i + 3 < n; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0) {
      if (buf[i + 2] === 1) return { pos: i, len: 3 };
      if (i + 4 < n && buf[i + 2] === 0 && buf[i + 3] === 1) return { pos: i, len: 4 };
    }
  }
  return null;
}

/** Split Annex B buffer into NAL units (without start codes). */
function splitAnnexB(buf) {
  const nals = [];
  let i = 0;
  while (i < buf.length) {
    const sc = findStartCode(buf, i);
    if (!sc) break;
    const nalStart = sc.pos + sc.len;
    const next = findStartCode(buf, nalStart);
    const nalEnd = next ? next.pos : buf.length;
    if (nalStart < nalEnd) {
      nals.push(buf.subarray(nalStart, nalEnd));
    }
    i = nalStart;
  }
  return nals;
}

function nalType(nal) {
  return nal.length > 0 ? nal[0] & 0x1f : -1;
}

function rbspFromNal(nal) {
  const out = [];
  let zeros = 0;
  for (let i = 1; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out;
}

function readUe(bits) {
  let zeroCount = 0;
  while (bits.pos < bits.totalBits && bits.readBit() === 0) {
    zeroCount++;
  }
  if (zeroCount === 0) return 0;
  let value = 1;
  for (let i = 0; i < zeroCount; i++) {
    value = (value << 1) | bits.readBit();
  }
  return value - 1;
}

function firstMbInSlice(nal) {
  const rbsp = rbspFromNal(nal);
  const bits = {
    pos: 0,
    totalBits: rbsp.length * 8,
    readBit() {
      const byte = rbsp[this.pos >> 3] || 0;
      const bit = (byte >> (7 - (this.pos & 7))) & 1;
      this.pos++;
      return bit;
    },
  };
  return readUe(bits);
}

/**
 * Build AVCDecoderConfigurationRecord from raw SPS/PPS NALs (no start codes).
 */
function buildAvcC(sps, pps) {
  const size = 7 + 2 + sps.length + 1 + 2 + pps.length;
  const buf = Buffer.alloc(size);
  let o = 0;
  buf[o++] = 1;
  buf[o++] = sps[1];
  buf[o++] = sps[2];
  buf[o++] = sps[3];
  buf[o++] = 0xfc | 3;
  buf[o++] = 0xe0 | 1;
  buf.writeUInt16BE(sps.length, o);
  o += 2;
  sps.copy(buf, o);
  o += sps.length;
  buf[o++] = 1;
  buf.writeUInt16BE(pps.length, o);
  o += 2;
  pps.copy(buf, o);
  return buf;
}

/** Convert one access unit (Annex B NALs) to AVCC elementary stream (length-prefixed NALs). */
function annexBAccessUnitToAvcc(auAnnexB) {
  const nals = splitAnnexB(auAnnexB);
  const parts = [];
  for (const nal of nals) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(nal.length, 0);
    parts.push(len, nal);
  }
  return Buffer.concat(parts);
}

function buildAnnexBFromNals(nals) {
  const parts = [];
  for (const nal of nals) {
    parts.push(Buffer.from([0, 0, 0, 1]), nal);
  }
  return Buffer.concat(parts);
}

/**
 * Group Annex B stream into access units.
 * VCL NAL types 1 / 5 close an AU (preceding SPS/PPS/SEI stay in the same AU).
 */
function groupAccessUnits(annexB) {
  const nals = splitAnnexB(annexB);
  const aus = [];
  let cur = [];

  for (const nal of nals) {
    const t = nalType(nal);
    if (t === 5 || t === 1) {
      cur.push(nal);
      aus.push(buildAnnexBFromNals(cur));
      cur = [];
    } else {
      cur.push(nal);
    }
  }
  if (cur.length) {
    aus.push(buildAnnexBFromNals(cur));
  }
  return aus;
}

function accessUnitHasIdr(auAnnexB) {
  for (const nal of splitAnnexB(auAnnexB)) {
    if (nalType(nal) === 5) return true;
  }
  return false;
}

function extractSpsPps(auAnnexB) {
  let sps = null;
  let pps = null;
  for (const nal of splitAnnexB(auAnnexB)) {
    const t = nalType(nal);
    if (t === 7) sps = Buffer.from(nal);
    if (t === 8) pps = Buffer.from(nal);
  }
  return sps && pps ? { sps, pps } : null;
}

module.exports = {
  splitAnnexB,
  nalType,
  firstMbInSlice,
  buildAvcC,
  annexBAccessUnitToAvcc,
  groupAccessUnits,
  accessUnitHasIdr,
  extractSpsPps,
  findStartCode,
};
