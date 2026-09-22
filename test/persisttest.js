/**
 * Kiểm thử: hàng chờ còn nguyên sau khi khởi động lại server.
 *
 * Chạy server THẬT trong tiến trình con, thêm bài qua WebSocket như điện thoại
 * vẫn làm, rồi tắt bằng SIGTERM — đúng tín hiệu `systemctl restart` gửi — và
 * bật lại xem còn gì. Không chạy server ngay trong tiến trình kiểm thử được,
 * vì phải kiểm đúng đường tắt/bật thật, không phải gọi hàm lưu bằng tay.
 *
 * Chạy: node test/persisttest.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-persist-'));
const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(extraEnv = {}) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DATA, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.log = '';
  proc.stdout.on('data', (d) => { proc.log += d; });
  proc.stderr.on('data', (d) => { proc.log += d; });
  return proc;
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server không lên');
}

function stopServer(proc, sig = 'SIGTERM') {
  return new Promise((resolve) => {
    proc.once('exit', (code, signal) => resolve({ code, signal }));
    proc.kill(sig);
  });
}

function client(role) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.last = null;
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === 'state') ws.last = m.state;
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role, name: 'test' }));
      resolve(ws);
    });
    ws.on('error', reject);
  });
}

const cmd = (ws, c, extra = {}) => ws.send(JSON.stringify({ type: 'cmd', cmd: c, ...extra }));
const getState = async () => (await fetch(BASE + '/api/state')).json();

const TRACKS = ['dQw4w9WgXcQ', 'kJQP7kiw5Fk', '9bZkp7q19f0', 'OPf0YbXqDm0'].map((id, i) => ({
  id, title: 'Bài số ' + (i + 1), author: 'Ca sĩ ' + (i + 1), duration: 200, thumb: '',
}));

(async () => {
  console.log('\n== Kiểm thử giữ hàng chờ qua khởi động lại ==\n');
  let srv;
  try {
    // ------------------------------------------------ lần chạy 1: thêm bài
    srv = startServer();
    await waitUp();
    const player = await client('player');
    const remote = await client('remote');
    await sleep(200);

    cmd(remote, 'add', { items: TRACKS, addedBy: 'Max' });
    await sleep(200);
    cmd(remote, 'jump', { uid: (await getState()).queue[2].uid });
    await sleep(200);
    cmd(remote, 'volume', { value: 37 });
    cmd(remote, 'repeat');   // off -> all
    await sleep(200);
    // Máy phát báo đang ở giây 95 của bài hiện tại.
    player.send(JSON.stringify({ type: 'progress', position: 95, duration: 200 }));
    await sleep(200);

    const before = await getState();
    assert.strictEqual(before.queue.length, 4);
    assert.strictEqual(before.index, 2);
    assert.strictEqual(before.playing, true);

    // Tắt NGAY sau khi đổi — chưa hết nhịp gom ghi 1 giây, chưa hết 20 giây
    // của vị trí phát. Nếu không bắt SIGTERM để ghi nốt thì mất hết ở đây.
    player.close(); remote.close();
    const how = await stopServer(srv);
    assert.strictEqual(how.code, 0, 'SIGTERM phải thoát sạch (mã 0) sau khi ghi xong');
    assert.ok(fs.existsSync(path.join(DATA, 'queue.json')), 'phải có data/queue.json');
    ok('systemctl restart (SIGTERM): ghi hết xuống đĩa rồi mới thoát');

    // ------------------------------------------------ lần chạy 2: còn không?
    srv = startServer();
    await waitUp();
    let after = await getState();
    assert.deepStrictEqual(after.queue.map((t) => t.id), TRACKS.map((t) => t.id),
      'hàng chờ phải còn đủ và đúng thứ tự');
    assert.deepStrictEqual(after.queue.map((t) => t.uid), before.queue.map((t) => t.uid),
      'uid phải giữ nguyên, nếu không điện thoại đang mở sẽ bấm nhầm bài');
    assert.strictEqual(after.queue[0].addedBy, 'Max');
    ok('khởi động lại: hàng chờ còn nguyên, đúng thứ tự, đúng người thêm');

    assert.strictEqual(after.index, 2, 'phải đứng lại đúng bài đang phát');
    assert.strictEqual(after.volume, 37);
    assert.strictEqual(after.repeat, 'all');
    ok('giữ luôn bài đang phát, âm lượng, chế độ lặp');

    assert.strictEqual(after.position, 95, 'phải nhớ đang nghe tới giây thứ mấy');
    ok('nhớ vị trí trong bài (giây 95) để phát tiếp chứ không hát lại từ đầu');

    // Chưa có máy phát thì chưa được coi là đang phát.
    assert.strictEqual(after.playing, false, 'chưa có máy phát nối lại thì không thể đang phát');
    const p2 = await client('player');
    await sleep(300);
    after = await getState();
    assert.strictEqual(after.playing, true,
      'đang phát lúc tắt => máy phát nối lại là phát tiếp');
    ok('đang phát lúc restart => máy phát nối lại là tự phát tiếp');
    p2.close();

    // Thao tác sau khi restart vẫn chạy bình thường trên hàng chờ đã nạp.
    const r2 = await client('remote');
    await sleep(150);
    cmd(r2, 'remove', { uid: after.queue[0].uid });
    await sleep(300);
    assert.strictEqual((await getState()).queue.length, 3, 'xoá bài trên hàng chờ đã nạp lại');
    r2.close();
    ok('xoá bài trên hàng chờ vừa nạp lại vẫn đúng');

    // Chờ nhịp gom 1 giây tự ghi (không nhờ SIGTERM), rồi tắt KIỂU MẤT ĐIỆN.
    await sleep(1500);
    await stopServer(srv, 'SIGKILL');
    srv = startServer();
    await waitUp();
    assert.strictEqual((await getState()).queue.length, 3,
      'mất điện đột ngột: vẫn còn thay đổi đã ghi trước đó');
    ok('mất điện đột ngột (SIGKILL): còn nguyên thay đổi đã ghi');
    await stopServer(srv);

    // ------------------------------------------------ file hỏng / sửa tay
    fs.writeFileSync(path.join(DATA, 'queue.json'), '{"v":1,"queue":[{"id":"dQw4w9W');
    srv = startServer();
    await waitUp();
    assert.strictEqual((await getState()).queue.length, 0);
    ok('file hàng chờ hỏng: server vẫn chạy, bắt đầu với hàng chờ trống');
    await stopServer(srv);

    fs.writeFileSync(path.join(DATA, 'queue.json'), JSON.stringify({
      v: 1, index: 99, playing: true,
      queue: [
        { uid: 'a', id: 'dQw4w9WgXcQ', title: 'Đúng' },
        { uid: 'b', id: 'không phải id' },           // id bậy
        null,                                         // rác
        { uid: 'a', id: 'kJQP7kiw5Fk', title: 'Trùng uid' },
      ],
    }));
    srv = startServer();
    await waitUp();
    const cleaned = await getState();
    assert.deepStrictEqual(cleaned.queue.map((t) => t.title), ['Đúng'],
      'phải bỏ bài id sai, rác và uid trùng');
    assert.strictEqual(cleaned.index, 0, 'index vượt quá phải kéo về trong khoảng');
    ok('file sửa tay/bậy: bỏ dòng hỏng, uid trùng, index vượt quá');
    await stopServer(srv);

    // ------------------------------------------------ hẹn giờ tắt đã qua
    fs.writeFileSync(path.join(DATA, 'queue.json'), JSON.stringify({
      v: 1, index: 0, playing: true, sleepAt: Date.now() - 60_000,
      queue: [{ uid: 'a', id: 'dQw4w9WgXcQ', title: 'Bài' }],
    }));
    srv = startServer();
    await waitUp();
    const p3 = await client('player');
    await sleep(300);
    assert.strictEqual((await getState()).playing, false,
      'hẹn giờ tắt đã tới trong lúc server nghỉ thì không được tự phát lại');
    p3.close();
    ok('hẹn giờ tắt đã qua trong lúc tắt máy => không tự phát lại');
    await stopServer(srv);

    // ------------------------------------------------ dữ liệu nhạy cảm
    const mode = fs.statSync(path.join(DATA, 'queue.json')).mode & 0o777;
    assert.strictEqual(mode, 0o600, `queue.json phải là 600, đang là ${mode.toString(8)}`);
    assert.ok(!fs.existsSync(path.join(DATA, 'queue.json.tmp')), 'không được sót file tạm');
    ok('file lưu quyền 600, không sót file tạm');

    console.log(`\n${pass}/${pass} bài kiểm thử giữ hàng chờ PASS\n`);
    fs.rmSync(DATA, { recursive: true, force: true });
    process.exit(0);
  } catch (e) {
    console.error('\n✗ FAIL:', e.message);
    if (srv) { console.error('--- log server ---\n' + srv.log.slice(-2000)); srv.kill('SIGKILL'); }
    process.exit(1);
  }
})();
