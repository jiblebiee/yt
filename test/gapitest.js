/**
 * Kiểm thử module YouTube Data API bằng fetch giả lập.
 * Chạy: node test/gapitest.js
 *
 * Container phát triển không gọi được ra Google, nên toàn bộ luồng device
 * flow / refresh token / phân trang được kiểm bằng cách thay global.fetch.
 * Không cần mạng.
 */
const assert = require('assert');
const g = require('../youtube-api.js');

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

const realFetch = global.fetch;
let calls = [];

/** Thay fetch bằng hàm trả về phản hồi do bài test quy định. */
function mockFetch(handler) {
  calls = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ url: u, method: init?.method || 'GET', body, headers: init?.headers || {} });
    const r = await handler(u, body, calls.length);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
    };
  };
}
const restore = () => { global.fetch = realFetch; };

(async () => {
  // ------------------------------------------------------- parse độ dài ISO
  assert.strictEqual(g.parseISODuration('PT4M13S'), 253);
  assert.strictEqual(g.parseISODuration('PT1H2M3S'), 3723);
  assert.strictEqual(g.parseISODuration('PT45S'), 45);
  assert.strictEqual(g.parseISODuration('P1DT2H'), 93600);
  assert.strictEqual(g.parseISODuration('rác'), 0);
  assert.strictEqual(g.parseISODuration(undefined), 0);
  ok('parseISODuration đọc đúng mọi dạng, rác thì trả 0');

  // ------------------------------------------------------------- chuẩn hoá
  {
    const t = g.trackFromPlaylistItem({
      contentDetails: { videoId: 'dQw4w9WgXcQ' },
      snippet: {
        title: 'Bài hát',
        videoOwnerChannelTitle: 'Kênh A',
        thumbnails: { medium: { url: 'https://i.ytimg.com/m.jpg' } },
      },
    });
    assert.deepStrictEqual(t, {
      id: 'dQw4w9WgXcQ',
      title: 'Bài hát',
      author: 'Kênh A',
      duration: 0,
      thumb: 'https://i.ytimg.com/m.jpg',
    });

    // Video đã xoá / riêng tư vẫn nằm trong playlist nhưng KHÔNG phát được
    assert.strictEqual(g.trackFromPlaylistItem({
      contentDetails: { videoId: 'aaaaaaaaaaa' }, snippet: { title: 'Deleted video' },
    }), null);
    assert.strictEqual(g.trackFromPlaylistItem({
      contentDetails: { videoId: 'bbbbbbbbbbb' }, snippet: { title: 'Private video' },
    }), null);
    assert.strictEqual(g.trackFromPlaylistItem({ snippet: { title: 'x' } }), null);
    ok('trackFromPlaylistItem loại video đã xoá / riêng tư');

    const v = g.trackFromVideo({
      id: 'ccccccccccc',
      snippet: { title: 'Có độ dài', channelTitle: 'Kênh B', thumbnails: {} },
      contentDetails: { duration: 'PT3M30S' },
    });
    assert.strictEqual(v.duration, 210);
    assert.strictEqual(v.thumb, 'https://i.ytimg.com/vi/ccccccccccc/mqdefault.jpg');
    ok('trackFromVideo lấy được độ dài thật và ảnh dự phòng');

    assert.deepStrictEqual(
      g.playlistFromApi({ id: 'PL1', snippet: { title: 'Nhạc' }, contentDetails: { itemCount: 12 } }),
      { id: 'PL1', title: 'Nhạc', count: 12, thumb: null }
    );
    ok('playlistFromApi chuẩn hoá đúng');
  }

  // --------------------------------------------------------- xin mã đăng nhập
  mockFetch(async () => ({
    status: 200,
    json: {
      device_code: 'DC-1', user_code: 'ABCD-EFGH',
      verification_url: 'https://www.google.com/device',
      expires_in: 1800, interval: 5,
    },
  }));
  {
    const dc = await g.requestDeviceCode('cid.apps.googleusercontent.com');
    assert.strictEqual(dc.user_code, 'ABCD-EFGH');
    assert.strictEqual(dc.verification_url, 'https://www.google.com/device');
    assert.strictEqual(dc.interval, 5);
    assert.strictEqual(calls[0].body.scope, g.SCOPE, 'phải xin đúng scope readonly');
    assert.match(calls[0].url, /oauth2\.googleapis\.com\/device\/code/);
    ok('requestDeviceCode gửi đúng scope và đọc đúng mã');
  }

  // interval nhỏ hơn 5 giây phải bị nâng lên, tránh bị Google chặn
  mockFetch(async () => ({
    status: 200,
    json: { device_code: 'x', user_code: 'y', verification_uri: 'https://g/d', interval: 1 },
  }));
  {
    const dc = await g.requestDeviceCode('cid');
    assert.strictEqual(dc.interval, 5, 'interval tối thiểu là 5 giây');
    assert.strictEqual(dc.verification_url, 'https://g/d', 'chấp nhận cả verification_uri');
    ok('ép interval tối thiểu 5s và đọc được cả verification_uri');
  }

  // ------------------------------------------------------------ poll device
  mockFetch(async () => ({ status: 428, json: { error: 'authorization_pending' } }));
  assert.deepStrictEqual(await g.pollDeviceToken('c', 's', 'dc'), { status: 'pending' });
  mockFetch(async () => ({ status: 403, json: { error: 'slow_down' } }));
  assert.deepStrictEqual(await g.pollDeviceToken('c', 's', 'dc'), { status: 'slow_down' });
  ok('poll phân biệt đúng "đang chờ" và "chậm lại"');

  mockFetch(async () => ({
    status: 200,
    json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
  }));
  {
    const r = await g.pollDeviceToken('c', 's', 'dc');
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(r.tokens.access_token, 'AT');
    assert.strictEqual(r.tokens.refresh_token, 'RT');
    // Trừ hao 60s để không dùng token vừa kịp hết hạn
    const life = r.tokens.expires_at - Date.now();
    assert.ok(life > 3530000 && life <= 3540000, `hạn phải ~3540s, đang là ${life / 1000}s`);
    ok('lấy được token và trừ hao 60 giây trước khi hết hạn');
  }

  mockFetch(async () => ({ status: 401, json: { error: 'invalid_client' } }));
  await assert.rejects(() => g.pollDeviceToken('c', 's', 'dc'), /Client ID hoặc Client Secret sai/);
  mockFetch(async () => ({ status: 403, json: { error: 'access_denied' } }));
  await assert.rejects(() => g.pollDeviceToken('c', 's', 'dc'), /từ chối cấp quyền/);
  mockFetch(async () => ({ status: 400, json: { error: 'expired_token' } }));
  await assert.rejects(() => g.pollDeviceToken('c', 's', 'dc'), /hết hạn trước khi kịp nhập/);
  ok('lỗi OAuth được dịch sang câu người dùng hiểu được');

  // ----------------------------------------------------------- refresh token
  // Google KHÔNG gửi lại refresh_token khi làm mới. Nếu ghi đè bằng undefined
  // thì lần khởi động sau sẽ mất đăng nhập — đây là bẫy chính của luồng này.
  mockFetch(async () => ({ status: 200, json: { access_token: 'AT2', expires_in: 3600 } }));
  {
    const t = await g.refreshAccessToken('c', 's', 'RT-CU');
    assert.strictEqual(t.access_token, 'AT2');
    assert.strictEqual(t.refresh_token, 'RT-CU', 'phải giữ nguyên refresh token cũ');
    assert.strictEqual(calls[0].body.grant_type, 'refresh_token');
    ok('làm mới token vẫn giữ refresh_token cũ (không mất đăng nhập)');
  }

  mockFetch(async () => ({ status: 400, json: { error: 'invalid_grant' } }));
  await assert.rejects(() => g.refreshAccessToken('c', 's', 'RT'), /thu hồi hoặc hết hạn/);
  ok('token bị thu hồi báo lỗi rõ ràng');

  // ------------------------------------------------------------- gọi API
  mockFetch(async () => ({ status: 200, json: { items: [] } }));
  {
    await g.apiGet('playlists', { part: 'snippet', mine: 'true', bỏQua: '' },
      { accessToken: 'AT', apiKey: 'KEY' });
    const u = new URL(calls[0].url);
    assert.strictEqual(u.pathname, '/youtube/v3/playlists');
    assert.strictEqual(u.searchParams.get('mine'), 'true');
    assert.strictEqual(u.searchParams.get('key'), 'KEY');
    assert.strictEqual(u.searchParams.has('bỏQua'), false, 'tham số rỗng phải bị bỏ');
    assert.strictEqual(calls[0].headers.Authorization, 'Bearer AT');
    ok('apiGet dựng đúng URL, bỏ tham số rỗng, gắn Bearer token');
  }

  // ------------------------------------------------------------- phân trang
  mockFetch(async (url) => {
    const token = new URL(url).searchParams.get('pageToken');
    if (!token) {
      return { status: 200, json: {
        nextPageToken: 'p2',
        items: [
          { contentDetails: { videoId: 'aaaaaaaaaaa' }, snippet: { title: 'A' } },
          { contentDetails: { videoId: 'bbbbbbbbbbb' }, snippet: { title: 'B' } },
        ],
      } };
    }
    return { status: 200, json: {
      items: [
        { contentDetails: { videoId: 'bbbbbbbbbbb' }, snippet: { title: 'B trùng' } },
        { contentDetails: { videoId: 'ccccccccccc' }, snippet: { title: 'C' } },
        { contentDetails: { videoId: 'ddddddddddd' }, snippet: { title: 'Deleted video' } },
      ],
    } };
  });
  {
    const tracks = await g.playlistTracks({ accessToken: 'AT' }, 'PL1');
    assert.deepStrictEqual(tracks.map(t => t.id),
      ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']);
    assert.strictEqual(calls.length, 2, 'phải đi hết 2 trang');
    assert.strictEqual(new URL(calls[0].url).searchParams.get('maxResults'), '50');
    ok('phân trang đi hết các trang, bỏ trùng và bỏ video đã xoá');
  }

  // Giới hạn phải cắt ngay, không tải thừa trang
  mockFetch(async () => ({ status: 200, json: {
    nextPageToken: 'luôn-có',
    items: Array.from({ length: 50 }, (_, i) => ({
      contentDetails: { videoId: String(i).padStart(11, 'v') }, snippet: { title: 't' + i },
    })),
  } }));
  {
    const tracks = await g.playlistTracks({ accessToken: 'AT' }, 'PL1', 10);
    assert.strictEqual(tracks.length, 10);
    assert.strictEqual(calls.length, 1, 'đủ số lượng thì dừng ngay, không gọi thêm');
    ok('tôn trọng giới hạn, không gọi API thừa');
  }

  // nextPageToken lặp vô hạn -> phải bị chặn ở 20 trang
  let n = 0;
  mockFetch(async () => ({ status: 200, json: {
    nextPageToken: 'lặp-mãi',
    items: [{ contentDetails: { videoId: String(n++).padStart(11, 'z') }, snippet: { title: 'x' } }],
  } }));
  {
    const tracks = await g.playlistTracks({ accessToken: 'AT' }, 'PL1', 10000);
    assert.strictEqual(calls.length, 20, 'phải dừng ở 20 trang, không lặp vô hạn');
    assert.strictEqual(tracks.length, 20);
    ok('chặn vòng lặp vô hạn khi API trả nextPageToken mãi');
  }

  // --------------------------------------------------------- lỗi phía API
  mockFetch(async () => ({ status: 403, json: {
    error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] },
  } }));
  await assert.rejects(() => g.myPlaylists({ accessToken: 'AT' }), /Hết quota/);

  mockFetch(async () => ({ status: 403, json: {
    error: { message: 'not enabled', errors: [{ reason: 'accessNotConfigured' }] },
  } }));
  await assert.rejects(() => g.myPlaylists({ accessToken: 'AT' }), /Chưa bật YouTube Data API/);

  mockFetch(async () => ({ status: 401, json: { error: { message: 'bad creds' } } }));
  await assert.rejects(() => g.myPlaylists({ accessToken: 'AT' }), /hết hạn hoặc bị thu hồi/);
  ok('lỗi quota / chưa bật API / token hỏng đều có thông điệp riêng');

  // ------------------------------------------------------------- kênh của tôi
  mockFetch(async () => ({ status: 200, json: { items: [{
    id: 'UC123',
    snippet: { title: 'Kênh Của Tôi', thumbnails: { medium: { url: 'https://t.jpg' } } },
    contentDetails: { relatedPlaylists: { uploads: 'UU123', likes: 'LL123' } },
  }] } }));
  {
    const ch = await g.myChannel({ accessToken: 'AT' });
    assert.deepStrictEqual(ch, {
      id: 'UC123', name: 'Kênh Của Tôi', thumb: 'https://t.jpg',
      uploads: 'UU123', likes: 'LL123',
    });
    ok('myChannel lấy đúng tên kênh và id playlist hệ thống');
  }

  // Tài khoản Google không có kênh YouTube -> phải nói rõ, không crash
  mockFetch(async () => ({ status: 200, json: { items: [] } }));
  await assert.rejects(() => g.myChannel({ accessToken: 'AT' }), /chưa có kênh YouTube/);
  ok('tài khoản không có kênh được báo lỗi dễ hiểu');

  restore();
  console.log(`\n${pass}/${pass} bài kiểm thử Data API PASS\n`);
  process.exit(0);
})().catch((e) => {
  restore();
  console.error('\n✗ FAIL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
