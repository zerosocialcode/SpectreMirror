const puppeteer = require('puppeteer-core');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const log = require('./logger');

puppeteerExtra.use(StealthPlugin());

async function downloadAsset(assetUrl, outputDir, baseUrl) {
  try {
    let url = assetUrl;
    if (url.startsWith('//')) {
      url = 'https:' + url;
    } else if (url.startsWith('/')) {
      const { origin } = new URL(baseUrl);
      url = origin + url;
    } else if (!/^https?:\/\//i.test(url)) {
      const { origin, pathname } = new URL(baseUrl);
      url = origin + path.join(pathname, '..', url);
    }

    const res = await fetch(url, { timeout: 20000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const subPath = url.replace(/^https?:\/\//, '').replace(/\?.*$/, '');
    const assetPath = path.join(outputDir, subPath);
    await fs.ensureDir(path.dirname(assetPath));
    const buffer = await res.buffer();
    await fs.writeFile(assetPath, buffer);
    log.debug(`[ASSET] Downloaded: ${url} → ${assetPath}`);
    return { original: assetUrl, local: path.relative(outputDir, assetPath) };
  } catch (err) {
    log.warn(`[ASSET] Failed: ${assetUrl} (${err.message})`);
    return null;
  }
}

async function cloneWebsite({ url, outputDir, chromiumPath, downloadAssets = true }) {
  log.info(`🔍 Launching Chromium from: ${chromiumPath}`);
  const browser = await puppeteerExtra.launch({
    headless: true,
    executablePath: chromiumPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1920,1080',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    log.info(`🌐 Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    const html = await page.content();
    await fs.ensureDir(outputDir);
    const htmlFile = path.join(outputDir, 'index.html');
    await fs.writeFile(htmlFile, html);
    log.info(`💾 Saved HTML: ${htmlFile}`);

    if (downloadAssets) {
      log.info('🕸️  Discovering page assets...');
      const assets = await page.evaluate(() =>
        Array.from(document.querySelectorAll('img, link[rel="stylesheet"], script[src]')).map((el) => {
          if (el.tagName === 'IMG') return el.src;
          if (el.tagName === 'LINK') return el.href;
          if (el.tagName === 'SCRIPT') return el.src;
          return '';
        }).filter(Boolean)
      );

      log.info(`📦 Found ${assets.length} assets. Downloading...`);
      const downloadResults = await Promise.all(
        assets.map((asset) => downloadAsset(asset, outputDir, url))
      );
      // Optional: post-process HTML to rewrite asset URLs to local files
      let htmlData = await fs.readFile(htmlFile, 'utf8');
      for (const res of downloadResults) {
        if (res) {
          htmlData = htmlData.split(res.original).join(res.local.replace(/\\/g, '/'));
        }
      }
      await fs.writeFile(htmlFile, htmlData);
      log.info(`🔗 Rewrote asset URLs in: ${htmlFile}`);
    }
  } finally {
    await browser.close();
    log.debug('🛑 Chromium closed.');
  }
}

module.exports = { cloneWebsite };
