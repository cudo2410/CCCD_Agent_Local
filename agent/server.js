'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const util = require('util');
const { spawn, exec, execFile, execFileSync } = require('child_process');
const { parseCardData } = require('./parser');

const HOST = '127.0.0.1';
const PORT = 3000;
const ROOT = path.join(__dirname, '..');
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = process.pkg
  ? path.resolve(APP_DIR, '..', 'public')
  : path.join(ROOT, 'public');
const PORTABLE_DIR = path.join(APP_DIR, 'portable');
const RUN_CMD = path.join(PORTABLE_DIR, 'run.cmd');
const RUN_PS1 = path.join(PORTABLE_DIR, 'run.ps1');
const SDK_EXE = path.join(PORTABLE_DIR, 'read-cccd-chip.exe');
const SDK_IMAGE_DIR = path.join(PORTABLE_DIR, 'IDE200_V3.0-Demo', 'image');
const LOG_DIR = path.join(APP_DIR, 'logs');

// ---------------------------------------------------------------------------
// Log file
// ---------------------------------------------------------------------------

// Ghi console.log/warn/error nối tiếp vào logs/agent.log (Service không có console).
// Khi file vượt 5 MB: agent.log -> agent.1.log -> ... -> agent.5.log, file cũ nhất bị
// loại bỏ. Ghi lỗi (ví dụ đầy ổ đĩa) thì tạm ngừng 60 giây rồi thử lại, Agent vẫn chạy.
function setupFileLog(dir, maxBytes = 5 * 1024 * 1024, maxFiles = 5) {
  const file = path.join(dir, 'agent.log');
  let size = 0;
  let pausedUntil = 0;

  try {
    fs.mkdirSync(dir, { recursive: true });
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch (error) {
    pausedUntil = Infinity;
    process.stderr.write(`[LOG] Không tạo được thư mục log ${dir}: ${error.message}\n`);
  }

  function rotate() {
    const name = (i) => path.join(dir, `agent.${i}.log`);
    fs.rmSync(name(maxFiles), { force: true });
    for (let i = maxFiles - 1; i >= 1; i--) {
      if (fs.existsSync(name(i))) fs.renameSync(name(i), name(i + 1));
    }
    fs.renameSync(file, name(1));
    size = 0;
  }

  function write(level, args) {
    if (Date.now() < pausedUntil) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const time =
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const line = `[${time}] ${level} ${util.format(...args)}\n`;
    try {
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate();
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch (error) {
      pausedUntil = Date.now() + 60 * 1000;
      process.stderr.write(`[LOG] Lỗi ghi ${file}: ${error.message}. Thử lại sau 60 giây.\n`);
    }
  }

  for (const [method, level] of [
    ['log', 'INFO '],
    ['warn', 'WARN '],
    ['error', 'ERROR'],
  ]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      write(level, args);
    };
  }
}

setupFileLog(LOG_DIR);
process.on('uncaughtException', (error) => {
  console.error('[FATAL]', error && error.stack ? error.stack : error);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Thư mục ảnh
// ---------------------------------------------------------------------------

// Tài khoản LocalSystem có profile trong C:\Windows\System32\config\systemprofile.
function isSystemProfile(dir) {
  const systemRoot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase();
  return path.resolve(dir).toLowerCase().startsWith(systemRoot);
}

// SDK lưu ảnh mỗi lần đọc vào <IMAGE_DIR>\image_YYYYMMDD_HHMMSS (truyền cho SDK qua
// --desktop-root). Không để SDK tự chọn Desktop của tài khoản đang chạy: dưới Service
// (LocalSystem) đó là C:\Windows\System32\config\systemprofile\Desktop.
// Dưới Service, install-service.bat đặt CCCD_IMAGE_DIR = Desktop của tài khoản cài đặt.
function resolveImageDir() {
  const raw = (process.env.CCCD_IMAGE_DIR || '').trim().replace(/^"|"$/g, '');
  if (raw) {
    if (path.isAbsolute(raw) && !isSystemProfile(raw)) return path.resolve(raw);
    console.warn(`[CONFIG] CCCD_IMAGE_DIR không hợp lệ (cần đường dẫn tuyệt đối, ngoài thư mục Windows): ${raw}`);
  }
  if (!isSystemProfile(os.homedir())) return path.join(os.homedir(), 'Desktop');
  const adminDesktop = path.join(process.env.SystemDrive || 'C:', '\\Users', 'Administrator', 'Desktop');
  if (fs.existsSync(adminDesktop)) return adminDesktop;
  return path.join(APP_DIR, 'data', 'images');
}

const IMAGE_DIR = resolveImageDir();
// Desktop mặc định của SDK khi không nhận --desktop-root (bản cũ hoặc run.ps1 cũ):
// chỉ dùng để dọn ảnh, không dùng để lưu.
const LEGACY_IMAGE_DIRS = [path.join(os.homedir(), 'Desktop')].filter(
  (dir) => !samePath(dir, IMAGE_DIR),
);

// SDK tạo folder phiên ngay khi phát hiện thẻ (kể cả khi đọc lỗi), rồi ghi
// cccd_info.json hoặc error.txt cùng các file ảnh/dữ liệu sinh trắc học vào đó.
const SESSION_DIR_PATTERN = /^image_\d{8}_\d{6}(_\d+)?$/i;
const SESSION_FILE_PATTERN =
  /^(cccd_info\.json|error\.txt|(front_white|infrared|ultraviolet|portrait|face_data|finger_data|iris_data|signature_data|voice_data|palm_data)(_\d+)?\.[a-z0-9]+)$/i;

// File bị tiến trình khác giữ tạm thời (antivirus, Explorer tạo thumbnail...): fs.rm tự
// thử lại (~10 giây), sau đó folder vào hàng đợi và được thử lại mỗi 30 giây.
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 3, retryDelay: 300 };
const PENDING_RETRY_MS = 30 * 1000;
const pendingDeletes = new Map(); // dir -> { attempts, root }
let pendingRetryTimer = null;

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

// Tên folder phiên tương ứng với dòng "[2026-10-23 11:13:35] Phát hiện thẻ, bắt đầu đọc..."
// (SDK dùng cùng một thời điểm cho cả dòng log và tên folder).
function sessionNameFromTimestamp(text) {
  const match = String(text).match(/\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return `image_${y}${mo}${d}_${h}${mi}${s}`;
}

// Ảnh của một phiên đọc: file nằm trong <IMAGE_DIR>\image_*\.
function isSessionImage(filePath) {
  const dir = path.dirname(path.resolve(filePath));
  return samePath(path.dirname(dir), IMAGE_DIR) && SESSION_DIR_PATTERN.test(path.basename(dir));
}

// Chỉ xóa folder image_* nằm trực tiếp trong `root` và chỉ chứa file do SDK tạo,
// để không bao giờ xóa nhầm dữ liệu của người dùng trên Desktop.
async function inspectSessionDir(root, dir) {
  if (!samePath(path.dirname(dir), root) || !SESSION_DIR_PATTERN.test(path.basename(dir))) {
    return 'không phải folder ảnh của SDK';
  }
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : `không đọc được folder (${error.code || error.message})`;
  }
  const unexpected = entries.find((e) => !e.isFile() || !SESSION_FILE_PATTERN.test(e.name));
  if (unexpected) return `chứa mục không do SDK tạo: ${unexpected.name}`;
  return null;
}

function schedulePendingRetry() {
  if (pendingRetryTimer || !pendingDeletes.size) return;
  pendingRetryTimer = setTimeout(() => {
    pendingRetryTimer = null;
    retryPendingDeletes()
      .catch((error) => console.error('[DELETE] Lỗi khi thử xóa lại folder ảnh:', error.message))
      .finally(schedulePendingRetry);
  }, PENDING_RETRY_MS);
  pendingRetryTimer.unref();
}

async function removeSessionDir(dir, root) {
  const problem = await inspectSessionDir(root, dir);
  if (problem === 'missing') {
    pendingDeletes.delete(dir);
    return;
  }
  if (problem) {
    pendingDeletes.delete(dir);
    console.warn(`[DELETE] Bỏ qua ${dir}: ${problem}`);
    return;
  }
  let failure = null;
  try {
    await fs.promises.rm(dir, RM_OPTIONS);
    if (fs.existsSync(dir)) failure = 'folder vẫn tồn tại sau khi xóa';
  } catch (error) {
    failure = `${error.code || ''} ${error.message}`.trim();
  }
  if (failure) {
    const attempts = ((pendingDeletes.get(dir) || {}).attempts || 0) + 1;
    pendingDeletes.set(dir, { attempts, root });
    schedulePendingRetry();
    // File bị khóa lâu: ghi lần đầu và khoảng mỗi 10 phút, không ghi mỗi 30 giây.
    if (attempts === 1 || attempts % 20 === 0) {
      console.error(`[DELETE] Không xóa được folder ảnh CCCD (lần ${attempts}), sẽ thử lại: ${dir} - ${failure}`);
    }
    return;
  }
  pendingDeletes.delete(dir);
  console.log(`[DELETE] Đã xóa folder ảnh CCCD: ${dir}`);
}

async function retryPendingDeletes(skip = new Set()) {
  for (const [dir, { root }] of [...pendingDeletes]) {
    if (!skip.has(dir)) await removeSessionDir(dir, root);
  }
}

// Ảnh gốc của SDK (wh_/ir_/uv_/portrait_Scan_*.jpg) trước khi được copy sang folder phiên.
async function cleanSdkImageDir() {
  let entries;
  try {
    entries = await fs.promises.readdir(SDK_IMAGE_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[DELETE] Không đọc được thư mục image của SDK:', error.message);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      await fs.promises.rm(path.join(SDK_IMAGE_DIR, entry.name), RM_OPTIONS);
    } catch (error) {
      console.error(`[DELETE] Không xóa được ảnh gốc của SDK ${entry.name}: ${error.message}`);
    }
  }
}

// Xóa folder của một phiên đã kết thúc: folder SDK báo ("Folder ảnh: ...") hoặc folder suy
// ra từ thời điểm phát hiện thẻ (khi đọc lỗi SDK không báo folder), trong IMAGE_DIR và
// Desktop mặc định của SDK.
async function removeSessionImages(session) {
  const dirs = new Map(); // dir -> thư mục cha dùng để kiểm tra
  if (session.folder) {
    const folder = path.resolve(session.folder);
    dirs.set(folder, path.dirname(folder));
  }
  if (session.name) {
    for (const root of [IMAGE_DIR, ...LEGACY_IMAGE_DIRS]) {
      dirs.set(path.join(root, session.name), root);
    }
    // SDK thêm hậu tố _1, _2... khi 2 lần quét trong cùng một giây.
    try {
      for (const name of await fs.promises.readdir(IMAGE_DIR)) {
        if (name.toLowerCase().startsWith(`${session.name.toLowerCase()}_`)) {
          dirs.set(path.join(IMAGE_DIR, name), IMAGE_DIR);
        }
      }
    } catch {}
  }
  for (const [dir, root] of dirs) await removeSessionDir(dir, root);
  await retryPendingDeletes(new Set(dirs.keys()));
  await cleanSdkImageDir();
}

// Dọn ảnh còn sót (Agent/SDK bị dừng giữa chừng). Chỉ gọi khi SDK chưa chạy, nên không
// có phiên nào đang dùng các folder này.
async function sweepLeftoverImages() {
  for (const root of [IMAGE_DIR, ...LEGACY_IMAGE_DIRS]) {
    let names;
    try {
      names = await fs.promises.readdir(root);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => SESSION_DIR_PATTERN.test(n))) {
      await removeSessionDir(path.join(root, name), root);
    }
  }
  await cleanSdkImageDir();
}

// run.ps1 của bản cũ không truyền --desktop-root: SDK sẽ lưu ảnh vào Desktop của tài
// khoản đang chạy (LocalSystem -> systemprofile\Desktop) dù CCCD-Agent.exe đã cập nhật.
function checkRunScript() {
  try {
    if (!fs.readFileSync(RUN_PS1, 'utf8').includes('CCCD_DESKTOP_ROOT')) {
      console.error(
        `[CCCD] ${RUN_PS1} là bản cũ, không truyền thư mục ảnh cho SDK. Hãy cập nhật thư mục portable cùng CCCD-Agent.exe.`,
      );
    }
  } catch (error) {
    console.error(`[CCCD] Không đọc được ${RUN_PS1}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Đầu đọc CCCD
// ---------------------------------------------------------------------------

let lastHardwarePresent = null;
let hardwareCheckTimer = null;

function checkHardwareConnected(callback) {
  if (process.platform !== 'win32') {
    return callback(null, true);
  }
  exec('pnputil /enum-devices /connected /class USB', { timeout: 3000 }, (error, stdout) => {
    if (error) {
      return callback(null, true);
    }
    const hasDevice =
      stdout.includes('VID_0C45&PID_0415') ||
      stdout.includes('IDE200') ||
      stdout.includes('RTScan');
    callback(null, hasDevice);
  });
}

function killReaderProcess() {
  if (!readerProcess) return;
  const proc = readerProcess;
  readerProcess = null;
  readerStarted = false;
  readerStopped = true;
  try {
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${proc.pid} /T /F`, () => {});
    } else {
      proc.kill();
    }
  } catch {}
}

function pollHardwareStatus() {
  checkHardwareConnected((err, isConnected) => {
    if (err) return;

    // Phát hiện thiết bị bị rút ra khỏi USB khi Agent đang chạy
    if (lastHardwarePresent === true && !isConnected) {
      console.warn('[HARDWARE] Phát hiện đầu đọc CCCD đã bị rút khỏi cổng USB.');
      isReaderReady = false;
      readerStatus = 'no-reader';
      readerStatusMessage = 'Không tìm thấy thiết bị đọc CCCD (đã rút USB).';

      broadcast('reader-state', {
        state: 'no-reader',
        message: readerStatusMessage,
      });
      broadcast('reader-error', {
        message: readerStatusMessage,
      });

      killReaderProcess();
    }

    // Phát hiện thiết bị được cắm lại vào cổng USB
    if (lastHardwarePresent === false && isConnected) {
      console.log('[HARDWARE] Phát hiện đầu đọc CCCD đã được cắm lại vào cổng USB.');
      if (!readerProcess && !isShuttingDown) {
        if (readerRestartTimer) {
          clearTimeout(readerRestartTimer);
          readerRestartTimer = null;
        }
        startReader();
      }
    }

    lastHardwarePresent = isConnected;
  });
}

// Dừng read-cccd-chip.exe còn sót lại từ lần chạy trước (Agent bị kill/crash)
// để tránh 2 tiến trình SDK cùng giữ đầu đọc.
const KILL_READERS_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  `Get-CimInstance Win32_Process -Filter "Name='read-cccd-chip.exe'" | ` +
    `Where-Object { $_.ExecutablePath -eq '${SDK_EXE.replace(/'/g, "''")}' } | ` +
    `ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }`,
];

function killOrphanReaders(callback) {
  if (process.platform !== 'win32') return callback();
  execFile(
    'powershell.exe',
    KILL_READERS_ARGS,
    { timeout: 10000, windowsHide: true },
    (_error, stdout) => {
      const pids = String(stdout || '').trim().split(/\s+/).filter(Boolean);
      if (pids.length) {
        console.warn(`[CCCD] Đã dừng tiến trình SDK còn sót lại: ${pids.join(', ')}`);
      }
      callback();
    },
  );
}

let isShuttingDown = false;

function getCorsHeaders(req) {
  const origin = req && req.headers ? req.headers.origin : '';
  const allowedStr =
    process.env.ALLOWED_ORIGINS ||
    'https://visedu.vn,https://visedu.vn:4002,https://visedu.vn:4005';
  const whitelist = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'https://visedu.vn:4002', // Thêm origin port 4002 của bạn
    ...allowedStr
      .split(',')
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
      : whitelist.find((x) => x.includes('visedu.vn')) || whitelist[0];
  }

  return {
    'Access-Control-Allow-Origin': resultOrigin,
    'Access-Control-Allow-Private-Network': 'true', // Bắt buộc cho PNA
    'Access-Control-Allow-Credentials': 'true',
  };
}

let readerProcess = null;
let readerStarted = false;
let readerStopped = false;
let isReaderReady = false;
let readerStatus = 'stopped';
let readerStatusMessage = 'Máy đọc chưa chạy.';
let readerRestartTimer = null;
let consecutiveInitFailures = 0;
let currentBuffer = '';
let currentCard = null;
let currentSignature = '';
let sseClients = new Set();

// Phiên đọc hiện tại, bắt đầu từ dòng "Phát hiện thẻ" và kết thúc ở
// "Sẵn sàng đọc thẻ tiếp theo" (đã nhấc thẻ) hoặc khi tiến trình SDK dừng.
let activeSession = null;

// Ghi họ tên (trường fullName do parser trích từ dòng "- Họ tên:") đúng một lần mỗi
// phiên đọc thành công: ở dòng "Nhấc thẻ ra", hoặc khi phiên kết thúc nếu dòng đó
// không tới được Agent. Không ghi số CCCD, ngày sinh, địa chỉ, MRZ hay ảnh.
function logReadSuccessOnce(session) {
  if (!session || session.successLogged) return false;
  if (!session.sdkSuccess && !currentBuffer) return false;
  session.successLogged = true;
  const fullName = parseCardData(currentBuffer).fullName || 'Không xác định';
  console.log(`Đọc CCCD thành công - Họ và tên: ${fullName}`);
  return true;
}

function endSession() {
  const session = activeSession;
  activeSession = null;
  if (!session) return;
  logReadSuccessOnce(session);
  removeSessionImages(session).catch((error) =>
    console.error('[DELETE] Lỗi dọn ảnh CCCD của phiên đọc:', error.message),
  );
}

function sendJson(req, res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ...getCorsHeaders(req),
  });
  res.end(body);
}

function sendText(req, res, statusCode, text) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...getCorsHeaders(req),
  });
  res.end(text);
}

function sendFile(req, res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(req, res, 404, 'Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    res.writeHead(200, {
      'Content-Type': contentTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function cleanOutput(text) {
  return String(text || '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
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
  ].join('|');
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
  broadcast('card-read', {
    data,
    timestamp: new Date().toISOString(),
  });
  broadcast('reader-state', {
    state: 'card-read',
    message: 'Đọc CCCD thành công.',
  });
}

// Dòng do chính SDK (read-cccd-chip) in ra: được ghi vào log. Các dòng khác là output
// của thư viện OCR/native (đường dẫn template, mã nội bộ...) và bị bỏ qua.
const SDK_LOG_LINE =
  /^(RTScan |VID\/PID:|Serial:|Firmware:|Đang chờ CCCD|\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] Phát hiện thẻ|Chưa phát hiện thẻ|Đọc CCCD thành công\.|Folder ảnh:|Nhấc thẻ ra|Sẵn sàng đọc thẻ|Lỗi đọc thẻ:|Không chạy được tool đọc CCCD|Không tìm thấy sdk-root|Thiếu lib|RTScanner_|Thiết bị đang offline|Lỗi giao tiếp|Lỗi chụp ảnh|Không mở được thiết bị|SDK chưa khởi tạo|Không tải được DLL|System\.[\w.]+(Exception|Error)|at |--- End of|Unhandled exception)/;

// Thư viện native của SDK đôi khi in không xuống dòng, khiến dòng tiếp theo của SDK
// (trạng thái hoặc "- Họ tên: ...") bị dính vào sau nó. Tách lại tại các điểm này để
// không bỏ sót trạng thái và không ghi nhầm dữ liệu CCCD vào log.
const SDK_LINE_START =
  /- (Loại thiết bị|Số CCCD|Họ tên|Giới tính|Ngày sinh|Quốc tịch|Ngày hết hạn|Quê quán|Nơi thường trú|Thông tin khác|MRZ dòng \d|Scan session id|Ảnh mặt trước\/white|Ảnh hồng ngoại|Ảnh UV|Ảnh chân dung):|Folder ảnh:|Đọc CCCD thành công\.|Nhấc thẻ ra|Sẵn sàng đọc thẻ|Lỗi đọc thẻ:|\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] Phát hiện thẻ/g;

function handleReaderLine(rawLine) {
  const line = cleanOutput(rawLine).trim();
  if (!line) return;
  const starts = [...line.matchAll(SDK_LINE_START)].map((m) => m.index).filter((i) => i > 0);
  let from = 0;
  for (const index of [...starts, line.length]) {
    const part = line.slice(from, index).trim();
    if (part) handleSdkLine(part);
    from = index;
  }
}

function handleSdkLine(line) {
  // Họ tên được ghi ngay trước dòng "Nhấc thẻ ra..." của SDK.
  if (line.includes('Nhấc thẻ ra để đọc thẻ tiếp theo')) logReadSuccessOnce(activeSession);
  // Không ghi các dòng "- Số CCCD:", "- Họ tên:", "- MRZ...", đường dẫn ảnh...
  if (!line.startsWith('- ') && SDK_LOG_LINE.test(line)) console.log(line);

  // 1. Phát hiện lỗi không khởi tạo được phần cứng hoặc lỗi SDK
  if (
    line.includes('RTScanner_Start') ||
    line.includes('RTScanner_Init') ||
    line.includes('RTScanner_GetDeviceBaseInfo') ||
    line.includes('Không chạy được tool đọc CCCD') ||
    line.includes('InvalidOperationException') ||
    line.includes('Thiết bị đang offline') ||
    line.includes('Lỗi giao tiếp đầu đọc') ||
    line.includes('Không mở được thiết bị') ||
    line.includes('Cannot see if a key has been pressed')
  ) {
    isReaderReady = false;
    readerStatus = 'no-reader';
    readerStatusMessage = 'Không tìm thấy hoặc không khởi tạo được đầu đọc CCCD.';
    broadcast('reader-state', {
      state: 'no-reader',
      message: readerStatusMessage,
    });
    broadcast('reader-error', {
      message: readerStatusMessage,
    });
    return;
  }

  // 2. Phát hiện đầu đọc khởi tạo thành công và đang chờ thẻ
  if (
    line.includes('Đang chờ CCCD') ||
    line.includes('vùng NFC để đọc') ||
    line.includes('Sẵn sàng đọc thẻ tiếp theo')
  ) {
    isReaderReady = true;
    consecutiveInitFailures = 0;
    readerStatus = 'waiting';
    readerStatusMessage = 'Đang chờ CCCD...';
    if (line.includes('Sẵn sàng đọc thẻ tiếp theo')) {
      endSession();
      currentBuffer = '';
      currentCard = null;
      currentSignature = '';
      broadcast('card-removed', {
        message: 'Sẵn sàng đọc thẻ tiếp theo.',
      });
    }
    broadcast('reader-state', {
      state: 'waiting',
      message: readerStatusMessage,
    });
    return;
  }

  if (line.includes('Phát hiện thẻ, bắt đầu đọc')) {
    // Phiên trước chưa kết thúc (không nhận được "Sẵn sàng..."): dọn luôn.
    if (activeSession) endSession();
    activeSession = { name: sessionNameFromTimestamp(line), folder: null };
    currentBuffer = '';
    currentCard = null;
    currentSignature = '';
    readerStatus = 'reading';
    readerStatusMessage = 'Đang đọc CCCD...';
    broadcast('reader-state', {
      state: 'reading',
      message: readerStatusMessage,
    });
    return;
  }
  if (line.includes('Lỗi đọc thẻ:')) {
    const match = line.match(/SDK trả mã lỗi\s+(-?\d+)/i);
    const code = match ? Number(match[1]) : null;
    readerStatus = 'read-failed';
    readerStatusMessage = line;
    broadcast('card-read-failed', {
      code,
      message: line,
    });
    broadcast('reader-state', {
      state: 'read-failed',
      message: line,
    });
    currentBuffer = '';
    currentCard = null;
    currentSignature = '';
    return;
  }
  if (line.startsWith('Folder ảnh:')) {
    // SDK chỉ in dòng này khi đọc thành công; folder phải nằm trong IMAGE_DIR.
    const folder = line.slice('Folder ảnh:'.length).trim();
    if (activeSession) {
      activeSession.folder = folder;
      activeSession.sdkSuccess = true;
    }
    if (!samePath(path.dirname(folder), IMAGE_DIR)) {
      console.error(`[CCCD] SDK lưu ảnh ngoài thư mục ảnh đã cấu hình (${IMAGE_DIR}): ${folder}`);
    }
    return;
  }
  if (line.includes('Đọc CCCD thành công.')) {
    if (activeSession) activeSession.sdkSuccess = true;
    broadcast('reader-state', {
      state: 'reading',
      message: 'Đang nhận dữ liệu CCCD...',
    });
  }
  if (line.includes('Nhấc thẻ ra để đọc thẻ tiếp theo')) {
    broadcast('waiting-card-removal', {
      message: 'Nhấc thẻ ra để đọc thẻ tiếp theo.',
    });
    return;
  }

  if (
    line.startsWith('- Loại thiết bị:') ||
    line.startsWith('- Số CCCD:') ||
    line.startsWith('- Họ tên:') ||
    line.startsWith('- Giới tính:') ||
    line.startsWith('- Ngày sinh:') ||
    line.startsWith('- Quốc tịch:') ||
    line.startsWith('- Ngày hết hạn:') ||
    line.startsWith('- Quê quán:') ||
    line.startsWith('- Nơi thường trú:') ||
    line.startsWith('- Thông tin khác:') ||
    line.startsWith('- MRZ dòng 1:') ||
    line.startsWith('- MRZ dòng 2:') ||
    line.startsWith('- MRZ dòng 3:') ||
    line.startsWith('- Scan session id:') ||
    line.startsWith('- Ảnh mặt trước/white:') ||
    line.startsWith('- Ảnh hồng ngoại:') ||
    line.startsWith('- Ảnh UV:') ||
    line.startsWith('- Ảnh chân dung:')
  ) {
    currentBuffer += `${line}\n`;
    processBuffer();
  }
}

function startReader() {
  if (readerStarted || readerProcess || isShuttingDown) return;

  checkHardwareConnected((err, isConnected) => {
    lastHardwarePresent = isConnected;

    if (!isConnected) {
      const alreadyReported = readerStatus === 'no-reader';
      isReaderReady = false;
      readerStatus = 'no-reader';
      readerStatusMessage = 'Không tìm thấy thiết bị đọc CCCD (chưa cắm USB).';
      // Chỉ ghi lần đầu, không lặp lại mỗi 5 giây khi chưa cắm đầu đọc.
      if (!alreadyReported) console.warn(`[CCCD] ${readerStatusMessage}`);
      broadcast('reader-state', {
        state: 'no-reader',
        message: readerStatusMessage,
      });
      broadcast('reader-error', {
        message: readerStatusMessage,
      });

      if (!isShuttingDown) {
        if (readerRestartTimer) clearTimeout(readerRestartTimer);
        readerRestartTimer = setTimeout(() => {
          if (!isShuttingDown) startReader();
        }, 5000);
      }
      return;
    }

    readerStarted = true;
    readerStopped = false;
    isReaderReady = false;
    readerStatus = 'starting';
    readerStatusMessage = 'Đang khởi động máy đọc CCCD...';
    currentBuffer = '';
    currentCard = null;
    currentSignature = '';

    console.log('Khởi động máy đọc CCCD...');
    broadcast('reader-started', {
      message: 'Máy đọc CCCD đã được khởi động.',
    });
    broadcast('reader-state', {
      state: 'starting',
      message: readerStatusMessage,
    });

    // SDK dùng Console.KeyAvailable nên stdin phải là console thật.
    // Khi chạy dưới Service (NSSM) stdin của Agent không phải console,
    // vì vậy lấy stdin từ CONIN$ (console của cmd.exe) thay vì kế thừa.
    // CCCD_DESKTOP_ROOT: run.ps1 truyền cho SDK dưới dạng --desktop-root.
    readerProcess = spawn('cmd.exe', ['/d', '/s', '/c', `""${RUN_CMD}" < CONIN$"`], {
      cwd: PORTABLE_DIR,
      env: { ...process.env, CCCD_DESKTOP_ROOT: IMAGE_DIR },
      windowsHide: false,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    readerProcess.stdout.setEncoding('utf8');
    readerProcess.stderr.setEncoding('utf8');
    // Một dòng có thể bị chia ra nhiều chunk: chỉ xử lý dòng đã kết thúc bằng xuống dòng.
    for (const stream of [readerProcess.stdout, readerProcess.stderr]) {
      let pending = '';
      stream.on('data', (chunk) => {
        const lines = (pending + chunk).split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) handleReaderLine(line);
      });
      stream.on('end', () => {
        if (pending) handleReaderLine(pending);
        pending = '';
      });
    }
    readerProcess.on('error', (error) => {
      console.error('Reader error:', error.message);
      isReaderReady = false;
      readerStatus = 'error';
      readerStatusMessage = error.message;
      broadcast('reader-error', {
        message: error.message,
      });
      broadcast('reader-state', {
        state: 'error',
        message: 'Máy đọc CCCD gặp lỗi khởi động.',
      });
    });
    readerProcess.on('exit', (code, signal) => {
      readerProcess = null;
      readerStopped = true;
      readerStarted = false;
      const hadHardwareError = readerStatus === 'no-reader' || !isReaderReady;
      isReaderReady = false;
      // SDK dừng giữa phiên đọc: phiên đó không thể hoàn tất, xóa ảnh.
      endSession();

      if (hadHardwareError) {
        consecutiveInitFailures++;
        readerStatus = 'no-reader';
        readerStatusMessage = 'Đầu đọc CCCD chưa sẵn sàng hoặc không có phần cứng.';
      } else {
        consecutiveInitFailures = 0;
        readerStatus = 'stopped';
        readerStatusMessage = 'Máy đọc đã dừng.';
      }

      broadcast('reader-stopped', {
        code,
        signal,
      });
      broadcast('reader-state', {
        state: readerStatus,
        message: readerStatusMessage,
      });

      if (!isShuttingDown) {
        if (readerRestartTimer) clearTimeout(readerRestartTimer);
        const delay = hadHardwareError
          ? Math.min(15000, 3000 + consecutiveInitFailures * 2000)
          : 3000;

        // Lỗi khởi tạo lặp lại liên tục khi đầu đọc hỏng: chỉ ghi vài lần đầu.
        if (consecutiveInitFailures <= 3) {
          console.log(
            `Máy đọc đã dừng. Code: ${code}, Signal: ${signal || ''}. Tự động khởi động lại sau ${Math.round(delay / 1000)} giây...`,
          );
        }

        readerRestartTimer = setTimeout(() => {
          if (!isShuttingDown) startReader();
        }, delay);
      }
    });
  });
}

function serveImage(req, res, imagePath) {
  if (!imagePath) {
    sendText(req, res, 400, 'Missing image path');
    return;
  }
  const filePath = String(imagePath).trim();
  const allowedExtensions = [
    '.jpg',
    '.jpeg',
    '.png',
    '.bmp',
    '.webp',
    '.gif',
    '.tif',
    '.tiff',
  ];
  const ext = path.extname(filePath).toLowerCase();
  if (!allowedExtensions.includes(ext)) {
    sendText(req, res, 403, 'Unsupported image type');
    return;
  }
  // Chỉ phục vụ ảnh của phiên đọc CCCD, không cho đọc ảnh bất kỳ trên máy.
  if (!isSessionImage(filePath)) {
    sendText(req, res, 403, 'Forbidden');
    return;
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      sendText(req, res, 404, 'Image not found');
      return;
    }
    const contentTypes = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.bmp': 'image/bmp',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.tif': 'image/tiff',
      '.tiff': 'image/tiff',
    };
    res.writeHead(200, {
      'Content-Type': contentTypes[ext],
      'Cache-Control': 'no-cache',
      ...getCorsHeaders(req),
    });
    const stream = fs.createReadStream(filePath);
    stream.on('error', (error) => {
      console.error('Image error:', error.message);
      if (!res.headersSent) {
        sendText(req, res, 500, 'Cannot read image');
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });
}

function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(req, res, 200, {
      success: true,
      readerRunning: Boolean(readerProcess),
      readerStarted,
      readerStopped,
      isReaderReady,
      readerStatus,
      readerStatusMessage,
    });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(req, res, 200, {
      success: true,
      readerRunning: Boolean(readerProcess),
      readerStarted,
      readerStopped,
      isReaderReady,
      readerStatus,
      readerStatusMessage,
      card: currentCard,
    });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/image') {
    serveImage(req, res, url.searchParams.get('path'));
    return true;
  }
  return false;
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...getCorsHeaders(req),
  });
  res.write('\n');
  sseClients.add(res);
  writeSse(res, 'connected', {
    message: 'Đã kết nối tới CCCD Agent.',
  });
  writeSse(res, 'reader-state', {
    state: readerStatus,
    message: readerStatusMessage,
  });
  if (currentCard) {
    writeSse(res, 'card-read', {
      data: currentCard,
      timestamp: new Date().toISOString(),
    });
  }
  req.on('close', () => {
    sseClients.delete(res);
  });
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(req, res, 403, 'Forbidden');
    return;
  }
  sendFile(req, res, filePath);
}

const server = http.createServer((req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || `${HOST}:${PORT}`}`,
  );
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Access-Control-Allow-Private-Network',
      'Access-Control-Allow-Private-Network': 'true', // Bắt buộc
      ...getCorsHeaders(req),
    });
    res.end();
    return;
  }
  if (url.pathname === '/events' && req.method === 'GET') {
    handleEvents(req, res);
    return;
  }
  if (handleApi(req, res, url)) return;
  if (req.method === 'GET') {
    serveStatic(req, res, url);
    return;
  }
  sendText(req, res, 404, 'Not found');
});

const heartbeat = setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': heartbeat\n\n');
    } catch {
      sseClients.delete(client);
    }
  }
}, 15000);

server.listen(PORT, HOST, () => {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {}
  console.log('');
  console.log('==============================');
  console.log(' CCCD Local Agent');
  console.log('==============================');
  console.log(`http://${HOST}:${PORT}`);
  console.log(`Tài khoản: ${user} | Thư mục chạy: ${APP_DIR}`);
  console.log(`Thư mục ảnh CCCD: ${IMAGE_DIR}`);
  console.log('');
  checkRunScript();
  // Chỉ dọn SDK sót lại sau khi đã giữ được cổng, tức không có Agent khác đang chạy.
  killOrphanReaders(() => {
    // SDK chưa chạy nên mọi folder image_* còn lại đều là ảnh sót của lần chạy trước.
    sweepLeftoverImages()
      .catch((error) => console.error('[DELETE] Lỗi dọn ảnh CCCD còn sót:', error.message))
      .finally(() => {
        if (isShuttingDown) return;
        startReader();
        hardwareCheckTimer = setInterval(pollHardwareStatus, 2000);
      });
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[CCCD] Cổng ${PORT} đang được sử dụng. Có thể CCCD Agent hoặc Service CCCDLocalAgent đã chạy.`,
    );
  } else {
    console.error('Lỗi HTTP server:', error.message);
  }
  process.exit(1);
});

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('CCCD Local Agent đang dừng...');
  clearInterval(heartbeat);
  if (hardwareCheckTimer) {
    clearInterval(hardwareCheckTimer);
    hardwareCheckTimer = null;
  }
  if (readerRestartTimer) {
    clearTimeout(readerRestartTimer);
    readerRestartTimer = null;
  }
  for (const client of sseClients) {
    try {
      client.end();
    } catch {}
  }
  sseClients.clear();
  killReaderProcess();
  // Dọn SDK đồng bộ: khi dừng Service, NSSM kill cả cây tiến trình của Agent
  // nên taskkill bất đồng bộ ở trên có thể bị kill trước khi kịp chạy xong.
  if (process.platform === 'win32') {
    try {
      execFileSync('powershell.exe', KILL_READERS_ARGS, {
        timeout: 4000,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {}
  }
  // Ảnh của phiên đang dở; nếu không kịp xóa ở đây sẽ được dọn ở lần khởi động sau.
  const dir =
    activeSession &&
    (activeSession.folder || (activeSession.name && path.join(IMAGE_DIR, activeSession.name)));
  if (dir && SESSION_DIR_PATTERN.test(path.basename(dir))) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      console.log(`[DELETE] Đã xóa folder ảnh CCCD: ${dir}`);
    } catch (error) {
      console.warn(`[DELETE] Chưa xóa được ${dir} khi dừng, sẽ dọn ở lần khởi động sau: ${error.message}`);
    }
  }
  activeSession = null;
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
