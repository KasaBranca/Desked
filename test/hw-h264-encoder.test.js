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

test('non-desktop encoders cap bitrate with a small VBV buffer', () => {
  for (const encoder of ['h264_nvenc', 'h264_qsv', 'libx264', 'h264_amf']) {
    const { args } = buildFfmpegArgs({ ...COMMON, encoder });
    const maxrate = valueAfter(args, '-maxrate:v');
    const bufsize = valueAfter(args, '-bufsize:v');
    if (maxrate != null) assert.equal(maxrate, '6000k', `${encoder} maxrate`);
    if (bufsize != null) assert.equal(bufsize, '1500k', `${encoder} bufsize`);
  }
});

test('desktop encoders stay low-latency (async depth 1) with headroom', () => {
  for (const encoder of ['h264_qsv', 'libx264']) {
    const { args } = buildDesktopFfmpegArgs({ ...COMMON, encoder });
    assert.equal(valueAfter(args, '-maxrate:v'), '6000k', `${encoder} maxrate`);
    assert.equal(valueAfter(args, '-bufsize:v'), '1500k', `${encoder} bufsize`);
    if (encoder === 'h264_qsv') {
      assert.equal(valueAfter(args, '-async_depth'), '1', 'qsv async_depth');
    }
  }
});

test('maxrate is configurable and bounded', () => {
  const { args } = buildFfmpegArgs({ ...COMMON, encoder: 'libx264', maxrateKbps: 3000 });
  assert.equal(valueAfter(args, '-maxrate:v'), '3000k');
  assert.equal(valueAfter(args, '-bufsize:v'), '750k');
});

test('desktop capture reads Desktop Duplication frames at the requested rate', () => {
  const { args } = buildDesktopFfmpegArgs({ ...COMMON, encoder: 'libx264' });
  const input = valueAfter(args, '-i');
  assert.match(input, /ddagrab=/);
  assert.match(input, /framerate=24/);
});

test('desktop NVENC at native size encodes the D3D11 texture without a download', () => {
  const { args, zeroCopy } = buildDesktopFfmpegArgs({
    ...COMMON, encoder: 'h264_nvenc', outW: 1920, outH: 1080, fps: 60,
  });
  assert.equal(zeroCopy, true);
  assert.ok(!args.includes('-vf'), 'no filter chain');
  assert.ok(!args.includes('-pix_fmt'), 'no software pixel format');
  assert.match(valueAfter(args, '-i'), /framerate=60/);
  assert.match(valueAfter(args, '-i'), /dup_frames=1/);
});

test('desktop NVENC with scaling downloads and scales on the CPU', () => {
  const { args, zeroCopy } = buildDesktopFfmpegArgs({ ...COMMON, encoder: 'h264_nvenc' });
  assert.equal(zeroCopy, false);
  assert.match(valueAfter(args, '-vf'), /^hwdownload,format=bgra,scale=1280:720/);
  assert.equal(valueAfter(args, '-c:v'), 'h264_nvenc');
});
