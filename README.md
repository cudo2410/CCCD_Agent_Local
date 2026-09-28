# CCCD Local Agent

## 1. Giới thiệu

**CCCD Local Agent** là lớp trung gian giữa Web FE và máy đọc CCCD.

FE không giao tiếp trực tiếp với SDK/máy đọc mà gọi **HTTP API + SSE** của Agent.

```text
Web FE ──HTTP/SSE──> CCCD Local Agent ──> Máy đọc CCCD
```

Agent chạy trên máy tính đang kết nối với máy đọc CCCD.

---

## 2. Cấu trúc thư mục

```text
CCCD_Web/
├── agent/
│   ├── server.js       # Local Agent, HTTP API
│   ├── parser.js       # Parse dữ liệu thô → JSON
│   └── portable/
│       ├── run.cmd     # Khởi động chương trình đọc
│       └── ...
│
├── public/
│   ├── index.html      # FE Demo
│   ├── app.js          # Code gọi API Agent
│   └── styles.css      # Giao diện
│
└── README.md
```

> `agent/` là phần cốt lõi có thể tái sử dụng. `public/` chỉ là FE Demo để kiểm thử.

---

## 3. Kiến trúc và luồng hoạt động

```text
FE
 │
 ├── POST /api/start
 ├── GET  /api/status
 └── GET  /events
        │
        ▼
   server.js
        │
        ├── Khởi động Reader qua run.cmd
        ├── Nhận dữ liệu từ Reader
        └── parser.js
              │
              ▼
          JSON CCCD
              │
              │ SSE: card-read
              ▼
             FE
```

### Luồng đọc

1. FE kết nối `/events`.
2. FE gọi `POST /api/start`.
3. Agent khởi động chương trình đọc CCCD.
4. Người dùng đặt thẻ lên máy đọc.
5. Agent nhận và parse dữ liệu bằng `parser.js`.
6. Agent gửi kết quả về FE qua event `card-read`.

---

## 4. Cách chạy Agent

Tại thư mục:

```text
CCCD_Web\agent
```

chạy:

```powershell
node server.js
```

Agent chạy tại:

```text
http://127.0.0.1:3000
```

Nếu đang dùng FE Demo trong `public/`, mở:

```text
http://127.0.0.1:3000
```

---

## 5. API cho FE khác

### Base URL

```text
http://127.0.0.1:3000
```

| Method | Endpoint      | Chức năng                   |
| ------ | ------------- | --------------------------- |
| POST   | `/api/start`  | Bắt đầu đọc CCCD            |
| GET    | `/api/status` | Lấy trạng thái Reader       |
| GET    | `/events`     | Kết nối SSE để nhận sự kiện |

### Ví dụ bắt đầu đọc

```javascript
await fetch("http://127.0.0.1:3000/api/start", {
  method: "POST",
});
```

### Ví dụ kết nối SSE

```javascript
const events = new EventSource("http://127.0.0.1:3000/events");

events.addEventListener("card-read", (event) => {
  const card = JSON.parse(event.data);

  console.log(card.idNumber);
  console.log(card.fullName);
});
```

---

## 6. Các Event

| Event                  | Ý nghĩa                               |
| ---------------------- | ------------------------------------- |
| `connected`            | FE kết nối thành công với Agent       |
| `reader-state`         | Cập nhật trạng thái Reader            |
| `reader-started`       | Reader đã được khởi động              |
| `card-detected`        | Máy đọc phát hiện CCCD                |
| `card-read`            | Đọc CCCD thành công, trả dữ liệu JSON |
| `card-read-failed`     | Đọc CCCD thất bại                     |
| `waiting-card-removal` | Đang chờ lấy CCCD ra                  |
| `card-removed`         | CCCD đã được lấy ra                   |
| `reader-error`         | Có lỗi trong quá trình đọc            |
| `reader-stopped`       | Reader đã dừng                        |

Trong đó `card-read` là event chính để FE nhận dữ liệu CCCD.

FE khác chỉ cần sử dụng API trên, không cần biết `run.cmd`, `parser.js` hay SDK của máy đọc.

---

## 7. Mục tiêu tích hợp

```text
FE A ──┐
FE B ──┼── HTTP/SSE ──> CCCD Local Agent ──> Reader
FE C ──┘
```

Agent đóng vai trò **chuẩn hóa giao tiếp với máy đọc CCCD thành một API dùng chung**, giúp nhiều FE có thể tích hợp mà không phải xử lý trực tiếp phần thiết bị.
