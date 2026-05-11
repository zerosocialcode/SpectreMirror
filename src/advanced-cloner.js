const puppeteer = require('puppeteer-core');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');
const log = require('./logger');
const { URL } = require('url');

puppeteerExtra.use(StealthPlugin());

class AdvancedCloner {
  constructor(options = {}) {
    this.baseUrl = options.url;
    this.outputDir = options.outputDir;
    this.chromiumPath = options.chromiumPath || '/usr/bin/chromium';
    this.downloadAssets = options.downloadAssets !== false;
    this.keepExternalLinks = options.keepExternalLinks !== false;
    
    this.downloadedAssets = new Map(); // Track downloaded assets
    this.failedAssets = new Set(); // Track failed assets
    this.processedUrls = new Set(); // Prevent duplicate downloads
  }

  /**
   * Get safe filename from URL
   */
  getSafeFilename(urlString) {
    try {
      const urlObj = new URL(urlString);
      let filename = path.basename(urlObj.pathname);
      
      if (!filename || filename === '/') {
        filename = 'index.html';
      }
      
      // Remove query parameters for filename
      filename = filename.split('?')[0];
      
      // If filename is still too long, hash it
      if (filename.length > 200) {
        const ext = path.extname(filename);
        const hash = crypto.createHash('md5').update(urlString).digest('hex').substring(0, 8);
        filename = hash + ext;
      }
      
      return filename;
    } catch (err) {
      return crypto.createHash('md5').update(urlString).digest('hex').substring(0, 8);
    }
  }

  /**
   * Download a single asset with retry logic
   */
  async downloadAsset(assetUrl) {
    // Skip if already processed
    if (this.processedUrls.has(assetUrl)) {
      return this.downloadedAssets.get(assetUrl) || null;
    }

    try {
      // Skip data URIs
      if (assetUrl.startsWith('data:')) {
        log.debug(`[SKIP] Data URI`);
        return null;
      }

      // Validate URL
      let fullUrl = assetUrl;
      if (assetUrl.startsWith('//')) {
        fullUrl = 'https:' + assetUrl;
      } else if (assetUrl.startsWith('/')) {
        const baseUrlObj = new URL(this.baseUrl);
        fullUrl = baseUrlObj.origin + assetUrl;
      } else if (!assetUrl.match(/^https?:\/\//)) {
        // Relative URL
        const baseUrlObj = new URL(this.baseUrl);
        fullUrl = new URL(assetUrl, this.baseUrl).href;
      }

      // Validate it's a real URL
      new URL(fullUrl); // Will throw if invalid

      this.processedUrls.add(assetUrl);

      // Try to fetch with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      const response = await fetch(fullUrl, {
        signal: controller.signal,
        timeout: 12000,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        log.debug(`[SKIP] HTTP ${response.status}`);
        this.failedAssets.add(assetUrl);
        return null;
      }

      // Get filename
      const filename = this.getSafeFilename(fullUrl);
      const assetPath = path.join(this.outputDir, 'assets', filename);

      // Ensure directory exists
      await fs.ensureDir(path.dirname(assetPath));

      // Write file
      const buffer = await response.buffer();
      await fs.writeFile(assetPath, buffer);

      const relativePath = path.relative(this.outputDir, assetPath).replace(/\\/g, '/');
      log.debug(`[ASSET] Downloaded: ${filename}`);

      this.downloadedAssets.set(assetUrl, relativePath);
      return relativePath;
    } catch (err) {
      log.debug(`[ASSET] Failed: ${err.message}`);
      this.failedAssets.add(assetUrl);
      this.processedUrls.add(assetUrl);
      return null;
    }
  }

  /**
   * Rewrite HTML with smart asset replacement and link handling
   */
  async processHtml(html) {
    let processed = html;

    // Process img tags: download and cache with fallback
    const imgRegex = /<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi;
    let match;
    const imgReplacements = new Map();

    while ((match = imgRegex.exec(html)) !== null) {
      const originalSrc = match[2];
      const localPath = await this.downloadAsset(originalSrc);

      if (localPath) {
        imgReplacements.set(
          match[0],
          `<img ${match[1]}src="${localPath}" onerror="this.src='${originalSrc}'" ${match[3]}>`
        );
      } else {
        // Keep original, ensure it's absolute URL
        let safeSrc = originalSrc;
        if (originalSrc.startsWith('/')) {
          const baseUrlObj = new URL(this.baseUrl);
          safeSrc = baseUrlObj.origin + originalSrc;
        }
        imgReplacements.set(match[0], `<img ${match[1]}src="${safeSrc}" ${match[3]}>`);
      }
    }

    // Apply img replacements
    imgReplacements.forEach((replacement, original) => {
      processed = processed.split(original).join(replacement);
    });

    // Process script src tags: download and cache
    const scriptRegex = /<script\s+([^>]*?)src=["']([^"']+)["']([^>]*?)><\/script>/gi;
    const scriptReplacements = new Map();

    while ((match = scriptRegex.exec(html)) !== null) {
      const originalSrc = match[2];
      const localPath = await this.downloadAsset(originalSrc);

      if (localPath) {
        scriptReplacements.set(
          match[0],
          `<script ${match[1]}src="${localPath}" ${match[3]}></script>`
        );
      } else {
        // Keep original, ensure absolute URL
        let safeSrc = originalSrc;
        if (originalSrc.startsWith('/')) {
          const baseUrlObj = new URL(this.baseUrl);
          safeSrc = baseUrlObj.origin + originalSrc;
        }
        scriptReplacements.set(match[0], `<script ${match[1]}src="${safeSrc}" ${match[3]}></script>`);
      }
    }

    // Apply script replacements
    scriptReplacements.forEach((replacement, original) => {
      processed = processed.split(original).join(replacement);
    });

    // Process link href for stylesheets: download and cache
    const linkRegex = /<link\s+([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi;
    const linkReplacements = new Map();

    while ((match = linkRegex.exec(html)) !== null) {
      const originalHref = match[2];
      // Only process CSS stylesheets
      if (match[0].includes('stylesheet')) {
        const localPath = await this.downloadAsset(originalHref);

        if (localPath) {
          linkReplacements.set(
            match[0],
            `<link ${match[1]}href="${localPath}" ${match[3]}>`
          );
        } else {
          // Keep original
          let safeHref = originalHref;
          if (originalHref.startsWith('/')) {
            const baseUrlObj = new URL(this.baseUrl);
            safeHref = baseUrlObj.origin + originalHref;
          }
          linkReplacements.set(match[0], `<link ${match[1]}href="${safeHref}" ${match[3]}>`);
        }
      }
    }

    // Apply link replacements
    linkReplacements.forEach((replacement, original) => {
      processed = processed.split(original).join(replacement);
    });

    // Ensure all links are absolute URLs (don't break them)
    if (this.keepExternalLinks) {
      const anchorRegex = /<a\s+([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi;
      const anchorReplacements = new Map();

      while ((match = anchorRegex.exec(processed)) !== null) {
        const originalHref = match[2];

        // Only fix relative links to be absolute
        if (originalHref.startsWith('/')) {
          const baseUrlObj = new URL(this.baseUrl);
          const absoluteHref = baseUrlObj.origin + originalHref;
          anchorReplacements.set(
            match[0],
            `<a ${match[1]}href="${absoluteHref}" ${match[3]}>`
          );
        }
      }

      // Apply anchor replacements
      anchorReplacements.forEach((replacement, original) => {
        processed = processed.split(original).join(replacement);
      });
    }

    return processed;
  }

  /**
   * Main cloning function
   */
  async clone() {
    log.info(`🔍 Launching Chromium from: ${this.chromiumPath}`);
    const browser = await puppeteerExtra.launch({
      headless: true,
      executablePath: this.chromiumPath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    try {
      const page = await browser.newPage();

      // Set realistic user agent
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      log.info(`🌐 Navigating to: ${this.baseUrl}`);
      await page.goto(this.baseUrl, { waitUntil: 'networkidle2', timeout: 60000 });

      // Get HTML
      let html = await page.content();
      log.info(`💾 Retrieved page content`);

      // Ensure output directory exists
      await fs.ensureDir(this.outputDir);

      // Process HTML if downloading assets
      if (this.downloadAssets) {
        log.info('🕸️ Processing assets...');
        html = await this.processHtml(html);
        log.info(`✅ Downloaded ${this.downloadedAssets.size} assets`);
        
        if (this.failedAssets.size > 0) {
          log.info(`⚠️  Skipped ${this.failedAssets.size} assets (will load from remote)`);
        }
      }

      // Write processed HTML
      const indexPath = path.join(this.outputDir, 'index.html');
      await fs.writeFile(indexPath, html);
      log.info(`💾 Saved to: ${indexPath}`);

      // Create assets directory marker
      const assetsDir = path.join(this.outputDir, 'assets');
      await fs.ensureDir(assetsDir);

      // Save metadata
      const metadataPath = path.join(this.outputDir, '.spectremirror.json');
      await fs.writeFile(
        metadataPath,
        JSON.stringify(
          {
            clonedAt: new Date().toISOString(),
            sourceUrl: this.baseUrl,
            assetsDownloaded: this.downloadedAssets.size,
            assetsFailed: this.failedAssets.size,
          },
          null,
          2
        )
      );

      await page.close();
    } finally {
      await browser.close();
      log.debug('🛑 Chromium closed.');
    }
  }
}

async function cloneWebsite(options) {
  const cloner = new AdvancedCloner(options);
  await cloner.clone();
}

module.exports = { cloneWebsite };
