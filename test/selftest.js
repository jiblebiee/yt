/**
 * Self-test: kiểm tra parser + toàn bộ luồng WebSocket (player <-> remote).
 * Chạy: node test/selftest.js
 * Không cần internet (dùng HTML giả lập cho phần parser).
 */
process.env.PORT = process.env.PORT || '3999';
// Không để bài test ghi đè dữ liệu thật trong data/.
// Thư mục MỚI mỗi lần chạy: server giờ nạp lại hàng chờ từ đĩa, nên dùng lại
// thư mục cũ thì lần chạy trước để lại "lặp tất cả" và bài kiểm thử "hết hàng
// chờ thì dừng" hỏng — hỏng vì dữ liệu cũ, không phải vì code.
process.env.DATA_DIR = process.env.DATA_DIR ||
  require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'jukebox-selftest-'));
const assert = require('assert');
const fs = require('fs');
const WebSocket = require('ws');
const {
  server,
  parseYouTubeInput,
  extractInitialData,
  trackFromNode,
  feedTracks,
  trimQueue,
  state,
  GENRES,
  genreByKey,
  isSongLike,
  genreTracks,
  ytStatus,
  noteYtOk,
  hideTrack,
  unhideTrack,
  notHidden,
  HIDDEN_PATH,
  buildMix,
  buildMixes,
  mergeSongs,
  shuffled,
  MIX_SIZE,
  notePlay,
  loadConfig,
  saveConfig,
  CONFIG_PATH,
  noteInnertubeFailure,
  getInnertube,
  _backoffUntil,
} = require('../server.js');

let pass = 0;
const ok = (name) => { pass++; console.log('  ✓', name); };

// ---------------------------------------------------------------- parser
{
  assert.deepStrictEqual(parseYouTubeInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), { video: 'dQw4w9WgXcQ', list: null });
  assert.strictEqual(parseYouTubeInput('https://youtu.be/dQw4w9WgXcQ?t=30').video, 'dQw4w9WgXcQ');
  assert.strictEqual(parseYouTubeInput('https://www.youtube.com/shorts/dQw4w9WgXcQ').video, 'dQw4w9WgXcQ');
  assert.strictEqual(parseYouTubeInput('https://music.youtube.com/watch?v=dQw4w9WgXcQ').video, 'dQw4w9WgXcQ');
  assert.strictEqual(parseYouTubeInput('https://www.youtube.com/playlist?list=PL123abc').list, 'PL123abc');
  assert.strictEqual(parseYouTubeInput('nhạc chill buổi sáng'), null);
  assert.strictEqual(parseYouTubeInput('https://vimeo.com/12345'), null);
  ok('parseYouTubeInput nhận diện đúng mọi dạng link');
}
{
  const html = `<script>var ytInitialData = {"a":"}{ \\" tricky","b":{"videoRenderer":{"videoId":"abc"}}};</script>`;
  const d = extractInitialData(html);
  assert.strictEqual(d.b.videoRenderer.videoId, 'abc');
  assert.strictEqual(d.a, '}{ " tricky');
  ok('extractInitialData bóc đúng JSON kể cả khi chuỗi chứa dấu ngoặc');
}

// ------------------------------------------------- chuẩn hoá node youtubei.js
{
  // Node "Video" cổ điển (kết quả tìm kiếm)
  const v = trackFromNode({
    video_id: 'dQw4w9WgXcQ',
    title: { text: 'Tên bài' },
    author: { name: 'Kênh ABC' },
    duration: { seconds: 213, text: '3:33' },
    thumbnails: [{ url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mq.jpg' }],
  });
  assert.deepStrictEqual(v, {
    id: 'dQw4w9WgXcQ',
    title: 'Tên bài',
    author: 'Kênh ABC',
    duration: 213,
    thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mq.jpg',
  });

  // Node "PlaylistVideo"
  const p = trackFromNode({
    id: 'abcdefghijk',
    title: { text: 'Bài trong playlist' },
    author: { name: 'Kênh XYZ' },
    duration: { seconds: 100, text: '1:40' },
    thumbnails: [],
  });
  assert.strictEqual(p.id, 'abcdefghijk');
  assert.strictEqual(p.thumb, 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');

  // Node "LockupView" (dạng mới YouTube đang chuyển sang)
  const l = trackFromNode({
    content_id: 'zzzzzzzzzzz',
    content_type: 'VIDEO',
    metadata: { title: { text: 'Bài kiểu lockup' } },
    content_image: { image: [{ url: 'https://i.ytimg.com/vi/zzzzzzzzzzz/mq.jpg' }] },
  });
  assert.strictEqual(l.title, 'Bài kiểu lockup');
  assert.strictEqual(l.duration, 0, 'lockup không có duration, player sẽ báo lại sau');

  // Những thứ phải bị loại
  assert.strictEqual(trackFromNode(null), null);
  assert.strictEqual(trackFromNode({ content_id: 'PLxxxx', content_type: 'PLAYLIST' }), null);
  assert.strictEqual(trackFromNode({ video_id: 'quá-ngắn' }), null, 'id sai định dạng bị loại');
  ok('trackFromNode chuẩn hoá đúng Video / PlaylistVideo / LockupView');
}

// ------------------------------------------------------------ gom track
{
  const feed = {
    videos: [
      { video_id: 'aaaaaaaaaaa', title: { text: 'A' }, duration: { seconds: 10 }, thumbnails: [] },
      { video_id: 'aaaaaaaaaaa', title: { text: 'A trùng' }, duration: { seconds: 10 }, thumbnails: [] },
      { video_id: 'bbbbbbbbbbb', title: { text: 'Live' }, is_live: true, thumbnails: [] },
      { video_id: 'ccccccccccc', title: { text: 'C' }, duration: { seconds: 20 }, thumbnails: [] },
    ],
  };
  const out = feedTracks(feed);
  assert.deepStrictEqual(out.map((t) => t.id), ['aaaaaaaaaaa', 'ccccccccccc']);
  assert.deepStrictEqual(feedTracks(feed, 1).map((t) => t.id), ['aaaaaaaaaaa']);
  assert.deepStrictEqual(feedTracks(null), []);
  ok('feedTracks bỏ bài trùng, bỏ livestream, tôn trọng giới hạn');
}

// ------------------------------- install.sh phải chép đủ mọi module local
// Đây là bài test sinh ra từ một lỗi thật: thêm youtube-api.js nhưng quên cập
// nhật danh sách file trong install.sh -> server chết vì MODULE_NOT_FOUND.
{
  const { execFileSync } = require('child_process');
  const os = require('os');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'jb-install-'));

  execFileSync('bash', [path.join(root, 'install.sh'), '--copy-only', dest], {
    stdio: 'pipe',
  });

  // Mọi require('./…') trong mã nguồn phải có mặt ở thư mục đã chép.
  const entryFiles = ['server.js', 'youtube-api.js'];
  const missing = [];
  for (const f of entryFiles) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/require\('(\.\/[^']+)'\)/g)) {
      const rel = m[1].replace(/^\.\//, '');
      if (!fs.existsSync(path.join(dest, rel))) missing.push(`${f} -> ${rel}`);
    }
  }
  assert.deepStrictEqual(missing, [], 'install.sh chép thiếu module');

  // Những file bắt buộc phải có để chạy được
  for (const f of ['server.js', 'youtube-api.js', 'package.json',
    'public/remote.html', 'public/player.html', 'public/favicon.svg']) {
    assert.ok(fs.existsSync(path.join(dest, f)), `thiếu ${f} sau khi cài`);
  }

  // Và những thứ KHÔNG được chép sang
  assert.strictEqual(fs.existsSync(path.join(dest, 'node_modules')), false,
    'không được chép node_modules');
  assert.strictEqual(fs.existsSync(path.join(dest, 'data')), false,
    'không được chép data/ (sẽ đè lên token của bản đang chạy)');

  fs.rmSync(dest, { recursive: true, force: true });
  ok('install.sh chép đủ mọi module local, không chép data/ và node_modules');
}

// ------------------------------------------------------- BUILD phải khớp nhau
{
  const path = require('path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const grab = (src) => (src.match(/BUILD\s*=\s*'([^']+)'/) || [])[1];

  const serverBuild = grab(read('server.js'));
  const remoteBuild = grab(read('public/remote.html'));
  assert.ok(serverBuild, 'server.js phải khai báo BUILD');
  assert.ok(remoteBuild, 'remote.html phải khai báo BUILD');
  assert.strictEqual(
    remoteBuild, serverBuild,
    'BUILD trong remote.html và server.js phải giống nhau, nếu không trang nào ' +
    'cũng báo "server chạy mã cũ" dù đã restart'
  );
  ok(`BUILD khớp giữa server.js và remote.html (${serverBuild})`);
}

// ------------------------------------------------------------ config kênh
{
  try { fs.unlinkSync(CONFIG_PATH); } catch {}
  assert.deepStrictEqual(loadConfig(), {}, 'chưa có file thì trả object rỗng');

  // Client ID / Secret của Google Cloud nằm ở đây -> phải là 600.
  saveConfig({ google: { client_id: 'abc.apps.googleusercontent.com', client_secret: 's3cr3t' } });
  assert.strictEqual(loadConfig().google.client_id, 'abc.apps.googleusercontent.com');
  assert.strictEqual(fs.statSync(CONFIG_PATH).mode & 0o777, 0o600,
    'config chứa Client Secret nên bắt buộc quyền 600');
  ok('lưu/đọc cấu hình Google, file ở quyền 600');

  try { fs.unlinkSync(CONFIG_PATH); } catch {}
  assert.deepStrictEqual(loadConfig(), {}, 'file hỏng/không có thì trả object rỗng');
  fs.writeFileSync(CONFIG_PATH, 'không-phải-json');
  assert.deepStrictEqual(loadConfig(), {}, 'JSON hỏng cũng không được ném lỗi');
  try { fs.unlinkSync(CONFIG_PATH); } catch {}
  ok('config hỏng không làm server chết');
}

// ------------------------------------------------------- đài theo thể loại
{
  assert.ok(GENRES.length >= 8, 'phải có đủ thể loại để chọn');
  const keys = GENRES.map((g) => g.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'key thể loại không được trùng');
  for (const g of GENRES) {
    assert.ok(g.label, `thể loại ${g.key} thiếu tên hiển thị`);
    assert.ok(g.queries.length >= 1, `thể loại ${g.key} phải có ít nhất 1 từ khoá`);
  }
  assert.strictEqual(genreByKey('bolero').label, 'Bolero · Nhạc vàng');
  assert.strictEqual(genreByKey('không-có'), null);
  assert.strictEqual(genreByKey(undefined), null);
  ok(`có ${GENRES.length} đài thể loại, key không trùng, đều có từ khoá`);
}

// ---------------------------------------------------------- lọc Shorts
// Rót bài tự động mà dính Shorts thì hàng chờ nhảy bài liên tục.
{
  assert.strictEqual(isSongLike({ id: 'a', title: 'Bài hát', duration: 240 }), true);
  assert.strictEqual(isSongLike({ id: 'a', title: 'Bài hát', duration: 0 }), true,
    'chưa biết độ dài thì vẫn cho qua, player sẽ báo lại sau');
  assert.strictEqual(isSongLike({ id: 'a', title: 'Clip vui', duration: 45 }), false,
    'dưới 70 giây coi như Shorts');
  assert.strictEqual(isSongLike({ id: 'a', title: 'Trend này hay #shorts', duration: 300 }), false,
    'tiêu đề có #shorts thì loại kể cả khi dài');
  assert.strictEqual(isSongLike({ id: 'a', title: 'Hay quá #Shorts', duration: 300 }), false,
    'không phân biệt hoa thường');
  assert.strictEqual(isSongLike({ id: 'a', title: 'Nhạc shortsighted', duration: 300 }), true,
    'không được nhận nhầm chữ chứa "shorts"');
  assert.strictEqual(isSongLike(null), false);
  assert.strictEqual(isSongLike({ title: 'thiếu id' }), false);
  ok('isSongLike loại Shorts nhưng không nhận nhầm bài dài có chữ giống');

  // Chế độ strict: loại video tổng hợp. Đây là những tiêu đề THẬT lấy từ
  // màn hình đài "Nhạc trẻ" trước khi sửa — toàn video 1 tiếng.
  const rac = [
    ['Nhạc Trẻ Ballad Việt Hay Nhất 2026 | Lk Nhạc Trẻ Buồn', 3844],
    ['NHẠC REMIX TIKTOK TRIỆU VIEW - BXH Nhạc Trẻ Remix', 2977],
    ['Top Những Bản Ca Sĩ Giấu Mặt Cover Hay Nhất', 5224],
    ['Nhạc Trẻ Ballad Hot Trend 2026 ♫ Top 20 Ca Khúc Việt', 4817],
    ['Tái Sinh Remix ♫ BXH Nhạc Trẻ EDM Hot Trend TRIỆU VIEW', 4831],
    ['Mashup 2 In 1 | Nhạc Trẻ Remix', 4165],
  ];
  for (const [title, duration] of rac) {
    assert.strictEqual(isSongLike({ id: 'x', title, duration }, { strict: true }), false,
      `phải loại bản tổng hợp: ${title}`);
    // Lưới dự phòng vẫn cho qua, để không bao giờ trả về danh sách trống.
    assert.strictEqual(isSongLike({ id: 'x', title, duration }), true,
      `lưới dự phòng vẫn phải nhận: ${title}`);
  }
  ok(`chế độ strict loại đúng ${rac.length} tiêu đề tổng hợp lấy từ màn hình thật`);

  // Ngược lại: bài lẻ chính thức phải lọt qua được lưới chặt.
  const that = [
    ['HIEUTHUHAI - Người Im Lặng Gặp Người Hay Nói (Official Music Video)', 245],
    ['Sơn Tùng M-TP | Chúng Ta Của Hiện Tại | Official MV', 312],
    ['Duyên Phận - Như Quỳnh', 380],
    ['Vì Yêu Cứ Đâm Đầu - Min | Official Audio', 268],
  ];
  for (const [title, duration] of that) {
    assert.strictEqual(isSongLike({ id: 'x', title, duration }, { strict: true }), true,
      `không được loại nhầm bài lẻ: ${title}`);
  }
  // Bài lẻ nhưng dài quá 12 phút thì vẫn bị loại — gần như chắc là tổng hợp.
  assert.strictEqual(
    isSongLike({ id: 'x', title: 'Nhạc nhẹ nhàng', duration: 13 * 60 }, { strict: true }), false,
    'dài hơn 12 phút phải bị loại kể cả khi tiêu đề sạch');
  ok('chế độ strict không loại nhầm bài lẻ official, nhưng chặn video quá dài');

  // ---- ghép mix 15 bài -------------------------------------------------
  assert.strictEqual(MIX_SIZE, 15);

  // mergeSongs: gộp nhiều mẻ, bỏ trùng id, loại bản tổng hợp.
  const merged = mergeSongs([
    [{ id: 'a', title: 'Bài A official mv', duration: 240 },
     { id: 'b', title: 'Bài B official', duration: 250 }],
    [{ id: 'a', title: 'Bài A official mv', duration: 240 },   // trùng
     { id: 'c', title: 'LK Nhạc Trẻ Buồn', duration: 3800 },   // tổng hợp
     { id: 'd', title: 'Bài D', duration: 200 },
     { id: 'e', title: 'Bài E', duration: 300 },
     { id: 'f', title: 'Bài F', duration: 280 }],
  ]);
  assert.deepStrictEqual(merged.map((t) => t.id), ['a', 'b', 'd', 'e', 'f'],
    'phải bỏ id trùng và loại bản tổng hợp');
  ok('mergeSongs gộp nhiều mẻ, bỏ trùng, loại video tổng hợp');

  // ---- ẩn bài gợi ý ----------------------------------------------------
  const fs2 = require('fs');
  hideTrack('ghet1');
  assert.strictEqual(notHidden({ id: 'ghet1' }), false, 'bài đã ẩn phải bị loại');
  assert.strictEqual(notHidden({ id: 'thich1' }), true);

  // Phải ghi xuống đĩa ngay: gạt xong mà khởi động lại nó quay về thì vô nghĩa.
  const onDisk = JSON.parse(fs2.readFileSync(HIDDEN_PATH, 'utf8'));
  assert.ok(onDisk.includes('ghet1'), 'id đã ẩn phải nằm trong hidden.json');

  // Bài đã ẩn không được lọt vào bất kỳ mẻ gợi ý nào.
  const withHidden = mergeSongs([[
    { id: 'ghet1', title: 'Bài không thích', duration: 240 },
    { id: 'thich1', title: 'Bài ổn', duration: 240 },
  ]]);
  assert.deepStrictEqual(withHidden.map((t) => t.id), ['thich1'],
    'mergeSongs phải bỏ bài đã ẩn');

  assert.strictEqual(unhideTrack('ghet1'), true);
  assert.strictEqual(notHidden({ id: 'ghet1' }), true, 'bỏ ẩn thì bài quay lại');
  assert.strictEqual(unhideTrack('chua-tung-an'), false,
    'bỏ ẩn id chưa từng ẩn thì báo là không có gì để bỏ');
  ok('ẩn/bỏ ẩn bài: ghi xuống đĩa, loại khỏi mọi mẻ gợi ý, đảo lại được');

  // ---- theo dõi sức khoẻ đường ra YouTube ------------------------------
  // Chưa gọi lần nào thì KHÔNG được kết luận là hỏng — server vừa khởi động
  // mà đã hiện cảnh báo đỏ thì lần nào cũng báo động giả.
  const h0 = ytStatus();
  assert.strictEqual(h0.status, 'idle');
  assert.strictEqual(h0.hint, null, 'trạng thái idle thì đừng bày cách sửa');

  noteYtOk('innertube');
  assert.strictEqual(ytStatus().status, 'ok');
  assert.strictEqual(ytStatus().via, 'innertube');
  assert.strictEqual(ytStatus().hint, null);

  // Chỉ còn scraper = vẫn nghe được nhưng đã hỏng đường chính. Phải báo, kèm
  // đúng lệnh cần chạy — đây là lúc nâng youtubei.js.
  noteYtOk('scraper');
  const deg = ytStatus();
  assert.strictEqual(deg.status, 'degraded');
  assert.match(deg.hint, /update\.sh/);

  // Lỗi MỚI hơn lần thành công gần nhất cũng là suy giảm.
  noteYtOk('innertube');
  noteInnertubeFailure(new Error('YouTube đổi API'));
  const deg2 = ytStatus();
  assert.strictEqual(deg2.status, 'degraded');
  assert.strictEqual(deg2.lastError, 'YouTube đổi API');
  assert.ok(deg2.lastErrAt >= deg2.lastOkAt);

  // Lỗi backoff không được tính là lỗi mới, nếu không một lần hỏng thật sẽ
  // sinh ra hàng loạt lỗi giả và cửa sổ chờ bị gia hạn vô hạn.
  const failsBefore = ytStatus().fails;
  const backoffErr = new Error('Innertube đang tạm nghỉ');
  backoffErr.isBackoff = true;
  noteInnertubeFailure(backoffErr);
  assert.strictEqual(ytStatus().fails, failsBefore,
    'lỗi backoff không được cộng vào số lần hỏng');
  ok('theo dõi YouTube: phân biệt được idle / ok / chỉ-còn-scraper / có lỗi mới');


  // shuffled không được làm mất hay nhân đôi phần tử.
  const src = Array.from({ length: 30 }, (_, i) => i);
  const sh = shuffled(src);
  assert.strictEqual(sh.length, src.length);
  assert.deepStrictEqual([...sh].sort((x, y) => x - y), src, 'trộn không được mất phần tử');
  assert.deepStrictEqual(src, Array.from({ length: 30 }, (_, i) => i),
    'shuffled phải trả mảng mới, không sửa mảng gốc');
  ok('shuffled trộn đủ phần tử và không đụng vào mảng gốc');

}

// ------------------------------------------- cắt hàng chờ khi auto-radio chạy
// Máy chạy 24/7 với auto-radio sẽ nối bài liên tục; không cắt thì hàng chờ
// phình mãi và trang điều khiển ngày càng nặng.
{
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ uid: 'u' + i, id: 'v' + i, title: 't' + i }));

  // Dưới ngưỡng: không đụng gì
  state.queue = mk(100); state.index = 90;
  trimQueue();
  assert.strictEqual(state.queue.length, 100, 'dưới ngưỡng thì giữ nguyên');
  assert.strictEqual(state.index, 90);

  // Trên ngưỡng: cắt bớt phần ĐÃ PHÁT ở đầu, index dời theo
  state.queue = mk(400); state.index = 380;
  const cur = state.queue[380];
  trimQueue();
  assert.ok(state.queue.length <= 300, `phải cắt còn <=300, đang ${state.queue.length}`);
  assert.strictEqual(state.queue[state.index], cur, 'bài đang phát KHÔNG được đổi');
  assert.ok(state.index >= 0);

  // Đang ở đầu hàng chờ thì không được cắt (sẽ mất bài chưa phát)
  state.queue = mk(400); state.index = 5;
  const before = state.queue.length;
  trimQueue();
  assert.strictEqual(state.queue.length, before, 'index còn nhỏ thì không cắt');
  assert.strictEqual(state.index, 5);

  state.queue = []; state.index = -1;
  ok('trimQueue cắt đúng phần đã phát, không bao giờ mất bài đang phát');
}

// ------------------------------------------------------ backoff Innertube
async function testBackoff() {
  // Lỗi thật -> mở cửa sổ chờ 60s.
  noteInnertubeFailure(new Error('mạng hỏng'));
  const e1 = await getInnertube().then(() => null, (e) => e);
  assert.ok(e1 && e1.isBackoff, 'trong cửa sổ chờ thì báo lỗi backoff');

  // Lỗi backoff KHÔNG được gia hạn cửa sổ, nếu không sẽ kẹt vĩnh viễn khi
  // có người tìm kiếm liên tục dưới 60s một lần.
  const deadline = _backoffUntil();
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const e2 = await getInnertube().then(() => null, (e) => e);
    assert.ok(e2 && e2.isBackoff);
    noteInnertubeFailure(e2);
  }
  assert.strictEqual(_backoffUntil(), deadline, 'hạn chờ phải giữ nguyên, không bị đẩy lùi');

  // Lỗi thật thì mới được gia hạn.
  noteInnertubeFailure(new Error('mạng lại hỏng'));
  assert.ok(_backoffUntil() > deadline, 'lỗi thật thì gia hạn cửa sổ chờ');
  ok('backoff: lỗi giả không gia hạn, lỗi thật mới gia hạn');
}

// ------------------------------------------------------------ websocket
const PORT = process.env.PORT;
const URL = `ws://127.0.0.1:${PORT}/ws`;
const track = (id, title) => ({ id, title, author: 'Tester', duration: 100, thumb: '' });

function open(role, name) {
  return new Promise((res) => {
    const ws = new WebSocket(URL);
    ws.states = [];
    ws.msgs = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      ws.msgs.push(m);
      if (m.type === 'state') ws.states.push(m.state);
    });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', role, name })); res(ws); });
  });
}
const last = (ws) => ws.states[ws.states.length - 1];
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- genreTracks: gạt nhiều bài không được làm trắng màn hình ---------
  // Đây là lỗi người dùng gặp thật. Giả lập YouTube bằng cách chặn ytSearch
  // là không làm được từ đây, nên kiểm ở mức hợp đồng: hàm phải trả về đủ ba
  // trường để giao diện phân biệt "hết bài" với "đã gạt hết".
  // Tiêm hàm tìm giả: mỗi từ khoá trả về một mẻ bài KHÁC nhau, giống thật.
  const song = (id) => ({ id, title: 'Bài ' + id, author: 'CS', duration: 220,
                          thumb: 't' });
  const asked = [];
  const fakeSearch = (q) => {
    asked.push(q);
    const n = asked.length;
    return Promise.resolve(Array.from({ length: 8 }, (_, i) => song(`q${n}s${i}`)));
  };

  asked.length = 0;
  const g1 = await genreTracks('tre', 5, { search: fakeSearch });
  assert.strictEqual(g1.items.length, 5);
  assert.strictEqual(g1.exhausted, false);
  assert.ok(asked.length >= 2,
    `phải hỏi nhiều từ khoá để gom đủ bài dự phòng, mới hỏi ${asked.length}`);
  ok(`genreTracks hỏi ${asked.length} từ khoá để gom đủ mẻ, không dừng ở một cái`);

  // ĐÂY LÀ LỖI NGƯỜI DÙNG GẶP: gạt hết bài thì mẻ mới trắng trơn và không nói
  // vì sao. Giờ phải trả về exhausted=true kèm số bài đã ẩn.
  const allIds = [];
  for (let n = 1; n <= 4; n++) for (let i = 0; i < 8; i++) allIds.push(`q${n}s${i}`);
  allIds.forEach(hideTrack);
  asked.length = 0;
  const g2 = await genreTracks('tre', 5, { search: fakeSearch });
  assert.strictEqual(g2.items.length, 0);
  assert.strictEqual(g2.exhausted, true,
    'hết bài vì đã gạt hết thì phải nói rõ, khác với YouTube không trả về gì');
  assert.ok(g2.hiddenSkipped > 0, 'phải đếm được bao nhiêu bài bị bỏ do đã ẩn');
  assert.strictEqual(asked.length, genreByKey('tre').queries.length,
    'hết bài thì phải thử HẾT các từ khoá rồi mới chịu thua');
  ok(`gạt hết bài => exhausted=true, đã ẩn ${g2.hiddenSkipped} bài, đã thử hết từ khoá`);

  allIds.forEach(unhideTrack);

  // Một từ khoá hỏng không được làm hỏng cả mẻ.
  asked.length = 0;
  let call = 0;
  const flaky = (q) => {
    asked.push(q);
    call++;
    if (call === 1) return Promise.reject(new Error('YouTube 403'));
    return Promise.resolve(Array.from({ length: 8 }, (_, i) => song(`f${call}s${i}`)));
  };
  const g3 = await genreTracks('tre', 5, { search: flaky });
  assert.strictEqual(g3.items.length, 5, 'một từ khoá hỏng thì phải thử từ khoá kế');
  ok('một từ khoá lỗi không làm hỏng cả mẻ — tự chuyển sang từ khoá khác');

  // buildMix nguồn 'history' chạy được KHÔNG cần mạng: hạt giống lấy từ lịch
  // sử tại chỗ, phần tìm bài liên quan hỏng thì bỏ qua.
  for (let i = 0; i < 20; i++) {
    notePlay({ id: 'h' + i, title: 'Bài hay nghe ' + i, author: 'CS', duration: 200 + i });
  }
  const mixHist = await buildMix({ source: 'history' });
  assert.strictEqual(mixHist.label, 'Mix bài hay nghe');
  assert.ok(mixHist.items.length > 0, 'phải ghép được ít nhất vài bài');
  assert.ok(mixHist.items.length <= MIX_SIZE,
    `mix tối đa ${MIX_SIZE} bài, đang có ${mixHist.items.length}`);
  const mixIds = mixHist.items.map((t) => t.id);
  assert.strictEqual(new Set(mixIds).size, mixIds.length, 'mix không được có bài trùng');
  ok(`buildMix('history') ghép ${mixHist.items.length} bài, không trùng, không quá ${MIX_SIZE}`);

  await assert.rejects(() => buildMix({ source: 'query', query: '  ' }),
    /Chưa nhập từ khoá/, 'từ khoá trống phải báo lỗi rõ ràng');
  await assert.rejects(() => buildMix({ source: 'linh tinh' }),
    /Nguồn mix không hợp lệ/);
  ok('buildMix báo lỗi rõ khi thiếu từ khoá hoặc sai nguồn');

  // buildMixes: nhiều mix để CHỌN, không phải một mẻ bài lẻ.
  for (let i = 0; i < 80; i++) {
    notePlay({ id: 'm' + i, title: 'Bài mix ' + i, author: 'CS ' + (i % 7), duration: 210 });
  }
  const many = await buildMixes({ source: 'history' }, { count: 5 });
  assert.ok(many.mixes.length >= 3,
    `mẻ 60 bài phải ghép được nhiều mix để chọn, đang có ${many.mixes.length}`);
  assert.strictEqual(many.mixes[0].items.length, MIX_SIZE, `mix đầu đúng ${MIX_SIZE} bài`);
  for (const m of many.mixes) {
    assert.ok(m.items.length <= MIX_SIZE, `không mix nào quá ${MIX_SIZE} bài`);
    assert.ok(m.label, 'mix phải có tên');
    assert.ok(m.sub.includes('bài'), 'phụ đề phải nói số bài');
    assert.strictEqual(m.label, m.items[0].title, 'tên mix lấy theo bài đầu');
  }
  // Các mix KHÔNG được trùng bài — trùng thì chọn mix nào cũng như nhau.
  const ids = many.mixes.flatMap((m) => m.items.map((t) => t.id));
  assert.strictEqual(new Set(ids).size, ids.length, 'các mix phải rời nhau');
  ok(`buildMixes ghép 5 mix × ${MIX_SIZE} bài, không mix nào trùng bài mix nào`);

  // ---- cache tìm kiếm --------------------------------------------------
  // Mở tab Home gọi tìm cho cả danh sách gợi ý lẫn 5 playlist, cùng những từ
  // khoá đó. Không nhớ tạm thì Pi ngồi chờ mạng suốt và YouTube dễ chặn IP.
  const { _searchCache, _cacheGet, _cacheSet, SEARCH_CACHE_MAX } = require('../server.js');
  _searchCache.clear();

  _cacheSet('k1', [{ id: 'a' }]);
  assert.deepStrictEqual(_cacheGet('k1'), [{ id: 'a' }]);
  assert.strictEqual(_cacheGet('chua-co'), null);

  // Quá hạn thì coi như không có, và phải DỌN luôn khỏi Map — giữ lại thì cache
  // đầy dần bằng rác và đẩy mất những mục còn dùng được.
  _searchCache.set('cu', { at: Date.now() - 10 * 60 * 1000, items: [{ id: 'x' }] });
  assert.strictEqual(_cacheGet('cu'), null, 'mục quá hạn phải coi như không có');
  assert.strictEqual(_searchCache.has('cu'), false, 'và phải bị xoá khỏi cache');

  // Đầy thì bỏ mục CŨ NHẤT, không phải bỏ mục vừa thêm.
  _searchCache.clear();
  for (let i = 0; i < SEARCH_CACHE_MAX + 5; i++) _cacheSet('key' + i, [{ id: 'i' + i }]);
  assert.ok(_searchCache.size <= SEARCH_CACHE_MAX,
    `cache không được vượt ${SEARCH_CACHE_MAX}, đang ${_searchCache.size}`);
  assert.strictEqual(_cacheGet('key0'), null, 'mục cũ nhất phải bị đẩy ra');
  assert.ok(_cacheGet('key' + (SEARCH_CACHE_MAX + 4)), 'mục mới nhất phải còn');
  _searchCache.clear();
  ok('cache tìm kiếm: hết hạn thì dọn, đầy thì bỏ mục cũ nhất chứ không bỏ mục mới');

  // Mẻ bài ít thì trả về ít mix, nhưng luôn có ít nhất một cái.
  const few = await buildMixes({ source: 'history' }, { count: 5, size: 60 });
  assert.ok(few.mixes.length >= 1 && few.mixes.length <= 5);
  ok('mẻ bài ít => trả về ít mix hơn nhưng không bao giờ rỗng');

  // server.js đã tự listen khi require; chỉ cần đợi nó sẵn sàng.
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  await testBackoff();

  const remote = await open('remote', 'Máy A');
  await wait();
  assert.strictEqual(last(remote).players, 0, 'chưa có máy phát');
  ok('remote kết nối, server báo 0 máy phát');

  // Không có player -> thêm bài vẫn xếp hàng nhưng không "phát" được ra loa
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'add', item: track('aaaaaaaaaaa', 'Bài 1'), addedBy: 'Máy A' }));
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'add', item: track('bbbbbbbbbbb', 'Bài 2'), addedBy: 'Máy A' }));
  await wait();
  assert.strictEqual(last(remote).queue.length, 2);
  assert.strictEqual(last(remote).index, 0);
  assert.strictEqual(last(remote).current.title, 'Bài 1');
  ok('thêm 2 bài, bài đầu tự thành bài hiện tại');

  const player = await open('player');
  await wait();
  assert.strictEqual(last(remote).players, 1);
  assert.strictEqual(last(player).current.id, 'aaaaaaaaaaa');
  ok('player kết nối, nhận đúng bài đang phát');

  // next
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'next' }));
  await wait();
  assert.strictEqual(last(player).current.title, 'Bài 2');
  ok('lệnh next từ remote đẩy đúng bài mới xuống player');

  // player báo hết bài -> repeat off, hết hàng chờ -> dừng
  player.send(JSON.stringify({ type: 'ended' }));
  await wait();
  assert.strictEqual(last(remote).playing, false, 'hết hàng chờ thì dừng');
  ok('hết bài cuối + repeat off => dừng');

  // repeat all -> quay vòng
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'repeat', value: 'all' }));
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'jump', uid: last(remote).queue[1].uid }));
  await wait();
  player.send(JSON.stringify({ type: 'ended' }));
  await wait();
  assert.strictEqual(last(remote).index, 0, 'quay lại bài đầu');
  assert.strictEqual(last(remote).playing, true);
  ok('repeat=all quay vòng về bài đầu');

  // Công tắc tự phát tiếp (Mix). Hàng chờ còn bài kế nên KHÔNG gọi mạng.
  assert.strictEqual(last(remote).autoRadio, false, 'mặc định phải tắt');
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'autoradio' }));
  await wait();
  assert.strictEqual(last(remote).autoRadio, true);
  assert.strictEqual(last(player).autoRadio, true, 'player cũng phải thấy trạng thái');
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'autoradio', value: false }));
  await wait();
  assert.strictEqual(last(remote).autoRadio, false, 'truyền value=false thì tắt hẳn');
  ok('bật/tắt tự phát tiếp, trạng thái đồng bộ sang cả player');

  // Hẹn giờ dừng
  assert.strictEqual(last(remote).sleepAt, null, 'mặc định không hẹn giờ');
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'sleep', minutes: 30 }));
  await wait();
  const left = last(remote).sleepAt - Date.now();
  assert.ok(left > 29 * 60000 && left <= 30 * 60000, `phải còn ~30 phút, đang ${left}ms`);
  assert.ok(remote.msgs.some((m) => m.type === 'toast' && /30 phút/.test(m.text)));
  ok('hẹn giờ 30 phút đặt đúng mốc và báo lại cho remote');

  remote.send(JSON.stringify({ type: 'cmd', cmd: 'sleep', minutes: 0 }));
  await wait();
  assert.strictEqual(last(remote).sleepAt, null, 'minutes=0 phải huỷ hẹn giờ');
  ok('huỷ hẹn giờ');

  // Hẹn giờ RẤT ngắn để kiểm tra nó thật sự dừng nhạc, không chỉ đặt mốc.
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'play' }));
  await wait();
  assert.strictEqual(last(remote).playing, true, 'phải đang phát trước đã');
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'sleep', minutes: 0.02 })); // 1,2 giây
  await wait(1600);
  assert.strictEqual(last(remote).playing, false, 'tới giờ thì phải dừng phát');
  assert.strictEqual(last(remote).sleepAt, null, 'hẹn giờ tự xoá sau khi chạy');
  assert.ok(last(remote).queue.length > 0, 'chỉ tạm dừng, KHÔNG được xoá hàng chờ');
  assert.ok(remote.msgs.some((m) => m.type === 'toast' && /Hết giờ hẹn/.test(m.text)));
  ok('tới giờ hẹn thì dừng phát thật, giữ nguyên hàng chờ');

  // volume + seek đi tới player
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'volume', value: 33 }));
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'seek', to: 42 }));
  await wait();
  assert.strictEqual(last(player).volume, 33);
  assert.ok(player.msgs.some((m) => m.type === 'cmd' && m.cmd === 'seek' && m.to === 42), 'player nhận lệnh seek');
  ok('volume + seek truyền tới player');

  // progress từ player -> remote nhận tick
  player.send(JSON.stringify({ type: 'progress', position: 55, duration: 180 }));
  await wait();
  assert.ok(remote.msgs.some((m) => m.type === 'tick' && m.position === 55), 'remote nhận tick');
  ok('player báo tiến độ, remote nhận tick');

  // xoá bài đang phát
  const uid = last(remote).queue[last(remote).index].uid;
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'remove', uid }));
  await wait();
  assert.strictEqual(last(remote).queue.length, 1);
  assert.ok(last(remote).queue.every((t) => t.uid !== uid));
  ok('xoá bài đang phát, hàng chờ tự nhảy sang bài còn lại');

  // video lỗi -> tự bỏ qua
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'add', item: track('ccccccccccc', 'Bài 3') }));
  await wait();
  player.send(JSON.stringify({ type: 'error', code: 101 }));
  await wait();
  assert.ok(remote.msgs.some((m) => m.type === 'toast'), 'remote được báo lỗi');
  ok('video lỗi => báo remote và tự chuyển bài');

  // ĐIỀU KIỆN CỐT LÕI: player đóng => nhạc dừng
  remote.send(JSON.stringify({ type: 'cmd', cmd: 'play' }));
  await wait();
  assert.strictEqual(last(remote).playing, true);
  player.close();
  await wait(300);
  assert.strictEqual(last(remote).players, 0);
  assert.strictEqual(last(remote).playing, false, 'không có máy phát thì không phát');
  ok('đóng trang /player => server tự dừng phát (đúng yêu cầu Volumio-style)');

  remote.close();
  await wait(100);
  console.log(`\n${pass}/${pass} bài kiểm thử PASS\n`);
  server.close();
  process.exit(0);
})().catch((e) => { console.error('\n✗ FAIL:', e.message); process.exit(1); });
