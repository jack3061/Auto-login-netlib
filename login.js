/**
 * Netlib auto login (robust)
 * VERSION: 2025-12-31 v7
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

console.log('### login.js VERSION 2025-12-31 v7 ###');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log('### FILE PATH:', __filename);

const token = process.env.BOT_TOKEN;
const chatId = process.env.CHAT_ID;
const accountsRaw = process.env.ACCOUNTS || '';
const baseUrlRaw = process.env.BASE_URL || 'https://www.netlib.re/';

function normalizeBaseUrl(u) {
  try {
    const url = new URL(u);
    return `${url.origin}/`;
  } catch {
    return 'https://www.netlib.re/';
  }
}

const baseUrl = normalizeBaseUrl(baseUrlRaw);

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

  const maxLen = 3800; // Telegram limit ~4096
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

async function isDisconnected(page) {
  const banner = page.getByText(/You have been disconnected/i);
  return await banner.isVisible().catch(() => false);
}

/**
 * Wait until the disconnected banner disappears automatically.
 * (Do NOT click reconnect per your requirement.)
 */
async function waitForDisconnectedGone(page, timeoutMs = 30000) {
  const banner = page.getByText(/You have been disconnected/i);
  const t0 = Date.now();

  while (Date.now() - t0 < timeoutMs) {
    const visible = await banner.isVisible().catch(() => false);
    if (!visible) return true;
    await page.waitForTimeout(400);
  }
  return false;
}

/**
 * Your required readiness gate:
 * 1) Wait until "Read the news!" appears
 * 2) Then wait until disconnected banner auto-disappears
 */
async function waitForHomeReady(page, timeoutMs = 30000) {
  const readNews = page.getByText(/Read the news!/i);
  await readNews.waitFor({ state: 'visible', timeout: timeoutMs });
  return await waitForDisconnectedGone(page, timeoutMs);
}

/** Detect top "Invalid credentials" banner (not Logs) */
async function hasTopInvalidBanner(page) {
  const alertLoc = page
    .locator('.alert, .alert-danger, .notification, .toast, .snackbar')
    .filter({ hasText: /Invalid credentials/i });

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

  // Logs area is usually lower; banner is near top
  return minY < 450;
}

async function getSuccessSignalsUI(page) {
  const myDomainsHeading = page.getByRole('heading', { name: /my domains/i });
  const ownerText = page.getByText(/You are the exclusive owner of the following domains\./i);

  const hasMyDomains = await myDomainsHeading.first().isVisible().catch(() => false);
  const hasOwnerText = await ownerText.first().isVisible().catch(() => false);

  return { hasMyDomains, hasOwnerText, success: hasMyDomains || hasOwnerText };
}

/**
 * Parse Logs from body.innerText, but ONLY after the LAST
 * "authenticate (login: user)" occurrence.
 */
async function getLoginVerdictFromLogs(page, user) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  const anchor = `authenticate (login: ${user})`;
  const idx = bodyText.lastIndexOf(anchor);

  // If no anchor, return last lines for debugging
  if (idx === -1) {
    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
    const tail = lines.slice(-50).join('\n');
    return { verdict: 'NONE', snippet: tail };
  }

  const tail = bodyText.slice(idx);
  const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
  const snippet = lines.slice(0, 35).join('\n');

  const hasInvalid = /Error:\s*Invalid credentials\.?/i.test(tail);
  const hasAuthd = /Authenticated to authd\./i.test(tail);
  const hasDns = /Authenticated to dnsmanagerd\./i.test(tail);

  if (hasInvalid) return { verdict: 'FAIL_INVALID', snippet };
  if (hasAuthd && hasDns) return { verdict: 'SUCCESS', snippet };
  return { verdict: 'UNKNOWN', snippet };
}

/**
 * Navigate to login page reliably:
 * - Try click (SPA route)
 * - If inputs not visible, try goto on href + common fallbacks
 * - If tabbed UI, click "Authentication" tab
 */
async function gotoLoginPage(page, baseUrl) {
  const loginLink = page.getByRole('link', { name: /^login$/i }).first();
  const href = await loginLink.getAttribute('href').catch(() => null);

  const userInput = page.locator('input[name="username"]');

  // 1) Try click route (after home ready this should work often)
  if (await loginLink.isVisible().catch(() => false)) {
    await loginLink.scrollIntoViewIfNeeded().catch(() => {});
    await loginLink.click({ timeout: 10000, force: true }).catch(() => {});

    const authTab = page.getByRole('link', { name: /^authentication$/i });
    if (await authTab.first().isVisible().catch(() => false)) {
      await authTab.first().click().catch(() => {});
    }

    if (await userInput.first().isVisible().catch(() => false)) {
      return { ok: true, href, tried: 'click(Login)' };
    }
  }

  // 2) Try goto fallbacks
  const candidates = [];
  if (href) {
    try { candidates.push(new URL(href, baseUrl).toString()); } catch {}
  }
  candidates.push(
    new URL('/#/authentication', baseUrl).toString(),
    new URL('/#/login', baseUrl).toString(),
    new URL('/login', baseUrl).toString(),
    new URL('/auth', baseUrl).toString()
  );

  for (const url of [...new Set(candidates)]) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});

    const authTab = page.getByRole('link', { name: /^authentication$/i });
    if (await authTab.first().isVisible().catch(() => false)) {
      await authTab.first().click().catch(() => {});
    }

    if (await userInput.first().isVisible().catch(() => false)) {
      return { ok: true, href, tried: url };
    }
  }

  return { ok: false, href, tried: candidates[0] || '' };
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
    nav: { href: '', tried: '' },
    evidence: {
      disconnected: false,
      topInvalid: false,
      uiMyDomains: false,
      uiOwnerText: false,
      logsVerdict: 'NONE'
    },
    logsSnippet: '',
    screenshot: ''
  };

  try {
    // avoid reused storage/token affecting state
    await page.addInitScript(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch {}
    });

    console.log(`📱 ${user} - 访问首页...`);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    console.log(`⏳ ${user} - 等待首页就绪(Read the news!) 且断线提示自动消失...`);
    const ready = await waitForHomeReady(page, 40000);
    if (!ready) {
      result.status = 'FAIL_UNKNOWN';
      result.reason = '首页断线提示未自动消失（WebSocket不稳定/Actions网络问题）';
      result.url = page.url();
      result.title = await page.title().catch(() => '');
      result.evidence.disconnected = await isDisconnected(page);

      result.screenshot = `disconnected_${safeName(user)}.png`;
      await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});

      const logs = await getLoginVerdictFromLogs(page, user);
      result.logsSnippet = logs.snippet || '';
      await fs.writeFile(path.join(__dirname, `logs_${safeName(user)}.txt`), result.logsSnippet, 'utf8').catch(() => {});
      return result;
    }

    console.log(`🔑 ${user} - 打开登录页...`);
    const nav = await gotoLoginPage(page, baseUrl);
    result.nav.href = nav.href || '';
    result.nav.tried = nav.tried || '';
    console.log(`🔗 ${user} - login href=${result.nav.href || '(null)'} ; tried=${result.nav.tried}`);

    // 登录页也可能短暂断线：按你的要求只等待它自动消失
    await waitForDisconnectedGone(page, 20000).catch(() => {});

    if (!nav.ok) {
      result.status = 'FAIL_UNKNOWN';
      result.reason = '无法进入登录页（Login 路由/页面结构可能变化）';
      result.url = page.url();
      result.title = await page.title().catch(() => '');
      result.evidence.disconnected = await isDisconnected(page);

      result.screenshot = `no_login_page_${safeName(user)}.png`;
      await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});

      const logs = await getLoginVerdictFromLogs(page, user);
      result.logsSnippet = logs.snippet || '';
      await fs.writeFile(path.join(__dirname, `logs_${safeName(user)}.txt`), result.logsSnippet, 'utf8').catch(() => {});
      return result;
    }

    // Ensure inputs are visible
    await page.locator('input[name="username"]').waitFor({ state: 'visible', timeout: 20000 });

    console.log(`📝 ${user} - 填写用户名...`);
    await page.locator('input[name="username"]').fill(user);

    console.log(`🔒 ${user} - 填写密码...`);
    await page.locator('input[name="password"]').fill(pass);

    console.log(`📤 ${user} - 提交登录(Validate)...`);
    await page.getByRole('button', { name: /^validate$/i }).click();

    // Wait for any sign: top invalid / UI success / logs anchor
    const anchorLoc = page.getByText(new RegExp(`authenticate \\(login: ${user}\\)`, 'i'));

    const t0 = Date.now();
    while (Date.now() - t0 < 35000) {
      // If disconnected shows up, wait it to go away automatically and keep waiting
      if (await isDisconnected(page)) {
        await waitForDisconnectedGone(page, 15000).catch(() => {});
      }

      const topInvalid = await hasTopInvalidBanner(page);
      const ui = await getSuccessSignalsUI(page);
      const hasAnchor = await anchorLoc.first().isVisible().catch(() => false);

      if (topInvalid || ui.success || hasAnchor) break;
      await page.waitForTimeout(350);
    }

    // Allow logs to append Authenticated/Error after anchor
    await page.waitForTimeout(2000);

    result.url = page.url();
    result.title = await page.title().catch(() => '');
    result.evidence.disconnected = await isDisconnected(page);

    // Evidence
    result.evidence.topInvalid = await hasTopInvalidBanner(page);
    const ui = await getSuccessSignalsUI(page);
    result.evidence.uiMyDomains = ui.hasMyDomains;
    result.evidence.uiOwnerText = ui.hasOwnerText;

    const logs = await getLoginVerdictFromLogs(page, user);
    result.evidence.logsVerdict = logs.verdict;
    result.logsSnippet = logs.snippet || '';
    await fs.writeFile(path.join(__dirname, `logs_${safeName(user)}.txt`), result.logsSnippet, 'utf8').catch(() => {});

    console.log(
      `🔍 ${user} - evidence: disconnected=${result.evidence.disconnected}, topInvalid=${result.evidence.topInvalid}, uiMyDomains=${result.evidence.uiMyDomains}, uiOwnerText=${result.evidence.uiOwnerText}, logsVerdict=${result.evidence.logsVerdict}, url=${result.url}`
    );

    // Decide (priority: UI top invalid > logs invalid > UI success > logs success > unknown)
    if (result.evidence.topInvalid || logs.verdict === 'FAIL_INVALID') {
      result.status = 'FAIL_INVALID';
      result.reason = result.evidence.topInvalid
        ? '账号或密码错误（顶部出现 Invalid credentials）'
        : '账号或密码错误（Logs 出现 Error: Invalid credentials）';
      result.success = false;

      result.screenshot = `fail_${safeName(user)}.png`;
      await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});
      return result;
    }

    if (ui.success || logs.verdict === 'SUCCESS') {
      result.status = 'SUCCESS';
      result.reason = ui.success
        ? (ui.hasMyDomains ? '检测到成功页面: My domains' : '检测到成功文案: exclusive owner...')
        : '检测到成功日志: Authenticated to authd + dnsmanagerd';
      result.success = true;
      return result;
    }

    result.status = 'FAIL_UNKNOWN';
    result.reason = result.evidence.disconnected
      ? '未能判定：提交后页面仍处于 disconnected（WS不稳定），见截图与 logs_*.txt'
      : '未能判定：UI 未出现成功/错误条，Logs 也未给出明确 SUCCESS/Invalid（见截图与 logs_*.txt）';
    result.success = false;

    result.screenshot = `unknown_${safeName(user)}.png`;
    await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});
    return result;

  } catch (e) {
    result.status = 'ERROR';
    result.success = false;
    result.reason = `脚本异常: ${e?.message || e}`;
    result.url = page?.url?.() || '';
    result.title = await page?.title?.().catch(() => '') || '';
    result.evidence.disconnected = await isDisconnected(page).catch(() => false);

    result.screenshot = `error_${safeName(user)}.png`;
    await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});

    const logs = await getLoginVerdictFromLogs(page, user).catch(() => ({ snippet: '' }));
    result.logsSnippet = logs?.snippet || '';
    await fs.writeFile(path.join(__dirname, `logs_${safeName(user)}.txt`), result.logsSnippet, 'utf8').catch(() => {});
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
  const nav = r.nav || {};

  let s =
    `账号：${r.user}\n` +
    `结果：${statusZh} (${r.status})\n` +
    `原因：${r.reason}\n` +
    `证据：disconnected=${!!ev.disconnected}, topInvalid=${!!ev.topInvalid}, uiMyDomains=${!!ev.uiMyDomains}, uiOwnerText=${!!ev.uiOwnerText}, logsVerdict=${ev.logsVerdict}\n` +
    `Login入口：href=${nav.href || '(null)'} ; tried=${nav.tried || '(none)'}\n`;

  if (r.title) s += `Title：${r.title}\n`;
  if (r.url) s += `URL：${r.url}\n`;
  if (r.screenshot) s += `截图：${r.screenshot}\n`;
  s += `Logs：logs_${safeName(r.user)}.txt\n`;

  if (r.logsSnippet) {
    const preview = r.logsSnippet.split('\n').slice(0, 10).join('\n');
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
