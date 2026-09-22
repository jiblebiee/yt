#!/usr/bin/env bash
# Nâng thư viện đọc YouTube (youtubei.js) rồi khởi động lại service.
#
#   sudo bash update.sh           # nâng lên bản mới nhất, kiểm tra, giữ nếu chạy được
#   sudo bash update.sh --check   # chỉ xem tình trạng, không đụng gì
#   sudo bash update.sh --rollback
#
# VÌ SAO CẦN: youtubei.js đọc API NỘI BỘ của YouTube. YouTube đổi nội bộ vài
# tháng một lần, và khi đó tìm kiếm / gợi ý hỏng mà không có thông báo nào —
# triệu chứng duy nhất là "tìm mãi không ra bài". Cách sửa gần như luôn là nâng
# thư viện lên bản mới.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/yt-jukebox}
PKG=youtubei.js
BACKUP="$APP_DIR/node_modules/.youtubei-backup"

health_url() {
  local port
  port="$(systemctl show yt-jukebox -p Environment --value 2>/dev/null \
          | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -1)"
  echo "http://127.0.0.1:${port:-80}"
}

show_status() {
  local base; base="$(health_url)"
  echo "==> Tình trạng đường ra YouTube ($base/healthz)"
  if ! command -v curl >/dev/null 2>&1; then
    echo "    (không có curl, bỏ qua)"
    return 0
  fi
  # "|| true": server chưa chạy thì vẫn phải in được phần còn lại.
  local body
  body="$(curl -s --max-time 5 "$base/healthz" || true)"
  if [[ -z "$body" ]]; then
    echo "    Không gọi được server. Kiểm tra: systemctl status yt-jukebox"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    node -e '
      let raw = ""; process.stdin.on("data", d => raw += d).on("end", () => {
        let j; try { j = JSON.parse(raw); } catch { console.log("    (không đọc được)"); return; }
        const y = j.youtube || {};
        const t = (ms) => ms ? new Date(ms).toLocaleString("vi-VN") : "chưa có";
        console.log("    trạng thái : " + (y.status || "?"));
        console.log("    đi bằng    : " + (y.via || "chưa gọi lần nào"));
        console.log("    lần OK cuối: " + t(y.lastOkAt));
        console.log("    lần lỗi cuối: " + t(y.lastErrAt));
        if (y.lastError) console.log("    lỗi        : " + y.lastError);
        console.log("    số lần OK/lỗi: " + (y.ok || 0) + "/" + (y.fails || 0));
      });
    ' <<< "$body"
  else
    echo "$body"
  fi
}

installed_version() {
  node -e "try{console.log(require('$APP_DIR/node_modules/$PKG/package.json').version)}catch{console.log('?')}" 2>/dev/null
}

# Thử thật: gọi tìm kiếm qua chính thư viện vừa cài, thay vì tin vào npm.
smoke_test() {
  node -e "
    const { Innertube } = require('$APP_DIR/node_modules/$PKG');
    (async () => {
      const yt = await Innertube.create({ retrieve_player: false });
      const res = await yt.search('nhạc trẻ official mv', { type: 'video' });
      const n = (res.videos || []).length;
      if (!n) { console.error('tìm được 0 kết quả'); process.exit(1); }
      console.log('    tìm thử: ' + n + ' kết quả — OK');
    })().catch((e) => { console.error('    ' + e.message); process.exit(1); });
  "
}

for arg in "$@"; do
  case "$arg" in
    --check)
      show_status
      echo
      echo "==> Bản $PKG đang cài: $(installed_version)"
      exit 0 ;;
    --rollback)
      [[ -d "$BACKUP" ]] || { echo "Không có bản sao lưu để quay lại." >&2; exit 1; }
      [[ $EUID -eq 0 ]] || { echo "Cần sudo." >&2; exit 1; }
      rm -rf "$APP_DIR/node_modules/$PKG"
      mv "$BACKUP" "$APP_DIR/node_modules/$PKG"
      systemctl restart yt-jukebox
      echo "Đã quay lại bản cũ và khởi động lại service."
      exit 0 ;;
    *) echo "Tham số lạ: $arg" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Cần chạy bằng sudo: sudo bash update.sh" >&2
  exit 1
fi

[[ -d "$APP_DIR" ]] || { echo "Không thấy $APP_DIR" >&2; exit 1; }

OLD="$(installed_version)"
echo "==> Bản đang cài: $OLD"
show_status
echo

# Giữ lại bản cũ. Bản mới cũng có thể hỏng — lúc đó cần đường lùi ngay, chứ
# không phải ngồi tìm xem bản trước là bản nào.
echo "==> Sao lưu bản hiện tại"
rm -rf "$BACKUP"
cp -a "$APP_DIR/node_modules/$PKG" "$BACKUP"

RUN_USER="$(stat -c '%U' "$APP_DIR")"
echo "==> Nâng $PKG (chạy bằng user $RUN_USER)"
sudo -u "$RUN_USER" bash -c "cd '$APP_DIR' && npm install $PKG@latest --omit=dev"

NEW="$(installed_version)"
echo "==> Bản sau khi nâng: $NEW"
if [[ "$OLD" == "$NEW" ]]; then
  echo "    Đã là bản mới nhất, không có gì để nâng."
fi

echo "==> Thử gọi YouTube bằng thư viện vừa cài"
if ! smoke_test; then
  echo
  echo "!!! Bản mới KHÔNG gọi được YouTube. Đang quay lại bản $OLD." >&2
  rm -rf "$APP_DIR/node_modules/$PKG"
  cp -a "$BACKUP" "$APP_DIR/node_modules/$PKG"
  chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR/node_modules/$PKG"
  systemctl restart yt-jukebox
  echo "    Đã quay lại. Nếu bản cũ cũng hỏng thì lỗi không nằm ở thư viện —" >&2
  echo "    kiểm tra mạng của máy chủ, hoặc YouTube đang chặn IP này." >&2
  exit 1
fi

chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR/node_modules/$PKG"
echo "==> Khởi động lại service"
systemctl restart yt-jukebox
sleep 3

if ! systemctl is-active --quiet yt-jukebox; then
  echo "!!! Service không chạy được sau khi nâng. Log:" >&2
  journalctl -u yt-jukebox --no-pager --lines=30 >&2 || true
  echo "    Quay lại:  sudo bash update.sh --rollback" >&2
  exit 1
fi

echo
show_status
cat <<EOF

===================================================
 Xong. $PKG: $OLD -> $NEW

 Không ưng thì quay lại:  sudo bash update.sh --rollback
 Xem tình trạng bất cứ lúc nào:  bash update.sh --check
===================================================
EOF
