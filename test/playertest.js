/**
 * Kiểm thử trang /player với một YouTube IFrame API GIẢ.
 *
 * Lỗi thật đã gặp: chọn bài xong thì trang phát hiện màn "Bật loa — trình duyệt
 * đang chặn tự phát" che kín màn hình, dù người dùng đã bấm Bật loa từ trước.
 * Nguyên nhân: cứ bài đứng yên 10 giây (mạng chậm, YouTube nạp hụt) là bị coi
 * là "bị chặn tiếng", không phân biệt gì.
 *
 * Máy kiểm thử không vào được YouTube, nên thay iframe_api bằng bản giả điều
 * khiển được: cho bài "kẹt" (vị trí không nhích) hoặc chạy bình thường.
 *
 * Chạy: node test/playertest.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jukebox-player-'));
process.env.PORT = String(3800 + Math.floor(Math.random() * 400));
process.env.HOST = '127.0.0.1';

const { chromium } = require('playwright');
const WebSocket = require('ws');
const { server } = require('../server.js');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// YT giả. window.__yt điều khiển hành vi từ bài kiểm thử:
//   stuck=true      -> gọi phát nhưng vị trí đứng yên (như bị kẹt)
//   recoverOnRetry  -> kẹt ở lần phát đầu, gọi playVideo() lần nữa thì chạy
const FAKE_YT = `
window.__yt = { stuck: false, recoverOnRetry: false, plays: 0, loads: [] };
window.YT = { PlayerState: { UNSTARTED:-1, ENDED:0, PLAYING:1, PAUSED:2, BUFFERING:3, CUED:5 } };
window.YT.Player = function (id, opts) {
  const self = this;
  let t = 0, st = -1, timer = null;
  const run = () => {
    clearInterval(timer);
    const y = window.__yt;
    if (y.stuck && !(y.recoverOnRetry && y.plays >= 2)) { st = -1; return; }
    st = 1;
    opts.events.onStateChange && opts.events.onStateChange({ data: 1 });
    timer = setInterval(() => { t += 1; }, 1000);
  };
  this.loadVideoById = (v) => { window.__yt.loads.push(v); t = 0; window.__yt.plays++; run(); };
  this.cueVideoById = (v) => { window.__yt.loads.push(v); t = 0; st = 5; };
  this.playVideo = () => { window.__yt.plays++; run(); };
  this.pauseVideo = () => { clearInterval(timer); st = 2; };
  this.stopVideo = () => { clearInterval(timer); st = -1; };
  this.seekTo = (s) => { t = s; };
  this.setVolume = () => {};
  this.getCurrentTime = () => t;
  this.getDuration = () => 200;
  this.getPlayerState = () => st;
  setTimeout(() => opts.events.onReady && opts.events.onReady(), 50);
};
// Như API thật: báo sẵn sàng SAU khi trang đã chạy xong script của nó (hàm
// onYouTubeIframeAPIReady được khai báo ở script đứng sau thẻ nạp API).
window.addEventListener('DOMContentLoaded', () =>
  window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady());
`;

function remote() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.PORT}/ws`);
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', role: 'remote' })); resolve(ws); });
  });
}
const cmd = (ws, c, extra = {}) => ws.send(JSON.stringify({ type: 'cmd', cmd: c, ...extra }));
const state = async () => (await fetch(BASE + '/api/state')).json();
const T = (id, n) => ({ id, title: 'Bài ' + n, author: 'CS', duration: 200, thumb: '' });

(async () => {
  console.log('\n== Kiểm thử trang phát (YouTube giả) ==\n');
  await new Promise((r) => server.listening ? r() : server.once('listening', r));
  // Giống uitest.js: ưu tiên Chromium có sẵn trên máy nếu bản đi kèm
  // playwright không khớp phiên bản.
  const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';
  const launchOpts = { args: ['--no-sandbox'] };
  if (fs.existsSync(CHROME)) launchOpts.executablePath = CHROME;
  const browser = await chromium.launch(launchOpts);
  let code = 0;
  try {
    const ctx = await browser.newContext();
    // Playwright xét route theo thứ tự NGƯỢC với lúc đăng ký (đăng ký sau thắng),
    // nên chặn-tất-cả phải đăng ký TRƯỚC, bản YT giả đăng ký sau.
    await ctx.route('https://**', (r) => r.abort());   // không gọi ra ngoài
    await ctx.route('**/iframe_api*', (r) =>
      r.fulfill({ contentType: 'text/javascript', body: FAKE_YT }));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(BASE + '/player', { waitUntil: 'domcontentloaded' });
    await sleep(500);

    // Người dùng bấm "Bật loa" một lần — đúng như trên Pi.
    if (await page.locator('#gate').isVisible()) await page.click('#startBtn');
    await sleep(200);
    assert.strictEqual(await page.locator('#gate').isVisible(), false);

    const r = await remote();
    await sleep(100);

    // ---- 1. Bài chạy bình thường: không bao giờ hiện màn Bật loa
    cmd(r, 'add', { items: [T('dQw4w9WgXcQ', 1), T('kJQP7kiw5Fk', 2), T('9bZkp7q19f0', 3), T('OPf0YbXqDm0', 4)], playNow: true });
    await sleep(3000);
    assert.strictEqual(await page.locator('#gate').isVisible(), false);
    assert.ok((await state()).position >= 1, 'bài phải chạy, vị trí phải nhích');
    ok('chọn bài chạy bình thường: không hiện màn "Bật loa"');

    // ---- 2. Kẹt một nhịp rồi chạy khi gọi phát lại: tự gỡ, không làm phiền
    await page.evaluate(() => { window.__yt.stuck = true; window.__yt.recoverOnRetry = true; window.__yt.plays = 0; });
    cmd(r, 'next');
    await sleep(9000);
    assert.strictEqual(await page.locator('#gate').isVisible(), false,
      'kẹt một nhịp thì phải tự phát lại, không được đòi bấm Bật loa');
    assert.ok(await page.evaluate(() => window.__yt.plays >= 2), 'phải thử phát lại');
    const s2 = await state();
    assert.strictEqual(s2.current.title, 'Bài 2', 'phát lại được thì giữ nguyên bài');
    ok('bài kẹt một nhịp (mạng chậm): tự phát lại, không hiện màn "Bật loa"');

    // ---- 3. Kẹt hẳn (đã bấm Bật loa từ trước): bỏ qua bài, KHÔNG che màn hình
    await page.evaluate(() => { window.__yt.stuck = true; window.__yt.recoverOnRetry = false; });
    cmd(r, 'next');   // sang Bài 3, sẽ kẹt hẳn
    await sleep(17500);
    assert.strictEqual(await page.locator('#gate').isVisible(), false,
      'đã bấm Bật loa rồi thì kẹt là lỗi của bài, không được đòi bấm lại');
    const s3 = await state();
    assert.strictEqual(s3.current && s3.current.title, 'Bài 4',
      'bài kẹt hẳn phải bị bỏ qua, sang bài kế tiếp');
    ok('bài kẹt hẳn: tự bỏ qua sang bài khác, không che màn hình');

    assert.deepStrictEqual(errs, [], 'trang phát không được có lỗi JS');
    ok('không có lỗi JS trên trang phát');

    // Đóng máy phát thứ nhất: nó cũng đang kẹt và sẽ tự bỏ bài, làm nhiễu
    // bài kiểm thử dưới đây.
    await ctx.close();
    await sleep(300);

    // ---- 4. Trang CHƯA từng được bấm và trình duyệt chặn: vẫn phải hiện màn
    // Bật loa — đây mới là lúc nó có ích.
    const ctx2 = await browser.newContext();
    await ctx2.route('https://**', (rt) => rt.abort());
    await ctx2.route('**/iframe_api*', (rt) =>
      rt.fulfill({ contentType: 'text/javascript', body: FAKE_YT.replace('stuck: false', 'stuck: true') }));
    const p2 = await ctx2.newPage();
    // Giả lập trình duyệt KHÔNG cho tự phát nhưng trang tưởng đã mở khoá.
    await p2.addInitScript(() => {
      navigator.getAutoplayPolicy = () => 'disallowed';
      Object.defineProperty(navigator, 'userActivation',
        { value: { hasBeenActive: false, isActive: false } });
    });
    await p2.goto(BASE + '/player', { waitUntil: 'domcontentloaded' });
    await sleep(400);
    // Mở khoá "tự động" như khi trình duyệt báo sai, để watchdog phải bắt lỗi.
    await p2.evaluate(() => unlock(true));
    cmd(r, 'jump', { uid: (await state()).queue[0].uid });
    // 15 giây của watchdog + vài nhịp 1 giây để nó bắt đầu đếm.
    await sleep(20000);
    assert.strictEqual(await p2.locator('#gate').isVisible(), true,
      'chưa bấm lần nào và bị chặn thật thì phải hiện màn Bật loa');
    ok('bị chặn thật (chưa bấm lần nào): vẫn hiện màn "Bật loa" để bấm');

    // ---- 5. Mở trang phát THỨ HAI (lỗi thật: kiosk mở chồng cả dãy tab, tab
    // nào cũng phát): chỉ trang mới nhất được phát, trang cũ im và đứng yên.
    const p3 = await ctx2.newPage();
    await p3.goto(BASE + '/player', { waitUntil: 'domcontentloaded' });
    await sleep(800);
    assert.strictEqual(await p2.locator('#standby').isVisible(), true,
      'trang phát cũ phải chuyển sang chờ khi có trang phát mới');
    assert.strictEqual((await state()).players, 1, 'chỉ được tính MỘT máy phát');
    ok('mở trang phát thứ hai: trang cũ tự im, chỉ còn một máy phát');

    // Trang cũ KHÔNG được tự nối lại để giành quyền (sẽ giành qua giành lại mãi).
    await sleep(4500);
    assert.strictEqual(await p3.locator('#standby').isVisible(), false,
      'trang mới không được bị trang cũ giành lại');
    assert.strictEqual((await state()).players, 1);
    ok('trang cũ không tự nối lại giành quyền phát');

    // Chủ động bấm "Phát ở đây" thì lấy lại được.
    await p2.click('#takeBtn');
    await sleep(800);
    assert.strictEqual(await p2.locator('#standby').isVisible(), false);
    assert.strictEqual(await p3.locator('#standby').isVisible(), true);
    assert.strictEqual((await state()).players, 1);
    ok('bấm "Phát ở đây" => giành lại quyền phát, trang kia chuyển sang chờ');

    r.close();
  } catch (e) {
    console.error('\n✗ FAIL:', e.message);
    code = 1;
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
  if (!code) console.log(`\n${pass}/${pass} bài kiểm thử trang phát PASS\n`);
  process.exit(code);
})();
