/**
 * Kiểm thử điều khiển âm lượng loa máy chủ, bằng một pactl GIẢ LẬP.
 *
 * Máy chạy test không có PulseAudio/PipeWire, nên dựng một script pactl giả in
 * ra đúng định dạng thật rồi kiểm module đọc/ghi có đúng không. Cách này bắt
 * được lỗi phân tích chuỗi — thứ hay sai nhất ở đây — mà không cần loa thật.
 *
 * Chạy: node test/audiotest.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-audio-'));
const calls = path.join(dir, 'calls.txt');

// pactl giả: in ra dữ liệu giống hệt máy thật (hai sink, sink mặc định là loa
// Bluetooth), và ghi lại mọi lệnh set-* để kiểm module gọi đúng cái gì.
function writeFakePactl({ defaultSinkCmd = true, volume = 43, muted = 'no' } = {}) {
  const script = `#!/bin/sh
echo "$@" >> ${calls}
case "$1 $2" in
"get-default-sink ")
  ${defaultSinkCmd ? 'echo bluez_output.AA_BB.1' : 'exit 1'} ;;
"info ")
  echo "Server Name: PulseAudio (on PipeWire 1.0)"
  echo "Default Sink: bluez_output.AA_BB.1" ;;
"list sinks")
  echo "Sink #0"
  echo "	Name: alsa_output.platform-bcm2835.hdmi"
  echo "	Description: HDMI"
  echo "	Mute: no"
  echo "	Volume: front-left: 65536 /  100% / 0.00 dB,   front-right: 65536 /  100%"
  echo "Sink #1"
  echo "	Name: bluez_output.AA_BB.1"
  echo "	Description: Loa Bluetooth JBL"
  echo "	Mute: ${muted}"
  echo "	Volume: front-left: 28180 /  ${volume}% / -19.45 dB,   front-right: 28180 /  ${volume}%" ;;
*) : ;;
esac
`;
  fs.writeFileSync(path.join(dir, 'pactl'), script, { mode: 0o755 });
}

function loadAudio() {
  delete require.cache[require.resolve('../audio.js')];
  return require('../audio.js');
}

(async () => {
  process.env.PATH = dir + ':' + process.env.PATH;

  // ---- đọc đúng sink mặc định, không đọc nhầm sink khác ----
  writeFakePactl({ volume: 43 });
  let audio = loadAudio();
  let info = await audio.readVolume();
  assert.strictEqual(info.available, true);
  assert.strictEqual(info.sink, 'bluez_output.AA_BB.1');
  assert.strictEqual(info.label, 'Loa Bluetooth JBL');
  assert.strictEqual(info.volume, 43,
    'phải lấy âm lượng của SINK MẶC ĐỊNH (43%), không phải sink HDMI (100%)');
  assert.strictEqual(info.muted, false);
  ok('đọc đúng âm lượng và tên của sink mặc định giữa nhiều sink');

  // ---- máy đời cũ không có get-default-sink thì lùi về "pactl info" ----
  writeFakePactl({ defaultSinkCmd: false, volume: 43 });
  audio = loadAudio();
  info = await audio.readVolume();
  assert.strictEqual(info.available, true);
  assert.strictEqual(info.sink, 'bluez_output.AA_BB.1');
  ok('PulseAudio đời cũ (không có get-default-sink) vẫn đọc được qua pactl info');

  // ---- đang tắt tiếng thì phải báo ----
  writeFakePactl({ volume: 43, muted: 'yes' });
  audio = loadAudio();
  info = await audio.readVolume();
  assert.strictEqual(info.muted, true, 'sink đang tắt tiếng phải được báo');
  ok('phát hiện được sink đang tắt tiếng');

  // ---- đặt âm lượng: phải bật tiếng luôn, kéo về 0 mới tắt ----
  fs.writeFileSync(calls, '');
  writeFakePactl();
  audio = loadAudio();
  await audio.setVolume(72);
  let log = fs.readFileSync(calls, 'utf8');
  assert.ok(/set-sink-mute bluez_output.AA_BB.1 0/.test(log),
    'kéo thanh lên phải BẬT tiếng — sink đang tắt tiếng mà kéo lên vẫn im thì tưởng hỏng');
  assert.ok(/set-sink-volume bluez_output.AA_BB.1 72%/.test(log));
  ok('đặt âm lượng 72% đồng thời bật tiếng');

  fs.writeFileSync(calls, '');
  await audio.setVolume(0);
  log = fs.readFileSync(calls, 'utf8');
  assert.ok(/set-sink-mute bluez_output.AA_BB.1 1/.test(log),
    'kéo về 0 thì đúng ý người dùng là tắt tiếng');
  ok('kéo về 0 thì tắt tiếng hẳn');

  // ---- giá trị ngoài khoảng phải được kẹp lại, không truyền thẳng xuống ----
  fs.writeFileSync(calls, '');
  assert.strictEqual(await audio.setVolume(180), 100);
  assert.strictEqual(await audio.setVolume(-5), 0);
  log = fs.readFileSync(calls, 'utf8');
  assert.ok(/set-sink-volume bluez_output.AA_BB.1 100%/.test(log));
  assert.ok(!/1[0-9][0-9]%/.test(log.replace(/100%/g, '')),
    'không được gửi mức trên 100% xuống pactl');
  ok('giá trị ngoài khoảng bị kẹp về 0..100 trước khi gọi pactl');

  // ---- máy không có pactl: phải nói RÕ lý do, không ném lỗi khó hiểu ----
  fs.unlinkSync(path.join(dir, 'pactl'));
  audio = loadAudio();
  info = await audio.readVolume();
  assert.strictEqual(info.available, false);
  assert.match(info.reason, /pactl/,
    'thiếu pactl thì phải nói thẳng là thiếu pactl kèm cách cài');
  ok('máy không có pactl: báo không dùng được kèm lý do cụ thể');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass}/${pass} bài kiểm thử âm lượng PASS\n`);
})().catch((e) => {
  console.error('\n✗ FAIL:', e.message);
  process.exit(1);
});
