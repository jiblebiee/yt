# Jukebox Remote — app Android

App này chỉ là **vỏ WebView** mở trang `/remote` của máy chủ Jukebox chạy trên
Raspberry Pi. Toàn bộ giao diện và logic vẫn nằm ở Pi, nên mỗi lần bạn cập nhật
máy chủ là app tự có tính năng mới — không phải build lại APK.

Có hai cách dùng trên điện thoại, chọn cách nào cũng được:

## Cách 1 — Không cần build gì (khuyên dùng thử trước)

Mở Chrome trên điện thoại → vào `http://<IP-của-Pi>` → menu ⋮ →
**Add to Home screen / Thêm vào màn hình chính**.

Biểu tượng Jukebox xuất hiện như một app thật, mở lên là toàn màn hình, không
có thanh địa chỉ (nhờ `manifest.webmanifest` đã thêm vào máy chủ).

Hạn chế: vì LAN chạy HTTP thường (không HTTPS) nên Android không đăng ký được
service worker — app không chạy offline. Với cái remote này thì không sao, vì
không có mạng LAN thì cũng chẳng điều khiển được Pi.

## Cách 2 — Build APK thật

Cần **Android Studio** (Hedgehog trở lên) hoặc JDK 17 + Android SDK.

```bash
# Trên máy có Android Studio
cd android
gradle wrapper --gradle-version 8.7   # tạo ./gradlew, chỉ cần làm một lần
./gradlew assembleDebug
```

APK nằm ở `app/build/outputs/apk/debug/app-debug.apk`. Chép sang điện thoại,
bật "Cài từ nguồn không xác định", rồi cài.

Hoặc đơn giản hơn: mở thư mục `android/` bằng Android Studio → nút ▶ Run.
Android Studio tự tạo gradle wrapper và tự cài lên máy đang cắm USB.

### Địa chỉ máy chủ

Mặc định điền sẵn `http://192.168.1.50` (khai báo ở `app/build.gradle`,
dòng `resValue "string", "default_server", ...`).

Lần mở app đầu tiên nó sẽ hỏi địa chỉ, bạn sửa được ngay lúc đó. Sau này muốn
đổi: bấm nút Back ở màn hình chính → **Đổi địa chỉ**.

### Vì sao phải bật cleartext HTTP

Android 9 trở lên chặn HTTP thường. Máy chủ trong LAN không có chứng chỉ HTTPS
hợp lệ, nên `AndroidManifest.xml` khai báo `usesCleartextTraffic="true"` cùng
`res/xml/network_security_config.xml`. Chỉ ảnh hưởng đúng app này.

### Vì sao không làm TWA

TWA (Trusted Web Activity — cách đóng gói PWA thành app "xịn") bắt buộc HTTPS
và một file xác thực đặt trên tên miền công khai. Jukebox chỉ chạy trong nhà
qua HTTP nên không dùng được. WebView wrapper là cách phù hợp duy nhất.
