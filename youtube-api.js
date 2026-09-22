/**
 * YouTube Data API v3 — đăng nhập chính thức bằng OAuth client của riêng bạn.
 *
 * VÌ SAO CÓ FILE NÀY: cách đăng nhập bằng "mã TV" của youtubei.js dùng client
 * TV nội bộ của YouTube, và YouTube từ chối (HTTP 400) mọi endpoint thư viện
 * với token đó. Data API chính thức thì không bị vậy — đổi lại phải tự tạo
 * OAuth client trên Google Cloud.
 *
 * ĐƯỢC GÌ:   playlist (kể cả riêng tư), video đã thích, kênh đã đăng ký.
 * KHÔNG ĐƯỢC: lịch sử xem và gợi ý trang chủ — Data API không hề có hai thứ
 *             này, không phải do code thiếu.
 *
 * QUOTA: mặc định 10.000 unit/ngày. playlists/playlistItems/subscriptions/
 * videos đều chỉ tốn 1 unit nên thoải mái. Riêng search.list tốn 100 unit nên
 * phần tìm kiếm của app KHÔNG dùng API này — vẫn để youtubei.js lo, miễn phí.
 */

const DEVICE_CODE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/youtube/v3/';
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Lỗi có ý nghĩa với người dùng, kèm mã máy đọc được. */
class ApiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'unknown';
  }
}

async function postForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* Google luôn trả JSON; nếu không thì coi như rỗng */
  }
  return { ok: res.ok, status: res.status, body };
}

/** Bước 1: xin mã để người dùng nhập trên google.com/device. */
async function requestDeviceCode(clientId) {
  const { ok, body } = await postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: SCOPE,
  });
  if (!ok) {
    throw new ApiError(
      describeOAuthError(body) || 'Không xin được mã đăng nhập từ Google',
      body.error || 'device_code_failed'
    );
  }
  return {
    device_code: body.device_code,
    user_code: body.user_code,
    // Google trả về verification_url ở endpoint này (không phải _uri).
    verification_url: body.verification_url || body.verification_uri,
    expires_in: Number(body.expires_in) || 1800,
    interval: Math.max(5, Number(body.interval) || 5),
  };
}

/**
 * Bước 2: hỏi một lần xem người dùng đã xác nhận chưa.
 * Trả về { status: 'pending' | 'slow_down' | 'ok', tokens? }
 */
async function pollDeviceToken(clientId, clientSecret, deviceCode) {
  const { ok, body } = await postForm(TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret || '',
    device_code: deviceCode,
    grant_type: DEVICE_GRANT,
  });

  if (ok) return { status: 'ok', tokens: normaliseTokens(body) };
  if (body.error === 'authorization_pending') return { status: 'pending' };
  if (body.error === 'slow_down') return { status: 'slow_down' };

  throw new ApiError(describeOAuthError(body), body.error || 'token_failed');
}

/** Lấy access token mới từ refresh token. */
async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const { ok, body } = await postForm(TOKEN_URL, {
    client_id: clientId,
    client_secret: clientSecret || '',
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!ok) throw new ApiError(describeOAuthError(body), body.error || 'refresh_failed');
  // Google KHÔNG gửi lại refresh_token khi làm mới -> phải giữ cái cũ,
  // nếu không lần khởi động sau sẽ mất đăng nhập.
  return { ...normaliseTokens(body), refresh_token: refreshToken };
}

function normaliseTokens(body) {
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    scope: body.scope,
    token_type: body.token_type,
    // Trừ hao 60 giây để không dùng token vừa kịp hết hạn giữa chừng.
    expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000 - 60000,
  };
}

/** Đổi mã lỗi khô khan của Google thành câu tiếng Việt hiểu được. */
function describeOAuthError(body) {
  const e = body?.error;
  const d = body?.error_description || '';
  switch (e) {
    case 'invalid_client':
      return 'Client ID hoặc Client Secret sai. Kiểm tra lại phần đã dán, và ' +
        'chắc chắn loại ứng dụng là "TVs and Limited Input devices".';
    case 'invalid_grant':
      return 'Quyền truy cập đã bị thu hồi hoặc hết hạn. Hãy đăng nhập lại.';
    case 'access_denied':
      return 'Bạn đã từ chối cấp quyền ở màn hình của Google.';
    case 'expired_token':
      return 'Mã đã hết hạn trước khi kịp nhập. Bấm đăng nhập lại để lấy mã mới.';
    case 'admin_policy_enforced':
      return 'Chính sách quản trị của tài khoản Google chặn ứng dụng này.';
    default:
      return d || (e ? `Google báo lỗi: ${e}` : 'Google từ chối yêu cầu');
  }
}

/** Gọi một endpoint của Data API. */
async function apiGet(path, params, auth) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  if (auth.apiKey) url.searchParams.set('key', auth.apiKey);

  const headers = {};
  if (auth.accessToken) headers.Authorization = `Bearer ${auth.accessToken}`;

  const res = await fetch(url.toString(), { headers });
  let body = {};
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) throw new ApiError(describeApiError(res.status, body), apiErrorCode(body));
  return body;
}

function apiErrorCode(body) {
  return body?.error?.errors?.[0]?.reason || body?.error?.status || 'api_error';
}

function describeApiError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason || '';
  const msg = body?.error?.message || '';
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return 'Hết quota YouTube API hôm nay (10.000 unit). Quota tự reset lúc ' +
      '0h theo giờ Thái Bình Dương.';
  }
  if (reason === 'accessNotConfigured') {
    return 'Chưa bật YouTube Data API v3 cho project này trên Google Cloud.';
  }
  if (status === 401) return 'Token hết hạn hoặc bị thu hồi. Hãy đăng nhập lại.';
  if (status === 403) return msg || 'Google từ chối truy cập (403).';
  if (status === 404) return 'Không tìm thấy dữ liệu (404).';
  return msg || `Google API lỗi ${status}`;
}

// ---------------------------------------------------------------------------
// Chuẩn hoá về đúng dạng dữ liệu mà jukebox đang dùng
// ---------------------------------------------------------------------------

const bestThumb = (t) =>
  t?.medium?.url || t?.high?.url || t?.default?.url || t?.standard?.url || null;

/** playlistItems -> track. Bỏ video đã xoá/riêng tư (không phát được). */
function trackFromPlaylistItem(item) {
  const sn = item?.snippet;
  const id = item?.contentDetails?.videoId || sn?.resourceId?.videoId;
  if (!id) return null;
  const title = sn?.title || '';
  // Video bị xoá/ẩn vẫn nằm trong playlist nhưng không phát được.
  if (title === 'Deleted video' || title === 'Private video') return null;
  return {
    id,
    title,
    author: sn?.videoOwnerChannelTitle || sn?.channelTitle || '',
    duration: 0, // Data API không trả độ dài ở đây; player tự báo lại khi phát
    thumb: bestThumb(sn?.thumbnails) || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  };
}

/** videos.list -> track (có độ dài thật). */
function trackFromVideo(v) {
  const id = v?.id;
  if (!id) return null;
  return {
    id,
    title: v?.snippet?.title || id,
    author: v?.snippet?.channelTitle || '',
    duration: parseISODuration(v?.contentDetails?.duration),
    thumb: bestThumb(v?.snippet?.thumbnails) || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  };
}

/** ISO 8601 "PT4M13S" -> 253 giây. */
function parseISODuration(iso) {
  if (typeof iso !== 'string') return 0;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return (
    (Number(d) || 0) * 86400 +
    (Number(h) || 0) * 3600 +
    (Number(min) || 0) * 60 +
    (Number(s) || 0)
  );
}

function playlistFromApi(p) {
  const id = p?.id;
  if (!id) return null;
  return {
    id,
    title: p?.snippet?.title || 'Playlist',
    count: Number(p?.contentDetails?.itemCount) || 0,
    thumb: bestThumb(p?.snippet?.thumbnails),
  };
}

// ---------------------------------------------------------------------------
// Các lệnh cấp cao
// ---------------------------------------------------------------------------

/** Lặp qua các trang, gom tối đa `limit` phần tử. */
async function paginate(path, params, auth, limit, mapFn) {
  const out = [];
  const seen = new Set();
  let pageToken;
  // Chặn cứng 20 trang: tránh vòng lặp vô hạn nếu API trả nextPageToken lặp.
  for (let page = 0; page < 20; page++) {
    const body = await apiGet(path, { ...params, maxResults: 50, pageToken }, auth);
    for (const item of body.items || []) {
      const mapped = mapFn(item);
      if (!mapped || seen.has(mapped.id)) continue;
      seen.add(mapped.id);
      out.push(mapped);
      if (out.length >= limit) return out;
    }
    pageToken = body.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/** Kênh đang đăng nhập: tên, ảnh, và id các playlist hệ thống. */
async function myChannel(auth) {
  const body = await apiGet(
    'channels',
    { part: 'snippet,contentDetails', mine: 'true' },
    auth
  );
  const ch = body.items?.[0];
  if (!ch) {
    throw new ApiError(
      'Tài khoản này chưa có kênh YouTube nào, nên không đọc được playlist.',
      'no_channel'
    );
  }
  return {
    id: ch.id,
    name: ch.snippet?.title || 'Kênh YouTube',
    thumb: bestThumb(ch.snippet?.thumbnails),
    uploads: ch.contentDetails?.relatedPlaylists?.uploads || null,
    likes: ch.contentDetails?.relatedPlaylists?.likes || null,
  };
}

async function myPlaylists(auth, limit = 100) {
  return paginate('playlists', { part: 'snippet,contentDetails', mine: 'true' },
    auth, limit, playlistFromApi);
}

async function playlistTracks(auth, playlistId, limit = 200) {
  return paginate('playlistItems', { part: 'snippet,contentDetails', playlistId },
    auth, limit, trackFromPlaylistItem);
}

/** Video đã thích. Dùng videos.list để có luôn độ dài thật. */
async function likedVideos(auth, limit = 50) {
  return paginate('videos', { part: 'snippet,contentDetails', myRating: 'like' },
    auth, limit, trackFromVideo);
}

async function mySubscriptions(auth, limit = 100) {
  return paginate(
    'subscriptions',
    { part: 'snippet', mine: 'true', order: 'alphabetical' },
    auth,
    limit,
    (s) => {
      const id = s?.snippet?.resourceId?.channelId;
      if (!id) return null;
      return {
        id,
        title: s.snippet.title || 'Kênh',
        thumb: bestThumb(s.snippet.thumbnails),
      };
    }
  );
}

/** Video mới nhất của một kênh, qua playlist "uploads" của kênh đó. */
async function channelUploads(auth, channelId, limit = 50) {
  const body = await apiGet('channels', { part: 'contentDetails', id: channelId }, auth);
  const uploads = body.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new ApiError('Kênh này không có danh sách video công khai', 'no_uploads');
  return playlistTracks(auth, uploads, limit);
}

module.exports = {
  ApiError,
  SCOPE,
  requestDeviceCode,
  pollDeviceToken,
  refreshAccessToken,
  apiGet,
  myChannel,
  myPlaylists,
  playlistTracks,
  likedVideos,
  mySubscriptions,
  channelUploads,
  // để kiểm thử
  parseISODuration,
  trackFromPlaylistItem,
  trackFromVideo,
  playlistFromApi,
  describeOAuthError,
  describeApiError,
};
