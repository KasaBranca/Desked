const { test } = require('node:test');
const assert = require('node:assert');
const { buildFfmpegArgs, buildDesktopFfmpegArgs } = require('../lib/hw-h264-encoder');

/** Return the value that follows an option in an ffmpeg arg list. */
function valueAfter(args, option) {
  const i = args.indexOf(option);
  return i >= 0 ? args[i + 1] : undefined;
}

const COMMON = {
  inputW: 1920,
  inputH: 1080,
  outW: 1280,
  outH: 720,
  fps: 24,
  gop: 24,
  cq: 28,
};

test('non-desktop encoders keep enough bitrate for full-motion scenes', () => {
  for (const encoder of ['h264_nvenc', 'h264_qsv', 'libx264', 'h264_amf']) {
    const { args } = buildFfmpegArgs({ ...COMMON, encoder });
    const maxrate = valueAfter(args, '-maxrate:v');
    const bufsize = valueAfter(args, '-bufsize:v');
    if (maxrate != null) assert.equal(maxrate, '8M', `${encoder} maxrate`);
    if (bufsize != null) assert.equal(bufsize, '8M', `${encoder} bufsize`);
  }
});

test('desktop encoders stay low-latency (async depth 1) with headroom', () => {
  for (const encoder of ['h264_qsv', 'libx264']) {
    const { args } = buildDesktopFfmpegArgs({ ...COMMON, encoder });
    assert.equal(valueAfter(args, '-maxrate:v'), '8M', `${encoder} maxrate`);
    assert.equal(valueAfter(args, '-bufsize:v'), '8M', `${encoder} bufsize`);
    if (encoder === 'h264_qsv') {
      assert.equal(valueAfter(args, '-async_depth'), '1', 'qsv async_depth');
    }
  }
});

test('desktop capture reads Desktop Duplication frames at the requested rate', () => {
  const { args } = buildDesktopFfmpegArgs({ ...COMMON, encoder: 'libx264' });
  const input = valueAfter(args, '-i');
  assert.match(input, /ddagrab=/);
  assert.match(input, /framerate=24/);
});
