"use strict";

function cleanValue(value) {
  return String(value || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
}

function getValue(line, prefix) {
  if (!line.startsWith(prefix)) return "";
  return cleanValue(line.slice(prefix.length));
}

function parseCardData(text) {
  const lines = String(text || "").split(/\r?\n/);
  const data = {
    success: false,
    deviceType: "",
    idNumber: "",
    fullName: "",
    gender: "",
    dateOfBirth: "",
    nationality: "",
    expiryDate: "",
    placeOfOrigin: "",
    placeOfResidence: "",
    otherInfo: "",
    mrz1: "",
    mrz2: "",
    mrz3: "",
    scanSessionId: "",
    images: {
      frontWhite: "",
      infrared: "",
      ultraviolet: "",
      portrait: "",
    },
  };
  for (const rawLine of lines) {
    const line = cleanValue(rawLine);
    if (!line) continue;
    let value = "";
    value = getValue(line, "- Loại thiết bị:");
    if (value) {
      data.deviceType = value;
      continue;
    }
    value = getValue(line, "- Số CCCD:");
    if (value) {
      data.idNumber = value;
      continue;
    }
    value = getValue(line, "- Họ tên:");
    if (value) {
      data.fullName = value;
      continue;
    }
    value = getValue(line, "- Giới tính:");
    if (value) {
      data.gender = value;
      continue;
    }
    value = getValue(line, "- Ngày sinh:");
    if (value) {
      data.dateOfBirth = value;
      continue;
    }
    value = getValue(line, "- Quốc tịch:");
    if (value) {
      data.nationality = value;
      continue;
    }
    value = getValue(line, "- Ngày hết hạn:");
    if (value) {
      data.expiryDate = value;
      continue;
    }
    value = getValue(line, "- Quê quán:");
    if (value) {
      data.placeOfOrigin = value;
      continue;
    }
    value = getValue(line, "- Nơi thường trú:");
    if (value) {
      data.placeOfResidence = value;
      continue;
    }
    value = getValue(line, "- Thông tin khác:");
    if (value) {
      data.otherInfo = value;
      continue;
    }
    value = getValue(line, "- MRZ dòng 1:");
    if (value) {
      data.mrz1 = value;
      continue;
    }
    value = getValue(line, "- MRZ dòng 2:");
    if (value) {
      data.mrz2 = value;
      continue;
    }
    value = getValue(line, "- MRZ dòng 3:");
    if (value) {
      data.mrz3 = value;
      continue;
    }
    value = getValue(line, "- Scan session id:");
    if (value) {
      data.scanSessionId = value;
      continue;
    }
    value = getValue(line, "- Ảnh mặt trước/white:");
    if (value) {
      data.images.frontWhite = value;
      continue;
    }
    value = getValue(line, "- Ảnh hồng ngoại:");
    if (value) {
      data.images.infrared = value;
      continue;
    }
    value = getValue(line, "- Ảnh UV:");
    if (value) {
      data.images.ultraviolet = value;
      continue;
    }
    value = getValue(line, "- Ảnh chân dung:");
    if (value) {
      data.images.portrait = value;
      continue;
    }
  }
  data.success = Boolean(data.idNumber && data.fullName);
  return data;
}

module.exports = {
  parseCardData,
};
