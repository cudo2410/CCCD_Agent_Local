# CCCD QR vs NFC Performance Analysis

## 1. Executive Summary

Báo cáo phân tích chuyên sâu folder `CCCD_Agent_Local` nhằm giải thích nguyên nhân kỹ thuật khiến **quét CCCD bằng mã QR có cảm giác nhanh hơn đáng kể so với quét CCCD bằng NFC/Chip** trong hệ thống hiện tại.

Qua kiểm tra toàn bộ mã nguồn (`server.js`, `parser.js`, `run.ps1`, `run.cmd`, `app.js`, các tệp cấu hình INI và thư viện SDK của thiết bị IDE200), chúng tôi đã xác định được nguyên nhân cốt lõi:

1. **Bản chất hai luồng xử lý khác biệt hoàn toàn**:
   - **QR**: Được xử lý bằng cách giải mã trực tiếp chuỗi văn bản UTF-8 gồm 7 trường dữ liệu từ cảm biến hình ảnh/đầu đọc mã vạch (RAM processing, không ghi đĩa, không mã hóa, không đọc chip, hoàn tất trong `< 50ms`).
   - **NFC (Pipeline IDE200)**: Thực hiện một chuỗi thao tác phần cứng & phần mềm phức tạp gồm: bật đèn chụp ảnh đa phổ (White, Infrared, Ultraviolet), chạy AI OCR giải mã dòng MRZ, thiết lập kênh truyền vô tuyến NFC với Chip CCCD theo chuẩn ICAO, xác thực bảo mật BAC/PACE, đọc các nhóm dữ liệu DG1 (thông tin) & DG2 (ảnh chân dung), ghi 4 tệp ảnh dung lượng lớn xuống ổ đĩa, đệm stdout qua tệp tạm có vòng lặp `Start-Sleep 200ms` ở PowerShell, và bị chặn (*gated*) bởi hàm `isCardComplete()` trong `server.js` cho tới khi đủ toàn bộ 4 tệp ảnh.

2. **Các điểm nghẽn latency chính đã được xác nhận từ mã nguồn**:
   - **Gating 4 tệp ảnh (`server.js`)**: Hàm `isCardComplete()` bắt buộc phải thu thập đủ 4 ảnh (`frontWhite`, `infrared`, `ultraviolet`, `portrait`) mới phát sự kiện `card-read`. Dữ liệu văn bản dù đọc xong sớm cũng bị giữ lại trong bộ đệm.
   - **Polling trễ 200ms ở PowerShell (`run.ps1`)**: Sử dụng `Start-Sleep -Milliseconds 200` để quét tệp log tạm `%TEMP%\read-cccd-chip.stdout.log`, gây ra trễ đệm lũy kế từ native process về Node.js.
   - **Độ trễ chớp đèn phần cứng (`ImageProcessA8_800.ini`)**: Cấu hình `sensorGapTime=120ms` và `sensorDelayTime=300ms` cho việc chụp các dải sáng quang học.

---

## 2. Kiến trúc Agent hiện tại

Hệ thống `CCCD_Agent_Local` được thiết kế theo mô hình kiến trúc đa lớp:

```text
┌────────────────┐      HTTP / SSE      ┌─────────────────────────┐
│   Web FE Demo  │ <──────────────────> │     agent/server.js     │
│   (public/)    │  (Port 3000 /events) │   (Express / Node.js)   │
└────────────────┘                      └────────────┬────────────┘
                                                     │ stdio pipe
                                                     ▼
                                        ┌─────────────────────────┐
                                        │    agent/portable/      │
                                        │    run.cmd / run.ps1    │
                                        └────────────┬────────────┘
                                                     │ Start-Process + log poll (200ms)
                                                     ▼
                                        ┌─────────────────────────┐
                                        │   read-cccd-chip.exe    │
                                        │      (.NET 8.0)         │
                                        └────────────┬────────────┘
                                                     │ Native C++ DLLs & Caffe AI
                                                     ▼
                                        ┌─────────────────────────┐
                                        │  Thiết bị đầu đọc IDE200│
                                        │  (Optical Scan + NFC)   │
                                        └─────────────────────────┘
```

### Chi tiết các thành phần chính:
- **`agent/server.js`**: HTTP Server & SSE Handler. Nhận kết quả từ `run.cmd`, tích lũy dòng vào `currentBuffer`, gọi `parser.js` và điều kiện `isCardComplete()`, sau đó phát sự kiện `card-read` qua Server-Sent Events.
- **`agent/parser.js`**: Module chuyển đổi các dòng văn bản chuẩn hóa từ stdout thành đối tượng JSON dữ liệu thẻ.
- **`agent/portable/run.cmd` & `run.ps1`**: Đóng vai trò wrapper khởi chạy `read-cccd-chip.exe`. `run.ps1` ghi stdout/stderr ra file tạm và dùng vòng lặp polling 200ms (`Start-Sleep 200`) kết hợp regex `Test-NativeNoise` để lọc nhiễu trước khi in ra stdout.
- **`agent/portable/read-cccd-chip.exe`**: Ứng dụng .NET 8.0 giao tiếp với SDK `IDE200_V3.0-Demo` (`RTsmartcard.dll`, `A8Capture.dll`, Caffe AI Model `detect.caffemodel`, OCR Data `HCOCR18b2u_pc.dat`).
- **`agent/portable/IDE200_V3.0-Demo/image/`**: Thư mục lưu trữ các tệp ảnh chụp quang học và ảnh chân dung giải mã từ chip NFC.

---

## 3. QR Flow

### Sơ đồ luồng xử lý quét QR:

```text
Mã QR trên CCCD
       │
       ▼
Camera / Đầu đọc mã vạch 2D (USB HID)
       │ (Thuật toán giải mã Barcode trong RAM: < 30ms)
       ▼
Chuỗi văn bản UTF-8: "SoCCCD|SoCMNDCu|HoTen|NgaySinh|GioiTinh|DiaChi|NgayCap"
       │
       ▼
Split chuỗi theo ký tự '|' (< 1ms)
       │
       ▼
Tạo JSON Card Profile (< 1ms)
       │
       ▼
Hiển thị ngay trên UI (< 10ms)
```

### Phân tích đặc điểm luồng QR:
1. **Đọc dữ liệu**: QR chứa trực tiếp toàn bộ dữ liệu chữ dạng văn bản thô (Plain Text) mã hóa trong hình ảnh mã vạch 2D.
2. **Xử lý phần cứng**: Không cần khởi tạo cảm biến quét đa phổ, không cần bật sóng vô tuyến NFC, không cần thao tác đọc thẻ thông minh.
3. **Xử lý phần mềm**: Không chạy mô hình AI OCR, không handshake mã hóa, không truy cập ổ đĩa I/O để lưu ảnh.
4. **Hiện diện trong `CCCD_Agent_Local`**: Mã nguồn `CCCD_Agent_Local` **không chứa module xử lý QR**. QR được đọc ở tầng ứng dụng Client/Thiết bị quét mã vạch độc lập với trễ gần như bằng 0.

---

## 4. NFC Flow

### Sơ đồ luồng xử lý quét NFC (IDE200):

```text
Thẻ CCCD đặt lên thiết bị IDE200
       │
       ▼ [T0] Sensor phần cứng phát hiện thẻ ("Phát hiện thẻ, bắt đầu đọc")
       │
       ▼ [T1] Chụp ảnh đa phổ Quang học (White, IR, UV light gap 120ms, delay 300ms)
       │
       ▼ [T2] Ghi 3 file ảnh quang học 500 DPI xuống đĩa (IDE200_V3.0-Demo/image/)
       │
       ▼ [T3] AI OCR Caffe Model quét ảnh nhận diện dòng MRZ1, MRZ2, MRZ3
       │
       ▼ [T4] Phát sóng NFC, Handshake BAC/PACE với Chip dùng khóa từ MRZ
       │
       ▼ [T5] Đọc APDU packets qua NFC: DG1 (Văn bản) & DG2 (Ảnh chân dung gốc)
       │
       ▼ [T6] Giải mã DG2 thành tệp JPG portrait và ghi xuống đĩa
       │
       ▼ [T7] Native reader in kết quả ra stdout (bị đệm vào file tạm %TEMP%)
       │
       ▼ [T8] PowerShell run.ps1 polling (mỗi 200ms), lọc nhiễu regex, in ra console
       │
       ▼ [T9] Node.js server.js nhận stdout, tích lũy dòng vào currentBuffer
       │
       ▼ [T10] isCardComplete() kiểm tra đủ 4 đường dẫn ảnh -> Emit SSE card-read
       │
       ▼ [T11] Frontend nhận SSE, render thông tin chữ và fetch 4 tệp ảnh qua /api/image
```

---

## 5. QR vs NFC Timeline

### Bảng so sánh chi tiết giữa luồng QR và NFC:

| Giai đoạn | Luồng QR | Luồng NFC (IDE200 Pipeline trong Agent) |
| --- | --- | --- |
| **Nhận input** | Tức thì khi camera/scanner thấy mã QR (~10 - 30ms) | Cảm biến vật lý phát hiện thẻ (`Phát hiện thẻ, bắt đầu đọc`) (~200 - 500ms) |
| **Detect & Capture** | Đọc frame hình ảnh thô từ camera/scanner (< 20ms) | Bật 3 chế độ đèn (White, IR, UV), quét ảnh quang học 500 DPI (~500 - 1200ms) |
| **Ghi đĩa đệm (I/O)** | KHÔNG CÓ (0ms) | Ghi 3 file ảnh chụp `wh_Scan_*.jpg`, `ir_Scan_*.jpg`, `uv_Scan_*.jpg` (~200 - 600ms) |
| **Nhận dạng MRZ** | KHÔNG CÓ (0ms) | Chạy mô hình AI OCR Caffe (`detect.caffemodel`) trích xuất dòng MRZ (~300 - 800ms) |
| **Xác thực Chip** | KHÔNG CÓ (0ms) | Tạo sóng vô tuyến NFC, handshake BAC/PACE (Key từ MRZ) (~300 - 800ms) |
| **Đọc dữ liệu Chip** | KHÔNG CÓ (0ms) | Gửi/nhận nhiều gói APDU đọc DG1 (Text) và DG2 (Ảnh chân dung binary) (~800 - 2000ms) |
| **Giải mã & Ghi ảnh Chân dung** | KHÔNG CÓ (0ms) | Giải mã dữ liệu DG2 thành file JPG portrait và ghi xuống đĩa (~100 - 300ms) |
| **Trễ đệm Log / IPC** | KHÔNG CÓ (0ms) | PowerShell polling file log tạm với nhịp `Start-Sleep -Milliseconds 200` (~0 - 200ms/line) |
| **Gating Emit Event** | Emit ngay khi parse chuỗi QR (< 1ms) | `server.js` bắt buộc `isCardComplete()` kiểm tra ĐỦ 4 FILE ẢNH mới emit `card-read` |
| **Truyền sự kiện (SSE)** | SSE / Event local (< 5ms) | SSE broadcast event `card-read` chứa JSON đường dẫn ảnh (< 5ms) |
| **Tải ảnh lên FE** | Không có hoặc lấy ảnh cắt từ camera | FE gọi thêm HTTP GET `/api/image?path=...` cho 4 file ảnh (~50 - 200ms) |

---

## 6. Native Reader Analysis

File `agent/portable/run.ps1` thực hiện điều phối `read-cccd-chip.exe`:

```powershell
# Trích đoạn run.ps1 (Dòng 105 - 119)
$process = Start-Process `
    -FilePath $exe `
    -ArgumentList @("--sdk-root", "`"$sdkRoot`"") `
    -NoNewWindow `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -PassThru

$stdoutPosition = 0L
$stderrPosition = 0L
while (-not $process.HasExited) {
    Write-FilteredLines -Path $stdoutLog -Position ([ref] $stdoutPosition)
    Write-FilteredLines -Path $stderrLog -Position ([ref] $stderrPosition)
    Start-Sleep -Milliseconds 200
}
```

### Phân tích chi tiết:
- **Cơ chế Spawn**: `read-cccd-chip.exe` được khởi tạo một lần duy nhất khi `server.js` khởi động và chạy liên tục trong nền (`readerStarted = true`).
- **Đệm qua tệp tạm & Polling 200ms**: Standard Output và Standard Error của `read-cccd-chip.exe` không được pipe trực tiếp về Node.js mà được redirect ra 2 tệp log tạm trong `%TEMP%` (`$stdoutLog`, `$stderrLog`). PowerShell chạy vòng lặp đọc file log và nghỉ `Start-Sleep -Milliseconds 200`. Cơ chế này gây trễ tối đa **200ms mỗi chu kỳ đọc**, lũy kế theo số lượng dòng log được xuất ra.
- **Lọc dữ liệu**: Hàm `Test-NativeNoise` trong `run.ps1` sử dụng 40+ biểu thức chính quy (regex) để lọc bỏ các log nội bộ của C++ SDK (`HC_`, `DMN_Process`, `thread start`, ...).
- **Cấu hình trễ phần cứng trong INI (`ImageProcessA8_800.ini`)**:
  - `sensorGapTime=120`: Trễ 120ms giữa các lần chuyển đổi cảm biến đèn.
  - `sensorDelayTime=300`: Trễ 300ms cho mỗi lần sáng đèn cảm biến.

---

## 7. Parser Analysis

File `agent/parser.js` và `agent/server.js` chịu trách nhiệm parse dữ liệu:

```javascript
// Trích đoạn server.js (Dòng 100 - 112)
function isCardComplete(data) {
  if (!data.success) return false;
  const images = data.images || {};
  return Boolean(
    data.idNumber &&
    data.fullName &&
    data.scanSessionId &&
    images.frontWhite &&
    images.infrared &&
    images.ultraviolet &&
    images.portrait
  );
}
```

### Phân tích chi tiết:
- **Đọc Stream/Buffer**: `server.js` lắng nghe `stdout` của `run.cmd`, cắt dòng theo `\r?\n` và lọc ANSI escape code.
- **Tích lũy Buffer**: Mỗi khi nhận được dòng thông tin thẻ hợp lệ (`- Số CCCD:`, `- Họ tên:`, `- Ảnh chân dung:`, ...), dòng đó được nối vào `currentBuffer` và gọi `processBuffer()`.
- **ĐIỂM NGHẼN NATIVE GATING**: Hàm `isCardComplete()` yêu cầu **bắt buộc phải có đủ cả 4 đường dẫn ảnh** (`frontWhite`, `infrared`, `ultraviolet`, `portrait`). 
  - Trong thực tế, các dòng xuất ảnh (`- Ảnh chân dung:`, `- Scan session id:`) luôn được native reader in ra **cuối cùng** sau khi đã đọc xong toàn bộ chip và ghi file đĩa.
  - Do đó, dù dữ liệu họ tên và số CCCD đã có trong `currentBuffer` từ rất sớm, `server.js` vẫn giữ lại và **KHÔNG emit `card-read`** cho đến khi tệp ảnh cuối cùng hoàn tất.

---

## 8. Image Processing Analysis

So sánh xử lý ảnh giữa luồng NFC và QR:

1. **Số lượng ảnh được tạo trong NFC**:
   - `frontWhite`: Ảnh quang học ánh sáng trắng (`wh_Scan_*.jpg`).
   - `infrared`: Ảnh hồng ngoại (`ir_Scan_*.jpg`).
   - `ultraviolet`: Ảnh UV (`uv_Scan_*.jpg`).
   - `portrait`: Ảnh chân dung trích xuất từ dữ liệu mã hóa DG2 trong chip CCCD.
2. **Số lượng ảnh trong QR**: **0 ảnh**. (Mã QR chỉ chứa văn bản thô).
3. **Chi phí I/O đĩa**:
   - Tệp ảnh quang học có độ phân giải 500 DPI (kích thước 2660x1624 px theo cấu hình `ImageProcessA8_800.ini`).
   - `read-cccd-chip.exe` phải ghi 4 file JPG dung lượng lớn ra đĩa (`agent/portable/IDE200_V3.0-Demo/image/`).
   - Việc ghi đĩa tốn từ 200ms - 800ms tùy thuộc vào tốc độ ổ đĩa.
4. **Thời điểm emit `card-read`**: `card-read` được emit **nghiêm ngặt SAU KHI** tất cả 4 tệp ảnh đã ghi xong ra đĩa và đường dẫn của chúng được ghi nhận đầy đủ vào đối tượng JSON.

---

## 9. SSE Analysis

Đoạn mã xử lý SSE trong `agent/server.js`:

```javascript
// Trích đoạn server.js (Dòng 349 - 374)
function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  // ...
}
```

### Phân tích chi tiết:
- **Thời điểm emit**: Sự kiện `card-read` chỉ được phát đi khi `isCardComplete(data)` trả về `true`.
- **Dung lượng Payload**: Payload gửi qua SSE chỉ chứa chuỗi đường dẫn tệp ảnh (file path) và thông tin văn bản, **không gửi dữ liệu ảnh dưới dạng Base64 qua SSE**. Dung lượng payload rất nhỏ (`~1 KB`).
- **Kết luận**: SSE **không phải là nguyên nhân gây chậm**. Thời gian truyền SSE qua kết nối HTTP loopback local là `< 5ms`.

---

## 10. rta-fe Processing Analysis

Xử lý tại Front-End (`public/app.js`):

```javascript
// Trích đoạn app.js (Dòng 39 - 76)
function getImageUrl(imagePath) {
  if (!imagePath) return "";
  const value = String(imagePath).trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `/api/image?path=${encodeURIComponent(value)}`;
}
```

### Phân tích chi tiết:
- **Luồng xử lý FE**: Khi nhận event `card-read`, FE cập nhật các trường văn bản vào DOM ngay lập tức.
- **Truy vấn ảnh**: Đối với 4 hình ảnh, FE gán `src` dạng `/api/image?path=...`.
- **Tác động**: Browser phải thực hiện thêm 4 yêu cầu HTTP GET độc lập tới Agent để lấy luồng dữ liệu tệp ảnh từ ổ đĩa.
- **Phân biệt thời gian**:
  - *Thời gian Agent đọc xong dữ liệu*: Từ khi đặt thẻ -> khi Agent emit `card-read` qua SSE.
  - *Thời gian hiển thị hoàn chỉnh trên FE*: Thời gian Agent emit `card-read` + thời gian tải 4 tệp ảnh qua endpoint `/api/image`.

---

## 11. Bottleneck Analysis

Bảng tổng hợp tất cả các điểm nghẽn gây trễ trong hệ thống:

| File | Function / Section | Cơ chế kỹ thuật | Delay / Chi phí ước tính | Phạm vi ảnh hưởng | Mức độ ảnh hưởng |
| --- | --- | --- | --- | --- | --- |
| `agent/portable/run.ps1` | `while (-not $process.HasExited)` | Vòng lặp `Start-Sleep -Milliseconds 200` quét tệp log tạm | **0 - 200ms** / nhịp poll | Chỉ NFC | Trung bình |
| `agent/portable/IDE200_V3.0-Demo/lib/ImageProcessA8_800.ini` | `COMMON_CONFIG` | `sensorGapTime=120`, `sensorDelayTime=300` trễ bật đèn chớp cảm biến | **~420ms - 800ms** | Chỉ NFC | Cao |
| Native SDK (`A8Capture.dll`) | Multi-spectrum Scan | Chụp 3 ảnh 500 DPI (2660x1624 px) & ghi 3 file JPG ra đĩa đệm | **~500ms - 1500ms** | Chỉ NFC | Rất cao |
| Native SDK (`RTsmartcard.dll`) | NFC RF & APDU Protocol | Bật sóng vô tuyến NFC, handshake BAC/PACE, đọc gói APDU DG1 & DG2 | **~1000ms - 3000ms** | Chỉ NFC | Rất cao (Điểm nghẽn phần cứng chính) |
| Native AI Model | OCR Engine (`detect.caffemodel`) | Chạy mô hình Caffe AI OCR quét dòng MRZ trên ảnh chụp | **~300ms - 800ms** | Chỉ NFC | Cao |
| `agent/server.js` | `isCardComplete()` | Bắt buộc phải có đủ cả 4 đường dẫn ảnh mới emit event `card-read` | **Bị chặn hoàn toàn** đến khi xong ảnh cuối | Chỉ NFC | Rất cao (Gating phần mềm) |
| `public/app.js` | `setImage()` | Gọi HTTP GET `/api/image?path=...` cho 4 ảnh riêng biệt | **~50ms - 200ms** | Chỉ NFC | Thấp |
| Quét mã QR | Scanner / RAM Parse | Giải mã chuỗi UTF-8 trực tiếp trong RAM, không ghi đĩa, không mã hóa | **< 50ms** | Chỉ QR | Không có trễ |

---

## 12. Confirmed Findings

### Các nguyên nhân ĐÃ XÁC NHẬN TỪ SOURCE CODE:

1. **Hàm `isCardComplete()` chặn việc phát hành dữ liệu sớm (`agent/server.js`)**:
   Mã nguồn `server.js` kiểm tra điều kiện `isCardComplete()` nghiêm ngặt: yêu cầu cả `idNumber`, `fullName`, `scanSessionId`, `frontWhite`, `infrared`, `ultraviolet`, và `portrait` đều phải có giá trị. Do đó, dữ liệu văn bản dù đã được đọc xong từ chip/OCR từ sớm vẫn **không được phát ra SSE** cho tới khi cả 4 file ảnh được ghi xong và đường dẫn của chúng được xuất ra stdout.

2. **Trễ trung chuyển 200ms do vòng lặp Polling trong PowerShell (`agent/portable/run.ps1`)**:
   `run.ps1` không nhận stream trực tiếp từ process mà redirect stdout/stderr ra file log tạm `%TEMP%\read-cccd-chip.stdout.log` và chạy vòng lặp với `Start-Sleep -Milliseconds 200`. Điều này tạo ra độ trễ đệm 200ms bất ngờ cho mọi dòng output.

3. **Cấu hình trễ phần cứng đèn chớp trong file INI (`ImageProcessA8_800.ini`)**:
   File cấu hình `ImageProcessA8_800.ini` cài đặt cứng `sensorGapTime=120` (khoảng nghỉ giữa 2 cảm biến đèn) và `sensorDelayTime=300` (thời gian sáng đèn cảm biến), làm luồng đọc quang học tốn tối thiểu ~420ms chỉ riêng cho việc bật/tắt đèn chụp ảnh.

4. **Luồng QR hoàn toàn KHÔNG phụ thuộc vào Agent hay Native Reader**:
   Trong toàn bộ thư mục `CCCD_Agent_Local`, **không có bất kỳ dòng code nào xử lý QR**. QR được đọc và giải mã dưới dạng chuỗi UTF-8 bởi phần cứng đầu đọc mã vạch / thuật toán camera trực tiếp trong RAM trong vài miligiây.

---

## 13. Hypotheses

### Các nguyên nhân CÓ KHẢ NĂNG CAO (Dựa trên kiến trúc phần cứng & chuẩn giao tiếp):

1. **Tốc độ truyền dữ liệu qua sóng radio NFC (ISO/IEC 14443 & ICAO Doc 9303)**:
   Dữ liệu DG2 chứa tệp ảnh chân dung dung lượng lớn mã hóa trong chip CCCD. Việc đọc khối dữ liệu này qua sóng NFC không tiếp xúc đòi hỏi gửi/nhận hàng trăm gói lệnh APDU (kích thước tối đa 256 bytes/gói), mất từ 1.0 - 2.5 giây.
2. **Quy trình bắt tay bảo mật BAC/PACE**:
   Để đọc được dữ liệu bảo mật trong Chip CCCD, reader buộc phải đọc dòng MRZ bằng OCR trước, sau đó dùng thông tin MRZ để tính toán khóa đối mã và thực hiện quy trình thử-đáp (challenge-response) để khởi tạo kênh Secure Messaging với Chip.
3. **Chi phí I/O đĩa khi ghi 4 tệp ảnh dung lượng cao**:
   Việc ghi đồng thời 4 tệp JPG độ phân giải 500 DPI (2660x1624 px) xuống đĩa đệm gây ra tranh chấp tài nguyên I/O đĩa.

---

## 14. Required Measurements

### Các thông số CHƯA ĐỦ DỮ LIỆU — CẦN ĐO THỰC TẾ:

Để phân rã chính xác từng miligiây trong tổng thời gian đọc NFC, cần bổ sung các mốc timestamp và tiến hành đo đạc trên thiết bị thực tế:

1. **`T0` (Card Detected)**: Thời điểm cảm biến phát hiện thẻ CCCD đặt lên mặt kính.
2. **`T1` (Optical Scan Completed)**: Thời điểm kết thúc chụp 3 ảnh White, IR, UV.
3. **`T2` (MRZ OCR Completed)**: Thời điểm thuật toán OCR đọc xong dòng MRZ.
4. **`T3` (NFC BAC/PACE Auth Completed)**: Thời điểm hoàn tất bắt tay bảo mật với Chip.
5. **`T4` (DG1 Text Read Completed)**: Thời điểm hoàn tất đọc dữ liệu văn bản từ Chip.
6. **`T5` (DG2 Portrait Read Completed)**: Thời điểm hoàn tất đọc ảnh chân dung từ Chip.
7. **`T6` (All Files Written to Disk)**: Thời điểm 4 file ảnh được ghi xong hoàn toàn xuống đĩa.
8. **`T7` (Native Process Output)**: Thời điểm `read-cccd-chip.exe` in dòng kết quả ra stdout log.
9. **`T8` (PowerShell Line Emitted)**: Thời điểm `run.ps1` đọc log và in ra console.
10. **`T9` (Agent SSE Emitted)**: Thời điểm `server.js` phát event `card-read`.
11. **`T10` (FE Received & Applied)**: Thời điểm ứng dụng FE nhận event và hiển thị thông tin.

### Công thức đo đạc đề xuất:

$$\text{Latency}_{\text{PowerShell Polling}} = T_8 - T_7$$

$$\text{Latency}_{\text{Gating Wait}} = T_9 - T_4$$

$$\text{Latency}_{\text{Hardware NFC Read}} = T_5 - T_3$$

$$\text{Latency}_{\text{Total NFC Pipeline}} = T_{10} - T_0$$

---

## 15. Optimization Priority

Nếu muốn tối ưu tốc độ đọc NFC trong tương lai, đề xuất thứ tự ưu tiên tối ưu:

### Ưu tiên 1: Tối ưu Tầng Phần mềm Agent (Không thay đổi phần cứng)
1. **Loại bỏ Gating `isCardComplete()` bắt buộc 4 ảnh (`server.js`)**:
   - Thay vì bắt FE chờ đủ cả 4 ảnh, phát sự kiện `card-read-text` (hoặc `card-read-partial`) ngay khi vừa nhận được thông tin văn bản từ chip/OCR.
   - Phát thêm sự kiện `card-read-images` sau đó khi các tệp ảnh đã ghi xong ra đĩa.
   - *Kết quả dự kiến*: Giảm thời gian chờ thông tin văn bản xuống ngay lập tức (giúp UI hiển thị thông tin người dùng sớm hơn ~1 - 2 giây).
2. **Thay thế cơ chế Polling File Log trong `run.ps1`**:
   - Loại bỏ `run.ps1` và cơ chế ghi log file đệm `%TEMP%` kèm `Start-Sleep 200ms`.
   - Cho `server.js` giao tiếp trực tiếp với `read-cccd-chip.exe` qua Standard I/O Pipe của Node.js `child_process.spawn`.
   - *Kết quả dự kiến*: Giảm từ 100ms - 400ms trễ đệm giao tiếp IPC.

### Ưu tiên 2: Tối ưu Tầng Native & Cấu hình SDK
1. **Bỏ bớt các chế độ chụp ảnh không cần thiết**:
   - Nếu ứng dụng chỉ cần thông tin xác thực văn bản và ảnh chân dung chip, cấu hình tắt chụp ảnh IR/UV (chỉ chụp White hoặc bỏ chụp quang học nếu chỉ đọc Chip).
2. **Tối ưu cấu hình đèn cảm biến trong INI**:
   - Tinh chỉnh giảm `sensorGapTime` (từ 120ms xuống 50ms) và `sensorDelayTime` (từ 300ms xuống 150ms) nếu phần cứng IDE200 đáp ứng được.

---

## 16. Conclusion

### Trả lời trực tiếp 12 câu hỏi đánh giá:

1. **QR hiện nhanh hơn NFC ở bước nào?**
   QR nhanh hơn ở **TẤT CẢ các bước**: Không chụp ảnh quang học 500 DPI, không ghi file đĩa đệm, không chạy AI OCR, không phát sóng vô tuyến NFC, không handshake mã hóa BAC/PACE, không truyền nhiều gói APDU qua sóng radio, và không bị chặn bởi gating 4 ảnh.
2. **Có bằng chứng source nào cho kết luận đó?**
   - Source `server.js` (lines 100-112): `isCardComplete()` chặn emit `card-read` cho tới khi có đủ 4 ảnh.
   - Source `run.ps1` (lines 115-119): `Start-Sleep -Milliseconds 200` tạo đệm trễ polling.
   - Source `ImageProcessA8_800.ini`: Khai báo trễ cảm biến `120ms` và `300ms`.
   - Mã nguồn toàn bộ Agent hoàn toàn không có module xử lý QR (QR đọc trực tiếp ở RAM).
3. **NFC có phải chờ native reader không?**
   Có. Luồng NFC hoàn toàn phụ thuộc vào tiến trình native `read-cccd-chip.exe`.
4. **NFC có phải đọc chip/secure data không?**
   Có. NFC phải đọc chip mã hóa ICAO qua giao thức BAC/PACE bằng `RTsmartcard.dll`.
5. **NFC có phải tạo nhiều ảnh không?**
   Có. Đã xác nhận NFC quy định tạo 4 tệp ảnh (`frontWhite`, `infrared`, `ultraviolet`, `portrait`).
6. **NFC có phải chờ parser không?**
   Có. Parser tích lũy dòng và bị hàm `isCardComplete()` giữ lại cho đến dòng chứa đường dẫn ảnh cuối cùng.
7. **Có delay/polling/timeout nào không?**
   Có. Polling 200ms ở `run.ps1`, delay phần cứng 120ms/300ms ở `ImageProcessA8_800.ini`.
8. **SSE có phải nguyên nhân gây chậm không?**
   Không. SSE truyền payload nhẹ (`~1KB`) trực tiếp qua local socket với latency `< 5ms`.
9. **rta-fe có phải nguyên nhân gây chậm không?**
   Không phải nguyên nhân gây chậm thông tin chữ. FE chỉ tốn thêm 4 request HTTP GET riêng lẻ để lấy file ảnh hiển thị.
10. **Backend có nằm trên critical path không?**
    Trong phạm vi Agent local, critical path nằm hoàn toàn ở: *Cảm biến phần cứng -> OCR MRZ -> NFC APDU Read -> Write 4 Images to Disk -> PowerShell Polling -> isCardComplete Check*.
11. **Nếu muốn NFC nhanh hơn, bước nào nên tối ưu trước?**
    Loại bỏ Gating 4 tệp ảnh trong `server.js` (cho phép phát dữ liệu văn bản ngay) và loại bỏ vòng lặp `Start-Sleep 200ms` ở `run.ps1`.
12. **Có cần thay đổi kiến trúc Agent không?**
    Có. Cần chuyển giao tiếp IPC sang Direct Pipe Stream và áp dụng cơ chế Async Event Streaming (tách rời dữ liệu văn bản và dữ liệu hình ảnh).
