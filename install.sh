#!/usr/bin/env bash
# Cài YT Jukebox lên Raspberry Pi / Linux có systemd.
# Chạy:  sudo bash install.sh
set -euo pipefail

APP_DIR=/opt/yt-jukebox
RUN_USER="${SUDO_USER:-pi}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Những thứ KHÔNG chép sang thư mục cài đặt.
#   data/         -> token đăng nhập, phải giữ nguyên khi cài đè
#   node_modules/ -> cài lại bằng npm ở đích
#   android/      -> source app điện thoại, build trên máy khác, Pi không cần
EXCLUDES=(data node_modules package-lock.json .git .dockerignore .gitignore android)

# Chép TOÀN BỘ mã nguồn, trừ danh sách trên.
#
# Trước đây chỗ này liệt kê tay từng file, và khi thêm module mới
# (youtube-api.js) thì quên cập nhật -> server chết vì MODULE_NOT_FOUND.
# Chép cả thư mục thì thêm file mới không bao giờ hỏng nữa.
copy_sources() {
  local dest="$1"
  mkdir -p "$dest"
  [[ "$SRC_DIR" == "$dest" ]] && return 0

  local args=()
  for e in "${EXCLUDES[@]}"; do args+=(--exclude="$e"); done

  if command -v rsync >/dev/null 2>&1; then
    rsync -a "${args[@]}" "$SRC_DIR"/ "$dest"/
  else
    # Không có rsync thì dùng tar, vẫn giữ được phần loại trừ.
    local targs=()
    for e in "${EXCLUDES[@]}"; do targs+=(--exclude="$e"); done
    tar -C "$SRC_DIR" "${targs[@]}" -cf - . | tar -C "$dest" -xf -
  fi
}

# ------------------------------------------------- dọn tàn dư của tên miền
# Phần tên miền nội bộ (nhac.me / nhac.home...) đã bị BỎ HẲN: nó chỉ tiết kiệm
# vài ký tự khi gõ, đổi lại phải cài dnsmasq, phải đổi DNS trong router, và khi
# hỏng thì trang trắng mà không biết vì sao. Dùng thẳng IP là xong.
#
# Gỡ script thôi chưa đủ: cấu hình cũ vẫn nằm trong /etc/hosts và
# /etc/dnsmasq.d, nên máy VẪN phân giải tên miền đó — đúng cảnh "xoá rồi mà
# vẫn còn". Dọn ở đây, mỗi lần cài.
#
# Hai đường dẫn thay được bằng biến môi trường, chỉ nhằm mục đích KIỂM THỬ:
# không ai muốn bài kiểm thử ghi thật vào /etc của máy đang chạy.
clean_domain_leftovers() {
  local dns_conf="${JUKEBOX_DNS_CONF:-/etc/dnsmasq.d/jukebox.conf}"
  local etc_hosts="${JUKEBOX_ETC_HOSTS:-/etc/hosts}"
  local cleaned=0

  if [[ -f "$dns_conf" ]]; then
    rm -f "$dns_conf"
    echo "==> Đã xoá $dns_conf (tên miền cũ)"
    cleaned=1
    systemctl restart dnsmasq 2>/dev/null || true
  fi

  # Neo '$' ở cuối: chỉ xoá đúng dòng do script cũ ghi ra, không đụng vào dòng
  # nào khác của người dùng có chữ jukebox trong đó.
  if grep -q '# jukebox-domain$' "$etc_hosts" 2>/dev/null; then
    sed -i '/# jukebox-domain$/d' "$etc_hosts"
    echo "==> Đã xoá dòng tên miền jukebox trong $etc_hosts"
    cleaned=1
  fi

  rm -f "${1:-}/setup-domain.sh" 2>/dev/null || true

  if [[ $cleaned -eq 1 ]]; then
    echo "    Nếu trước đây có trỏ DNS trong router về Pi thì trả lại mặc định."
  fi
}

# Chỉ dọn tàn dư tên miền rồi thoát. Dùng cho kiểm thử, và cho ai đã cài bản
# cũ mà chỉ muốn gỡ tên miền chứ chưa muốn cài lại.
if [[ "${1:-}" == "--clean-domain" ]]; then
  clean_domain_leftovers "${2:-$APP_DIR}"
  exit 0
fi

# Chế độ chỉ chép, dùng cho kiểm thử — không cần quyền root.
if [[ "${1:-}" == "--copy-only" ]]; then
  [[ -n "${2:-}" ]] || { echo "Thiếu thư mục đích" >&2; exit 1; }
  copy_sources "$2"
  exit 0
fi

if [[ $EUID -ne 0 ]]; then
  echo "Cần chạy bằng sudo: sudo bash install.sh" >&2
  exit 1
fi

# Nói rõ đang cài TỪ ĐÂU và BẢN NÀO ngay từ dòng đầu.
# Đã gặp thật: giải nén bản mới ra một thư mục, nhưng chạy install.sh ở thư mục
# cũ -> cài đè lại đúng bản cũ, mà không có gì báo.
# sed chứ không phải grep -oP: -P là phần mở rộng PCRE, không có trên mọi bản grep.
build_of() { sed -n "s/^const BUILD = '\\([^']*\\)'.*/\\1/p" "$1" 2>/dev/null | head -1; }
SRC_BUILD="$(build_of "$SRC_DIR/server.js")"
SRC_BUILD="${SRC_BUILD:-?}"
echo "==> Cài từ: $SRC_DIR"
echo "    phiên bản trong thư mục này: $SRC_BUILD"
if [[ -f "$APP_DIR/server.js" ]]; then
  OLD_BUILD="$(build_of "$APP_DIR/server.js")"
  OLD_BUILD="${OLD_BUILD:-?}"
  echo "    phiên bản đang cài ở $APP_DIR: $OLD_BUILD"
fi
echo

echo "==> Kiểm tra Node.js (cần >= 18) và npm"

# Trả về major version của node, hoặc 0 nếu chưa có node.
node_major() {
  command -v node >/dev/null 2>&1 &&
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

if [[ "$(node_major)" -lt 18 ]]; then
  echo "==> Cài Node.js 20 LTS từ NodeSource"
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# QUAN TRỌNG: gói "nodejs" của Debian / Raspberry Pi OS KHÔNG kèm npm.
# Có node không có nghĩa là có npm, phải kiểm tra riêng.
if ! command -v npm >/dev/null 2>&1; then
  echo "==> Chưa có npm (gói nodejs của Debian không kèm npm), đang cài"
  apt-get update
  apt-get install -y npm
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Không cài được npm. Thử thủ công: sudo apt-get install -y npm" >&2
  exit 1
fi

echo "    node $(node -v) · npm $(npm -v)"

echo "==> Chép mã nguồn vào $APP_DIR"
copy_sources "$APP_DIR"

# Chép xong phải KIỂM chứ không tin. server.js và remote.html mang cùng một
# hằng BUILD; lệch nhau là dấu hiệu chép hụt hoặc chép nhầm thư mục.
NEW_SRV="$(build_of "$APP_DIR/server.js")"
NEW_SRV="${NEW_SRV:-?}"
NEW_WEB="$(build_of "$APP_DIR/public/remote.html")"
NEW_WEB="${NEW_WEB:-?}"
if [[ "$NEW_SRV" != "$SRC_BUILD" || "$NEW_WEB" != "$SRC_BUILD" ]]; then
  echo
  echo "!!! Chép không khớp phiên bản." >&2
  echo "    nguồn=$SRC_BUILD  server.js=$NEW_SRV  remote.html=$NEW_WEB" >&2
  echo "    Kiểm tra bạn có đang chạy install.sh trong ĐÚNG thư mục vừa giải nén không." >&2
  exit 1
fi
echo "    OK: đã cài phiên bản $SRC_BUILD"
mkdir -p "$APP_DIR/data"
chmod 700 "$APP_DIR/data"
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"

echo "==> Cài dependencies"
sudo -u "$RUN_USER" bash -c "cd '$APP_DIR' && npm install --omit=dev"

clean_domain_leftovers "$APP_DIR"

echo "==> Cài systemd service (chạy dưới user: $RUN_USER)"
sed "s/^User=pi$/User=$RUN_USER/; s/^Group=pi$/Group=$RUN_USER/" \
  "$SRC_DIR/yt-jukebox.service" > /etc/systemd/system/yt-jukebox.service
systemctl daemon-reload
systemctl enable yt-jukebox

# BẮT BUỘC dùng restart, KHÔNG dùng "enable --now": với service đang chạy sẵn
# thì --now là lệnh không làm gì cả, nên server.js cũ vẫn nằm trong bộ nhớ.
# Các file trong public/ thì được đọc lại từ đĩa mỗi request, nên giao diện mới
# vẫn hiện ra trong khi code server vẫn là bản cũ — rất khó nhận ra.
echo "==> Khởi động lại service để nạp mã mới"
systemctl restart yt-jukebox
sleep 3

if ! systemctl is-active --quiet yt-jukebox; then
  echo
  echo "!!! Service KHÔNG chạy được. Log gần nhất:" >&2
  journalctl -u yt-jukebox --no-pager --lines=30 >&2 || true
  exit 1
fi

systemctl --no-pager --lines=10 status yt-jukebox || true

# ------------------------------------------------- cổng thật sự đang nghe
# Chuyện đã xảy ra thật: service tưởng chạy cổng 80 nhưng địa chỉ lại hoá
# thành :3000, mà không có gì báo. Nguyên nhân thường là còn một tiến trình
# node chạy tay từ trước, hoặc file .service cũ vẫn nằm ở /etc/systemd.
# Nên kiểm tra bằng CỔNG THẬT của đúng PID mà systemd đang quản, chứ không tin
# vào cấu hình.
MAIN_PID="$(systemctl show yt-jukebox -p MainPID --value 2>/dev/null || echo 0)"
LISTEN_PORT=""
if [[ -n "$MAIN_PID" && "$MAIN_PID" != "0" ]] && command -v ss >/dev/null 2>&1; then
  LISTEN_PORT="$(ss -lntpH 2>/dev/null | grep "pid=$MAIN_PID," \
                 | awk '{print $4}' | grep -oE '[0-9]+$' | sort -un | head -1)"
fi
WANT_PORT="$(systemctl show yt-jukebox -p Environment --value 2>/dev/null \
             | tr ' ' '\n' | sed -n 's/^PORT=//p' | head -1)"
WANT_PORT="${WANT_PORT:-80}"

if [[ -n "$LISTEN_PORT" && "$LISTEN_PORT" != "$WANT_PORT" ]]; then
  echo
  echo "!!! Service khai báo PORT=$WANT_PORT nhưng đang nghe cổng $LISTEN_PORT." >&2
  echo "    Địa chỉ sẽ có đuôi :$LISTEN_PORT thay vì gọn như mong đợi." >&2
  echo "    Kiểm tra: systemctl cat yt-jukebox | grep PORT" >&2
fi

# Còn tiến trình node nào KHÁC đang chạy server này không? Nó chiếm cổng 80
# thì service thật phải lùi, hoặc nó tự phục vụ ở 3000 và bạn vào nhầm nó.
STRAY="$(pgrep -f 'node .*server\.js' 2>/dev/null | grep -v "^${MAIN_PID}$" | tr '\n' ' ' || true)"
if [[ -n "${STRAY// /}" ]]; then
  echo
  echo "!!! Có tiến trình node server.js chạy NGOÀI systemd (PID: $STRAY)." >&2
  echo "    Đây là nguyên nhân hay gặp nhất khiến cổng bị lệch. Tắt đi:" >&2
  echo "      sudo kill $STRAY && sudo systemctl restart yt-jukebox" >&2
fi

# Launcher kiosk cũ ghi cứng tên miền: tên miền vừa bị dọn ở trên, nên nếu
# không nhắc thì lần khởi động tới kiosk sẽ trắng màn hình.
KHOME="$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6)"
KLAUNCH="${KHOME:-/home/$RUN_USER}/.local/bin/jukebox-kiosk.sh"
if [[ -f "$KLAUNCH" ]]; then
  KURL="$(grep -oE 'https?://[^"]+/player' "$KLAUNCH" | head -1 || true)"
  KHOST="$(printf '%s' "$KURL" | sed -E 's#^https?://##; s#[:/].*##')"
  case "${KHOST:-127.0.0.1}" in
    127.0.0.1|localhost) ;;
    *)
      echo
      echo "!!! Kiosk đang trỏ vào '$KHOST', mà phần tên miền đã bị bỏ hẳn." >&2
      echo "    Chạy lại (KHÔNG sudo):  bash $APP_DIR/setup-kiosk.sh" >&2
      ;;
  esac
fi

PORT_SUFFIX=""
[[ "${LISTEN_PORT:-$WANT_PORT}" != "80" ]] && PORT_SUFFIX=":${LISTEN_PORT:-$WANT_PORT}"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "==================================================="
echo " Xong! Service đang chạy. Trong mạng nội bộ truy cập:"
echo "   Máy nối loa (trang phát):  http://${IP:-<ip>}${PORT_SUFFIX}/player"
echo "   Điện thoại (điều khiển):   http://${IP:-<ip>}${PORT_SUFFIX}/remote"
echo
echo " Muốn Pi tự mở trang phát mỗi lần khởi động (không cần bấm Bật loa):"
echo "   bash $APP_DIR/setup-kiosk.sh     # chạy KHÔNG có sudo"
echo
echo " Muốn gõ cho gọn trên điện thoại: lưu trang remote ra màn hình chính"
echo "   (Safari/Chrome > Chia sẻ > Thêm vào MH chính) — bấm một cái là vào."
echo "==================================================="
