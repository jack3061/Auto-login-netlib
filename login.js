const puppeteer = require('puppeteer');

(async () => {
  // -------------------------------------------------------------
  // 1. 初始化环境：针对 GitHub Action 和 Cloudflare 优化
  // -------------------------------------------------------------
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled', // 抹除部分 webdriver 特征
      '--window-size=1920,1080'
    ]
  });

  const page = await browser.newPage();
  
  // 伪装 User-Agent，防止简单的 UA 封锁
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // 从环境变量获取机密
  const username = process.env.USERNAME;
  const password = process.env.PASSWORD;

  if (!username || !password) {
    console.error('❌ 配置错误：缺少 USERNAME 或 PASSWORD 环境变量');
    process.exit(1);
  }

  try {
    console.log(`🚀 正在访问登录页...`);
    // 增加超时时间以应对网络波动
    await page.goto('https://netlib.re/login', { waitUntil: 'networkidle0', timeout: 60000 });

    // -------------------------------------------------------------
    // 2. 模拟真人操作：输入与点击
    // -------------------------------------------------------------
    console.log('✍️ 正在输入凭证...');
    
    // 等待输入框，如果连输入框都加载不出来，直接抛错
    await page.waitForSelector('input[name="identity"]', { timeout: 15000 });
    
    // 带延迟的输入，模拟人类打字
    await page.type('input[name="identity"]', username, { delay: 130 });
    await page.type('input[name="password"]', password, { delay: 120 });

    console.log('👆 提交登录...');
    const submitSelector = 'button[type="submit"], input[type="submit"]';
    await page.waitForSelector(submitSelector);

    // 并发执行：点击后必须等待导航完成
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }).catch(e => console.log('⚠️ 导航超时或无跳转，继续检查页面内容...')), 
      page.click(submitSelector)
    ]);

    // -------------------------------------------------------------
    // 3. 【Diamond 核心】结果指纹验证
    // -------------------------------------------------------------
    console.log('🕵️ 正在进行指纹验证...');
    
    // 获取页面快照
    const content = await page.content();
    const currentUrl = page.url();

    // 特征库定义
    const fingerprints = {
      // 成功特征：必须包含这些词之一 (根据 Netlib 英文后台调整)
      success: /Logout|Sign out|Dashboard|My Domains|Welcome/i,
      // 失败特征：明确的错误提示
      authError: /Invalid credentials|Wrong password|User not found|Login failed/i,
      // 拦截特征：Cloudflare
      cloudflare: /Verify you are human|Just a moment|Challenge/i
    };

    // --- 判定逻辑 ---

    // 1. 优先检查是否被墙
    if (fingerprints.cloudflare.test(content)) {
      throw new Error('⛔️ 登录失败：遭遇 Cloudflare 5秒盾拦截。IP被标记。');
    }

    // 2. 检查是否有明确的密码错误提示
    if (fingerprints.authError.test(content)) {
      throw new Error('❌ 登录失败：网站提示账号或密码错误（请检查 Secrets 配置）。');
    }

    // 3. 终极校验：如果还在登录页 URL，且没有成功关键词 -> 失败
    const isStillOnLoginPage = currentUrl.includes('/login');
    const hasSuccessText = fingerprints.success.test(content);

    if (hasSuccessText) {
      console.log('✅ 登录成功：检测到后台特征关键词。');
      // 可选：在这里添加截图证明成功
      // await page.screenshot({ path: 'success_proof.png' });
    } else if (isStillOnLoginPage) {
      throw new Error('❌ 登录失败：页面仍停留在登录页，且未检测到成功特征。');
    } else {
      // URL 变了，但没找到成功关键词，可能是未知页面
      console.warn('⚠️ 警告：URL已跳转，但未检测到标准成功特征。可能网站改版。');
      console.log(`当前 URL: ${currentUrl}`);
      // 这种情况下姑且算成功，但记录警告
    }

  } catch (error) {
    console.error(`💥 运行终止: ${error.message}`);
    
    // -------------------------------------------------------------
    // 4. 尸检：保存现场截图
    // -------------------------------------------------------------
    try {
      await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
      console.log('📸 已保存现场截图: debug_screenshot.png (请在 Artifacts 查看)');
    } catch (e) {
      console.error('截图失败:', e);
    }
    
    process.exit(1); // 强制让 Action 变红
  } finally {
    await browser.close();
  }
})();
