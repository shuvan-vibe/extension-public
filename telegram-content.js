/**
 * FoxiGrow Auto-Claimer — Telegram Web Content Script
 * 
 * Injected into web.telegram.org. Handles the mini app launch flow:
 * 1. Click "Launch App" button at the bottom of the FoxiGrowBot chat
 * 2. Click "LAUNCH" in the confirmation dialog
 * 3. Wait for the mini app iframe to appear
 * 4. Extract the standalone URL from the iframe src
 * 5. Send it to background.js to open in a new tab
 */

const DEBUG = false;

function log(msg, ...args) {
  if (DEBUG) console.log(`[FoxiExt-TG] ${msg}`, ...args);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Find an element by its text content (returns the last match, usually at bottom of screen) */
function findByText(selector, text) {
  const elements = document.querySelectorAll(selector);
  const lowerText = text.toLowerCase().trim();
  const matches = Array.from(elements).filter(el => {
    return el.textContent.trim().toLowerCase() === lowerText;
  });
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/** Find an element whose text content includes the given string (returns last match) */
function findByTextIncludes(selector, text) {
  const elements = document.querySelectorAll(selector);
  const lowerText = text.toLowerCase().trim();
  const matches = Array.from(elements).filter(el => {
    return el.textContent.trim().toLowerCase().includes(lowerText);
  });
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/** Wait for a condition, polling at interval with timeout */
function waitFor(checkFn, interval = 500, timeout = 30000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const result = checkFn();
      if (result) { resolve(result); return; }
      if (Date.now() - start > timeout) { resolve(null); return; }
      setTimeout(check, interval);
    };
    check();
  });
}

async function launchMiniApp() {
  log('Starting mini app launch flow...');

  // ── Step 1: Wait for the page to load and find "Launch App" button ──
  log('Step 1: Looking for "Launch App" button...');
  
  const launchAppBtn = await waitFor(() => {
    // Look for the "Launch App" button at the bottom of the chat
    // It could be a button, div, or span with text "Launch App"
    return findByTextIncludes('button, div, span, a', 'launch app');
  }, 1000, 15000);

  if (!launchAppBtn) {
    log('❌ Could not find "Launch App" button');
    chrome.runtime.sendMessage({ type: 'LAUNCH_FAILED', reason: 'Launch App button not found' });
    return;
  }

  log('Found "Launch App" button, clicking...');
  await sleep(1500); // Increased delay to ensure the button is fully interactive
  launchAppBtn.click();

  // ── Step 2 & 3: Wait for LAUNCH dialog OR iframe ──
  log('Step 2: Waiting for LAUNCH dialog or mini app iframe...');
  
  let launchBtnClicked = false;
  
  const iframeSrc = await waitFor(() => {
    // 1. Check if iframe already appeared
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      if (iframe.src && iframe.src.includes('tma.foxigrow.com')) {
        return iframe.src;
      }
    }
    
    // 2. If not, check if we need to click LAUNCH dialog
    if (!launchBtnClicked) {
      const btn = findByText('button, span, a, div', 'launch');
      let foundBtn = null;
      if (btn && btn !== launchAppBtn && !btn.textContent.trim().toLowerCase().includes('app')) {
        foundBtn = btn;
      } else {
        const popupBtns = document.querySelectorAll('.popup-button, .btn-primary, [class*="popup"] button');
        for (const pb of popupBtns) {
          if (pb.textContent.trim().toLowerCase() === 'launch') {
            foundBtn = pb;
            break;
          }
        }
      }
      
      if (foundBtn) {
        log('Found "LAUNCH" dialog button, clicking...');
        foundBtn.click();
        launchBtnClicked = true;
      }
    }
    
    return null; // Keep waiting for iframe
  }, 500, 20000); // Wait up to 20 seconds for iframe

  if (!iframeSrc) {
    log('❌ Could not find mini app iframe');
    chrome.runtime.sendMessage({ type: 'LAUNCH_FAILED', reason: 'Mini app iframe not found' });
    return;
  }

  log('✅ Found mini app URL:', iframeSrc);

  // ── Step 4: Send the URL to background.js ──
  chrome.runtime.sendMessage({ 
    type: 'MINIAPP_URL_FOUND', 
    url: iframeSrc 
  });
}

// ─── Listen for launch command from background ──────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_LAUNCH_FLOW') {
    log('Received START_LAUNCH_FLOW command');
    launchMiniApp();
    sendResponse({ ok: true });
  }
  return true;
});

// ─── Auto-launch if we're on the FoxiGrowBot page ───────────────────────────
async function init() {
  log('Telegram content script loaded on', window.location.href);
  
  // Check if we should auto-launch (background will tell us)
  const response = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'SHOULD_LAUNCH' }, resolve);
  });

  if (response?.shouldLaunch) {
    log('Auto-launching mini app...');
    // Wait for Telegram to fully load
    await sleep(6000);
    launchMiniApp();
  }
}

init();
