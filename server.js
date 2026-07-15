/**
 * SERVER.JS
 * Server aplikasi Chat & File Transfer berbasis Client-Server
 * Protokol   : WebSocket (menggunakan library Socket.io yang berjalan di atas TCP/HTTP)
 * Framework  : Express.js (untuk menyajikan file statis client) + Socket.io (untuk komunikasi realtime)
 *
 * Tugas server:
 *  1. Menerima koneksi dari banyak client sekaligus.
 *  2. Mengirim kode OTP ke email user dan memverifikasinya sebelum boleh bergabung ke chat.
 *  3. Menyiarkan (broadcast) pesan chat ke semua client yang terhubung.
 *  4. Menerima file yang dikirim client, menyimpannya di folder "uploads",
 *     lalu membagikan link download ke semua client.
 *  5. Menangani error koneksi, error penyimpanan file, dan pemutusan koneksi (disconnect).
 */

require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");

// ==================== KONFIGURASI ====================
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // batas ukuran file: 10 MB

// Pastikan folder uploads tersedia
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// ==================== KONFIGURASI OTP (VERIFIKASI EMAIL) ====================
const OTP_LENGTH = 6;
const OTP_EXPIRY_MS = 5 * 60 * 1000; // kode OTP berlaku 5 menit
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // jeda minimal sebelum boleh kirim ulang
const OTP_MAX_ATTEMPTS = 5; // batas percobaan verifikasi salah sebelum kode dianggap hangus

// Transporter nodemailer, dikonfigurasi lewat file .env (lihat .env.example)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === "true", // true untuk port 465, false untuk 587/25
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Menyimpan kode OTP yang sedang aktif, per socket.id:
// { [socketId]: { email, code, expiresAt, attempts, lastSentAt } }
const otpStore = {};

// Menyimpan socket yang emailnya sudah berhasil diverifikasi: { [socketId]: email }
const verifiedSockets = {};

function generateOtpCode() {
  // Hasilkan angka acak 6 digit, misal "042917"
  return Math.floor(100000 + Math.random() * 900000)
    .toString()
    .slice(0, OTP_LENGTH);
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function sendOtpEmail(email, code) {
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: "Kode OTP Verifikasi - Chat & File Transfer App",
    text: `Kode OTP kamu: ${code}\n\nKode berlaku selama 5 menit. Jangan bagikan kode ini kepada siapa pun.`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto;">
        <h2 style="color:#0ea5e9; margin-bottom: 8px;">Verifikasi Email Kamu</h2>
        <p>Gunakan kode berikut untuk masuk ke Chat &amp; File Transfer App:</p>
        <p style="font-size: 28px; font-weight: bold; letter-spacing: 6px; color:#0f172a; background:#e2e8f0; padding: 14px 20px; display:inline-block; border-radius:8px;">${code}</p>
        <p style="margin-top: 12px; color:#475569; font-size: 13px;">Kode ini berlaku selama 5 menit. Jangan bagikan kode ini kepada siapa pun, termasuk pihak yang mengaku sebagai admin.</p>
      </div>
    `,
  });
}

// ==================== SETUP SERVER ====================
const app = express();
const server = http.createServer(app);

// Socket.io: naikkan buffer maksimum agar bisa menerima file (default socket.io hanya 1MB)
const io = new Server(server, {
  maxHttpBufferSize: MAX_FILE_SIZE + 5 * 1024 * 1024,
  cors: { origin: "*" },
});

// Sajikan file client (HTML/CSS/JS) secara statis
app.use(express.static(path.join(__dirname, "public")));
// Sajikan file yang sudah diupload agar bisa didownload lewat browser
app.use("/uploads", express.static(UPLOAD_DIR));

// Menyimpan daftar user yang sedang online: { socketId: username }
const onlineUsers = {};

// ==================== LOGIKA KOMUNIKASI SOCKET.IO ====================
io.on("connection", (socket) => {
  console.log(`[KONEKSI BARU] Client terhubung -> id: ${socket.id}`);

  // --- 1a. Event: minta kode OTP dikirim ke email ---
  socket.on("request_otp", async (data, callback) => {
    try {
      const email = data && data.email ? String(data.email).trim().toLowerCase() : "";

      if (!isValidEmail(email)) {
        if (typeof callback === "function") {
          callback({ success: false, message: "Format email tidak valid." });
        }
        return;
      }

      // Cegah spam kirim ulang sebelum jeda cooldown selesai
      const existing = otpStore[socket.id];
      if (existing && Date.now() - existing.lastSentAt < OTP_RESEND_COOLDOWN_MS) {
        const sisaDetik = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - existing.lastSentAt)) / 1000);
        if (typeof callback === "function") {
          callback({ success: false, message: `Tunggu ${sisaDetik} detik sebelum meminta kode baru.` });
        }
        return;
      }

      const code = generateOtpCode();
      otpStore[socket.id] = {
        email,
        code,
        expiresAt: Date.now() + OTP_EXPIRY_MS,
        attempts: 0,
        lastSentAt: Date.now(),
      };

      await sendOtpEmail(email, code);

      console.log(`[OTP] Kode terkirim ke ${email} (socket ${socket.id})`);
      if (typeof callback === "function") {
        callback({ success: true, message: `Kode OTP telah dikirim ke ${email}.` });
      }
    } catch (err) {
      console.error("[ERROR request_otp]", err.message);
      delete otpStore[socket.id];
      if (typeof callback === "function") {
        callback({
          success: false,
          message: "Gagal mengirim email OTP. Periksa kembali konfigurasi SMTP server.",
        });
      }
    }
  });

  // --- 1b. Event: verifikasi kode OTP yang dimasukkan user ---
  socket.on("verify_otp", (data, callback) => {
    try {
      const inputCode = data && data.code ? String(data.code).trim() : "";
      const record = otpStore[socket.id];

      if (!record) {
        if (typeof callback === "function") {
          callback({ success: false, message: "Belum ada kode OTP yang diminta. Silakan minta kode terlebih dahulu." });
        }
        return;
      }

      if (Date.now() > record.expiresAt) {
        delete otpStore[socket.id];
        if (typeof callback === "function") {
          callback({ success: false, message: "Kode OTP sudah kedaluwarsa. Silakan minta kode baru." });
        }
        return;
      }

      record.attempts += 1;
      if (record.attempts > OTP_MAX_ATTEMPTS) {
        delete otpStore[socket.id];
        if (typeof callback === "function") {
          callback({ success: false, message: "Terlalu banyak percobaan gagal. Silakan minta kode baru." });
        }
        return;
      }

      if (inputCode !== record.code) {
        if (typeof callback === "function") {
          callback({
            success: false,
            message: `Kode OTP salah. Sisa percobaan: ${OTP_MAX_ATTEMPTS - record.attempts}.`,
          });
        }
        return;
      }

      // Kode benar -> tandai socket ini sudah terverifikasi
      verifiedSockets[socket.id] = record.email;
      delete otpStore[socket.id];

      console.log(`[OTP] ${record.email} berhasil diverifikasi (socket ${socket.id})`);
      if (typeof callback === "function") {
        callback({ success: true, message: "Verifikasi berhasil." });
      }
    } catch (err) {
      console.error("[ERROR verify_otp]", err.message);
      if (typeof callback === "function") {
        callback({ success: false, message: "Terjadi kesalahan saat verifikasi." });
      }
    }
  });

  // --- 2. Event: user bergabung ke chat room ---
  socket.on("join", (username) => {
    try {
      // Wajib sudah lolos verifikasi OTP sebelum boleh bergabung ke chat
      if (!verifiedSockets[socket.id]) {
        socket.emit("error_message", "Email kamu belum terverifikasi. Silakan verifikasi kode OTP terlebih dahulu.");
        return;
      }

      if (!username || typeof username !== "string" || username.trim() === "") {
        // Validasi input, kirim error khusus ke client ini saja
        socket.emit("error_message", "Username tidak valid.");
        return;
      }

      username = username.trim().substring(0, 20); // batasi panjang username
      onlineUsers[socket.id] = username;

      // Beritahu semua client (broadcast) bahwa ada user baru bergabung
      io.emit("system_message", `${username} bergabung ke dalam chat.`);
      // Kirim daftar user online terbaru ke semua client
      io.emit("user_list", Object.values(onlineUsers));

      console.log(`[JOIN] ${username} (${socket.id}) bergabung.`);
    } catch (err) {
      console.error("[ERROR join]", err.message);
      socket.emit("error_message", "Terjadi kesalahan saat bergabung ke chat.");
    }
  });

  // --- 3. Event: menerima pesan chat teks dari client ---
  socket.on("chat_message", (data) => {
    try {
      const username = onlineUsers[socket.id] || "Anonim";

      if (!data || !data.message || data.message.trim() === "") {
        socket.emit("error_message", "Pesan tidak boleh kosong.");
        return;
      }

      const payload = {
        username,
        message: data.message.trim(),
        timestamp: new Date().toISOString(),
      };

      // Broadcast pesan ke SEMUA client termasuk pengirim
      io.emit("chat_message", payload);
      console.log(`[CHAT] ${username}: ${data.message}`);
    } catch (err) {
      console.error("[ERROR chat_message]", err.message);
      socket.emit("error_message", "Pesan gagal dikirim karena kesalahan server.");
    }
  });

  // --- 4. Event: menerima file dari client ---
  socket.on("file_upload", (data, callback) => {
    // data = { fileName, fileType, fileSize, fileData (base64) }
    try {
      const username = onlineUsers[socket.id] || "Anonim";

      if (!data || !data.fileData || !data.fileName) {
        throw new Error("Data file tidak lengkap.");
      }

      if (data.fileSize > MAX_FILE_SIZE) {
        throw new Error(`Ukuran file melebihi batas maksimum (${MAX_FILE_SIZE / 1024 / 1024} MB).`);
      }

      // Buat nama file unik agar tidak bentrok antar user
      const safeName = data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
      const uniqueName = `${Date.now()}-${safeName}`;
      const filePath = path.join(UPLOAD_DIR, uniqueName);

      // Ubah data base64 menjadi buffer biner, lalu simpan ke disk
      const buffer = Buffer.from(data.fileData, "base64");
      fs.writeFile(filePath, buffer, (err) => {
        if (err) {
          console.error("[ERROR simpan file]", err.message);
          // callback mengembalikan status kegagalan ke client pengirim
          if (typeof callback === "function") {
            callback({ success: false, message: "Server gagal menyimpan file." });
          }
          socket.emit("error_message", "Gagal menyimpan file di server.");
          return;
        }

        console.log(`[FILE] ${username} mengirim file: ${uniqueName} (${data.fileSize} bytes)`);

        // Broadcast informasi file (bukan isi file) ke semua client sebagai pesan chat
        io.emit("file_message", {
          username,
          fileName: data.fileName,
          fileType: data.fileType || "",
          fileUrl: `/uploads/${uniqueName}`,
          fileSize: data.fileSize,
          timestamp: new Date().toISOString(),
        });

        // Beritahu client pengirim bahwa upload berhasil
        if (typeof callback === "function") {
          callback({ success: true, message: "File berhasil dikirim." });
        }
      });
    } catch (err) {
      console.error("[ERROR file_upload]", err.message);
      if (typeof callback === "function") {
        callback({ success: false, message: err.message });
      }
      socket.emit("error_message", `Gagal mengirim file: ${err.message}`);
    }
  });

  // --- 5. Event: penanganan error socket bawaan ---
  socket.on("error", (err) => {
    console.error(`[SOCKET ERROR] id: ${socket.id} ->`, err.message);
  });

  // --- 6. Event: client terputus / disconnect ---
  socket.on("disconnect", (reason) => {
    const username = onlineUsers[socket.id];

    // Bersihkan data OTP/verifikasi milik socket ini agar tidak menumpuk di memori
    delete otpStore[socket.id];
    delete verifiedSockets[socket.id];

    if (username) {
      io.emit("system_message", `${username} keluar dari chat.`);
      delete onlineUsers[socket.id];
      io.emit("user_list", Object.values(onlineUsers));
      console.log(`[DISCONNECT] ${username} (${socket.id}) terputus. Alasan: ${reason}`);
    } else {
      console.log(`[DISCONNECT] ${socket.id} terputus sebelum join. Alasan: ${reason}`);
    }
  });
});

// ==================== ERROR HANDLING GLOBAL ====================
server.on("error", (err) => {
  console.error("[SERVER ERROR]", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

// ==================== JALANKAN SERVER ====================
server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(` Server Chat & File Transfer berjalan`);
  console.log(` Alamat lokal   : http://localhost:${PORT}`);
  console.log(` Alamat jaringan: http://<IP-Address-server>:${PORT}`);
  console.log(`=================================================`);
});
