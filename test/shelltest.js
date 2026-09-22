/**
 * Kiểm thử các script cài đặt (install.sh, setup-kiosk.sh).
 *
 * Vì sao cần: phần tên miền nội bộ đã bị bỏ hẳn, nhưng "bỏ" ở đây có hai nghĩa
 * khác nhau, và chỉ làm một nửa thì người dùng vẫn thấy tên miền y như cũ:
 *   1. không sinh ra tên miền mới nữa  (setup-kiosk.sh);
 *   2. DỌN cấu hình cũ đã nằm sẵn trong /etc  (install.sh).
 * Đúng cảnh đã gặp thật: xoá script rồi mà máy vẫn phân giải nhac.home, vì
 * /etc/hosts và /etc/dnsmasq.d vẫn còn nguyên.
 *
 * Mọi thứ chạy trong thư mục tạm — KHÔNG đụng vào /etc của máy đang chạy
 * (install.sh cho phép đổi hai đường dẫn đó bằng biến môi trường, chính là để
 * kiểm thử được mà không cần quyền root).
 *
 * Chạy: node test/shelltest.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-shell-'));
const sh = (args, env = {}) =>
  execFileSync('bash', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });

console.log('\n== Kiểm thử script cài đặt ==\n');

try {
  // ---------------------------------------------------------------- cú pháp
  for (const f of ['install.sh', 'setup-kiosk.sh', 'setup-audio.sh', 'update.sh']) {
    sh(['-n', path.join(ROOT, f)]);
  }
  ok('mọi script .sh đều đúng cú pháp bash');

  // Script tên miền phải BIẾN MẤT khỏi mã nguồn, không chỉ là ngừng gọi tới.
  assert.ok(!fs.existsSync(path.join(ROOT, 'setup-domain.sh')),
    'setup-domain.sh phải bị xoá hẳn khỏi mã nguồn');
  ok('setup-domain.sh đã bị gỡ khỏi mã nguồn');

  // ------------------------------------------------ dọn tàn dư trong /etc
  const etc = path.join(dir, 'etc');
  const dnsDir = path.join(etc, 'dnsmasq.d');
  fs.mkdirSync(dnsDir, { recursive: true });
  const conf = path.join(dnsDir, 'jukebox.conf');
  const hosts = path.join(etc, 'hosts');
  const app = path.join(dir, 'app');
  fs.mkdirSync(app, { recursive: true });

  fs.writeFileSync(conf, 'address=/nhac.home/192.168.10.214\n');
  fs.writeFileSync(hosts,
    '127.0.0.1\tlocalhost\n' +
    '127.0.0.1\tnhac.home\t# jukebox-domain\n' +
    '192.168.1.9\tmay-in-jukebox-cua-toi\n');   // dòng của người dùng, phải giữ
  fs.writeFileSync(path.join(app, 'setup-domain.sh'), '#!/bin/sh\n');

  const env = { JUKEBOX_DNS_CONF: conf, JUKEBOX_ETC_HOSTS: hosts };
  const out = sh([path.join(ROOT, 'install.sh'), '--clean-domain', app], env);

  assert.ok(!fs.existsSync(conf), 'phải xoá cấu hình dnsmasq cũ');
  assert.ok(!fs.existsSync(path.join(app, 'setup-domain.sh')),
    'phải xoá cả script tên miền còn sót trong thư mục cài đặt');
  const after = fs.readFileSync(hosts, 'utf8');
  assert.ok(!/nhac\.home/.test(after), 'phải xoá dòng tên miền trong /etc/hosts');
  assert.match(out, /trỏ DNS trong router/, 'phải nhắc trả DNS router về mặc định');
  ok('install.sh --clean-domain dọn sạch dnsmasq + /etc/hosts + script cũ');

  // Chỉ được xoá ĐÚNG dòng do script cũ ghi ra. Xoá theo chữ "jukebox" thì
  // dòng nào của người dùng có chữ đó cũng bay mất.
  assert.match(after, /^127\.0\.0\.1\tlocalhost$/m, 'không được đụng dòng localhost');
  assert.match(after, /may-in-jukebox-cua-toi/,
    'dòng của người dùng có chữ "jukebox" phải được giữ nguyên');
  ok('chỉ xoá đúng dòng đánh dấu, không đụng dòng khác trong /etc/hosts');

  // Chạy lại trên máy SẠCH thì phải im lặng, không báo nhầm là vừa dọn gì đó.
  const again = sh([path.join(ROOT, 'install.sh'), '--clean-domain', app], env);
  assert.ok(!/trỏ DNS trong router/.test(again),
    'máy không có tàn dư thì không được in cảnh báo thừa');
  ok('chạy lại trên máy sạch: không báo nhầm, không lỗi');

  // ------------------------------------------------------- launcher kiosk
  // setup-kiosk.sh phải sinh ra launcher KHÔNG dính tên miền nào, và tự dò
  // cổng thay vì đoán.
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  // Chromium giả: setup-kiosk.sh dừng ngay nếu không tìm thấy trình duyệt.
  fs.writeFileSync(path.join(bin, 'chromium-browser'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(bin, 'chromium-browser'), 0o755);

  // setup-kiosk.sh CỐ Ý từ chối chạy bằng root (nó cài vào HOME của user
  // desktop, chạy sudo là cài nhầm vào /root). Máy kiểm thử thường là root,
  // nên hạ quyền xuống 'nobody' để chạy được đúng đường đi thật.
  const asUser = process.getuid && process.getuid() === 0;
  const kioskEnv = { HOME: home, PATH: bin + ':' + process.env.PATH };
  let kioskScript = path.join(ROOT, 'setup-kiosk.sh');

  if (asUser) {
    // 'nobody' không đọc được thư mục mã nguồn (hay nằm trong /root), nên chép
    // script ra thư mục tạm rồi chạy ở đó.
    const src = path.join(dir, 'src');
    fs.mkdirSync(src, { recursive: true });
    for (const f of ['setup-kiosk.sh', 'setup-audio.sh']) {
      fs.copyFileSync(path.join(ROOT, f), path.join(src, f));
    }
    kioskScript = path.join(src, 'setup-kiosk.sh');
    execFileSync('chmod', ['-R', 'a+rX', dir]);
    execFileSync('chown', ['-R', '65534:65534', home]);
    execFileSync('setpriv',
      ['--reuid=65534', '--regid=65534', '--clear-groups', 'bash', kioskScript],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, ...kioskEnv } });
  } else {
    sh([kioskScript], kioskEnv);
  }
  const launcher = fs.readFileSync(
    path.join(home, '.local/bin/jukebox-kiosk.sh'), 'utf8');

  const urls = launcher.match(/https?:\/\/[^"'\s]+/g) || [];
  const hostsUsed = [...new Set(urls.map((u) => u.replace(/^https?:\/\//, '').split(/[:/]/)[0]))];
  assert.deepStrictEqual(hostsUsed, ['127.0.0.1'],
    `launcher chỉ được dùng 127.0.0.1, đang thấy: ${hostsUsed.join(', ')}`);
  ok('launcher kiosk chỉ trỏ 127.0.0.1, không còn tên miền nào');

  assert.ok(!/getent hosts/.test(launcher),
    'không cần tra DNS nữa thì phải bỏ luôn đoạn dự phòng khi tra hỏng');
  ok('bỏ hẳn đoạn dự phòng "tên miền không phân giải được"');

  // Dò cổng: phải thử cả 80 lẫn 3000, vì service có thể chạy cổng nào cũng được.
  assert.match(launcher, /for p in 80 3000/, 'phải tự dò cổng 80 rồi 3000');
  ok('launcher tự dò cổng lúc khởi động thay vì ghi cứng');

  // Chạy THẬT đoạn dò cổng với một server đang nghe ở cổng khác 80: đây là
  // phần dễ sai nhất (viết trong heredoc, dấu $ phải thoát đúng).
  const lines = launcher.split('\n');
  const logAt = lines.findIndex((l) => l.includes('log "tự dò cổng'));
  assert.ok(logAt > 0, 'không tìm thấy đoạn dò cổng trong launcher');
  // Cắt tới hết khối if (dòng 'fi' ngay sau), nếu không đoạn trích sẽ thiếu
  // dấu đóng và shell báo lỗi cú pháp thay vì chạy.
  const fiAt = lines.findIndex((l, i) => i > logAt && l.trim() === 'fi');
  assert.ok(fiAt > logAt, 'không tìm thấy dấu đóng của khối dò cổng');
  const probe = lines.slice(0, fiAt + 1)
    .filter((l) => !/^TARGET="\$|^HEALTHURL="\$/.test(l))
    .join('\n');
  const probeFile = path.join(dir, 'probe.sh');
  fs.writeFileSync(probeFile,
    'log(){ :; }\nTARGET=""\nHEALTHURL=""\n' + probe +
    '\necho "TARGET=$TARGET"\n');

  // Server giả phải nằm ở TIẾN TRÌNH KHÁC: execFileSync chặn luồng sự kiện của
  // node, nên server dựng ngay trong bài kiểm thử này sẽ không kịp trả lời và
  // curl luôn hết giờ — bài kiểm thử "pass/fail" vì lý do chẳng liên quan gì.
  const { spawnSync, spawn } = require('child_process');
  const srv = spawn('node',
    ['-e', "require('http').createServer((_,r)=>r.end('{}')).listen(3000,'127.0.0.1')"],
    { stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      up = spawnSync('curl',
        ['-fsS', '--noproxy', '*', '--max-time', '1', 'http://127.0.0.1:3000/healthz'],
        { stdio: 'ignore' }).status === 0;
      if (!up) spawnSync('sleep', ['0.1']);
    }
    assert.ok(up, 'không dựng được server giả ở cổng 3000');

    const res = execFileSync('sh', [probeFile], { encoding: 'utf8' });
    assert.match(res, /TARGET=http:\/\/127\.0\.0\.1:3000\/player/,
      `server ở cổng 3000 thì phải dò ra đúng cổng đó, nhận: ${res.trim()}`);
    ok('dò cổng chạy thật: server ở 3000 => mở đúng http://127.0.0.1:3000/player');
  } finally {
    srv.kill();
  }

  console.log(`\n${pass}/${pass} bài kiểm thử script cài đặt PASS\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
} catch (e) {
  console.error('\n✗ FAIL:', e.message);
  process.exit(1);
}
