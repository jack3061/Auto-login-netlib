/**
 * Netlib auto login (robust)
 * VERSION: 2025-12-31 v5
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
import fs from 'node:fs/promises';

console.log('### login.js VERSION 2025-12-31 v5 ###');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log('### FILE PATH:', __filename);

const token = process.env.BOT_TOKEN;
const chatId = process.env.CHAT_ID;
const accountsRaw = process.env.ACCOUNTS || '';
const baseUrl = process.env.BASE_URL || 'https://www.netlib.re/';

function hktTimeString() {
  const now = new Date();
  const hk = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return hk.toISOString().replace('T', ' ').slice(0, 19) + ' HKT';
}

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Split only on FIRST ":" so password may contain ":" */
function parseAccounts(raw) {
  const items = raw
    .split(/[,;]/)
    .map(s => s.trim())
    .filter(Boolean);

  const list = [];
  for (const item of items) {
    const idx = item.indexOf(':');
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

function getActionsRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  }
  return '';
}

async function sendTelegram(message) {
  if (!token || !chatId) return;

  // Telegram limit ~4096
  const maxLen = 3800;
  const text = message.length > maxLen ? message.slice(0, maxLen) + '\n\n...(truncated)' : message;

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text },
      { timeout: 10000 }
    );
    console.log('✅ Telegram 通知发送成功');
  } catch (e) {
    console.log(`⚠️ Telegram 发送失败: ${e?.message || e}`);
  }
}

/** Try to detect the TOP red banner, not the Logs entry */
async function hasTopInvalidBanner(page) {
  // Prefer bootstrap-like alerts if present
  const alertLoc = page.locator(
    '.alert, .alert-danger, .notification, .toast, .snackbar'
  ).filter({ hasText: /Invalid credentials/i });

  if (await alertLoc.first().isVisible().catch(() => false)) return true;

  // Fallback: distinguish by y position
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

  return minY < 450; // relaxed threshold for headless layout
}

async function getSuccessSignalsUI(page) {
  const myDomainsHeading = page.getByRole('heading', { name: /my domains/i });
  const myDomainsText = page.getByText(/my domains/i);
  const ownerText = page.getByText(/You are the exclusive owner of the following domains\./i);

  const hasHeading = await myDomainsHeading.first().isVisible().catch(() => false);
  const hasMyDomains = hasHeading || (await myDomainsText.first().isVisible().catch(() => false));
  const hasOwnerText = await ownerText.first().isVisible().catch(() => false);

  return { hasMyDomains, hasOwnerText, success: hasMyDomains || hasOwnerText };
}

/**
 * Parse Logs from body.innerText, but ONLY after the LAST
 * "System: authenticate (login: user)" occurrence.
 */
async function getLoginVerdictFromLogs(page, user) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  const anchor = `authenticate (login: ${user})`;
  const idx = bodyText.lastIndexOf(anchor);
  if (idx === -1) return { verdict: 'NONE', snippet: '' };

  const tail = bodyText.slice(idx);

  // Keep a short snippet for Telegram debugging
  const lines = tail
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const snippet = lines.slice(0, 25).join('\n'); // first 25 lines after anchor

  const hasInvalid = /Error:\s*Invalid credentials\.?/i.test(tail);
  const hasAuthd = /Authenticated to authd\./i.test(tail);
  const hasDns = /Authenticated to dnsmanagerd\./i.test(tail);

  if (hasInvalid) return { verdict: 'FAIL_INVALID', snippet };
  if (hasAuthd && hasDns) return { verdict: 'SUCCESS', snippet };

  return { verdict: 'UNKNOWN', snippet };
}

async function loginWithAccount(user, pass) {
  console.log(`\n🚀 开始登录账号: ${user}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 }
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const result = {
    user,
    success: false,
    status: 'INIT', // SUCCESS | FAIL_INVALID | FAIL_UNKNOWN | ERROR
    reason: '',
    url: '',
    title: '',
    evidence: {
      topInvalid: false,
      uiMyDomains: false,
      uiOwnerText: false,
      logsVerdict: 'NONE'
    },
    logsSnippet: '',
    screenshot: ''
  };

  try {
    // reduce chance of reused storage/token
    await page.addInitScript(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
    });

    console.log(`📱 ${user} - 正在访问网站...`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    console.log(`🔑 ${user} - 点击 Login...`);
    await page.getByRole('link', { name: /^login$/i }).first().click({ timeout: 10000 });

    // wait for auth form
    await page.locator('input[name="username"]').waitFor({ state: 'visible', timeout: 15000 });

    console.log(`📝 ${user} - 填写用户名...`);
    await page.locator('input[name="username"]').fill(user);

    console.log(`🔒 ${user} - 填写密码...`);
    await page.locator('input[name="password"]').fill(pass);

    console.log(`📤 ${user} - 提交登录(Validate)...`);
    await page.getByRole('button', { name: /^validate$/i }).click();

    // Wait up to 30s for any sign (UI fail / UI success / logs anchor line)
    const anchorLoc = page.getByText(new RegExp(`authenticate \\(login: ${user}\\)`, 'i'));

    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const topInvalid = await hasTopInvalidBanner(page);
      const ui = await getSuccessSignalsUI(page);
      const hasAnchor = await anchorLoc.first().isVisible().catch(() => false);

      if (topInvalid || ui.success || hasAnchor) break;
      await page.waitForTimeout(300);
    }

    // Give logs a bit time to append Authenticated/Error after anchor appears
    await page.waitForTimeout(1500);

    result.url = page.url();
    result.title = await page.title().catch(() => '');

    // UI checks
    result.evidence.topInvalid = await hasTopInvalidBanner(page);
    const ui = await getSuccessSignalsUI(page);
    result.evidence.uiMyDomains = ui.hasMyDomains;
    result.evidence.uiOwnerText = ui.hasOwnerText;

    // Logs-based fallback
    const logs = await getLoginVerdictFromLogs(page, user);
    result.evidence.logsVerdict = logs.verdict;
    result.logsSnippet = logs.snippet;

    console.log(
      `🔍 ${user} - evidence: topInvalid=${result.evidence.topInvalid}, uiMyDomains=${result.evidence.uiMyDomains}, uiOwnerText=${result.evidence.uiOwnerText}, logsVerdict=${result.evidence.logsVerdict}, url=${result.url}`
    );

    // Final decision (priority: UI top error > logs invalid > UI success > logs success > unknown)
    if (result.evidence.topInvalid || logs.verdict === 'FAIL_INVALID') {
      result.status = 'FAIL_INVALID';
      result.reason = result.evidence.topInvalid
        ? '账号或密码错误（顶部出现 Invalid credentials）'
        : '账号或密码错误（Logs 出现 Error: Invalid credentials）';
      result.success = false;

      result.screenshot = `fail_${safeName(user)}.png`;
      await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});
      await fs.writeFile(path.join(__dirname, `logs_${safeName(user)}.txt`), result.logsSnippet || '', 'utf8').catch(() => {});
      console.log(`❌ ${user} - 登录失败（密码错误）`);
      return result;
    }

    if (ui.success || logs.verdict === 'SUCCESS') {
      result.status = 'SUCCESS';
      result.reason = ui.success
        ? (ui.hasMyDomains ? '检测到成功页面: My domains' : '检测到成功文案: exclusive owner...')
        : '检测到成功日志: Authenticated to authd + dnsmanagerd';
      result.success = true;

      // optional: screenshot on success too (comment out if you don't want)
      // result.screenshot = `success_${safeName(user)}.png`;
      // await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});
      await fs.writeFile(path.join(__dirname, `logs_${safeName(user)}.txt`), result.logsSnippet || '', 'utf8').catch(() => {});
      console.log(`✅ ${user} - 登录成功`);
      return result;
    }

    // Unknown
    result.status = 'FAIL_UNKNOWN';
    result.reason = '未能判定：UI 未出现成功/错误条，Logs 也未给出明确 SUCCESS/Invalid（见截图与 logs_*.txt）';
    result.success = false;

    result.screenshot = `unknown_${safeName(user)}.png`;
    await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(__dirname, `logs_${safeName(user)}.txt`), result.logsSnippet || '', 'utf8').catch(() => {});
    console.log(`❌ ${user} - 登录失败（未判定，已截图+保存日志）`);
    return result;

  } catch (e) {
    result.status = 'ERROR';
    result.success = false;
    result.reason = `脚本异常: ${e?.message || e}`;
    result.url = page?.url?.() || '';
    result.title = await page?.title?.().catch(() => '') || '';

    result.screenshot = `error_${safeName(user)}.png`;
    await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});
    console.log(`❌ ${user} - 登录异常: ${e?.message || e}`);
    return result;

  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function formatResultBlock(r) {
  const statusZh = {
    SUCCESS: '成功',
    FAIL_INVALID: '失败-密码错误',
    FAIL_UNKNOWN: '失败-未判定',
    ERROR: '异常'
  }[r.status] || r.status;

  const ev = r.evidence || {};
  let s =
    `账号：${r.user}\n` +
    `结果：${statusZh} (${r.status})\n` +
    `原因：${r.reason}\n` +
    `证据：topInvalid=${!!ev.topInvalid}, uiMyDomains=${!!ev.uiMyDomains}, uiOwnerText=${!!ev.uiOwnerText}, logsVerdict=${ev.logsVerdict}\n`;

  if (r.title) s += `Title：${r.title}\n`;
  if (r.url) s += `URL：${r.url}\n`;
  if (r.screenshot) s += `截图：${r.screenshot}\n`;
  s += `Logs：logs_${safeName(r.user)}.txt\n`;

  // add a small logs preview in telegram (avoid too long)
  if (r.logsSnippet) {
    const preview = r.logsSnippet.split('\n').slice(0, 8).join('\n');
    s += `Logs预览：\n${preview}\n`;
  }

  return s;
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

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const runUrl = getActionsRunUrl();

  let msg =
    `Netlib 登录通知\n` +
    `时间：${hktTimeString()}\n` +
    (runUrl ? `Run：${runUrl}\n` : '') +
    `\n` +
    `汇总：成功 ${counts.SUCCESS || 0}；密码错误 ${counts.FAIL_INVALID || 0}；未判定 ${counts.FAIL_UNKNOWN || 0}；异常 ${counts.ERROR || 0}\n\n`;

  for (const r of results) {
    msg += formatResultBlock(r) + '\n';
  }

  await sendTelegram(msg);
  console.log('\n✅ 所有账号处理完成！');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
