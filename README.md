# FoxiGrow Auto-Claimer

**FoxiGrow Auto-Claimer** (internally labeled as *Page Utilities*) is a Chrome Extension designed to automate interactions and task claiming within the FoxiGrow Telegram Mini App. It seamlessly handles authentication, auto-launches the mini app, detects new tasks via a Radar Server (WebSocket), and simulates human-like clicking behavior to maximize task claiming efficiency while avoiding detection.

## Features

- **Automated Task Claiming**: Scans `tma.foxigrow.com` for available tasks and automatically executes the claim sequence (START → GO → Verify → Dismiss).
- **Radar Server Integration**: Connects to a custom WebSocket Radar Server that listens for real-time task drops and triggers immediate localized page reloads to catch tasks instantly.
- **Humanized & Competitive Modes**: Configurable delay metrics in `content.js` allow for either natural, log-normal distributed human reaction times or aggressive zero-latency competitive clicking.
- **Auto-Auth Refresh**: Background service worker automatically opens Telegram Web, clicks "Launch App", and intercepts the new standalone iframe URL to prevent session expiration (runs every 55 minutes).
- **License System**: Integrates with Firebase Firestore to validate license keys, lock them to a specific `deviceId`, and track daily/total USDT rewards.
- **Popup UI**: Offers an interface to toggle the extension on/off, manage the license key, configure the Radar Server URL, and view earning stats.

## Project Structure

- **`manifest.json`**: Chrome extension manifest (V3) specifying permissions (`notifications`, `storage`, `alarms`, `tabs`, `debugger`) and matching rules for tma.foxigrow.com and web.telegram.org.
- **`background.js`**: The core background service worker. Orchestrates the auto-auth refresh flow, handles Radar WebSocket connections, tracks stats, and manages extension state (Enabled/Paused).
- **`content.js`**: The main script injected into `tma.foxigrow.com`. Handles DOM mutation observation, task parsing, and the automated click logic.
- **`telegram-content.js`**: Injected into `web.telegram.org`. Automatically clicks the "Launch App" button in the `@FoxiGrowbot` chat and extracts the mini app URL from the spawned iframe.
- **`firebase.js`**: A lightweight REST API client for Firebase Firestore. Manages license key creation, activation, and reward recording without needing the full Firebase SDK.
- **`popup.html` / `popup.js` / `popup.css`**: The user interface for the extension popup.

## How it Works

1. **Authentication**: Upon activation with a valid license key, the extension instructs Telegram Web (`web.telegram.org`) to launch the FoxiGrow mini app.
2. **URL Extraction**: `telegram-content.js` waits for the mini-app iframe to load, extracts the direct `tma.foxigrow.com` URL, and sends it to the background script.
3. **Task Scanning**: The background script opens the extracted URL in an isolated tab where `content.js` is injected.
4. **Execution**: `content.js` continuously monitors the DOM for new tasks. When a task appears, it executes the start and claim buttons based on the pre-configured reaction speeds.
5. **Session Maintenance**: Every 55 minutes, the background script repeats the launch process to refresh the session token invisibly.

## Configuration

You can customize the clicking behavior inside `content.js` under the `CONFIG` constant:

- **Non-Competitive (Human-like)**: Uses `humanDelay()` to calculate randomized log-normal distributed wait times (e.g., `DELAY_BEFORE_START_CLICK`, `DELAY_BEFORE_GO_CLICK`).
- **Competitive**: Aggressive timeouts meant to claim tasks as fast as the DOM allows (e.g., `COMPETITIVE_START_CLICK: 10`).

## Installation

1. Clone or download this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right.
4. Click **Load unpacked** and select the directory containing this project.
5. Open the extension popup, enter a valid License Key, and click "Start".
