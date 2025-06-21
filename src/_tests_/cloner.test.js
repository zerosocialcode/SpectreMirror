const { cloneWebsite } = require('../cloner');

jest.setTimeout(120000);

test('Clones example.com homepage (no assets)', async () => {
  await expect(
    cloneWebsite({
      url: 'https://example.com',
      outputDir: './test-clone',
      chromiumPath: '/usr/bin/chromium',
      downloadAssets: false,
    })
  ).resolves.not.toThrow();
});
