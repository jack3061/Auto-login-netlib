const axios = require('axios');
const { chromium } = require('playwright');

const token = process.env.BOT_TOKEN;
const chatId = process.env.CHAT_ID;
const accounts = process.env.ACCOUNTS;

if (!accounts) {
  console.log('❌ 未配置账号');
  process.exit(1);
}

const accountList = accounts.split(/[,;]/).map(account => {
  const [user, pass] = account.split(":").map(s => s.trim());
  return { user, pass };
}).filter(acc => acc.user && acc.pass);

if (accountList.length === 0) {
  console.log('❌ 账号格式错误');
  process.exit(1);
}

async function sendTelegram(message) {
  if (!token || !chatId) return;
  const now = new Date();
  const hkTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  const timeStr = hkTime.toISOString().replace('T', ' ').substr(0, 19) + " HKT";
  const fullMessage = `🎉 Netlib 登录通知\n\n登录时间：${timeStr}\n\n${message}`;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: fullMessage
    }, { timeout: 10000 });
    console.log('✅ Telegram 通知发送成功');
  } catch (e) {
    console.log('⚠️ Telegram 发送失败');
  }
}

async function loginWithAccount(user, pass) {
  console.log(`🚀 开始登录: ${user}`);
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  let page;
  let result = { user, success: false, message: '' };
  
  try {
    page = await browser.newPage();
    page.setDefaultTimeout(30000);
    
    console.log(`📱 ${user} - 正在访问网站...`);
    await page.goto('https://www.netlib.re/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    
    console.log(`🔑 ${user} - 点击登录按钮...`);
    await page.click('text=Login', { timeout: 5000 });
    await page.waitForTimeout(2000);
    
    console.log(`📝 ${user} - 填写用户名...`);
    await page.fill('input[name="username"], input[type="text"]', user);
    await page.waitForTimeout(1000);
    
    console.log(`🔒 ${user} - 填写密码...`);
    await page.fill('input[name="password"], input[type="password"]', pass);
    await page.waitForTimeout(1000);
    
    console.log(`📤 ${user} - 提交登录...`);
    await page.click('button:has-text("Validate"), input[type="submit"]');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(8000);
    
    const pageText = await page.evaluate(() => document.body.innerText);
    
    console.log(`==== DEBUG START ====`);
    console.log(`Invalid credentials: ${pageText.includes('Invalid credentials')}`);
    console.log(`Authenticated to authd: ${pageText.includes('Authenticated to authd')}`);
    console.log(`Authenticated to dnsmanagerd: ${pageText.includes('Authenticated to dnsmanagerd')}`);
    console.log(`==== DEBUG END ====`);
    
    const hasError = pageText.includes('Invalid credentials');
    const authOK = pageText.includes('Authenticated to authd');
    const dnsOK = pageText.includes('Authenticated to dnsmanagerd');
    
    if (hasError) {
      console.log(`❌ ${user} - 登录失败: 密码错误`);
      result.message = `❌ ${user} 登录失败`;
    } else if (authOK && dnsOK) {
      console.log(`✅ ${user} - 登录成功`);
      result.success = true;
      result.message = `✅ ${user} 登录成功`;
    } else {
      console.log(`❌ ${user} - 登录失败`);
      result.message = `❌ ${user} 登录失败`;
    }
  } catch (e) {
    console.log(`❌ ${user} - 异常: ${e.message}`);
    result.message = `❌ ${user} 登录异常`;
  } finally {
    if (page) await page.close();
    await browser.close();
  }
  return result;
}

async function main() {
  console.log(`🔍 发现 ${accountList.length} 个账号`);
  const results = [];
  for (let i = 0; i < accountList.length; i++) {
    const { user, pass } = accountList[i];
    console.log(`📋 处理第 ${i + 1}/${accountList.length} 个账号: ${user}`);
    const result = await loginWithAccount(user, pass);
    results.push(result);
    if (i < accountList.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
  const successCount = results.filter(r => r.success).length;
  let summaryMessage = `📊 登录汇总: ${successCount}/${results.length} 成功\n\n`;
  results.forEach(r => { summaryMessage += `${r.message}\n`; });
  await sendTelegram(summaryMessage);
  console.log('✅ 所有账号处理完成！');
}

main().catch(console.error);
