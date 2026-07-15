/**
 * CLIENT.JS
 * Logika di sisi client (browser).
 * Bertugas: membuka koneksi ke server, mengirim & menerima pesan chat,
 * mengirim file (dikonversi ke base64), serta menangani error koneksi.
 */

const socket = io(); // otomatis connect ke server asal (origin) halaman ini

// ==================== ELEMEN DOM ====================
const loginOverlay = document.getElementById("login-overlay");
const loginError = document.getElementById("login-error");

// Step 1: email
const stepEmail = document.getElementById("step-email");
const emailInput = document.getElementById("email-input");
const sendOtpBtn = document.getElementById("send-otp-btn");

// Step 2: OTP
const stepOtp = document.getElementById("step-otp");
const otpInfoText = document.getElementById("otp-info-text");
const otpInput = document.getElementById("otp-input");
const verifyOtpBtn = document.getElementById("verify-otp-btn");
const resendOtpBtn = document.getElementById("resend-otp-btn");
const backToEmailBtn = document.getElementById("back-to-email-btn");

// Step 3: username
const stepUsername = document.getElementById("step-username");
const usernameInput = document.getElementById("username-input");
const joinBtn = document.getElementById("join-btn");

const appEl = document.getElementById("app");
const messagesEl = document.getElementById("messages");
const userListEl = document.getElementById("user-list");
const connectionStatusEl = document.getElementById("connection-status");

const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");

const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");
const progressWrap = document.getElementById("upload-progress-wrap");
const progressBar = document.getElementById("upload-progress-bar");
const progressText = document.getElementById("upload-progress-text");

let myUsername = "";
let resendCooldownTimer = null;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // harus sinkron dengan batas di server

// ==================== FUNGSI BANTUAN ====================
function appendMessage({ type, username, message, timestamp, fileUrl, fileName, fileType, fileSize }) {
  const div = document.createElement("div");

  if (type === "system") {
    div.className = "msg system";
    div.textContent = message;
  } else if (type === "error") {
    div.className = "msg error";
    div.textContent = "⚠️ " + message;
  } else if (type === "file") {
    div.className = "msg file" + (username === myUsername ? " own" : "");
    const time = new Date(timestamp).toLocaleTimeString();
    const sizeText = `${(fileSize / 1024).toFixed(1)} KB`;
    const mime = (fileType || "").toLowerCase();

    let previewHtml = "";
    if (mime.startsWith("image/")) {
      previewHtml = `
        <a href="${fileUrl}" target="_blank">
          <img src="${fileUrl}" alt="${escapeHtml(fileName)}" class="file-preview-img" loading="lazy" />
        </a>
      `;
    } else if (mime.startsWith("video/")) {
      previewHtml = `
        <video src="${fileUrl}" class="file-preview-video" controls preload="metadata"></video>
      `;
    }

    div.innerHTML = `
      <div class="meta">${username} • ${time}</div>
      ${previewHtml}
      📎 <a href="${fileUrl}" target="_blank" download>${fileName}</a>
      <div class="meta">${sizeText}</div>
    `;
  } else {
    div.className = "msg" + (username === myUsername ? " own" : "");
    const time = new Date(timestamp).toLocaleTimeString();
    div.innerHTML = `<div class="meta">${username} • ${time}</div>${escapeHtml(message)}`;
  }

  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(str) {
  const p = document.createElement("p");
  p.textContent = str;
  return p.innerHTML;
}

function renderUserList(users) {
  userListEl.innerHTML = "";
  users.forEach((u) => {
    const li = document.createElement("li");
    li.textContent = u === myUsername ? `${u} (kamu)` : u;
    userListEl.appendChild(li);
  });
}

// ==================== LOGIN: STEP 1 - KIRIM OTP KE EMAIL ====================
sendOtpBtn.addEventListener("click", requestOtp);
emailInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") requestOtp();
});

function requestOtp() {
  const email = emailInput.value.trim();
  loginError.textContent = "";

  if (!email) {
    loginError.textContent = "Email tidak boleh kosong.";
    return;
  }

  sendOtpBtn.disabled = true;
  sendOtpBtn.textContent = "Mengirim...";

  socket.emit("request_otp", { email }, (response) => {
    sendOtpBtn.disabled = false;
    sendOtpBtn.textContent = "Kirim Kode OTP";

    if (!response || !response.success) {
      loginError.textContent = response ? response.message : "Gagal mengirim kode OTP.";
      return;
    }

    otpInfoText.textContent = `Kode OTP telah dikirim ke ${email}. Cek inbox (atau folder spam).`;
    otpInput.value = "";
    stepEmail.classList.add("hidden");
    stepOtp.classList.remove("hidden");
    otpInput.focus();
    startResendCooldown();
  });
}

// ==================== LOGIN: STEP 2 - VERIFIKASI KODE OTP ====================
verifyOtpBtn.addEventListener("click", verifyOtp);
otpInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") verifyOtp();
});

function verifyOtp() {
  const code = otpInput.value.trim();
  loginError.textContent = "";

  if (!code) {
    loginError.textContent = "Kode OTP tidak boleh kosong.";
    return;
  }

  verifyOtpBtn.disabled = true;
  verifyOtpBtn.textContent = "Memverifikasi...";

  socket.emit("verify_otp", { code }, (response) => {
    verifyOtpBtn.disabled = false;
    verifyOtpBtn.textContent = "Verifikasi";

    if (!response || !response.success) {
      loginError.textContent = response ? response.message : "Verifikasi gagal.";
      return;
    }

    clearInterval(resendCooldownTimer);
    stepOtp.classList.add("hidden");
    stepUsername.classList.remove("hidden");
    usernameInput.focus();
  });
}

resendOtpBtn.addEventListener("click", () => {
  if (resendOtpBtn.disabled) return;
  requestOtp();
});

backToEmailBtn.addEventListener("click", () => {
  clearInterval(resendCooldownTimer);
  loginError.textContent = "";
  otpInput.value = "";
  stepOtp.classList.add("hidden");
  stepEmail.classList.remove("hidden");
});

function startResendCooldown() {
  let seconds = 60;
  resendOtpBtn.disabled = true;
  resendOtpBtn.textContent = `Kirim Ulang (${seconds}s)`;

  clearInterval(resendCooldownTimer);
  resendCooldownTimer = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(resendCooldownTimer);
      resendOtpBtn.disabled = false;
      resendOtpBtn.textContent = "Kirim Ulang Kode";
    } else {
      resendOtpBtn.textContent = `Kirim Ulang (${seconds}s)`;
    }
  }, 1000);
}

// ==================== LOGIN: STEP 3 - MASUKKAN USERNAME & GABUNG ====================
joinBtn.addEventListener("click", handleJoin);
usernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleJoin();
});

function handleJoin() {
  const name = usernameInput.value.trim();
  loginError.textContent = "";

  if (!name) {
    loginError.textContent = "Nama tidak boleh kosong.";
    return;
  }
  myUsername = name;
  socket.emit("join", name);
  loginOverlay.classList.add("hidden");
  appEl.classList.remove("hidden");
}

// ==================== KIRIM PESAN CHAT ====================
sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendMessage();
});

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit("chat_message", { message: text });
  messageInput.value = "";
}

// ==================== KIRIM FILE ====================
attachBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;

  if (file.size > MAX_FILE_SIZE) {
    appendMessage({ type: "error", message: `File terlalu besar. Maksimum ${MAX_FILE_SIZE / 1024 / 1024} MB.` });
    fileInput.value = "";
    return;
  }

  const reader = new FileReader();

  progressWrap.classList.remove("hidden");
  progressBar.style.width = "0%";
  progressText.textContent = "Membaca file... 0%";

  reader.onprogress = (e) => {
    if (e.lengthComputable) {
      const percent = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = percent + "%";
      progressText.textContent = `Membaca file... ${percent}%`;
    }
  };

  reader.onload = () => {
    // Ambil bagian base64 saja (buang prefix "data:...;base64,")
    const base64Data = reader.result.split(",")[1];

    progressText.textContent = "Mengunggah ke server...";

    socket.emit(
      "file_upload",
      {
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        fileData: base64Data,
      },
      (response) => {
        // Callback acknowledgment dari server (berhasil / gagal)
        progressWrap.classList.add("hidden");
        if (!response || !response.success) {
          appendMessage({ type: "error", message: response ? response.message : "Gagal mengirim file." });
        }
      }
    );
  };

  reader.onerror = () => {
    progressWrap.classList.add("hidden");
    appendMessage({ type: "error", message: "Gagal membaca file dari perangkat." });
  };

  reader.readAsDataURL(file);
  fileInput.value = "";
});

// ==================== EVENT DARI SERVER ====================
socket.on("connect", () => {
  connectionStatusEl.textContent = "🟢 Terhubung ke server";
  connectionStatusEl.style.color = "#4ade80";
});

socket.on("disconnect", () => {
  connectionStatusEl.textContent = "🔴 Terputus dari server";
  connectionStatusEl.style.color = "#f87171";
  appendMessage({ type: "system", message: "Koneksi ke server terputus. Mencoba menghubungkan kembali..." });
});

socket.on("connect_error", (err) => {
  connectionStatusEl.textContent = "🔴 Gagal terhubung";
  connectionStatusEl.style.color = "#f87171";
  console.error("Connection error:", err.message);
});

socket.on("system_message", (message) => {
  appendMessage({ type: "system", message });
});

socket.on("error_message", (message) => {
  appendMessage({ type: "error", message });
});

socket.on("chat_message", (data) => {
  appendMessage({ type: "chat", ...data });
});

socket.on("file_message", (data) => {
  appendMessage({ type: "file", ...data });
});

socket.on("user_list", (users) => {
  renderUserList(users);
});
