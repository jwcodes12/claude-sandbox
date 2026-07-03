const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://localhost:8765/', { waitUntil: 'networkidle2' });
  await page.click('#btn-solo-game');
  await page.waitForSelector('#game-container:not(.hidden)');
  await new Promise(r => setTimeout(r, 300));
  const info = await page.evaluate(() => {
    const log = document.querySelector('.btn-log');
    const menu = document.querySelector('.btn-menu');
    return {
      logFound: !!log,
      logRect: log && log.getBoundingClientRect(),
      logText: log && log.textContent,
      menuRect: menu && menu.getBoundingClientRect(),
      topBarHtml: document.querySelector('.top-bar')?.innerHTML.slice(0, 500),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: '/tmp/topbar.png', clip: { x: 0, y: 0, width: 390, height: 60 } });
  await browser.close();
})();
