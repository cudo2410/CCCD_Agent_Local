"use strict";

const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { parseCardData } = require("./parser");

const HOST = "127.0.0.1";
const PORT = 3000;
const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const PORTABLE_DIR = path.join(__dirname, "portable");
const RUN_CMD = path.join(PORTABLE_DIR, "run.cmd");

let isShuttingDown = false;

async function deleteCardImages(card) {
  // 1. Xóa toàn bộ file ảnh trong thư mục image của SDK
  const portableImageDir = path.resolve(
    __dirname,
    "portable",
    "IDE200_V3.0-Demo",
    "image",
  );

  try {
    if (fs.existsSync(portableImageDir)) {
      const files = await fs.promises.readdir(portableImageDir);

      for (const file of files) {
        const filePath = path.join(portableImageDir, file);
        const stat = await fs.promises.stat(filePath);

        if (stat.isFile()) {
          await fs.promises.unlink(filePath);
          console.log(`Đã xóa ảnh tồn dư trong thư mục image/: ${file}`);
        }
      }
    }
  } catch (error) {
    console.error("Lỗi khi dọn dẹp thư mục image của SDK:", error.message);
  }

  // 2. Xóa toàn bộ folder phiên chứa ảnh CCCD trên Desktop
  if (!card || !card.images) {
    console.warn(
      "[DELETE] Không có dữ liệu ảnh CCCD để xác định folder cần xóa.",
    );
    return;
  }

  const imagePaths = [
    card.images.frontWhite,
    card.images.infrared,
    card.images.ultraviolet,
    card.images.portrait,
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p));

  if (imagePaths.length === 0) {
    console.warn("[DELETE] Không có đường dẫn ảnh CCCD.");
    return;
  }

  const os = require("os");
  const desktopDir = path.resolve(os.homedir(), "Desktop");

  // Xác định folder phiên từ đường dẫn ảnh
  const imageDir = path.dirname(imagePaths[0]);

  // Chỉ cho phép xóa folder image_YYYYMMDD_HHMMSS trực tiếp trên Desktop
  const isDesktopSession =
    path.dirname(imageDir).toLowerCase() === desktopDir.toLowerCase() &&
    /^image_\d{8}_\d{6}$/i.test(path.basename(imageDir));

  // Đảm bảo mọi ảnh đều nằm trong cùng folder phiên
  const allImagesInSameDir = imagePaths.every(
    (p) => path.dirname(p).toLowerCase() === imageDir.toLowerCase(),
  );

  if (!isDesktopSession || !allImagesInSameDir) {
    console.warn(
      "[DELETE] Bỏ qua: folder ảnh không hợp lệ hoặc không thuộc Desktop.",
    );
    console.warn("[DELETE] Desktop:", desktopDir);
    console.warn("[DELETE] Folder ảnh:", imageDir);
    return;
  }

  console.log("[DELETE] Bắt đầu xóa toàn bộ folder ảnh CCCD:", imageDir);

  // 3. Xóa toàn bộ folder phiên và mọi file bên trong
  try {
    await fs.promises.rm(imageDir, {
      recursive: true,
      force: true,
    });

    if (fs.existsSync(imageDir)) {
      console.error("[DELETE] Folder vẫn tồn tại sau khi xóa:", imageDir);
    } else {
      console.log("[DELETE] Đã xóa toàn bộ folder ảnh CCCD:", imageDir);
    }
  } catch (error) {
    console.error("[DELETE] Lỗi xóa folder ảnh CCCD:", imageDir, error.message);
  }
}

function getCorsHeaders(req) {
  const origin = req && req.headers ? req.headers.origin : "";
  const allowedStr =
    process.env.ALLOWED_ORIGINS ||
    "https://visedu.vn,https://visedu.vn:4002,https://visedu.vn:4005";
  const whitelist = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://visedu.vn:4002", // Thêm origin port 4002 của bạn
    ...allowedStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];

  // Cho phép mọi port của các origin trong whitelist (vd: https://visedu.vn:4002)
  const isAllowed = (o) => {
    if (whitelist.includes(o)) return true;
    try {
      const u = new URL(o);
      return whitelist.some((w) => {
        try {
          const wu = new URL(w);
          return wu.protocol === u.protocol && wu.hostname === u.hostname;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  };

  let resultOrigin = whitelist[0];
  if (origin) {
    resultOrigin = isAllowed(origin)
      ? origin
      : whitelist.find((x) => x.includes("visedu.vn")) || whitelist[0];
  }

  return {
    "Access-Control-Allow-Origin": resultOrigin,
    "Access-Control-Allow-Private-Network": "true", // Bắt buộc cho PNA
    "Access-Control-Allow-Credentials": "true",
  };
}

let readerProcess = null;
let readerStarted = false;
let readerStopped = false;
let currentBuffer = "";
let currentCard = null;
let currentSignature = "";
let sseClients = new Set();

function sendJson(req, res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache",
    ...getCorsHeaders(req),
  });
  res.end(body);
}

function sendText(req, res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...getCorsHeaders(req),
  });
  res.end(text);
}

function sendFile(req, res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(req, res, 404, "Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
    };
    res.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

function cleanOutput(text) {
  return String(text || "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of sseClients) {
    try {
      writeSse(client, event, data);
    } catch {
      sseClients.delete(client);
    }
  }
}

function cardSignature(data) {
  const images = data.images || {};
  return [
    data.idNumber,
    data.fullName,
    data.scanSessionId,
    images.frontWhite,
    images.infrared,
    images.ultraviolet,
    images.portrait,
  ].join("|");
}

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
    images.portrait,
  );
}

function processBuffer() {
  if (!currentBuffer.trim()) return;
  const data = parseCardData(currentBuffer);
  if (!isCardComplete(data)) return;
  const signature = cardSignature(data);
  if (!signature || signature === currentSignature) return;
  currentSignature = signature;
  currentCard = data;
  broadcast("card-read", {
    data,
    timestamp: new Date().toISOString(),
  });
  broadcast("reader-state", {
    state: "card-read",
    message: "Đọc CCCD thành công.",
  });
}

function handleReaderLine(rawLine) {
  const line = cleanOutput(rawLine).trim();
  if (!line) return;
  console.log(line);
  if (line.includes("Phát hiện thẻ, bắt đầu đọc")) {
    currentBuffer = "";
    currentCard = null;
    currentSignature = "";
    broadcast("reader-state", {
      state: "reading",
      message: "Đang đọc CCCD...",
    });
    return;
  }
  if (line.includes("Lỗi đọc thẻ:")) {
    const match = line.match(/SDK trả mã lỗi\s+(-?\d+)/i);
    const code = match ? Number(match[1]) : null;
    broadcast("card-read-failed", {
      code,
      message: line,
    });
    broadcast("reader-state", {
      state: "read-failed",
      message: line,
    });
    currentBuffer = "";
    currentCard = null;
    currentSignature = "";
    return;
  }
  if (line.includes("Đọc CCCD thành công.")) {
    broadcast("reader-state", {
      state: "reading",
      message: "Đang nhận dữ liệu CCCD...",
    });
  }
  if (line.includes("Nhấc thẻ ra để đọc thẻ tiếp theo")) {
    broadcast("waiting-card-removal", {
      message: "Nhấc thẻ ra để đọc thẻ tiếp theo.",
    });
    return;
  }

  if (line.includes("Sẵn sàng đọc thẻ tiếp theo")) {
    const cardToDelete = currentCard;

    currentBuffer = "";
    currentCard = null;
    currentSignature = "";

    void deleteCardImages(cardToDelete);

    broadcast("card-removed", {
      message: "Sẵn sàng đọc thẻ tiếp theo.",
    });
    broadcast("reader-state", {
      state: "waiting",
      message: "Đang chờ CCCD...",
    });
    return;
  }
  if (
    line.startsWith("- Loại thiết bị:") ||
    line.startsWith("- Số CCCD:") ||
    line.startsWith("- Họ tên:") ||
    line.startsWith("- Giới tính:") ||
    line.startsWith("- Ngày sinh:") ||
    line.startsWith("- Quốc tịch:") ||
    line.startsWith("- Ngày hết hạn:") ||
    line.startsWith("- Quê quán:") ||
    line.startsWith("- Nơi thường trú:") ||
    line.startsWith("- Thông tin khác:") ||
    line.startsWith("- MRZ dòng 1:") ||
    line.startsWith("- MRZ dòng 2:") ||
    line.startsWith("- MRZ dòng 3:") ||
    line.startsWith("- Scan session id:") ||
    line.startsWith("- Ảnh mặt trước/white:") ||
    line.startsWith("- Ảnh hồng ngoại:") ||
    line.startsWith("- Ảnh UV:") ||
    line.startsWith("- Ảnh chân dung:")
  ) {
    currentBuffer += `${line}\n`;
    processBuffer();
  }
}

function startReader() {
  if (readerStarted || readerProcess) return;
  readerStarted = true;
  readerStopped = false;
  currentBuffer = "";
  currentCard = null;
  currentSignature = "";
  console.log("Khởi động máy đọc CCCD...");
  broadcast("reader-started", {
    message: "Máy đọc CCCD đã được khởi động.",
  });
  readerProcess = spawn("cmd.exe", ["/c", RUN_CMD], {
    cwd: PORTABLE_DIR,
    windowsHide: false,
    stdio: ["inherit", "pipe", "pipe"],
  });
  readerProcess.stdout.setEncoding("utf8");
  readerProcess.stderr.setEncoding("utf8");
  readerProcess.stdout.on("data", (chunk) => {
    const text = cleanOutput(chunk);
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      handleReaderLine(line);
    }
  });
  readerProcess.stderr.on("data", (chunk) => {
    const text = cleanOutput(chunk).trim();
    if (text) {
      console.error(text);
    }
  });
  readerProcess.on("error", (error) => {
    console.error("Reader error:", error.message);
    broadcast("reader-error", {
      message: error.message,
    });
    broadcast("reader-state", {
      state: "stopped",
      message: "Máy đọc CCCD gặp lỗi.",
    });
  });
  readerProcess.on("exit", (code, signal) => {
    readerProcess = null;
    readerStopped = true;
    readerStarted = false;
    console.log(`Máy đọc đã dừng. Code: ${code}, Signal: ${signal || ""}`);
    broadcast("reader-stopped", {
      code,
      signal,
    });
    broadcast("reader-state", {
      state: "stopped",
      message: "Máy đọc đã dừng.",
    });
    if (!isShuttingDown) {
      console.log("Tự động khởi động lại máy đọc sau 3 giây...");
      setTimeout(() => {
        if (!isShuttingDown) startReader();
      }, 3000);
    }
  });
}

function serveImage(req, res, imagePath) {
  if (!imagePath) {
    sendText(req, res, 400, "Missing image path");
    return;
  }
  const filePath = String(imagePath).trim();
  const allowedExtensions = [
    ".jpg",
    ".jpeg",
    ".png",
    ".bmp",
    ".webp",
    ".gif",
    ".tif",
    ".tiff",
  ];
  const ext = path.extname(filePath).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    sendText(req, res, 403, "Unsupported image type");
    return;
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendText(req, res, 404, "Image not found");
      return;
    }
    const contentTypes = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".bmp": "image/bmp",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".tif": "image/tiff",
      ".tiff": "image/tiff",
    };
    res.writeHead(200, {
      "Content-Type": contentTypes[ext],
      "Cache-Control": "no-cache",
      ...getCorsHeaders(req),
    });
    const stream = fs.createReadStream(filePath);
    stream.on("error", (error) => {
      console.error("Image error:", error.message);
      if (!res.headersSent) {
        sendText(req, res, 500, "Cannot read image");
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });
}

function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(req, res, 200, {
      success: true,
      readerRunning: Boolean(readerProcess),
      readerStarted,
      readerStopped,
    });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(req, res, 200, {
      success: true,
      readerRunning: Boolean(readerProcess),
      readerStarted,
      readerStopped,
      card: currentCard,
    });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/image") {
    serveImage(req, res, url.searchParams.get("path"));
    return true;
  }
  return false;
}

function handleEvents(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...getCorsHeaders(req),
  });
  res.write("\n");
  sseClients.add(res);
  writeSse(res, "connected", {
    message: "Đã kết nối tới CCCD Agent.",
  });
  writeSse(res, "reader-state", {
    state: readerProcess ? "waiting" : "stopped",
    message: readerProcess ? "Đang chờ CCCD..." : "Máy đọc chưa chạy.",
  });
  if (currentCard) {
    writeSse(res, "card-read", {
      data: currentCard,
      timestamp: new Date().toISOString(),
    });
  }
  req.on("close", () => {
    sseClients.delete(res);
  });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(req, res, 403, "Forbidden");
    return;
  }
  sendFile(req, res, filePath);
}

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || `${HOST}:${PORT}`}`,
  );
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Access-Control-Allow-Private-Network",
      "Access-Control-Allow-Private-Network": "true", // Bắt buộc
      ...getCorsHeaders(req),
    });
    res.end();
    return;
  }
  if (url.pathname === "/events" && req.method === "GET") {
    handleEvents(req, res);
    return;
  }
  if (handleApi(req, res, url)) return;
  if (req.method === "GET") {
    serveStatic(req, res, url);
    return;
  }
  sendText(req, res, 404, "Not found");
});

const heartbeat = setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(": heartbeat\n\n");
    } catch {
      sseClients.delete(client);
    }
  }
}, 15000);

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("==============================");
  console.log(" CCCD Local Agent");
  console.log("==============================");
  console.log(`http://${HOST}:${PORT}`);
  console.log("");
  startReader();
});

function shutdown() {
  isShuttingDown = true;
  clearInterval(heartbeat);
  for (const client of sseClients) {
    try {
      client.end();
    } catch {}
  }
  sseClients.clear();
  if (readerProcess) {
    readerProcess.kill();
    readerProcess = null;
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
