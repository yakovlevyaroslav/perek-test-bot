// bot.js
// Node.js Telegram bot: анкета (согласие → ФИО → телефон → Telegram → фото),
// сохранение данных в Google Sheets + сохранение фото на сервер (uploads/) и запись photo_url.
//
// UX-улучшения:
// - ФИО проверяется: ровно 3 слова (Фамилия Имя Отчество)
// - Telegram подтверждается кнопками (если у пользователя есть @username)
// - Кнопки "🚀 Старт" и "🔄 Начать заново" (reply keyboard) — не нужно писать /start
// - Inline-кнопка "🔄 Заполнить заново" после успешной регистрации
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

// ---- ensure uploads dir exists ----
const uploadsAbsPath = path.join(__dirname, UPLOAD_DIR);
if (!fs.existsSync(uploadsAbsPath)) fs.mkdirSync(uploadsAbsPath, { recursive: true });

// ---- Public file server for uploads ----
const app = express();
app.use("/uploads", express.static(uploadsAbsPath));
app.get("/health", (req, res) => res.send("ok"));

app.listen(PUBLIC_PORT, "0.0.0.0", () => {
  console.log(`Public server listening on port ${PUBLIC_PORT}`);
  console.log(`Health check: ${PUBLIC_BASE_URL}/health`);
  console.log(`Uploads served at: ${PUBLIC_BASE_URL}/uploads/...`);
});

// ---- helpers ----
const nowIso = () => new Date().toISOString();

const normalizePhone = (text) => {
  const t = String(text || "").trim().replace(/\s+/g, "").replace(/-/g, "");
  if (!/^\+?\d{10,15}$/.test(t)) return null;
  return t;
};

const normalizeTg = (text) => {
  let t = String(text || "").trim();
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

// ---- keyboards ----
function mainMenuKeyboard() {
  return {
    keyboard: [[{ text: "🚀 Старт" }, { text: "🔄 Начать заново" }]],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
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

function telegramConfirmKeyboard(suggested) {
  return {
    inline_keyboard: [
      [{ text: `✅ Да, это мой Telegram (${suggested})`, callback_data: "tg_confirm_yes" }],
      [{ text: "✏️ Ввести другой", callback_data: "tg_confirm_other" }],
    ],
  };
}

function restartInlineKeyboard() {
  return {
    inline_keyboard: [[{ text: "🔄 Заполнить заново", callback_data: "restart_form" }]],
  };
}

// ---- session helpers ----
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

async function beginForm(chatId, userId) {
  // сброс
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

  // меню (reply keyboard)
  await bot.sendMessage(chatId, "Выберите действие:", {
    reply_markup: mainMenuKeyboard(),
  });

  const text =
    "Привет! Заполните анкету участника.\n\n" +
    `Перед началом ознакомьтесь с согласием на обработку персональных данных:\n${CONSENT_URL}\n\n` +
    "Чтобы продолжить — поставьте галочку согласия.";

  // inline keyboard (галочка) отдельным сообщением
  await bot.sendMessage(chatId, text, {
    reply_markup: consentKeyboard(false),
    disable_web_page_preview: true,
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
  await sheet.loadHeaderRow(); // важно для addRow(object)

  console.log("Connected to spreadsheet:", doc.title);
  console.log("Using sheet:", sheet.title);

  return sheet;
}

const sheetPromise = initSheet();

// ---- Telegram bot init ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---- /start and /reset ----
bot.onText(/\/start/, async (msg) => {
  await beginForm(msg.chat.id, msg.from.id);
});

bot.onText(/\/reset/, async (msg) => {
  sessions.delete(msg.from.id);
  await bot.sendMessage(msg.chat.id, "Анкета сброшена. Нажмите «🚀 Старт» или напишите /start.", {
    reply_markup: mainMenuKeyboard(),
  });
});

// ---- inline callbacks (consent / telegram confirm / restart) ----
bot.on("callback_query", async (q) => {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const messageId = q.message.message_id;

  const s = getSession(userId);
  if (!s) {
    await bot.answerCallbackQuery(q.id, { text: "Нажмите /start или кнопку «🚀 Старт»" });
    return;
  }

  // согласие
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
    await bot.sendMessage(chatId, "Введите ФИО в формате: Фамилия Имя Отчество (3 слова).\nПример: Иванов Иван Иванович");
    await bot.answerCallbackQuery(q.id);
    return;
  }

  // подтверждение Telegram
  if (q.data === "tg_confirm_yes") {
    if (!s.suggested_tg) {
      setSession(userId, { step: "telegram" });
      await bot.sendMessage(chatId, "Не удалось определить username. Введите Telegram вручную: @username или t.me/username");
      await bot.answerCallbackQuery(q.id, { text: "Введите вручную" });
      return;
    }

    setSession(userId, { telegram: s.suggested_tg, step: "photo" });
    await bot.sendMessage(chatId, "Отправьте вашу фотографию (как фото, не как файл):");
    await bot.answerCallbackQuery(q.id, { text: "Telegram подтверждён" });
    return;
  }

  if (q.data === "tg_confirm_other") {
    setSession(userId, { step: "telegram" });
    await bot.sendMessage(chatId, "Ок! Введите Telegram username в формате @username (или ссылку t.me/username):");
    await bot.answerCallbackQuery(q.id);
    return;
  }

  // заполнить заново
  if (q.data === "restart_form") {
    await bot.answerCallbackQuery(q.id);
    await beginForm(chatId, userId);
    return;
  }

  await bot.answerCallbackQuery(q.id);
});

// ---- messages (шаги анкеты + кнопки меню) ----
bot.on("message", async (msg) => {
  // игнорируем команды
  if (msg.text && msg.text.startsWith("/")) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const txt = (msg.text || "").trim();

  // кнопки меню (reply keyboard)
  if (txt === "🚀 Старт" || txt === "🔄 Начать заново") {
    await beginForm(chatId, userId);
    return;
  }

  const s = getSession(userId);
  if (!s) return; // пользователь не начинал

  // шаг: full_name (ровно 3 слова)
  if (s.step === "full_name") {
    const fullNameRaw = String(msg.text || "").trim();
    const parts = fullNameRaw.split(/\s+/).filter(Boolean);

    if (parts.length !== 3) {
      await bot.sendMessage(
        chatId,
        "Пожалуйста, введите ФИО в формате: Фамилия Имя Отчество (3 слова).\nПример: Иванов Иван Иванович"
      );
      return;
    }

    const fullName = parts.join(" ");
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
      await bot.sendMessage(chatId, `Я нашёл ваш Telegram: ${username}\nПодтвердите, пожалуйста:`, {
        reply_markup: telegramConfirmKeyboard(username),
      });
    } else {
      await bot.sendMessage(chatId, "Введите ваш Telegram username в формате @username (или ссылку t.me/username):");
    }
    return;
  }

  // шаг: telegram (ручной ввод)
  if (s.step === "telegram") {
    const tg = normalizeTg(msg.text);
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

    const biggest = photos[photos.length - 1];
    const photoFileId = biggest.file_id;

    try {
      // 1) file_path
      const fileInfo = await bot.getFile(photoFileId);
      const filePath = fileInfo.file_path; // e.g. photos/file_123.jpg

      // 2) Telegram download url
      const tgDownloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

      // 3) filename on server
      const ext = path.extname(filePath) || ".jpg";
      const fileName = safeFileName(`${userId}_${Date.now()}${ext}`);

      // 4) save to uploads/
      const localPath = path.join(uploadsAbsPath, fileName);
      await downloadToFile(tgDownloadUrl, localPath);

      // 5) public url
      const photoUrl = `${PUBLIC_BASE_URL}/uploads/${encodeURIComponent(fileName)}`;

      // 6) write to Google Sheet
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
          "Пожалуйста, ожидайте сообщения.",
        {
          reply_markup: restartInlineKeyboard(),
        }
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