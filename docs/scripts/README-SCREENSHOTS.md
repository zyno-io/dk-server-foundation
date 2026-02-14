# DevConsole Screenshot Capture

This directory contains a script to capture DevConsole screenshots for documentation.

## Prerequisites

1. **Install dependencies** (if not already done):
   ```bash
   cd docs && yarn install
   ```

2. **Install Playwright browsers**:
   ```bash
   cd docs && npx playwright install chromium
   ```

3. **Ensure services are running**:
   - MySQL server
   - Redis server

## Usage

### Step 1: Start the Demo Application

In one terminal window, start the demoapp:

```bash
yarn demoapp
```

Wait for the output to show:
```
DevConsole:  http://localhost:3000/_devconsole/
Server started.
```

### Step 2: Run the Screenshot Capture Script

In another terminal window, run:

```bash
yarn screenshots
```

This will:
- Open a Chromium browser (visible by default)
- Navigate through all 10 DevConsole views in order
- Wait for each page to load completely
- Capture full-page screenshots
- Save them to `docs/content/public/images/devconsole/`

### Options

```bash
# Run in headless mode (faster, no visible browser)
yarn screenshots:headless

# Use custom URL
yarn screenshots --url http://localhost:3001/_devconsole

# Use custom output directory
yarn screenshots --output ./screenshots

# Custom wait time between navigations (in milliseconds)
yarn screenshots --wait 3000
```

## Screenshots Captured

The script captures all DevConsole views in navigation order:

1. **01-dashboard.png** - Dashboard with app metrics
2. **02-routes.png** - HTTP Routes listing
3. **03-openapi.png** - OpenAPI Schema viewer
4. **04-requests.png** - HTTP Request detail drill-down
5. **05-srpc.png** - SRPC message request/response detail
6. **06-database.png** - Database query results
7. **07-health.png** - Health checks status
8. **08-mutex.png** - Mutex monitor
9. **09-repl.png** - Interactive REPL
10. **10-workers.png** - Workers/BullMQ monitor

## Troubleshooting

### "Connection refused" or "Navigation timeout"

Make sure the demoapp is running:
```bash
yarn demoapp
```

Check that you can access http://localhost:3000/_devconsole in your browser.

### Browser not found

Install Playwright browsers:
```bash
npx playwright install chromium
```

### Screenshots are blank or incomplete

Increase the wait time:
```bash
yarn screenshots --wait 8000
```

### MySQL or Redis connection errors

Ensure MySQL and Redis services are running:
```bash
# MySQL
sudo service mysql start

# Redis
sudo service redis-server start
```

## Manual Verification

After running the script, verify the screenshots:

1. Open `docs/content/public/images/devconsole/` directory
2. Check that all 10 PNG files exist
3. Open each image to verify:
   - Correct view is captured
   - Page is fully loaded
   - No loading spinners visible
   - Content is clearly visible

## Rebuilding Documentation

After capturing new screenshots, rebuild the docs:

```bash
yarn docs:build
```

Then preview locally:

```bash
yarn docs:preview
```

Open http://localhost:4173/dk-server-foundation/ to verify the documentation site with new screenshots.
