#!/usr/bin/env node
const { program } = require('commander');
const { cloneWebsite } = require('./cloner');
const pkg = require('../package.json');
const log = require('./logger');

program
  .name('spectremirror')
  .version(pkg.version)
  .description(pkg.description)
  .requiredOption('-u, --url <url>', 'URL of the webpage to clone')
  .requiredOption('-o, --output <directory>', 'Output directory for the cloned site')
  .option('-c, --chromium <path>', 'Path to Chromium/Chrome binary', '/usr/bin/chromium')
  .option('--no-assets', 'Do not download assets (images, CSS, JS)')
  .option('-v, --verbose', 'Enable verbose logging')
  .parse(process.argv);

if (program.opts().verbose) {
  log.setLevel('debug');
} else {
  log.setLevel('info');
}

(async () => {
  try {
    await cloneWebsite({
      url: program.opts().url,
      outputDir: program.opts().output,
      chromiumPath: program.opts().chromium,
      downloadAssets: program.opts().assets,
    });
    log.info('✅ Cloning completed successfully!');
  } catch (err) {
    log.error(`❌ ${err.message}`);
    process.exit(1);
  }
})();
