#!/usr/bin/env bash
# Đưa âm thanh của Pi ra loa Bluetooth và giữ nguyên như vậy sau mỗi lần khởi động.
#
#   bash setup-audio.sh --doctor    # xem đang hỏng ở đâu (chạy cái này TRƯỚC)
#   bash setup-audio.sh             # tự chọn loa Bluetooth làm mặc định
#   bash setup-audio.sh --sink <tên-sink>
#   bash setup-audio.sh --list      # liệt kê tên sink để chọn tay
#
# KHÔNG chạy bằng sudo. Âm thanh thuộc về phiên đăng nhập của user, chạy bằng
# root là nói chuyện với một server âm thanh khác (hoặc không có server nào).
set -euo pipefail

WANT_SINK=""
MODE="apply"

for arg in "$@"; do
  case "$arg" in
    --doctor) MODE="doctor" ;;
    --list)   MODE="list" ;;
    --sink)   MODE="apply" ;;      # giá trị lấy ở vòng sau
    -*)       echo "Tham số lạ: $arg" >&2; exit 1 ;;
    *)        WANT_SINK="$arg" ;;
  esac
done

if [[ $EUID -eq 0 ]]; then
  echo "Đừng chạy bằng sudo — âm thanh gắn với phiên của user desktop." >&2
  echo "Chạy lại:  bash setup-audio.sh --doctor" >&2
  exit 1
fi

# pactl cần biết đường tới server âm thanh của phiên. Khi vào bằng SSH thì
# biến này thường trống, và pactl sẽ báo "Connection refused" dù loa vẫn kêu.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

if ! command -v pactl >/dev/null 2>&1; then
  echo "Không có pactl. Cài:  sudo apt-get install -y pulseaudio-utils" >&2
  exit 1
fi

if ! pactl info >/dev/null 2>&1; then
  echo "!!! Không kết nối được server âm thanh (PipeWire/PulseAudio)." >&2
  echo "    XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR" >&2
  echo "    Nếu bạn đang SSH: phải đăng nhập vào màn hình desktop của Pi ít nhất" >&2
  echo "    một lần thì phiên âm thanh mới tồn tại. Hoặc chạy trực tiếp trên Pi." >&2
  exit 1
fi

# pactl get-default-sink chỉ có từ PulseAudio 15 / PipeWire. Trên Pi OS đời cũ
# vẫn phải đọc từ "pactl info", nên bọc lại một lần cho chắc.
default_sink() {
  local d
  d="$(pactl get-default-sink 2>/dev/null || true)"
  # Không tin vào mã thoát: có bản in ra rỗng mà vẫn báo thành công.
  [[ -n "$d" ]] || d="$(pactl info 2>/dev/null | sed -n 's/^Default Sink: //p')"
  printf '%s' "$d"
}

# Tên sink Bluetooth luôn bắt đầu bằng bluez_
find_bt_sink() {
  pactl list short sinks 2>/dev/null | awk '$2 ~ /^bluez_/ {print $2; exit}'
}

# --------------------------------------------------------------------- liệt kê
if [[ "$MODE" == "list" ]]; then
  echo "Các sink (ngõ ra) hiện có:"
  pactl list short sinks | awk '{printf "   %s\n", $2}'
  echo
  echo "Mặc định: $(default_sink || echo '?')"
  exit 0
fi

# -------------------------------------------------------------------- chẩn đoán
if [[ "$MODE" == "doctor" ]]; then
  echo "===== CHẨN ĐOÁN ÂM THANH ====="
  echo
  echo "-- 1. Server âm thanh --"
  pactl info | sed -n 's/^Server Name/   Server/p; s/^Default Sink/   Sink mặc định/p'

  echo
  echo "-- 2. Ngõ ra (sinks) --"
  pactl list short sinks | awk '{printf "   %s  [%s]\n", $2, $NF}'
  BT="$(find_bt_sink || true)"
  if [[ -n "$BT" ]]; then
    echo "   -> có loa Bluetooth: $BT"
  else
    echo "   -> KHÔNG thấy sink bluez_* : loa chưa kết nối, hoặc đang ở chế độ"
    echo "      tai nghe thoại (HSP/HFP) chứ không phải A2DP."
  fi

  echo
  echo "-- 3. Âm lượng & tắt tiếng của sink mặc định --"
  DEF="$(default_sink || true)"
  if [[ -n "$DEF" ]]; then
    echo "   $DEF"
    pactl list sinks | awk -v s="$DEF" '
      $1=="Name:" {cur=$2}
      cur==s && /^\tMute:/ {printf "   Tắt tiếng: %s\n", $2}
      cur==s && /^\tVolume:/ {printf "   Âm lượng:  %s\n", $5}' | head -2
  fi

  echo
  echo "-- 4. Luồng đang phát (sink-inputs) --"
  # Đây là chỗ hay lộ ra vấn đề thật: Chromium đã mở luồng TRƯỚC khi loa
  # Bluetooth kết nối, nên nó vẫn đang đổ tiếng vào HDMI/jack 3.5.
  if [[ -z "$(pactl list short sink-inputs)" ]]; then
    echo "   (không có luồng nào — Chromium chưa phát, hoặc đang tạm dừng)"
  else
    pactl list sink-inputs | awk '
      /^Sink Input #/ {id=$3}
      /^\tSink:/ {sink=$2}
      /application.name =/ {app=$3; printf "   %s -> sink #%s  %s\n", app, sink, id}'
    echo "   (số sink ở trên phải khớp với sink Bluetooth thì mới ra loa)"
  fi

  echo
  echo "-- 5. Thiết bị Bluetooth --"
  if command -v bluetoothctl >/dev/null 2>&1; then
    bluetoothctl devices 2>/dev/null | sed 's/^/   /' || true
    echo "   --- đang kết nối ---"
    for mac in $(bluetoothctl devices 2>/dev/null | awk '{print $2}'); do
      info="$(bluetoothctl info "$mac" 2>/dev/null || true)"
      conn="$(printf '%s' "$info" | awk -F': ' '/Connected:/{print $2}')"
      trust="$(printf '%s' "$info" | awk -F': ' '/Trusted:/{print $2}')"
      name="$(printf '%s' "$info" | awk -F': ' '/Name:/{print $2}')"
      echo "   $mac  $name  connected=$conn trusted=$trust"
    done
  else
    echo "   không có bluetoothctl"
  fi

  echo
  echo "-- 6. Hồ sơ (profile) của card Bluetooth --"
  pactl list cards | awk '
    /^Card #/ {c=""}
    /^\tName: bluez_card/ {c=$2; printf "   %s\n", c}
    c!="" && /^\tActive Profile:/ {printf "   profile đang dùng: %s\n", $3; c=""}' || true
  echo "   (phải là a2dp-sink. Nếu là headset-head-unit thì tiếng sẽ rất tệ"
  echo "    hoặc câm hẳn khi phát nhạc.)"

  echo
  echo "===== HẾT ====="
  echo "Sửa tự động:  bash setup-audio.sh"
  exit 0
fi

# ---------------------------------------------------------------------- áp dụng
SINK="$WANT_SINK"
if [[ -z "$SINK" ]]; then
  SINK="$(find_bt_sink || true)"
fi
if [[ -z "$SINK" ]]; then
  echo "!!! Không tìm thấy loa Bluetooth nào đang kết nối." >&2
  echo "    Kết nối loa trước (biểu tượng Bluetooth trên thanh menu), rồi chạy lại." >&2
  echo "    Xem chi tiết:  bash setup-audio.sh --doctor" >&2
  exit 1
fi
echo "==> Dùng sink: $SINK"

# 1. Ép card Bluetooth sang A2DP. Nếu hệ thống trót chọn hồ sơ tai nghe thoại
#    thì chất lượng nhạc coi như hỏng, có khi câm luôn.
CARD="$(pactl list short cards | awk '$2 ~ /^bluez_card/ {print $2; exit}' || true)"
if [[ -n "$CARD" ]]; then
  PROF="$(pactl list cards | awk -v c="$CARD" '
    $1=="Name:" {cur=$2}
    cur==c && /Active Profile:/ {print $3; exit}')"
  if [[ "$PROF" != a2dp* ]]; then
    echo "==> Đổi hồ sơ $CARD: $PROF -> a2dp-sink"
    pactl set-card-profile "$CARD" a2dp-sink || \
      echo "    (không đổi được, bỏ qua — có loa chỉ hỗ trợ một hồ sơ)" >&2
    sleep 1
    SINK="$(find_bt_sink || echo "$SINK")"
  fi
fi

# 2. Đặt làm ngõ ra mặc định. WirePlumber nhớ lựa chọn này, nên lần khởi động
#    sau vẫn đúng loa.
echo "==> Đặt làm ngõ ra mặc định"
pactl set-default-sink "$SINK"

# 3. Bật tiếng và kéo âm lượng lên. Sink Bluetooth mới xuất hiện đôi khi bị
#    tắt tiếng sẵn — nhìn bề ngoài y hệt lỗi "không có tiếng".
pactl set-sink-mute "$SINK" 0 || true
pactl set-sink-volume "$SINK" 90% || true

# 4. Chuyển các luồng ĐANG phát sang loa mới.
#    Quan trọng: Chromium chọn ngõ ra lúc MỞ luồng. Kiosk khởi động lúc boot,
#    trước khi loa Bluetooth kịp kết nối, nên nó đang đổ tiếng vào HDMI. Đổi
#    mặc định thôi không đủ, phải kéo luồng cũ sang.
MOVED=0
for id in $(pactl list short sink-inputs | awk '{print $1}'); do
  pactl move-sink-input "$id" "$SINK" 2>/dev/null && MOVED=$((MOVED+1)) || true
done
echo "==> Đã chuyển $MOVED luồng đang phát sang $SINK"

# 5. Cho loa tự kết nối lại sau khi Pi khởi động.
if command -v bluetoothctl >/dev/null 2>&1; then
  MAC="$(printf '%s' "$SINK" | sed -n 's/^bluez_\(output\|sink\)\.\([0-9A-F_]*\)\..*/\2/p' | tr '_' ':')"
  if [[ -n "$MAC" ]]; then
    bluetoothctl trust "$MAC" >/dev/null 2>&1 && \
      echo "==> Đã đánh dấu tin cậy $MAC (tự kết nối lại sau khi khởi động)" || true
  fi
fi

echo
echo "==================================================="
echo " Xong. Thử phát một bài từ điện thoại xem có tiếng chưa."
echo
echo " Vẫn câm thì chạy:  bash setup-audio.sh --doctor"
echo " và gửi mình toàn bộ kết quả."
echo "==================================================="
