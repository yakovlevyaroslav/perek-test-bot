import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import fs from "fs";
import { GoogleSpreadsheet } from "google-spreadsheet";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const CONSENT_URL = process.env.CONSENT_URL;
const GOOGLE_CREDS = process.env.GOOGLE_CREDS || "service_account.json";

if (!BOT_TOKEN || !SHEET_ID || !CONSENT_URL) {
  throw new Error("Заполните .env: BOT_TOKEN, SHEET_ID, CONSENT_URL");
}

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

// ---- Google Sheets init ----
async function initSheet() {
  const credsRaw = fs.readFileSync(GOOGLE_CREDS, "utf8");
  const creds = JSON.parse(credsRaw);

  const doc = new GoogleSpreadsheet(SHEET_ID);

  await doc.useServiceAccountAuth({
    client_email: creds.client_email,
    private_key: creds.private_key,
  });

  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0]; // первый лист
  return sheet;
}

const sheetPromise = initSheet();

// ---- bot init ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// состояние пользователей (в памяти). Для продакшна лучше хранить в БД/Redis.
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
  // игнорируем /start (уже обработали)
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
      await bot.sendMessage(chatId, 'Введите ваш Telegram username в формате @username (или ссылку t.me/username):');
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
      await bot.sendMessage(chatId, "Пожалуйста, отправьте именно фото весов.");
      return;
    }

    // самое большое фото — последнее
    const biggest = photos[photos.length - 1];
    const photoFileId = biggest.file_id;

    // запись в таблицу
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
    };

    await sheet.addRow(row);

    await bot.sendMessage(chatId, "✅ Спасибо! Анкета заполнена и сохранена.");
    sessions.delete(userId);
    return;
  }
});