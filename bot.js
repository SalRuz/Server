require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs').promises;
const path = require('path');
const { exec, spawn } = require('child_process');
const Database = require('./database');

const token = process.env.TELEGRAM_BOT_TOKEN;
const adminId = parseInt(process.env.ADMIN_ID, 10);
const workspace = path.resolve(process.env.WORKSPACE_PATH || './workspace');

// Гарантируем существование рабочей папки
fs.mkdir(workspace, { recursive: true }).catch(console.error);

const bot = new TelegramBot(token, { polling: true });
const db = new Database();

let currentPath = workspace;
let uploadMode = { active: false, targetPath: '' };

// Проверка админских прав
function isAdmin(userId) {
  return userId === adminId;
}

// Безопасная проверка пути (защита от Directory Traversal)
function getSafePath(target) {
  const resolved = path.resolve(currentPath, target);
  if (!resolved.startsWith(workspace)) {
    throw new Error('Доступ за пределы рабочей директории запрещен');
  }
  return resolved;
}

// Форматирование длинных сообщений
function sendLongMessage(chatId, text) {
  const maxLength = 4000;
  if (text.length <= maxLength) {
    return bot.sendMessage(chatId, text);
  }
  
  const parts = [];
  for (let i = 0; i < text.length; i += maxLength) {
    parts.push(text.substring(i, i + maxLength));
  }
  
  return parts.reduce((promise, part) => {
    return promise.then(() => bot.sendMessage(chatId, part));
  }, Promise.resolve());
}

// Команда /start
bot.onText(/\/start/, async (msg) => {
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(msg.chat.id, '⛔️ Доступ запрещен');
  }
  
  await bot.sendMessage(msg.chat.id, `
🤖 **Dev Bot активирован!**

Доступные команды:
/files - Список файлов и папок
/cd <путь> - Перейти в папку
/mkdir <имя> - Создать папку
/rm <путь> - Удалить файл или папку
/upload <путь> - Загрузить файлы в папку
/cmd <команда> - Выполнить shell команду
/npm <команда> - Выполнить npm команду
/db <запрос> - Выполнить SQL запрос
/status - Статус сервера
/cancel - Отменить режим загрузки
/help - Подробная справка
  `, { parse_mode: 'Markdown' });
});

// Команда /files
bot.onText(/\/files/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  
  try {
    const files = await fs.readdir(currentPath, { withFileTypes: true });
    let message = `📁 *${currentPath}*\n\n`;
    
    if (files.length === 0) {
      message += '_Папка пуста_';
    } else {
      for (const file of files) {
        const stat = await fs.stat(path.join(currentPath, file.name));
        const icon = file.isDirectory() ? '📁' : '📄';
        const size = file.isFile() ? ` (${(stat.size / 1024).toFixed(2)} KB)` : '';
        message += `${icon} \`${file.name}\`${size}\n`;
      }
    }
    
    await sendLongMessage(msg.chat.id, message);
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
  }
});

// Команда /cd
bot.onText(/\/cd (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  
  try {
    const newPath = getSafePath(match[1]);
    const stat = await fs.stat(newPath);
    if (!stat.isDirectory()) {
      throw new Error('Указанный путь не является директорией');
    }
    currentPath = newPath;
    await bot.sendMessage(msg.chat.id, `✅ Перешли в: \`${currentPath}\``, { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
  }
});

// Команда /mkdir - создать папку
bot.onText(/\/mkdir (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  
  try {
    const newDirPath = getSafePath(match[1]);
    await fs.mkdir(newDirPath, { recursive: true });
    await bot.sendMessage(msg.chat.id, `✅ Папка создана: \`${newDirPath}\``, { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка создания папки: ${err.message}`);
  }
});

// Команда /rm - удалить файл или папку
bot.onText(/\/rm (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  
  try {
    const targetPath = getSafePath(match[1]);
    const stat = await fs.stat(targetPath);
    
    if (stat.isDirectory()) {
      await fs.rm(targetPath, { recursive: true, force: true });
      await bot.sendMessage(msg.chat.id, `✅ Папка удалена: \`${targetPath}\``, { parse_mode: 'Markdown' });
    } else {
      await fs.unlink(targetPath);
      await bot.sendMessage(msg.chat.id, `✅ Файл удален: \`${targetPath}\``, { parse_mode: 'Markdown' });
    }
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка удаления: ${err.message}`);
  }
});

// Команда /upload
bot.onText(/\/upload(?: (.+))?/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  
  try {
    const targetPath = match[1] ? getSafePath(match[1]) : currentPath;
    await fs.mkdir(targetPath, { recursive: true });
    uploadMode = { active: true, targetPath };
    await bot.sendMessage(msg.chat.id, `📤 **Режим загрузки активирован**\nЦель: \`${targetPath}\`\n\nОтправьте файлы или фото. Для отмены: /cancel`, { parse_mode: 'Markdown' });
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
  }
});

// Команда /cancel
bot.onText(/\/cancel/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  uploadMode = { active: false, targetPath: '' };
  bot.sendMessage(msg.chat.id, '❌ Режим загрузки отменен');
});

// Обработка документов
bot.on('document', async (msg) => {
  if (!isAdmin(msg.from.id) || !uploadMode.active) return;
  
  const fileId = msg.document.file_id;
  const fileName = msg.document.file_name || 'unknown_file';
  
  try {
    const downloadedPath = await bot.downloadFile(fileId, uploadMode.targetPath);
    const finalPath = path.join(uploadMode.targetPath, fileName);
    
    await fs.rename(downloadedPath, finalPath);
    await bot.sendMessage(msg.chat.id, `✅ Файл сохранен: \`${finalPath}\``, { parse_mode: 'Markdown' });
    
    await db.query('INSERT INTO files (path, size) VALUES (?, ?)', [finalPath, msg.document.file_size]).catch(console.error);
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка загрузки: ${err.message}`);
  }
});

// Обработка фото
bot.on('photo', async (msg) => {
  if (!isAdmin(msg.from.id) || !uploadMode.active) return;
  
  const photo = msg.photo[msg.photo.length - 1];
  
  try {
    const downloadedPath = await bot.downloadFile(photo.file_id, uploadMode.targetPath);
    const fileName = `photo_${Date.now()}.jpg`;
    const finalPath = path.join(uploadMode.targetPath, fileName);
    
    await fs.rename(downloadedPath, finalPath);
    await bot.sendMessage(msg.chat.id, `✅ Фото сохранено: \`${finalPath}\``, { parse_mode: 'Markdown' });
    
    await db.query('INSERT INTO files (path, size) VALUES (?, ?)', [finalPath, photo.file_size]).catch(console.error);
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка загрузки фото: ${err.message}`);
  }
});

// Команда /cmd
bot.onText(/\/cmd (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  
  const command = match[1];
  await bot.sendMessage(msg.chat.id, `⚙️ Выполняю: \`${command}\``, { parse_mode: 'Markdown' });
  
  exec(command, { cwd: currentPath, maxBuffer: 1024 * 1024 * 10, timeout: 30000 }, async (err, stdout, stderr) => {
    let output = '';
    if (stdout) output += `📤 **Вывод:**\n\`\`\`\n${stdout}\n\`\`\`\n`;
    if (stderr) output += `⚠️ **Ошибки:**\n\`\`\`\n${stderr}\n\`\`\`\n`;
    if (err) output += `❌ **Код ошибки:** ${err.code || err.signal}\n`;
    if (!output) output = '✅ Команда выполнена успешно (нет вывода)';
    
    await sendLongMessage(msg.chat.id, output);
    await db.logCommand(command, err ? 'error' : 'success').catch(console.error);
  });
});

// Команда /npm
bot.onText(/\/npm (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  
  const npmArgs = match[1].split(' ');
  await bot.sendMessage(msg.chat.id, `📦 Выполняю: \`npm ${match[1]}\``, { parse_mode: 'Markdown' });
  
  const npm = spawn('npm', npmArgs, { cwd: currentPath });
  let output = '';
  
  npm.stdout.on('data', (data) => { output += data.toString(); });
  npm.stderr.on('data', (data) => { output += data.toString(); });
  
  npm.on('close', async (code) => {
    const result = `**Код завершения:** ${code}\n\n\`\`\`\n${output || 'Нет вывода'}\n\`\`\``;
    await sendLongMessage(msg.chat.id, result);
    await db.logCommand(`npm ${match[1]}`, code === 0 ? 'success' : 'error').catch(console.error);
  });

  npm.on('error', async (err) => {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка запуска npm: ${err.message}`);
  });
});

// Команда /db
bot.onText(/\/db (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  
  const query = match[1];
  try {
    const result = await db.query(query);
    const formattedResult = typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result);
    await sendLongMessage(msg.chat.id, `✅ **Результат:**\n\`\`\`json\n${formattedResult}\n\`\`\``);
  } catch (err) {
    await bot.sendMessage(msg.chat.id, `❌ Ошибка SQL: ${err.message}`);
  }
});

// Команда /status
bot.onText(/\/status/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  
  const uptime = process.uptime();
  const memory = process.memoryUsage();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);
  
  const status = `
📊 **Статус сервера:**

⏱ **Uptime:** ${hours} ч ${mins} мин
💾 **RAM:** ${(memory.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(memory.heapTotal / 1024 / 1024).toFixed(2)} MB
📂 **Рабочая папка:** \`${currentPath}\`
🔌 **Статус бота:** Активен
  `;
  
  await bot.sendMessage(msg.chat.id, status, { parse_mode: 'Markdown' });
});

// Команда /help
bot.onText(/\/help/, (msg) => {
  if (!isAdmin(msg.from.id)) return;
  
  bot.sendMessage(msg.chat.id, `
📚 **Справка по командам:**

• /files - Список файлов в текущей папке
• /cd <путь> - Перейти в папку (пример: \`/cd src\`)
• /mkdir <имя> - Создать папку (пример: \`/mkdir src/utils\`)
• /rm <путь> - Удалить файл или папку (пример: \`/rm old.txt\`)
• /upload [путь] - Включить режим загрузки файлов
• /cancel - Выключить режим загрузки
• /cmd <команда> - Выполнить shell команду (пример: \`/cmd ls -la\`)
• /npm <аргументы> - Выполнить npm команду (пример: \`/npm install express\`)
• /db <SQL> - Выполнить SQL запрос (пример: \`/db SELECT * FROM logs\`)
• /status - Показать статус сервера

⚠️ **Важно:** Удаление файлов через \`/rm\` необратимо!
  `, { parse_mode: 'Markdown' });
});

// Обработка ошибок polling
bot.on('polling_error', (err) => {
  console.error('❌ Polling error:', err.message);
});

// Глобальная обработка необработанных ошибок
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
  if (adminId) {
    bot.sendMessage(adminId, `🚨 **Критическая ошибка сервера:**\n\`${err.message}\``, { parse_mode: 'Markdown' }).catch(console.error);
  }
  process.exit(1);
});

console.log(`🤖 Бот запущен. Рабочая директория: ${workspace}`);
