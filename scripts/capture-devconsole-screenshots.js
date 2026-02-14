#!/usr/bin/env node

/**
 * DevConsole Screenshot Capture Script
 * 
 * This script uses Playwright to capture screenshots of all DevConsole views
 * in the correct navigation order with proper wait times.
 * 
 * Prerequisites:
 * 1. Install Playwright: npm install -D @playwright/test
 * 2. Install browsers: npx playwright install chromium
 * 3. Start the demoapp: yarn demoapp
 * 4. Wait for the server to be ready (check console output)
 * 
 * Usage:
 *   node scripts/capture-devconsole-screenshots.js [options]
 * 
 * Options:
 *   --url <url>       DevConsole URL (default: http://localhost:3000/_devconsole)
 *   --output <dir>    Output directory (default: docs/public/images/devconsole)
 *   --wait <ms>       Wait time between navigations (default: 5000)
 *   --headless        Run in headless mode (default: false for visibility)
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Parse command line arguments
const args = process.argv.slice(2);
const getArg = (name, defaultValue) => {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] ? args[index + 1] : defaultValue;
};

const config = {
  baseUrl: getArg('--url', 'http://localhost:3000/_devconsole'),
  outputDir: getArg('--output', path.join(__dirname, '..', 'docs', 'public', 'images', 'devconsole')),
  waitTime: parseInt(getArg('--wait', '5000')),
  headless: args.includes('--headless')
};

// DevConsole views in navigation order
const views = [
  { name: 'Dashboard', path: '#/', filename: '01-dashboard.png' },
  { name: 'Routes', path: '#/routes', filename: '02-routes.png' },
  { name: 'OpenAPI', path: '#/openapi', filename: '03-openapi.png' },
  { name: 'Requests', path: '#/requests', filename: '04-requests.png' },
  { name: 'Requests Detail', path: '#/requests', filename: '05-requests-detail.png', action: 'clickFirst' },
  { name: 'SRPC', path: '#/srpc', filename: '06-srpc.png' },
  { name: 'SRPC Detail', path: '#/srpc', filename: '07-srpc-detail.png', action: 'clickFirst' },
  { name: 'Database', path: '#/database', filename: '08-database.png' },
  { name: 'Database Detail', path: '#/database?table=notes', filename: '09-database-detail.png', action: 'clickNotes' },
  { name: 'Health', path: '#/health', filename: '10-health.png' },
  { name: 'Mutex', path: '#/mutex', filename: '11-mutex.png' },
  { name: 'REPL', path: '#/repl', filename: '12-repl.png' },
  { name: 'Workers', path: '#/workers', filename: '13-workers.png' }
];

async function waitForDevConsole(page) {
  // Wait for DevConsole to be fully loaded
  await page.waitForSelector('text=DevConsole', { timeout: 30000 });
  await page.waitForLoadState('networkidle');
}

async function captureScreenshot(page, view, outputPath) {
  console.log(`📸 Capturing: ${view.name}`);
  
  // Navigate to the view
  const url = `${config.baseUrl}${view.path}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  
  // Wait for the page to stabilize
  await page.waitForTimeout(config.waitTime);
  
  // Handle special actions
  if (view.action === 'clickFirst') {
    // Click on the first row in a table to show detail view
    try {
      const firstRow = await page.locator('table tbody tr').first();
      if (await firstRow.isVisible()) {
        await firstRow.click();
        await page.waitForTimeout(3000);
      }
    } catch (error) {
      console.warn(`  ⚠️  Could not click first row for ${view.name}`);
    }
  } else if (view.action === 'clickNotes') {
    // Click on notes entity in database view
    try {
      const notesEntity = await page.locator('text=notes').last();
      if (await notesEntity.isVisible()) {
        await notesEntity.click();
        await page.waitForTimeout(3000);
      }
    } catch (error) {
      console.warn(`  ⚠️  Could not click notes entity for ${view.name}`);
    }
  }
  
  // Take full page screenshot
  await page.screenshot({
    path: outputPath,
    fullPage: true,
    type: 'png'
  });
  
  console.log(`  ✅ Saved to: ${outputPath}`);
}

async function main() {
  console.log('🚀 DevConsole Screenshot Capture Script');
  console.log('========================================');
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Output Directory: ${config.outputDir}`);
  console.log(`Wait Time: ${config.waitTime}ms`);
  console.log(`Headless: ${config.headless}`);
  console.log('');
  
  // Ensure output directory exists
  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
    console.log(`📁 Created output directory: ${config.outputDir}`);
  }
  
  // Launch browser
  console.log('🌐 Launching browser...');
  const browser = await chromium.launch({
    headless: config.headless,
    args: ['--no-sandbox']
  });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1
  });
  
  const page = await context.newPage();
  
  try {
    // Navigate to DevConsole
    console.log('📍 Navigating to DevConsole...');
    await page.goto(config.baseUrl, { waitUntil: 'networkidle' });
    await waitForDevConsole(page);
    console.log('✅ DevConsole loaded successfully\n');
    
    // Capture each view
    for (const view of views) {
      const outputPath = path.join(config.outputDir, view.filename);
      await captureScreenshot(page, view, outputPath);
      
      // Brief pause between captures
      await page.waitForTimeout(1000);
    }
    
    console.log('\n🎉 All screenshots captured successfully!');
    console.log(`📁 Screenshots saved to: ${config.outputDir}`);
    
  } catch (error) {
    console.error('❌ Error capturing screenshots:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

// Run the script
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
