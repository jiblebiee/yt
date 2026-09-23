# YT Jukebox — máy phát nhạc YouTube nội bộ (kiểu Volumio)

Một web nội bộ để cả phòng cùng chọn nhạc. Kiến trúc giống Volumio: có **một
máy phát** nối loa, và **nhiều trang điều khiển** trên điện thoại/laptop.

| Trang | Ai mở | Vai trò |
|---|---|---|
| `http://<ip>/player` | Máy nối loa (Raspberry Pi, PC phòng làm việc) | Nơi duy nhất âm thanh phát ra |
| `http://<ip>/remote` | Mọi người trong LAN | Tìm nhạc, xếp hàng chờ, play/pause/next/volume |

**Nhạc chỉ phát khi trang `/player` đang mở.** Nếu không có máy phát nào online,
server tự chuyển sang trạng thái dừng và trang điều khiển hiện cảnh báo — giống
như Volumio khi không có output device.

Nhạc được phát qua trình nhúng chính thức của YouTube (YouTube IFrame Player),
không tải/lưu file về máy.

---

## Cài đặt trên Raspberry Pi / Linux

```bash
unzip yt-jukebox.zip -d ~
cd ~/yt-jukebox
sudo bash install.sh
```

Script sẽ: cài Node.js 20 nếu thiếu → chép mã sang `/opt/yt-jukebox` →
`npm install` → cài + bật systemd service (tự khởi động cùng máy).

### Quản lý service

```bash
sudo systemctl status yt-jukebox
sudo systemctl restart yt-jukebox
journalctl -u yt-jukebox -f          # xem log
sudo systemctl disable --now yt-jukebox
```

### Chạy thử không cài service

```bash
cd yt-jukebox && npm install && npm start
```

### Chạy bằng Docker (tuỳ chọn)

```bash
docker compose up -d
docker compose logs -f
```

**Docker không làm server nhẹ hơn.** Tiến trình Node vẫn tốn chừng đó RAM, và
bạn tốn thêm phần cho `dockerd`. Số đo thực tế của server này:

| | |
|---|---|
| Tiến trình Node lúc chạy | **~96 MB RSS** |
| `node_modules` trên đĩa | ~50 MB |
| Mã nguồn | 264 KB |
| `dockerd` trên Pi (thêm vào) | ~80–150 MB RAM |

Nếu mục tiêu là Pi nhẹ hơn thì Docker đi sai hướng — thứ nặng nhất trên máy đó
là **Chromium ở chế độ kiosk** (400–700 MB), không phải server.

Cái Docker thật sự cho bạn: dependency gói sẵn (không cần cài npm trên Pi —
đúng lỗi đã gặp lúc cài), nâng cấp bằng cách dựng lại container, gỡ là sạch,
và log tự xoay vòng (`max-size: 5m`) nên không ghi vô hạn lên thẻ SD.

Container chỉ chạy **server**. Trang `/player` vẫn là Chromium trên desktop của
Pi, ngoài container, vì nó cần loa và màn hình. Thư mục `./data` được gắn vào
container để token đăng nhập không mất khi dựng lại.

Đổi cổng: `PORT=8080 npm start`, hoặc sửa `Environment=PORT=` trong file service.

Service chạy ở **cổng 80** để không phải gõ `:3000`. Node vẫn chạy bằng user
thường — systemd cấp đúng một quyền `CAP_NET_BIND_SERVICE` (đã kiểm chứng là
vẫn hiệu lực cùng `NoNewPrivileges=true`).

---

## Giao diện điều khiển

### Lưới chọn bài

Kết quả tìm kiếm, gợi ý theo thể loại, playlist và lịch sử đều hiện dạng **lưới
thumbnail lớn** như menu chọn bài phòng hát — mắt nhận ra bài qua ảnh nhanh hơn
nhiều so với đọc một cột chữ.

- Bấm vào thẻ = **phát ngay**.
- Bấm **＋** (góc trên-trái) = **thêm vào cuối hàng chờ**.
- Bấm **▶ Mix** (góc trên-phải) = **phát ngay + tự nối mạch bài tương tự**, giống
  nút "Play all" trên thẻ Mix của YouTube.
- Bấm **✕** (góc dưới-trái, chỉ có ở danh sách gợi ý theo thể loại) = **không
  thích bài này**.

Nút Mix làm ba việc cùng lúc: phát bài đó ngay, nối các bài liên quan vào hàng
chờ, và **bật auto-radio** để nhạc chạy mãi không cần thêm bài thủ công. Nó cũng
tắt chế độ nghe liên tục theo thể loại, vì Mix bám theo *bài* chứ không theo *thể loại* —
hai thứ này chọi nhau, để cả hai thì không đoán được bài kế tiếp lấy từ đâu.

Tắt Mix: bấm nút 📻 ở thanh điều khiển dưới cùng.

### Xoá nhanh ô tìm kiếm

Nút **✕** trong ô tìm kiếm, chỉ hiện khi ô có chữ, xoá xong con trỏ vẫn ở lại
trong ô để gõ từ khoá mới ngay. Đây là nút tự làm chứ không dùng nút xoá sẵn của
trình duyệt — Chrome trên Android không hiện nó, và trên nền tối thì gần như
không nhìn thấy.

### Gạt bài gợi ý không thích

Nút **✕** ở góc dưới-trái thẻ. Bấm là bài biến mất và **một bài khác đôn vào
đúng chỗ đó ngay** — lưới không nhảy chỗ, không phải chờ tải lại. Làm được vì
server trả về 26 bài nhưng chỉ hiện 20, phần dư giữ sẵn để thế chỗ; sắp cạn thì
âm thầm lấy thêm mẻ mới.

Server **nhớ id đã gạt** (`data/hidden.json`, tối đa 1000 id) và loại nó khỏi
**mọi** chỗ gợi ý: nghe liên tục theo thể loại, tạo playlist, tự nối bài liên quan.

**Gạt nhiều quá thì sao?** Trước đây mỗi thể loại chỉ hỏi **một** từ khoá ngẫu
nhiên, nên gạt vài chục bài là mẻ đó cạn sạch và màn hình trắng trơn, không nói
vì sao. Giờ nó hỏi lần lượt các từ khoá của thể loại cho tới khi đủ bài; nếu
vẫn hết thì báo đúng nguyên nhân *"Bạn đã gạt hết bài của thể loại này (N bài
đang ẩn)"* kèm nút **Bỏ ẩn tất cả**.

Riêng **tìm kiếm thì không lọc** — gõ đúng tên một bài mà không thấy nó đâu còn
khó hiểu hơn nhiều. Bỏ ẩn từng bài: `curl -X POST http://<ip-pi>/api/unhide -H
'Content-Type: application/json' -d '{"id":"<video-id>"}'`; xem danh sách đang
ẩn ở `/api/hidden`; xoá sạch bằng `POST /api/unhide-all`.

Nút ✕ đặt xa hai nút ＋ và ▶ Mix, vì bấm nhầm "xoá" khi đang định thêm bài là
kiểu nhầm khó chịu nhất.

### Phân trang cho danh sách dài

"Hay nghe ở đây" và "Video đã thích" đều có thể dài vài chục thẻ — trên điện
thoại phải cuộn mãi mới qua nổi một mục. Cả hai giờ chia trang, có nút `‹ ›` và
số trang.

Mỗi trang **6 thẻ trên điện thoại, 12 trên màn rộng** — lưới 2 cột và 3 cột đều
chia hết cho 6 nên không có hàng cuối lẻ một thẻ trơ trọi, còn màn rộng thì 6
thẻ không đầy nổi một hàng, nhìn rất trống. Xoay máy là tự tính lại.

Một cái bẫy ở đây: `trackListHTML` đánh số thẻ theo **chỉ mục trong
`lists[key]`**, nên khi cắt trang phải gán `lists[key]` đúng bằng mảng của
trang đang hiện. Quên là bấm ＋ ở trang 2 lại thêm bài của trang 1. Có bài test
kiểm đúng chuyện đó.

Hai chỗ dùng chung một hàm `createPager` thay vì chép đôi — chép đôi thì chắc
chắn sẽ sửa một chỗ quên chỗ kia.

### Mở playlist rồi quay lại

Bấm `›` trên một playlist ở tab "Của tôi" sẽ nhảy sang tab "Tìm kiếm" để hiện
danh sách bài. Trước đây không có đường về: phải tải lại trang mới thoát ra
được. Giờ có thanh **‹ Quay lại** (kèm tên playlist và nút **＋ Thêm tất cả**),
và trang tự cuộn lên đầu.

Tìm kiếm mới sẽ xoá thanh đó — kể cả khi lượt tìm **hỏng**, vì để lại nút quay
về một playlist không còn hiển thị là sai hẳn.

Nhân đó vá một lỗi CSS: `.mixhead{display:flex}` **đè lên** thuộc tính `hidden`
của trình duyệt (quy tắc UA luôn thua quy tắc tác giả), nên thanh vẫn hiện dù
đã đặt `hidden`. Giờ có `[hidden]{display:none !important}` chặn một lần cho
mọi phần tử.

### Tab "Của tôi" chỉ còn "Video đã thích"

Data API **không** cung cấp lịch sử xem, nên mục dưới cùng là video đã thích chứ
không phải "nghe gần đây".

Chỗ này từng có lỗi: còn sót một biến `viaApi` từ thời có hai cách đăng nhập.
Nó ném `ReferenceError` **ngay, trước cả khi `fetch` chạy**, nên `.catch` không
bao giờ được gọi và vòng xoay quay mãi không dừng. Bộ test cũ không bắt được vì
khi chưa đăng nhập thì hàm thoát sớm, không chạm tới dòng hỏng — giờ có test
chạy đúng nhánh đã-đăng-nhập, cả khi API trả lỗi.

### Nhớ tạm kết quả tìm kiếm

Mở tab Home gọi tìm kiếm cho **cả** danh sách gợi ý lẫn 5 playlist — cùng những
từ khoá đó. Đổi thể loại rồi quay lại cũng vậy. Nên kết quả được nhớ tạm **5
phút** (tối đa 40 mục, đầy thì bỏ mục cũ nhất). Không có nó thì Pi ngồi chờ mạng
suốt, và YouTube cũng dễ chặn IP vì gọi quá dày.

### Nháy đúp không phóng to

`touch-action: manipulation` trên `<html>` bỏ đúng cử chỉ nháy-đúp-để-zoom —
bấm nhanh hai bài liên tiếp là dính ngay. Vẫn giữ chụm-hai-ngón, nên người cần
phóng to để đọc thì làm được.

Cố ý **không** dùng `user-scalable=no` ở thẻ viewport: iOS Safari bỏ qua nó, mà
nó lại chặn luôn chụm-hai-ngón trên máy khác — chặn đúng người thật sự cần.

### Thanh điều khiển tự ẩn khi lướt (điện thoại)

Trên điện thoại thanh điều khiển chiếm gần 1/4 màn hình. Lướt xuống là nó trượt
đi; ba thứ kéo nó về:

- lướt về gần đầu trang (dưới 120px),
- **dừng lướt 4 giây**,
- **chạm vào bất cứ thứ gì liên quan tới nhạc** — chọn bài, thêm bài, play/pause,
  chỉnh âm lượng.

**Cố ý không hiện lại khi lướt ngược lên.** Lướt qua lướt lại để tìm bài mà
thanh cứ thò ra thụt vào theo từng cử động ngón tay thì rối mắt hơn là hữu ích.

Không ẩn khi đang kéo thanh tua hay đang mở popup âm lượng — thanh trượt mất
giữa chừng là hỏng hẳn thao tác đang làm. Màn rộng (≥900px) cũng không ẩn: ở đó
nó không chiếm mấy chỗ, ẩn đi chỉ gây giật.

Một chi tiết phải xử lý riêng: bấm vào một thẻ ở giữa trang thì trình duyệt cuộn
thẻ đó vào tầm nhìn, và sự kiện cuộn bắn ra **ngay sau** cú bấm sẽ giấu thanh đi
lần nữa. Nên lệnh nhạc không chỉ "hiện" mà còn **giữ** thanh lại 4 giây.

### Thanh tab gim khi cuộn

Thanh **Hàng chờ · Tìm kiếm · Home · Của tôi** dính ngay dưới header khi cuộn,
nên đang xem giữa danh sách vẫn chuyển tab được mà không phải cuộn ngược lên.

Không đặt cứng `top` bằng px được: header co giãn theo vùng an toàn của máy có
tai thỏ, theo việc có hiện cảnh báo "chưa có máy phát" hay không, và theo cả cỡ
chữ hệ thống. Nên JS đo chiều cao header, đổ vào biến `--headerH`, và theo dõi
bằng `ResizeObserver` để header đổi cỡ lúc nào thanh tab bám theo lúc đó. Cột
hàng chờ bên phải (bố cục PC) cũng neo theo cùng biến này.

### Vùng an toàn (tai thỏ iPhone)

Trang mở từ biểu tượng ngoài màn hình chính iPhone chạy **toàn màn hình**, tức
là nội dung nằm ngay dưới đồng hồ và cột sóng. Header giờ chừa đúng
`env(safe-area-inset-top)` nên không bị che nữa; thanh điều khiển dưới cùng
chừa `inset-bottom` (vạch home) và `inset-left/right` (tai thỏ khi xoay ngang).

Thanh điều khiển là `position:fixed` nên **không** ăn padding của `body` —
phải tự chừa lề riêng. Các inset gói vào biến `--sat/--sar/--sab/--sal` để bài
kiểm thử giả lập được máy có tai thỏ (Playwright không giả lập `env()` được).

Nhân đó cũng vá một lỗi khác: 7 nút điều khiển trước đây để `flex:none`, màn
hẹp là nút âm lượng bị đẩy văng khỏi màn hình. Giờ chúng co lại thay vì tràn,
đã kiểm ở 320 / 360 / 393px.

### Hai cột trên máy tính bảng

Từ 900px trở lên, hàng chờ tách hẳn ra cột phải và **luôn nhìn thấy** — bên
trái chọn bài, bên phải xem hàng chờ, không phải bấm qua lại giữa hai tab. Tab
"Hàng chờ" tự ẩn vì đã thừa. Dưới 900px thì quay về một cột như cũ, xoay máy
giữa chừng cũng đổi theo.

Cột hàng chờ rộng **420px**, và từ 1280px trở lên nới thành **500px** — tên bài
tiếng Việt dài, cột hẹp thì cắt cụt ngay từ chữ thứ tư, nhìn vào không biết bài
nào với bài nào.

### Nghe liên tục chỉ lấy bài lẻ, không lấy video tổng hợp

Tìm "nhạc trẻ hay nhất" trên YouTube ra gần như toàn video một tiếng: *"LK Nhạc
Trẻ | BXH Top 20"*, *"NHẠC REMIX TIKTOK TRIỆU VIEW"*. Nghe thì được, nhưng hàng
chờ hỏng hẳn — một "bài" chiếm cả tiếng, bấm bài kế là mất luôn 50 phút còn
lại, và mục "hay nghe" đếm sai bét.

Nên có hai lớp chặn:

1. **Từ khoá tìm** bỏ hết "hay nhất", "tuyển tập", "top 20" — đó chính là mấy
   cụm dẫn tới video tổng hợp. Thay bằng `official mv` / `official audio`, cách
   các hãng đặt tên bản phát hành chính thức của từng bài.
2. **Lọc kết quả** loại video dài quá **12 phút**, và loại theo tiêu đề: `LK`,
   `liên khúc`, `tổng hợp`, `nonstop`, `BXH`, `top 20`, `mashup`, `triệu view`,
   `hay nhất`… Phải lọc cả tiêu đề vì nhiều bản tổng hợp không khai độ dài.

Lọc chặt mà còn dưới 5 bài thì tự nới ra lưới lỏng (chỉ chặn clip vụn và
Shorts) — thà có nhạc để nghe còn hơn một danh sách trống.

Cùng bộ lọc này áp cho cả **Mix**: feed "bài liên quan" của YouTube cũng đầy
video tổng hợp.

### Playlist gợi ý (tự tạo, 5 cái một lần)

Ở đầu tab **Home**. Đây là câu trả lời cho việc
YouTube toàn video tổng hợp 1 tiếng: thay vì phát cái đó, mình **tự ghép** một
liên khúc từ tối đa **15 bài lẻ official**.

Khác biệt quan trọng: mỗi bài là **một mục riêng** trong hàng chờ. Bấm bài kế
là nhảy đúng bài, không mất 50 phút còn lại như khi phát video tổng hợp — và
thống kê "hay nghe" đếm đúng từng bài.

Ba nguồn để ghép:

| Nguồn | Lấy bài từ đâu |
|---|---|
| **Theo thể loại** | Gộp **tất cả** từ khoá official của thể loại đang chọn ở dưới (chế độ nghe liên tục chỉ dùng một từ khoá ngẫu nhiên, nên playlist đa dạng hơn hẳn) |
| **Từ bài hay nghe** | Lấy 4 bài hay bật nhất làm hạt giống, tìm bài liên quan quanh chúng |
| **Từ khoá tự gõ** | Gõ tên ca sĩ / bài hát, server tìm với đuôi `official mv` và `official audio` |

Mọi nguồn đều đi qua bộ lọc bài lẻ ở trên, bỏ trùng theo video id, rồi trộn
ngẫu nhiên (Fisher–Yates, không phải `sort(() => Math.random()-0.5)` — cách đó
cho phân phối lệch, vài bài gần như luôn đứng đầu).

Mở tab Home là **5 playlist tự hiện sẵn**, không phải bấm nút nào. Mỗi thẻ là
một playlist 15 bài hoàn chỉnh; bấm vào thẻ là đẩy cả 15 bài vào hàng chờ và
phát ngay. Không ưng cả mẻ thì bấm **⟳** để đổi mẻ khác.

Các playlist **không trùng bài nhau**: mẻ bài lấy về được trộn rồi chia thành
từng khối 15 rời nhau. Trùng thì chọn thẻ nào cũng như nhau, bày ra 5 thẻ để
làm gì.

Tên playlist lấy theo **bài đầu tiên** trong đó, không phải "Playlist #1 / #2" —
nhìn tên một bài cụ thể là đoán ngay được nó nghe kiểu gì.

Để đủ 5 × 15 = 75 bài sau khi bỏ trùng và lọc video tổng hợp, mỗi từ khoá xin
**50** kết quả. Xin 30 chỉ ra được 4 playlist.

Đổi thể loại thì playlist đổi theo — nếu không nhãn ghi "từ Nhạc trẻ" mà bài
lại là Bolero. Nguồn **Từ khoá tự gõ** không tự chạy: chưa gõ gì thì chưa có gì
để tạo.

### "Hay nghe ở đây"

Ở tab **Home**, danh sách bài hay bật nhất **trên chính cái dàn này**.

Server tự đếm: mỗi bài nghe quá **30 giây** thì +1 (bài ngắn dưới 60 giây lấy
mốc nửa bài). Mốc 30 giây để loại các lần bấm nhầm rồi chuyển bài ngay.

Đây là thống kê tại chỗ, **không phải gợi ý của YouTube** — nó phản ánh đúng
thứ hay bật trong phòng, không phải thứ YouTube muốn đẩy. Không tốn quota API,
không gọi mạng.

Số liệu nằm ở `data/history.json`, ghi xuống đĩa mỗi 60 giây (không ghi mỗi lần
đếm — thẻ SD có hạn số lần ghi), giữ tối đa 400 bài.

**Không làm được:** mã số bài kiểu phòng hát (`50123`) và gõ tắt chữ cái đầu
(`NDBD`). Hai thứ đó cần một thư viện bài cố định; jukebox này lấy nhạc thẳng
từ YouTube nên không có kho để đánh số.

### Cài bản mới mà giao diện không đổi

Hai nguyên nhân, cách sửa khác hẳn nhau — trang tự nhận ra và báo đúng cái nào.

**Trình duyệt giữ bản cũ.** Chrome lấy `remote.html` từ cache mà không hỏi lại
server; trang đã "Thêm vào màn hình chính" còn dai hơn. Server giờ gửi
`Cache-Control: no-cache` cho mọi file HTML nên chuyện này không tái diễn, nhưng
bản cache **cũ vẫn nằm sẵn trên máy** — lần đầu sau khi nâng cấp có thể vẫn
thấy giao diện cũ. Lúc đó trang hiện băng đỏ kèm nút **Tải lại bản mới**, hoặc
tự làm:

- Android/Chrome: menu ⋮ → Cài đặt → Quyền riêng tư → Xoá dữ liệu duyệt web
- Nhanh hơn: mở `http://<ip-pi>/remote?v=1` (thêm tham số lạ là buộc tải mới)
- Máy tính: `Ctrl+Shift+R`

**Server chưa restart.** File tĩnh đọc từ đĩa mỗi request nên giao diện mới ngay,
còn `server.js` nằm trong bộ nhớ tiến trình. Trang sẽ báo *"Server đang chạy mã
cũ"* kèm lệnh `sudo systemctl restart yt-jukebox`. (`install.sh` đã tự restart,
nên chỉ gặp khi bạn chép file bằng tay.)

Kiểm tra nhanh phiên bản hai bên:

```bash
curl -s http://localhost/healthz          # build của server
grep "const BUILD" /opt/yt-jukebox/public/remote.html   # build của giao diện
```

### Thanh âm lượng chỉnh loa thật của máy chủ

Trước đây thanh âm lượng chỉnh **bên trong trình phát YouTube**. Loa của Pi đang
vặn nhỏ thì kéo hết cỡ vẫn nhỏ, muốn to phải SSH vào chạy `pactl` — đúng thứ
không ai muốn làm giữa bữa tiệc.

Giờ nếu máy chủ chỉnh được loa (có `pactl` và có phiên âm thanh) thì thanh này
điều khiển **đúng cái loa đó**, còn trình phát YouTube được ghim ở 100%. Ghim là
bắt buộc: để cả hai mức thì chúng nhân với nhau, kéo hết cỡ vẫn chỉ được 60%.

Popup âm lượng ghi rõ đang chỉnh cái gì — *"Loa máy chủ · Loa Bluetooth JBL"*
hay *"Mức trong trình phát"* kèm lý do (thiếu `pactl`, chạy trong Docker, chưa
đăng nhập desktop…).

Server dò lại ngõ ra mỗi 60 giây, nên loa Bluetooth nối sau khi server chạy vẫn
được nhận. Kéo thanh trượt bắn ra hàng chục lệnh mỗi giây, nên chỉ chạy **một**
tiến trình `pactl` tại một thời điểm và giữ lại mức cuối cùng — đẻ ngần ấy tiến
trình là treo Pi.

---

## Khi YouTube đổi API (tìm mãi không ra bài)

Đây là rủi ro lớn nhất của hệ thống. `youtubei.js` đọc **API nội bộ** của
YouTube, mà YouTube đổi nội bộ vài tháng một lần. Khi đó tìm kiếm và gợi ý hỏng,
hệ thống lặng lẽ tụt xuống scraper dự phòng rồi tắt hẳn.

```bash
bash update.sh --check        # xem tình trạng, không đụng gì
sudo bash update.sh           # nâng youtubei.js, tự kiểm, tự lùi nếu hỏng
sudo bash update.sh --rollback
```

`update.sh` sao lưu bản đang dùng, nâng lên bản mới nhất, rồi **gọi thử YouTube
bằng chính thư viện vừa cài**. Không gọi được thì tự quay lại bản cũ và restart
— không để máy chết vì một lần nâng cấp.

Trang điều khiển tự hỏi `/api/health/youtube` mỗi phút và hiện băng đỏ khi có
vấn đề, kèm luôn lệnh cần chạy. Phân biệt bốn trạng thái:

| | |
|---|---|
| `idle` | chưa gọi lần nào từ lúc khởi động — **không** cảnh báo, tránh báo động giả |
| `ok` | đường chính chạy tốt |
| `degraded` | chỉ còn scraper, hoặc lần gọi gần nhất hỏng — vẫn nghe được nhưng nên nâng thư viện |
| `down` | không lấy được gì |

Thứ tự sự kiện được ghi bằng cờ `last: 'ok' \| 'err'` chứ không so mốc thời
gian: một lượt tìm hỏng rồi lùi sang scraper diễn ra trong **cùng một
mili-giây**, so timestamp sẽ ra kết quả tuỳ may rủi.

---

## Loa Bluetooth không ra tiếng

```bash
bash setup-audio.sh --doctor    # xem hỏng ở đâu
bash setup-audio.sh             # sửa tự động
```

Chạy **không có sudo** — âm thanh gắn với phiên đăng nhập của user, chạy bằng
root là nói chuyện với một server âm thanh khác.

Bốn nguyên nhân thường gặp, script xử lý cả bốn:

1. **Chromium mở luồng âm thanh trước khi loa kết nối.** Trình duyệt chọn ngõ ra
   đúng lúc bắt đầu phát và giữ nguyên; loa nối sau cũng không được dùng. Đổi
   sink mặc định thôi chưa đủ, phải kéo luồng đang phát sang (`move-sink-input`).
2. **Card Bluetooth đang ở hồ sơ `headset-head-unit`** (chế độ tai nghe thoại)
   thay vì `a2dp-sink`. Nhạc sẽ rất tệ hoặc câm hẳn.
3. **Sink Bluetooth bị tắt tiếng hoặc âm lượng 0** ngay khi vừa xuất hiện.
4. **Loa không được đánh dấu tin cậy**, nên sau khi Pi khởi động lại nó không tự
   kết nối. Script chạy `bluetoothctl trust` cho đúng thiết bị đó.

Kiosk cũng đã được vá cho khớp: trước khi mở Chromium, launcher chờ tối đa 30
giây cho loa Bluetooth xuất hiện rồi mới gọi `setup-audio.sh`. Không có loa
Bluetooth nào thì bỏ qua ngay, không làm chậm khởi động.

---

## Gõ địa chỉ cho gọn trên điện thoại

**Đã bỏ hẳn phần tên miền nội bộ.** Trước đây có `setup-domain.sh` dựng
`nhac.me` / `nhac.home` bằng dnsmasq, nhưng cái giá thì lớn hơn cái lợi: phải
cài thêm dịch vụ DNS, phải vào router đổi DNS cho cả mạng, đuôi tên miền nào
cũng có rủi ro riêng, và khi nó hỏng thì chỉ thấy trang trắng chứ không thấy
nguyên nhân. Đổi lại chỉ tiết kiệm được vài ký tự khi gõ.

Dùng thẳng IP:

```
http://192.168.10.214/remote     # điện thoại
http://192.168.10.214/player     # máy nối loa
```

Ba cách để khỏi phải gõ lại:

1. **Lưu ra màn hình chính** (khuyên dùng). Safari hoặc Chrome > Chia sẻ >
   "Thêm vào MH chính". Từ đó bấm một cái là vào, chạy toàn màn hình như app.
2. **mDNS** — Pi có sẵn `avahi`, nên `http://raspberrypi.local/remote` dùng
   được ngay, không cấu hình gì. Chạy tốt trên iPhone, Mac, Windows 10+ và
   Android 12 trở lên; Android đời cũ thì phập phù. (Tên máy thật xem bằng
   `hostname`.)
3. **Đặt IP tĩnh cho Pi** trong phần DHCP của router, để IP không đổi sau mỗi
   lần mất điện. Đây mới là thứ đáng làm, chứ không phải tên miền.

Trang player trên chính Pi thì `setup-kiosk.sh` luôn mở bằng `127.0.0.1` — máy
tự nói chuyện với chính nó, không cần DNS, không cần mạng.

### Đã lỡ cài tên miền trước đó?

`install.sh` tự dọn: xoá `/etc/dnsmasq.d/jukebox.conf`, xoá dòng đánh dấu
`# jukebox-domain` trong `/etc/hosts`, rồi khởi động lại dnsmasq. Nếu trước đây
có trỏ DNS trong router về Pi thì **trả lại mặc định** — đó là phần duy nhất
script không tự làm được.

Kiosk đã cài từ bản cũ còn ghi cứng tên miền trong launcher; `install.sh` sẽ
báo và bảo chạy lại `bash setup-kiosk.sh`. Kiểm tra bất cứ lúc nào:

```
bash setup-kiosk.sh --doctor
```

---

## Dùng thế nào

1. Trên máy nối loa: mở trình duyệt tới `/player`, bấm **“Bật loa”** một lần.
   Trình duyệt bắt buộc phải có thao tác click đầu tiên thì mới cho phép phát
   âm thanh — sau đó cứ để tab này mở.
   *Mẹo:* để tự động, đặt Chromium chạy kiosk khi boot rồi bấm nút một lần.
2. Mọi người mở `/remote` trên điện thoại (cùng Wi-Fi).
3. Gõ tên bài để tìm, hoặc dán thẳng link YouTube (video / playlist / `youtu.be` / Shorts).
4. `＋` thêm vào hàng chờ, `▶` phát ngay.

Có sẵn: hàng chờ dùng chung, phát ngẫu nhiên, lặp tất cả / lặp một bài, tua,
chỉnh âm lượng, xoá & đổi thứ tự bài, hiện tên người đã thêm bài.

---

## Tắt quảng cáo (cần YouTube Premium)

Điểm quan trọng cần hiểu về kiến trúc: **đăng nhập ở server không tắt được
quảng cáo.** Phiên đăng nhập trên server chỉ dùng để đọc metadata (tìm kiếm,
playlist). Nhạc thật sự phát bằng YouTube IFrame player chạy trong Chrome trên
máy loa, và nó dùng cookie của chính trình duyệt đó.

Nên muốn không quảng cáo, hãy đăng nhập ngay trong Chrome trên máy loa:

1. Trên máy loa, mở Chromium → đăng nhập tài khoản **có YouTube Premium**
   tại `youtube.com`.
2. Giữ nguyên profile đó, mở `http://<ip>/player`, bấm "Bật loa".
3. Xong. Embed player tự nhận ra Premium và không chèn quảng cáo.

Nếu tài khoản không có Premium thì sẽ vẫn có quảng cáo xen giữa các bài. Dự án
này cố tình **không** cài cơ chế né quảng cáo — vừa vi phạm điều khoản YouTube,
vừa là thứ hay khiến các project dạng này bị chặn.

### Tự mở trang player khi Pi khởi động (kiosk)

```bash
bash setup-kiosk.sh          # KHÔNG dùng sudo
```

Chạy dưới đúng user sẽ đăng nhập vào desktop. Script sẽ:

- Tìm Chromium (`chromium-browser` / `chromium` / `google-chrome`).
- Tạo `~/.local/bin/jukebox-kiosk.sh` — **chờ server sẵn sàng** (thăm dò
  `/healthz` tối đa 2 phút) rồi mới mở trình duyệt. Lúc Pi vừa boot, Chromium
  hay chạy trước khi Node kịp lắng nghe cổng.
- Đăng ký tự khởi động ở cả ba nơi tuỳ desktop đang dùng: XDG autostart
  (`~/.config/autostart/`), labwc, và wayfire. Cuối cùng script in ra
  **compositor nào đang chạy** và **file nào mới thật sự có tác dụng**.

**Raspberry Pi OS đời mới dùng labwc, mà labwc KHÔNG đọc `~/.config/autostart/`**
— nó chỉ đọc `~/.config/labwc/autostart`. Đây là cái bẫy hay gặp nhất: chạy tay
thì được, khởi động lại thì không có gì xảy ra. Script luôn ghi file labwc kể cả
khi thư mục chưa tồn tại.

Thử ngay mà không cần khởi động lại:

```bash
~/.local/bin/jukebox-kiosk.sh
```

Chạy được cả khi bạn **SSH vào Pi**: launcher tự dò phiên desktop và in ra nó
chọn màn hình nào. Không có phiên desktop nào thì nó nói thẳng thay vì để
Chromium chết với thông báo khó hiểu.

Có **hai** việc tách biệt, thiếu một là hỏng:

1. Đặt `WAYLAND_DISPLAY` / `DISPLAY` — chạy tay qua SSH thì không có sẵn.
2. Truyền `--ozone-platform=wayland|x11` cho Chromium. Chromium trên Pi OS mặc
   định chọn X11, nên **dù đã có `WAYLAND_DISPLAY` nó vẫn cố mở X11 rồi chết**
   với `Missing X server or $DISPLAY`. Đây là cái bẫy khó đoán nhất, vì biến môi
   trường nhìn thì đúng hết.

Launcher cũng ưu tiên compositor **cục bộ** của Pi: nếu bạn SSH có bật X11
forwarding thì `DISPLAY` trỏ về máy của bạn, mở Chromium ở đó là sai chỗ.

**Cổng nào?** Không phải khai báo — launcher tự hỏi `/healthz` ở 80, rồi 3000,
rồi 8080 mỗi lần khởi động và dùng cổng nào trả lời. Dò lúc chạy chứ không ghi
cứng lúc cài, nên đổi cổng sau này cũng không phải cài lại. Muốn ép cứng thì
vẫn được:

```bash
JUKEBOX_URL=http://127.0.0.1:3000/player \
JUKEBOX_HEALTH=http://127.0.0.1:3000/healthz \
bash setup-kiosk.sh
```

Địa chỉ luôn là `127.0.0.1` — máy này mở trang của chính nó, không cần DNS,
không cần mạng, không có gì để hỏng.

#### Chạy trên Ubuntu / Linux desktop khác (không phải Raspberry Pi OS)

Server thì chạy ở đâu cũng được. Riêng phần kiosk có hai chỗ khác nhau giữa
các bản Linux, và cả hai đều từng làm kiosk im lặng không lên trên Ubuntu 24.04:

- **Chromium trên Ubuntu là gói snap.** Snap bị AppArmor nhốt: quyền `home`
  chỉ cho đọc/ghi file **không ẩn** trong thư mục nhà. Hồ sơ kiosk để trong
  `~/.config` là Chromium không mở nổi — mà cũng không báo gì. Script tự nhận
  ra snap và chuyển hồ sơ sang `~/snap/chromium/common/jukebox-kiosk-profile`.
  Trang báo lỗi cũng chuyển theo, nếu không thì đúng lúc cần biết lỗi gì lại
  chỉ thấy màn hình trống.
- **Mỗi desktop đọc một chỗ autostart khác nhau.** Raspberry Pi OS dùng labwc
  hoặc wayfire; Ubuntu dùng GNOME. Ngoài `~/.config/autostart`, script còn
  đăng ký một **systemd user service** (`jukebox-kiosk.service`) chờ
  `graphical-session.target` — cách chắc ăn nhất trên GNOME, KDE và các bản
  desktop đời mới.

Cài lại còn **dẹp launcher cũ** trước khi ghi đè. Bản cũ kẹt trong vòng lặp
sẽ giữ khoá, và bản mới vừa cài chạy lên thấy khoá có người cầm nên ghi đúng
một dòng *"đã có một launcher khác đang chạy -> thoát"* rồi biến mất — nhìn log
thì tưởng bản mới không ăn thua, thật ra nó chưa từng được chạy.

Khi trình duyệt thoát ngay (dưới 20 giây), log kiosk chép luôn mấy dòng cuối
của chính trình duyệt sang. *"trình duyệt thoát (mã 21)"* một mình thì chẳng
nói được gì.

Cài xong, script **chạy thử ngay** và báo kết quả, thay vì để bạn khởi động lại
rồi mới biết hỏng. Nếu không lên, nó in luôn mấy dòng log cuối. Chẩn đoán đầy
đủ (hệ điều hành, phiên, trình duyệt, hồ sơ, autostart, âm thanh):

```bash
bash setup-kiosk.sh --doctor
```

#### Hồ sơ Chromium riêng cho kiosk

Kiosk chạy Chromium bằng hồ sơ riêng (`~/.config/jukebox-kiosk-profile`), tách
hẳn khỏi Chromium bạn vẫn dùng. Trước đây dùng chung hồ sơ, nên chỉ cần một
cửa sổ Chromium thường đang mở là lệnh kiosk bị gộp vào đó: mất chế độ toàn
màn hình, mất quyền tự phát (hiện màn "Bật loa" mỗi lần chọn bài), và mỗi vòng
tự mở lại lại nhét thêm một tab — ra cả dãy tab cùng phát.

Giờ thì:

- Trình duyệt kiosk đang chạy thì launcher chờ, không bao giờ mở thêm tab.
- Server chỉ cho **một** trang phát được phát. Mở trang phát thứ hai thì trang
  cũ tự im và hiện nút **Phát ở đây** để giành lại khi cần.

Có YouTube Premium? Hồ sơ riêng nghĩa là phải đăng nhập lại một lần cho kiosk:

```bash
bash setup-kiosk.sh --signin
```

#### Tự mở lại khi bị tắt

Máy này chạy 24/7 làm bộ phát, không ai ngồi canh. Trình duyệt bị tắt (Alt+F4,
tự crash, hết bộ nhớ) mà không có gì mở lại thì cả dàn im tới khi có người phát
hiện. Nên launcher là một **vòng giám sát**: trình duyệt thoát là nó mở lại.

- Thoát ngay dưới 20 giây bị coi là hỏng thật (thiếu màn hình, profile bị khoá).
  Thời gian chờ giữa các lần lùi dần **5s → 30s → 120s**, để không quay vòng
  liên tục ghi mòn thẻ SD.
- Chạy đúng **một** launcher, giữ bằng `flock`. Trước đây script đăng ký tự
  khởi động ở cả XDG autostart lẫn labwc, desktop nào đọc cả hai sẽ mở hai
  Chromium — bản thứ hai chỉ mở thêm tab và bỏ qua sạch các cờ kiosk.
- Log ghi rõ từng lần mở lại: `~/.local/share/jukebox-kiosk.log`.

Vì vậy `Alt+F4` và `pkill` chỉ làm nó hiện lên lại sau vài giây. Muốn dừng hẳn:

```bash
bash setup-kiosk.sh --stop     # dừng, đặt cờ không tự mở lại
bash setup-kiosk.sh --start    # chạy lại
```

Cờ dừng **sống qua cả lần khởi động lại máy**. Đã tắt để đi sửa chữa thì reboot
cũng không được tự chiếm màn hình — chỉ `--start` mới xoá cờ.

Gỡ tự khởi động: `bash setup-kiosk.sh --remove`.

Chẩn đoán khi có trục trặc — gom mọi thứ vào một lần chạy:

```bash
bash setup-kiosk.sh --doctor
```

#### Hộp thoại "Unlock Keyring"

Chromium mặc định cất cookie vào keyring hệ thống. Keyring đang khoá thì nó
dừng lại chờ mật khẩu — với một máy chạy 24/7 thì mỗi lần khởi động là đứng im
ở đó, không ai bấm.

Launcher truyền `--password-store=basic` nên Chromium không đụng keyring nữa,
mà cất vào file riêng trong profile. **Đánh đổi:** file đó chỉ được che chứ
không mã hoá thật, nên ai lấy được thẻ SD là đọc được cookie trong profile —
kể cả cookie đăng nhập YouTube nếu bạn dùng tài khoản Premium ở đó. Với một
máy nhạc đặt cố định trong văn phòng thì đổi lại được, nhưng nên biết.

Muốn giữ keyring thì bỏ cờ đó đi và đặt mật khẩu keyring thành rỗng để nó tự
mở khoá — nhưng mức an toàn thực tế cũng tương đương.

#### Khi kiosk hiện màn hình trắng

Không bao giờ được để màn hình trắng tinh — nó không nói cho ai biết chuyện gì
đang xảy ra. Nếu launcher không gọi được `/healthz` sau 60 lần thử, nó **mở một
trang báo lỗi** ngay trên màn hình đó, ghi rõ: mã HTTP cuối cùng, trạng thái
service `yt-jukebox`, danh sách cổng đang mở, và lệnh cần chạy tiếp.

Dấu hiệu hay gặp nhất: trang lỗi cho thấy cổng đang mở là **3000** thay vì
**80** — nghĩa là systemd vẫn dùng file service cũ. Chạy `sudo bash install.sh`
là xong.

Log của launcher: `~/.local/share/jukebox-kiosk.log`. Launcher cũng ghi cảnh báo
nếu phát hiện Chromium đã chạy sẵn — khi đó lệnh mới chỉ mở thêm tab và **bỏ qua
toàn bộ cờ dòng lệnh**, kể cả `--kiosk` lẫn `--autoplay-policy`.

### Bỏ bước bấm "Bật loa"

Trình duyệt bình thường chặn phát âm thanh cho tới khi có người bấm chuột — vì
vậy mới có màn hình "Bật loa". Script kiosk ở trên chạy Chromium với cờ
`--autoplay-policy=no-user-gesture-required`, và **trang player tự dò**: nếu
trình duyệt cho phép tự phát thì màn hình đó không bao giờ hiện ra, Pi khởi động
là nhạc chạy luôn.

Cách dò: ưu tiên `navigator.getAutoplayPolicy()`, trình duyệt nào không có API
đó thì thử phát một đoạn WAV im lặng để xem có bị chặn không.

Ngoài ra còn một cơ chế canh chừng: nếu server báo đang phát mà vị trí bài hát
đứng yên quá 10 giây (và không phải đang buffer), trang sẽ hiện lại nút bấm —
tránh trường hợp tưởng mở được mà thật ra vẫn bị chặn, dẫn tới im lặng mà không
ai biết vì sao.

---

## Đăng nhập tài khoản YouTube (tuỳ chọn)

Vào tab **Của tôi** trên trang điều khiển → **Đăng nhập YouTube**. Server hiện
một mã, bạn mở `google.com/device` trên điện thoại và nhập mã đó (giống hệt cách
đăng nhập YouTube trên TV). Trang tự cập nhật khi xong.

Sau khi đăng nhập bạn có thêm:

- Tab **Gợi ý** — feed trang chủ YouTube theo tài khoản của bạn, kèm các chip lọc
  ("Âm nhạc", "Mới tải lên"…) giống giao diện thật.
- **Playlist của tôi** — mở xem từng bài, hoặc thêm cả playlist vào hàng chờ.
- **Nghe gần đây** — lịch sử xem, phát lại nhanh.
- Kết quả **tìm kiếm được cá nhân hoá** theo gu của tài khoản.

### Tài khoản có nhiều kênh (brand account)

Nếu tài khoản Google của bạn có nhiều kênh YouTube, device flow sẽ lấy **kênh
mặc định** — thường không phải kênh bạn muốn (hay gặp: nó chọn nhầm profile trẻ em).

Sau khi đăng nhập, tab **Của tôi** hiện danh sách kênh. Bấm **"Dùng kênh này"**
ở kênh đúng. Lựa chọn lưu ở `data/config.json` và được áp dụng lại mỗi lần khởi
động, nên chỉ phải chọn một lần.

Về mặt kỹ thuật: lựa chọn này được truyền vào `Innertube.create()` qua tham số
`on_behalf_of_user` (pageId của kênh), đúng cơ chế YouTube dùng để phân biệt các
brand account trên cùng một tài khoản Google. Danh sách kênh chỉ hiện khi tài
khoản thật sự có từ 2 kênh trở lên.

Đăng xuất sẽ xoá luôn lựa chọn kênh, để lần đăng nhập sau bằng tài khoản khác
không gửi nhầm pageId cũ.

### Giới hạn của đăng nhập kiểu TV

Luồng device flow đăng nhập dưới danh nghĩa client **TV** của YouTube. Mà các
browseId của dữ liệu cá nhân — `FEhistory` (lịch sử), `FEplaylist_aggregation`
(playlist), `FEwhat_to_watch` (gợi ý) — chỉ tồn tại ở client **WEB**. Gọi bằng
context TV thì YouTube trả về **HTTP 400**.

Server có thử ép các lệnh này sang context WEB rồi rơi về TV nếu hỏng. Log cho
biết đường nào đã đi:

```
[browse] FEhistory OK với client WEB          <- ổn
[browse] FEhistory lỗi với client WEB: ...    <- WEB bị chặn, đang thử TV
```

**Thực tế đo được:** cả hai đều 400. Token OAuth kiểu TV không được YouTube
chấp nhận ở context WEB, kể cả cho bộ chuyển kênh (`getInfo(true)` vốn đã tự
chạy client WEB). Nên với cách đăng nhập bằng mã TV, ba tab Gợi ý / Playlist /
Lịch sử **không dùng được** — đây là giới hạn phía YouTube, không vá bằng code
được.

Tìm kiếm, hàng chờ và phát nhạc **vẫn chạy bình thường** vì chúng không cần
đăng nhập. Dán thẳng link playlist YouTube vào ô tìm kiếm vẫn thêm được cả
playlist vào hàng chờ.

### Đăng nhập bằng YouTube Data API (khuyến nghị)

Đây là cách chính thức: bạn tự tạo một OAuth client trên Google Cloud, app dùng
client đó để xin quyền đọc dữ liệu của bạn. Không cookie, không scrape.

**Được:** playlist (kể cả riêng tư), video đã thích, kênh đã đăng ký.
**Không được:** lịch sử xem và gợi ý trang chủ — Data API **không hề có** hai
endpoint này. Không phải app thiếu tính năng. Vì vậy khi đăng nhập kiểu này,
tab "Gợi ý" tự đổi thành **"Đăng ký"** và mục "Nghe gần đây" đổi thành
**"Video đã thích"**.

#### Tạo OAuth client (làm một lần, ~15 phút)

1. Vào [console.cloud.google.com](https://console.cloud.google.com) → tạo project mới.
2. **APIs & Services → Library** → tìm **YouTube Data API v3** → **Enable**.
3. **APIs & Services → OAuth consent screen** → chọn **External** → điền tên
   app và email → Save.
4. **Quan trọng — trạng thái publish:** để ở **Testing** thì Google cho refresh
   token **hết hạn sau 7 ngày**, tức mỗi tuần bạn phải đăng nhập lại. Bấm
   **Publish app** để chuyển sang **Production** thì token không bị giới hạn đó
   nữa. App chưa được Google xác minh sẽ hiện màn hình cảnh báo "unverified" —
   bấm Advanced → Continue là qua. Với app cá nhân dùng trong nhà thì không sao.
5. **Credentials → Create Credentials → OAuth client ID** → Application type
   chọn **TVs and Limited Input devices**.
6. Copy **Client ID** và **Client Secret**.

#### Nối vào app

Tab **Của tôi** → dán Client ID + Client Secret → **Lưu Client ID** →
**Đăng nhập Google**. App hiện một mã, bạn mở `google.com/device` nhập mã.

Ở màn hình cấp quyền, **Google cho bạn chọn kênh nào** — đây chính là chỗ giải
quyết vấn đề chọn nhầm profile trẻ em. Chọn đúng kênh bạn muốn.

#### Quota

Mặc định 10.000 unit/ngày. `playlists`, `playlistItems`, `subscriptions`,
`videos` mỗi lệnh chỉ tốn **1 unit** nên dùng thoải mái. Riêng `search.list`
tốn **100 unit**, nên phần tìm kiếm của app **cố tình không dùng Data API** —
vẫn để `youtubei.js` lo, miễn phí và không giới hạn.

Token nằm ở `data/gapi-tokens.json`, quyền 600. Thu hồi bất cứ lúc nào tại
[myaccount.google.com/permissions](https://myaccount.google.com/permissions).

### Đăng nhập bằng cookie (để thư viện chạy được)

Cách duy nhất lấy được đầy đủ dữ liệu cá nhân là dùng cookie của một phiên WEB
thật. Vào tab **Của tôi** → **Đăng nhập bằng cookie**.

Lấy cookie trên máy tính đã đăng nhập YouTube bằng **đúng profile bạn muốn**:

1. Mở `youtube.com` → `F12` → tab **Network**
2. `F5`, bấm vào request đầu tiên trong danh sách
3. Kéo tới **Request Headers**, tìm dòng `Cookie:`
4. Copy **toàn bộ** giá trị dòng đó, dán vào ô trong app

**Đừng dùng `document.cookie` trong Console** — nó không trả về các cookie
HttpOnly, nên sẽ thiếu `SAPISID` và không dùng được. Server kiểm tra điều này
và từ chối ngay nếu thiếu.

Nếu trình duyệt đăng nhập nhiều tài khoản Google, nhập thêm số thứ tự tài khoản
(0 là tài khoản đầu tiên) — nó thành header `X-Goog-Authuser`.

Sau khi lưu, server **thử đọc playlist ngay** để xác nhận cookie dùng được.
Hỏng thì cookie bị xoá luôn, không giữ lại — tránh việc app kẹt ở trạng thái
"đã đăng nhập" mà mọi thứ đều lỗi.

**Rủi ro cần cân nhắc:** cookie YouTube cho quyền truy cập tài khoản Google của
bạn, và nó nằm trong `data/cookie.txt` trên thẻ SD của Pi (quyền 600). Nguy
hiểm hơn token OAuth. Cookie cũng hết hạn theo chu kỳ, lúc đó phải dán lại.
Muốn thu hồi ngay: đổi mật khẩu Google, hoặc đăng xuất tất cả thiết bị trong
phần bảo mật tài khoản.

### Bảo mật token

Refresh token nằm ở `data/credentials.json`, quyền `600`. **Token này cho phép
truy cập tài khoản YouTube của bạn** — ai đọc được ổ đĩa Pi là dùng được. Thu hồi
bằng nút **Đăng xuất**, hoặc bất cứ lúc nào tại
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
(hiện dưới tên **"YouTube on TV"**).

Đổi chỗ lưu token: đặt biến môi trường `DATA_DIR`.

---

## Ghi chú kỹ thuật

- **Tìm kiếm không cần API key**: dùng thư viện [`youtubei.js`](https://github.com/LuanRT/YouTube.js),
  nói chuyện với InnerTube API nội bộ của YouTube. Không cần key, không dính
  quota 10.000 unit/ngày của YouTube Data API, và thư viện được cập nhật
  upstream mỗi khi YouTube đổi cấu trúc — chỉ cần `npm update youtubei.js`.
  Nếu vì lý do gì đó nó hỏng, server **tự động rơi về** bộ scraper đọc
  `ytInitialData` (hàm `scrapeSearch`/`scrapePlaylist` trong `server.js`), và
  lùi 60 giây trước khi thử lại InnerTube.

- **Vì sao không tìm kiếm thẳng từ trình duyệt?** Trang `/remote` không thể tự
  `fetch()` tới `youtube.com` — YouTube không gửi header CORS nên trình duyệt
  chặn. Phần tìm kiếm buộc phải chạy ở server.
- **Đồng bộ**: toàn bộ trạng thái nằm trên server, đẩy xuống client qua
  WebSocket (`/ws`). Trang player báo tiến độ mỗi giây; hết bài thì server tự
  chuyển bài kế.
- **Video lỗi / chặn nhúng**: player báo lỗi, server tự bỏ qua và sang bài kế,
  đồng thời hiện thông báo trên các trang điều khiển.
- **Bảo mật**: không có đăng nhập — thiết kế cho mạng nội bộ tin cậy. Nếu cần
  giới hạn, chặn cổng 3000 ở firewall hoặc đặt sau nginx có basic auth.
- **Máy phát cần có loa và trình duyệt hiện đại** (Chromium). Raspberry Pi OS
  Desktop là đủ; bản Lite không có trình duyệt nên không làm máy phát được.

## Hàng chờ còn nguyên khi khởi động lại

Hàng chờ được lưu vào `data/queue.json`, vị trí đang nghe vào `data/playhead.json`.
Restart service, cài bản mới, hay Pi mất điện: bật lên là còn nguyên danh sách,
đúng bài đang phát, đúng giây đang nghe dở, cùng âm lượng và chế độ lặp.

- **Đang phát lúc tắt** thì máy phát nối lại là phát tiếp — nhưng chỉ khi nối
  lại trong vòng 3 phút. Mất điện cả đêm thì sáng ra hàng chờ vẫn còn, nhưng
  đứng yên chờ bấm Phát, không tự mở nhạc.
- Hẹn giờ tắt đã tới trong lúc máy nghỉ thì cũng không tự phát lại.
- Nhẹ cho thẻ SD: danh sách bài chỉ ghi khi có thay đổi; vị trí trong bài là
  file vài chục byte, 20 giây mới ghi một lần.
- Ghi kiểu file tạm rồi đổi tên, nên mất điện giữa lúc ghi vẫn còn bản cũ
  nguyên vẹn. File hỏng hay bị sửa bậy thì server bỏ qua dòng hỏng và vẫn chạy.

Muốn xoá sạch hàng chờ khi khởi động: `sudo rm /opt/yt-jukebox/data/queue.json`
rồi restart — hoặc bấm nút xoá hàng chờ trên điện thoại như bình thường.

## Kiểm thử

```bash
npm test                 # chạy cả bảy bộ
node test/selftest.js    # 41 bài: parser, lọc bài, ghép playlist, ẩn bài, luồng player<->remote
node test/gapitest.js    # 18 bài: YouTube Data API (fetch giả lập)
node test/audiotest.js   #  7 bài: âm lượng loa máy chủ (pactl giả lập)
node test/persisttest.js # 11 bài: hàng chờ còn nguyên sau restart / mất điện
node test/playertest.js  #  8 bài: trang phát (YouTube giả): bài kẹt, nhiều tab
node test/shelltest.js   # 16 bài: script cài đặt (dọn tên miền cũ, launcher kiosk)
node test/uitest.js      # 78 bài: giao diện thật bằng Chromium (cần playwright)
```

Năm bộ đầu không cần internet. `uitest.js` cần `npm install -D playwright`; nếu
bản Chromium đi kèm không khớp, đặt `CHROME_PATH` trỏ tới Chromium có sẵn.

**Những chỗ không kiểm được ở máy phát triển:** container bị YouTube chặn (403),
nên mọi đường ra YouTube — tìm kiếm, bài liên quan, thể loại, playlist — chỉ
kiểm bằng dữ liệu giả và hàm tìm tiêm vào. Tương tự, máy test không có
PulseAudio nên phần âm lượng kiểm bằng `pactl` giả lập. Logic thì chắc, còn
chất lượng kết quả thật phải chạy trên Pi mới biết.

## Cấu trúc

```
yt-jukebox/
├── server.js              # Express + WebSocket + youtubei.js + OAuth
├── audio.js               # âm lượng loa máy chủ qua pactl
├── update.sh              # nâng youtubei.js khi YouTube đổi API
├── package.json
├── public/
│   ├── player.html        # máy nối loa
│   ├── remote.html        # trang điều khiển
│   └── favicon.svg
├── data/                  # token, hàng chờ, lịch sử nghe (tự tạo, quyền 600, đừng commit)
├── test/
│   ├── selftest.js
│   ├── gapitest.js
│   ├── audiotest.js
│   ├── persisttest.js
│   ├── playertest.js
│   ├── shelltest.js
│   └── uitest.js
├── yt-jukebox.service     # systemd unit
├── install.sh             # script cài tự động
└── README.md
```
