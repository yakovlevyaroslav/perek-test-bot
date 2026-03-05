// bot.js
// Node.js Telegram bot: анкета (согласие → ФИО → телефон → Telegram → фото),
// сохранение данных в Google Sheets + сохранение фото на сервер (uploads/) и запись photo_url.
//
// Требования по .env:
// BOT_TOKEN=...
// SHEET_ID=...
// CONSENT_URL=...
// GOOGLE_CREDS=service_account.json
// PUBLIC_BASE_URL=http://SERVER_IP:3000   (или https://your-domain)
// PUBLIC_PORT=3000
// UPLOAD_DIR=uploads
//
// В Google Sheets (первая строка) должны быть заголовки колонок:
// created_at,user_id,full_name,phone,telegram,consent,consent_at,photo_file_id,photo_url

import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import express from "express";
import https from "https";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

dotenv.config();

// ---- env ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const CONSENT_URL = process.env.CONSENT_URL;
const GOOGLE_CREDS = process.env.GOOGLE_CREDS || "service_account.json";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // например http://185.21.12.44:3000 или https://example.com
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 3000);
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";

if (!BOT_TOKEN || !SHEET_ID || !CONSENT_URL) {
  throw new Error("Заполните .env: BOT_TOKEN, SHEET_ID, CONSENT_URL");
}
if (!PUBLIC_BASE_URL) {
  throw new Error("Заполните .env: PUBLIC_BASE_URL (например http://SERVER_IP:3000 или https://example.com)");
}

// ---- paths ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Public file server for uploads ----
const app = express();
app.use("/uploads", express.static(path.join(__dirname, UPLOAD_DIR)));
app.get("/health", (req, res) => res.send("ok"));

app.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Public server listening on port ${PUBLIC_PORT}`);
  console.log(`Uploads served at: ${PUBLIC_BASE_URL}/uploads/...`);
});

// ---- helpers ----
const nowIso = () => new Date().toISOString();

const normalizePhone = (text) => {
  const t = String(text || "").trim().replace(/\s+/g, "").replace(/-/g, "");
  if (!/^\+?\d{10,15}$/.test(t)) return null;
  return t;
};

const normalizeTg = (text, suggested) => {
  const t0 = String(text || "").trim();

  if (suggested && ["да", "yes", "ok", "верно", "правильно"].includes(t0.toLowerCase())) {
    return suggested;
  }

  let t = t0;
  if (t.includes("t.me/")) t = t.split("t.me/").pop();
  if (t.startsWith("@")) t = t.slice(1);
  if (!/^[A-Za-z0-9_]{5,32}$/.test(t)) return null;
  return `@${t}`;
};

function safeFileName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function downloadToFile(url, destPath) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: ${res.statusCode}`));
          res.resume();
          return;
        }
        const fsStream = fs.createWriteStream(destPath);
        pipeline(res, fsStream).then(resolve).catch(reject);
      })
      .on("error", reject);
  });
}

// ---- Google Sheets init ----
async function initSheet() {
  const credsRaw = fs.readFileSync(GOOGLE_CREDS, "utf8");
  const creds = JSON.parse(credsRaw);

  const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: SCOPES,
  });

  const doc = new GoogleSpreadsheet(SHEET_ID, jwt);

  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0]; // первый лист

  // важно для addRow(object)
  await sheet.loadHeaderRow();

  console.log("Connected to spreadsheet:", doc.title);
  console.log("Using sheet:", sheet.title);

  return sheet;
}

const sheetPromise = initSheet();

// ---- Telegram bot init ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Состояние пользователей (в памяти). Для продакшна лучше Redis/DB.
const sessions = new Map();
/**
 * session shape:
 * {
 *   step: "consent"|"full_name"|"phone"|"telegram"|"photo",
 *   consent: boolean,
 *   consent_at: string|null,
 *   full_name: string,
 *   phone: string,
 *   telegram: string,
 *   suggested_tg: string|null
 * }
 */

function setSession(userId, patch) {
  const prev = sessions.get(userId) || {};
  sessions.set(userId, { ...prev, ...patch });
}

function getSession(userId) {
  return sessions.get(userId);
}

function consentKeyboard(checked) {
  if (checked) {
    return {
      inline_keyboard: [
        [{ text: "☑️ Я согласен на обработку ПДн", callback_data: "consent_toggle" }],
        [{ text: "✅ Продолжить", callback_data: "consent_continue" }],
      ],
    };
  }
  return {
    inline_keyboard: [[{ text: "☐ Я согласен на обработку ПДн", callback_data: "consent_toggle" }]],
  };
}

// ---- /start ----
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;

  // Всегда сбрасываем прошлую "незавершённую" анкету
  sessions.delete(userId);

  setSession(userId, {
    step: "consent",
    consent: false,
    consent_at: null,
    full_name: "",
    phone: "",
    telegram: "",
    suggested_tg: null,
  });

  const text =
    "Привет! Заполните анкету участника.\n\n" +
    `Перед началом ознакомьтесь с согласием на обработку персональных данных:\n${CONSENT_URL}\n\n` +
    "Чтобы продолжить — поставьте галочку согласия.";

  await bot.sendMessage(msg.chat.id, text, {
    reply_markup: consentKeyboard(false),
    disable_web_page_preview: true,
  });
});

// ---- /reset (на всякий случай) ----
bot.onText(/\/reset/, async (msg) => {
  const userId = msg.from.id;
  sessions.delete(userId);
  await bot.sendMessage(msg.chat.id, "Анкета сброшена. Напишите /start чтобы начать заново.");
});

// ---- inline callbacks (галочка/продолжить) ----
bot.on("callback_query", async (q) => {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;

  const s = getSession(userId);
  if (!s) {
    await bot.answerCallbackQuery(q.id, { text: "Нажмите /start" });
    return;
  }

  if (q.data === "consent_toggle") {
    const newValue = !s.consent;
    setSession(userId, { consent: newValue, consent_at: newValue ? nowIso() : null });

    await bot.editMessageReplyMarkup(consentKeyboard(newValue), {
      chat_id: chatId,
      message_id: messageId,
    });

    await bot.answerCallbackQuery(q.id, { text: newValue ? "Согласие принято" : "Согласие снято" });
    return;
  }

  if (q.data === "consent_continue") {
    if (!s.consent) {
      await bot.answerCallbackQuery(q.id, { text: "Нужно поставить галочку согласия.", show_alert: true });
      return;
    }

    setSession(userId, { step: "full_name" });
    await bot.sendMessage(chatId, "Введите ФИО (например: Иванов Иван Иванович):");
    await bot.answerCallbackQuery(q.id);
    return;
  }

  await bot.answerCallbackQuery(q.id);
});

// ---- messages (шаги анкеты) ----
bot.on("message", async (msg) => {
  // игнорируем команды
  if (msg.text && msg.text.startsWith("/")) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const s = getSession(userId);
  if (!s) return; // пользователь не делал /start

  // шаг: full_name
  if (s.step === "full_name") {
    const fullName = String(msg.text || "").trim();
    if (fullName.length < 5) {
      await bot.sendMessage(chatId, "ФИО слишком короткое. Введите полностью, пожалуйста.");
      return;
    }
    setSession(userId, { full_name: fullName, step: "phone" });
    await bot.sendMessage(chatId, "Введите телефон в формате +79991234567 (или 79991234567):");
    return;
  }

  // шаг: phone
  if (s.step === "phone") {
    const phone = normalizePhone(msg.text);
    if (!phone) {
      await bot.sendMessage(chatId, "Не похоже на номер. Пример: +79991234567");
      return;
    }

    const username = msg.from.username ? `@${msg.from.username}` : null;
    setSession(userId, {
      phone,
      step: "telegram",
      suggested_tg: username,
    });

    if (username) {
      await bot.sendMessage(
        chatId,
        `Ваш Telegram: ${username}\nЕсли верно — отправьте "да". Если нужно другой — отправьте @username или t.me/username`
      );
    } else {
      await bot.sendMessage(chatId, "Введите ваш Telegram username в формате @username (или ссылку t.me/username):");
    }
    return;
  }

  // шаг: telegram
  if (s.step === "telegram") {
    const tg = normalizeTg(msg.text, s.suggested_tg);
    if (!tg) {
      await bot.sendMessage(chatId, "Не удалось распознать username. Пример: @username или t.me/username");
      return;
    }

    setSession(userId, { telegram: tg, step: "photo" });
    await bot.sendMessage(chatId, "Отправьте вашу фотографию (как фото, не как файл):");
    return;
  }

  // шаг: photo
  if (s.step === "photo") {
    const photos = msg.photo;
    if (!photos || photos.length === 0) {
      await bot.sendMessage(chatId, "Пожалуйста, отправьте именно фото (не как файл/document).");
      return;
    }

    // самое большое фото — последнее
    const biggest = photos[photos.length - 1];
    const photoFileId = biggest.file_id;

    try {
      // 1) получить file_path
      const fileInfo = await bot.getFile(photoFileId);
      const filePath = fileInfo.file_path; // e.g. photos/file_123.jpg

      // 2) url скачивания из Telegram
      const tgDownloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

      // 3) подготовить имя файла на сервере
      const ext = path.extname(filePath) || ".jpg";
      const fileName = safeFileName(`${userId}_${Date.now()}${ext}`);

      // 4) сохранить в uploads/
      const saveDir = path.join(__dirname, UPLOAD_DIR);
      if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

      const localPath = path.join(saveDir, fileName);
      await downloadToFile(tgDownloadUrl, localPath);

      // 5) публичный URL для таблицы
      const photoUrl = `${PUBLIC_BASE_URL}/uploads/${encodeURIComponent(fileName)}`;

      // 6) запись в таблицу
      const sheet = await sheetPromise;

      const row = {
        created_at: nowIso(),
        user_id: String(userId),
        full_name: s.full_name,
        phone: s.phone,
        telegram: s.telegram,
        consent: s.consent ? "yes" : "no",
        consent_at: s.consent_at || "",
        photo_file_id: photoFileId,
        photo_url: photoUrl,
      };

      await sheet.addRow(row);

      await bot.sendMessage(
        chatId,
        "✅ Регистрация завершена!\n\n" +
          "Вы зарегистрированы как участник.\n\n" +
          "📞 В ближайшее время с вами свяжется организатор.\n" +
          "Пожалуйста, ожидайте сообщения."
      );

      sessions.delete(userId);
      return;
    } catch (err) {
      console.error("PHOTO SAVE ERROR:", err);
      await bot.sendMessage(chatId, "❌ Не удалось сохранить фото. Попробуйте отправить фото ещё раз.");
      return;
    }
  }
});