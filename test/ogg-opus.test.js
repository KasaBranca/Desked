const { test } = require('node:test');
const assert = require('node:assert');
const { OggOpusParser } = require('../lib/ogg-opus');

/** Build a single Ogg page. Packets are split into 255-byte segments. */
function oggPage(seq, packets, { continued = false } = {}) {
  const segments = [];
  const parts = [];
  for (const p of packets) {
    let off = 0;
    let len = p.length;
    while (len >= 255) {
      segments.push(255);
      parts.push(p.subarray(off, off + 255));
      off += 255;
      len -= 255;
    }
    segments.push(len);
    parts.push(p.subarray(off, off + len));
  }
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'ascii');
  header[4] = 0;
  header[5] = continued ? 1 : 0;
  header.writeUInt32LE(1, 14);
  header.writeUInt32LE(seq, 18);
  header[26] = segments.length;
  return Buffer.concat([header, Buffer.from(segments), ...parts]);
}

function collect() {
  const headers = [];
  const packets = [];
  const parser = new OggOpusParser({
    onHeader: (h) => headers.push(h),
    onPacket: (p) => packets.push(p),
  });
  return { parser, headers, packets };
}

test('extracts OpusHead, skips OpusTags, emits audio packets', () => {
  const { parser, headers, packets } = collect();
  const head = Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)]);
  const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(4)]);
  const audio1 = Buffer.from([1, 2, 3, 4]);
  const audio2 = Buffer.from([5, 6, 7]);

  parser.push(oggPage(0, [head]));
  parser.push(oggPage(1, [tags]));
  parser.push(oggPage(2, [audio1, audio2]));

  assert.equal(headers.length, 1);
  assert.equal(headers[0].toString('ascii', 0, 8), 'OpusHead');
  assert.equal(packets.length, 2);
  assert.deepEqual(packets[0], audio1);
  assert.deepEqual(packets[1], audio2);
});

/** Build a page from an explicit segment table + payload. */
function rawPage(seq, segments, payload, { continued = false } = {}) {
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'ascii');
  header[5] = continued ? 1 : 0;
  header.writeUInt32LE(1, 14);
  header.writeUInt32LE(seq, 18);
  header[26] = segments.length;
  return Buffer.concat([header, Buffer.from(segments), payload]);
}

test('reassembles a packet that spans two pages', () => {
  const { parser, packets } = collect();
  const big = Buffer.alloc(300, 7);
  const head = Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)]);
  const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(4)]);
  parser.push(oggPage(0, [head]));
  parser.push(oggPage(1, [tags]));
  // First page: a single 255-byte segment with no terminator (packet continues).
  parser.push(rawPage(2, [255], big.subarray(0, 255)));
  // Second page: continuation, final 45-byte segment terminates the packet.
  parser.push(rawPage(3, [45], big.subarray(255), { continued: true }));

  assert.equal(packets.length, 1);
  assert.equal(packets[0].length, 300);
  assert.equal(packets[0][0], 7);
  assert.equal(packets[0][299], 7);
});

test('handles pages split across pushes', () => {
  const { parser, headers, packets } = collect();
  const head = Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)]);
  const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(4)]);
  const audio = Buffer.from([9, 9, 9]);
  const stream = Buffer.concat([oggPage(0, [head]), oggPage(1, [tags]), oggPage(2, [audio])]);

  for (const byte of stream) parser.push(Buffer.from([byte]));

  assert.equal(headers.length, 1);
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0], audio);
});
