const puppeteer = require('puppeteer-core');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');
const log = require('./logger');

puppeteerExtra.use(StealthPlugin());

// Sanitize filename to remove invalid characters
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"|?*]/g, '_')
    .replace(/[\0]/g, '')
    .replace(/\s+/g, '_')
    .trim();
}

// Hash long filenames
function hashLongFilename(url) {
  const hash = crypto.createHash('md5').update(url).digest('hex');
  return hash;
}

// Validate and normalize URLs
function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// Check if URL is a data URI - CHECK THIS FIRST
function isDataUri(url) {
  return url && url.startsWith('data:');
}

async function downloadAsset(assetUrl, outputDir, baseUrl) {
  try {
    // FIRST: Skip data URIs before any URL processing
    if (isDataUri(assetUrl)) {
      log.debug(`[SKIP] Data URI: ${assetUrl.substring(0, 50)}...`);
      return null;
    }

    let url = assetUrl;
    
    // Handle protocol-relative URLs
    if (url.startsWith('//')) {
      url = 'https:' + url;
    } else if (url.startsWith('/')) {
      // Handle root-relative URLs
      const { origin } = new URL(baseUrl);
      url = origin + url;
    } else if (!/^https?:\/\//i.test(url)) {
      // Handle relative URLs
      const { origin, pathname } = new URL(baseUrl);
      url = origin + path.join(pathname, '..', url);
    }

    // Validate final URL
    if (!isValidUrl(url)) {
      log.debug(`[SKIP] Invalid URL: ${url}`);
      return null;
    }

    // Fetch with timeout
    const res = await fetch(url, { timeout: 15000 });
    
    if (!res.ok) {
      log.debug(`[SKIP] HTTP ${res.status}: ${url}`);
      return null;
    }

    // Parse URL and get filename
    const urlObj = new URL(url);
    let filename = path.basename(urlObj.pathname) || 'index.html';
    filename = sanitizeFilename(filename);

    // If filename is too long, hash it but keep extension
    if (filename.length > 150) {
      const ext = path.extname(filename);
      const hash = hashLongFilename(url);
      filename = hash + ext;
      log.debug(`[FILENAME] Hashed long filename to: ${filename}`);
    }

    // Use a flat structure: outputDir/hostname/filename
    // This avoids the deeply nested paths that cause ENAMETOOLONG
    const hostname = urlObj.hostname || 'unknown';
    const assetPath = path.join(outputDir, hostname, filename);
    
    // Check if the final path would be too long (Windows 260 char limit)
    if (assetPath.length > 250) {
      log.debug(`[SKIP] Path too long (${assetPath.length}): ${url}`);
      return null;
    }

    // Ensure directory exists
    await fs.ensureDir(path.dirname(assetPath));

    // Write file
    const buffer = await res.buffer();
    await fs.writeFile(assetPath, buffer);
    log.debug(`[ASSET] Downloaded: ${url}`);
    
    return { original: assetUrl, local: path.relative(outputDir, assetPath) };
  } catch (err) {
    // Handle different error types
    if (err.message && err.message.includes('ENAMETOOLONG')) {
      log.debug(`[SKIP] Filename too long: ${assetUrl}`);
    } else if (err.code === 'ENAMETOOLONG') {
      log.debug(`[SKIP] Path too long: ${assetUrl}`);
    } else {
      log.debug(`[ASSET] Failed: ${assetUrl} (${err.message})`);
    }
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
      const downloadResults = await Promise.allSettled(
        assets.map((asset) => downloadAsset(asset, outputDir, url))
      );
      
      // Count successful downloads
      const successful = downloadResults.filter(r => r.status === 'fulfilled' && r.value).length;
      const skipped = downloadResults.length - successful;
      log.info(`✅ Downloaded ${successful} assets, skipped ${skipped}`);

      // Post-process HTML to rewrite asset URLs to local files
      let htmlData = await fs.readFile(htmlFile, 'utf8');
      for (const result of downloadResults) {
        if (result.status === 'fulfilled' && result.value) {
          const res = result.value;
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
