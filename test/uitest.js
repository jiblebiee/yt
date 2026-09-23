/**
 * Kiểm thử giao diện bằng trình duyệt thật (Playwright + Chromium).
 * Chạy: node test/uitest.js
 *
 * Không cần internet: chỉ kiểm tra trang render đúng, chuyển tab được, không
 * có lỗi JS, và các trạng thái "chưa đăng nhập" hiện đúng thông điệp.
 */
process.env.PORT = process.env.PORT || '3998';
// Bài test có ghi lịch sử nghe. Đẩy sang thư mục tạm để không đụng vào
// data/ thật của máy đang chạy.
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR =
    require('path').join(require('os').tmpdir(), 'jukebox-uitest-data');
  // Xoá sạch trước mỗi lần chạy: lịch sử tồn dư từ lần trước làm số lần
  // nghe cộng dồn, và bài kiểm tra thứ hạng sẽ sai một cách khó hiểu.
  require('fs').rmSync(process.env.DATA_DIR, { recursive: true, force: true });
}
const assert = require('assert');
const { chromium } = require('playwright');
const { server } = require('../server.js');

const PORT = process.env.PORT;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

(async () => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));

  // Dùng Chromium có sẵn trong máy nếu bản playwright cài kèm không khớp build.
  const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';
  const launchOpts = { args: ['--no-sandbox'] };
  if (require('fs').existsSync(CHROME)) launchOpts.executablePath = CHROME;
  const browser = await chromium.launch(launchOpts);
  // Khổ điện thoại: đây là thiết bị chính. Bố cục hai cột của máy tính bảng
  // được kiểm riêng ở cuối file với khổ rộng.
  const page = await browser.newPage({ viewport: { width: 412, height: 900 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    // Bỏ qua lỗi mạng tới youtube (container kiểm thử bị chặn ra ngoài), và
    // các mã lỗi HTTP mà chính bài test bên dưới cố tình tạo ra: 502 của lượt
    // tìm kiếm hỏng, 400 của cookie thiếu SAPISID.
    const deliberate = /youtube|ytimg|net::ERR|502|400/i;
    if (m.type() === 'error' && !deliberate.test(m.text())) {
      errors.push('console: ' + m.text() + ' @ ' + (m.location()?.url || ''));
    }
  });

  // ---------------------------------------------------------- trang remote
  await page.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);

  assert.deepStrictEqual(
    await page.locator('.tab').evaluateAll((els) => els.map((e) => e.textContent.trim())),
    ['Hàng chờ', 'Tìm kiếm', 'Home', 'Album', 'Của tôi']);
  ok('trang remote có đủ 5 tab, đúng thứ tự');

  // Chưa có máy phát -> phải hiện cảnh báo
  await page.waitForSelector('#noPlayer:visible', { timeout: 4000 });
  ok('hiện cảnh báo khi chưa có máy phát nào online');

  // BUILD khớp -> không được hiện cảnh báo "server chạy mã cũ"
  assert.strictEqual(await page.locator('#staleBuild').isVisible(), false);
  ok('BUILD khớp thì không có cảnh báo lệch phiên bản');

  // Lệch phiên bản có HAI chiều và cách sửa khác hẳn nhau.
  // Chiều 1: server cũ hơn trang -> phải bảo restart service.
  const fakeHealth = (build) => (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, build }) });

  await page.route('**/healthz', fakeHealth('2020-01-01.1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#staleBuild:visible', { timeout: 4000 });
  assert.match(await page.locator('#staleBuild').innerText(), /systemctl restart yt-jukebox/);
  assert.strictEqual(await page.locator('#hardReload').count(), 0,
    'server cũ thì tải lại trang vô ích, không được bày nút đó');
  ok('server chạy mã cũ => hiện cảnh báo kèm đúng lệnh restart');
  await page.unroute('**/healthz');

  // Chiều 2: server MỚI hơn trang -> thủ phạm là cache trình duyệt, bảo
  // restart service là chỉ sai chỗ.
  await page.route('**/healthz', fakeHealth('2099-12-31.9'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#staleBuild:visible', { timeout: 4000 });
  const staleTxt = await page.locator('#staleBuild').innerText();
  assert.match(staleTxt, /cache/i, 'phải nói rõ là do cache trình duyệt');
  assert.doesNotMatch(staleTxt, /systemctl restart/,
    'không được bảo restart service khi lỗi nằm ở trình duyệt');
  assert.strictEqual(await page.locator('#hardReload').count(), 1,
    'phải có nút tải lại bản mới');
  ok('trang bị cache cũ => báo đúng thủ phạm và cho nút tải lại');
  await page.unroute('**/healthz');

  // HTML phải được gửi kèm no-cache, nếu không thì đúng cảnh trên sẽ tái diễn.
  const htmlRes = await page.request.get(BASE + '/remote');
  assert.match(htmlRes.headers()['cache-control'] || '', /no-cache/,
    'trang HTML phải có Cache-Control: no-cache');
  const iconRes = await page.request.get(BASE + '/icon-192.png');
  assert.doesNotMatch(iconRes.headers()['cache-control'] || '', /no-cache/,
    'icon thì vẫn nên cho cache');
  ok('HTML gửi kèm no-cache, icon vẫn được cache');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);

  // Chuyển từng tab, pane tương ứng phải hiện
  for (const [tab, pane] of [
    ['results', '#paneResults'],
    ['home', '#paneHome'],
    ['me', '#paneMe'],
    ['queue', '#paneQueue'],
  ]) {
    await page.click(`.tab[data-tab="${tab}"]`);
    await page.waitForTimeout(150);
    assert.ok(await page.locator(pane).isVisible(), `${pane} phải hiện`);
    assert.strictEqual(
      await page.locator(`.tab[data-tab="${tab}"].active`).count(), 1,
      'tab đang chọn phải có class active'
    );
  }
  ok('chuyển qua lại 4 tab, đúng pane hiện đúng lúc');

  // Tab "Của tôi": chỉ còn MỘT cách đăng nhập là YouTube Data API.
  await page.click('.tab[data-tab="me"]');
  await page.waitForSelector('#gapiId', { timeout: 4000 });
  ok('tab Của tôi hiện form Client ID của Data API');

  // Hai cách đăng nhập cũ (mã TV + cookie) phải biến mất hoàn toàn.
  for (const sel of ['#loginBtn', '#cookieToggle', '#cookieInput', '#profiles']) {
    assert.strictEqual(await page.locator(sel).count(), 0, `${sel} lẽ ra đã bị gỡ`);
  }
  ok('đã gỡ sạch đăng nhập mã TV và đăng nhập bằng cookie');

  // Client ID dán nhầm (API key / secret) phải bị chặn ngay ở server,
  // trước khi gọi Google lần nào.
  await page.fill('#gapiId', 'AIzaSyDAY-LA-API-KEY-KHONG-PHAI-CLIENT-ID');
  await page.click('#gapiSave');
  await page.waitForSelector('#toast.show', { timeout: 4000 });
  assert.match(await page.locator('#toast').innerText(), /apps\.googleusercontent\.com/);
  ok('Client ID sai định dạng bị chặn kèm chỉ dẫn đúng đuôi cần có');

  // Chưa cấu hình Client ID thì không được bày nút đăng nhập Google
  assert.strictEqual(await page.locator('#gapiLogin').count(), 0);
  ok('chưa có Client ID thì chưa hiện nút đăng nhập Google');

  // Tab Thịnh hành: danh sách thể loại là dữ liệu tĩnh của server nên PHẢI
  // hiện được kể cả khi không ra được YouTube.
  assert.strictEqual(await page.locator('#tabHomeLabel').innerText(), 'Home');
  await page.click('.tab[data-tab="home"]');
  await page.waitForSelector('#homeChips [data-genre]', { timeout: 4000 });
  const chips = await page.locator('#homeChips [data-genre]').allInnerTexts();
  assert.ok(chips.length >= 8, `phải có >=8 thể loại, đang có ${chips.length}`);
  assert.ok(chips.some((c) => /Bolero/i.test(c)), 'phải có đài Bolero · Nhạc vàng');
  assert.strictEqual(await page.locator('#homeChips .chip.on').count(), 1,
    'luôn có đúng một thể loại đang được chọn');
  ok(`tab Thịnh hành hiện ${chips.length} đài thể loại, có sẵn một cái được chọn`);

  // Nút bật đài phải có mặt và nói đúng việc nó làm.
  await page.waitForSelector('#stationBtn', { timeout: 4000 });
  assert.match(await page.locator('#stationBtn').innerText(), /Bật nghe liên tục/);
  assert.doesNotMatch(await page.locator('#stationBar').innerText(), /đài/i,
    'đã bỏ hẳn chữ "đài" khỏi giao diện');
  ok('có nút "Bật nghe liên tục" cho thể loại đang xem');

  // Đổi thể loại thì chip active phải đổi theo.
  const second = page.locator('#homeChips [data-genre]').nth(1);
  const secondName = (await second.innerText()).trim();
  await second.click();
  await page.waitForTimeout(400);
  assert.strictEqual((await page.locator('#homeChips .chip.on').innerText()).trim(), secondName);
  assert.match(await page.locator('#stationBtn').innerText(), /Bật nghe liên tục/);
  ok('bấm chip khác thì đổi thể loại đang xem, nút vẫn đúng');

  // Hẹn giờ dừng: ba mốc phải có mặt ngay trong tab Hàng chờ.
  await page.click('.tab[data-tab="queue"]');
  await page.waitForSelector('#sleepChips [data-sleep]', { timeout: 4000 });
  const sleeps = await page.locator('#sleepChips [data-sleep]').allInnerTexts();
  assert.deepStrictEqual(sleeps, ['30 phút', '1 tiếng', '2 tiếng']);
  assert.strictEqual((await page.locator('#sleepLeft').innerText()).trim(), '',
    'chưa hẹn giờ thì không hiện đếm ngược');
  ok('có đủ 3 mốc hẹn giờ 30 phút / 1 tiếng / 2 tiếng');

  await page.click('#sleepChips [data-sleep="30"]');
  await page.waitForFunction(
    () => /còn \d+:\d\d/.test(document.getElementById('sleepLeft').textContent),
    { timeout: 4000 });
  assert.match(await page.locator('#sleepLeft').innerText(), /còn (29|30):\d\d/);
  assert.strictEqual(await page.locator('#sleepChips [data-sleep="0"]').count(), 1,
    'đang hẹn giờ thì phải có nút huỷ');
  ok('bấm 30 phút => hiện đếm ngược và nút huỷ');

  await page.click('#sleepChips [data-sleep="0"]');
  await page.waitForTimeout(400);
  assert.strictEqual((await page.locator('#sleepLeft').innerText()).trim(), '');
  ok('huỷ hẹn giờ thì đếm ngược biến mất');

  // Âm lượng: thanh trượt phải NẰM TRONG popup, chỉ hiện khi bấm icon loa.
  assert.ok(await page.locator('#volPop').isHidden(), 'popup âm lượng phải ẩn lúc đầu');
  await page.click('#bVol');
  await page.waitForSelector('#volPop', { state: 'visible', timeout: 3000 });
  const volBox = await page.locator('#volPop input[type=range]').boundingBox();
  assert.ok(volBox.height >= 32,
    `vùng chạm thanh âm lượng phải đủ to cho ngón tay, đang là ${volBox.height}px`);
  ok('bấm icon loa => hiện popup, thanh trượt đủ to để chạm');

  // Nút −/+ phải đổi âm lượng THẬT trên server, không chỉ đổi số hiển thị.
  const volBefore = Number(await page.locator('#vol').inputValue());
  await page.click('#volDown');
  await page.waitForFunction(
    (v) => Number(document.getElementById('vol').value) === v - 5,
    volBefore, { timeout: 3000 });
  const stAfter = await (await page.request.get(BASE + '/api/state')).json();
  assert.strictEqual(stAfter.volume, volBefore - 5,
    'server phải nhận đúng mức âm lượng mới');
  assert.strictEqual((await page.locator('#volVal').innerText()).trim(), String(volBefore - 5));
  ok('nút − giảm 5 nấc và server nhận đúng giá trị');

  await page.click('#volUp');
  await page.waitForFunction(
    (v) => Number(document.getElementById('vol').value) === v,
    volBefore, { timeout: 3000 });
  ok('nút ＋ tăng lại đúng mức cũ');

  // Chạm ra ngoài thì popup đóng, không che mất hàng chờ.
  await page.mouse.click(10, 200);
  await page.waitForSelector('#volPop', { state: 'hidden', timeout: 3000 });
  // Chú thích "đang chỉnh cái gì" phải nằm TRONG popup — trước đây nó lọt ra
  // ngoài và nằm chình ình dưới thanh điều khiển suốt.
  await page.click('#bVol');
  await page.waitForSelector('#volPop', { state: 'visible', timeout: 3000 });
  const noteBox = await page.locator('#volNote').boundingBox();
  const popBox = await page.locator('#volPop').boundingBox();
  assert.ok(noteBox.y >= popBox.y && noteBox.y + noteBox.height <= popBox.y + popBox.height + 1,
    'chú thích âm lượng phải nằm gọn trong popup');
  assert.match(await page.locator('#volNote').innerText(), /trình phát|Loa máy chủ/,
    'phải nói rõ thanh này đang chỉnh cái gì');
  await page.mouse.click(10, 200);
  await page.waitForSelector('#volPop', { state: 'hidden', timeout: 3000 });
  assert.strictEqual(await page.locator('#volNote').isVisible(), false,
    'đóng popup thì chú thích cũng phải biến mất');
  ok('chú thích âm lượng nằm trong popup và nói rõ đang chỉnh loa nào');

  // Nháy đúp không được phóng to màn hình — bấm nhanh hai bài liên tiếp là
  // dính ngay. touch-action:manipulation bỏ đúng cử chỉ đó mà vẫn giữ
  // chụm-hai-ngón, nên người cần phóng to để đọc vẫn làm được.
  const ta = await page.evaluate(() =>
    getComputedStyle(document.documentElement).touchAction);
  assert.strictEqual(ta, 'manipulation');
  const viewport = await page.evaluate(() =>
    document.querySelector('meta[name=viewport]').content);
  assert.doesNotMatch(viewport, /user-scalable\s*=\s*no/,
    'không được chặn chụm-hai-ngón: iOS bỏ qua nó, mà nó chặn cả người cần phóng to thật');
  ok('nháy đúp không phóng to, nhưng chụm hai ngón vẫn phóng được');

  ok('chạm ra ngoài => popup âm lượng tự đóng');

  // Manifest cho PWA phải phục vụ được, nếu không thì không cài lên
  // màn hình chính điện thoại được.
  const mf = await page.request.get(BASE + '/manifest.webmanifest');
  assert.strictEqual(mf.status(), 200);
  const mfj = await mf.json();
  assert.strictEqual(mfj.start_url, '/remote');
  assert.strictEqual(mfj.display, 'standalone');
  assert.ok(mfj.icons.length >= 2);
  for (const ic of mfj.icons) {
    const r = await page.request.get(BASE + ic.src);
    assert.strictEqual(r.status(), 200, `icon ${ic.src} phải tải được`);
  }
  ok('manifest PWA hợp lệ và mọi icon đều tải được');

  // Hàng chờ trống
  await page.click('.tab[data-tab="queue"]');
  assert.match(await page.locator('#queue').innerText(), /trống/i);
  ok('hàng chờ trống hiện đúng thông điệp');

  // Tìm kiếm hỏng (không có mạng) phải hiện lỗi gọn, không làm vỡ trang
  await page.fill('#q', 'nhạc chill');
  await page.click('#searchBtn');
  await page.waitForTimeout(2500);
  const resultsText = await page.locator('#results').innerText();
  assert.ok(resultsText.length > 0, 'khu vực kết quả phải có nội dung');
  ok('tìm kiếm thất bại vẫn hiện lỗi gọn gàng, không vỡ trang');

  await page.screenshot({ path: '/tmp/remote.png', fullPage: true });

  // ---------------------------------------------------------- trang player
  const p2 = await browser.newPage();
  p2.on('pageerror', (e) => errors.push('player pageerror: ' + e.message));
  await p2.goto(BASE + '/player', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(600);
  assert.ok(await p2.locator('#gate').isVisible(), 'phải hiện màn hình "Bật loa"');
  assert.match(await p2.locator('#gateHint').innerText(), /\/remote$/);
  ok('trang player hiện cổng "Bật loa" và địa chỉ trang điều khiển');
  await p2.screenshot({ path: '/tmp/player.png' });

  // Máy phát kết nối -> cảnh báo bên remote phải biến mất
  await page.waitForTimeout(600);
  assert.strictEqual(await page.locator('#noPlayer').isVisible(), false);
  ok('mở trang player => cảnh báo "chưa có máy phát" tự tắt bên remote');

  assert.deepStrictEqual(errors, [], 'không được có lỗi JS nào');
  ok('không có lỗi JavaScript trên cả hai trang');

  await browser.close();

  // ------------------------------------------- cổng "Bật loa" tự mở hay không
  // Đây là điểm mấu chốt của chế độ kiosk: chạy Chromium với cờ cho phép tự
  // phát thì trang phải bỏ qua bước bấm tay, còn khi bị chặn thì phải hiện.
  async function gateVisibleWith(policyFlag) {
    const b = await chromium.launch({
      ...launchOpts,
      args: [...(launchOpts.args || []), `--autoplay-policy=${policyFlag}`],
    });
    const p = await b.newPage();
    await p.goto(BASE + '/player', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1200);
    const visible = await p.locator('#gate').isVisible();
    const policy = await p.evaluate(() =>
      typeof navigator.getAutoplayPolicy === 'function'
        ? navigator.getAutoplayPolicy('mediaelement') : 'không có API');
    await b.close();
    return { visible, policy };
  }

  const blocked = await gateVisibleWith('document-user-activation-required');
  assert.strictEqual(blocked.visible, true,
    `trình duyệt chặn tự phát (policy=${blocked.policy}) thì phải hiện cổng Bật loa`);
  ok(`bị chặn tự phát (policy=${blocked.policy}) => vẫn hiện cổng "Bật loa"`);

  const allowed = await gateVisibleWith('no-user-gesture-required');
  assert.strictEqual(allowed.visible, false,
    `cờ kiosk cho tự phát (policy=${allowed.policy}) thì phải tự bỏ qua cổng`);
  ok(`cờ kiosk --autoplay-policy=no-user-gesture-required (policy=${allowed.policy}) => tự bỏ qua cổng`);

  // -------------------------------------------------- lưới + "hay nghe"
  // Đổ sẵn vài lượt nghe vào lịch sử để có dữ liệu thật mà kiểm.
  const srv = require('../server.js');
  srv.notePlay({ id: 'v1', title: 'Bài nghe nhiều', author: 'Ca sĩ A', duration: 200 });
  srv.notePlay({ id: 'v1', title: 'Bài nghe nhiều', author: 'Ca sĩ A', duration: 200 });
  srv.notePlay({ id: 'v2', title: 'Bài nghe ít', author: 'Ca sĩ B', duration: 180 });

  // browser ở trên đã đóng sau nhóm kiểm thử tự-phát, nên mở trình duyệt mới.
  const b2 = await chromium.launch(launchOpts);
  const grid = await b2.newPage({ viewport: { width: 412, height: 900 } });
  await grid.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await grid.waitForTimeout(500);

  const topRes = await grid.request.get(BASE + '/api/top?limit=5');
  assert.strictEqual(topRes.status(), 200);
  const topJson = await topRes.json();
  assert.strictEqual(topJson.items[0].id, 'v1', 'bài nghe nhiều nhất phải đứng đầu');
  assert.strictEqual(topJson.items[0].count, 2);
  ok('/api/top xếp đúng theo số lần nghe');

  await grid.click('.tab[data-tab="home"]');
  await grid.waitForSelector('#topBox .card', { timeout: 4000 });
  assert.strictEqual(await grid.locator('#topBox').isVisible(), true);
  assert.match(await grid.locator('#topBox .card').first().innerText(), /Bài nghe nhiều/);
  assert.match(await grid.locator('#topBox .card').first().innerText(), /2 lần/);
  ok('tab Thịnh hành hiện mục "Hay nghe" kèm số lần nghe');

  // Lưới thumbnail: thẻ phải đủ to để bấm bằng ngón tay, và ảnh phải 16:9.
  const cardBox = await grid.locator('#topBox .card').first().boundingBox();
  assert.ok(cardBox.width >= 130, `thẻ bài quá hẹp: ${cardBox.width}px`);
  const thumbBox = await grid.locator('#topBox .card .thumb').first().boundingBox();
  const ratio = thumbBox.width / thumbBox.height;
  assert.ok(ratio > 1.6 && ratio < 1.9, `ảnh phải xấp xỉ 16:9, đang là ${ratio.toFixed(2)}`);
  ok('kết quả hiện dạng lưới thumbnail 16:9, thẻ đủ to để chạm');

  // Bấm vào thẻ = phát ngay; bấm nút ＋ trên ảnh = chỉ thêm vào hàng chờ.
  await grid.click('#topBox .card .addbtn');
  await grid.waitForTimeout(400);
  let stNow = await (await grid.request.get(BASE + '/api/state')).json();
  assert.strictEqual(stNow.queue.length, 1, 'nút ＋ phải thêm đúng 1 bài');
  assert.strictEqual(stNow.queue[0].id, 'v1');
  ok('nút ＋ trên thumbnail thêm bài vào hàng chờ');

  // Nút Mix trên thẻ: phát bài đó ngay, nối bài liên quan, bật auto-radio.
  await grid.click('#topBox .card .mixbtn');
  await grid.waitForTimeout(800);
  const stMix = await (await grid.request.get(BASE + '/api/state')).json();
  assert.strictEqual(stMix.autoRadio, true, 'Mix phải bật tự nối bài');
  assert.strictEqual(stMix.station, null, 'Mix bám theo bài, phải tắt đài thể loại');
  assert.strictEqual(stMix.current.id, 'v1', 'Mix phải phát ngay bài được bấm');
  ok('nút Mix trên thẻ: phát ngay + bật tự nối bài liên quan');

  // Nút ✕ xoá nhanh ô tìm kiếm.
  assert.strictEqual(await grid.locator('#qClear').isVisible(), false,
    'ô trống thì không bày nút xoá');
  await grid.fill('#q', 'nhạc trẻ');
  await grid.waitForTimeout(150);
  assert.strictEqual(await grid.locator('#qClear').isVisible(), true);
  await grid.click('#qClear');
  await grid.waitForTimeout(150);
  assert.strictEqual(await grid.inputValue('#q'), '');
  assert.strictEqual(await grid.locator('#qClear').isVisible(), false);
  assert.strictEqual(await grid.evaluate(() => document.activeElement.id), 'q',
    'xoá xong con trỏ phải ở lại trong ô để gõ tiếp');
  ok('nút ✕ xoá ô tìm kiếm, chỉ hiện khi có chữ, xoá xong vẫn giữ con trỏ');

  // --------------------------------------------- gạt bài gợi ý không thích
  // Container kiểm thử không ra được YouTube, nên giả lập /api/genre để chạy
  // trọn vẹn thao tác trên giao diện thật.
  const fakeItems = Array.from({ length: 26 }, (_, i) => ({
    id: 'g' + i, title: 'Bài thể loại ' + i, author: 'Ca sĩ ' + i,
    duration: 200 + i, thumb: '/icon-192.png',
  }));
  await grid.route('**/api/genre/**', (route) =>
    route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ items: fakeItems }) }));
  const hideCalls = [];
  await grid.route('**/api/hide', (route) => {
    hideCalls.push(JSON.parse(route.request().postData() || '{}'));
    route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });

  await grid.click('.tab[data-tab="home"]');
  await grid.waitForSelector('#homeChips [data-genre]', { timeout: 5000 });
  // Bấm chip để buộc nạp lại — lần mở tab trước đó đã lỗi vì không ra được mạng.
  await grid.click('#homeChips [data-genre]');
  await grid.waitForSelector('#home .card', { timeout: 5000 });
  const shown = await grid.locator('#home .card').count();
  assert.strictEqual(shown, 20, `hiện 20 thẻ, để dành phần dư mà thế chỗ (đang ${shown})`);

  // Nút làm mới phải đủ to để bấm bằng ngón tay.
  const refreshBox = await grid.locator('#homeRefresh').boundingBox();
  assert.ok(refreshBox.height >= 44 && refreshBox.width >= 44,
    `nút làm mới quá nhỏ: ${refreshBox.width}×${refreshBox.height}`);
  assert.strictEqual((await grid.locator('#homeRefresh').innerText()).trim(), '⟳',
    'chỉ cần icon, không kèm chữ');
  ok(`tab Home hiện ${shown} thẻ gợi ý, nút ⟳ ${refreshBox.width}×${refreshBox.height}px đủ to để chạm`);

  const firstTitle = await grid.locator('#home .card .t').first().innerText();
  await grid.click('#home .card .hidebtn');
  await grid.waitForTimeout(400);

  assert.strictEqual(await grid.locator('#home .card').count(), 20,
    'gạt một bài thì phải có bài khác đôn vào, số thẻ giữ nguyên');
  const newFirst = await grid.locator('#home .card .t').first().innerText();
  assert.notStrictEqual(newFirst, firstTitle, 'bài vừa gạt phải biến mất');
  assert.deepStrictEqual(hideCalls, [{ id: 'g0' }],
    'phải báo server đúng id vừa gạt để lần sau đừng gợi ý nữa');
  ok('bấm ✕ => bài biến mất, bài khác đôn vào, server ghi nhớ để không gợi lại');

  // LỖI ĐÃ GẶP THẬT: gạt nhiều bài quá thì mẻ mới trắng trơn, không hiện gì
  // và cũng không nói vì sao. Giờ phải nói đúng nguyên nhân + cho nút sửa.
  await grid.unroute('**/api/genre/**');
  await grid.route('**/api/genre/**', (route) =>
    route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ items: [], hiddenSkipped: 42, exhausted: true }) }));
  await grid.click('#homeChips [data-genre]:nth-child(2)');
  await grid.waitForSelector('#unhideAll', { timeout: 5000 });
  const emptyTxt = await grid.locator('#home').innerText();
  assert.match(emptyTxt, /đã gạt hết/i, 'phải nói rõ là do đã gạt hết, không im lặng');
  assert.match(emptyTxt, /42 bài đang ẩn/);
  ok('gạt hết bài => báo đúng nguyên nhân kèm nút "Bỏ ẩn tất cả"');

  // Bấm nút đó phải gọi đúng API và nạp lại danh sách.
  let unhideCalled = false;
  await grid.route('**/api/unhide-all', (route) => {
    unhideCalled = true;
    route.fulfill({ contentType: 'application/json', body: '{"ok":true,"removed":42}' });
  });
  await grid.unroute('**/api/genre/**');
  await grid.route('**/api/genre/**', (route) =>
    route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ items: fakeItems, hiddenSkipped: 0, exhausted: false }) }));
  await grid.click('#unhideAll');
  await grid.waitForSelector('#home .card', { timeout: 5000 });
  assert.strictEqual(unhideCalled, true, 'phải gọi /api/unhide-all');
  ok('bấm "Bỏ ẩn tất cả" => gọi đúng API và bài gợi ý hiện lại');

  await grid.unroute('**/api/genre/**');
  await grid.unroute('**/api/unhide-all');
  await grid.unroute('**/api/hide');

  // API ẩn/bỏ ẩn: kiểm thẳng, không qua giao diện.
  const hideRes = await grid.request.post(BASE + '/api/hide', { data: { id: 'zzz-test' } });
  assert.strictEqual(hideRes.status(), 200);
  const hiddenList = await (await grid.request.get(BASE + '/api/hidden')).json();
  assert.ok(hiddenList.ids.includes('zzz-test'));
  const badHide = await grid.request.post(BASE + '/api/hide', { data: {} });
  assert.strictEqual(badHide.status(), 400, 'thiếu id phải báo lỗi rõ ràng');
  await grid.request.post(BASE + '/api/unhide', { data: { id: 'zzz-test' } });
  const after = await (await grid.request.get(BASE + '/api/hidden')).json();
  assert.ok(!after.ids.includes('zzz-test'), 'bỏ ẩn phải gỡ khỏi danh sách');
  ok('/api/hide và /api/unhide hoạt động, thiếu id thì báo 400');

  // Bỏ ẩn hàng loạt: lối thoát khi gạt quá tay.
  await grid.request.post(BASE + '/api/hide', { data: { id: 'a1' } });
  await grid.request.post(BASE + '/api/hide', { data: { id: 'a2' } });
  const wipe = await (await grid.request.post(BASE + '/api/unhide-all')).json();
  assert.ok(wipe.removed >= 2);
  const none = await (await grid.request.get(BASE + '/api/hidden')).json();
  assert.deepStrictEqual(none.ids, [], 'bỏ ẩn tất cả thì danh sách phải sạch');
  ok('/api/unhide-all xoá sạch danh sách bài đã gạt');

  // /healthz phải báo cả tình trạng YouTube và âm thanh, để update.sh và
  // trang điều khiển đọc được mà không phải đoán.
  const hz = await (await grid.request.get(BASE + '/healthz')).json();
  assert.ok(hz.youtube && typeof hz.youtube.status === 'string');
  assert.ok(['idle', 'ok', 'degraded', 'down'].includes(hz.youtube.status));
  assert.ok(hz.audio && typeof hz.audio.mode === 'string');
  assert.ok(['system', 'player'].includes(hz.audio.mode));
  // Máy kiểm thử không có pactl -> phải nói RÕ vì sao, đừng để trống.
  if (hz.audio.mode === 'player') assert.ok(hz.audio.reason, 'phải kèm lý do');
  ok(`/healthz báo tình trạng YouTube (${hz.youtube.status}) và âm thanh (${hz.audio.mode})`);

  // ---------------------------------------------------- ghép mix 15 bài
  // Nguồn 'history' chạy được không cần mạng: hạt giống lấy từ lịch sử tại chỗ.
  const mixApi = await grid.request.get(BASE + '/api/mixes?source=history&count=5');
  assert.strictEqual(mixApi.status(), 200);
  const mixJson = await mixApi.json();
  assert.ok(mixJson.mixes.length >= 1, 'phải có ít nhất một mix');
  for (const m of mixJson.mixes) {
    assert.ok(m.items.length <= 15, 'mỗi mix tối đa 15 bài');
    assert.ok(m.label && m.thumb, 'mix phải có tên và ảnh đại diện');
  }
  // Các mix không được trùng bài nhau, nếu không chọn mix nào cũng như nhau.
  const allIds = mixJson.mixes.flatMap((m) => m.items.map((t) => t.id));
  assert.strictEqual(new Set(allIds).size, allIds.length,
    'các mix phải khác bài nhau');
  ok(`/api/mixes trả ${mixJson.mixes.length} mix riêng biệt, mỗi mix tối đa 15 bài`);

  // Ô từ khoá chỉ hiện khi chọn nguồn "Từ khoá tự gõ".
  assert.strictEqual(await grid.locator('#mixQ').isVisible(), false);
  await grid.click('#mixSrcChips [data-mixsrc="query"]');
  await grid.waitForTimeout(150);
  assert.strictEqual(await grid.locator('#mixQ').isVisible(), true);
  await grid.click('#mixSrcChips [data-mixsrc="history"]');
  await grid.waitForTimeout(150);
  assert.strictEqual(await grid.locator('#mixQ').isVisible(), false);
  assert.strictEqual(await grid.locator('#mixSrcChips .chip.on').count(), 1,
    'luôn đúng một nguồn được chọn');
  ok('chọn nguồn mix: ô từ khoá chỉ hiện đúng lúc');

  // TỰ hiện khi mở tab Home: người ta mở tab này để nghe ngay, không phải để
  // bấm thêm một nút nữa. Mở tab mới hoàn toàn để kiểm từ trạng thái sạch.
  const auto = await b2.newPage({ viewport: { width: 412, height: 900 } });
  const autoMixes = [1, 2, 3, 4, 5].map((n) => ({
    label: 'Bài đầu ' + n, sub: '15 bài · CS', thumb: '/icon-192.png',
    items: Array.from({ length: 15 }, (_, i) => ({
      id: `m${n}_${i}`, title: `Bài ${n}-${i}`, author: 'CS',
      duration: 210, thumb: '/icon-192.png' })),
  }));
  await auto.route('**/api/mixes**', (route) =>
    route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ label: 'Nhạc trẻ', mixes: autoMixes }) }));
  await auto.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await auto.waitForTimeout(500);
  await auto.click('.tab[data-tab="home"]');
  // KHÔNG bấm nút nào cả — thẻ phải tự hiện.
  await auto.waitForSelector('.mixcard', { timeout: 8000 });
  assert.strictEqual(await auto.locator('.mixcard').count(), 5,
    'mỗi lần phải cho đủ 5 playlist');
  ok('mở tab Home => 5 playlist tự hiện, không cần bấm nút nào');

  // Không playlist nào được trùng bài với playlist khác — trùng thì chọn thẻ
  // nào cũng như nhau, bày ra 5 thẻ để làm gì.
  const ids = autoMixes.flatMap((m) => m.items.map((t) => t.id));
  assert.strictEqual(new Set(ids).size, ids.length);
  const apiMix = await auto.request.get(BASE + '/api/mixes?source=history&count=5');
  const apiJson = await apiMix.json();
  const realIds = (apiJson.mixes || []).flatMap((m) => m.items.map((t) => t.id));
  assert.strictEqual(new Set(realIds).size, realIds.length,
    'server không được trả về playlist trùng bài nhau');
  ok('các playlist không có bài nào trùng nhau');
  await auto.close();

  // Playlist phải TỰ hiện khi mở tab Home, không bắt bấm nút mới có.
  assert.strictEqual(await grid.locator('#mixMake').isVisible(), false,
    'đã bỏ nút "Tạo playlist" — playlist tự sinh');
  const reloadBox = await grid.locator('#mixReload').boundingBox();
  assert.ok(reloadBox.width >= 44 && reloadBox.height >= 44,
    `nút ⟳ playlist quá nhỏ: ${reloadBox.width}×${reloadBox.height}`);
  ok('không còn nút "Tạo playlist", chỉ còn icon ⟳ đủ to');

  // Ô từ khoá của playlist cũng phải có nút ✕ như ô tìm kiếm chính.
  await grid.click('#mixSrcChips [data-mixsrc="query"]');
  await grid.waitForTimeout(150);
  assert.strictEqual(await grid.locator('#mixQClear').isVisible(), false,
    'ô trống thì không bày nút xoá');
  await grid.fill('#mixQ', 'mỹ tâm');
  await grid.waitForTimeout(150);
  assert.strictEqual(await grid.locator('#mixQClear').isVisible(), true);
  await grid.click('#mixQClear');
  await grid.waitForTimeout(150);
  assert.strictEqual(await grid.inputValue('#mixQ'), '');
  assert.strictEqual(await grid.evaluate(() => document.activeElement.id), 'mixQ',
    'xoá xong con trỏ phải ở lại trong ô');
  await grid.click('#mixSrcChips [data-mixsrc="history"]');
  await grid.waitForTimeout(150);
  ok('ô từ khoá playlist cũng có nút ✕ xoá nhanh');

  // Ghép ra NHIỀU thẻ để chọn, chưa phát gì cả.
  const beforeMix = (await (await grid.request.get(BASE + '/api/state')).json()).queue.length;
  await grid.click('#mixReload');
  await grid.waitForSelector('.mixcard', { timeout: 8000 });
  const mixCards = await grid.locator('.mixcard').count();
  assert.ok(mixCards >= 1, 'phải hiện ít nhất một thẻ mix');
  assert.match(await grid.locator('.mixcard').first().innerText(), /Playlist ·/);
  assert.match(await grid.locator('.mixcard .mixbadge').first().innerText(), /\d+ bài/);
  const midMix = await (await grid.request.get(BASE + '/api/state')).json();
  assert.strictEqual(midMix.queue.length, beforeMix,
    'mới ghép xong thì chưa được phát gì — còn phải chọn mix nào đã');
  ok(`bấm ⟳ => hiện ${mixCards} thẻ playlist để chọn, chưa phát`);

  // Bấm MỘT thẻ = phát cả mix đó. Mỗi bài là một mục riêng trong hàng chờ —
  // đây chính là lý do tự ghép thay vì phát một video tổng hợp 1 tiếng.
  const wantCount = (await grid.locator('.mixcard .mixbadge').first().innerText())
    .match(/(\d+) bài/)[1];
  await grid.click('.mixcard');
  await grid.waitForTimeout(700);
  const stAfterMix = await (await grid.request.get(BASE + '/api/state')).json();
  assert.strictEqual(stAfterMix.queue.length - beforeMix, Number(wantCount),
    'bấm thẻ mix phải đẩy đúng từng bài một vào hàng chờ');
  assert.ok(stAfterMix.current, 'bấm thẻ mix là phát ngay');
  ok(`bấm một thẻ playlist => phát cả ${wantCount} bài, mỗi bài một mục riêng`);

  await grid.close();

  // ------------------------------- tab "Của tôi" khi ĐÃ đăng nhập Data API
  // LỖI ĐÃ GẶP THẬT: mục "Nghe gần đây" quay vòng mãi không dừng. Nguyên nhân
  // là một biến sót lại từ thời còn hai cách đăng nhập; nó ném ReferenceError
  // NGAY, trước cả khi fetch chạy, nên .catch không bao giờ chạy.
  //
  // Bộ test cũ không bắt được vì chưa đăng nhập thì loadMe thoát sớm, không
  // chạm tới dòng hỏng.
  const me = await b2.newPage({ viewport: { width: 412, height: 900 } });
  const meErrors = [];
  me.on('pageerror', (e) => meErrors.push(e.message));
  await me.route('**/api/gapi/status', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      configured: true, logged_in: true, channel: { name: 'Kênh của tôi' } }) }));
  await me.route('**/api/me/playlists', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }));
  await me.route('**/api/me/liked', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: [] }) }));

  await me.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await me.waitForTimeout(500);
  await me.click('.tab[data-tab="me"]');
  await me.waitForTimeout(1200);

  assert.deepStrictEqual(meErrors, [], 'tab Của tôi không được có lỗi JS');
  assert.strictEqual(await me.locator('#myHistory .spin').count(), 0,
    'vòng xoay phải tắt, không được quay mãi');
  assert.match(await me.locator('#myHistory').innerText(), /Chưa thích video nào/);
  ok('đã đăng nhập: mục "đã thích" tải xong và tắt vòng xoay');

  // Danh sách dài phải PHÂN TRANG: đổ 40 thẻ ra một lúc thì trên điện thoại
  // cuộn mãi không hết một mục.
  await me.unroute('**/api/me/liked');
  const many = Array.from({ length: 40 }, (_, i) => ({
    id: 'L' + i, title: 'Đã thích ' + i, author: 'CS', duration: 200,
    thumb: '/icon-192.png' }));
  await me.route('**/api/me/liked', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: many }) }));
  await me.reload({ waitUntil: 'domcontentloaded' });
  await me.waitForTimeout(400);
  await me.click('.tab[data-tab="me"]');
  await me.waitForSelector('#myHistory .card', { timeout: 5000 });

  const perPage = await me.locator('#myHistory .card').count();
  assert.strictEqual(perPage, 6, `khổ điện thoại mỗi trang 6 thẻ, đang ${perPage}`);
  assert.strictEqual(await me.locator('#histPager').isVisible(), true);
  assert.strictEqual((await me.locator('#histPageInfo').innerText()).trim(), '1/7');
  assert.strictEqual(await me.locator('#histPrev').isDisabled(), true,
    'ở trang đầu thì nút lùi phải mờ đi');

  const likedFirst = await me.locator('#myHistory .card .t').first().innerText();
  await me.click('#histNext');
  await me.waitForTimeout(250);
  assert.strictEqual((await me.locator('#histPageInfo').innerText()).trim(), '2/7');
  const likedSecond = await me.locator('#myHistory .card .t').first().innerText();
  assert.notStrictEqual(likedSecond, likedFirst, 'sang trang phải đổi nội dung');

  // Chỉ mục thẻ phải khớp với trang ĐANG hiện, nếu không bấm là nhầm bài.
  const beforeAdd = (await (await me.request.get(BASE + '/api/state')).json()).queue.length;
  await me.click('#myHistory .card .addbtn');
  await me.waitForTimeout(400);
  const stAdd = await (await me.request.get(BASE + '/api/state')).json();
  assert.strictEqual(stAdd.queue.length - beforeAdd, 1);
  assert.strictEqual(stAdd.queue[stAdd.queue.length - 1].title, likedSecond,
    'phải thêm đúng bài đang hiện ở trang 2, không phải bài ở trang 1');
  ok('video đã thích: phân trang 6 thẻ/trang, sang trang thêm đúng bài');

  // Màn rộng thì mỗi trang nhiều hơn — 6 thẻ không đầy nổi một hàng.
  await me.setViewportSize({ width: 1280, height: 900 });
  await me.waitForTimeout(300);
  assert.strictEqual(await me.locator('#myHistory .card').count(), 12,
    'màn rộng mỗi trang 12 thẻ');
  await me.setViewportSize({ width: 412, height: 900 });
  await me.waitForTimeout(300);
  ok('xoay sang màn rộng: mỗi trang 12 thẻ, thu lại còn 6');

  // Mở một playlist phải có đường QUAY LẠI — trước đây nhảy sang tab khác rồi
  // mắc kẹt, phải tải lại trang mới thoát ra được.
  await me.unroute('**/api/me/playlists');
  await me.route('**/api/me/playlists', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      items: [{ id: 'PL1', title: 'Nhạc @@', count: 36, thumb: '/icon-192.png' }] }) }));
  await me.route('**/api/playlist/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      items: many.slice(0, 8) }) }));
  await me.reload({ waitUntil: 'domcontentloaded' });
  await me.waitForTimeout(400);
  await me.click('.tab[data-tab="me"]');
  await me.waitForSelector('#myPlaylists [data-open]', { timeout: 5000 });
  await me.click('#myPlaylists [data-open]');
  await me.waitForSelector('#resultsBack:visible', { timeout: 5000 });

  assert.match(await me.locator('#resultsCtx').innerText(), /Nhạc @@/,
    'tiêu đề phải nói rõ đang mở playlist nào');
  assert.strictEqual(await me.locator('#paneResults').isVisible(), true);
  await me.click('#backToMe');
  await me.waitForTimeout(300);
  assert.strictEqual(await me.locator('#paneMe').isVisible(), true,
    'bấm Quay lại phải về đúng tab Của tôi');
  ok('mở playlist rồi bấm "‹ Quay lại" là về tab Của tôi, không phải tải lại trang');

  // Tìm mới thì ngữ cảnh playlist cũ phải biến mất — kể cả khi lượt tìm HỎNG.
  await me.route('**/api/search**', (route) =>
    route.fulfill({ status: 502, contentType: 'application/json',
      body: JSON.stringify({ error: 'YouTube responded 403' }) }));
  await me.fill('#q', 'bài gì đó');
  await me.click('#searchBtn');
  await me.waitForTimeout(800);
  assert.strictEqual(await me.locator('#resultsBack').isVisible(), false,
    'tìm mới (kể cả hỏng) phải bỏ thanh quay lại của playlist trước');
  assert.match(await me.locator('#results').innerText(), /403/);
  ok('tìm mới xoá ngữ cảnh playlist cũ, kể cả khi tìm hỏng');

  // Lỗi từ server cũng phải tắt vòng xoay và nói ra lỗi.
  await me.unroute('**/api/me/liked');
  await me.route('**/api/me/liked', (route) =>
    route.fulfill({ status: 403, contentType: 'application/json',
      body: JSON.stringify({ error: 'Token hết hạn' }) }));
  await me.reload({ waitUntil: 'domcontentloaded' });
  await me.waitForTimeout(400);
  await me.click('.tab[data-tab="me"]');
  await me.waitForTimeout(1200);
  assert.strictEqual(await me.locator('#myHistory .spin').count(), 0,
    'gọi hỏng cũng phải tắt vòng xoay');
  assert.match(await me.locator('#myHistory').innerText(), /Token hết hạn/,
    'phải hiện lỗi thật thay vì quay mãi');
  await me.close();
  ok('gọi API hỏng: tắt vòng xoay và hiện đúng lỗi');

  // -------------------------------------------------------------- Album
  // Cách dùng thật: tạo album trống trước, rồi gặp bài nào thích thì bấm
  // "💿 Thêm vào album" ngay trên thẻ bài. Muốn nghe thì sang tab Album bấm ▶.
  const alb = await b2.newPage({ viewport: { width: 412, height: 900 } });
  const albErrors = [];
  alb.on('pageerror', (e) => albErrors.push(e.message));
  await alb.route('**/api/genre/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      // id phải đúng 11 ký tự như id video thật: server lọc bỏ id sai, và
      // album sẽ im lặng không nhận bài.
      items: Array.from({ length: 6 }, (_, i) => ({
        id: 'gOiY000000' + i, title: 'Bài gợi ý ' + i, author: 'CS ' + i, duration: 200,
        thumb: '/icon-192.png' })), hiddenSkipped: 0, exhausted: false }) }));
  await alb.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await alb.waitForTimeout(500);

  // Dọn album do lần chạy trước để lại, để đếm cho chắc.
  for (const a of (await (await alb.request.get(BASE + '/api/albums')).json()).albums) {
    await alb.request.delete(BASE + '/api/albums/' + a.id);
  }

  // Tab Album phải có mặt, và lúc chưa có gì thì nói rõ phải làm sao.
  await alb.click('.tab[data-tab="albums"]');
  await alb.waitForTimeout(500);
  assert.match(await alb.locator('#albums').innerText(), /Chưa có album nào/);
  assert.match(await alb.locator('#albums').innerText(), /Thêm vào album/,
    'lúc trống phải chỉ luôn cách dùng, đừng để một ô trống vô nghĩa');
  ok('có tab Album riêng; lúc chưa có gì thì hướng dẫn luôn cách tạo');

  // Tạo album TRỐNG trước.
  await alb.click('#albNew');
  await alb.waitForSelector('#albModal.open', { timeout: 3000 });
  await alb.fill('#albName', 'Nhạc ngủ');
  await alb.click('#albOk');
  await alb.waitForTimeout(700);
  assert.strictEqual(await alb.locator('#albums .albcard').count(), 1);
  assert.match(await alb.locator('#albums').innerText(), /Nhạc ngủ/);
  assert.match(await alb.locator('.albbadge').first().innerText(), /trống/,
    'album rỗng phải nói là trống chứ không phải "0 bài" khó hiểu');
  ok('tạo album trống trước, chưa cần có bài nào');

  // Gặp bài thích thì bấm "💿 Thêm vào album". Mới có ĐÚNG MỘT album nên bỏ
  // thẳng vào, không bắt chọn giữa một lựa chọn.
  await alb.click('.tab[data-tab="home"]');
  await alb.waitForTimeout(400);
  await alb.click('#homeChips [data-genre]');
  await alb.waitForSelector('#home .card', { timeout: 5000 });
  await alb.click('#home .card [data-toalbum]');
  await alb.waitForTimeout(700);
  let list = (await (await alb.request.get(BASE + '/api/albums')).json()).albums;
  assert.strictEqual(list[0].count, 1, 'một album thì bỏ thẳng vào, khỏi hỏi');
  ok('bấm "💿 Thêm vào album" khi chỉ có một album: bỏ thẳng vào');

  // Thêm đúng bài đó lần nữa: phải nói "đã có rồi", không nhân đôi.
  await alb.click('#home .card [data-toalbum]');
  await alb.waitForTimeout(700);
  list = (await (await alb.request.get(BASE + '/api/albums')).json()).albums;
  assert.strictEqual(list[0].count, 1, 'không được thêm trùng bài vào cùng album');
  assert.match(await alb.locator('#toast').innerText(), /đã có bài này rồi/i);
  ok('thêm lại đúng bài đó: báo "đã có rồi", không nhân đôi');

  // Có NHIỀU album thì phải cho chọn.
  await alb.request.post(BASE + '/api/albums', { data: { empty: true, name: 'Nhạc sáng' } });
  await alb.click('.tab[data-tab="albums"]');
  await alb.waitForTimeout(500);
  await alb.click('.tab[data-tab="home"]');
  await alb.waitForTimeout(400);
  await alb.locator('#home .card [data-toalbum]').nth(1).click();
  await alb.waitForSelector('#pickModal.open', { timeout: 3000 });
  assert.strictEqual(await alb.locator('#pickList .pickitem').count(), 2,
    'nhiều album thì hiện đủ để chọn');
  assert.match(await alb.locator('#pickNote').innerText(), /Bài gợi ý 1/,
    'hộp chọn phải nói rõ đang thêm BÀI NÀO');
  // Chọn theo TÊN chứ không theo vị trí: danh sách xếp mới nhất trước, chọn
  // theo số thứ tự là bài kiểm thử tự đánh đố mình.
  await alb.locator('#pickList .pickitem', { hasText: 'Nhạc sáng' }).click();
  await alb.waitForTimeout(700);
  list = (await (await alb.request.get(BASE + '/api/albums')).json()).albums;
  const nhacSang = list.find((a) => a.name === 'Nhạc sáng');
  assert.strictEqual(nhacSang.count, 1, 'bài phải vào ĐÚNG album vừa chọn');
  ok('nhiều album: hiện hộp cho chọn, bài vào đúng album đã chọn');

  // Mở album ra xem có bài gì, rồi đẩy sang hàng chờ mà nghe.
  await alb.click('.tab[data-tab="albums"]');
  await alb.waitForTimeout(600);
  await alb.click('#albums .albcard .thumb');
  await alb.waitForTimeout(700);
  assert.strictEqual(await alb.locator('#albBack').isVisible(), true);
  assert.strictEqual(await alb.locator('#albListWrap').isHidden(), true,
    'mở album là đổi nội dung tab, không phải chồng lên danh sách');
  assert.strictEqual(await alb.locator('#albTracks .card').count(), 1);
  ok('bấm thẻ album => mở ra xem các bài bên trong');

  await alb.click('#albPlayAll');
  await alb.waitForTimeout(700);
  let qs = await (await alb.request.get(BASE + '/api/state')).json();
  assert.strictEqual(qs.queue.length, 1, 'nút ▶ Phát đẩy cả album sang hàng chờ');
  assert.strictEqual(qs.index, 0);
  ok('nút ▶ Phát trong album: đẩy cả album sang hàng chờ và phát');

  // Bỏ một bài khỏi album, ngay trong màn xem chi tiết.
  await alb.click('#albTracks [data-albrm]');
  await alb.waitForTimeout(800);
  assert.match(await alb.locator('#albTracks').innerText(), /còn trống/,
    'bỏ bài cuối cùng thì album trống, phải nói rõ');
  qs = await (await alb.request.get(BASE + '/api/state')).json();
  assert.strictEqual(qs.queue.length, 1, 'bỏ bài khỏi album không đụng hàng chờ');
  ok('bỏ bài khỏi album ngay trong album; hàng chờ không bị đụng');

  await alb.click('#albBackBtn');
  await alb.waitForTimeout(400);
  assert.strictEqual(await alb.locator('#albListWrap').isVisible(), true,
    'bấm "‹ Album" là về danh sách, không phải tải lại trang');
  ok('nút ‹ Album: quay lại danh sách album');

  // Nút ＋ trên thẻ = nối vào cuối hàng chờ, không cắt ngang bài đang nghe.
  const before = (await (await alb.request.get(BASE + '/api/state')).json()).queue.length;
  // Chọn đúng album CÒN BÀI: album vừa bị bỏ bài ở trên đang trống, nối nó vào
  // thì hàng chờ chẳng đổi gì và bài kiểm thử hỏng vì lý do chẳng liên quan.
  await alb.locator('.albcard', { hasText: 'Nhạc ngủ' }).locator('[data-albadd]').click();
  await alb.waitForTimeout(700);
  qs = await (await alb.request.get(BASE + '/api/state')).json();
  assert.ok(qs.queue.length > before, 'nút ＋ phải nối thêm vào hàng chờ');
  assert.strictEqual(qs.index, 0, 'nối album không được nhảy bài đang nghe');
  ok('nút ＋ trên thẻ album: nối vào cuối, không cắt ngang bài đang nghe');

  // Nút 💿 ở thanh điều khiển vẫn làm việc ngược lại: lưu CẢ hàng chờ.
  await alb.click('#bAlbum');
  await alb.waitForSelector('#albModal.open', { timeout: 3000 });
  assert.match(await alb.locator('#albModalNote').innerText(), /\d+ bài/,
    'hộp lưu album phải nói rõ đang lưu bao nhiêu bài');
  await alb.fill('#albName', 'Mạch tối nay');
  await alb.click('#albOk');
  await alb.waitForTimeout(800);
  await alb.click('.tab[data-tab="albums"]');
  await alb.waitForTimeout(600);
  assert.match(await alb.locator('#albums .albcard').first().innerText(), /Mạch tối nay/,
    'album mới nhất phải đứng đầu');
  ok('nút 💿 ở thanh điều khiển: lưu cả hàng chờ thành album mới');

  // Đổi tên và xoá.
  await alb.click('#albums [data-albren]');
  await alb.waitForSelector('#albModal.open', { timeout: 3000 });
  assert.strictEqual(await alb.locator('#albName').inputValue(), 'Mạch tối nay',
    'hộp đổi tên phải điền sẵn tên cũ');
  await alb.fill('#albName', 'Nhạc khuya');
  await alb.click('#albOk');
  await alb.waitForTimeout(700);
  assert.match(await alb.locator('#albums').innerText(), /Nhạc khuya/);
  ok('đổi tên album ngay trên trang, không cần hộp thoại của trình duyệt');

  const nAlb = await alb.locator('#albums .albcard').count();
  await alb.click('#albums [data-albdel]');
  await alb.waitForSelector('#albModal.open', { timeout: 3000 });
  await alb.click('#albCancel');
  await alb.waitForTimeout(500);
  assert.strictEqual(await alb.locator('#albums .albcard').count(), nAlb, 'bấm Huỷ thì giữ nguyên');
  await alb.click('#albums [data-albdel]');
  await alb.waitForSelector('#albModal.open', { timeout: 3000 });
  await alb.click('#albOk');
  await alb.waitForTimeout(700);
  assert.strictEqual(await alb.locator('#albums .albcard').count(), nAlb - 1);
  ok('xoá album: hỏi trước, bấm Huỷ thì không mất gì');

  // Nút 📻 cũ đã nhường chỗ cho 💿 — nhưng "nghe liên tục" vẫn phải còn chỗ
  // bật, nếu không là mất tính năng chứ không phải đổi chỗ.
  assert.strictEqual(await alb.locator('#bRadio').count(), 0, 'nút 📻 cũ phải được thay');
  assert.strictEqual(await alb.locator('#bAlbum').count(), 1);
  await alb.click('.tab[data-tab="home"]');
  await alb.waitForTimeout(800);
  assert.match(await alb.locator('#stationBar').innerText(), /nghe liên tục/i,
    '"nghe liên tục" vẫn phải bật/tắt được ở tab Home');
  ok('nút 📻 nhường chỗ cho 💿, "nghe liên tục" vẫn bật được ở tab Home');

  // Năm tab trên màn hẹp: không được xuống dòng, và vẫn bấm trúng.
  await alb.setViewportSize({ width: 360, height: 780 });
  await alb.waitForTimeout(300);
  const tabBoxes = await alb.locator('.tab').evaluateAll((els) =>
    els.filter((e) => e.offsetParent !== null).map((e) => e.getBoundingClientRect()));
  const rows = new Set(tabBoxes.map((b) => Math.round(b.top)));
  assert.strictEqual(rows.size, 1, 'màn 360px: 5 tab phải nằm trên MỘT hàng');
  assert.ok(Math.min(...tabBoxes.map((b) => b.height)) >= 30, 'tab vẫn đủ cao để chạm');
  ok('màn 360px: 5 tab vẫn nằm gọn một hàng, đủ to để chạm');
  await alb.setViewportSize({ width: 412, height: 900 });

  // Nhiều album thì phân trang, đừng đổ hết ra một trang dài trên điện thoại.
  await alb.route('**/api/albums', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      albums: Array.from({ length: 14 }, (_, i) => ({
        id: 'alb' + i, name: 'Album ' + i, count: 10, createdAt: Date.now(),
        thumb: '/icon-192.png', authors: 'CS' })) }) });
  });
  await alb.click('.tab[data-tab="albums"]');
  await alb.waitForTimeout(600);
  assert.strictEqual(await alb.locator('#albums .albcard').count(), 6,
    'khổ điện thoại: 6 album một trang');
  assert.strictEqual(await alb.locator('#albPager').isVisible(), true);
  await alb.click('#albNext');
  await alb.waitForTimeout(300);
  assert.match(await alb.locator('#albums').innerText(), /Album 6/);
  ok('nhiều album: phân trang 6 thẻ/trang trên điện thoại');

  assert.deepStrictEqual(albErrors, [], 'phần album không được có lỗi JS');
  ok('không có lỗi JS ở phần album');
  await alb.close();

  // ------------------------------ tự ẩn thanh điều khiển khi lướt (điện thoại)
  const dockPage = await b2.newPage({ viewport: { width: 412, height: 800 } });
  await dockPage.route('**/api/genre/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      items: Array.from({ length: 26 }, (_, i) => ({
        id: 'd' + i, title: 'Bài dài ' + i, author: 'CS', duration: 220,
        thumb: '/icon-192.png' })), hiddenSkipped: 0, exhausted: false }) }));
  await dockPage.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await dockPage.waitForTimeout(500);
  await dockPage.click('.tab[data-tab="home"]');
  await dockPage.waitForTimeout(400);
  await dockPage.click('#homeChips [data-genre]');
  await dockPage.waitForSelector('#home .card', { timeout: 5000 });

  const dockAway = () => dockPage.evaluate(() =>
    document.querySelector('.dock').classList.contains('away'));

  // Playwright tự cuộn khi click, nên phải kéo về đầu trang rồi mới kiểm.
  await dockPage.evaluate(() => window.scrollTo(0, 0));
  await dockPage.waitForTimeout(300);
  assert.strictEqual(await dockAway(), false, 'ở đầu trang thanh phải hiện');

  await dockPage.evaluate(() => window.scrollTo(0, 900));
  await dockPage.waitForTimeout(300);
  assert.strictEqual(await dockAway(), true, 'lướt xuống thì thanh phải trượt đi');
  // Trượt đi rồi thì phải nằm NGOÀI màn hình, không chỉ đổi class.
  const box = await dockPage.locator('.dock').boundingBox();
  assert.ok(box.y >= 780, `thanh phải ra khỏi màn hình (y=${box.y}, cao 800)`);
  ok('lướt xuống: thanh điều khiển trượt khỏi màn hình');

  // Lướt NGƯỢC lên vẫn giữ ẩn — cố ý: thanh thò ra thụt vào theo từng cử động
  // ngón tay thì rối mắt hơn là hữu ích.
  await dockPage.evaluate(() => window.scrollTo(0, 700));
  await dockPage.waitForTimeout(300);
  assert.strictEqual(await dockAway(), true, 'lướt lên vẫn giữ ẩn');
  ok('lướt ngược lên: thanh vẫn ẩn, không nhấp nháy theo ngón tay');

  // Dừng lướt 4 giây thì tự nổi lại.
  await dockPage.evaluate(() => window.scrollTo(0, 1600));
  await dockPage.waitForTimeout(300);
  assert.strictEqual(await dockAway(), true);
  await dockPage.waitForTimeout(2000);
  assert.strictEqual(await dockAway(), true, 'mới 2 giây thì chưa được nổi lại');
  await dockPage.waitForTimeout(2600);
  assert.strictEqual(await dockAway(), false, 'dừng lướt 4 giây thì thanh nổi lại');
  ok('dừng lướt 4 giây: thanh tự nổi lại (2 giây thì chưa)');

  // Chọn một bài khi thanh đang ẩn thì phải kéo nó về.
  await dockPage.evaluate(() => window.scrollTo(0, 2400));
  await dockPage.waitForTimeout(300);
  if (await dockAway()) {
    await dockPage.click('#home .card .addbtn');
    await dockPage.waitForTimeout(300);
    assert.strictEqual(await dockAway(), false,
      'thêm bài xong phải thấy ngay thanh điều khiển');
    ok('chọn bài khi thanh đang ẩn => thanh quay lại');
  } else {
    // Cuộn tới đáy nên không còn chỗ để ẩn — vẫn phải hiện, cũng là đúng.
    ok('ở cuối trang thanh vẫn hiện (không còn chỗ để ẩn)');
  }

  // Màn rộng thì KHÔNG ẩn: thanh ở đó không chiếm mấy chỗ, ẩn đi chỉ gây giật.
  await dockPage.setViewportSize({ width: 1280, height: 800 });
  await dockPage.waitForTimeout(300);
  await dockPage.evaluate(() => window.scrollTo(0, 0));
  await dockPage.evaluate(() => window.scrollTo(0, 1200));
  await dockPage.waitForTimeout(400);
  const wideBox = await dockPage.locator('.dock').boundingBox();
  assert.ok(wideBox.y < 800, `màn rộng: thanh phải nằm trong màn hình (y=${wideBox.y})`);
  ok('màn rộng: thanh điều khiển không tự ẩn');

  await dockPage.close();

  // ------------------------------------------- chuyển động: vừa mượt vừa nhẹ
  //
  // "Mượt" không đo được bằng mắt trong bài kiểm thử, nhưng ba nguyên nhân
  // khiến nó GIẬT thì đo được, và cả ba đều từng có thật ở đây:
  //   1. không có transition -> đổi trạng thái là nhảy một phát;
  //   2. chuyển động những thuộc tính bắt vẽ lại (box-shadow, width, top...)
  //      -> máy yếu tụt khung hình;
  //   3. dùng thuộc tính hidden (display:none) -> không thể chuyển động.
  const mo = await b2.newPage({ viewport: { width: 412, height: 800 } });
  await mo.route('**/api/genre/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      items: Array.from({ length: 26 }, (_, i) => ({
        id: 'm' + i, title: 'Bài ' + i, author: 'CS', duration: 210,
        thumb: '/icon-192.png' })), hiddenSkipped: 0, exhausted: false }) }));
  await mo.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await mo.waitForTimeout(500);
  // Cần có thẻ bài THẬT trên trang thì mới đọc được style đã tính của .card.
  await mo.click('.tab[data-tab="home"]');
  await mo.waitForTimeout(400);
  await mo.click('#homeChips [data-genre]');
  await mo.waitForSelector('#home .card', { timeout: 5000 });
  await mo.evaluate(() => window.scrollTo(0, 0));
  await mo.waitForTimeout(300);

  const css = (sel, prop) => mo.evaluate(([s, p]) =>
    getComputedStyle(document.querySelector(s)).getPropertyValue(p), [sel, prop]);
  const secs = (v) => Math.max(...String(v).split(',').map((x) => parseFloat(x) || 0));

  assert.ok(secs(await css('.dock', 'transition-duration')) >= 0.3,
    'thanh điều khiển phải trượt đủ chậm để mắt theo kịp');
  assert.ok(!/^(linear|ease-in)$/.test((await css('.dock', 'transition-timing-function')).trim()),
    'phải dùng đường cong hãm dần, không phải linear/ease-in (nhìn như bị giật)');
  ok('thanh điều khiển trượt bằng đường cong hãm dần, không bụp một phát');

  // Chỉ transform/opacity mới chạy thẳng trên GPU. Danh sách dưới đây là
  // những thứ bắt tính lại bố cục hoặc vẽ lại — có mặt là biết sẽ nặng.
  const HEAVY = /\b(box-shadow|width|height|top|left|right|bottom|margin|padding|filter\b(?!:)|all)\b/;
  let checked = 0;
  for (const sel of ['.card', '.dock', '.volpop', '.tab', '.chip', '.row', '.ctrl', '.icon']) {
    // Chỉ xét những phần tử THẬT SỰ có chuyển động: phần tử không đặt
    // transition thì transition-property mặc định là 'all' với thời lượng 0 —
    // vô hại, mà đưa vào kiểm thì báo sai.
    if (secs(await css(sel, 'transition-duration')) === 0) continue;
    checked++;
    const props = (await css(sel, 'transition-property')).trim();
    assert.ok(!/\ball\b/.test(props), `${sel}: transition:all làm máy chạy hiệu ứng cho MỌI thuộc tính`);
    assert.ok(!/box-shadow|width|height|margin|padding/.test(props),
      `${sel} đang chuyển động thuộc tính nặng: ${props}`);
  }
  assert.ok(checked >= 5, `phải kiểm được ít nhất 5 phần tử có chuyển động, mới ${checked}`);
  ok('không thứ gì chuyển động thuộc tính nặng (box-shadow / kích thước / lề)');

  // Bóng đổ khi rê chuột nằm ở lớp phủ riêng, mờ/tỏ bằng opacity.
  const shadowFade = await mo.evaluate(() =>
    getComputedStyle(document.querySelector('.card'), '::after').transitionProperty);
  assert.match(shadowFade || '', /opacity/, 'bóng đổ phải mờ dần bằng opacity, không phải box-shadow');
  ok('bóng đổ thẻ bài dùng lớp phủ opacity thay vì chuyển động box-shadow');

  // Popup âm lượng: KHÔNG được dùng thuộc tính hidden nữa.
  assert.strictEqual(await mo.locator('#volPop').getAttribute('hidden'), null,
    'volPop dùng hidden (display:none) thì không thể chuyển động được');
  assert.ok(await mo.locator('#volPop').isHidden(), 'đóng rồi thì vẫn phải coi là ẩn');
  assert.ok(secs(await css('.volpop', 'transition-duration')) > 0,
    'popup âm lượng phải mờ dần chứ không bật ra tức thì');
  await mo.click('#bVol');
  await mo.waitForSelector('#volPop', { state: 'visible', timeout: 3000 });
  assert.strictEqual(await mo.evaluate(() =>
    document.getElementById('volPop').classList.contains('open')), true);
  await mo.mouse.click(10, 300);
  await mo.waitForSelector('#volPop', { state: 'hidden', timeout: 3000 });
  ok('popup âm lượng mở/đóng bằng class nên mờ dần được, vẫn ẩn đúng nghĩa');

  // will-change chỉ được bật lúc đang trượt: để thường trực thì trình duyệt
  // giữ mãi một lớp ảnh riêng cho thanh có backdrop-filter — rất tốn bộ nhớ.
  assert.strictEqual((await css('.dock', 'will-change')).trim(), 'auto',
    'lúc đứng yên thanh điều khiển không được đặt will-change');
  // Vừa chạm vào nút loa nên thanh đang được "giữ" 4 giây (xem keepDock) —
  // phải chờ hết mới trượt được, nếu không đây chỉ là bài kiểm thử sai.
  await mo.waitForTimeout(4300);
  await mo.evaluate(() => window.scrollTo(0, 1200));
  await mo.waitForTimeout(150);
  const movingNow = await mo.evaluate(() =>
    document.querySelector('.dock').classList.contains('moving'));
  assert.strictEqual(movingNow, true, 'đang trượt thì phải bật lớp GPU');
  await mo.waitForTimeout(700);
  assert.strictEqual(await mo.evaluate(() =>
    document.querySelector('.dock').classList.contains('moving')), false,
    'trượt xong phải gỡ will-change ra để trả bộ nhớ');
  ok('will-change chỉ bật đúng lúc trượt rồi gỡ ngay (không giữ bộ nhớ)');

  // Ảnh thumbnail phải giải mã ngoài luồng chính, nếu không cuộn sẽ khựng.
  await mo.evaluate(() => window.scrollTo(0, 0));
  await mo.click('.tab[data-tab="me"]');
  const imgAttrs = await mo.evaluate(() => {
    const html = document.body.innerHTML;
    return { lazy: (html.match(/loading="lazy"/g) || []).length,
             async: (html.match(/decoding="async"/g) || []).length };
  });
  assert.ok(imgAttrs.lazy === 0 || imgAttrs.async >= imgAttrs.lazy,
    'mọi ảnh tải lười phải kèm decoding="async"');
  ok('ảnh thumbnail tải lười và giải mã ngoài luồng chính');
  await mo.close();

  // Người bật "giảm chuyển động" trong cài đặt máy: bỏ hết hiệu ứng, nhưng
  // giao diện vẫn phải chạy đúng — không được vì thế mà hỏng chức năng.
  const rm = await b2.newPage({
    viewport: { width: 412, height: 800 }, reducedMotion: 'reduce' });
  const rmErrs = [];
  rm.on('pageerror', (e) => rmErrs.push(String(e)));
  await rm.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await rm.waitForTimeout(500);
  const rmDur = await rm.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('.dock')).transitionDuration));
  assert.ok(rmDur < 0.05, `bật giảm chuyển động thì phải gần như tắt hẳn (đang ${rmDur}s)`);
  await rm.click('#bVol');
  await rm.waitForSelector('#volPop', { state: 'visible', timeout: 3000 });
  await rm.mouse.click(10, 300);
  await rm.waitForSelector('#volPop', { state: 'hidden', timeout: 3000 });
  assert.deepStrictEqual(rmErrs, [], 'chế độ giảm chuyển động không được gây lỗi JS');
  ok('bật "giảm chuyển động": tắt hiệu ứng nhưng mọi thứ vẫn dùng được');
  await rm.close();

  // ------------------------------------------------- gim thanh tab khi cuộn
  const sticky = await b2.newPage({ viewport: { width: 412, height: 800 } });
  await sticky.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await sticky.waitForTimeout(600);
  await sticky.click('.tab[data-tab="home"]');
  await sticky.waitForTimeout(600);

  const tabsTop0 = (await sticky.locator('.tabs').boundingBox()).y;
  await sticky.evaluate(() => window.scrollTo(0, 900));
  await sticky.waitForTimeout(300);
  const tabsAfter = await sticky.locator('.tabs').boundingBox();
  const headerBox = await sticky.locator('header').boundingBox();

  assert.ok(tabsAfter.y > 0 && tabsAfter.y <= 800,
    `cuộn xuống rồi thanh tab vẫn phải nằm trong màn hình (y=${tabsAfter.y})`);
  assert.ok(tabsAfter.y < tabsTop0,
    'cuộn xuống thì thanh tab phải dính lên trên, không trôi theo trang');
  // Dính ngay DƯỚI header, không đè lên ô tìm kiếm.
  const headerBottom = headerBox.y + headerBox.height;
  assert.ok(Math.abs(tabsAfter.y - headerBottom) <= 2,
    `thanh tab phải dính sát dưới header (tab y=${tabsAfter.y}, header hết ở ${headerBottom})`);
  assert.strictEqual(await sticky.locator('.tab[data-tab="home"]').isVisible(), true);
  await sticky.close();
  ok('cuộn trang: thanh tab gim lại ngay dưới header, không đè lên nhau');

  // ------------------------------------------- vùng an toàn (tai thỏ iPhone)
  // iPhone mở từ biểu tượng ngoài màn hình chính chạy toàn màn hình, đồng hồ và
  // cột sóng đè thẳng lên header. Playwright không giả lập được env(), nên
  // CSS gói inset vào biến để chỗ này ghi đè mà kiểm.
  const safe = await b2.newPage({ viewport: { width: 393, height: 852 } });
  await safe.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await safe.waitForTimeout(500);

  const brandBefore = await safe.locator('.brand').boundingBox();
  await safe.evaluate(() => {
    const r = document.documentElement.style;
    r.setProperty('--sat', '59px');   // tai thỏ iPhone 15
    r.setProperty('--sab', '34px');   // vạch home
    r.setProperty('--sal', '0px');
    r.setProperty('--sar', '0px');
  });
  await safe.waitForTimeout(200);
  const brandAfter = await safe.locator('.brand').boundingBox();
  assert.ok(brandAfter.y >= 59,
    `tên app phải nằm dưới thanh trạng thái (đang ở y=${brandAfter.y})`);
  assert.ok(brandAfter.y - brandBefore.y >= 55,
    'header phải tụt xuống đúng bằng chiều cao vùng an toàn');
  ok('máy có tai thỏ: header tụt xuống, không bị đồng hồ/sóng che');

  await safe.close();

  // Thanh điều khiển dưới cùng là position:fixed nên KHÔNG ăn padding của body,
  // phải tự chừa lề. Tai thỏ ngang chỉ xuất hiện khi máy XOAY NGANG, nên kiểm
  // đúng khổ đó — ép lề 44px lên màn dọc 360px là tổ hợp không có thật.
  const land = await b2.newPage({ viewport: { width: 852, height: 393 } });
  await land.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await land.waitForTimeout(500);
  await land.evaluate(() => {
    document.documentElement.style.setProperty('--sal', '59px');
    document.documentElement.style.setProperty('--sar', '59px');
    document.documentElement.style.setProperty('--sab', '21px');
  });
  await land.waitForTimeout(200);
  const shuffleBtn = await land.locator('#bShuffle').boundingBox();
  const volBtn = await land.locator('#bVol').boundingBox();
  assert.ok(shuffleBtn.x >= 59,
    `nút đầu phải nằm ngoài tai thỏ trái (x=${shuffleBtn.x})`);
  assert.ok(volBtn.x + volBtn.width <= 852 - 59,
    `nút cuối phải nằm ngoài tai thỏ phải (mép phải=${volBtn.x + volBtn.width})`);
  await land.close();
  ok('xoay ngang có tai thỏ: thanh điều khiển tự chừa lề hai bên');

  // Máy hẹp: 7 nút không được tràn ra ngoài màn hình. Trước đây chúng để
  // flex:none nên nút âm lượng bị đẩy văng khỏi màn hình mà không ai thấy.
  for (const w of [320, 360, 393]) {
    const narrow = await b2.newPage({ viewport: { width: w, height: 800 } });
    await narrow.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
    await narrow.waitForTimeout(400);
    const v = await narrow.locator('#bVol').boundingBox();
    const s0 = await narrow.locator('#bShuffle').boundingBox();
    assert.ok(v.x + v.width <= w, `màn ${w}px: nút âm lượng tràn ra ngoài (${v.x + v.width})`);
    assert.ok(s0.x >= 0 && v.width >= 30, `màn ${w}px: nút co lại quá nhỏ để chạm`);
    await narrow.close();
  }
  ok('màn 320/360/393px: cả 7 nút vẫn nằm trong màn hình và đủ to để chạm');

  // ------------------------------------------------ bố cục máy tính bảng
  const wide = await b2.newPage({ viewport: { width: 1280, height: 800 } });
  // Bố cục rộng chạy nhánh code khác (mở thẳng vào tab Thịnh hành), nên phải
  // bắt lỗi JS RIÊNG ở đây. Đúng chỗ này từng lọt một lỗi TDZ chỉ xuất hiện
  // khi màn rộng, vì khổ điện thoại mặc định vào tab Hàng chờ.
  const wideErrors = [];
  wide.on('pageerror', (e) => wideErrors.push(e.message));
  await wide.goto(BASE + '/remote', { waitUntil: 'domcontentloaded' });
  await wide.waitForTimeout(1200);

  assert.deepStrictEqual(wideErrors, [], 'khổ rộng không được có lỗi JS');
  assert.ok(await wide.locator('#homeChips [data-genre]').count() >= 8,
    'khổ rộng: danh sách thể loại phải nạp được');
  ok('khổ rộng: không lỗi JS, danh sách thể loại nạp đủ');

  assert.strictEqual(await wide.locator('#side').isVisible(), true,
    'màn rộng: hàng chờ phải luôn hiện ở cột phải');
  assert.strictEqual(await wide.locator('.tab[data-tab="queue"]').isVisible(), false,
    'màn rộng: tab Hàng chờ thừa, phải ẩn');
  assert.strictEqual(await wide.locator('#paneHome').isVisible(), true,
    'màn rộng: mở thẳng vào tab chọn bài');

  // Cột phải phải nằm bên phải cột nội dung, không đè lên nhau.
  const sideBox = await wide.locator('#side').boundingBox();
  const mainBox = await wide.locator('main').boundingBox();
  assert.ok(sideBox.x >= mainBox.x + mainBox.width - 2,
    `cột hàng chờ phải nằm cạnh cột nội dung (side.x=${sideBox.x}, main hết ở ${mainBox.x + mainBox.width})`);
  ok('máy tính bảng ngang: hai cột, hàng chờ luôn nhìn thấy');

  // Cột hàng chờ phải đủ rộng để đọc được tên bài, không cắt cụt từ chữ thứ tư.
  assert.ok(sideBox.width >= 400,
    `cột hàng chờ quá hẹp trên PC: ${sideBox.width}px`);
  await wide.setViewportSize({ width: 1440, height: 900 });
  await wide.waitForTimeout(250);
  const sideWide = await wide.locator('#side').boundingBox();
  assert.ok(sideWide.width >= 480,
    `màn PC rộng thì cột hàng chờ phải nới thêm: ${sideWide.width}px`);
  ok(`cột hàng chờ rộng ${sideBox.width}px (1280px) và ${sideWide.width}px (1440px)`);

  // Thu nhỏ lại thì phải quay về một cột, tab Hàng chờ hiện lại.
  await wide.setViewportSize({ width: 412, height: 900 });
  await wide.waitForTimeout(300);
  assert.strictEqual(await wide.locator('.tab[data-tab="queue"]').isVisible(), true,
    'khổ hẹp: tab Hàng chờ phải hiện lại');
  await wide.click('.tab[data-tab="queue"]');
  await wide.waitForTimeout(200);
  assert.strictEqual(await wide.locator('#side').isVisible(), true);
  assert.strictEqual(await wide.locator('#paneHome').isVisible(), false,
    'khổ hẹp: mỗi lúc chỉ một pane hiện');
  ok('thu nhỏ về khổ điện thoại: quay lại một cột, tab Hàng chờ dùng được');

  await wide.close();
  await b2.close();

  console.log(`\n${pass}/${pass} bài kiểm thử giao diện PASS\n`);
  server.close();
  process.exit(0);
})().catch(async (e) => {
  console.error('\n✗ FAIL:', e.message);
  process.exit(1);
});
