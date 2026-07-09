const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Helper to pause execution for a random duration (simulates human reading/thinking)
const sleep = (min, max) => new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1) + min)));

async function generateImage(prompt) {
    console.log('Connecting to running Chrome instance (CDP on port 9222)...');
    let browser;
    try {
        browser = await chromium.connectOverCDP('http://localhost:9222');
    } catch (e) {
        console.error("❌ Failed to connect to Chrome.");
        console.error("Did you start Chrome with: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --user-data-dir=\"/Users/john.watkins/chrome-bot-profile\" ?");
        process.exit(1);
    }

    const context = browser.contexts()[0];
    
    // [ANTI-FOCUS-STEAL & CONCURRENCY] Use a pool of up to 10 tabs.
    // Find the first tab that isn't currently doing anything, or open a new one if we have less than 10.
    const pages = context.pages();
    let page = null;
    
    for (const p of pages) {
        // A simple heuristic to check if a tab is 'idle' - we check if its URL is our base URL or blank
        // (This prevents us from taking over a tab that is actively generating an image for another script run)
        if (p.url() === 'about:blank' || p.url() === 'https://gemini.google.com/app') {
            page = p;
            break;
        }
    }

    if (!page) {
        if (pages.length < 10) {
            console.log('Opening a new tab in the pool...');
            page = await context.newPage();
        } else {
            console.log('All 10 tabs in the pool are busy. Reusing the oldest tab...');
            page = pages[0]; // Fallback if all 10 are somehow busy (or if heuristic failed)
        }
    } else {
        console.log('Reusing an idle tab from the pool...');
    }

    // [ANTI-FOCUS-STEAL] Force macOS to completely hide the Chrome application (like pressing Cmd+H)
    require('child_process').exec('osascript -e \'tell application "System Events" to set visible of process "Google Chrome" to false\'');

    try {
        console.log('Navigating to Gemini...');
        await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
        
        // [ANTI-BAN] Wait a random amount of time before interacting, like a human taking in the page.
        await sleep(3000, 6000);

        console.log('Finding chat box...');
        // Gemini uses a custom rich-text editor element. 
        const inputSelector = 'rich-textarea p, .ql-editor'; 
        await page.waitForSelector(inputSelector, { state: 'visible', timeout: 15000 });
        
        // [ANTI-BAN] Click the box, then pause before typing
        await page.locator(inputSelector).first().click();
        await sleep(800, 1800);
        
        console.log(`Typing prompt: "${prompt}"`);
        // [ANTI-BAN] Type with a random delay between keystrokes to mimic a human typing speed
        await page.keyboard.type(prompt, { delay: 75 }); 
        
        // [ANTI-BAN] Pause after typing before hitting enter
        await sleep(1000, 2500);
        
        console.log('Sending message...');
        await page.keyboard.press('Enter');

        console.log('Waiting for generation to finish... (This takes 15-30 seconds)');
        
        // Generating images takes time. Instead of failing if a selector changes, 
        // we do a solid human-like wait to let the AI process the request.
        await sleep(20000, 25000); 

        // Let's look for images in the newest message.
        // Note: CSS selectors on Google sites change often. This is a generic approach.
        console.log('Looking for generated images...');
        let images = await page.locator('message-content:last-of-type img').all();
        
        // If it's still generating, wait another 15 seconds
        if (images.length === 0) {
            console.log("No images found yet. Waiting 15 more seconds...");
            await sleep(15000, 15000);
            images = await page.locator('message-content:last-of-type img').all();
        }

        console.log(`Found ${images.length} images (this might include icons, filtering...)`);

        if (!fs.existsSync('output_images')){
            fs.mkdirSync('output_images');
        }

        let savedCount = 0;
        for (let i = 0; i < images.length; i++) {
            const el = images[i];
            
            // Filter out tiny UI icons by checking dimensions
            const box = await el.boundingBox();
            if (!box || box.width < 100 || box.height < 100) continue;

            // [ANTI-BAN / RELIABILITY] Grabbing the `src` URL often fails because Google uses blob URLs
            // or auth-protected CDN links. The safest way to get the image is to literally 
            // screenshot the DOM element as it renders on your screen.
            const buffer = await el.screenshot();
            const filename = path.join('output_images', `gemini_image_${Date.now()}_${savedCount}.png`);
            fs.writeFileSync(filename, buffer);
            console.log(`✅ Saved image to ${filename}`);
            savedCount++;
        }

        if (savedCount === 0) {
            console.log('⚠️ Could not find any large generated images. The UI might have changed, or the generation was blocked by safety filters.');
        }

        console.log('Done.');
        
        // [ANTI-BAN] Human cool-down before resetting
        await sleep(2000, 4000);
        
        // Reset the tab so it is clean and marked as "idle" for the next run
        await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
        
    } catch (e) {
        console.error("An error occurred during automation:", e);
    } finally {
        // [ANTI-FOCUS-STEAL] Do not close the page, leave it open for the next run to reuse!
        await browser.disconnect();
    }
}

const userPrompt = process.argv[2] || "Generate a highly detailed, realistic picture of a cute mouse eating a piece of yellow cheese";
generateImage(userPrompt);
