/**
 * YT Jukebox - internal Volumio-style YouTube music player.
 *
 * Architecture:
 *   /player  -> opened on ONE machine connected to the speakers. This is the
 *               only place audio actually comes out. Uses the official
 *               YouTube IFrame embed player (no downloading / ripping).
 *   /remote  -> opened by anyone on the LAN (phone, laptop) to search,
 *               queue and control playback.
 *
 * The server holds all state and pushes it to every connected client over
 * WebSocket. If no /player is open, nothing plays - exactly like Volumio
 * with the output device switched off.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Innertube, YT, Mixins } = require('youtubei.js');
const gapiClient = require('./youtube-api.js');
const sysAudio = require('./audio.js');

// Phải khớp với hằng BUILD trong public/remote.html. Trang điều khiển so sánh
// hai giá trị này và cảnh báo nếu lệch — dấu hiệu service chưa được restart sau
// khi cài bản mới (file tĩnh đọc từ đĩa nên mới, còn server.js vẫn là bản cũ).
const BUILD = '2026-08-31.2';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  queue: [], // { uid, id, title, author, duration, thumb, addedBy }
  index: -1, // index into queue of the current track
  playing: false,
  volume: 60,
  position: 0,
  duration: 0,
  repeat: 'off', // 'off' | 'all' | 'one'
  shuffle: false,
  // Hết hàng chờ thì tự nối thêm bài liên quan — giống Mix của YouTube.
  // Dành cho máy chạy cả ngày: không ai phải thêm bài liên tục.
  autoRadio: false,
  radioBusy: false,
  // Khi đã chọn đài, bài nối tiếp lấy theo THỂ LOẠI chứ không bám vào bài cũ.
  station: null, // key của GENRES, hoặc null
  stationLabel: null,
  sleepAt: null, // mốc thời gian (ms) sẽ tự dừng phát, hoặc null
  // 'system' = thanh âm lượng chỉnh loa THẬT của máy chủ (qua pactl).
  // 'player' = không có pactl, đành chỉnh bên trong trình phát YouTube.
  audioMode: 'player',
  audioLabel: null,   // tên ngõ ra, ví dụ "Loa Bluetooth JBL"
  audioReason: null,  // vì sao không chỉnh được loa thật
  players: 0, // how many /player pages are connected
  remotes: 0,
};

// Giữ hàng chờ khỏi phình vô hạn khi auto-radio chạy suốt nhiều ngày.
const MAX_QUEUE = 300;
const KEEP_PLAYED = 40;

let uidSeq = 1;
const nextUid = () => `t${Date.now().toString(36)}${(uidSeq++).toString(36)}`;

const current = () =>
  state.index >= 0 && state.index < state.queue.length
    ? state.queue[state.index]
    : null;

/** Public snapshot sent to clients. */
function snapshot() {
  return {
    queue: state.queue,
    index: state.index,
    playing: state.playing,
    volume: state.volume,
    position: state.position,
    duration: state.duration,
    repeat: state.repeat,
    shuffle: state.shuffle,
    autoRadio: state.autoRadio,
    radioBusy: state.radioBusy,
    station: state.station,
    stationLabel: state.stationLabel,
    sleepAt: state.sleepAt,
    audioMode: state.audioMode,
    audioLabel: state.audioLabel,
    audioReason: state.audioReason,
    // Trang /player dùng giá trị này. Khi thanh âm lượng đang chỉnh loa thật,
    // trình phát phải để 100% — nếu không thì hai mức nhân với nhau, kéo hết cỡ
    // vẫn nhỏ, đúng cái bực mình cần sửa.
    playerVolume: state.audioMode === 'system' ? 100 : state.volume,
    players: state.players,
    remotes: state.remotes,
    current: current(),
  };
}

// ---------------------------------------------------------------------------
// YouTube scraping helpers (no API key required)
// ---------------------------------------------------------------------------

async function ytFetch(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) throw new Error(`YouTube responded ${res.status}`);
  return res.text();
}

/** Pull the ytInitialData JSON blob out of a YouTube HTML page. */
function extractInitialData(html) {
  const markers = [
    /var ytInitialData\s*=\s*/,
    /window\["ytInitialData"\]\s*=\s*/,
    /ytInitialData"\]\s*=\s*/,
  ];
  for (const marker of markers) {
    const m = marker.exec(html);
    if (!m) continue;
    const start = m.index + m[0].length;
    if (html[start] !== '{') continue;
    // Brace matching, skipping over string literals.
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

/** Recursively collect every object that has one of the given keys. */
function collect(node, key, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collect(item, key, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key && v && typeof v === 'object') out.push(v);
    else collect(v, key, out);
  }
  return out;
}

const runText = (o) =>
  o?.simpleText ||
  (Array.isArray(o?.runs) ? o.runs.map((r) => r.text).join('') : '') ||
  '';

function parseDuration(text) {
  if (!text) return 0;
  const parts = text.split(':').map((n) => parseInt(n, 10));
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

const fmtDuration = (secs) => {
  if (!secs) return '';
  const s = Math.floor(secs % 60);
  const m = Math.floor(secs / 60) % 60;
  const h = Math.floor(secs / 3600);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};

function trackFromRenderer(r) {
  const id = r.videoId;
  if (!id) return null;
  const durText =
    runText(r.lengthText) ||
    runText(r.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text) ||
    '';
  return {
    id,
    title: runText(r.title) || 'Untitled',
    author:
      runText(r.ownerText) ||
      runText(r.longBylineText) ||
      runText(r.shortBylineText) ||
      runText(r.videoOwnerRenderer?.title) ||
      '',
    duration: parseDuration(durText),
    thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  };
}

/** Fallback: search by scraping the public results page. */
async function scrapeSearch(query, limit = 25) {
  const url =
    'https://www.youtube.com/results?search_query=' +
    encodeURIComponent(query) +
    '&sp=EgIQAQ%253D%253D';
  const data = extractInitialData(await ytFetch(url));
  if (!data) throw new Error('Không đọc được kết quả từ YouTube');
  const seen = new Set();
  const out = [];
  for (const r of collect(data, 'videoRenderer')) {
    const t = trackFromRenderer(r);
    if (!t || seen.has(t.id)) continue;
    // Skip live streams (no length) to keep the queue sane.
    if (!t.duration) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** Fallback: read a public playlist by scraping its page. */
async function scrapePlaylist(listId, limit = 200) {
  const url = 'https://www.youtube.com/playlist?list=' + encodeURIComponent(listId);
  const data = extractInitialData(await ytFetch(url));
  if (!data) throw new Error('Không đọc được playlist');
  const seen = new Set();
  const out = [];
  for (const r of collect(data, 'playlistVideoRenderer')) {
    const t = trackFromRenderer(r);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** Fallback: metadata for a single video id, via the public oEmbed endpoint. */
async function oembedVideo(id) {
  const res = await fetch(
    'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id),
    { headers: { 'User-Agent': UA } }
  );
  if (!res.ok) throw new Error('Video không tồn tại hoặc bị giới hạn nhúng');
  const j = await res.json();
  return {
    id,
    title: j.title || id,
    author: j.author_name || '',
    duration: 0,
    thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  };
}

// ---------------------------------------------------------------------------
// Cấu hình lưu trên đĩa
//
// GHI CHÚ: từng có thêm hai cách đăng nhập — "mã TV" (OAuth của youtubei.js)
// và dán cookie. Cả hai đã bị bỏ hẳn:
//   - Mã TV: YouTube trả HTTP 400 cho MỌI endpoint thư viện với token client
//     TV, kể cả bộ chuyển kênh. Không vá được từ phía mình.
//   - Cookie: chạy được, nhưng cho toàn quyền tài khoản Google và phải nằm
//     trên thẻ SD của Pi. Rủi ro không đáng.
// Đăng nhập giờ chỉ đi qua YouTube Data API v3 với OAuth client của chính bạn.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('[config] không ghi được:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Lịch sử nghe — để gợi ý "bài hay nghe"
//
// YouTube không cho biết cái dàn này hay phát gì; chỉ chính nó mới biết. Nên
// đếm tại chỗ: mỗi bài nghe quá 30 giây thì +1.
//
// 30 giây là để loại các lần bấm nhầm rồi chuyển bài ngay. Bài ngắn hơn 60 giây
// thì lấy mốc nửa bài, nếu không sẽ không bao giờ được tính.
// ---------------------------------------------------------------------------

const HISTORY_PATH = path.join(DATA_DIR, 'history.json');
const COUNT_AFTER = 30;      // giây
const HISTORY_MAX = 400;     // số bài giữ lại, tránh phình file trên thẻ SD

let history = loadHistory();
let historyDirty = false;
let countedUid = null;       // bài đã tính rồi, để không cộng nhiều lần

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveHistory() {
  if (!historyDirty) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history), { mode: 0o600 });
    historyDirty = false;
  } catch (err) {
    console.error('[history] không ghi được:', err.message);
  }
}

/** Xếp hạng: nghe nhiều nhất trước, hoà thì bài nghe gần đây hơn đứng trên. */
function rankHistory() {
  return Object.values(history).sort((a, b) => b.count - a.count || b.last - a.last);
}

function notePlay(track) {
  if (!track || !track.id) return;
  const e = history[track.id] || { id: track.id, count: 0, last: 0 };
  e.title = track.title || e.title || track.id;
  e.author = track.author || e.author || '';
  e.thumb = track.thumb || e.thumb || `https://i.ytimg.com/vi/${track.id}/mqdefault.jpg`;
  if (track.duration) e.duration = track.duration;
  e.count += 1;
  e.last = Date.now();
  history[track.id] = e;

  // Cắt bớt khi quá đông: bỏ những bài ít nghe nhất / lâu không nghe nhất.
  if (Object.keys(history).length > HISTORY_MAX) {
    const keep = rankHistory().slice(0, HISTORY_MAX);
    history = Object.fromEntries(keep.map((x) => [x.id, x]));
  }
  historyDirty = true;
}

/** Gọi từ luồng 'progress' của player. Tự quyết định đã đủ lâu để tính chưa. */
function maybeCountPlay(track, position, duration) {
  if (!track || track.uid === countedUid) return;
  const need = duration && duration < 60 ? duration / 2 : COUNT_AFTER;
  if (position < need) return;
  countedUid = track.uid;
  notePlay(track);
}

function topTracks(limit = 24) {
  return rankHistory()
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      title: e.title,
      author: e.author,
      thumb: e.thumb,
      duration: e.duration || 0,
      count: e.count,
    }));
}

// Ghi xuống đĩa theo nhịp, không ghi mỗi lần đếm — thẻ SD có hạn số lần ghi.
const historyTimer = setInterval(saveHistory, 60_000);
historyTimer.unref?.();

// ---------------------------------------------------------------------------
// Giữ hàng chờ qua các lần khởi động lại
//
// Trước đây hàng chờ chỉ nằm trong bộ nhớ: restart service, cài bản mới, hay
// Pi mất điện là mất trắng. Giờ ghi xuống data/ và nạp lại lúc khởi động.
//
// Tách HAI file, vì hai thứ thay đổi với nhịp rất khác nhau:
//   queue.json    — danh sách bài + cài đặt. Đổi khi có người thêm/xoá/chuyển
//                   bài, nên ghi ngay (gom trong 1 giây). File có thể tới
//                   ~100 KB với 300 bài.
//   playhead.json — đang ở giây thứ mấy của bài nào. Đổi MỖI GIÂY khi đang
//                   phát, nhưng chỉ vài chục byte, và chỉ ghi 20 giây một lần.
// Gộp làm một thì cứ 20 giây lại ghi lại cả 100 KB — cả ngày là vài trăm MB
// ghi vô ích lên thẻ SD, thứ có giới hạn số lần ghi.
//
// Ghi kiểu "file tạm rồi đổi tên": đổi tên là thao tác nguyên tử, nên mất điện
// giữa chừng thì còn nguyên bản cũ, chứ không bao giờ ra một file JSON bị cụt
// làm hỏng luôn lần khởi động sau.
// ---------------------------------------------------------------------------

const QUEUE_PATH = path.join(DATA_DIR, 'queue.json');
const PLAYHEAD_PATH = path.join(DATA_DIR, 'playhead.json');
const QUEUE_SAVE_MS = 1000;
const PLAYHEAD_SAVE_MS = 20_000;
// Đang phát lúc tắt thì phát tiếp — nhưng chỉ khi máy phát nối lại SỚM. Pi mất
// điện cả đêm rồi 7 giờ sáng có điện lại thì không nên tự dưng mở nhạc to.
const RESUME_WINDOW_MS = 3 * 60 * 1000;

const BOOT_AT = Date.now();
let resumePlaying = false;
let lastQueueJson = '';
let lastPlayheadJson = '';
let queueTimer = null;
let playheadTimer = null;

function writeAtomic(file, text) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function queueJson() {
  return JSON.stringify({
    v: 1,
    queue: state.queue,
    index: state.index,
    playing: state.playing,
    volume: state.volume,
    repeat: state.repeat,
    shuffle: state.shuffle,
    autoRadio: state.autoRadio,
    station: state.station,
    stationLabel: state.stationLabel,
    sleepAt: state.sleepAt,
  });
}

function saveQueueNow() {
  clearTimeout(queueTimer);
  queueTimer = null;
  const text = queueJson();
  // Phần lớn các lần broadcast không đổi gì trong hàng chờ (đổi số người kết
  // nối, trạng thái loa...). So chuỗi rẻ hơn nhiều so với một lần ghi thẻ SD.
  if (text === lastQueueJson) return;
  try {
    writeAtomic(QUEUE_PATH, text);
    lastQueueJson = text;
  } catch (err) {
    console.error('[queue] không ghi được:', err.message);
  }
}

function savePlayheadNow() {
  clearTimeout(playheadTimer);
  playheadTimer = null;
  const cur = current();
  const text = JSON.stringify({
    uid: cur ? cur.uid : null,
    position: Math.floor(state.position || 0),
  });
  if (text === lastPlayheadJson) return;
  try {
    writeAtomic(PLAYHEAD_PATH, text);
    lastPlayheadJson = text;
  } catch (err) {
    console.error('[queue] không ghi được vị trí phát:', err.message);
  }
}

function saveQueueSoon() {
  if (!queueTimer) {
    queueTimer = setTimeout(saveQueueNow, QUEUE_SAVE_MS);
    queueTimer.unref?.();
  }
}

function savePlayheadSoon() {
  if (!playheadTimer) {
    playheadTimer = setTimeout(savePlayheadNow, PLAYHEAD_SAVE_MS);
    playheadTimer.unref?.();
  }
}

// Làm sạch từng bài khi nạp: file này nằm trên đĩa, sửa tay hay hỏng một nửa
// thì server vẫn phải khởi động được, chỉ bỏ qua những dòng không dùng được.
function cleanTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const id = String(t.id || '');
  if (!/^[\w-]{11}$/.test(id)) return null;
  return {
    uid: typeof t.uid === 'string' && t.uid ? t.uid : nextUid(),
    id,
    title: String(t.title || id).slice(0, 300),
    author: String(t.author || '').slice(0, 200),
    duration: Number(t.duration) || 0,
    thumb: String(t.thumb || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`),
    addedBy: String(t.addedBy || '').slice(0, 40),
  };
}

function loadQueue() {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[queue] bỏ qua file hàng chờ hỏng:', err.message);
    return false;
  }
  if (!saved || !Array.isArray(saved.queue)) return false;

  const seen = new Set();
  const queue = saved.queue.map(cleanTrack).filter((t) => {
    if (!t || seen.has(t.uid)) return false;   // uid trùng thì nút xoá/nhảy bài sẽ nhầm
    seen.add(t.uid);
    return true;
  }).slice(-MAX_QUEUE);

  state.queue = queue;
  const idx = Number.isInteger(saved.index) ? saved.index : -1;
  state.index = queue.length ? Math.min(Math.max(idx, -1), queue.length - 1) : -1;
  if (Number.isFinite(saved.volume)) state.volume = Math.max(0, Math.min(100, saved.volume));
  if (['off', 'all', 'one'].includes(saved.repeat)) state.repeat = saved.repeat;
  state.shuffle = !!saved.shuffle;
  state.autoRadio = !!saved.autoRadio;
  state.station = typeof saved.station === 'string' ? saved.station : null;
  state.stationLabel = state.station ? String(saved.stationLabel || '') || null : null;

  // Hẹn giờ tắt đã qua trong lúc server nghỉ = người ta muốn nó dừng rồi.
  const sleepPassed = saved.sleepAt && saved.sleepAt <= Date.now();
  resumePlaying = !!saved.playing && !sleepPassed && state.index >= 0;
  state.playing = false;   // chờ máy phát nối lại (xem resumeIfDue)

  // Vị trí trong bài: chỉ nhận nếu đúng là bài đang đứng.
  try {
    const ph = JSON.parse(fs.readFileSync(PLAYHEAD_PATH, 'utf8'));
    const cur = current();
    if (cur && ph && ph.uid === cur.uid && Number.isFinite(ph.position)) {
      state.position = Math.max(0, ph.position);
    }
  } catch {}

  lastQueueJson = queueJson();
  console.log(`[queue] đã nạp lại ${queue.length} bài` +
    (current() ? `, đang ở: ${current().title}` : '') +
    (resumePlaying ? ' (sẽ phát tiếp khi máy phát nối lại)' : ''));
  return true;
}

/** Gọi khi một máy phát vừa nối vào. Trả true nếu vừa bật phát lại. */
function resumeIfDue() {
  if (!resumePlaying) return false;
  resumePlaying = false;
  if (Date.now() - BOOT_AT > RESUME_WINDOW_MS) return false;
  if (!current()) return false;
  state.playing = true;
  return true;
}

// systemctl restart gửi SIGTERM. Node mặc định chết NGAY khi nhận SIGTERM mà
// KHÔNG chạy sự kiện 'exit' — nên trước đây lịch sử nghe cũng mất tới 60 giây
// cuối mỗi lần restart. Bắt tín hiệu để ghi hết xuống đĩa rồi mới thoát.
function flushAll() {
  saveQueueNow();
  savePlayheadNow();
  saveHistory();
}
process.on('exit', flushAll);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    flushAll();
    process.exit(0);
  });
}

loadQueue();

// ---------------------------------------------------------------------------
// YouTube Data API v3 — cách đăng nhập chính thức, dùng OAuth client của bạn
//
// Đây là đường dùng cho DỮ LIỆU CÁ NHÂN (playlist, đã thích, kênh đăng ký).
// Phần TÌM KIẾM vẫn đi qua youtubei.js vì search.list tốn 100 unit/lượt, dùng
// hết quota rất nhanh, trong khi youtubei.js tìm miễn phí không giới hạn.
// ---------------------------------------------------------------------------

const GAPI_TOKENS_PATH = path.join(DATA_DIR, 'gapi-tokens.json');

const gapi = {
  logged_in: false,
  channel: null, // { id, name, thumb, uploads, likes }
  pending: null, // { verification_url, user_code, expires_at }
  tokens: null,
  poller: null,
};

function gapiConfig() {
  const cfg = loadConfig().google || {};
  return {
    clientId: cfg.client_id || '',
    clientSecret: cfg.client_secret || '',
    apiKey: cfg.api_key || '',
  };
}

const gapiConfigured = () => !!gapiConfig().clientId;

function loadGapiTokens() {
  try {
    const t = JSON.parse(fs.readFileSync(GAPI_TOKENS_PATH, 'utf8'));
    return t && t.refresh_token ? t : null;
  } catch {
    return null;
  }
}

function saveGapiTokens(tokens) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(GAPI_TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    fs.chmodSync(GAPI_TOKENS_PATH, 0o600);
  } catch (err) {
    console.error('[gapi] không ghi được token:', err.message);
  }
}

function clearGapiTokens() {
  try {
    fs.unlinkSync(GAPI_TOKENS_PATH);
  } catch {}
  gapi.tokens = null;
  gapi.logged_in = false;
  gapi.channel = null;
}

/**
 * Trả về thông tin xác thực để gọi Data API, tự làm mới access token nếu hết
 * hạn. Ném lỗi rõ ràng nếu chưa đăng nhập.
 */
async function gapiAuth() {
  const cfg = gapiConfig();
  if (!cfg.clientId) throw new gapiClient.ApiError('Chưa cấu hình Client ID', 'no_config');
  if (!gapi.tokens) gapi.tokens = loadGapiTokens();
  if (!gapi.tokens) throw new gapiClient.ApiError('Chưa đăng nhập Google', 'no_login');

  if (!gapi.tokens.access_token || Date.now() >= (gapi.tokens.expires_at || 0)) {
    gapi.tokens = await gapiClient.refreshAccessToken(
      cfg.clientId,
      cfg.clientSecret,
      gapi.tokens.refresh_token
    );
    saveGapiTokens(gapi.tokens);
    console.log('[gapi] đã làm mới access token');
  }
  return { accessToken: gapi.tokens.access_token, apiKey: cfg.apiKey };
}

/** Nạp lại thông tin kênh, cũng là phép thử token còn sống hay không. */
async function refreshGapiChannel() {
  gapi.channel = await gapiClient.myChannel(await gapiAuth());
  gapi.logged_in = true;
  return gapi.channel;
}

function stopGapiPolling() {
  if (gapi.poller) clearTimeout(gapi.poller);
  gapi.poller = null;
}

/** Bắt đầu luồng nhập mã, trả mã về ngay và tự hỏi Google ở nền. */
async function startGapiLogin() {
  const cfg = gapiConfig();
  if (!cfg.clientId) {
    throw new gapiClient.ApiError(
      'Chưa có Client ID. Nhập Client ID và Client Secret từ Google Cloud trước.',
      'no_config'
    );
  }
  stopGapiPolling();

  const dc = await gapiClient.requestDeviceCode(cfg.clientId);
  gapi.pending = {
    verification_url: dc.verification_url,
    user_code: dc.user_code,
    expires_at: Date.now() + dc.expires_in * 1000,
  };

  let interval = dc.interval * 1000;
  const tick = async () => {
    if (!gapi.pending || Date.now() > gapi.pending.expires_at) {
      gapi.pending = null;
      return;
    }
    try {
      const r = await gapiClient.pollDeviceToken(cfg.clientId, cfg.clientSecret, dc.device_code);
      if (r.status === 'ok') {
        gapi.tokens = r.tokens;
        saveGapiTokens(gapi.tokens);
        gapi.pending = null;
        await refreshGapiChannel();
        console.log('[gapi] đăng nhập thành công:', gapi.channel?.name);
        return;
      }
      // Google yêu cầu chậm lại thì phải nghe, nếu không sẽ bị chặn.
      if (r.status === 'slow_down') interval += 5000;
    } catch (err) {
      console.warn('[gapi] luồng đăng nhập dừng:', err.message);
      gapi.pending = null;
      gapi.lastError = err.message;
      return;
    }
    gapi.poller = setTimeout(tick, interval);
  };
  gapi.poller = setTimeout(tick, interval);

  return gapi.pending;
}

function gapiLogout() {
  stopGapiPolling();
  gapi.pending = null;
  gapi.lastError = null;
  clearGapiTokens();
}

/** Khôi phục đăng nhập Data API lúc khởi động (chạy nền, không chặn). */
async function restoreGapi() {
  if (!gapiConfigured()) return;
  if (!loadGapiTokens()) return;
  try {
    await refreshGapiChannel();
    console.log('[gapi] đã khôi phục đăng nhập:', gapi.channel?.name);
  } catch (err) {
    console.warn('[gapi] token cũ không dùng được:', err.message);
    gapi.lastError = err.message;
  }
}

// ---------------------------------------------------------------------------
// Innertube (youtubei.js) - backend tìm kiếm chính
//
// Nói chuyện với InnerTube API nội bộ của YouTube: không cần API key, không
// dính quota, và thư viện được cập nhật upstream mỗi khi YouTube đổi cấu trúc.
// Nếu vì lý do gì đó hỏng, tự động rơi về scraper ở trên.
// ---------------------------------------------------------------------------

let innertubePromise = null;
let innertubeBrokenUntil = 0;

async function getInnertube() {
  if (Date.now() < innertubeBrokenUntil) {
    const e = new Error('Innertube đang tạm nghỉ');
    e.isBackoff = true; // không tính là lỗi mới, nếu không cửa sổ backoff sẽ bị gia hạn vô hạn
    throw e;
  }
  if (!innertubePromise) {
    innertubePromise = createInnertube().catch((e) => {
      innertubePromise = null;
      throw e;
    });
  }
  return innertubePromise;
}

/** Tạo phiên Innertube, và khôi phục đăng nhập từ file token nếu có. */
async function createInnertube() {
  // retrieve_player: false -> bỏ qua bước tải/giải mã player, ta chỉ cần metadata.
  const opts = { retrieve_player: false };
  const cfg = loadConfig();
  if (cfg.on_behalf_of_user) {
    // Tài khoản Google có nhiều kênh (brand account) -> chỉ định đúng kênh,
    // nếu không YouTube trả về kênh mặc định (có thể là profile trẻ em).
    opts.on_behalf_of_user = cfg.on_behalf_of_user;
    console.log('[auth] dùng kênh đã chọn:', cfg.profile_name || cfg.on_behalf_of_user);
  }
  // Phiên này KHÔNG đăng nhập. Nó chỉ lo tìm kiếm, đọc playlist công khai và
  // lấy danh sách bài liên quan — ba việc không cần tài khoản. Dữ liệu cá nhân
  // đi hoàn toàn qua YouTube Data API ở phần dưới.
  return Innertube.create(opts);
}

/** Lùi 60s trước khi thử lại, để mỗi lượt tìm không phải chờ timeout hai lần. */
function noteInnertubeFailure(err) {
  if (err && err.isBackoff) return; // đang trong cửa sổ chờ, đừng gia hạn thêm
  innertubeBrokenUntil = Date.now() + 60000;
  innertubePromise = null;
  ytHealth.lastErrAt = Date.now();
  ytHealth.lastError = err.message;
  ytHealth.last = 'err';
  ytHealth.fails += 1;
  console.warn('[innertube] lỗi, dùng scraper dự phòng:', err.message);
}

// ---------------------------------------------------------------------------
// Theo dõi sức khoẻ đường ra YouTube
//
// youtubei.js đọc API NỘI BỘ của YouTube, mà YouTube đổi nội bộ vài tháng một
// lần. Khi đó hệ thống lặng lẽ tụt xuống scraper rồi tắt hẳn, và người dùng chỉ
// biết lúc bấm tìm thấy màn hình trống — không ai đoán ra là phải nâng thư viện.
//
// Nên ghi lại: lần lấy được dữ liệu gần nhất, lỗi gần nhất, đi bằng đường nào.
// ---------------------------------------------------------------------------

const ytHealth = {
  lastOkAt: 0,
  lastOkVia: null,     // 'innertube' | 'scraper'
  lastErrAt: 0,
  lastError: null,
  // Sự kiện gần nhất là gì. KHÔNG so sánh lastErrAt với lastOkAt: đồng hồ chỉ
  // tới mili-giây, mà một lượt tìm hỏng rồi lùi sang scraper diễn ra trong cùng
  // một mili-giây — so mốc thời gian sẽ ra kết quả tuỳ may rủi.
  last: null,          // 'ok' | 'err'
  ok: 0,
  fails: 0,
};

function noteYtOk(via) {
  ytHealth.lastOkAt = Date.now();
  ytHealth.lastOkVia = via;
  ytHealth.last = 'ok';
  ytHealth.ok += 1;
}

/**
 * Tóm tắt tình trạng cho /healthz và cho cảnh báo trên trang điều khiển.
 *
 * status:
 *   'ok'      — đường chính (innertube) đang chạy
 *   'degraded'— chỉ còn scraper dự phòng: vẫn tìm được nhưng ít dữ liệu hơn và
 *               dễ hỏng, đây là lúc nên nâng youtubei.js
 *   'down'    — không lấy được gì
 *   'idle'    — chưa gọi lần nào kể từ khi khởi động, chưa kết luận được
 */
function ytStatus() {
  const { lastOkAt, lastErrAt, lastOkVia, last } = ytHealth;
  let status;
  if (!lastOkAt && !lastErrAt) status = 'idle';
  else if (!lastOkAt) status = 'down';
  else if (lastOkVia === 'scraper') status = 'degraded';
  else if (last === 'err') status = 'degraded';
  else status = 'ok';

  return {
    status,
    via: lastOkVia,
    lastOkAt: lastOkAt || null,
    lastErrAt: lastErrAt || null,
    lastError: ytHealth.lastError,
    ok: ytHealth.ok,
    fails: ytHealth.fails,
    // Gợi ý cách sửa ngay trong dữ liệu, để trang điều khiển khỏi phải đoán.
    hint: status === 'ok' || status === 'idle'
      ? null
      : 'YouTube có thể đã đổi API nội bộ. Trên máy chủ chạy: sudo bash update.sh',
  };
}

const textOf = (t) => (typeof t === 'string' ? t : t?.text || '');

/**
 * Chuẩn hoá một node của youtubei.js về dạng track của mình.
 * Xử lý cả Video, PlaylistVideo và LockupView (dạng node mới của YouTube).
 */
function trackFromNode(v) {
  if (!v) return null;
  if (v.content_type && v.content_type !== 'VIDEO' && v.content_type !== 'SHORT') return null;

  const id = v.video_id || v.content_id || (typeof v.id === 'string' ? v.id : null);
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;

  const thumbs =
    v.thumbnails || v.thumbnail || v.content_image?.image || v.content_image?.primary_thumbnail?.image || [];

  return {
    id,
    title: textOf(v.title) || textOf(v.metadata?.title) || id,
    author: v.author?.name || textOf(v.author) || '',
    duration: Number(v.duration?.seconds) || 0,
    thumb: thumbs[0]?.url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
  };
}

/** Gom track từ bất kỳ feed nào của youtubei.js, bỏ trùng. */
function feedTracks(feed, limit = 60) {
  const seen = new Set();
  const out = [];
  for (const v of feed?.videos || []) {
    if (v.is_live) continue;
    const t = trackFromNode(v);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Lấy danh sách bài "liên quan" — chính là thứ sinh ra các Mix của YouTube.
 *
 * VÌ SAO KHÔNG DÙNG DATA API: Data API không đọc được playlist tự sinh (id bắt
 * đầu bằng RD), và tham số relatedToVideoId của search.list đã bị YouTube gỡ
 * từ 8/2023. Đường duy nhất còn lại là endpoint /next của InnerTube — thứ mà
 * chính trang xem video dùng để dựng danh sách bên phải.
 *
 * Không cần đăng nhập, không tốn quota.
 */
async function ytRelated(videoId, limit = 20) {
  const yt = await getInnertube();

  // Ưu tiên gọi thẳng /next: nhẹ hơn getInfo và không phụ thuộc vào JS player
  // (server chạy với retrieve_player: false).
  try {
    const resp = await yt.actions.execute('/next', { videoId, parse: true });
    const feed = new Mixins.Feed(yt.actions, resp, true);
    const out = feedTracks(feed, limit + 1).filter((t) => t.id !== videoId);
    if (out.length) { noteYtOk('innertube'); return out.slice(0, limit); }
  } catch (err) {
    console.warn('[radio] /next thất bại, thử getInfo:', err.message);
  }

  const info = await yt.getInfo(videoId);
  const seen = new Set([videoId]);
  const out = [];
  for (const v of info.watch_next_feed || []) {
    const t = trackFromNode(v);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Đài theo thể loại
//
// Mix dựa trên MỘT bài chỉ quanh quẩn gần bài đó. Muốn "cả buổi toàn nhạc
// vàng" thì phải bám vào thể loại, nên mỗi đài là một nhóm từ khoá tìm kiếm.
// Mỗi lần rót bài lại bốc ngẫu nhiên một từ khoá trong nhóm, để nghe cả ngày
// không bị lặp đúng một danh sách.
// ---------------------------------------------------------------------------

// Từ khoá cố ý KHÔNG dùng "hay nhất", "tuyển tập", "top 20" — mấy cụm đó trên
// YouTube dẫn thẳng tới video tổng hợp một tiếng. Thay bằng "official mv" /
// "official audio", là cách các hãng đặt tên bản phát hành chính thức của
// từng bài.
const GENRES = [
  { key: 'tre', label: 'Nhạc trẻ',
    queries: ['nhạc trẻ official mv', 'ca khúc việt mới official music video',
              'nhạc việt official audio', 'mv nhạc trẻ mới ra mắt'] },
  { key: 'bolero', label: 'Bolero · Nhạc vàng',
    queries: ['bolero official mv', 'nhạc vàng official audio',
              'trữ tình bolero mv chính thức', 'nhạc vàng thu âm phòng thu'] },
  { key: 'tiktok', label: 'Nhạc TikTok',
    queries: ['nhạc hot tiktok official mv', 'bài hát trend tiktok official audio',
              'nhạc tiktok bản gốc official'] },
  { key: 'rap', label: 'Rap Việt',
    queries: ['rap việt official mv', 'rap việt official audio', 'mv rap việt mới'] },
  { key: 'lofi', label: 'Lofi · Chill',
    queries: ['lofi việt official', 'bản lofi cover việt', 'nhạc việt bản lofi'] },
  { key: 'remix', label: 'Remix · EDM',
    queries: ['nhạc việt remix official', 'edm việt official mv', 'bản remix official audio'] },
  { key: 'acoustic', label: 'Acoustic',
    queries: ['acoustic việt official', 'bản acoustic cover việt', 'nhạc việt acoustic version'] },
  { key: 'hoa', label: 'Nhạc Hoa lời Việt',
    queries: ['nhạc hoa lời việt official mv', 'nhạc hoa lời việt official audio'] },
  { key: 'khongloi', label: 'Không lời',
    queries: ['hoà tấu không lời', 'piano cover nhạc việt', 'guitar cover nhạc việt không lời'] },
  { key: 'trinh', label: 'Nhạc Trịnh',
    queries: ['nhạc trịnh công sơn official', 'ca khúc trịnh công sơn thu âm',
              'nhạc trịnh acoustic cover'] },
];

const genreByKey = (key) => GENRES.find((g) => g.key === key) || null;

/**
 * Lọc bớt thứ không phải bài hát.
 * Shorts là nguồn rác lớn nhất khi rót bài tự động — chúng dài vài chục giây
 * nên hàng chờ sẽ nhảy bài liên tục.
 */
// Một bài hát lẻ hiếm khi dài quá 12 phút. Video dài hơn gần như chắc chắn là
// bản tổng hợp / liên khúc một tiếng.
const MAX_SONG_SECONDS = 12 * 60;

// Dấu hiệu tổng hợp trong tiêu đề. Tìm "nhạc trẻ hay nhất" trên YouTube ra
// toàn video 1 tiếng kiểu "LK Nhạc Trẻ | BXH Top 20", nên phải lọc bằng cả
// tiêu đề chứ không chỉ độ dài — nhiều bản tổng hợp không khai độ dài.
const COMPILATION_RE = new RegExp([
  '\\blk\\b', 'liên\\s*khúc', 'lien\\s*khuc',
  'tổng\\s*hợp', 'tuyển\\s*tập', 'tuyển\\s*chọn', 'chọn\\s*lọc',
  'nonstop', 'non\\s*stop', 'playlist', 'mixtape', '\\bmedley\\b',
  '\\balbum\\b', '\\bbxh\\b', 'bảng\\s*xếp\\s*hạng',
  'top\\s*\\d+', 'top\\s*hits?', 'top\\s*những',
  'hay\\s*nhất', 'hot\\s*trend\\s*\\d', 'triệu\\s*view',
  '\\d+\\s*(bài|ca\\s*khúc)', 'những\\s*(bài|ca\\s*khúc|bản)',
  'liveshow', 'mashup\\s*\\d',
].join('|'), 'i');

/**
 * Trông có giống MỘT bài hát không?
 *
 * strict = false chỉ loại rác rõ ràng (clip vụn, Shorts). Dùng làm lưới dự
 * phòng khi lọc chặt không còn bài nào — thà có nhạc để nghe còn hơn danh sách
 * trống trơn.
 */
function isSongLike(t, { strict = false } = {}) {
  if (!t || !t.id) return false;
  if (t.duration && t.duration < 70) return false;
  if (/#shorts?\b/i.test(t.title || '')) return false;
  if (!strict) return true;
  if (t.duration && t.duration > MAX_SONG_SECONDS) return false;
  if (COMPILATION_RE.test(t.title || '')) return false;
  return true;
}

/** Lấy một mẻ bài của một thể loại. */
/**
 * Lấy một mẻ bài lẻ cho một thể loại.
 *
 * Trả về { items, hiddenSkipped, exhausted }.
 *
 * `search` chỉ để bài kiểm thử tiêm hàm giả — máy chạy test bị YouTube chặn,
 * không có nó thì vòng lặp nhiều từ khoá dưới đây không kiểm được lần nào.
 *
 * ĐÃ GẶP THẬT: chỉ hỏi MỘT từ khoá ngẫu nhiên, nên gạt vài chục bài là mẻ đó
 * cạn sạch và màn hình trống trơn. Giờ hỏi lần lượt các từ khoá của thể loại
 * cho tới khi đủ bài, và nếu vẫn không ra thì nói rõ "bạn đã ẩn hết rồi" chứ
 * không im lặng trả về danh sách rỗng.
 */
async function genreTracks(key, limit = 25, { search = ytSearch } = {}) {
  const g = genreByKey(key);
  if (!g) throw new Error('Không có thể loại này');

  const seen = new Set();
  const pool = [];
  let hiddenSkipped = 0;
  let lastErr = null;

  for (const q of shuffled(g.queries)) {
    let found = [];
    try {
      found = await search(q, 60);
    } catch (err) {
      lastErr = err;
      continue;   // từ khoá này hỏng thì thử từ khoá kế, đừng bỏ cuộc ngay
    }
    for (const t of found) {
      if (!t || !t.id || seen.has(t.id)) continue;
      seen.add(t.id);
      if (!notHidden(t)) { hiddenSkipped++; continue; }
      pool.push(t);
    }
    // Xin dư gấp đôi để phía giao diện còn bài dự phòng mà thế chỗ khi gạt.
    if (pool.length >= limit * 2) break;
  }

  if (!pool.length && lastErr && !seen.size) throw lastErr;

  const strict = pool.filter((t) => isSongLike(t, { strict: true }));
  const out = strict.length >= 5 ? strict : pool.filter((t) => isSongLike(t));
  return {
    items: out.slice(0, limit),
    hiddenSkipped,
    // Không còn bài nào MÀ lý do là đã ẩn hết — khác hẳn với "YouTube không
    // trả về gì", và cách sửa cũng khác hẳn.
    exhausted: out.length === 0 && hiddenSkipped > 0,
  };
}

/** Tìm video trên YouTube. */
// Nhớ tạm kết quả tìm trong ít phút.
//
// Mở tab Home một lần là gọi tìm kiếm cho CẢ danh sách gợi ý lẫn 5 playlist —
// cùng những từ khoá đó. Đổi thể loại rồi quay lại cũng vậy. Không nhớ tạm thì
// Pi ngồi chờ mạng suốt, và YouTube cũng dễ chặn IP vì gọi quá dày.
const SEARCH_TTL = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 40;
const searchCache = new Map();

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_TTL) { searchCache.delete(key); return null; }
  return hit.items;
}

function cacheSet(key, items) {
  // Map giữ thứ tự chèn, nên phần tử đầu tiên là cái cũ nhất.
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    searchCache.delete(searchCache.keys().next().value);
  }
  searchCache.set(key, { at: Date.now(), items });
}

async function ytSearch(query, limit = 25) {
  const key = `${query}\u0000${limit}`;
  const cached = cacheGet(key);
  // Trả bản sao: nơi gọi có thể sắp xếp / cắt bớt, đừng để nó sửa vào cache.
  if (cached) return cached.slice();

  try {
    const yt = await getInnertube();
    const res = await yt.search(query, { type: 'video' });
    const seen = new Set();
    const out = [];
    for (const v of res.videos || []) {
      if (v.is_live) continue; // livestream không có độ dài, bỏ qua
      const t = trackFromNode(v);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= limit) break;
    }
    if (out.length) { noteYtOk('innertube'); cacheSet(key, out); return out.slice(); }
    throw new Error('Innertube trả về 0 kết quả');
  } catch (err) {
    noteInnertubeFailure(err);
    // Scraper chạy được vẫn là "còn nghe được", nhưng phải ghi rõ là đường phụ.
    const fallback = await scrapeSearch(query, limit);
    if (fallback.length) { noteYtOk('scraper'); cacheSet(key, fallback); }
    return fallback.slice();
  }
}

/** Đọc toàn bộ video trong một playlist công khai. */
async function ytPlaylist(listId, limit = 200) {
  try {
    const yt = await getInnertube();
    let pl = await yt.getPlaylist(listId);
    const seen = new Set();
    const out = [];
    for (let page = 0; page < 20; page++) {
      for (const v of pl.items || pl.videos || []) {
        const t = trackFromNode(v);
        if (!t || seen.has(t.id)) continue;
        seen.add(t.id);
        out.push(t);
        if (out.length >= limit) break;
      }
      if (out.length >= limit || !pl.has_continuation) break;
      pl = await pl.getContinuation();
    }
    if (out.length) return out;
    throw new Error('Playlist rỗng hoặc không đọc được');
  } catch (err) {
    noteInnertubeFailure(err);
    return scrapePlaylist(listId, limit);
  }
}

/** Metadata của một video theo id. */
async function ytVideo(id) {
  try {
    const yt = await getInnertube();
    const b = (await yt.getBasicInfo(id)).basic_info || {};
    return {
      id,
      title: b.title || id,
      author: b.author || b.channel?.name || '',
      duration: Number(b.duration) || 0,
      thumb: b.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    };
  } catch (err) {
    noteInnertubeFailure(err);
    return oembedVideo(id);
  }
}

/** Recognise a pasted YouTube URL / bare id. */
function parseYouTubeInput(input) {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return { video: s };
  let u;
  try {
    u = new URL(s.startsWith('http') ? s : 'https://' + s);
  } catch {
    return null;
  }
  if (!/(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be|music\.youtube\.com)$/i.test(u.hostname))
    return null;
  const list = u.searchParams.get('list');
  const v = u.searchParams.get('v');
  if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return { video: v, list };
  if (u.hostname.endsWith('youtu.be')) {
    const id = u.pathname.slice(1).split('/')[0];
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) return { video: id, list };
  }
  const m = /\/(embed|shorts|v|live)\/([A-Za-z0-9_-]{11})/.exec(u.pathname);
  if (m) return { video: m[2], list };
  if (list) return { list };
  return null;
}

// ---------------------------------------------------------------------------
// Playback logic
// ---------------------------------------------------------------------------

function pickNextIndex(step) {
  const n = state.queue.length;
  if (n === 0) return -1;
  if (state.shuffle && n > 1) {
    let i;
    do {
      i = Math.floor(Math.random() * n);
    } while (i === state.index);
    return i;
  }
  const i = state.index + step;
  if (i < 0) return state.repeat === 'all' ? n - 1 : 0;
  if (i >= n) return state.repeat === 'all' ? 0 : -1;
  return i;
}

function goTo(i, autoplay = true) {
  if (i < 0 || i >= state.queue.length) {
    state.index = -1;
    state.playing = false;
    state.position = 0;
    state.duration = 0;
  } else {
    state.index = i;
    // Nhảy tới một bài khác nghĩa là bài mới, cho phép đếm lại từ đầu.
    countedUid = null;
    state.position = 0;
    state.duration = state.queue[i].duration || 0;
    state.playing = autoplay;
  }
  broadcast();
}

/**
 * Nối thêm bài liên quan vào cuối hàng chờ, dựa trên bài vừa nghe.
 * Trả về số bài đã thêm.
 */
async function extendWithRadio(seedTrack, { forceSeed = false } = {}) {
  if (state.radioBusy) return 0;
  if (!state.station && !seedTrack) return 0;
  state.radioBusy = true;
  broadcast();

  // Đã chọn đài thì bám THỂ LOẠI. Không có đài mới bám vào bài vừa nghe.
  // forceSeed: người dùng bấm 📻 trên một bài cụ thể -> họ muốn mix của ĐÚNG
  // bài đó, kể cả khi đang mở đài.
  const byStation = !!state.station && !(forceSeed && seedTrack);
  const source = byStation ? state.stationLabel : `Mix: ${seedTrack.title}`;

  try {
    let pool;
    if (byStation) {
      pool = (await genreTracks(state.station, 30)).items;
    } else {
      // Feed "bài liên quan" cũng đầy video tổng hợp một tiếng. Lọc chặt
      // trước, hết bài mới nới — giống genreTracks.
      const rel = (await ytRelated(seedTrack.id, 30)).filter(notHidden);
      const strict = rel.filter((t) => isSongLike(t, { strict: true }));
      pool = strict.length >= 5 ? strict : rel.filter((t) => isSongLike(t));
    }

    // Không thêm lại bài đã có trong hàng chờ, tránh lặp vòng vài bài.
    const have = new Set(state.queue.map((t) => t.id));
    const fresh = pool.filter((t) => !have.has(t.id)).slice(0, 10);
    if (!fresh.length) {
      console.warn('[radio] không tìm được bài mới nào cho', source);
      return 0;
    }
    state.queue.push(
      ...fresh.map((t) => ({
        uid: nextUid(),
        id: t.id,
        title: t.title,
        author: t.author,
        duration: t.duration || 0,
        thumb: t.thumb,
        addedBy: byStation ? state.stationLabel : 'Mix tự động',
      }))
    );
    trimQueue();
    console.log(`[radio] thêm ${fresh.length} bài — nguồn: ${source}`);
    return fresh.length;
  } catch (err) {
    console.error('[radio] lỗi:', err.message);
    return 0;
  } finally {
    state.radioBusy = false;
  }
}

// --- Hẹn giờ dừng phát -----------------------------------------------------

let sleepTimer = null;

function toastRemotes(text) {
  const msg = JSON.stringify({ type: 'toast', text });
  for (const c of wss.clients)
    if (c.role === 'remote' && c.readyState === c.OPEN) c.send(msg);
}

/**
 * Hẹn giờ dừng. minutes <= 0 hoặc không truyền = huỷ hẹn giờ.
 *
 * Chỉ tạm dừng chứ không xoá hàng chờ: sáng hôm sau bấm ▶ là nghe tiếp đúng
 * chỗ cũ. Dừng ngay tại mốc, không đợi hết bài — để "6 giờ tắt nhạc" đúng
 * nghĩa là 6 giờ.
 */
function setSleep(minutes) {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }
  const mins = Number(minutes) || 0;
  if (mins <= 0) {
    state.sleepAt = null;
    broadcast();
    return;
  }
  const ms = mins * 60000;
  state.sleepAt = Date.now() + ms;
  sleepTimer = setTimeout(() => {
    sleepTimer = null;
    state.sleepAt = null;
    state.playing = false;
    console.log('[sleep] tới giờ hẹn, đã dừng phát');
    toastRemotes('Hết giờ hẹn — đã dừng phát nhạc');
    broadcast();
  }, ms);
  console.log(`[sleep] sẽ dừng sau ${mins} phút`);
  broadcast();
}

/** Cắt bớt các bài ĐÃ PHÁT ở đầu hàng chờ khi nó phình quá to. */
function trimQueue() {
  if (state.queue.length <= MAX_QUEUE) return;
  const drop = Math.min(state.index - KEEP_PLAYED, state.queue.length - MAX_QUEUE);
  if (drop <= 0) return;
  state.queue.splice(0, drop);
  state.index -= drop;
}

async function onTrackEnded() {
  if (state.repeat === 'one') {
    state.position = 0;
    sendToPlayers({ type: 'cmd', cmd: 'seek', to: 0 });
    state.playing = true;
    broadcast();
    return;
  }

  const finished = current();
  let next = pickNextIndex(1);

  // Hết bài mà bật auto-radio thì nối thêm rồi đi tiếp, thay vì dừng hẳn.
  if (next === -1 && state.autoRadio && finished) {
    const added = await extendWithRadio(finished);
    if (added > 0) next = pickNextIndex(1);
  }

  if (next === -1) {
    state.playing = false;
    state.position = 0;
    broadcast();
  } else {
    goTo(next, true);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '256kb' }));
// Trang HTML KHÔNG được cache.
//
// Đã gặp thật: cài bản mới, restart service, nhưng điện thoại vẫn hiện giao
// diện cũ — Chrome lấy remote.html từ bộ nhớ cache mà không hỏi lại server.
// Trang đã "Thêm vào màn hình chính" còn dai hơn. Ảnh/icon vẫn cache bình
// thường vì chúng gần như không bao giờ đổi.
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (/\.(html|webmanifest)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

app.get('/', (_req, res) => res.redirect('/remote'));

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Thiếu từ khoá' });

  try {
    const parsed = parseYouTubeInput(q);
    if (parsed?.list) {
      const items = await ytPlaylist(parsed.list);
      if (items.length) return res.json({ kind: 'playlist', items });
    }
    if (parsed?.video) {
      return res.json({ kind: 'video', items: [await ytVideo(parsed.video)] });
    }
    res.json({ kind: 'search', items: await ytSearch(q) });
  } catch (err) {
    console.error('[search]', err.message);
    res.status(502).json({ error: err.message || 'Tìm kiếm thất bại' });
  }
});

// --- YouTube Data API v3 (đăng nhập chính thức) ------------------------

app.get('/api/gapi/status', (_req, res) => {
  const cfg = gapiConfig();
  res.json({
    configured: !!cfg.clientId,
    has_secret: !!cfg.clientSecret,
    has_api_key: !!cfg.apiKey,
    logged_in: gapi.logged_in,
    channel: gapi.channel,
    pending: gapi.pending && gapi.pending.expires_at > Date.now() ? gapi.pending : null,
    last_error: gapi.lastError || null,
    // Data API không hề có hai thứ này, nói thẳng để giao diện khỏi bày ra.
    supports: { playlists: true, liked: true, subscriptions: true, history: false, home: false },
  });
});

app.post('/api/gapi/config', (req, res) => {
  const clientId = String(req.body?.clientId || '').trim();
  const clientSecret = String(req.body?.clientSecret || '').trim();
  const apiKey = String(req.body?.apiKey || '').trim();

  if (clientId && !/\.apps\.googleusercontent\.com$/.test(clientId)) {
    return res.status(400).json({
      error: 'Client ID phải kết thúc bằng .apps.googleusercontent.com — ' +
        'có vẻ bạn đang dán nhầm API key hoặc Client Secret.',
    });
  }

  const cfg = loadConfig();
  if (clientId) cfg.google = { client_id: clientId, client_secret: clientSecret, api_key: apiKey };
  else delete cfg.google;
  saveConfig(cfg);

  // Đổi client thì token cũ vô nghĩa.
  gapiLogout();
  res.json({ ok: true, configured: !!clientId });
});

app.post('/api/gapi/login', async (_req, res) => {
  try {
    res.json(await startGapiLogin());
  } catch (err) {
    console.error('[gapi/login]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/gapi/logout', (_req, res) => {
  gapiLogout();
  res.json({ ok: true });
});

// --- Dữ liệu cá nhân ---------------------------------------------------

app.get('/api/me/playlists', async (_req, res) => {
  // Ưu tiên Data API: đây là đường duy nhất thấy được playlist riêng tư.
  if (gapi.logged_in) {
    try {
      const auth = await gapiAuth();
      const items = await gapiClient.myPlaylists(auth);
      // Thêm "Video đã thích" như một playlist cho tiện.
      if (gapi.channel?.likes) {
        items.unshift({
          id: gapi.channel.likes,
          title: 'Video đã thích',
          count: 0,
          thumb: null,
        });
      }
      return res.json({ items, source: 'gapi' });
    } catch (err) {
      console.error('[me/playlists gapi]', err.message);
      return res.status(502).json({ error: err.message });
    }
  }

  res.status(401).json({ error: 'Cần đăng nhập bằng YouTube Data API' });
});

/** Video đã thích — Data API có, đường youtubei.js kiểu TV thì không. */
app.get('/api/me/liked', async (_req, res) => {
  if (!gapi.logged_in) {
    return res.status(401).json({ error: 'Cần đăng nhập bằng YouTube Data API' });
  }
  try {
    res.json({ items: await gapiClient.likedVideos(await gapiAuth()) });
  } catch (err) {
    console.error('[me/liked]', err.message);
    res.status(502).json({ error: err.message });
  }
});

/** Kênh đã đăng ký. */
app.get('/api/me/subscriptions', async (_req, res) => {
  if (!gapi.logged_in) {
    return res.status(401).json({ error: 'Cần đăng nhập bằng YouTube Data API' });
  }
  try {
    res.json({ items: await gapiClient.mySubscriptions(await gapiAuth()) });
  } catch (err) {
    console.error('[me/subscriptions]', err.message);
    res.status(502).json({ error: err.message });
  }
});

/** Video mới nhất của một kênh đã đăng ký. */
app.get('/api/channel/:id/uploads', async (req, res) => {
  if (!gapi.logged_in) {
    return res.status(401).json({ error: 'Cần đăng nhập bằng YouTube Data API' });
  }
  try {
    res.json({ items: await gapiClient.channelUploads(await gapiAuth(), req.params.id) });
  } catch (err) {
    console.error('[channel/uploads]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/playlist/:id', async (req, res) => {
  // Data API đọc được cả playlist riêng tư; đường công khai thì không.
  if (gapi.logged_in) {
    try {
      const items = await gapiClient.playlistTracks(await gapiAuth(), req.params.id);
      if (items.length) return res.json({ items, source: 'gapi' });
    } catch (err) {
      console.warn('[playlist gapi] thất bại, thử đường công khai:', err.message);
    }
  }
  try {
    res.json({ items: await ytPlaylist(req.params.id), source: 'public' });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Danh sách thể loại cho chế độ nghe liên tục. */
app.get('/api/genres', (_req, res) =>
  res.json({ genres: GENRES.map((g) => ({ key: g.key, label: g.label })), active: state.station }));

/** Xem trước bài của một thể loại (không thêm vào hàng chờ). */
app.get('/api/genre/:key', async (req, res) => {
  try {
    res.json(await genreTracks(req.params.key, 30));
  } catch (err) {
    console.error('[api/genre]', err.message);
    res.status(502).json({ error: err.message });
  }
});

/** Xem trước danh sách bài liên quan của một video (không thêm vào hàng chờ). */
app.get('/api/radio/:videoId', async (req, res) => {
  try {
    res.json({ items: await ytRelated(req.params.videoId, 25) });
  } catch (err) {
    console.error('[api/radio]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Bài bị ẩn — "đừng gợi ý cái này nữa"
//
// Gạt một bài đi mà lần sau nó lại hiện thì gạt để làm gì. Nên nhớ lại, và áp
// cho MỌI chỗ gợi ý: đài thể loại, ghép mix, tự nối bài liên quan.
//
// KHÔNG áp cho tìm kiếm: gõ đúng tên một bài mà không thấy nó đâu thì còn khó
// hiểu hơn nhiều.
// ---------------------------------------------------------------------------

const HIDDEN_PATH = path.join(DATA_DIR, 'hidden.json');
const HIDDEN_MAX = 1000;

let hidden = loadHidden();

function loadHidden() {
  try {
    const raw = JSON.parse(fs.readFileSync(HIDDEN_PATH, 'utf8'));
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveHidden() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(HIDDEN_PATH, JSON.stringify([...hidden]), { mode: 0o600 });
  } catch (err) {
    console.error('[hidden] không ghi được:', err.message);
  }
}

function hideTrack(id) {
  if (!id) return false;
  hidden.add(id);
  // Giữ danh sách khỏi phình vô hạn: bỏ những id ẩn lâu nhất.
  if (hidden.size > HIDDEN_MAX) hidden = new Set([...hidden].slice(-HIDDEN_MAX));
  saveHidden();
  return true;
}

function unhideTrack(id) {
  const had = hidden.delete(id);
  if (had) saveHidden();
  return had;
}

const notHidden = (t) => t && !hidden.has(t.id);

// ---------------------------------------------------------------------------
// Tự ghép "liên khúc" từ bài lẻ official
//
// Video tổng hợp 1 tiếng trên YouTube nghe tiện nhưng phá hàng chờ: nó là MỘT
// mục, bấm bài kế là mất luôn 50 phút còn lại, và thống kê nghe sai bét. Nên
// mình tự ghép: 15 bài lẻ official, vẫn liền mạch mà mỗi bài là một mục riêng.
// ---------------------------------------------------------------------------

const MIX_SIZE = 15;

/** Trộn tại chỗ (Fisher–Yates). Không dùng sort(() => Math.random()-0.5): cách
 *  đó cho phân phối lệch, vài bài gần như luôn đứng đầu. */
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Gộp nhiều mẻ kết quả, bỏ trùng id, lọc lấy bài lẻ. */
function mergeSongs(batches) {
  const seen = new Set();
  const all = [];
  for (const batch of batches) {
    for (const t of batch || []) {
      if (!t || !t.id || seen.has(t.id)) continue;
      seen.add(t.id);
      all.push(t);
    }
  }
  const fresh = all.filter(notHidden);
  const strict = fresh.filter((t) => isSongLike(t, { strict: true }));
  // Nới lưới khi lọc chặt còn quá ít, giống genreTracks.
  return strict.length >= 5 ? strict : fresh.filter((t) => isSongLike(t));
}

/**
 * Ghép một mix tối đa MIX_SIZE bài.
 *
 * source:
 *   'genre'   -> gộp TẤT CẢ từ khoá của thể loại (không chỉ một cái ngẫu nhiên
 *                như đài), nên mix đa dạng hơn hẳn.
 *   'query'   -> từ khoá người dùng gõ, thêm đuôi official để tránh tổng hợp.
 *   'history' -> lấy bài hay nghe làm hạt giống rồi tìm bài liên quan.
 */
async function mixPool({ source, genre, query }) {
  let batches = [];
  let label = '';

  if (source === 'genre') {
    const g = genreByKey(genre);
    if (!g) throw new Error('Không có thể loại này');
    label = g.label;
    // 50 mỗi từ khoá: 5 playlist × 15 bài = 75, mà sau khi bỏ trùng và lọc
    // video tổng hợp thì rơi rụng quá nửa. Xin 30 chỉ đủ 4 playlist.
    batches = await Promise.all(g.queries.map((q) => ytSearch(q, 50).catch(() => [])));
  } else if (source === 'query') {
    const q = String(query || '').trim();
    if (!q) throw new Error('Chưa nhập từ khoá');
    label = q;
    batches = await Promise.all(
      [`${q} official mv`, `${q} official audio`, q].map((s) => ytSearch(s, 50).catch(() => []))
    );
  } else if (source === 'history') {
    // Lấy rộng chứ không chỉ vài bài đầu: mẻ càng lớn thì càng ghép được
    // nhiều mix khác nhau để chọn, và mix cũng đỡ lặp đi lặp lại.
    const seeds = topTracks(90);
    if (!seeds.length) throw new Error('Chưa có lịch sử nghe để tạo mix');
    label = 'bài hay nghe';
    // Chính các bài hay nghe cũng nằm trong mix — đó là thứ người ta muốn nghe.
    batches = [seeds];
    // Chỉ 3 bài đầu mới đi tìm bài liên quan: mỗi lượt là một request tới
    // YouTube, tìm cho cả 60 bài thì chờ rất lâu mà chẳng thêm được bao nhiêu.
    const rel = await Promise.all(
      seeds.slice(0, 4).map((s) => ytRelated(s.id, 25).catch(() => []))
    );
    batches = batches.concat(rel);
  } else {
    throw new Error('Nguồn mix không hợp lệ');
  }

  return { label, pool: mergeSongs(batches) };
}

/** Ghép MỘT mix. Giữ lại cho các chỗ chỉ cần một danh sách. */
async function buildMix(opts, size = MIX_SIZE) {
  const { label, pool } = await mixPool(opts);
  return { label: `Mix ${label}`, items: shuffled(pool).slice(0, size) };
}

/**
 * Ghép NHIỀU mix khác nhau từ cùng một mẻ bài, để người dùng chọn — giống hàng
 * thẻ "Mix - <tên bài>" của YouTube.
 *
 * Chia mẻ đã trộn thành từng khối MIX_SIZE bài, nên các mix KHÔNG trùng bài
 * nhau. Đặt tên theo bài đầu của mỗi mix: "Mix Nhạc trẻ #2" thì chẳng gợi được
 * gì, còn tên một bài cụ thể thì đoán ngay được mix đó nghe kiểu gì.
 */
/** Cắt một mẻ bài đã trộn thành các playlist RỜI NHAU. */
function sliceMixes(deck, { count, size, tag }) {
  const mixes = [];
  for (let i = 0; i < count; i++) {
    const items = deck.slice(i * size, i * size + size);
    // Khối cuối lẻ vài bài thì bỏ: một "playlist" 2 bài không đáng gọi là
    // playlist. Nhưng luôn giữ ít nhất một cái, kể cả khi mẻ bài quá ít.
    if (!items.length) break;
    if (items.length < Math.min(size, 5) && mixes.length) break;
    mixes.push({
      label: items[0].title,
      sub: `${items.length} bài · ${tag}`,
      thumb: items[0].thumb,
      items,
    });
  }
  return mixes;
}

async function buildMixes(opts, { count = 5, size = MIX_SIZE } = {}) {
  const { label, pool } = await mixPool(opts);
  if (!pool.length) return { label, mixes: [] };

  // Trộn rồi cắt thành các khối RỜI NHAU: mỗi lần bấm ⟳ là một thứ tự khác,
  // và không playlist nào trùng bài với playlist khác.
  const tagOf = (items) =>
    [...new Set(items.map((t) => t.author).filter(Boolean))].slice(0, 2).join(', ') || label;
  const mixes = sliceMixes(shuffled(pool), { count, size, tag: '' })
    .map((m) => ({ ...m, sub: `${m.items.length} bài · ${tagOf(m.items)}` }));
  return { label, mixes };
}

/**
 * Bài hay nghe nhất trên chính dàn này. Không gọi mạng, không tốn quota —
 * đọc từ lịch sử đếm tại chỗ.
 */
app.get('/api/top', (req, res) => {
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 24));
  res.json({ items: topTracks(limit) });
});

/**
 * Ghép nhiều mix (mỗi mix tối đa 15 bài lẻ) để người dùng chọn.
 * Chỉ trả danh sách, không đụng vào hàng chờ.
 */
app.get('/api/mixes', async (req, res) => {
  try {
    const count = Math.min(8, Math.max(1, parseInt(req.query.count, 10) || 5));
    res.json(await buildMixes(
      { source: req.query.source, genre: req.query.genre, query: req.query.q },
      { count }
    ));
  } catch (err) {
    console.error('[api/mixes]', err.message);
    res.status(502).json({ error: err.message });
  }
});

/** Một mix duy nhất. Giữ lại cho tương thích. */
app.get('/api/mix', async (req, res) => {
  try {
    const size = Math.min(MIX_SIZE, Math.max(1, parseInt(req.query.size, 10) || MIX_SIZE));
    res.json(await buildMix(
      { source: req.query.source, genre: req.query.genre, query: req.query.q },
      size
    ));
  } catch (err) {
    console.error('[api/mix]', err.message);
    res.status(502).json({ error: err.message });
  }
});

/**
 * Ẩn / bỏ ẩn một bài khỏi mọi danh sách gợi ý.
 * GET để xem danh sách đang ẩn (dùng khi cần bỏ ẩn hàng loạt).
 */
app.post('/api/hide', (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Thiếu id bài hát' });
  hideTrack(id);
  res.json({ ok: true, hidden: hidden.size });
});

app.post('/api/unhide', (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Thiếu id bài hát' });
  res.json({ ok: true, removed: unhideTrack(id), hidden: hidden.size });
});

app.get('/api/hidden', (_req, res) => res.json({ ids: [...hidden] }));

/** Bỏ ẩn tất cả — lối thoát khi lỡ gạt quá tay và không còn bài nào để gợi ý. */
app.post('/api/unhide-all', (_req, res) => {
  const n = hidden.size;
  hidden = new Set();
  saveHidden();
  res.json({ ok: true, removed: n });
});

app.get('/api/state', (_req, res) => res.json(snapshot()));

app.get('/healthz', (_req, res) =>
  res.json({
    ok: true,
    build: BUILD,
    players: state.players,
    logged_in: gapi.logged_in,
    youtube: ytStatus(),
    audio: audioStatus(),
  }));

/** Chỉ riêng tình trạng YouTube — trang điều khiển hỏi định kỳ chỗ này. */
app.get('/api/health/youtube', (_req, res) => res.json(ytStatus()));

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast() {
  // Mọi thay đổi trạng thái đều đi qua đây, nên móc việc lưu vào đây là đủ —
  // không phải rải lệnh lưu vào từng lệnh thêm/xoá/chuyển bài.
  saveQueueSoon();
  savePlayheadSoon();
  const msg = JSON.stringify({ type: 'state', state: snapshot() });
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

function sendToPlayers(obj) {
  for (const ws of wss.clients) if (ws.role === 'player') send(ws, obj);
}

function recount() {
  let p = 0;
  let r = 0;
  for (const ws of wss.clients) {
    if (ws.role === 'player') p++;
    else if (ws.role === 'remote') r++;
  }
  const changed = p !== state.players || r !== state.remotes;
  state.players = p;
  state.remotes = r;
  // Nothing can play with no output device attached.
  if (p === 0 && state.playing) {
    state.playing = false;
    return true;
  }
  return changed;
}

function addTracks(items, addedBy, playNow = false) {
  const added = items
    .filter((t) => t && t.id)
    .map((t) => ({
      uid: nextUid(),
      id: t.id,
      title: t.title || t.id,
      author: t.author || '',
      duration: t.duration || 0,
      thumb: t.thumb || `https://i.ytimg.com/vi/${t.id}/mqdefault.jpg`,
      addedBy: addedBy || 'ai đó',
    }));
  if (!added.length) return;
  const startAt = state.queue.length;
  state.queue.push(...added);
  if (playNow || state.index === -1) goTo(startAt, true);
  else broadcast();
}

// ---------------------------------------------------------------------------
// Âm lượng loa thật của máy chủ
//
// Nếu máy chủ chỉnh được loa (có pactl và có phiên âm thanh) thì thanh âm lượng
// điều khiển ĐÚNG cái loa đó, còn trình phát YouTube giữ 100%. Không có thì lùi
// về chỉnh trong trình phát như trước, và nói rõ lý do trên giao diện.
// ---------------------------------------------------------------------------

async function detectSystemAudio() {
  try {
    const info = await sysAudio.readVolume();
    if (!info.available) {
      state.audioMode = 'player';
      state.audioLabel = null;
      state.audioReason = info.reason || 'Không chỉnh được loa của máy chủ';
      return;
    }
    state.audioMode = 'system';
    state.audioLabel = info.label;
    state.audioReason = null;
    // Lấy mức đang có của máy làm mức khởi điểm, để thanh trượt khớp thực tế
    // ngay từ lần mở đầu tiên thay vì nhảy về 60 rồi đổi âm lượng bất ngờ.
    if (typeof info.volume === 'number') {
      state.volume = info.muted ? 0 : info.volume;
    }
    console.log(`[audio] chỉnh loa máy chủ: ${info.label} (${state.volume}%)`);
  } catch (err) {
    state.audioMode = 'player';
    state.audioReason = err.message;
  }
}

let volumeBusy = false;
let volumePending = null;

/**
 * Gửi mức âm lượng xuống pactl.
 *
 * Kéo thanh trượt bắn ra hàng chục lệnh mỗi giây; đẻ ra ngần ấy tiến trình
 * pactl là treo máy. Nên chỉ chạy MỘT lệnh tại một thời điểm, các mức đến trong
 * lúc đó chỉ giữ lại mức cuối cùng — đó cũng là mức người dùng thật sự muốn.
 */
function applySystemVolume(v) {
  volumePending = v;
  if (volumeBusy) return;
  volumeBusy = true;

  (async () => {
    while (volumePending !== null) {
      const target = volumePending;
      volumePending = null;
      try {
        await sysAudio.setVolume(target);
      } catch (err) {
        console.warn('[audio] không đặt được âm lượng máy chủ:', err.message);
        state.audioMode = 'player';
        state.audioReason = err.message;
        broadcast();
        break;
      }
    }
    volumeBusy = false;
  })();
}

function audioStatus() {
  return { mode: state.audioMode, label: state.audioLabel, reason: state.audioReason };
}

const COMMANDS = {
  play() {
    if (state.index === -1 && state.queue.length) return goTo(0, true);
    if (state.index === -1) return;
    state.playing = true;
    broadcast();
  },
  pause() {
    state.playing = false;
    broadcast();
  },
  toggle() {
    if (state.index === -1 && state.queue.length) return goTo(0, true);
    if (state.index === -1) return;
    state.playing = !state.playing;
    broadcast();
  },
  next() {
    const i = pickNextIndex(1);
    if (i === -1) {
      state.playing = false;
      broadcast();
    } else goTo(i, true);
  },
  prev(_m) {
    // Restart the track if we're more than 4s in, like a real player.
    if (state.position > 4) {
      state.position = 0;
      sendToPlayers({ type: 'cmd', cmd: 'seek', to: 0 });
      return broadcast();
    }
    const i = pickNextIndex(-1);
    if (i === -1) return;
    goTo(i, true);
  },
  jump(m) {
    const i = state.queue.findIndex((t) => t.uid === m.uid);
    if (i >= 0) goTo(i, true);
  },
  seek(m) {
    const to = Math.max(0, Number(m.to) || 0);
    state.position = to;
    sendToPlayers({ type: 'cmd', cmd: 'seek', to });
    broadcast();
  },
  volume(m) {
    const v = Math.min(100, Math.max(0, Math.round(Number(m.value) || 0)));
    state.volume = v;
    broadcast();   // phản hồi ngay, không chờ pactl chạy xong
    if (state.audioMode === 'system') applySystemVolume(v);
  },
  repeat(m) {
    const modes = ['off', 'all', 'one'];
    state.repeat = modes.includes(m.value)
      ? m.value
      : modes[(modes.indexOf(state.repeat) + 1) % 3];
    broadcast();
  },
  shuffle(m) {
    state.shuffle = typeof m.value === 'boolean' ? m.value : !state.shuffle;
    broadcast();
  },
  /** Hẹn giờ dừng phát. { minutes: 30 } — 0 hoặc thiếu = huỷ. */
  sleep(m) {
    setSleep(m.minutes);
    const mins = Number(m.minutes) || 0;
    toastRemotes(mins > 0 ? `Sẽ dừng nhạc sau ${mins} phút` : 'Đã huỷ hẹn giờ');
  },
  autoradio(m) {
    state.autoRadio = typeof m.value === 'boolean' ? m.value : !state.autoRadio;
    broadcast();
    // Bật lúc hàng chờ đã hết thì nối ngay, khỏi phải đợi hết một bài nữa.
    if (state.autoRadio && current() && pickNextIndex(1) === -1) {
      extendWithRadio(current()).then((n) => {
        if (n > 0) broadcast();
      });
    }
  },
  /**
   * Bật nghe liên tục theo thể loại: bật luôn tự phát tiếp và rót một mẻ bài
   * ngay, vì đó là điều người dùng mong đợi khi bấm nút.
   */
  station(m) {
    const g = m.key ? genreByKey(m.key) : null;
    state.station = g ? g.key : null;
    state.stationLabel = g ? g.label : null;

    if (!g) {
      broadcast();
      return;
    }
    state.autoRadio = true;
    broadcast();

    extendWithRadio(null).then((n) => {
      // playNow: phát ngay bài đầu tiên của đài thay vì xếp sau hàng chờ cũ.
      if (n > 0 && m.playNow) goTo(state.queue.length - n, true);
      else broadcast();
      const msg = JSON.stringify({
        type: 'toast',
        text: n > 0
          ? `Nghe liên tục · ${g.label}: đã thêm ${n} bài`
          : `Không lấy được bài cho thể loại ${g.label}`,
      });
      for (const c of wss.clients)
        if (c.role === 'remote' && c.readyState === c.OPEN) c.send(msg);
    });
  },
  /** Tạo mix từ một bài trong hàng chờ (hoặc bài đang phát). */
  /**
   * "Phát Mix" — giống nút Play all trên thẻ Mix của YouTube.
   *
   * Khác `radio` ở chỗ nhận thẳng một bài CHƯA có trong hàng chờ (từ kết quả
   * tìm kiếm): phát bài đó ngay, nối các bài liên quan, rồi bật auto-radio để
   * chạy mãi không dừng — đó mới đúng nghĩa "Mix".
   */
  mix(m) {
    let seed;
    if (m.item && m.item.id) {
      addTracks([m.item], m.addedBy, true);
      seed = current();
    } else {
      seed = m.uid ? state.queue.find((t) => t.uid === m.uid) : current();
    }
    if (!seed) return;

    // Mix bám theo BÀI, không theo đài thể loại đang bật.
    state.station = null;
    state.stationLabel = null;
    state.autoRadio = true;

    extendWithRadio(seed, { forceSeed: true }).then((n) => {
      toastRemotes(
        n > 0
          ? `Mix "${seed.title}" — thêm ${n} bài, sẽ tự nối tiếp`
          : 'Không tìm được bài liên quan để tạo Mix'
      );
      broadcast();
    });
    broadcast();
  },

  radio(m) {
    const seed = m.uid ? state.queue.find((t) => t.uid === m.uid) : current();
    if (!seed) return;
    extendWithRadio(seed, { forceSeed: true }).then((n) => {
      const msg = JSON.stringify({
        type: 'toast',
        text: n > 0 ? `Đã thêm ${n} bài giống "${seed.title}"` : 'Không tìm được bài liên quan',
      });
      for (const c of wss.clients)
        if (c.role === 'remote' && c.readyState === c.OPEN) c.send(msg);
      broadcast();
    });
  },
  add(m) {
    addTracks(m.items || (m.item ? [m.item] : []), m.addedBy, !!m.playNow);
  },
  remove(m) {
    const i = state.queue.findIndex((t) => t.uid === m.uid);
    if (i < 0) return;
    state.queue.splice(i, 1);
    if (i === state.index) {
      if (state.queue.length === 0) goTo(-1);
      else goTo(Math.min(i, state.queue.length - 1), state.playing);
    } else {
      if (i < state.index) state.index--;
      broadcast();
    }
  },
  move(m) {
    const from = state.queue.findIndex((t) => t.uid === m.uid);
    const to = Math.min(state.queue.length - 1, Math.max(0, Number(m.to)));
    if (from < 0 || to === from) return;
    const cur = current();
    const [item] = state.queue.splice(from, 1);
    state.queue.splice(to, 0, item);
    if (cur) state.index = state.queue.indexOf(cur);
    broadcast();
  },
  clear() {
    const cur = current();
    state.queue = cur ? [cur] : [];
    state.index = cur ? 0 : -1;
    broadcast();
  },
  stop() {
    state.playing = false;
    state.position = 0;
    sendToPlayers({ type: 'cmd', cmd: 'seek', to: 0 });
    broadcast();
  },
};

wss.on('connection', (ws) => {
  ws.role = null;
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'hello') {
      ws.role = m.role === 'player' ? 'player' : 'remote';
      ws.name = String(m.name || '').slice(0, 40);
      // CHỈ MỘT máy phát được phát. Hai trang /player mở cùng lúc (hai tab,
      // hay kiosk bị mở chồng) thì cả hai cùng phát lệch nhau vài giây, và mỗi
      // trang tự báo "hết bài" -> bỏ bài loạn xạ. Trang mở SAU được quyền phát;
      // trang cũ chuyển sang chờ, tắt tiếng, và KHÔNG tự nối lại (nếu tự nối
      // lại thì hai trang giành qua giành lại mãi).
      if (ws.role === 'player') {
        for (const other of wss.clients) {
          if (other !== ws && other.role === 'player') {
            other.role = 'standby';
            send(other, { type: 'standby' });
          }
        }
      }
      recount();
      if (ws.role === 'player') resumeIfDue();
      send(ws, { type: 'state', state: snapshot() });
      broadcast();
      return;
    }

    if (ws.role === 'player') {
      if (m.type === 'progress') {
        state.position = Number(m.position) || 0;
        if (m.duration) state.duration = Number(m.duration);
        const cur = current();
        if (cur && m.duration && !cur.duration) cur.duration = Number(m.duration);
        maybeCountPlay(cur, state.position, state.duration);
        savePlayheadSoon();
        const tick = JSON.stringify({
          type: 'tick',
          position: state.position,
          duration: state.duration,
        });
        for (const c of wss.clients)
          if (c.role === 'remote' && c.readyState === c.OPEN) c.send(tick);
        return;
      }
      if (m.type === 'ended') return onTrackEnded().catch((e) => console.error("[ended]", e.message));
      if (m.type === 'error') {
        console.warn('[player] lỗi phát video, bỏ qua bài này:', m.code);
        const cur = current();
        if (cur) {
          const msg = JSON.stringify({
            type: 'toast',
            text: `Không phát được "${cur.title}", bỏ qua.`,
          });
          for (const c of wss.clients)
            if (c.role === 'remote' && c.readyState === c.OPEN) c.send(msg);
        }
        return onTrackEnded().catch((e) => console.error("[ended]", e.message));
      }
      if (m.type === 'playstate') {
        // Player reports what it is actually doing (e.g. user paused the tab).
        if (typeof m.playing === 'boolean' && m.playing !== state.playing) {
          state.playing = m.playing;
          broadcast();
        }
        return;
      }
      return;
    }

    // Remote commands
    if (m.type === 'cmd') {
      const fn = COMMANDS[m.cmd];
      if (fn) fn(m);
    }
  });

  ws.on('close', () => {
    if (recount()) broadcast();
    else broadcast();
  });
});

// Drop dead sockets so the player count stays honest.
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 20000);

restoreGapi().catch(() => {});

server.listen(PORT, HOST, () => {
  console.log(`YT Jukebox đang chạy:`);
  console.log(`  Trang phát nhạc (máy nối loa): http://<ip-máy-này>:${PORT}/player`);
  console.log(`  Trang điều khiển (điện thoại): http://<ip-máy-này>:${PORT}/remote`);

  // Dò loa của máy chủ sau khi đã lắng nghe, để pactl chậm cũng không làm
  // server khởi động chậm theo.
  detectSystemAudio().then(broadcast);

  // Loa Bluetooth nối sau khi server chạy, hoặc người dùng đổi ngõ ra ở
  // desktop — dò lại định kỳ để thanh âm lượng không trỏ vào thiết bị đã rút.
  const t = setInterval(() => {
    const before = state.audioMode + state.audioLabel;
    detectSystemAudio().then(() => {
      if (before !== state.audioMode + state.audioLabel) broadcast();
    });
  }, 60_000);
  t.unref?.();
});

module.exports = {
  app,
  server,
  ytSearch,
  parseYouTubeInput,
  extractInitialData,
  trackFromNode,
  feedTracks,
  ytRelated,
  extendWithRadio,
  trimQueue,
  GENRES,
  genreByKey,
  isSongLike,
  genreTracks,
  _searchCache: searchCache,
  _cacheGet: cacheGet,
  _cacheSet: cacheSet,
  SEARCH_CACHE_MAX,
  ytStatus,
  noteYtOk,
  detectSystemAudio,
  applySystemVolume,
  audioStatus,
  hideTrack,
  unhideTrack,
  notHidden,
  HIDDEN_PATH,
  buildMix,
  buildMixes,
  sliceMixes,
  mixPool,
  mergeSongs,
  shuffled,
  MIX_SIZE,
  notePlay,
  maybeCountPlay,
  saveQueueNow,
  savePlayheadNow,
  loadQueue,
  resumeIfDue,
  QUEUE_PATH,
  PLAYHEAD_PATH,
  topTracks,
  state,
  gapi,
  gapiConfig,
  gapiAuth,
  loadGapiTokens,
  saveGapiTokens,
  clearGapiTokens,
  startGapiLogin,
  gapiLogout,
  GAPI_TOKENS_PATH,
  loadConfig,
  saveConfig,
  CONFIG_PATH,
  noteInnertubeFailure,
  getInnertube,
  fmtDuration,
  _backoffUntil: () => innertubeBrokenUntil, // chỉ dùng cho selftest
};
