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
const GOOGLE_CREDS = process.env.GOOGLE_CREDS || "service_account.json";
const ACCESS_PASSWORD = process.env.BOT_PASSWORD || "shkaf2026";
const ADMIN_USER_IDS = new Set(
  String(process.env.ADMIN_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 3000);
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";

if (!BOT_TOKEN || !SHEET_ID) {
  throw new Error("Заполните .env: BOT_TOKEN, SHEET_ID");
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

function safeFileName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isAdmin(userId) {
  return ADMIN_USER_IDS.has(String(userId));
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

const SHEET_HEADERS = [
  "created_at",
  "user_id",
  "main_category",
  "sub_category_1",
  "sub_category_2",
  "sub_category_3",
  "sub_category_4",
  "category_path",
  "photo_file_id",
  "photo_url",
];

const MAIN_CATEGORY_TO_SHEET = {
  верх: "верх",
  тело: "тело",
  низ: "низ",
};

// ---- keyboards ----
function mainMenuKeyboard(userId) {
  const row = [{ text: "🚀 Старт" }, { text: "🔄 Начать заново" }];
  if (isAdmin(userId)) {
    row.push({ text: "📊 Статистика" });
  }

  return {
    keyboard: [row],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

function restartInlineKeyboard() {
  return {
    inline_keyboard: [[{ text: "➕ Добавить еще вещь", callback_data: "restart_form" }]],
  };
}

function mainCategoryKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Верх", callback_data: "cat_main_upper" }],
      [{ text: "Тело", callback_data: "cat_main_body" }],
      [{ text: "Низ", callback_data: "cat_main_lower" }],
    ],
  };
}

function upperSeasonKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Летний головной убор", callback_data: "cat_upper_summer" }],
      [{ text: "Зимний головной убор", callback_data: "cat_upper_winter" }],
      [{ text: "Осенне-весенний головной убор", callback_data: "cat_upper_midseason" }],
    ],
  };
}

function bodyWarmthKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Легкая вещь", callback_data: "cat_body_light" }],
      [{ text: "Теплая вещь", callback_data: "cat_body_warm" }],
    ],
  };
}

function bodyLightTypeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Футболка", callback_data: "cat_body_light_tshirt" }],
      [{ text: "Кофта", callback_data: "cat_body_light_sweater" }],
      [{ text: "Рубашка", callback_data: "cat_body_light_shirt" }],
      [{ text: "Легкая куртка", callback_data: "cat_body_light_jacket" }],
    ],
  };
}

function bodyWarmTypeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Куртка зимняя", callback_data: "cat_body_warm_winter_jacket" }],
      [{ text: "Куртка легкая", callback_data: "cat_body_warm_light_jacket" }],
      [{ text: "Теплая кофта", callback_data: "cat_body_warm_sweater" }],
    ],
  };
}

function lowerTypeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Штаны", callback_data: "cat_lower_pants" }],
      [{ text: "Обувь", callback_data: "cat_lower_shoes" }],
    ],
  };
}

function pantsLengthKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Короткие штаны", callback_data: "cat_pants_short" }],
      [{ text: "Длинные штаны", callback_data: "cat_pants_long" }],
    ],
  };
}

function shortPantsTypeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Шорты для спорта", callback_data: "cat_pants_short_sport" }],
      [{ text: "Шорты для плавания", callback_data: "cat_pants_short_swim" }],
      [{ text: "Шорты для прогулок", callback_data: "cat_pants_short_walk" }],
    ],
  };
}

function longPantsTypeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Штаны для спорта", callback_data: "cat_pants_long_sport" }],
      [{ text: "Джинсы", callback_data: "cat_pants_long_jeans" }],
      [{ text: "Штаны для прогулок", callback_data: "cat_pants_long_walk" }],
      [{ text: "Теплые штаны", callback_data: "cat_pants_long_warm" }],
    ],
  };
}

function shoesTypeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Зимняя обувь", callback_data: "cat_shoes_winter" }],
      [{ text: "Спортивная обувь", callback_data: "cat_shoes_sport" }],
      [{ text: "Легкая обувь", callback_data: "cat_shoes_light" }],
      [{ text: "Кроксы", callback_data: "cat_shoes_crocs" }],
      [{ text: "Тапочки", callback_data: "cat_shoes_slippers" }],
    ],
  };
}

// ---- session helpers ----
const sessions = new Map();
/**
 * session shape:
 * {
 *   step: "password"|"photo"|"main_category"|"upper_season"|"body_warmth"|"body_light_type"|"body_warm_type"|
 *         "lower_type"|"pants_length"|"pants_short_type"|"pants_long_type"|"shoes_type",
 *   authenticated: boolean,
 *   photo_file_id: string,
 *   photo_url: string,
 *   main_category: "верх"|"тело"|"низ"|"",
 *   sub_categories: string[]
 * }
 */
function setSession(userId, patch) {
  const prev = sessions.get(userId) || {};
  sessions.set(userId, { ...prev, ...patch });
}

function getSession(userId) {
  return sessions.get(userId);
}

function resetItemState(userId) {
  setSession(userId, {
    step: "photo",
    photo_file_id: "",
    photo_url: "",
    main_category: "",
    sub_categories: [],
  });
}

async function beginFlow(chatId, userId) {
  sessions.delete(userId);
  setSession(userId, {
    step: "password",
    authenticated: false,
    photo_file_id: "",
    photo_url: "",
    main_category: "",
    sub_categories: [],
  });

  await bot.sendMessage(chatId, "Выберите действие:", {
    reply_markup: mainMenuKeyboard(userId),
  });
  await bot.sendMessage(chatId, "Введите пароль для доступа к персональному гардеробу:");
}

async function askForMainCategory(chatId) {
  await bot.sendMessage(chatId, "Выберите основную категорию вещи:", {
    reply_markup: mainCategoryKeyboard(),
  });
}

// ---- Google Sheets init ----
async function initDoc() {
  const credsRaw = fs.readFileSync(GOOGLE_CREDS, "utf8");
  const creds = JSON.parse(credsRaw);
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];

  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes,
  });

  const doc = new GoogleSpreadsheet(SHEET_ID, jwt);
  await doc.loadInfo();

  console.log("Connected to spreadsheet:", doc.title);
  return doc;
}

async function ensureSheetHeaders(sheet) {
  try {
    await sheet.loadHeaderRow();
  } catch {
    await sheet.setHeaderRow(SHEET_HEADERS);
    return;
  }

  const existing = sheet.headerValues || [];
  const hasAllHeaders = SHEET_HEADERS.every((h) => existing.includes(h));
  if (!hasAllHeaders) {
    await sheet.setHeaderRow(SHEET_HEADERS);
  }
}

async function getCategorySheet(mainCategory) {
  const title = MAIN_CATEGORY_TO_SHEET[mainCategory];
  if (!title) {
    throw new Error(`Unknown main category: ${mainCategory}`);
  }

  const doc = await docPromise;
  await doc.loadInfo();

  let sheet = doc.sheetsByTitle[title];
  if (!sheet) {
    sheet = await doc.addSheet({ title, headerValues: SHEET_HEADERS });
  } else {
    await ensureSheetHeaders(sheet);
  }

  return sheet;
}

async function countRowsInSheet(sheet) {
  const pageSize = 500;
  let offset = 0;
  let total = 0;

  while (true) {
    const rows = await sheet.getRows({ offset, limit: pageSize });
    total += rows.length;

    if (rows.length < pageSize) {
      break;
    }
    offset += pageSize;
  }

  return total;
}

async function buildStats() {
  const doc = await docPromise;
  await doc.loadInfo();

  const categories = Object.entries(MAIN_CATEGORY_TO_SHEET);
  const counts = {};
  let total = 0;

  for (const [key, sheetTitle] of categories) {
    const sheet = doc.sheetsByTitle[sheetTitle];
    const count = sheet ? await countRowsInSheet(sheet) : 0;
    counts[key] = count;
    total += count;
  }

  return {
    counts,
    total,
  };
}

async function handleStatsRequest(chatId, userId) {
  if (ADMIN_USER_IDS.size === 0) {
    await bot.sendMessage(chatId, "Команда /stats не настроена. Добавьте ADMIN_USER_IDS в .env.");
    return;
  }

  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, "⛔️ У вас нет доступа к админ-статистике.");
    return;
  }

  try {
    const { counts, total } = await buildStats();
    const text =
      "📊 Статистика гардероба\n\n" +
      `Верх: ${counts.верх || 0}\n` +
      `Тело: ${counts.тело || 0}\n` +
      `Низ: ${counts.низ || 0}\n\n` +
      `Итого: ${total}`;

    await bot.sendMessage(chatId, text);
  } catch (err) {
    console.error("STATS ERROR:", err);
    await bot.sendMessage(chatId, "❌ Не удалось получить статистику. Попробуйте позже.");
  }
}

async function saveWardrobeItem(userId, session) {
  const sheet = await getCategorySheet(session.main_category);
  const [sub1 = "", sub2 = "", sub3 = "", sub4 = ""] = session.sub_categories || [];
  const categoryPath = [session.main_category, ...session.sub_categories].filter(Boolean).join(" > ");
  const photoFormula = `=IMAGE("${session.photo_url}")`;

  await sheet.addRow({
    created_at: nowIso(),
    user_id: String(userId),
    main_category: session.main_category,
    sub_category_1: sub1,
    sub_category_2: sub2,
    sub_category_3: sub3,
    sub_category_4: sub4,
    category_path: categoryPath,
    photo_file_id: session.photo_file_id,
    photo_url: photoFormula,
  });
}

async function finalizeCategory(chatId, userId, mainCategory, subCategories) {
  const session = getSession(userId);
  if (!session || !session.photo_file_id || !session.photo_url) {
    await bot.sendMessage(chatId, "Сначала отправьте фото вещи.");
    return;
  }

  setSession(userId, { main_category: mainCategory, sub_categories: subCategories });
  const updated = getSession(userId);
  const categoryPath = [mainCategory, ...subCategories].join(" > ");

  await saveWardrobeItem(userId, updated);

  await bot.sendMessage(
    chatId,
    `✅ Вещь сохранена.\n\nКатегория: ${categoryPath}\nФото: ${updated.photo_url}`,
    { reply_markup: restartInlineKeyboard() }
  );

  resetItemState(userId);
}

const docPromise = initDoc();

// ---- Telegram bot init ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---- /start and /reset ----
bot.onText(/\/start/, async (msg) => {
  await beginFlow(msg.chat.id, msg.from.id);
});

bot.onText(/\/reset/, async (msg) => {
  sessions.delete(msg.from.id);
  await bot.sendMessage(msg.chat.id, "Сессия сброшена. Нажмите «🚀 Старт» или напишите /start.", {
    reply_markup: mainMenuKeyboard(msg.from.id),
  });
});

bot.onText(/^\/stats(?:@\w+)?$/, async (msg) => {
  await handleStatsRequest(msg.chat.id, msg.from.id);
});

// ---- inline callbacks ----
bot.on("callback_query", async (q) => {
  const userId = q.from.id;
  const chatId = q.message.chat.id;
  const data = q.data || "";

  const s = getSession(userId);
  if (!s) {
    await bot.answerCallbackQuery(q.id, { text: "Нажмите /start или кнопку «🚀 Старт»" });
    return;
  }

  if (!s.authenticated) {
    await bot.answerCallbackQuery(q.id, { text: "Сначала введите пароль", show_alert: true });
    return;
  }

  try {
    if (data === "restart_form") {
      resetItemState(userId);
      await bot.sendMessage(chatId, "Отправьте следующую вещь (как фото, не как файл):");
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_main_upper") {
      setSession(userId, { step: "upper_season", main_category: "верх", sub_categories: [] });
      await bot.sendMessage(chatId, "Выберите категорию для верха:", { reply_markup: upperSeasonKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_main_body") {
      setSession(userId, { step: "body_warmth", main_category: "тело", sub_categories: [] });
      await bot.sendMessage(chatId, "Выберите тип вещи для тела:", { reply_markup: bodyWarmthKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_main_lower") {
      setSession(userId, { step: "lower_type", main_category: "низ", sub_categories: [] });
      await bot.sendMessage(chatId, "Выберите: штаны или обувь:", { reply_markup: lowerTypeKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_upper_summer") {
      await finalizeCategory(chatId, userId, "верх", ["головной убор", "летний"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_upper_winter") {
      await finalizeCategory(chatId, userId, "верх", ["головной убор", "зимний"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_upper_midseason") {
      await finalizeCategory(chatId, userId, "верх", ["головной убор", "осенне-весенний"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_body_light") {
      setSession(userId, { step: "body_light_type", main_category: "тело", sub_categories: ["легкая вещь"] });
      await bot.sendMessage(chatId, "Выберите категорию легкой вещи:", { reply_markup: bodyLightTypeKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_body_warm") {
      setSession(userId, { step: "body_warm_type", main_category: "тело", sub_categories: ["теплая вещь"] });
      await bot.sendMessage(chatId, "Выберите категорию теплой вещи:", { reply_markup: bodyWarmTypeKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_body_light_tshirt") {
      await finalizeCategory(chatId, userId, "тело", ["легкая вещь", "футболка"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_body_light_sweater") {
      await finalizeCategory(chatId, userId, "тело", ["легкая вещь", "кофта"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_body_light_shirt") {
      await finalizeCategory(chatId, userId, "тело", ["легкая вещь", "рубашка"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_body_light_jacket") {
      await finalizeCategory(chatId, userId, "тело", ["легкая вещь", "легкая куртка"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_body_warm_winter_jacket") {
      await finalizeCategory(chatId, userId, "тело", ["теплая вещь", "куртка зимняя"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_body_warm_light_jacket") {
      await finalizeCategory(chatId, userId, "тело", ["теплая вещь", "куртка легкая"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_body_warm_sweater") {
      await finalizeCategory(chatId, userId, "тело", ["теплая вещь", "теплая кофта"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_lower_pants") {
      setSession(userId, { step: "pants_length", main_category: "низ", sub_categories: ["штаны"] });
      await bot.sendMessage(chatId, "Выберите длину штанов:", { reply_markup: pantsLengthKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_lower_shoes") {
      setSession(userId, { step: "shoes_type", main_category: "низ", sub_categories: ["обувь"] });
      await bot.sendMessage(chatId, "Выберите тип обуви:", { reply_markup: shoesTypeKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_pants_short") {
      setSession(userId, { step: "pants_short_type", main_category: "низ", sub_categories: ["штаны", "короткие штаны"] });
      await bot.sendMessage(chatId, "Выберите категорию коротких штанов:", { reply_markup: shortPantsTypeKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_pants_long") {
      setSession(userId, { step: "pants_long_type", main_category: "низ", sub_categories: ["штаны", "длинные штаны"] });
      await bot.sendMessage(chatId, "Выберите категорию длинных штанов:", { reply_markup: longPantsTypeKeyboard() });
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_pants_short_sport") {
      await finalizeCategory(chatId, userId, "низ", ["штаны", "короткие штаны", "шорты для спорта"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_pants_short_swim") {
      await finalizeCategory(chatId, userId, "низ", ["штаны", "короткие штаны", "шорты для плавания"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_pants_short_walk") {
      await finalizeCategory(chatId, userId, "низ", ["штаны", "короткие штаны", "шорты для прогулок"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_pants_long_sport") {
      await finalizeCategory(chatId, userId, "низ", ["штаны", "длинные штаны", "штаны для спорта"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_pants_long_jeans") {
      await finalizeCategory(chatId, userId, "низ", ["штаны", "длинные штаны", "джинсы"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_pants_long_walk") {
      await finalizeCategory(chatId, userId, "низ", ["штаны", "длинные штаны", "штаны для прогулок"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_pants_long_warm") {
      await finalizeCategory(chatId, userId, "низ", ["штаны", "длинные штаны", "теплые штаны"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    if (data === "cat_shoes_winter") {
      await finalizeCategory(chatId, userId, "низ", ["обувь", "зимняя обувь"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_shoes_sport") {
      await finalizeCategory(chatId, userId, "низ", ["обувь", "спортивная обувь"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_shoes_light") {
      await finalizeCategory(chatId, userId, "низ", ["обувь", "легкая обувь"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_shoes_crocs") {
      await finalizeCategory(chatId, userId, "низ", ["обувь", "кроксы"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }
    if (data === "cat_shoes_slippers") {
      await finalizeCategory(chatId, userId, "низ", ["обувь", "тапочки"]);
      await bot.answerCallbackQuery(q.id);
      return;
    }

    await bot.answerCallbackQuery(q.id);
  } catch (err) {
    console.error("CALLBACK ERROR:", err);
    await bot.answerCallbackQuery(q.id, { text: "Ошибка при обработке выбора", show_alert: true });
    await bot.sendMessage(chatId, "❌ Не удалось сохранить категорию. Попробуйте выбрать снова.");
  }
});

// ---- messages ----
bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const txt = (msg.text || "").trim();

  if (txt === "🚀 Старт" || txt === "🔄 Начать заново") {
    await beginFlow(chatId, userId);
    return;
  }
  if (txt === "📊 Статистика") {
    await handleStatsRequest(chatId, userId);
    return;
  }

  const s = getSession(userId);
  if (!s) return;

  if (s.step === "password") {
    if (txt !== ACCESS_PASSWORD) {
      await bot.sendMessage(chatId, "Неверный пароль. Попробуйте еще раз.");
      return;
    }

    setSession(userId, { authenticated: true });
    resetItemState(userId);
    await bot.sendMessage(chatId, "Пароль верный ✅\nТеперь отправьте фото вещи (как фото, не как файл).");
    return;
  }

  if (!s.authenticated) {
    await bot.sendMessage(chatId, "Сначала введите пароль.");
    return;
  }

  if (s.step === "photo") {
    const photos = msg.photo;
    if (!photos || photos.length === 0) {
      await bot.sendMessage(chatId, "Пожалуйста, отправьте именно фото (не как файл/document).");
      return;
    }

    const biggest = photos[photos.length - 1];
    const photoFileId = biggest.file_id;

    try {
      const fileInfo = await bot.getFile(photoFileId);
      const filePath = fileInfo.file_path;
      const tgDownloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

      const ext = path.extname(filePath) || ".jpg";
      const fileName = safeFileName(`${userId}_${Date.now()}${ext}`);
      const localPath = path.join(uploadsAbsPath, fileName);
      await downloadToFile(tgDownloadUrl, localPath);

      const photoUrl = `${PUBLIC_BASE_URL}/uploads/${encodeURIComponent(fileName)}`;
      setSession(userId, {
        step: "main_category",
        photo_file_id: photoFileId,
        photo_url: photoUrl,
      });

      await bot.sendMessage(chatId, "Фото загружено ✅");
      await askForMainCategory(chatId);
      return;
    } catch (err) {
      console.error("PHOTO SAVE ERROR:", err);
      await bot.sendMessage(chatId, "❌ Не удалось сохранить фото. Попробуйте отправить фото еще раз.");
      return;
    }
  }

  const stepsWithButtons = new Set([
    "main_category",
    "upper_season",
    "body_warmth",
    "body_light_type",
    "body_warm_type",
    "lower_type",
    "pants_length",
    "pants_short_type",
    "pants_long_type",
    "shoes_type",
  ]);

  if (stepsWithButtons.has(s.step)) {
    await bot.sendMessage(chatId, "Выберите вариант с помощью кнопок ниже.");
  }
});