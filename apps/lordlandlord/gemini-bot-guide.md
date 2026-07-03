# Gemini Headless Automation Bot

This document outlines the purpose, mechanics, and usage of the `gemini-bot.cjs` script.

## Overview

The Gemini Bot is a Node.js script powered by [Playwright](https://playwright.dev/) designed to programmatically interface with the Gemini web application (gemini.google.com). Because Google employs strict anti-bot measures (like reCAPTCHA v3) that easily detect traditional headless browsers, this script takes a different approach.

Instead of running a detectable "headless" browser, it connects to a **real, running instance of Google Chrome** over the Chrome DevTools Protocol (CDP). To prevent this from interrupting your workflow, the script leverages macOS AppleScript to forcefully hide the Chrome window and reuses the same tab to prevent macOS from stealing your screen focus.

## How It Works

1. **CDP Connection:** The script uses `chromium.connectOverCDP` to take control of an already-running Chrome window that you started with a specific debugging flag.
2. **Dedicated Profile:** To protect your personal bookmarks and history, the bot uses a completely separate, isolated profile folder (`~/chrome-bot-profile`).
3. **Anti-Focus Steal:** The script uses AppleScript (`osascript`) to simulate pressing `Cmd + H` on the Chrome window, completely hiding it from your desktop. It also reuses the same tab over and over so macOS doesn't pull the window forward.
4. **Human-like Interaction:** To prevent rate-limiting or flagging, the script employs randomized delays (`sleep`) and mimics natural human typing speeds when entering your prompt.
5. **Visual Extraction:** Rather than attempting to extract image URLs from the DOM (which often rely on protected Blob URIs), the bot takes direct screenshots of the generated elements as they render in the hidden browser.

## Setup & Usage Instructions

### 1. Prerequisites (One-Time Setup)
Ensure you have Node.js installed on your machine. You will also need to install the Playwright library in the directory where the script resides:
```bash
npm install playwright
```

### 2. Start the Bot's Chrome Instance
Every time you want to use the bot (or after restarting your computer), you need to start the dedicated background Chrome instance.

Open your terminal and run this exact command:
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="/Users/john.watkins/chrome-bot-profile"
```

### 3. Log In (If Needed)
If this is your first time running the bot, or if your Google session has expired:
1. The command above will open a visible Chrome window.
2. Navigate to `https://gemini.google.com`.
3. Log in with your Google account.
4. Once you see the chat interface, **DO NOT close the window**. Leave it open.

### 4. Generate Images
With the bot's Chrome window running in the background, you can now run the Node script from a new terminal tab at any time:

```bash
node gemini-bot.cjs "Generate an image of a cybernetic cat"
```

As soon as the script connects, it will automatically hide the Chrome window from your screen and generate the image invisibly.

### Expected Output
The script will log its progress in the terminal. Once the image is generated, it will be automatically saved to an `output_images` directory in the same folder as the script.

```
Connecting to running Chrome instance (CDP on port 9222)...
Navigating to Gemini...
Finding chat box...
Typing prompt: "Generate an image of a cybernetic cat"
Sending message...
Waiting for generation to finish... (This takes 15-30 seconds)
Looking for generated images...
Found 1 images (this might include icons, filtering...)
✅ Saved image to output_images/gemini_image_1715600000_0.png
Done.
```

## Troubleshooting
* **Failed to Connect:** Ensure you started Chrome with the `--remote-debugging-port=9222` flag. If it still fails, make sure you don't have multiple instances of Chrome trying to use that port.
* **Zero Images Found:** This usually means your Google session expired and the bot is staring at a login screen. Bring the hidden Chrome window back up (click its icon in the dock), log in manually, and try again.
* **Rate Limiting:** Gemini has usage limits. Do not run the script in rapid succession (e.g., in a tight `for` loop) or you may be temporarily restricted from generating images.