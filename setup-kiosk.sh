#!/usr/bin/env bash
# Tự mở trang player toàn màn hình mỗi khi Raspberry Pi khởi động,
# và cho phép tự phát nhạc (không cần bấm "Bật loa").
#
# Chạy KHÔNG cần sudo, dưới đúng user sẽ đăng nhập vào màn hình desktop:
#   bash setup-kiosk.sh
#
# Gỡ:  bash setup-kiosk.sh --remove
# Đăng nhập YouTube Premium cho kiosk:  bash setup-kiosk.sh --signin
set -euo pipefail

# Trang player LUÔN mở bằng 127.0.0.1 — máy này tự nói chuyện với chính nó,
# không cần tên miền, không cần DNS, không phụ thuộc mạng.
#
# Đã bỏ hẳn phần tên miền: nó chỉ để cho ĐIỆN THOẠI gõ cho gọn, mà kiosk thì
# chạy ngay trên máy chủ. Trước đây nếu tên miền hỏng hoặc bị xoá thì kiosk
# hiện màn hình trắng — một chỗ hỏng thừa thãi.
#
# Cổng thì không đoán: mặc định là 80, nhưng nếu server đang chạy 3000 thì
# launcher tự dò ra lúc khởi động (xem pick_port bên dưới).
URL="${JUKEBOX_URL:-}"
HEALTH="${JUKEBOX_HEALTH:-}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIO_SCRIPT="${JUKEBOX_AUDIO_SCRIPT:-$SRC_DIR/setup-audio.sh}"
LAUNCHER="$HOME/.local/bin/jukebox-kiosk.sh"
# Hồ sơ Chromium RIÊNG cho kiosk. Dùng chung hồ sơ mặc định thì chỉ cần có một
# cửa sổ Chromium thường đang mở (tự khôi phục phiên, hay ai đó mở lướt web),
# lệnh kiosk chỉ mở thêm một TAB trong cửa sổ đó và BỎ QUA mọi cờ — mất
# --kiosk, mất --autoplay-policy. Kết quả: cửa sổ thường có thanh dấu trang, và
# màn "Bật loa" hiện ra mỗi khi chọn bài. Hồ sơ riêng = tiến trình riêng = cờ
# luôn được áp dụng, không đụng gì tới trình duyệt bạn dùng hằng ngày.
PROFILE_DIR="$HOME/.config/jukebox-kiosk-profile"
DESKTOP="$HOME/.config/autostart/jukebox-player.desktop"
LABWC_AUTOSTART="$HOME/.config/labwc/autostart"
WAYFIRE_INI="$HOME/.config/wayfire.ini"
MARK="# jukebox-kiosk"

if [[ $EUID -eq 0 ]]; then
  echo "Đừng chạy bằng sudo — script này cài vào thư mục HOME của user desktop." >&2
  echo "Chạy lại:  bash setup-kiosk.sh" >&2
  exit 1
fi

# ------------------------------------------------------------------ chẩn đoán
# Gom mọi thứ liên quan tới kiosk vào một lần chạy, để không phải hỏi đi hỏi lại
# từng mẩu một.
if [[ "${1:-}" == "--doctor" ]]; then
  echo "===== CHẨN ĐOÁN KIOSK ====="
  echo
  echo "-- 1. Trình duyệt --"
  for c in chromium-browser chromium google-chrome; do
    if command -v "$c" >/dev/null 2>&1; then
      echo "   $c: $(command -v $c)"
      echo "   phiên bản: $($c --version 2>/dev/null | head -1)"
    fi
  done
  command -v chromium-browser chromium google-chrome >/dev/null 2>&1 || echo "   KHÔNG tìm thấy Chromium"

  echo
  echo "-- 2. Compositor đang chạy --"
  FOUND=0
  for c in labwc wayfire lxsession openbox mutter weston cage; do
    if pgrep -x "$c" >/dev/null 2>&1; then echo "   $c (pid $(pgrep -x $c | head -1))"; FOUND=1; fi
  done
  [[ $FOUND -eq 0 ]] && echo "   KHÔNG có compositor nào -> không có desktop, kiosk không chạy được"

  echo
  echo "-- 3. Màn hình khả dụng --"
  RTD="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  echo "   XDG_RUNTIME_DIR=$RTD"
  WLFOUND=0
  for s in "$RTD"/wayland-*; do
    case "$s" in *.lock) continue ;; esac
    [[ -S "$s" ]] && { echo "   socket Wayland: $s"; WLFOUND=1; }
  done
  [[ $WLFOUND -eq 0 ]] && echo "   không có socket Wayland"
  if [[ -e /tmp/.X11-unix/X0 ]]; then echo "   socket X11: /tmp/.X11-unix/X0"; else echo "   không có socket X11"; fi
  echo "   WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-(trống)}  DISPLAY=${DISPLAY:-(trống)}"

  echo
  echo "-- 4. Server jukebox --"
  # URL để trống nghĩa là "tự dò" — dò luôn ở đây cho chẩn đoán khớp với cái
  # launcher sẽ làm lúc khởi động, chứ không in ra một dòng trống khó hiểu.
  DH="$HEALTH"
  if [[ -z "$DH" ]]; then
    for dp in 80 3000 8080; do
      if curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:$dp/healthz" >/dev/null 2>&1; then
        DH="http://127.0.0.1$([[ $dp == 80 ]] || echo ":$dp")/healthz"; break
      fi
    done
    DH="${DH:-http://127.0.0.1/healthz  (chưa dò được, mặc định)}"
  fi
  echo "   health: $DH"
  # "|| true" là BẮT BUỘC: dưới set -e, gán biến từ lệnh thất bại sẽ thoát
  # script ngay, mất luôn các mục chẩn đoán phía sau — đúng lúc cần nhất.
  DCODE="$(curl -s -o /dev/null --noproxy '*' -w '%{http_code}' --max-time 4 "${DH%% *}" 2>/dev/null || true)"
  echo "   mã HTTP: ${DCODE:-000}$([[ "$DCODE" == "200" ]] && echo '  (OK)' || echo '  (KHÔNG gọi được)')"
  if command -v systemctl >/dev/null 2>&1; then
    echo "   systemd yt-jukebox: $(systemctl is-active yt-jukebox 2>/dev/null || echo 'không rõ')"
  fi
  echo "   cổng đang mở: $(ss -lntH 2>/dev/null | awk '{print $4}' | grep -oE '[0-9]+$' | sort -un | tr '\n' ' ' || true)"

  echo
  echo "-- 5. Launcher --"
  if [[ -f "$LAUNCHER" ]]; then
    echo "   $LAUNCHER (có)"
    LURL="$(grep -oE 'https?://[^\"]+/player' "$LAUNCHER" | head -1 || true)"
    echo "   URL đích: ${LURL:-(tự dò cổng lúc khởi động)}"
    # Launcher cũ còn ghi cứng tên miền: phần tên miền đã bị bỏ hẳn, nên nếu
    # tên đó không còn phân giải được thì kiosk sẽ trắng màn hình.
    LHOST="$(printf '%s' "$LURL" | sed -E 's#^https?://##; s#[:/].*##')"
    case "${LHOST:-127.0.0.1}" in
      127.0.0.1|localhost) ;;
      *)
        echo "   !!! Launcher còn trỏ vào tên miền '$LHOST' (bản cũ)."
        echo "       Bản này đã bỏ tên miền. Chạy lại:  bash setup-kiosk.sh"
        ;;
    esac
  else
    echo "   CHƯA CÓ $LAUNCHER -> chạy: bash setup-kiosk.sh"
  fi

  echo
  echo "-- 6. Autostart --"
  [[ -f "$DESKTOP" ]] && echo "   XDG:    $DESKTOP (có)" || echo "   XDG:    chưa có"
  if [[ -f "$LABWC_AUTOSTART" ]] && grep -q "$MARK" "$LABWC_AUTOSTART"; then
    echo "   labwc:  $LABWC_AUTOSTART (có dòng jukebox)"
  else
    echo "   labwc:  CHƯA có dòng jukebox <- labwc chỉ đọc file này"
  fi
  if [[ -f "$WAYFIRE_INI" ]] && grep -q "$MARK" "$WAYFIRE_INI"; then
    echo "   wayfire: $WAYFIRE_INI (có dòng jukebox)"
  fi

  echo
  echo "-- 7. Âm thanh --"
  if command -v pactl >/dev/null 2>&1; then
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    if pactl info >/dev/null 2>&1; then
      DEFSINK="$(pactl get-default-sink 2>/dev/null || pactl info 2>/dev/null | sed -n 's/^Default Sink: //p')"
      echo "   sink mặc định: ${DEFSINK:-?}"
      BTS="$(pactl list short sinks 2>/dev/null | awk '$2 ~ /^bluez_/ {print $2}' | tr '\n' ' ')"
      echo "   loa Bluetooth: ${BTS:-KHÔNG có}"
    else
      echo "   không kết nối được server âm thanh (chạy qua SSH thì hay bị)"
    fi
    echo "   chi tiết:  bash setup-audio.sh --doctor"
  else
    echo "   không có pactl -> sudo apt-get install -y pulseaudio-utils"
  fi

  echo
  echo "-- 8. Log kiosk (10 dòng cuối) --"
  tail -10 "$HOME/.local/share/jukebox-kiosk.log" 2>/dev/null | sed 's/^/   /' || echo "   chưa có log"

  echo
  echo "===== HẾT ====="
  exit 0
fi

# ------------------------------------------------------------- dừng / chạy lại
# Launcher tự mở lại trình duyệt mỗi khi nó thoát, nên "pkill chromium" thành vô
# dụng — vài giây sau nó lại hiện lên. Cần một cách dừng hẳn để còn sửa chữa.
STOP_FLAG="$HOME/.local/share/jukebox-kiosk.stop"

if [[ "${1:-}" == "--stop" ]]; then
  mkdir -p "$(dirname "$STOP_FLAG")"
  : > "$STOP_FLAG"
  pkill -f "jukebox-kiosk.sh" 2>/dev/null || true
  pkill -f -- "--kiosk" 2>/dev/null || true
  echo "Đã dừng kiosk và đặt cờ không tự mở lại."
  echo "Chạy lại:  bash setup-kiosk.sh --start"
  exit 0
fi

if [[ "${1:-}" == "--start" ]]; then
  rm -f "$STOP_FLAG"
  if [[ ! -x "$LAUNCHER" ]]; then
    echo "Chưa có $LAUNCHER — chạy: bash setup-kiosk.sh" >&2
    exit 1
  fi
  setsid "$LAUNCHER" >/dev/null 2>&1 &
  echo "Đã chạy lại kiosk (nền). Log: $HOME/.local/share/jukebox-kiosk.log"
  exit 0
fi

# ----------------------------------------------------------------- gỡ cài đặt
if [[ "${1:-}" == "--remove" ]]; then
  # Đặt cờ dừng TRƯỚC khi kill, nếu không vòng giám sát sẽ mở lại trình duyệt
  # ngay giữa lúc đang gỡ.
  mkdir -p "$(dirname "$STOP_FLAG")" && : > "$STOP_FLAG"
  pkill -f "jukebox-kiosk.sh" 2>/dev/null || true
  pkill -f -- "--kiosk" 2>/dev/null || true
  sleep 1
  rm -f "$LAUNCHER" "$DESKTOP" "$STOP_FLAG" "$HOME/.local/share/jukebox-kiosk.lock"
  for f in "$LABWC_AUTOSTART" "$WAYFIRE_INI"; do
    if [[ -f "$f" ]] && grep -q "$MARK" "$f"; then
      sed -i "/$MARK/d" "$f"
      echo "Đã xoá dòng khởi động trong $f"
    fi
  done
  echo "Đã gỡ kiosk. Khởi động lại Pi để áp dụng."
  exit 0
fi

# ------------------------------------------------------------- tìm trình duyệt
BROWSER=""
for c in chromium-browser chromium google-chrome; do
  if command -v "$c" >/dev/null 2>&1; then BROWSER="$c"; break; fi
done
if [[ -z "$BROWSER" ]]; then
  echo "Không tìm thấy Chromium. Cài trước:  sudo apt-get install -y chromium-browser" >&2
  exit 1
fi
echo "==> Dùng trình duyệt: $BROWSER"

# --------------------------------------------- đăng nhập YouTube cho kiosk
# Kiosk chạy hồ sơ Chromium riêng, nên tài khoản đăng nhập ở Chromium thường
# KHÔNG có mặt trong kiosk. Ai dùng YouTube Premium (để không có quảng cáo) thì
# đăng nhập MỘT lần vào hồ sơ kiosk bằng lệnh này, rồi đóng cửa sổ lại.
if [[ "${1:-}" == "--signin" ]]; then
  mkdir -p "$(dirname "$STOP_FLAG")"
  : > "$STOP_FLAG"          # tạm dừng kiosk, nếu không hai trình duyệt giành hồ sơ
  pkill -f "jukebox-kiosk.sh" 2>/dev/null || true
  pkill -f -- "--kiosk" 2>/dev/null || true
  sleep 1
  mkdir -p "$PROFILE_DIR"
  echo "Đăng nhập YouTube trong cửa sổ vừa mở, xong thì ĐÓNG cửa sổ đó lại."
  "$BROWSER" --user-data-dir="$PROFILE_DIR" --no-first-run \
    --password-store=basic "https://www.youtube.com/" >/dev/null 2>&1 || true
  rm -f "$STOP_FLAG"
  echo "Đã lưu đăng nhập. Mở lại kiosk:  bash setup-kiosk.sh --start"
  exit 0
fi

# --------------------------------------------------------------- script khởi chạy
mkdir -p "$(dirname "$LAUNCHER")"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
$MARK
LOG="\$HOME/.local/share/jukebox-kiosk.log"
BROWSER_LOG="\$HOME/.local/share/jukebox-browser.log"
ERR_PAGE="\$HOME/.local/share/jukebox-error.html"
LOCK="\$HOME/.local/share/jukebox-kiosk.lock"
STOP_FLAG="\$HOME/.local/share/jukebox-kiosk.stop"
mkdir -p "\$(dirname "\$LOG")"
log() { echo "[\$(date '+%F %T')] \$*" >> "\$LOG"; }

TARGET="$URL"
HEALTHURL="$HEALTH"

# Không có URL đặt sẵn thì tự dò cổng: hỏi /healthz ở 80 trước, rồi 3000.
# Dò mỗi lần khởi động chứ không ghi cứng lúc cài, vì cổng có thể đổi sau này
# (đổi file service, hoặc có thứ khác chiếm mất cổng 80).
if [ -z "\$TARGET" ]; then
  PORT=80
  for p in 80 3000 8080; do
    # --noproxy '*': nếu máy có đặt biến http_proxy thì curl sẽ gửi cả yêu cầu
    # tới CHÍNH NÓ qua proxy -> dò ra cổng sai. Gọi 127.0.0.1 thì không bao giờ
    # được đi vòng.
    if curl -fsS --noproxy '*' --max-time 2 "http://127.0.0.1:\$p/healthz" >/dev/null 2>&1; then
      PORT=\$p; break
    fi
  done
  case "\$PORT" in
    80) TARGET="http://127.0.0.1/player";     HEALTHURL="http://127.0.0.1/healthz" ;;
    *)  TARGET="http://127.0.0.1:\$PORT/player"; HEALTHURL="http://127.0.0.1:\$PORT/healthz" ;;
  esac
  log "tự dò cổng -> \$PORT"
fi

log "khởi chạy kiosk; URL=\$TARGET health=\$HEALTHURL"

# Chọn màn hình để vẽ lên.
#
# Hai việc TÁCH BIỆT, thiếu một là hỏng:
#   1. Đặt biến môi trường (WAYLAND_DISPLAY / DISPLAY) — khi chạy tay qua SSH
#      thì không có sẵn.
#   2. Nói cho Chromium biết dùng backend nào (--ozone-platform). Chromium trên
#      Pi OS mặc định chọn X11, nên dù có WAYLAND_DISPLAY nó vẫn cố mở X11 rồi
#      chết với "Missing X server or \$DISPLAY".
#
# Ưu tiên compositor CỤC BỘ của Pi. Nếu SSH có bật X11 forwarding thì DISPLAY
# trỏ về máy của bạn — mở Chromium ở đó là sai chỗ hoàn toàn.
RT="\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}"
WL="\${WAYLAND_DISPLAY:-}"
if [ -z "\$WL" ]; then
  for s in "\$RT"/wayland-*; do
    case "\$s" in *.lock) continue ;; esac
    [ -S "\$s" ] && { WL="\$(basename "\$s")"; break; }
  done
fi

OZONE=""
if [ -n "\$WL" ]; then
  export XDG_RUNTIME_DIR="\$RT"
  export WAYLAND_DISPLAY="\$WL"
  OZONE="--ozone-platform=wayland"
  SCREEN="Wayland (\$WL)"
elif [ -n "\${DISPLAY:-}" ] || [ -e /tmp/.X11-unix/X0 ]; then
  [ -z "\${DISPLAY:-}" ] && export DISPLAY=:0
  [ -f "\$HOME/.Xauthority" ] && export XAUTHORITY="\$HOME/.Xauthority"
  OZONE="--ozone-platform=x11"
  SCREEN="X11 (\$DISPLAY)"
else
  log "LỖI: không tìm thấy phiên desktop (không có wayland-* lẫn /tmp/.X11-unix/X0)"
  echo "Không tìm thấy phiên desktop nào đang chạy trên máy này." >&2
  echo "Kiosk cần Raspberry Pi OS bản Desktop, và phải đã đăng nhập vào màn hình." >&2
  echo "Bản Lite không có trình duyệt nên không chạy kiosk được." >&2
  exit 1
fi
log "màn hình: \$SCREEN | \$OZONE"
echo "==> Màn hình: \$SCREEN  (\$OZONE)" >&2

# Chromium đang mở sẵn với cùng profile thì lệnh mới chỉ mở thêm tab và BỎ QUA
# mọi cờ dòng lệnh (kể cả --kiosk và --autoplay-policy).
# (Không còn phải lo Chromium thường đang mở: kiosk chạy hồ sơ riêng.)
mkdir -p "$PROFILE_DIR"

# Chỉ cho phép MỘT launcher chạy. Script này được đăng ký ở cả XDG autostart lẫn
# labwc/wayfire; desktop nào đọc nhiều nơi sẽ gọi hai lần, và bản thứ hai chỉ mở
# thêm tab rồi bỏ qua hết cờ kiosk.
exec 9>"\$LOCK"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    log "đã có một launcher khác đang chạy -> thoát"
    exit 0
  fi
fi

# KHÔNG tự xoá cờ dừng ở đây. Đã bấm --stop để đi sửa chữa thì khởi động lại Pi
# cũng không được tự chiếm màn hình. Chỉ --start mới xoá cờ.

write_err_page() {
  SVC="\$(systemctl is-active yt-jukebox 2>/dev/null || echo 'không rõ')"
  PORTS="\$(ss -lntH 2>/dev/null | awk '{print \$4}' | grep -oE '[0-9]+\$' | sort -un | tr '\\n' ' ')"
  [ -z "\$PORTS" ] && PORTS='không đọc được'
  log "systemd yt-jukebox=\$SVC; cổng đang mở: \$PORTS"
  cat > "\$ERR_PAGE" <<HTMLEOF
<!doctype html><meta charset="utf-8"><title>Jukebox lỗi</title>
<body style="margin:0;background:#0b0f16;color:#e9edf5;font:16px/1.7 system-ui;padding:6vh 8vw">
<h1 style="color:#f87171;margin:0 0 18px">Không kết nối được server jukebox</h1>
<p>Trang phát nhạc cần server, nhưng gọi <code>\$HEALTHURL</code> không được sau 120 giây.</p>
<table style="border-collapse:collapse;margin:20px 0;font-size:15px">
<tr><td style="padding:4px 18px 4px 0;color:#8b97ab">Mã HTTP cuối</td><td><b>\$CODE</b></td></tr>
<tr><td style="padding:4px 18px 4px 0;color:#8b97ab">Service yt-jukebox</td><td><b>\$SVC</b></td></tr>
<tr><td style="padding:4px 18px 4px 0;color:#8b97ab">Cổng đang mở</td><td><b>\$PORTS</b></td></tr>
</table>
<p style="color:#8b97ab">Trang này sẽ tự thử lại. Muốn xem log, mở terminal (Ctrl+Alt+T):</p>
<pre style="background:#141a24;padding:16px;border-radius:10px;overflow:auto">sudo systemctl status yt-jukebox
journalctl -u yt-jukebox -n 40 --no-pager</pre>
<p style="color:#8b97ab">Nếu cổng đang mở là <b>3000</b> chứ không phải <b>80</b>, service đang chạy
file cũ. Cài lại rồi khởi động lại:</p>
<pre style="background:#141a24;padding:16px;border-radius:10px;overflow:auto">sudo bash install.sh</pre>
<p style="color:#5f6b80;font-size:13px">Log kiosk: \$LOG · Dừng hẳn: bash setup-kiosk.sh --stop</p>
</body>
HTMLEOF
}

# Loa Bluetooth kết nối CHẬM hơn kiosk. Chromium chọn ngõ ra ngay lúc mở luồng
# âm thanh, nên nếu nó chạy trước thì tiếng đổ vào HDMI/jack và loa im lặng —
# nhìn y hệt lỗi "Bluetooth không phát được".
AUDIO_SH="$AUDIO_SCRIPT"
route_audio() {
  [ -f "\$AUDIO_SH" ] || return 0
  command -v pactl >/dev/null 2>&1 || return 0
  if [ -n "\$(bluetoothctl devices 2>/dev/null)" ]; then
    for i in \$(seq 1 15); do
      pactl list short sinks 2>/dev/null | grep -q bluez_ && break
      sleep 2
    done
  fi
  if pactl list short sinks 2>/dev/null | grep -q bluez_; then
    if bash "\$AUDIO_SH" >> "\$LOG" 2>&1; then
      log "đã chuyển âm thanh sang loa Bluetooth"
    else
      log "cảnh báo: không đặt được loa Bluetooth (xem: bash setup-audio.sh --doctor)"
    fi
  else
    log "không thấy loa Bluetooth, dùng ngõ ra mặc định của hệ thống"
  fi
}

# ---------------------------------------------------------------- vòng giám sát
# Máy này chạy 24/7 làm bộ phát nhạc, không ai ngồi canh. Trình duyệt bị tắt
# (Alt+F4, tự crash, hết bộ nhớ) mà không có gì mở lại thì cả dàn im luôn tới
# khi có người phát hiện. Nên bọc trong vòng lặp: thoát là mở lại.
#
# Dừng hẳn (khi cần sửa chữa):  bash setup-kiosk.sh --stop
FAILS=0
while :; do
  if [ -f "\$STOP_FLAG" ]; then
    log "có cờ dừng (\$STOP_FLAG) -> không mở lại nữa"
    exit 0
  fi

  # Trình duyệt kiosk (hồ sơ riêng) VẪN đang chạy — ví dụ launcher cũ chết mà
  # cửa sổ còn đó. Gọi thêm một lần lúc này thì Chromium KHÔNG mở cửa sổ mới mà
  # nhét thêm một TAB vào cửa sổ cũ rồi thoát ngay; vòng lặp tưởng trình duyệt
  # vừa tắt, lại gọi tiếp -> mỗi vòng thêm một tab (lỗi thật: cả dãy tab
  # "Jukebox" cùng phát). Nên có rồi thì CHỜ nó tắt, không mở thêm.
  if pgrep -f -- "--user-data-dir=$PROFILE_DIR" >/dev/null 2>&1; then
    log "trình duyệt kiosk đang chạy sẵn -> chờ, không mở thêm tab"
    while pgrep -f -- "--user-data-dir=$PROFILE_DIR" >/dev/null 2>&1; do
      [ -f "\$STOP_FLAG" ] && exit 0
      sleep 5
    done
    continue
  fi

  # Cắt log nếu quá 1MB — Pi chạy bằng thẻ SD, đừng ghi vô hạn.
  [ -f "\$LOG" ] && [ "\$(stat -c%s "\$LOG" 2>/dev/null || echo 0)" -gt 1048576 ] && : > "\$LOG"

  # Chờ server sẵn sàng. Lúc Pi vừa boot, Chromium hay chạy trước khi Node
  # kịp lắng nghe cổng.
  READY=0
  TRIES=60
  for i in \$(seq 1 \$TRIES); do
    [ -f "\$STOP_FLAG" ] && break
    # KHÔNG thêm "|| echo 000": curl -w đã tự in 000 khi hỏng, thêm nữa thành 000000.
    CODE="\$(curl -s -o /dev/null --noproxy '*' -w '%{http_code}' --max-time 3 "\$HEALTHURL" 2>/dev/null)"
    [ -z "\$CODE" ] && CODE=000
    if [ "\$CODE" = "200" ]; then READY=1; log "server sẵn sàng sau \$i lần thử"; break; fi
    sleep 2
  done

  START="\$(date +%s)"
  if [ "\$READY" = "1" ]; then
    route_audio
    log "mở trình duyệt tới \$TARGET"
    $BROWSER \${OZONE:+"\$OZONE"} \\
      --user-data-dir="$PROFILE_DIR" \\
      --kiosk \\
      --autoplay-policy=no-user-gesture-required \\
      --password-store=basic \\
      --no-first-run \\
      --no-default-browser-check \\
      --disable-session-crashed-bubble \\
      --disable-features=Translate,InfiniteSessionRestore \\
      --check-for-update-interval=31536000 \\
      "\$TARGET" > "\$BROWSER_LOG" 2>&1
    RC=\$?
  else
    # Không kết nối được thì mở trang báo lỗi, KHÔNG mở trang trắng.
    # Màn hình trắng tinh không nói cho ai biết chuyện gì đang xảy ra.
    log "LỖI: không gọi được \$HEALTHURL sau \$TRIES lần thử (mã HTTP cuối: \$CODE)"
    write_err_page
    # --password-store=basic ở đây nữa: thiếu là hộp thoại keyring chặn luôn cả
    # trang báo lỗi, và bạn lại nhìn thấy một màn hình đứng im không rõ vì sao.
    $BROWSER \${OZONE:+"\$OZONE"} --user-data-dir="$PROFILE_DIR" --kiosk --no-first-run \\
      --password-store=basic --no-default-browser-check \\
      "file://\$ERR_PAGE" > "\$BROWSER_LOG" 2>&1
    RC=\$?
  fi

  RUNTIME=\$(( \$(date +%s) - START ))
  [ -f "\$STOP_FLAG" ] && { log "có cờ dừng -> thoát"; exit 0; }

  # Thoát ngay sau khi mở = hỏng thật (thiếu màn hình, profile khoá...). Lùi dần
  # thời gian chờ để khỏi quay vòng liên tục ghi mòn thẻ SD.
  if [ "\$RUNTIME" -lt 20 ]; then FAILS=\$((FAILS+1)); else FAILS=0; fi
  DELAY=5
  [ "\$FAILS" -ge 3 ] && DELAY=30
  [ "\$FAILS" -ge 6 ] && DELAY=120
  log "trình duyệt thoát (mã \$RC) sau \${RUNTIME}s -> mở lại sau \${DELAY}s (lỗi liên tiếp: \$FAILS)"
  sleep "\$DELAY"
done
EOF
chmod +x "$LAUNCHER"
echo "==> Đã tạo $LAUNCHER"

# --------------------------------------------------------------- đăng ký autostart
INSTALLED=0

# 1. XDG autostart — LXDE/X11 và phần lớn desktop đều đọc
mkdir -p "$(dirname "$DESKTOP")"
cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=Jukebox Player
Comment=$MARK
Exec=$LAUNCHER
X-GNOME-Autostart-enabled=true
EOF
echo "==> Đã tạo $DESKTOP (XDG autostart)"
INSTALLED=1

# 2. labwc — mặc định của Raspberry Pi OS bản Wayland đời mới.
#
# GHI VÔ ĐIỀU KIỆN. Trước đây chỗ này chỉ ghi khi ~/.config/labwc đã tồn tại,
# nên trên máy chưa có thư mục đó thì autostart im lặng không được đăng ký —
# chạy tay thì được mà khởi động lại thì không có gì xảy ra.
# labwc KHÔNG đọc ~/.config/autostart/, nên thiếu file này là hỏng hẳn.
mkdir -p "$(dirname "$LABWC_AUTOSTART")"
touch "$LABWC_AUTOSTART"
if ! grep -q "$MARK" "$LABWC_AUTOSTART"; then
  echo "$LAUNCHER & $MARK" >> "$LABWC_AUTOSTART"
fi
echo "==> Đã ghi $LABWC_AUTOSTART"
INSTALLED=1

# 3. wayfire — Raspberry Pi OS Bookworm bản Wayland
if [[ -f "$WAYFIRE_INI" ]]; then
  if ! grep -q "$MARK" "$WAYFIRE_INI"; then
    if grep -q '^\[autostart\]' "$WAYFIRE_INI"; then
      sed -i "/^\[autostart\]/a jukebox = $LAUNCHER $MARK" "$WAYFIRE_INI"
    else
      printf '\n[autostart]\njukebox = %s %s\n' "$LAUNCHER" "$MARK" >> "$WAYFIRE_INI"
    fi
    echo "==> Đã thêm vào $WAYFIRE_INI"
  fi
  INSTALLED=1
fi

[[ $INSTALLED -eq 1 ]] || { echo "Không đăng ký được autostart nào." >&2; exit 1; }

# --------------------------------------------------- compositor nào đang chạy
# Mỗi compositor đọc một file khác nhau. Nói rõ file nào mới thật sự có tác
# dụng, để khỏi tưởng đã cài xong mà thực ra không có gì chạy lúc khởi động.
COMP=""
for c in labwc wayfire lxsession openbox mutter; do
  if pgrep -x "$c" >/dev/null 2>&1; then COMP="$c"; break; fi
done
echo
case "$COMP" in
  labwc)
    echo "==> Đang chạy labwc -> file có tác dụng: $LABWC_AUTOSTART"
    echo "    (labwc KHÔNG đọc ~/.config/autostart/)" ;;
  wayfire)
    echo "==> Đang chạy wayfire -> file có tác dụng: $WAYFIRE_INI"
    if [[ ! -f "$WAYFIRE_INI" ]]; then
      echo "    !!! Chưa có $WAYFIRE_INI — autostart sẽ KHÔNG chạy." >&2
      echo "    Tạo file đó rồi chạy lại script này." >&2
    fi ;;
  lxsession|openbox|mutter)
    echo "==> Đang chạy $COMP -> file có tác dụng: $DESKTOP (XDG autostart)" ;;
  *)
    echo "==> Không nhận ra compositor nào đang chạy."
    echo "    Đã ghi cả 2-3 nơi; nếu khởi động lại vẫn không tự mở, gửi mình kết quả:"
    echo "      pgrep -a labwc wayfire lxsession openbox" ;;
esac

cat <<EOF

===================================================
 Xong. Thử ngay mà không cần khởi động lại:

   $LAUNCHER

 Kiosk giờ TỰ MỞ LẠI mỗi khi trình duyệt bị tắt hoặc crash.
 Nên Alt+F4 chỉ làm nó hiện lên lại sau vài giây. Muốn dừng hẳn:

   bash setup-kiosk.sh --stop      # dừng, không tự mở lại nữa
   bash setup-kiosk.sh --start     # chạy lại

 Kiosk dùng hồ sơ Chromium RIÊNG (không đụng Chromium bạn vẫn dùng).
 Có YouTube Premium thì đăng nhập một lần cho kiosk:
   bash setup-kiosk.sh --signin

 Gỡ tự khởi động:  bash setup-kiosk.sh --remove
===================================================
EOF
