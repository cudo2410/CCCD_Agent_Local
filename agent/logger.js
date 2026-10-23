'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

// Ghi console.log/warn/error nối tiếp vào logs/agent.log.
// Khi file vượt maxBytes: agent.log -> agent.1.log -> ... -> agent.<maxFiles>.log,
// file cũ nhất bị loại bỏ.
function setupFileLog({ dir, maxBytes = 5 * 1024 * 1024, maxFiles = 5 }) {
  const file = path.join(dir, 'agent.log');
  let size = 0;
  let enabled = true;

  try {
    fs.mkdirSync(dir, { recursive: true });
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch (error) {
    enabled = false;
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
    if (!enabled) return;
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
      enabled = false;
      process.stderr.write(`[LOG] Ngừng ghi file log: ${error.message}\n`);
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

  return file;
}

module.exports = { setupFileLog };
