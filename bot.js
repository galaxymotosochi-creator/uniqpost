// Telegram-бот: уникализация видео (файл или ссылка)
// /root/videobot/bot.js  — под node-telegram-bot-api v2
require('dotenv').config();
const { Bot } = require('node-telegram-bot-api');
const { fromPath } = require('node-telegram-bot-api/node');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('BOT_TOKEN не задан'); process.exit(1); }

const TMP = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const MAX_MB = 50;
const bot = new Bot(TOKEN);

// ── утилиты ────────────────────────────────────────────────────────────────
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 64, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().slice(0, 400)));
      else resolve(stdout);
    });
  });
}
function randHex(n) { return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join(''); }
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const f = fs.createWriteStream(dest);
    mod.get(url, res => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      res.pipe(f); f.on('finish', () => f.close(resolve));
    }).on('error', reject);
  });
}

// ── уникализация через FFmpeg ──────────────────────────────────────────────
async function uniquify(input, output, strength = 'medium') {
  const speed = 1 + (Math.random() * 0.02 - 0.01);
  const bright = (Math.random() * 0.06 - 0.03).toFixed(4);
  const contrast = (1 + Math.random() * 0.05 - 0.025).toFixed(4);
  const sat = (1 + Math.random() * 0.06 - 0.03).toFixed(4);
  const noise = strength === 'strong' ? 8 : strength === 'light' ? 2 : 4;
  const volDb = (Math.random() * 2 - 1).toFixed(2);

  const vf = [
    `setpts=${(1 / speed).toFixed(6)}*PTS`,
    `eq=brightness=${bright}:contrast=${contrast}:saturation=${sat}`,
    `noise=alls=${noise}:allf=t+u`,
    `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    `format=yuv420p`,
  ].join(',');

  await run('ffmpeg', [
    '-y', '-i', input,
    '-vf', vf,
    '-af', `volume=${volDb}dB,asetrate=44100*${speed.toFixed(4)},aresample=44100`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    '-map_metadata', '-1',
    '-metadata', 'encoder=' + randHex(12),
    output,
  ]);
  return output;
}

// ── тексты ─────────────────────────────────────────────────────────────────
const HELP =
  '👋 Бот уникализации видео\n\n' +
  'Пришли мне:\n' +
  '• 🎥 видеофайл — уникализирую\n' +
  '• 🔗 ссылку (TikTok, YouTube, VK, Instagram…) — скачаю в лучшем качестве и предложу уникализировать\n\n' +
  'Уникализация: метаданные, микро-смена скорости, цвета, шум, звук — каждый раз по-разному.';

// ── /start и /help ─────────────────────────────────────────────────────────
bot.command(['start', 'help'], async ctx => { await ctx.reply(HELP); });

// ── основной обработчик сообщений ──────────────────────────────────────────
bot.on('message', async ctx => {
  const msg = ctx.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  const isVideo = msg.video || (msg.document && (msg.document.mime_type || '').startsWith('video/'));
  if (isVideo) {
    const file = msg.video || msg.document;
    const sizeMb = (file.file_size || 0) / 1024 / 1024;
    if (sizeMb > MAX_MB) { await ctx.reply(`❌ Файл ${sizeMb.toFixed(1)} МБ — слишком большой (лимит ${MAX_MB} МБ).`); return; }

    await ctx.reply('⏳ Скачиваю видео…');
    const inPath = path.join(TMP, `in_${chatId}_${Date.now()}.mp4`);
    try {
      const info = await ctx.api.getFile({ file_id: file.file_id });
      const filePath = info.file_path || info.result?.file_path;
      const url = `https://api.telegram.org/file/bot${TOKEN}/${filePath}`;
      await download(url, inPath);
      await ctx.api.sendMessage({
        chat_id: chatId, text: '📥 Скачано. Что сделать с видео?',
        reply_markup: { inline_keyboard: [[
          { text: '🎨 Уникализировать', callback_data: 'uq:' + path.basename(inPath) },
          { text: '📤 Отправить как есть', callback_data: 'raw:' + path.basename(inPath) },
        ]] },
      });
    } catch (e) {
      await ctx.reply('❌ Ошибка обработки: ' + e.message);
      fs.rm(inPath, { force: true }, () => {});
    }
    return;
  }

  const urlMatch = text.match(/https?:\/\/\S+/);
  if (urlMatch && !text.startsWith('/')) {
    const url = urlMatch[0];
    await ctx.reply('⏳ Скачиваю видео по ссылке в лучшем качестве…');
    const stamp = Date.now();
    const outTemplate = path.join(TMP, `dl_${chatId}_${stamp}.%(ext)s`);
    try {
      await run('yt-dlp', ['-f', 'bv*+ba/b', '-o', outTemplate, '--no-playlist', '--max-filesize', '300M', '--no-warnings', url]);
      const files = fs.readdirSync(TMP).filter(f => f.startsWith(`dl_${chatId}_${stamp}.`));
      if (!files.length) throw new Error('файл не скачался');
      await ctx.api.sendMessage({
        chat_id: chatId, text: '📥 Скачано. Уникализировать?',
        reply_markup: { inline_keyboard: [[
          { text: '🎨 Уникализировать', callback_data: 'uq:' + files[0] },
          { text: '📤 Отправить как есть', callback_data: 'raw:' + files[0] },
        ]] },
      });
    } catch (e) {
      await ctx.reply('❌ Не удалось скачать: ' + e.message);
    }
    return;
  }
});

// ── кнопки ─────────────────────────────────────────────────────────────────
bot.on('callback_query', async ctx => {
  const q = ctx.callbackQuery;
  if (!q) return;
  const chatId = q.message.chat.id;
  const [action, fileName] = (q.data || '').split(':');
  const dlPath = path.join(TMP, fileName || '');
  try { await ctx.answerCallbackQuery(); } catch {}

  // Проверку файла делаем только для действий, которым он нужен (raw/uq)
  if (action === 'raw' || action === 'uq') {
    if (!fileName || !fs.existsSync(dlPath)) { await ctx.api.sendMessage({ chat_id: chatId, text: '❌ Файл уже удалён, пришли видео заново.' }); return; }
  }

  if (action === 'raw') {
    await ctx.api.sendMessage({ chat_id: chatId, text: '⏳ Отправляю оригинал…' });
    await ctx.api.sendVideo({ chat_id: chatId, video: await fromPath(dlPath), caption: '📤 Оригинал (без обработки).' });
    fs.rm(dlPath, { force: true }, () => {});
    return;
  }
  if (action === 'uq') {
    // Спрашиваем, сколько уникальных версий прислать (1–5)
    await ctx.api.sendMessage({
      chat_id: chatId, text: '🎚 Сколько версий видео прислать? (1–5)',
      reply_markup: { inline_keyboard: [[
        { text: '1', callback_data: 'uqN:1:' + fileName },
        { text: '2', callback_data: 'uqN:2:' + fileName },
        { text: '3', callback_data: 'uqN:3:' + fileName },
        { text: '4', callback_data: 'uqN:4:' + fileName },
        { text: '5', callback_data: 'uqN:5:' + fileName },
      ]] },
    });
    return;
  }

  if (action === 'uqN') {
    const parts = (q.data || '').split(':');
    const count = Math.max(1, Math.min(5, parseInt(parts[1], 10) || 1));
    const srcName = parts.slice(2).join(':');
    const srcPath = path.join(TMP, srcName);
    if (!srcName || !fs.existsSync(srcPath)) { await ctx.api.sendMessage({ chat_id: chatId, text: '❌ Файл уже удалён, пришли видео заново.' }); return; }
    await ctx.api.sendMessage({ chat_id: chatId, text: `⏳ Уникализирую ${count} ${count === 1 ? 'версию' : 'версий'}… Это займёт немного времени.` });
    const made = [];
    try {
      for (let i = 0; i < count; i++) {
        const outPath = path.join(TMP, `uq_${chatId}_${Date.now()}_${i}.mp4`);
        try {
          await uniquify(srcPath, outPath, 'medium');
          await ctx.api.sendVideo({ chat_id: chatId, video: await fromPath(outPath), caption: `✅ Версия ${i + 1} из ${count}` });
          made.push(outPath);
        } catch (e) {
          await ctx.api.sendMessage({ chat_id: chatId, text: `❌ Версия ${i + 1} не удалась: ` + e.message });
        }
      }
    } finally {
      fs.rm(srcPath, { force: true }, () => {});
      made.forEach(f => fs.rm(f, { force: true }, () => {}));
    }
    return;
  }
});

// автоочистка tmp: файлы старше 1 часа
setInterval(() => {
  const now = Date.now();
  for (const f of fs.readdirSync(TMP)) {
    const p = path.join(TMP, f);
    try { if (now - fs.statSync(p).mtimeMs > 3600 * 1000) fs.rmSync(p, { force: true }); } catch {}
  }
}, 3600 * 1000);

(async () => {
  await bot.startPolling();
  console.log('🤖 Видео-бот запущен');
})();
