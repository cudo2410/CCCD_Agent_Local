"use strict";

const guideScreen = document.getElementById("guide-screen");
const cardScreen = document.getElementById("card-screen");
const statusBadge = document.querySelector(".agent-status-badge");
const statusText = document.getElementById("device-status-text");
const waitingText = document.getElementById("waiting-text");
const toast = document.getElementById("toast");

function showGuide() {
  guideScreen.classList.remove("hidden");
  cardScreen.classList.add("hidden");
}

function showCard() {
  guideScreen.classList.add("hidden");
  cardScreen.classList.remove("hidden");
}

function setStatus(state, message) {
  if (statusBadge) statusBadge.className = `agent-status-badge ${state}`;
  if (statusText) statusText.textContent = message;
  if (waitingText) waitingText.textContent = message;
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 3000);
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value || "-";
}

function getImageUrl(imagePath) {
  if (!imagePath) return "";
  const value = String(imagePath).trim();
  if (!value) return "";
  if (value.startsWith("http://") || value.startsWith("https://")) return value;
  return `/api/image?path=${encodeURIComponent(value)}`;
}

function setImage(imageId, placeholderId, imagePath) {
  const image = document.getElementById(imageId);
  const placeholder = document.getElementById(placeholderId);
  if (!image) return;
  if (!imagePath) {
    image.removeAttribute("src");
    image.classList.remove("visible");
    image.classList.remove("clickable-image");
    if (placeholder) {
      placeholder.classList.remove("hidden");
      placeholder.textContent = "Chưa có ảnh";
    }
    return;
  }
  const imageUrl = getImageUrl(imagePath);
  image.onload = () => {
    image.classList.add("visible");
    image.classList.add("clickable-image");
    if (placeholder) placeholder.classList.add("hidden");
  };
  image.onerror = () => {
    image.classList.remove("visible");
    image.classList.remove("clickable-image");
    if (placeholder) {
      placeholder.classList.remove("hidden");
      placeholder.textContent = "Không tải được ảnh";
    }
  };
  image.src = imageUrl;
}

function displayCard(data) {
  if (!data) return;
  const images = data.images || {};
  setText("full-name", data.fullName);
  setText("id-number", data.idNumber);
  setText("id-number-info", data.idNumber);
  setText("gender", data.gender);
  setText("date-of-birth", data.dateOfBirth);
  setText("nationality", data.nationality);
  setText("expiry-date", data.expiryDate);
  setText("device-type", data.deviceType);
  setText("place-of-origin", data.placeOfOrigin);
  setText("place-of-residence", data.placeOfResidence);
  setText("other-info", data.otherInfo);
  setText("scan-session-id", data.scanSessionId);
  setImage("front-white", "front-white-placeholder", images.frontWhite);
  setImage("portrait", "portrait-placeholder", images.portrait);
  setImage("infrared", "infrared-placeholder", images.infrared);
  setImage("ultraviolet", "ultraviolet-placeholder", images.ultraviolet);
  showCard();
  setStatus("success", "Đã đọc CCCD");
}

function createImageViewer() {
  if (document.getElementById("image-viewer")) return;
  const viewer = document.createElement("div");
  viewer.id = "image-viewer";
  viewer.className = "image-viewer hidden";
  viewer.innerHTML = `
    <div class="image-viewer-backdrop"></div>
    <div class="image-viewer-content">
      <button id="image-viewer-close" class="image-viewer-close" type="button" aria-label="Đóng">×</button>
      <img id="image-viewer-image" src="" alt="Ảnh CCCD phóng to" />
    </div>
  `;
  document.body.appendChild(viewer);
  const closeButton = document.getElementById("image-viewer-close");
  const backdrop = viewer.querySelector(".image-viewer-backdrop");
  closeButton.addEventListener("click", closeImageViewer);
  backdrop.addEventListener("click", closeImageViewer);
}

function openImageViewer(image) {
  if (!image || !image.src || !image.classList.contains("visible")) return;
  createImageViewer();
  const viewer = document.getElementById("image-viewer");
  const viewerImage = document.getElementById("image-viewer-image");
  viewerImage.src = image.src;
  viewerImage.alt = image.alt || "Ảnh CCCD";
  viewer.classList.remove("hidden");
  document.body.classList.add("image-viewer-open");
}

function closeImageViewer() {
  const viewer = document.getElementById("image-viewer");
  const viewerImage = document.getElementById("image-viewer-image");
  if (!viewer) return;
  viewer.classList.add("hidden");
  document.body.classList.remove("image-viewer-open");
  if (viewerImage) viewerImage.removeAttribute("src");
}

function setupImageViewer() {
  const imageIds = ["front-white", "portrait", "infrared", "ultraviolet"];
  imageIds.forEach((id) => {
    const image = document.getElementById(id);
    if (!image) return;
    image.addEventListener("click", () => openImageViewer(image));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeImageViewer();
  });
}

async function loadStatus() {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) return;
    const result = await response.json();
    if (result.card) displayCard(result.card);
    if (result.readerRunning) {
      setStatus("waiting", "Đang chờ CCCD...");
    } else {
      setStatus("stopped", "Máy đọc đã dừng");
    }
  } catch {
    setStatus("error", "Không kết nối được Agent");
  }
}

function connectEvents() {
  const source = new EventSource("/events");
  source.addEventListener("connected", () => {
    setStatus("waiting", "Đang chờ CCCD...");
  });
  source.addEventListener("reader-started", () => {
    setStatus("waiting", "Đang chờ CCCD...");
  });
  source.addEventListener("reader-state", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.state === "waiting") {
        setStatus("waiting", data.message || "Đang chờ CCCD...");
        showGuide();
        return;
      }
      if (data.state === "reading") {
        setStatus("reading", data.message || "Đang đọc CCCD...");
        return;
      }
      if (data.state === "read-failed") {
        showGuide();
        setStatus("error", "Hãy lật ngược thẻ lại");
        return;
      }
      if (data.state === "stopped") {
        setStatus("stopped", data.message || "Máy đọc đã dừng");
      }
    } catch (error) {
      console.error("[SSE] reader-state không hợp lệ:", error);
    }
  });
  source.addEventListener("card-read", (event) => {
    try {
      const eventData = JSON.parse(event.data);
      const data = eventData.data || eventData;
      displayCard(data);
    } catch (error) {
      console.error("[SSE] card-read không hợp lệ:", error);
    }
  });
  source.addEventListener("card-read-failed", (event) => {
    showGuide();
    setStatus("error", "Hãy lật ngược thẻ lại");
  });
  source.addEventListener("waiting-card-removal", (event) => {
    try {
      const data = JSON.parse(event.data);
      setStatus("success", data.message || "Nhấc thẻ ra...");
    } catch (error) {
      setStatus("success", "Nhấc thẻ ra...");
    }
  });
  source.addEventListener("card-removed", () => {
    showGuide();
    setStatus("waiting", "Đang chờ CCCD...");
  });
  source.addEventListener("reader-error", (event) => {
    let data = {};
    try {
      data = JSON.parse(event.data);
    } catch (error) {
      console.error("[SSE] reader-error không hợp lệ:", error);
    }
    setStatus("error", "Lỗi máy đọc");
    showToast(data.message || "Lỗi máy đọc CCCD");
  });
  source.addEventListener("reader-stopped", () => {
    setStatus("stopped", "Máy đọc đã dừng");
  });
  source.onerror = () => {
    setStatus("error", "Mất kết nối Agent");
  };
}

createImageViewer();
setupImageViewer();
showGuide();
loadStatus();
connectEvents();
