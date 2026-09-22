/**
 * Điều khiển âm lượng THẬT của máy chủ (PulseAudio / PipeWire qua pactl).
 *
 * Vì sao cần: thanh âm lượng cũ chỉnh bên trong trình phát YouTube. Kéo hết cỡ
 * mà loa vẫn nhỏ thì phải SSH vào chạy pactl — đúng thứ không ai muốn làm giữa
 * bữa tiệc.
 *
 * Không phải máy nào cũng có: chạy trong Docker, chạy trên server không màn
 * hình, hoặc chưa đăng nhập desktop thì không có server âm thanh. Mọi hàm ở đây
 * đều trả về trạng thái "không dùng được" kèm LÝ DO, để giao diện nói rõ với
 * người dùng thay vì im lặng không làm gì.
 */

const { execFile } = require('child_process');

const TIMEOUT = 4000;

/**
 * pactl cần biết đường tới server âm thanh của phiên đăng nhập. Service systemd
 * không có sẵn biến này, nên tự dựng từ UID của tiến trình.
 */
function pactlEnv() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return {
    ...process.env,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  };
}

function pactl(args) {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { timeout: TIMEOUT, env: pactlEnv() }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** Tên sink mặc định. get-default-sink chỉ có từ PulseAudio 15 nên có đường lùi. */
async function defaultSink() {
  try {
    const out = (await pactl(['get-default-sink'])).trim();
    if (out) return out;
  } catch { /* bản cũ không có lệnh này */ }
  const info = await pactl(['info']);
  const m = /^Default Sink:\s*(.+)$/m.exec(info);
  return m ? m[1].trim() : null;
}

/**
 * Đọc âm lượng và trạng thái tắt tiếng của sink mặc định.
 * Trả về { available, volume, muted, sink, reason }.
 */
async function readVolume() {
  let sink;
  try {
    sink = await defaultSink();
  } catch (err) {
    return {
      available: false,
      reason: /ENOENT/.test(err.message)
        ? 'Máy chủ không có pactl (cài: sudo apt-get install -y pulseaudio-utils)'
        : 'Không kết nối được server âm thanh của máy chủ',
    };
  }
  if (!sink) return { available: false, reason: 'Máy chủ không có ngõ ra âm thanh nào' };

  const dump = await pactl(['list', 'sinks']);
  // Cắt đúng khối của sink mặc định rồi mới đọc — máy nhiều ngõ ra thì đọc
  // nhầm khối là chỉnh nhầm thiết bị.
  const blocks = dump.split(/\n(?=Sink #)/);
  const block = blocks.find((b) => new RegExp(`^\\s*Name:\\s*${escapeRe(sink)}\\s*$`, 'm').test(b));
  if (!block) return { available: false, reason: 'Không đọc được thông tin ngõ ra' };

  const volM = /^\s*Volume:.*?(\d+)%/m.exec(block);
  const muteM = /^\s*Mute:\s*(yes|no)/m.exec(block);
  const descM = /^\s*Description:\s*(.+)$/m.exec(block);

  return {
    available: true,
    sink,
    label: descM ? descM[1].trim() : sink,
    volume: volM ? Math.min(100, parseInt(volM[1], 10)) : null,
    muted: muteM ? muteM[1] === 'yes' : false,
  };
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Đặt âm lượng 0..100 cho sink mặc định.
 *
 * Bật tiếng luôn: sink đang tắt tiếng mà kéo thanh lên vẫn im thì người dùng
 * tưởng hỏng. Kéo về 0 thì mới tắt tiếng — đó đúng là ý họ.
 */
async function setVolume(percent) {
  const v = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  const sink = await defaultSink();
  if (!sink) throw new Error('Máy chủ không có ngõ ra âm thanh nào');
  await pactl(['set-sink-mute', sink, v === 0 ? '1' : '0']);
  await pactl(['set-sink-volume', sink, `${v}%`]);
  return v;
}

module.exports = { readVolume, setVolume, defaultSink };
