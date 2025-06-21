# SpectreMirror

**SpectreMirror** is a military-grade, robust, fully headless webpage cloning engine designed for professionals. It stealthily clones entire web pages, including assets, using Chromium in headless mode and advanced anti-detection techniques.

## Features

- **Headless & Stealth:** Uses puppeteer-extra-plugin-stealth to avoid detection by anti-bot systems.
- **Modular CLI:** Professional, documented, and extensible command-line interface.
- **Asset Downloading:** Recursively downloads images, CSS, and JS assets, rewriting links in the saved HTML.
- **Folder Structure Preservation:** Assets are saved using their original folder structure.
- **Logging:** Adjustable log levels for verbosity and debugging.
- **Cross-Platform:** Works on Linux, macOS, and Windows (with Chromium path adjustment).
- **Docker-Ready:** Includes Dockerfile for easy containerized deployment.

## Installation

```bash
git clone https://github.com/falconthehunter/spectremirror.git
cd spectremirror
npm install
```

## Usage

```bash
node src/cli.js --url "https://target.com" --output ./cloned-site --chromium /usr/bin/chromium --verbose
```

Or install globally:

```bash
npm install -g .
spectremirror --url "https://target.com" --output ./cloned-site
```

### CLI Options

- `-u, --url <url>`: **(required)** Webpage URL to clone
- `-o, --output <directory>`: **(required)** Output directory
- `-c, --chromium <path>`: Path to Chromium/Chrome binary (default: `/usr/bin/chromium`)
- `--no-assets`: Skip asset (images/CSS/JS) downloading
- `-v, --verbose`: Enable verbose logging

## Docker Usage

```bash
docker build -t spectremirror .
docker run --rm -v $PWD/output:/app/output spectremirror --url "https://target.com" --output /app/output
```

## Testing

```bash
npm test
```

## License

MIT License

---

**For professional/ethical use only.**  
Do not use this tool to clone or scrape sites without explicit permission.

## Contributing

PRs, bug reports, and feature requests welcome!  
See [CONTRIBUTING.md](CONTRIBUTING.md) for details.
