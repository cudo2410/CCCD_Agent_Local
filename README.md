# CCCD Local Agent

## 1. Giới thiệu

**CCCD Local Agent** là ứng dụng trung gian giữa Web Frontend (Web FE) và máy đọc Căn cước công dân (CCCD).

Agent cung cấp **HTTP API và Server-Sent Events (SSE)** để FE khởi động quá trình đọc, theo dõi trạng thái thiết bị và nhận dữ liệu CCCD. FE không cần giao tiếp trực tiếp với SDK hoặc xử lý giao thức riêng của máy đọc.

```text
Web FE ── HTTP API / SSE ──> CCCD Local Agent ──> CCCD Reader SDK ──> Máy đọc CCCD
```

Agent chạy trên máy tính được kết nối với máy đọc CCCD. FE có thể tích hợp thông qua API và SSE mà không cần xử lý trực tiếp các thành phần nội bộ của SDK.

### Mục tiêu

- Chuẩn hóa giao tiếp với máy đọc CCCD thông qua một giao diện API thống nhất.
- Tách biệt nghiệp vụ đọc CCCD khỏi mã nguồn FE.
- Hỗ trợ tái sử dụng Agent cho nhiều ứng dụng FE.
- Đóng gói Agent thành file `.exe` để thuận tiện triển khai trên máy khách Windows.

## 2. Cấu trúc thư mục

### 2.1. Cấu trúc mã nguồn

```text
CCCD_Local_Agent/
├── agent/
│   ├── server.js       # HTTP API, SSE và quản lý tiến trình Reader
│   ├── parser.js       # Phân tích dữ liệu thô thành JSON
│   ├── CCCD-Agent.exe  # Bản Agent đã đóng gói
│   └── portable/       # Chương trình đọc và tài nguyên SDK
│       ├── run.cmd
│       ├── run.ps1
│       ├── read-cccd-chip.exe
│       └── IDE200_V3.0-Demo/
│           ├── lib/
│           ├── model/
│           └── image/
├── public/             # FE Demo, chỉ phục vụ kiểm thử
└── README.md
```

> Cấu trúc thực tế có thể khác tùy phiên bản đóng gói. `parser.js` được sử dụng khi chạy từ mã nguồn; khi chạy bằng EXE, thành phần này được đóng gói cùng ứng dụng nếu cấu hình build hiện tại được giữ nguyên.

### 2.2. Các thành phần chính

| Thành phần       | Vai trò                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| `server.js`      | Khởi tạo HTTP server, cung cấp API/SSE và quản lý chương trình đọc        |
| `parser.js`      | Chuyển đổi dữ liệu đầu ra của Reader thành JSON                           |
| `portable/`      | Chứa chương trình đọc CCCD và các tài nguyên cần thiết của SDK            |
| `CCCD-Agent.exe` | Bản thực thi độc lập của Agent dành cho Windows                           |
| `public/`        | Giao diện demo phục vụ kiểm thử, không bắt buộc khi tích hợp với FE riêng |

**Lưu ý:** Không được tự ý loại bỏ hoặc thay đổi các file SDK và tài nguyên trong `portable/` nếu chưa xác nhận chúng không còn cần thiết.

## 3. Kiến trúc và luồng hoạt động

```text
Web FE
  │
  ├── POST /api/start
  ├── GET  /api/status
  └── GET  /events
          │
          ▼
    CCCD Local Agent
       server.js
          │
          ├── Khởi động/quản lý Reader
          ├── Nhận dữ liệu từ Reader
          ├── Phân tích dữ liệu bằng parser.js
          └── Phát sự kiện qua SSE
                  │
                  ▼
             Web FE nhận JSON
```

### Luồng đọc CCCD

1. FE mở kết nối SSE tới `/events` để nhận các sự kiện từ Agent.
2. FE gửi yêu cầu `POST /api/start` để khởi động quá trình đọc.
3. Agent khởi chạy hoặc quản lý tiến trình Reader thông qua các thành phần trong `portable/`.
4. Người dùng đặt CCCD lên máy đọc theo hướng dẫn.
5. Agent tiếp nhận đầu ra từ Reader và sử dụng parser để chuẩn hóa dữ liệu.
6. Khi đọc thành công, Agent phát sự kiện `card-read` kèm dữ liệu CCCD dạng JSON.
7. FE nhận dữ liệu và cập nhật giao diện hoặc tiếp tục xử lý theo nghiệp vụ của ứng dụng.

Agent chịu trách nhiệm giao tiếp với Reader; FE chịu trách nhiệm hiển thị và xử lý dữ liệu theo nghiệp vụ riêng.

## 4. Chạy CCCD Local Agent

### 4.1. Chạy từ mã nguồn

Yêu cầu: máy tính đã cài Node.js phù hợp và có đầy đủ các thành phần cần thiết của Agent.

Mở PowerShell tại thư mục `agent`:

```powershell
node server.js
```

Agent sử dụng địa chỉ mặc định:

```text
http://127.0.0.1:3000
```

### 4.2. Chạy bằng file EXE

Khi triển khai cho khách hàng, có thể sử dụng bản đóng gói để không cần cài Node.js riêng cho Agent.

Cấu trúc bàn giao tối thiểu dự kiến:

```text
CCCD-Local-Agent/
├── CCCD-Agent.exe
└── portable/
    ├── run.cmd
    ├── run.ps1
    ├── read-cccd-chip.exe
    └── IDE200_V3.0-Demo/
        ├── lib/
        ├── model/
        └── image/
```

Các bước thực hiện:

1. Giải nén bộ bàn giao vào thư mục trên máy tính Windows.
2. Kết nối máy đọc CCCD và cài driver nếu thiết bị yêu cầu.
3. Chạy `CCCD-Agent.exe`.
4. Kiểm tra Agent bằng endpoint trạng thái:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/status
```

5. Mở ứng dụng FE đã tích hợp với Agent và kiểm thử quy trình đọc CCCD.

**Lưu ý:**

- Giữ nguyên cấu trúc tương đối giữa EXE và thư mục `portable/`.
- Đảm bảo cổng `3000` chưa bị ứng dụng khác sử dụng.
- `public/` không bắt buộc nếu chỉ sử dụng FE riêng như `rta-fe`.
- Khi không có `public/`, không sử dụng trang `/` làm tiêu chí kiểm tra giao diện. Hãy kiểm tra API, SSE và quy trình đọc thực tế.
- Việc EXE khởi động thành công không đồng nghĩa Reader đã hoạt động bình thường; cần kiểm thử với thiết bị thực tế.

## 5. API dành cho FE

### 5.1. Base URL

```text
http://127.0.0.1:3000
```

| Method | Endpoint      | Chức năng                          |
| ------ | ------------- | ---------------------------------- |
| `POST` | `/api/start`  | Yêu cầu bắt đầu quá trình đọc CCCD |
| `GET`  | `/api/status` | Truy vấn trạng thái Agent/Reader   |
| `GET`  | `/events`     | Mở kết nối SSE để nhận sự kiện     |

### 5.2. Yêu cầu bắt đầu đọc

```javascript
const response = await fetch('http://127.0.0.1:3000/api/start', {
  method: 'POST',
});

if (!response.ok) {
  throw new Error('Không thể yêu cầu Agent bắt đầu đọc CCCD');
}
```

### 5.3. Truy vấn trạng thái

```javascript
const response = await fetch('http://127.0.0.1:3000/api/status');
const status = await response.json();

console.log(status);
```

Cấu trúc dữ liệu trả về cần được đối chiếu với phiên bản `server.js` đang triển khai.

### 5.4. Kết nối SSE và nhận kết quả

```javascript
const events = new EventSource('http://127.0.0.1:3000/events');

events.addEventListener('card-read', (event) => {
  const card = JSON.parse(event.data);

  console.log('Số CCCD:', card.idNumber);
  console.log('Họ tên:', card.fullName);
});

events.addEventListener('card-read-failed', (event) => {
  console.error('Đọc CCCD thất bại:', event.data);
});

events.addEventListener('reader-error', (event) => {
  console.error('Lỗi Reader:', event.data);
});
```

FE cần xử lý thêm các trạng thái kết nối, lỗi thiết bị và việc kết nối lại SSE theo yêu cầu của ứng dụng.

## 6. Các sự kiện SSE

Các sự kiện dưới đây mô tả những event được sử dụng trong luồng tích hợp. Cần đối chiếu với mã nguồn của phiên bản Agent cụ thể trước khi coi đây là danh sách đầy đủ.

| Event                  | Ý nghĩa                            |
| ---------------------- | ---------------------------------- |
| `connected`            | Thông báo kết nối SSE tới Agent    |
| `reader-state`         | Cập nhật trạng thái Reader         |
| `reader-started`       | Thông báo Reader đã được khởi động |
| `card-detected`        | Thông báo phát hiện thẻ            |
| `card-read`            | Đọc thành công, trả dữ liệu CCCD   |
| `card-read-failed`     | Đọc CCCD thất bại                  |
| `waiting-card-removal` | Đang chờ lấy thẻ ra                |
| `card-removed`         | Thông báo thẻ đã được lấy ra       |
| `reader-error`         | Thông báo lỗi Reader               |
| `reader-stopped`       | Thông báo Reader đã dừng           |

Trong đó, **`card-read` là sự kiện chính để FE tiếp nhận dữ liệu CCCD thành công**.

Tên event, cấu trúc payload và điều kiện phát event phải tuân theo triển khai thực tế của `server.js`.

## 7. Tích hợp với nhiều FE

CCCD Local Agent được thiết kế để tách phần giao tiếp với thiết bị khỏi nghiệp vụ của từng ứng dụng.

```text
rta-fe ─────┐
            │
Web FE B ───┼── HTTP API / SSE ──> CCCD Local Agent ──> Reader
            │
Web FE C ───┘
```

Mỗi FE tích hợp thông qua API/SSE mà không cần trực tiếp gọi SDK hoặc tự phân tích đầu ra của Reader.

### Điều kiện triển khai

- Agent phải chạy trên máy tính có kết nối tới máy đọc CCCD.
- FE phải truy cập được Agent trên đúng máy tính đang chạy FE.
- Nếu FE được triển khai qua HTTPS nhưng Agent chạy HTTP trên loopback, trình duyệt có thể áp dụng các chính sách bảo mật như Private Network Access. Cần kiểm thử trên trình duyệt và môi trường triển khai thực tế.
- Việc hỗ trợ nhiều FE không đồng nghĩa nhiều ứng dụng có thể đồng thời điều khiển một Reader an toàn; cần xác định chính sách truy cập đồng thời nếu có nhu cầu này.

## 8. Bảo mật và dữ liệu CCCD

Dữ liệu CCCD là dữ liệu cá nhân cần được bảo vệ trong quá trình xử lý.

- Chỉ cho phép các ứng dụng được phép truy cập Agent.
- Hạn chế Agent lắng nghe trên giao diện mạng không cần thiết.
- Không ghi log thông tin CCCD hoặc ảnh nhạy cảm nếu không có nhu cầu hợp lệ.
- Thực hiện kiểm tra và dọn dẹp ảnh theo chính sách lưu trữ của ứng dụng.
- Không công khai trực tiếp các endpoint của Agent ra mạng nếu chưa có biện pháp bảo vệ phù hợp.

## 9. Kết luận

**CCCD Local Agent là lớp tích hợp độc lập giữa Web FE và máy đọc CCCD.**

Agent đóng gói logic giao tiếp với Reader, tiếp nhận và chuẩn hóa dữ liệu, sau đó cung cấp HTTP API và SSE cho FE. Nhờ đó, các ứng dụng như `rta-fe` có thể tái sử dụng cùng một lớp tích hợp thay vì phụ thuộc trực tiếp vào SDK của thiết bị.
