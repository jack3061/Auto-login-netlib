/**
 * ### Netlib auto login (robust) ###
 * VERSION: 2025-12-31 v3
 *
 * Env:
 *  - ACCOUNTS="user1:pass1,user2:pass2"   (comma or semicolon separated)
 *  - BOT_TOKEN="xxx" (optional)
 *  - CHAT_ID="xxx"   (optional)
 *  - BASE_URL="https://www.netlib.re/" (optional)
 */

import axios from 'axios';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

console.log('### login.js VERSION 2025-12-31 v3 ###');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log('### FILE PATH:', __filename);

const token = process.env.BOT_TOKEN;
const chatId = process.env.CHAT_ID;
const accountsRaw = process.env.ACCOUNTS || '';
const baseUrl = process.env.BASE_URL || 'https://www.netlib.re/';

function parseAccounts(raw) {
  const items = raw
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(Boolean);

  const list = [];
  for (const item of items) {
    const idx = item.indexOf(':'); // only split on first colon
    if (idx === -1) continue;
    const user = item.slice(0, idx).trim();
    const pass = item.slice(idx + 1).trim();
    if (user && pass) list.push({ user, pass });
  }
  return list;
}

const accountList = parseAccounts(accountsRaw);

if (!accountsRaw) {
  console.log('❌ 未配置账号: 请设置环境变量 ACCOUNTS');
  process.exit(1);
}
if (accountList.length === 0) {
  console.log('❌ 账号格式错误，应为 username1:password1,username2:password2');
  process.exit(1);
}

function hktTimeString() {
  const now = new Date();
  const hk = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return hk.toISOString().replace('T', ' ').slice(0, 19) + ' HKT';
}

async function sendTelegram(message) {
  if (!token || !chatId) return;

  const fullMessage = `Netlib 登录通知\n\n登录时间：${hktTimeString()}\n\n${message}`;

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: fullMessage },
      { timeout: 10000 }
    );
    console.log('✅ Telegram 通知发送成功');
  } catch (e) {
    console.log(`⚠️ Telegram 发送失败: ${e?.message || e}`);
  }
}

// --- 判定函数：避免 Logs 污染 ---
async function hasTopInvalidBanner(page) {
  const loc = page.getByText(/Invalid credentials\.?/i);
  const n = await loc.count();
  let minY = Infinity;

  for (let i = 0; i < n; i++) {
    const item = loc.nth(i);
    const visible = await item.isVisible().catch(() => false);
    if (!visible) continue;

    const box = await item.boundingBox().catch(() => null);
    if (box && typeof box.y === 'number') minY = Math.min(minY, box.y);
  }

  // 顶部红条一般在页面上方；Logs 在更下方
  return minY < 200;
}

async function hasSuccessOwnerText(page) {
  const ownerText = page.getByText(/You are the exclusive owner of the following domains\./i);
  const visible = await ownerText.first().isVisible().catch(() => false);
  if (!visible) return false;

  const box = await ownerText.first().boundingBox().catch(() => null);
  // 成功页该文案在较上方区域；加个位置限制，避免极端误匹配
  return !!box && box.y < 800;
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

async function loginWithAccount(user, pass) {
  console.log(`\n🚀 开始登录账号: ${user}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const result = { user, success: false, message: '' };

  try {
    // 避免复用旧 token / storage 造成“错密码仍像成功”
    await page.addInitScript(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
    });

    console.log(`📱 ${user} - 正在访问网站...`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    console.log(`🔑 ${user} - 点击 Login...`);
    // 你截图里是导航栏 link
    const loginLink = page.getByRole('link', { name: /^login$/i });
    if (await loginLink.count()) {
      await loginLink.first().click();
    } else {
      await page.getByText(/^login$/i).click();
    }

    // 等待表单出现
    await page.locator('input[name="username"]').waitFor({ state: 'visible', timeout: 15000 });

    console.log(`📝 ${user} - 填写用户名...`);
    await page.locator('input[name="username"]').fill(user);

    console.log(`🔒 ${user} - 填写密码...`);
    await page.locator('input[name="password"]').fill(pass);

    console.log(`📤 ${user} - 提交登录(Validate)...`);
    await page.getByRole('button', { name: /^validate$/i }).click();

    // 等待 15 秒内出现“顶部错误”或“成功文案”
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const topInvalid = await hasTopInvalidBanner(page);
      const success = await hasSuccessOwnerText(page);
      if (topInvalid || success) break;
      await page.waitForTimeout(250);
    }

    const topInvalid = await hasTopInvalidBanner(page);
    const success = await hasSuccessOwnerText(page);

    console.log(`🔍 ${user} - 判定: topInvalid=${topInvalid}, successOwnerText=${success}`);

    // 失败永远优先
    if (topInvalid) {
      result.success = false;
      result.message = `❌ ${user} 登录失败: 账号或密码错误`;
      await page.screenshot({ path: path.join(__dirname, `fail_${safeName(user)}.png`), fullPage: true }).catch(() => {});
      console.log(`❌ ${user} - 登录失败`);
    } else if (success) {
      result.success = true;
      result.message = `✅ ${user} 登录成功`;
      console.log(`✅ ${user} - 登录成功`);
    } else {
      result.success = false;
      result.message = `❌ ${user} 登录失败: 未检测到成功/失败标识（已截图）`;
      await page.screenshot({ path: path.join(__dirname, `unknown_${safeName(user)}.png`), fullPage: true }).catch(() => {});
      console.log(`❌ ${user} - 登录结果不明确（已截图）`);
    }
  } catch (e) {
    result.success = false;
    result.message = `❌ ${user} 登录异常: ${e?.message || e}`;
    await page.screenshot({ path: path.join(__dirname, `error_${safeName(user)}.png`), fullPage: true }).catch(() => {});
    console.log(`❌ ${user} - 登录异常: ${e?.message || e}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return result;
}

async function main() {
  console.log(`🔍 发现 ${accountList.length} 个账号需要登录`);

  const results = [];

  for (let i = 0; i < accountList.length; i++) {
    const { user, pass } = accountList[i];
    console.log(`\n📋 处理第 ${i + 1}/${accountList.length} 个账号: ${user}`);

    const r = await loginWithAccount(user, pass);
    results.push(r);

    if (i < accountList.length - 1) {
      console.log('⏳ 等待3秒后处理下一个账号...');
      await new Promise(res => setTimeout(res, 3000));
    }
  }

  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;

  let summary = `📊 登录汇总: ${successCount}/${totalCount} 个账号成功\n\n`;
  for (const r of results) summary += `${r.message}\n`;

  await sendTelegram(summary);

  console.log('\n✅ 所有账号处理完成！');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
