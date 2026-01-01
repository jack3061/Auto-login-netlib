/**
 * Netlib auto login (robust)
 * VERSION: 2026-01-01 v9 (fix SPA routing / avoid /auth 404 + safer login nav)
 *
 * Env:
 *  - ACCOUNTS_JSON='[{"user":"u1","pass":"p,;:"}]' (RECOMMENDED)
 *  - ACCOUNTS="u1:pass1\nu2:pass2" (fallback; newline recommended)
 *  - BOT_TOKEN, CHAT_ID (optional)
 *  - BASE_URL="https://www.netlib.re/" (optional)
 *  - DEBUG_ACCOUNTS="1" (optional)
 */

import axios from 'axios';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

console.log('### login.js VERSION 2026-01-01 v9 ###');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
console.log('### FILE PATH:', __filename);

const token = process.env.BOT_TOKEN;
const chatId = process.env.CHAT_ID;

const accountsJsonRaw = process.env.ACCOUNTS_JSON || '';
const accountsRaw = process.env.ACCOUNTS || '';
const baseUrlRaw = process.env.BASE_URL || 'https://www.netlib.re/';
const debugAccounts = String(process.env.DEBUG_ACCOUNTS || '') === '1';

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
function sha8(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
}

function parseAccountsJson(raw) {
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => ({
      user: x?.user != null ? String(x.user).trim() : '',
      pass: typeof x?.pass === 'string' ? x.pass : (x?.pass != null ? String(x.pass) : '')
    }))
    .filter(x => x.user && x.pass !== '');
}

/**
 * Fallback parse:
 * - recommended: newline separated
 * - legacy: comma/semicolon (unsafe if password contains , or ;)
 */
function parseAccounts(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];

  const hasNewline = /[\r\n]/.test(trimmed);

  let items;
  if (hasNewline) {
    items = trimmed.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } else {
    items = trimmed.split(/[,;]/).map(s => s.trim()).filter(Boolean);
    if (items.length > 1) {
      console.log(
        '⚠️ ACCOUNTS 使用逗号/分号分隔；若密码包含 , 或 ; 会被截断导致 Invalid credentials。建议用换行或 ACCOUNTS_JSON。'
      );
    }
  }

  const list = [];
  for (const item of items) {
    const idx = item.indexOf(':');
    if (idx === -1) continue;
    const user = item.slice(0, idx).trim();
    const pass = item.slice(idx + 1); // do NOT trim
    if (user && pass !== '') list.push({ user, pass });
  }
  return list;
}

function getAccountList() {
  if (accountsJsonRaw) {
    try {
      const list = parseAccountsJson(accountsJsonRaw);
      if (list.length) return list;
      console.log('❌ ACCOUNTS_JSON 解析后为空，请检查 JSON 格式与字段 user/pass');
      process.exit(1);
    } catch (e) {
      console.log(`❌ ACCOUNTS_JSON 不是合法 JSON: ${e?.message || e}`);
      process.exit(1);
    }
  }

  if (!accountsRaw) {
    console.log('❌ 未配置账号: 请设置环境变量 ACCOUNTS_JSON 或 ACCOUNTS');
    process.exit(1);
  }

  const list = parseAccounts(accountsRaw);
  if (list.length === 0) {
    console.log('❌ 账号格式错误，应为：\n  - ACCOUNTS_JSON: [{"user":"u","pass":"p"}]\n  - 或 ACCOUNTS 换行: user:pass\\nuser2:pass2');
    process.exit(1);
  }
  return list;
}

const accountList = getAccountList();

if (debugAccounts) {
  console.log('### DEBUG_ACCOUNTS enabled (no plaintext password printed) ###');
  console.log(
    accountList.map(a => ({
      user: a.user,
      passLen: a.pass.length,
      passSha8: sha8(a.pass)
    }))
  );
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

async function isDisconnected(page) {
  const banner = page.getByText(/You have been disconnected/i);
  return await banner.isVisible().catch(() => false);
}

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

async function waitForHomeReady(page, timeoutMs = 30000) {
  const readNews = page.getByText(/Read the news!/i);
  await readNews.waitFor({ state: 'visible', timeout: timeoutMs });
  return await waitForDisconnectedGone(page, timeoutMs);
}

async function hasTopInvalidBanner(page) {
  const alertLoc = page
    .locator('.alert, .alert-danger, .notification, .toast, .snackbar')
    .filter({ hasText: /Invalid credentials/i });

  if (await alertLoc.first().isVisible().catch(() => false)) return true;

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
  return minY < 450;
}

async function getSuccessSignalsUI(page) {
  const myDomainsHeading = page.getByRole('heading', { name: /my domains/i });
  const ownerText = page.getByText(/You are the exclusive owner of the following domains\./i);

  const hasMyDomains = await myDomainsHeading.first().isVisible().catch(() => false);
  const hasOwnerText = await ownerText.first().isVisible().catch(() => false);

  return { hasMyDomains, hasOwnerText, success: hasMyDomains || hasOwnerText };
}

async function getLoginVerdictFromLogs(page, user) {
  const bodyText = await page.evaluate(() => document.body?.innerText || '');
  const anchor = `authenticate (login: ${user})`;
  const idx = bodyText.lastIndexOf(anchor);

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

async function isNotFoundPage(page) {
  const title = await page.title().catch(() => '');
  if (/404/i.test(title) || /not found/i.test(title)) return true;

  const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return /darkhttpd/i.test(body) || /The URL you requested was not found/i.test(body);
}

/**
 * IMPORTANT FIX:
 * Netlib is an SPA; deep-link paths like /auth may 404 (darkhttpd).
 * Use hash routing ONLY. Do NOT click tabs that navigate to /auth.
 */
async function gotoLoginPage(page, baseUrl) {
  const userInput = page.locator('input[name="username"]').first();

  async function gotoHash(hash) {
    // ensure we are at origin root
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    // set hash without triggering server path navigation
    await page.evaluate(h => { window.location.hash = h; }, hash).catch(() => {});
    // Wait a bit for SPA to render
    await page.waitForTimeout(500);

    // Some SPAs need a reload after hash set (optional)
    if (await isNotFoundPage(page)) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.evaluate(h => { window.location.hash = h; }, hash).catch(() => {});
      await page.waitForTimeout(600);
    }

    // If a tab/link "Authentication" exists, ONLY click it when href contains "#"
    const authTab = page.getByRole('link', { name: /^authentication$/i }).first();
    if (await authTab.isVisible().catch(() => false)) {
      const href = await authTab.getAttribute('href').catch(() => '');
      if (href && href.includes('#')) {
        await authTab.click().catch(() => {});
        await page.waitForTimeout(300);
      } // else: do NOT click (avoid /auth)
    }

    if (await userInput.isVisible().catch(() => false)) {
      return { ok: true, tried: `${baseUrl}#${hash}` };
    }
    return { ok: false, tried: `${baseUrl}#${hash}` };
  }

  // Try common hash routes
  const hashes = ['#/authentication', '#/login', '#/auth', '#/authentication/'];
  for (const h of hashes) {
    const r = await gotoHash(h);
    if (r.ok) return { ok: true, href: '', tried: r.tried };
  }

  // Last resort: try clicking Login link if present (but avoid non-hash href)
  const loginLink = page.getByRole('link', { name: /^(login|log in)$/i }).first();
  if (await loginLink.isVisible().catch(() => false)) {
    const href = await loginLink.getAttribute('href').catch(() => '');
    if (href && href.includes('#')) {
      await loginLink.click({ timeout: 10000, force: true }).catch(() => {});
      await page.waitForTimeout(500);
      if (await userInput.isVisible().catch(() => false)) {
        return { ok: true, href, tried: 'click(Login#)' };
      }
    } else {
      console.log(`⚠️ Login link href=${href || '(null)'} 不含 #，为避免 404(/auth) 已跳过点击。`);
    }
  }

  return { ok: false, href: '', tried: `${baseUrl}#/authentication` };
}

async function clickValidateScoped(page) {
  const userInput = page.locator('input[name="username"]').first();

  const form = userInput.locator('xpath=ancestor::form[1]');
  const formCount = await form.count().catch(() => 0);
  if (formCount > 0) {
    const btn = form.getByRole('button', { name: /^validate$/i }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 15000 });
      return { ok: true, used: 'form->Validate' };
    }
  }

  const panel = userInput.locator('xpath=ancestor::*[self::div or self::section or self::main][.//input[@name="password"]][1]');
  const panelCount = await panel.count().catch(() => 0);
  if (panelCount > 0) {
    const btn = panel.getByRole('button', { name: /^validate$/i }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 15000 });
      return { ok: true, used: 'panel->Validate' };
    }
  }

  await page.getByRole('button', { name: /^validate$/i }).first().click({ timeout: 15000 });
  return { ok: true, used: 'global->Validate' };
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
    status: 'INIT',
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

    console.log(`🔑 ${user} - 打开登录页(hash路由)...`);
    const nav = await gotoLoginPage(page, baseUrl);
    result.nav.href = nav.href || '';
    result.nav.tried = nav.tried || '';
    console.log(`🔗 ${user} - tried=${result.nav.tried}`);

    await waitForDisconnectedGone(page, 20000).catch(() => {});

    // If still NotFound -> fail early with screenshot
    if (await isNotFoundPage(page)) {
      result.status = 'FAIL_UNKNOWN';
      result.reason = '进入登录页后落入 404 Not Found（服务器不支持 /auth 这类路径；需使用 #/ 路由）';
      result.url = page.url();
      result.title = await page.title().catch(() => '');

      result.screenshot = `no_login_page_${safeName(user)}.png`;
      await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});
      const logs = await getLoginVerdictFromLogs(page, user);
      result.logsSnippet = logs.snippet || '';
      await fs.writeFile(path.join(__dirname, `logs_${safeName(user)}.txt`), result.logsSnippet, 'utf8').catch(() => {});
      return result;
    }

    const userInput = page.locator('input[name="username"]').first();
    const passInput = page.locator('input[name="password"]').first();

    if (!(await userInput.isVisible().catch(() => false))) {
      result.status = 'FAIL_UNKNOWN';
      result.reason = '无法进入登录页（未找到 username 输入框；页面结构可能变化）';
      result.url = page.url();
      result.title = await page.title().catch(() => '');

      result.screenshot = `no_login_page_${safeName(user)}.png`;
      await page.screenshot({ path: path.join(__dirname, result.screenshot), fullPage: true }).catch(() => {});
      const logs = await getLoginVerdictFromLogs(page, user);
      result.logsSnippet = logs.snippet || '';
      await fs.writeFile(path.join(__dirname, `logs_${safeName(user)}.txt`), result.logsSnippet, 'utf8').catch(() => {});
      return result;
    }

    await passInput.waitFor({ state: 'visible', timeout: 20000 });

    console.log(`📝 ${user} - 填写用户名...`);
    await userInput.fill(user);

    console.log(`🔒 ${user} - 填写密码...`);
    await passInput.fill(pass);

    console.log(`📤 ${user} - 提交登录(Validate)...`);
    const clickInfo = await clickValidateScoped(page).catch(e => ({ ok: false, used: `ERROR: ${e?.message || e}` }));
    console.log(`🧭 ${user} - Validate 点击方式: ${clickInfo.used}`);

    const anchorLoc = page.getByText(new RegExp(`authenticate \\(login: ${user}\\)`, 'i'));
    const t0 = Date.now();
    while (Date.now() - t0 < 35000) {
      if (await isDisconnected(page)) {
        await waitForDisconnectedGone(page, 15000).catch(() => {});
      }

      const topInvalid = await hasTopInvalidBanner(page);
      const ui = await getSuccessSignalsUI(page);
      const hasAnchor = await anchorLoc.first().isVisible().catch(() => false);

      if (topInvalid || ui.success || hasAnchor) break;
      await page.waitForTimeout(350);
    }

    await page.waitForTimeout(2000);

    result.url = page.url();
    result.title = await page.title().catch(() => '');
    result.evidence.disconnected = await isDisconnected(page);

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
