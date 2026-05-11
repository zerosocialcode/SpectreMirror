const puppeteer = require('puppeteer-core');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');
const log = require('./logger');

puppeteerExtra.use(StealthPlugin());

// Max filename length for most filesystems (255 bytes)
const MAX_FILENAME_LENGTH = 200;

// Sanitize filename to remove invalid characters
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"|?*]/g, '_') // Invalid chars on Windows
    .replace(/[\0]/g, '') // Null bytes
    .replace(/\s+/g, '_') // Multiple spaces
    .trim();
}

// Handle long filenames by hashing them
function handleLongFilename(url, originalFilename) {
  let filename = sanitizeFilename(originalFilename);
  
  if (filename.length > MAX_FILENAME_LENGTH) {
    // Get file extension
    const ext = path.extname(filename) || '';
    // Hash the full URL to create a short unique name
    const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 8);
    filename = hash + ext;
    log.debug(`[FILENAME] Hashed long URL to: ${filename}`);
  }
  
  return filename;
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

// Check if URL is a data URI
function isDataUri(url) {
  return url.startsWith('data:');
}

async function downloadAsset(assetUrl, outputDir, baseUrl) {
  try {
    // Skip data URIs (they're inline and don't need downloading)
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

    // Parse URL and remove query parameters
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const hostname = urlObj.hostname;
    let filename = path.basename(pathname) || 'index.html';

    // Handle long filenames
    filename = handleLongFilename(url, filename);

    // Build asset path
    const assetPath = path.join(outputDir, hostname, pathname.replace(/\/[^\/]*$/, ''), filename);
    
    // Ensure directory exists
    await fs.ensureDir(path.dirname(assetPath));

    // Check if path is too long before writing
    if (assetPath.length > 260) {
      log.debug(`[SKIP] Full path exceeds length limit: ${assetPath.substring(0, 50)}...`);
      return null;
    }

    // Write file
    const buffer = await res.buffer();
    await fs.writeFile(assetPath, buffer);
    log.debug(`[ASSET] Downloaded: ${url}`);
    
    return { original: assetUrl, local: path.relative(outputDir, assetPath) };
  } catch (err) {
    // Only log non-404 errors as warnings; 404s are expected for some assets
    if (err.message.includes('404')) {
      log.debug(`[SKIP] HTTP 404: ${assetUrl}`);
    } else if (err.message.includes('ENAMETOOLONG')) {
      log.debug(`[SKIP] Filename too long: ${assetUrl}`);
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
