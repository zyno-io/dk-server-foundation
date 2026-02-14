# Documentation Site Development

This directory contains the VitePress-based documentation site for @signal24/dk-server-foundation.

## Local Development

### Prerequisites

- Node.js 18+ 
- Yarn package manager

### Install Dependencies

From the repository root:

```bash
yarn install
```

### Development Server

Start the VitePress development server with hot reload:

```bash
yarn docs:dev
```

The site will be available at `http://localhost:5173`

### Build

Build the static site for production:

```bash
yarn docs:build
```

The built site will be in `docs/.vitepress/dist`

### Preview

Preview the production build locally:

```bash
yarn docs:preview
```

## Structure

```
docs/
├── .vitepress/
│   ├── config.mts          # VitePress configuration
│   └── dist/               # Build output (generated)
├── public/
│   └── images/
│       └── devconsole/     # DevConsole screenshots
├── guides/                 # Guide documents
├── index.md                # Home page (hero layout)
├── getting-started.md      # Getting started guide
├── configuration.md        # Configuration reference
├── database.md             # Database documentation
├── http.md                 # HTTP documentation
├── authentication.md       # Authentication documentation
├── worker.md               # Workers documentation
├── srpc.md                 # SRPC documentation
├── devconsole.md           # DevConsole documentation
└── ...                     # Other documentation files
```

## Adding Documentation

1. Create or edit Markdown files in `docs/`
2. Update the sidebar in `.vitepress/config.mts` if adding new pages
3. Use standard Markdown with VitePress enhancements

## Adding Images

Place images in `docs/public/images/` and reference them with `/images/...` in Markdown:

```markdown
![Alt text](/images/example.png)
```

## Capturing DevConsole Screenshots

To update the DevConsole screenshots used in the documentation:

### Prerequisites

1. Install Playwright:
   ```bash
   npm install -D @playwright/test
   npx playwright install chromium
   ```

2. Ensure MySQL and Redis are running

### Capture Screenshots

1. In one terminal, start the demo app:
   ```bash
   yarn demoapp
   ```

2. Wait for the server to start (you'll see "Server started" message)

3. In another terminal, run the screenshot capture script:
   ```bash
   yarn docs:screenshots
   ```

This will automatically:
- Navigate through all 13 DevConsole views
- Wait for each page to load completely
- Capture full-page screenshots
- Save them to `docs/public/images/devconsole/`

For headless mode (faster, no visible browser):
```bash
yarn docs:screenshots:headless
```

See `scripts/README-SCREENSHOTS.md` for detailed instructions and troubleshooting.

## Deployment

The documentation is automatically deployed to GitHub Pages when changes are pushed to the `main` branch. The workflow is defined in `.github/workflows/deploy-docs.yml`.

### Manual Deployment

To trigger a manual deployment, go to the Actions tab in GitHub and run the "Deploy Documentation" workflow.

## Links

- [VitePress Documentation](https://vitepress.dev/)
- [Main Repository](https://github.com/signal24/dk-server-foundation)
- [Published Documentation](https://signal24.github.io/dk-server-foundation/)
