/**
 * FoxiGrow Auto-Claimer — Content Script
 * 
 * Injected into tma.foxigrow.com. This is the core logic:
 * - Navigates to Tasks tab
 * - Scans Available section for START buttons
 * - Executes the claim sequence: START → GO ACTION → Verify → Dismiss
 * - Loops continuously, waiting for new tasks via MutationObserver
 * 
 * Runs in Chrome's "isolated world" — invisible to FoxiGrow's page scripts.
 */

// ─── Configuration ───────────────────────────────────────────────────────────
const DEBUG = true; // TEMPORARY: enabled for GO button diagnosis

const CONFIG = {
  // ── NON-COMPETITIVE (Human-like but fast enough to ensure <1000ms GO click) ──
  DELAY_BEFORE_START_CLICK:  280,    // median ms — fast human reflex
  DELAY_BEFORE_GO_CLICK:     100,    // median ms — quick, habitual click
  DELAY_BEFORE_NEXT_SCAN:    400,    // median ms — short pause before moving on
  
  // ── AGGRESSIVE COMPETITIVE (fastest safe limit) ──
  COMPETITIVE_START_CLICK:   10,     // Instant Twitch reflex
  COMPETITIVE_GO_CLICK:      0,      // 0ms delay after modal appears
  COMPETITIVE_REFLEX_MIN:    10,     // Almost instant spot
  COMPETITIVE_REFLEX_VAR:    50,
  COMPETITIVE_TIMEOUT:       2000,   // Wait up to 2s for verification (FoxiGrow responds in <750ms)
  COMPETITIVE_POLL_INTERVAL: 10,     // Poll modal status every 10ms

  // ── NON-COMPETITIVE (relaxed — speed doesn't matter) ──
  DELAY_BEFORE_DISMISS:      700,    // median ms — no rush to close a modal
  RELOAD_INTERVAL:          { min: 90000, max: 180000 },  // 1.5-3 min
  HARD_RELOAD_INTERVAL:     { min: 600000, max: 900000 }, // 10-15 min (full page reload)

  // Polling intervals
  MODAL_WAIT_INTERVAL:      100,
  MODAL_WAIT_TIMEOUT:       5000,
  RESULT_WAIT_INTERVAL:     200,
  RESULT_WAIT_TIMEOUT:       5000,
  SCAN_INTERVAL:            { min: 1500, max: 3000 },     // 1.5-3s variable

  // Max wait for the GO button to finish the sheet's slide-up animation.
  // Polled every 30ms and exits the instant it's on-screen, so a fast modal pays
  // nothing — this ceiling only applies when the animation is genuinely slow.
  GO_VIEWPORT_MAX_WAIT:     900,

  // ── DRIP SNIPING ──
  // A drip task releases its slots in batches at server-defined timestamps. Missing a
  // batch means waiting for the next one, so we schedule a refresh to land right on it.
  DRIP_MAX_ATTEMPTS:        1,      // real START attempts before a task is blocked forever
  DRIP_PREARM_MS:           2000,   // start the 16ms scanner this early (DOM-only, no network)
  DRIP_JITTER_MIN:          200,    // refresh fires at releaseAt + 200..900ms (never a fixed offset)
  DRIP_JITTER_VAR:          700,
  DRIP_SCAN_WINDOW:         12000,  // must cover release + the ~10s slot drain
  DRIP_REARM_DELAY:         3000,   // after a release, re-query if our task never appeared
  DRIP_MAX_REARMS:          3,      // bound the loop when a task stops dripping entirely
  DRIP_COALESCE_MS:         10000,  // merge snipes landing within this window into one refresh
  DRIP_REFRESH_LOCK_MS:     10000,  // FoxiGrow's client-side refresh-button cooldown
  DRIP_BLOCK_TTL_MS:        604800000, // prune blocked entries after 7 days

  // Safety
  MAX_CONSECUTIVE_ERRORS:   5,
};

// ─── State ───────────────────────────────────────────────────────────────────
const STATE = {
  INITIALIZING:   'INITIALIZING',
  SCANNING:       'SCANNING',
  CLICKING_START: 'CLICKING_START',
  WAITING_MODAL:  'WAITING_MODAL',
  CLICKING_GO:    'CLICKING_GO',
  CHECKING:       'CHECKING',
  DISMISSING:     'DISMISSING',
  PAUSED:         'PAUSED',
  ERROR:          'ERROR',
};

let currentState = STATE.INITIALIZING;
let isEnabled = false;
let isPaused = false;
let isFidgeting = false;
let abortFidget = false;
let userSettings = {};
let isMainLoopRunning = false;
let processedTaskIds = new Set();
let failedTaskCooldowns = new Map();
let consecutiveErrors = 0;
let scanTimer = null;
let observer = null;
let nextReloadTime = 0;
let nextHardReloadTime = 0;

// ─── Drip Snipe State ────────────────────────────────────────────────────────
// dripAttempts / permaBlocked are mirrored into chrome.storage.local because content.js
// reloads the page on stale-cache errors and hard-reloads every 10-15 minutes, both of
// which wipe in-memory state. An in-memory counter would reset before reaching 3 and the
// task would be retried forever.
let dripAttempts = new Map();     // taskId -> real START attempts that failed
let permaBlocked = new Map();     // taskId -> { at, reason }
let dripRearms = new Map();       // taskId -> re-query count for the current chase
let scheduledSnipes = new Map();  // releaseAt (sec) -> { preArmId, fireId, rearmId, taskIds:Set }
let taskTitleCache = new Map();   // taskId -> title (for UI)
let taskTotalSlotsCache = new Map(); // taskId -> total slots (for filtering)
let lastRefreshClickAt = 0;       // last reload-BUTTON click (bounces are not gated)

// ─── Utility Functions ──────────────────────────────────────────────────────

/** Generate a random delay between min and max (for range-based configs) */
function randomDelay(range) {
  return range.min + Math.random() * (range.max - range.min);
}

/** Generate a log-normal distributed delay (mimics human reaction time) */
function humanDelay(median, spread = 0.25) {
  const u1 = Math.random();
  const u2 = Math.random();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(50, median * Math.exp(spread * normal));
}

// ─── Unthrottled Timing Engine (Web Worker) ─────────────────────────────────
// Chrome throttles setTimeout to 1s minimum and kills rAF in background tabs.
// A dedicated Web Worker is NEVER throttled — it runs at full speed even when
// the user switches to another tab or app.

const _workerCode = `
  const _intervals = {};
  self.onmessage = function(e) {
    const d = e.data;
    if (d.cmd === 'sleep') {
      setTimeout(() => self.postMessage({ id: d.id }), d.ms);
    } else if (d.cmd === 'interval') {
      _intervals[d.id] = setInterval(() => self.postMessage({ id: d.id, tick: true }), d.ms);
    } else if (d.cmd === 'clearInterval') {
      clearInterval(_intervals[d.id]);
      delete _intervals[d.id];
    }
  };
`;

let _timingWorker = null;
const _workerCallbacks = new Map();
let _workerIdCounter = 0;

try {
  const blob = new Blob([_workerCode], { type: 'application/javascript' });
  _timingWorker = new Worker(URL.createObjectURL(blob));
  _timingWorker.onmessage = (e) => {
    const cb = _workerCallbacks.get(e.data.id);
    if (cb) {
      if (!e.data.tick) _workerCallbacks.delete(e.data.id); // one-shot: clean up
      cb();
    }
  };
  console.log('[FoxiExt] ⚡ Timing Worker created — background tab throttling BYPASSED');
} catch (e) {
  console.warn('[FoxiExt] Worker creation failed, falling back to throttled setTimeout:', e);
}

/** Sleep for ms (UNTHROTTLED — works at full speed in background tabs) */
function sleep(ms) {
  if (_timingWorker && ms > 0) {
    return new Promise(resolve => {
      const id = ++_workerIdCounter;
      _workerCallbacks.set(id, resolve);
      _timingWorker.postMessage({ cmd: 'sleep', ms, id });
    });
  }
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Unthrottled setTimeout replacement */
function workerTimeout(fn, ms) {
  if (_timingWorker && ms > 0) {
    const id = ++_workerIdCounter;
    _workerCallbacks.set(id, fn);
    _timingWorker.postMessage({ cmd: 'sleep', ms, id });
    return id;
  }
  return setTimeout(fn, ms);
}

/** Unthrottled setInterval replacement — returns interval id for cancellation */
function workerInterval(fn, ms) {
  if (_timingWorker) {
    const id = ++_workerIdCounter;
    _workerCallbacks.set(id, fn);
    _timingWorker.postMessage({ cmd: 'interval', ms, id });
    return { _workerId: id };
  }
  return { _nativeId: setInterval(fn, ms) };
}

/** Clear a Worker interval */
function clearWorkerInterval(handle) {
  if (!handle) return;
  if (handle._workerId) {
    _workerCallbacks.delete(handle._workerId);
    if (_timingWorker) _timingWorker.postMessage({ cmd: 'clearInterval', id: handle._workerId });
  } else if (handle._nativeId) {
    clearInterval(handle._nativeId);
  }
}

/** Sleep but check abortFidget frequently */
async function fidgetSleep(ms) {
  const chunks = Math.ceil(ms / 100);
  for (let i = 0; i < chunks; i++) {
    if (abortFidget) return false;
    await sleep(100);
  }
  return !abortFidget;
}

/** Simulate human-like scrolling to bring an element into view */
async function humanScroll(element) {
  let rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  
  // If element is safely inside the viewport (with padding), no need to scroll
  if (rect.top >= 100 && rect.bottom <= viewportHeight - 50) {
    return;
  }
  
  log('Element off-screen, simulating human scroll...');
  
  // Calculate target scroll position (aim to put element in upper-middle of screen)
  const targetY = window.scrollY + rect.top - (viewportHeight / 3);
  
  let currentY = window.scrollY;
  let remaining = targetY - currentY;
  
  if (Math.abs(remaining) < 50) return; // Too close to bother

  // Simulate mouse wheel "ticks"
  const steps = Math.floor(Math.random() * 5) + 5; // 5 to 9 steps
  
  for (let i = 0; i < steps; i++) {
    currentY = window.scrollY;
    remaining = targetY - currentY;
    if (Math.abs(remaining) < 20) break;
    
    // Calculate the size of this scroll tick with some random jitter
    const chunk = remaining / (steps - i) + (Math.random() * 30 - 15);
    window.scrollBy({ top: chunk, behavior: 'auto' });
    
    // Small delay between mouse wheel clicks
    await sleep(Math.random() * 40 + 20);
  }
  
  // Final smooth adjustment
  window.scrollTo({
    top: targetY,
    behavior: 'smooth'
  });
  
  // Wait for the scroll to finish and simulate human reading time
  await sleep(Math.random() * 800 + 400); // 400ms to 1200ms
}

/** Scroll element into view strictly vertically, preventing horizontal slider triggers */
function scrollIntoViewNested(element) {
  // First, native scroll into view to handle shadow DOMs / Modals
  element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
  
  const rect = element.getBoundingClientRect();
  
  // 1. Scroll the main window vertically to bring it into view (if it's not a modal)
  const targetY = window.scrollY + rect.top - (window.innerHeight / 3);
  window.scrollTo({ top: targetY, behavior: 'instant' });
  
  // 2. Walk up the DOM to find scrollable parents and scroll them vertically too
  let parent = element.parentElement;
  while (parent && parent !== document.body) {
    const style = getComputedStyle(parent);
    const isScrollableY = (style.overflow === 'auto' || style.overflow === 'scroll' ||
                           style.overflowY === 'auto' || style.overflowY === 'scroll');
    
    if (isScrollableY && parent.scrollHeight > parent.clientHeight) {
      // This parent is a vertical scroll container
      const parentRect = parent.getBoundingClientRect();
      const elemRect = element.getBoundingClientRect(); // Recalculate after window scroll
      
      // If the element is outside the bounds of its scrollable parent, adjust the parent's scroll
      if (elemRect.top < parentRect.top || elemRect.bottom > parentRect.bottom) {
        const offsetTop = elemRect.top - parentRect.top;
        const scrollTarget = parent.scrollTop + offsetTop - (parentRect.height / 2) + (elemRect.height / 2);
        parent.scrollTop = scrollTarget;
        console.log(`[FoxiExt-SCROLL] Scrolled parent <${parent.tagName}> to ${Math.round(scrollTarget)}`);
      }
    }
    parent = parent.parentElement;
  }
}

/** Helper to click elements using the human-like debugger API */
async function humanClick(element) {
  const isFast = userSettings.competitiveMode || false;

  // First, ensure the element is scrolled into view naturally
  if (isFast) {
    // Scroll both the element AND its nearest scrollable parent
    scrollIntoViewNested(element);
  } else {
    await humanScroll(element);
    // Wait a tiny bit for any layout shifts
    await sleep(50);
  }
  
  // Small delay to let scroll settle
  await sleep(10);
  
  // RECALCULATE rect after scrolling!
  let rect = element.getBoundingClientRect();
  
  // Check if element is actually visible in the viewport (Allow 50px margin for scrollbar/edge clipping)
  let inViewport = rect.top >= -50 && rect.bottom <= window.innerHeight + 50 && rect.left >= -50 && rect.right <= window.innerWidth + 50;
  if (!inViewport) {
    console.warn(`[FoxiExt-CLICK] Element NOT in viewport after scroll! top=${Math.round(rect.top)} viewportH=${window.innerHeight}. Retrying vertical scroll...`);
    // Only try scrolling the closest scrollable parent vertically
    scrollIntoViewNested(element);
    await sleep(50);
    rect = element.getBoundingClientRect();
    
    // Native fallback if our nested scroll failed
    inViewport = rect.top >= -50 && rect.bottom <= window.innerHeight + 50 && rect.left >= -50 && rect.right <= window.innerWidth + 50;
    if (!inViewport) {
      console.warn(`[FoxiExt-CLICK] Element STILL off-screen. Falling back to native scrollIntoView...`);
      element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'nearest' });
      await sleep(50);
      rect = element.getBoundingClientRect();
    }
  }
  
  // Add natural jitter — humans never click dead center
  const jitterX = (Math.random() - 0.5) * rect.width * 0.4;
  const jitterY = (Math.random() - 0.5) * rect.height * 0.3;
  const x = rect.left + rect.width / 2 + jitterX;
  const y = rect.top + rect.height / 2 + jitterY;
  
  // Final viewport check (Allow a 50px overflow margin for elements barely clipping the edge)
  const stillOffScreen = y < -50 || y > window.innerHeight + 50 || x < -50 || x > window.innerWidth + 50;
  const now = new Date();
  const clickTs = now.toTimeString().split(' ')[0] + '.' + now.getMilliseconds().toString().padStart(3, '0');
  const elementDesc = `<${element.tagName}> "${element.textContent.trim().substring(0,30)}"`;
  
  sendBlackboxLog(`CLICK_ATTEMPT: X=${Math.round(x)}, Y=${Math.round(y)} on ${elementDesc}. (Viewport: ${window.innerWidth}x${window.innerHeight})`);
  
  if (stillOffScreen) {
    console.warn(`[FoxiExt-CLICK] [${clickTs}] Element off-screen at (${Math.round(x)}, ${Math.round(y)}). Using direct .click()...`);
    try {
      element.click();
      sendBlackboxLog(`CLICK_RESULT: Off-screen fallback SUCCESS`);
      console.log(`[FoxiExt-CLICK] [${clickTs}] ✅ Off-screen .click() SUCCESS on ${elementDesc}`);
      sendMessage({ type: 'STATUS_UPDATE', status: `🖱️ [${clickTs}] Click ✅ (off-screen fallback) — ${elementDesc}` });
    } catch (e) {
      console.error(`[FoxiExt-CLICK] [${clickTs}] ❌ Off-screen .click() FAILED on ${elementDesc}:`, e);
      sendBlackboxLog(`CLICK_RESULT: Off-screen fallback FAILED - ${e.message}`);
      sendMessage({ type: 'STATUS_UPDATE', status: `🖱️ [${clickTs}] Click ❌ FAILED (off-screen) — ${elementDesc}` });
    }
    return;
  }
  
  // ── FIRE CLICK ──
  console.log(`[FoxiExt-CLICK] [${clickTs}] ${isFast ? 'COMPETITIVE' : 'NON-COMPETITIVE'} click on ${elementDesc} at (${Math.round(x)}, ${Math.round(y)})`);
  
  try {
    // Both modes now use chrome.debugger to guarantee isTrusted=true.
    // Competitive mode passes fast=true to bypass delays and teleport the cursor instantly.
    const response = await sendMessage({ type: 'SIMULATE_CLICK', x, y, fast: isFast });
    if (response && response.error) {
      // Debugger failed — try reattach + retry
      console.warn(`[FoxiExt-CLICK] [${clickTs}] Debugger FAILED: ${response.error}. Trying reattach...`);
      const reattach = await sendMessage({ type: 'REATTACH_DEBUGGER' });
      if (reattach && reattach.ok) {
        await sleep(100);
        const retry = await sendMessage({ type: 'SIMULATE_CLICK', x, y, fast: isFast });
        if (retry && !retry.error) {
          console.log(`[FoxiExt-CLICK] [${clickTs}] ✅ Debugger click SUCCESS (after reattach) on ${elementDesc}`);
          sendMessage({ type: 'STATUS_UPDATE', status: `🖱️ [${clickTs}] Click ✅ (debugger reattach${isFast ? ' - fast' : ''}) — ${elementDesc}` });
          logDiagnostic('click', `✅ Debugger click SUCCESS (reattach): ${elementDesc}`);
          return;
        }
      }
      
      // Debugger completely failed — fall back to direct .click() (WARNING: May trigger risk control)
      console.warn(`[FoxiExt-CLICK] [${clickTs}] Debugger unavailable. Falling back to direct .click()...`);
      const eventOpts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      element.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
      element.dispatchEvent(new MouseEvent('mousedown', eventOpts));
      element.dispatchEvent(new PointerEvent('pointerup', eventOpts));
      element.dispatchEvent(new MouseEvent('mouseup', eventOpts));
      element.click();
      console.log(`[FoxiExt-CLICK] [${clickTs}] ✅ Fallback .click() SUCCESS on ${elementDesc}`);
      sendMessage({ type: 'STATUS_UPDATE', status: `🖱️ [${clickTs}] Click ✅ (debugger failed → .click() fallback) — ${elementDesc}` });
      logDiagnostic('click', `⚠️ Debugger failed, used .click() fallback: ${elementDesc} at (${Math.round(x)}, ${Math.round(y)})`);
    } else {
      console.log(`[FoxiExt-CLICK] [${clickTs}] ✅ Debugger click SUCCESS on ${elementDesc}`);
      sendMessage({ type: 'STATUS_UPDATE', status: `🖱️ [${clickTs}] Click ✅ (debugger${isFast ? ' - fast' : ''}) — ${elementDesc}` });
      logDiagnostic('click', `✅ Debugger click SUCCESS: ${elementDesc}`);
    }
  } catch (err) {
    // Debugger threw — fall back to direct .click()
    console.error(`[FoxiExt-CLICK] [${clickTs}] Debugger THREW: ${err.message}. Falling back to .click()...`);
    try {
      const eventOpts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      element.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
      element.dispatchEvent(new MouseEvent('mousedown', eventOpts));
      element.dispatchEvent(new PointerEvent('pointerup', eventOpts));
      element.dispatchEvent(new MouseEvent('mouseup', eventOpts));
      element.click();
      console.log(`[FoxiExt-CLICK] [${clickTs}] ✅ Fallback .click() SUCCESS on ${elementDesc}`);
      sendMessage({ type: 'STATUS_UPDATE', status: `🖱️ [${clickTs}] Click ✅ (debugger threw → .click() fallback) — ${elementDesc}` });
      logDiagnostic('click', `⚠️ Debugger threw, used .click() fallback: ${elementDesc}`);
    } catch (fallbackErr) {
      console.error(`[FoxiExt-CLICK] [${clickTs}] ❌ ALL click methods FAILED on ${elementDesc}:`, fallbackErr);
      sendMessage({ type: 'STATUS_UPDATE', status: `🖱️ [${clickTs}] Click ❌ ALL METHODS FAILED — ${elementDesc}` });
      logDiagnostic('click', `❌ ALL click methods FAILED: ${elementDesc} — ${fallbackErr.message}`);
    }
  }
}

/** Send a message to the background script */
function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response);
    });
  });
}

/** Log to console with prefix — silent in production to avoid interception */
function log(msg, ...args) {
  if (DEBUG) console.log(`[FoxiExt] ${msg}`, ...args);
}

function sendBlackboxLog(text) {
  window.__foxiBlackboxQueue = window.__foxiBlackboxQueue || [];
  const now = new Date();
  const ts = now.toTimeString().split(' ')[0] + '.' + now.getMilliseconds().toString().padStart(3, '0');
  window.__foxiBlackboxQueue.push(`[${ts}] ${text}`);
}

sendBlackboxLog("BOT_STARTED: Content script injected and Blackbox Logger initialized.");

function logDiagnostic(taskId, message) {
  if (userSettings.diagnosticMode) {
    const timestamp = performance.now().toFixed(2);
    chrome.runtime.sendMessage({ 
      type: 'ADD_DIAGNOSTIC_LOG', 
      text: `[T+${timestamp}ms] ${message}`, 
      taskId: taskId 
    }).catch(() => {});
  }
}

let lastLoggedStatus = '';
/** Send status update only if it changed */
async function logStatus(status) {
  if (lastLoggedStatus !== status) {
    lastLoggedStatus = status;
    await sendMessage({ type: 'STATUS_UPDATE', status });
  }
}

/** Find text content in the DOM, case-insensitive */
function findElementByText(selector, text) {
  const elements = document.querySelectorAll(selector);
  const lowerText = text.toLowerCase().trim();
  return Array.from(elements).find(el => {
    const elText = el.textContent.trim().toLowerCase();
    return elText === lowerText;
  });
}

/** Find all elements matching text, case-insensitive */
function findAllElementsByText(selector, text) {
  const elements = document.querySelectorAll(selector);
  const lowerText = text.toLowerCase().trim();
  return Array.from(elements).filter(el => {
    const elText = el.textContent.trim().toLowerCase();
    return elText === lowerText;
  });
}

/**
 * Normalize label text for comparison: lowercase, strip emoji/punctuation.
 * FoxiGrow prefixes labels with icons ("🚫Hide", "🌐Language", "📍Region"),
 * so exact-equality checks against "hide" silently fail without this.
 */
function normText(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Is the element actually rendered inside the viewport?
 * Modals always are. Task-list cards further down the scroll container are NOT
 * (e.g. a started task's card sitting at top=2173 with a 945px viewport), which
 * is exactly the state that used to be mistaken for "a modal is open".
 */
function isInViewport(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  return r.bottom > 0 && r.top < window.innerHeight;
}

/**
 * Resolve the bottom-sheet modal container by walking up from an anchor element
 * (the modal's Cancel or GO button). Stops before climbing into the app shell,
 * so the returned container never includes the background task list.
 */
function getModalContainer(anchorEl) {
  if (!anchorEl) return null;
  const totalBtns = document.querySelectorAll('button').length;
  let node = anchorEl;
  let best = anchorEl;
  let depth = 0;

  while (node && node !== document.body && depth < 10) {
    const btnCount = node.querySelectorAll('button').length;
    // Bail out if this ancestor holds most of the page's buttons — that means
    // we've climbed past the sheet into the whole app root.
    if (totalBtns > 4 && btnCount > totalBtns * 0.6) break;

    best = node;
    const r = node.getBoundingClientRect();
    // A sheet is tall and holds at least the Cancel + GO pair
    if (btnCount >= 2 && r.height >= window.innerHeight * 0.25) break;

    node = node.parentElement;
    depth++;
  }
  return best;
}

/**
 * Snapshot the "task started" markers that ALREADY exist before we click START.
 * A task that started moments ago keeps its 30s timer card (TIME LEFT / Copy Link
 * / Upload Screenshot) mounted in the list, so counting those markers globally
 * produces phantom successes for the NEXT task. We only ever count NEW ones.
 */
function snapshotStartedMarkers() {
  return {
    copyLink:  new Set(findAllElementsByText('button', 'copy link')),
    upload:    new Set(findAllElementsByText('button, div, span', 'Upload Screenshot')),
    continues: new Set(findAllElementsByText('button', 'continue')),
    timeLeft:  (document.body.innerText.match(/TIME LEFT/gi) || []).length,
  };
}

/**
 * Extract taskId from the task card.
 * FoxiGrow puts the ID as `#12345` inside the card text.
 */
function extractTaskId(element) {
  // Look for # followed by numbers (the official FoxiGrow task ID)
  const match = element.textContent.match(/#(\d+)/);
  if (match) return match[1];

  // If the button has an ID, or a data-id attribute, or the container does
  const btn = element.querySelector('button');
  if (btn && btn.id) return btn.id;
  if (element.id) return element.id;
  
  // Fallback: hash the text content to create a pseudo-ID
  let text = element.textContent.replace(/\s+/g, '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return 'task_' + Math.abs(hash);
}

/** Extract the Title from the task card */
function extractTaskTitle(element) {
  // Find all text nodes or span/divs with text
  const allTexts = Array.from(element.querySelectorAll('h2, h3, h4, span, div, strong, b'))
    .map(el => {
      // Get direct text only (ignore children text to avoid mashing everything together)
      let text = '';
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) text += node.nodeValue;
      }
      return text.trim();
    })
    .filter(text => text.length > 8 && !text.match(/^[\d\.\+\-\s#]+$/)); // Longer than 8 chars, not just numbers/symbols

  if (allTexts.length > 0) {
    return allTexts[0]; // Usually the first meaningful text is the title
  }
  return null;
}

/** Extract the USDT reward amount from the task card */
function extractUsdt(element) {
  const fullText = element.textContent || "";
  
  // 1. Look for explicit USDT mentions (e.g. "Reward: +0.02 USDT" or "+0.04 USDT")
  let match = fullText.match(/\+?\s*(\d+\.\d+|\d+)\s*USDT/i);
  if (match) return parseFloat(match[1]);

  // 2. Look for "Reward: +0.02" without USDT
  match = fullText.match(/Reward:\s*\+?\s*(\d+\.\d+|\d+)/i);
  if (match) return parseFloat(match[1]);

  // 3. Look for standalone "+0.04" in isolated elements (like the modal badges)
  const allTexts = Array.from(element.querySelectorAll('*')).map(el => el.textContent.trim());
  for (const text of allTexts) {
    // Matches exactly "+0.04" or "0.04" (no other text/letters in the element)
    const exactMatch = text.match(/^\+?\s*(\d+\.\d+|\d+)$/);
    if (exactMatch) {
      const val = parseFloat(exactMatch[1]);
      if (val > 0) return val;
    }
  }

  return 0; // Default if not found
}

/** Check if we're on the Tasks tab */
function isOnTasksTab() {
  // Look for the "Task Center" heading or the active TASKS tab
  const heading = findElementByText('h1, h2, h3, div', 'Task Center');
  return !!heading;
}

/** Navigate to the Tasks tab */
function navigateToTasksTab() {
  // Find the TASKS icon/text in the bottom nav bar
  const tasksTab = findElementByText('span, div', 'Tasks');
  if (tasksTab) {
    log('Navigating to Tasks tab...');
    tasksTab.click();
    return true;
  }
  return false;
}

/** Find the reload button (circular arrow SVG) */
function findReloadButton() {
  const path = document.querySelector('button svg path[d*="M21 12a"]');
  if (path) {
    return path.closest('button');
  }
  return null;
}

// ─── Available Section Scanning ──────────────────────────────────────────────

/** Find the "Available" section header element */
function findAvailableHeader() {
  const allElements = document.querySelectorAll('div, span');
  return Array.from(allElements).find(el => {
    // Direct text node match for "Available" (not nested text)
    if (el.childNodes.length >= 1) {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE && 
            child.nodeValue.trim().toLowerCase() === 'available') {
          return true;
        }
      }
    }
    return false;
  });
}

/** Pre-scroll to the Available section before the task even renders */
function preScrollToTasks() {
  const header = findAvailableHeader();
  if (header) {
    const rect = header.getBoundingClientRect();
    const targetY = window.scrollY + rect.top - (window.innerHeight / 4);
    window.scrollTo({ top: targetY, behavior: 'instant' });
    log('Pre-scrolled to Available tasks section');
  }
}

let rAFScanActive = false;
let rAFScanEndTime = 0;
let rAFScanInterval = null;

/** Aggressive DOM scanner — uses Worker interval (works in background tabs unlike rAF) */
function startAggressiveRAFScan(durationMs = 5000) {
  rAFScanEndTime = Math.max(rAFScanEndTime, Date.now() + durationMs);
  if (rAFScanActive) return;
  rAFScanActive = true;
  
  // Use Worker-based interval at ~16ms (60fps equivalent) — never throttled
  rAFScanInterval = workerInterval(() => {
    if (!rAFScanActive) {
      clearWorkerInterval(rAFScanInterval);
      rAFScanInterval = null;
      return;
    }
    
    if (isEnabled && !isPaused && currentState === STATE.SCANNING) {
      const startable = findStartableTasks();
      if (startable.length > 0) {
        logDiagnostic('system', 'WORKER POLL: Task(s) detected in DOM');
        log('⚡ Worker scan detected tasks instantly!');
        rAFScanActive = false;
        rAFScanEndTime = 0;
        clearWorkerInterval(rAFScanInterval);
        rAFScanInterval = null;
        abortFidget = true;
        if (scanTimer) clearTimeout(scanTimer);
        mainLoop();
        return;
      }
    }
    
    if (Date.now() > rAFScanEndTime) {
      rAFScanActive = false;
      clearWorkerInterval(rAFScanInterval);
      rAFScanInterval = null;
    }
  }, 16);
}

/** 
 * Get all task cards in the Available section.
 * Returns array of { element, button, buttonText, taskId }
 */
function getAvailableTasks() {
  const header = findAvailableHeader();
  if (!header) {
    log('Available section header not found');
    return [];
  }

  // Walk up to the header's container (the div that wraps the "Available" label)
  let headerContainer = header;
  // The header might be a span inside a div — find the sibling-level container
  while (headerContainer && headerContainer.parentElement) {
    const parent = headerContainer.parentElement;
    // Check if this parent has siblings that look like task cards
    const siblings = Array.from(parent.children);
    const headerIndex = siblings.indexOf(headerContainer);
    if (headerIndex >= 0 && siblings.length > headerIndex + 1) {
      // Found the right level — task cards are siblings after this element
      const tasks = [];
      for (let i = headerIndex + 1; i < siblings.length; i++) {
        const sibling = siblings[i];
        // Look for buttons inside this sibling
        const buttons = sibling.querySelectorAll('button');
        for (const btn of buttons) {
          const btnText = btn.textContent.trim().toLowerCase();
          if (['start', 'continue', 'restart', 'checking', 'check'].includes(btnText)) {
            const taskId = extractTaskId(sibling);
            const usdtReward = extractUsdt(sibling);
            const taskTitle = extractTaskTitle(sibling) || `Task #${taskId}`;
            tasks.push({
              element: sibling,
              button: btn,
              buttonText: btnText,
              taskId: taskId,
              usdtReward: usdtReward,
              taskTitle: taskTitle
            });
          }
        }
      }
      if (tasks.length > 0) return tasks;
    }
    headerContainer = parent;
  }

  return [];
}

/**
 * Find the START buttons among available tasks.
 * Filters out already-processed tasks and non-START states.
 */
function findStartableTasks() {
  const tasks = getAvailableTasks();
  
  // Parse blocked keywords
  let blockedKeywords = [];
  if (userSettings.blockedKeywords) {
    blockedKeywords = userSettings.blockedKeywords.split(',')
      .map(k => k.trim().toLowerCase())
      .filter(k => k.length > 0);
  }

  // Parse blocked task IDs
  let blockedTaskIds = [];
  if (userSettings.blockedTaskIds) {
    blockedTaskIds = userSettings.blockedTaskIds.split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);
  }

  return tasks.filter(task => {
    // Only click START buttons
    if (task.buttonText !== 'start') return false;

    // Permanently blocked: burned all its drip attempts in an earlier session
    if (permaBlocked.has(task.taskId)) return false;

    // Check if previously successfully started (or hard failed in this run)
    if (processedTaskIds.has(task.taskId)) return false;

    // Check cooldown for recently failed slot races
    if (failedTaskCooldowns.has(task.taskId)) {
      if (Date.now() < failedTaskCooldowns.get(task.taskId)) {
        return false; // Still in cooldown
      } else {
        // Cooldown expired, allow retry
        failedTaskCooldowns.delete(task.taskId);
      }
    }

    // Check against user blocklists
    const title = extractTaskTitle(task.element) || '';
    if (task.taskId && blockedTaskIds.includes(task.taskId)) {
      log(`Skipping task #${task.taskId} due to blocked Task ID list`);
      processedTaskIds.add(task.taskId);
      return false;
    }
    
    // Check keyword blocking
    if (blockedKeywords.length > 0) {
      const taskText = task.element.textContent.toLowerCase();
      if (blockedKeywords.some(keyword => taskText.includes(keyword))) {
        log(`Skipping task #${task.taskId} due to blocked keyword: "${taskText}"`);
        processedTaskIds.add(task.taskId); // Mark processed so we don't keep logging it
        return false;
      }
    }
    
    return true;
  });
}

// ─── Modal Detection ─────────────────────────────────────────────────────────

/** Check if the bottom-sheet modal is currently open */
function isModalOpen() {
  // The pre-start modal is uniquely identified by its Cancel button, and a real
  // modal is ALWAYS on-screen. We deliberately do NOT treat "Upload Screenshot"
  // as proof of an open modal: that marker also belongs to a previously started
  // task's list card, which stays mounted for ~30s and used to make this return
  // true before the current task's modal had rendered.
  const cancelBtn = findAllElementsByText('button', 'cancel').find(isInViewport);
  if (cancelBtn) return true;

  // Post-start view of the CURRENT task (on-screen only)
  const uploadBtn = findAllElementsByText('button, div, span', 'Upload Screenshot').find(isInViewport);
  if (uploadBtn) return true;

  return false;
}

/** Find the GO action button in the modal (GO FOLLOW, GO VISIT, GO LIKE, GO RETWEET, etc.)
 *  @param {Element|null} scope - the resolved modal container. When provided, the search
 *  NEVER leaves it, so background task-list buttons (Hide/Language/Region) can't be hit. */
function findGoActionButton(scope = null) {
  const root = scope || document;
  const allBtns = root.querySelectorAll('button');

  // ── DIAGNOSTIC (only when explicitly enabled — keeps the hot path fast) ──
  if (DEBUG) {
    const btnDump = Array.from(allBtns).map(b => {
      const r = b.getBoundingClientRect();
      return `"${b.textContent.trim().substring(0,50)}" tag=${b.tagName} top=${Math.round(r.top)} vis=${r.width>0}`;
    });
    console.log(`[FoxiExt-DIAG] Buttons in ${scope ? 'MODAL' : 'page'}:`, JSON.stringify(btnDump));
  }

  // ── Strategy 1: Text-based matching across ALL elements ──
  const allElements = root.querySelectorAll('button, a, div, span');
  
  // Keywords that MUST be prefixed with "go " to match (too common in task titles otherwise)
  const goOnlyKeywords = ['follow', 'like', 'retweet', 'join', 'watch', 'subscribe', 'visit'];
  // Keywords that match standalone
  const standaloneKeywords = ['go '];
  
  const ignoreExact = ['submit', 'cancel', 'verify', 'check', 'got it', 'close', 'start', 'claim',
                        'upload screenshot', 'time left', 'copy link', 'tasks', 'leaderboard', 
                        'available', 'completed', 'task center', 'continue', 'browse other quests',
                        'hide', 'language', 'region', 'please wait'];
  
  const matches = [];
  
  for (const el of allElements) {
    const text = normText(el.textContent);
    if (!text || text.length > 25) continue;  // GO buttons are short (e.g. "Go Follow", "Go Visit")
    if (el.textContent.includes('[#')) continue;
    if (ignoreExact.includes(text)) continue;
    if (text.startsWith('please wait')) continue;  // start cooldown / timer button
    
    // Check if text starts with "go " (strongest signal)
    const startsWithGo = text.startsWith('go ');
    
    // For non-"go" keywords, only match if text is very short AND is a button/a
    // (prevents matching task title DIVs like "Join a SubredditStart")
    let isValidMatch = false;
    if (startsWithGo) {
      isValidMatch = true;
    } else {
      // Only accept button/a tags for standalone keywords, and text must be very short
      const tag = el.tagName.toLowerCase();
      if ((tag === 'button' || tag === 'a') && text.length <= 15) {
        isValidMatch = goOnlyKeywords.some(kw => text.startsWith(kw));
      }
    }
    
    if (!isValidMatch) continue;
    
    // Skip if it also contains ignore words (prevents matching parent containers)
    if (text.includes('cancel') || text.includes('upload') || text.includes('start')) continue;
    
    // Visual check: element must be visible AND on-screen
    if (!isInViewport(el)) continue;
    
    if (DEBUG) console.log(`[FoxiExt-DIAG] Strategy 1 MATCH: <${el.tagName}> "${text}"`);
    matches.push({ el, text, tag: el.tagName.toLowerCase() });
  }

  if (matches.length > 0) {
    // Prefer "go " prefixed matches first
    const goMatch = matches.find(m => m.text.startsWith('go '));
    if (goMatch) {
      log(`GO button found (text match): <${goMatch.tag}> "${goMatch.text}"`);
      return goMatch.el;
    }
    // Then prefer <button> or <a> tags
    const buttonOrLink = matches.find(m => m.tag === 'button' || m.tag === 'a');
    if (buttonOrLink) {
      log(`GO button found (text match): <${buttonOrLink.tag}> "${buttonOrLink.text}"`);
      return buttonOrLink.el;
    }
    // Prefer the smallest (most specific) element
    matches.sort((a, b) => a.text.length - b.text.length);
    log(`GO button found (text match, deepest): <${matches[0].tag}> "${matches[0].text}"`);
    return matches[0].el;
  }
  
  // ── Strategy 2: Positional fallback — MODAL-SCOPED ONLY ──
  // Previously this scanned every button on the page and filtered by y-position,
  // which discarded the real modal content (below the fold) and returned the task
  // list's "🚫Hide" button instead — hiding the task instead of starting it.
  // Without a resolved modal container we now refuse to guess.
  if (DEBUG) console.log('[FoxiExt-DIAG] Strategy 1 found NO matches, trying positional fallback...');
  
  if (!scope) {
    if (DEBUG) console.warn('[FoxiExt-DIAG] No modal scope — refusing page-wide fallback (would risk clicking list buttons)');
    return null;
  }
  
  const ignoreTexts = [
    'cancel', 'start', 'got it', 'close', 'tasks', 'leaderboard', 'continue',
    'browse other quests', 'upload screenshot', 'copy', 'copy link', 'verify',
    // Tab filter buttons
    'all', 'twitter', 'youtube', 'github', 'website', 'websites', 'tiktok', 'telegram',
    // Task list UI
    'link tiktok account', 'task center', 'history', 'available', 'completed',
    // Per-card / global controls that must NEVER be clicked as a GO action
    'hide', 'language', 'region',
  ];
  
  const modalButtons = Array.from(allBtns).filter(btn => {
    const text = normText(btn.textContent);
    if (!text) return false;
    
    // Skip known non-GO buttons
    if (ignoreTexts.includes(text)) return false;
    
    // Skip "Hidden (N)" / "Hide" style buttons (task list controls)
    if (text.startsWith('hidden') || text.startsWith('hide')) return false;
    
    // Skip timer / cooldown buttons ("Please wait 0:22")
    if (text.startsWith('please wait')) return false;
    
    // Skip buttons with task-list content (prices, stats, IDs)
    const raw = btn.textContent;
    if (raw.includes('+') || raw.includes('#') || raw.includes('$')) return false;
    
    // Skip very long text (GO buttons are short)
    if (text.length > 20) return false;
    
    if (!isInViewport(btn)) return false;
    
    const rect = btn.getBoundingClientRect();
    if (rect.bottom > window.innerHeight - 60) return false; // bottom nav bar
    if (rect.top < 10) return false; // top bar
    
    if (DEBUG) console.log(`[FoxiExt-DIAG] Strategy 2 candidate: "${btn.textContent.trim()}" top=${Math.round(rect.top)}`);
    return true;
  });
  
  if (modalButtons.length > 0) {
    // Pick the LOWEST on screen — the sheet's primary action sits at the bottom.
    // (Document order is not screen order, which the old code assumed.)
    const chosen = modalButtons.reduce((a, b) =>
      b.getBoundingClientRect().top > a.getBoundingClientRect().top ? b : a
    );
    log(`GO button found (positional fallback, modal-scoped): <button> "${chosen.textContent.trim()}"`);
    return chosen;
  }

  // ── Strategy 3: NUCLEAR — find the sibling of CANCEL button ──
  if (DEBUG) console.log('[FoxiExt-DIAG] Strategy 2 found NO matches, trying nuclear fallback...');
  const cancelBtn = findAllElementsByText('button', 'cancel').find(isInViewport);
  if (cancelBtn) {
    // The GO button is usually a sibling of CANCEL in the same parent container
    const parent = cancelBtn.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children);
      for (const sib of siblings) {
        if (sib === cancelBtn) continue;
        const sibText = normText(sib.textContent);
        if (!sibText || sibText.length >= 40) continue;
        if (sibText === 'cancel' || sibText.startsWith('hide') || sibText.startsWith('please wait')) continue;
        if (!isInViewport(sib)) continue;
        if (DEBUG) console.log(`[FoxiExt-DIAG] Strategy 3 NUCLEAR: Found sibling of Cancel: <${sib.tagName}> "${sib.textContent.trim()}"`);
        return sib;
      }
    }
  }

  // ── Diagnostic: dump what IS in the modal so we can fix the selector ──
  if (DEBUG) {
    const diagButtons = Array.from(root.querySelectorAll('button')).map(b => 
      `<button> "${b.textContent.trim().substring(0, 50)}" [${Math.round(b.getBoundingClientRect().top)}px]`
    );
    console.warn('[FoxiExt] GO BUTTON NOT FOUND. Modal buttons:', diagButtons);
    sendMessage({ type: 'STATUS_UPDATE', status: `⚠️ GO btn missing! Buttons: ${diagButtons.join(' | ')}` });
  }
  
  return null;
}

/** 
 * Detect the "Unable to Proceed" error screen and extract the real reason.
 * FoxiGrow shows different dismiss buttons: "Got It", "Browse Other Quests", etc.
 * Returns { button, reason } or null if no error screen is visible.
 */
function findErrorScreen() {
  const buttons = document.querySelectorAll('button');
  const dismissKeywords = ['got it', 'browse other quests', 'try again', 'ok'];
  
  const dismissBtn = Array.from(buttons).find(btn => {
    const text = btn.textContent.trim().toLowerCase();
    return dismissKeywords.includes(text);
  });
  
  if (!dismissBtn) return null;
  
  // Scrape the actual error text from the modal
  let reason = 'Unable to Proceed';
  
  // Look for the "Unable to Proceed" heading and grab the body text below it
  const allText = document.body.innerText || '';
  const unableMatch = allText.match(/Unable to Proceed[\s\n]+(.+?)(?:\n|$)/i);
  if (unableMatch) {
    const rawReason = unableMatch[1].trim();
    // Clean up: remove trailing "Thank you" fluff
    reason = rawReason.replace(/\.?\s*Thank you.*$/i, '').replace(/\.?\s*Please check out.*$/i, '').trim();
    if (!reason) reason = rawReason.split('.')[0].trim(); // Fallback to first sentence
  }
  
  // Specific pattern matching for known FoxiGrow errors
  if (allText.includes('quota is full')) {
    const quotaMatch = allText.match(/quota is full\s*\(([^)]+)\)/i);
    reason = quotaMatch ? `No slots available (${quotaMatch[1]})` : 'No slots available (quota full)';
  } else if (allText.includes('already completed')) {
    reason = 'Task already completed';
  } else if (allText.includes('not linked') || allText.includes('not connected')) {
    reason = 'Account not linked';
  } else if (allText.includes('expired')) {
    reason = 'Task expired';
  }
  
  return { button: dismissBtn, reason };
}

/** Check if the task was successfully started (timer/upload button appeared).
 *  @param {object|null} before - snapshotStartedMarkers() taken BEFORE clicking START.
 *  Markers that already existed then belong to a previously started task (its 30s
 *  timer card stays mounted), so only NEW markers count as this task starting. */
function isTaskStarted(before = null) {
  // Method 1: "TIME LEFT" — require MORE occurrences than before
  const timeLeftCount = (document.body.innerText.match(/TIME LEFT/gi) || []).length;
  if (timeLeftCount > (before ? before.timeLeft : 0)) return true;

  // Method 2: a NEW "Upload Screenshot" element, on-screen
  const uploads = findAllElementsByText('button, div, span', 'Upload Screenshot');
  if (uploads.some(el => isInViewport(el) && !(before && before.upload.has(el)))) return true;

  // Method 3: a NEW "Copy Link" button, on-screen (post-start UI)
  const copyBtns = findAllElementsByText('button', 'copy link');
  if (copyBtns.some(el => isInViewport(el) && !(before && before.copyLink.has(el)))) return true;

  // Method 4: Check if the task's button changed to "CONTINUE" in the main list
  // BUT only if the modal has actually closed (no Cancel button visible), and only
  // for a CONTINUE that wasn't already there — other started tasks also show one.
  const cancelBtn = findAllElementsByText('button', 'cancel').find(isInViewport);
  if (!cancelBtn) {
    const continues = findAllElementsByText('button', 'continue');
    if (continues.some(el => !(before && before.continues.has(el)))) return true;
  }

  return false;
}

/** Dismiss the task view / modal by clicking the backdrop or back buttons */
function dismissModal() {
  const isFast = userSettings.competitiveMode || false;
  const clickX = Math.round(window.innerWidth / 2);
  const clickY = 15;
  
  // ── Strategy 1: Find and click the backdrop element via DOM ──
  // FoxiGrow uses a "Bottom Sheet" design — the dark area at the top is a clickable backdrop overlay.
  // Use elementFromPoint to find whatever DOM element is at (center, 15) and click it directly.
  const backdropEl = document.elementFromPoint(clickX, clickY);
  if (backdropEl) {
    log(`Strategy 1: Clicking backdrop element <${backdropEl.tagName}> at (${clickX}, ${clickY})`);
    try {
      const eventOpts = { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY };
      backdropEl.dispatchEvent(new PointerEvent('pointerdown', eventOpts));
      backdropEl.dispatchEvent(new MouseEvent('mousedown', eventOpts));
      backdropEl.dispatchEvent(new PointerEvent('pointerup', eventOpts));
      backdropEl.dispatchEvent(new MouseEvent('mouseup', eventOpts));
      backdropEl.click();
    } catch (e) {
      log(`Strategy 1 failed: ${e.message}`);
    }
  }
  
  // ── Strategy 2: Find and click any close/back/cancel buttons ──
  const closeKeywords = ['close', 'back', '×', '✕', '✖'];
  const allBtns = document.querySelectorAll('button, [role="button"], a');
  for (const btn of allBtns) {
    const text = btn.textContent.trim().toLowerCase();
    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
    if (closeKeywords.some(kw => text === kw || ariaLabel.includes(kw))) {
      log(`Strategy 2: Found close button: "${btn.textContent.trim()}"`);
      btn.click();
      break;
    }
  }
  
  // ── Strategy 3: Simulate Escape key press (closes modals in most React apps) ──
  log('Strategy 3: Dispatching Escape key');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  
  // ── Strategy 4: Debugger click on backdrop (works when debugger is attached) ──
  if (!isFast) {
    log('Strategy 4: Debugger click at backdrop');
    sendMessage({ type: 'SIMULATE_CLICK', x: clickX, y: clickY }).catch(() => {});
  }
  
  return true;
}

// ─── Keep-Alive Heartbeat ────────────────────────────────────────────────────
// Chrome Service Workers sleep after 30s. We send a ping every 20s to keep it 
// permanently awake, ensuring zero wake-up latency when a task drops.
// Uses Worker interval so it's never throttled when tab is hidden.
workerInterval(() => {
  chrome.runtime.sendMessage({ type: 'PING' }).catch(() => {});
}, 20000);

// ─── State Machine ───────────────────────────────────────────────────────────

/** Wait for a condition to be true, polling at an interval with a timeout (UNTHROTTLED) */
function waitForCondition(checkFn, interval, timeout) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const check = () => {
      if (checkFn()) {
        resolve(true);
        return;
      }
      if (Date.now() - startTime > timeout) {
        resolve(false);
        return;
      }
      workerTimeout(check, interval);
    };
    check();
  });
}

// ─── Drip Snipe Persistence ──────────────────────────────────────────────────

/** Load the persisted attempt counters and permanent blocklist. */
async function loadDripState() {
  try {
    const data = await chrome.storage.local.get(['dripState']);
    const state = data.dripState || {};
    dripAttempts = new Map(Object.entries(state.attempts || {}));

    // Prune expired blocks so the list can't grow without bound
    const now = Date.now();
    permaBlocked = new Map();
    let pruned = 0;
    for (const [taskId, info] of Object.entries(state.blocked || {})) {
      if (info && info.at && now - info.at > CONFIG.DRIP_BLOCK_TTL_MS) {
        pruned++;
        continue;
      }
      permaBlocked.set(taskId, info);
    }
    if (pruned > 0) log(`Pruned ${pruned} expired drip block(s)`);
    if (permaBlocked.size > 0) log(`Loaded ${permaBlocked.size} permanently blocked task(s)`);
    if (pruned > 0) saveDripState();
  } catch (e) {
    log(`Failed to load drip state: ${e.message}`);
  }
}

/** Persist attempt counters and the blocklist. */
function saveDripState() {
  try {
    chrome.storage.local.set({
      dripState: {
        attempts: Object.fromEntries(dripAttempts),
        blocked: Object.fromEntries(permaBlocked)
      }
    });
  } catch (e) {
    log(`Failed to save drip state: ${e.message}`);
  }
}

/** Permanently skip a task: it burned all its attempts. */
function blockTaskPermanently(taskId, reason) {
  permaBlocked.set(taskId, { at: Date.now(), reason });
  dripAttempts.delete(taskId);
  dripRearms.delete(taskId);
  processedTaskIds.add(taskId); // keeps findStartableTasks() filtering it this session
  saveDripState();
  log(`🚫 Task #${taskId} blocked permanently (${reason})`);
  sendMessage({ type: 'ADD_LOG', text: `🚫 Task #${taskId} blocked after ${CONFIG.DRIP_MAX_ATTEMPTS} attempts` });
}

// ─── Drip Snipe Scheduling ───────────────────────────────────────────────────

/** Helper to determine if a task should be completely ignored for drips. */
function isTaskIgnored(taskId) {
  const idStr = String(taskId);
  if (permaBlocked.has(idStr)) return true;
  if (processedTaskIds.has(idStr)) return true;
  if (userSettings && userSettings.blockedTaskIds) {
    const blockedIds = userSettings.blockedTaskIds.split(',').map(id => id.trim()).filter(id => id.length > 0);
    if (blockedIds.includes(idStr)) return true;
  }
  return false;
}

/** Ask the radar server when the next drip batch releases for these task IDs.
 *  Radar answers from its cached dripSummary (zero extra FoxiGrow requests) and the
 *  reply arrives asynchronously as a DRIP_INFO message. */
async function queryDripSchedule(taskIds) {
  const targets = (taskIds || [])
    .filter(id => id && id !== 'unknown' && !isTaskIgnored(id));
  if (targets.length === 0) return;

  const res = await sendMessage({ type: 'DRIP_QUERY', taskIds: targets });
  if (!res || !res.ok) {
    log(`Drip query unavailable (${res ? res.reason : 'no response'})`);
  }
}

/** Handle a DRIP_INFO / DRIP_SCHEDULE payload from the radar server.
 *  Both carry { releaseAt, serverTime } plus a list of pending task IDs. */
function handleDripInfo(msg) {
  if (msg.titles) {
    for (const [id, title] of Object.entries(msg.titles)) {
      taskTitleCache.set(Number(id), title);
    }
  }
  if (msg.totals) {
    for (const [id, total] of Object.entries(msg.totals)) {
      taskTotalSlotsCache.set(Number(id), total);
    }
  }

  const releaseAt = Number(msg.releaseAt);
  if (!releaseAt || !isFinite(releaseAt)) return;

  const pending = (msg.pending || msg.questIds || []).map(String);

  // Only chase tasks we're actually retrying: ones with a recorded failed attempt that
  // haven't burned their limit. DRIP_SCHEDULE is a broadcast that repeats whenever the
  // pending list churns, so without this filter we'd arm snipes for tasks we never tried.
  const targets = pending.filter(id => {
    if (isTaskIgnored(id)) return false;
    const attempts = dripAttempts.get(id) || 0;
    if (attempts >= CONFIG.DRIP_MAX_ATTEMPTS) return false;
    const arms = dripRearms.get(id) || 0;
    if (arms >= CONFIG.DRIP_MAX_REARMS) {
      log(`Task #${id} missed ${arms} releases without a slot, dropping chase`);
      return false;
    }
    return true;
  });


  if (targets.length === 0) return;

  // Correct for local clock skew — a 2s wrong clock destroys the snipe, and we can't
  // assume the user's machine is synced. Radar sends serverTimeMs when available; with
  // only whole-second serverTime the raw difference carries up to 1s of truncation noise,
  // so quantize to whole seconds. Real skew worth correcting is seconds, not milliseconds,
  // and leaving the noise in would push the refresh as late as releaseAt + 1.9s — outside
  // the window where slots still exist.
  let skewMs = 0;
  if (msg.serverTimeMs) {
    skewMs = Date.now() - Number(msg.serverTimeMs);
  } else if (msg.serverTime) {
    skewMs = Math.round((Date.now() - Number(msg.serverTime) * 1000) / 1000) * 1000;
  }
  const targetMs = releaseAt * 1000 + skewMs;
  const delayMs = targetMs - Date.now();

  if (delayMs < -1000) return;                 // already passed
  if (delayMs > 3600000) return;               // more than an hour out, ignore

  scheduleDripSnipe(releaseAt, targetMs, targets, skewMs);
}

/** Arm a single refresh to land just after a known drip release.
 *  Because nextReleaseAt is global (not per-task), snipes for different tasks normally
 *  share a timestamp and coalesce into one refresh — which is also what keeps us inside
 *  FoxiGrow's 10s refresh cooldown. */
function scheduleDripSnipe(releaseAt, targetMs, taskIds, skewMs) {
  // Coalesce into an existing snipe landing within the cooldown window
  for (const [key, snipe] of scheduledSnipes) {
    if (Math.abs(key * 1000 - releaseAt * 1000) <= CONFIG.DRIP_COALESCE_MS) {
      const added = [];
      taskIds.forEach(id => {
        if (!snipe.taskIds.has(id)) { snipe.taskIds.add(id); added.push(id); }
      });
      if (added.length > 0) {
        log(`🎯 Merged #${added.join(', #')} into snipe at ${new Date(key * 1000).toLocaleTimeString()} (one refresh, respects 10s cooldown)`);
      }
      return;
    }
  }

  const jitter = CONFIG.DRIP_JITTER_MIN + Math.random() * CONFIG.DRIP_JITTER_VAR;
  const preArmDelay = Math.max(0, targetMs - Date.now() - CONFIG.DRIP_PREARM_MS);
  const fireDelay = Math.max(0, targetMs + jitter - Date.now());
  const snipe = { taskIds: new Set(taskIds), preArmId: null, fireId: null, rearmId: null };
  scheduledSnipes.set(releaseAt, snipe);

  const secs = ((targetMs - Date.now()) / 1000).toFixed(1);
  log(`🎯 Drip snipe armed: #${taskIds.join(', #')} releases in ${secs}s (skew ${Math.round(skewMs)}ms, jitter ${Math.round(jitter)}ms)`);
  sendMessage({ type: 'ADD_LOG', text: `🎯 Drip snipe armed: #${taskIds.join(', #')} in ${secs}s` });
  broadcastSnipes();

  // ── T-2s: pre-arm. DOM only, zero network, zero detection surface. ──
  snipe.preArmId = workerTimeout(() => {
    if (!isEnabled || isPaused) return;
    snipe.taskIds.forEach(id => failedTaskCooldowns.delete(id));
    abortFidget = true;
    preScrollToTasks();
    startAggressiveRAFScan(CONFIG.DRIP_SCAN_WINDOW);
    logDiagnostic('system', `Drip pre-arm for #${Array.from(snipe.taskIds).join(',')}`);
  }, preArmDelay);

  // ── T+jitter: exactly one refresh. Never a burst. ──
  snipe.fireId = workerTimeout(() => {
    if (!isEnabled || isPaused) return;
    const ids = Array.from(snipe.taskIds);
    ids.forEach(id => failedTaskCooldowns.delete(id));
    log(`🎯 Drip snipe firing for #${ids.join(', #')}`);
    // sendMessage({ type: 'TRIGGER_DIRECT_REFRESH', scheduled: true, taskIds: ids });
    if (scanTimer) clearTimeout(scanTimer);
    if (currentState === STATE.SCANNING) mainLoop();
    broadcastSnipes();
  }, fireDelay);

  // ── T+jitter+3s: a release may include only a subset of pending IDs, so if our task never
  // showed up, chase the next release. This is NOT an attempt (no START was clicked), so it
  // must not consume one of the 3 strikes — but it does consume a chase arm, which is what
  // stops us following a task that has quietly stopped dripping. Arms are counted here, on a
  // release that actually passed, rather than at arm time: radar re-broadcasts
  // DRIP_SCHEDULE whenever questIds churn, so counting at arm time would burn the cap
  // without a single release having happened. ──
  snipe.rearmId = workerTimeout(() => {
    scheduledSnipes.delete(releaseAt);
    if (!isEnabled || isPaused) return;

    const startableIds = new Set(findStartableTasks().map(t => t.taskId));
    const chase = [];
    for (const id of snipe.taskIds) {
      if (isTaskIgnored(id)) {
        dripRearms.delete(id);
        continue;
      }
      if (startableIds.has(id)) {
        dripRearms.delete(id); // it showed up; the chase for it is over
        continue;
      }
      const arms = (dripRearms.get(id) || 0) + 1;
      dripRearms.set(id, arms);
      if (arms >= CONFIG.DRIP_MAX_REARMS) {
        log(`Task #${id} missed ${arms} releases, dropping chase`);
        continue;
      }
      chase.push(id);
    }

    if (chase.length > 0) {
      log(`Release skipped #${chase.join(', #')} — re-querying next drip`);
      queryDripSchedule(chase);
    }
    broadcastSnipes();
  }, fireDelay + CONFIG.DRIP_REARM_DELAY);
}

/** Broadcast active snipes to the background script for popup UI */
function broadcastSnipes() {
  const active = [];
  for (const [releaseAt, snipe] of scheduledSnipes) {
    if (releaseAt * 1000 < Date.now()) continue; // Past snipes
    for (const id of snipe.taskIds) {
      active.push({
        taskId: id,
        title: taskTitleCache.get(id) || `Task #${id}`,
        releaseAt: releaseAt * 1000
      });
    }
  }
  sendMessage({ type: 'ACTIVE_SNIPES_UPDATE', snipes: active });
}

/** Helper to manage task failure state */
function handleTaskFailure(taskId, errorReason, taskTitle = '') {
  if (taskId !== 'unknown') {
    if (taskTitle) taskTitleCache.set(taskId, taskTitle);

    // Hard-fail reasons: don't retry these tasks at all
    const hardFailReasons = ['Account not linked', 'Task already completed', 'Task expired', 'blocked'];
    const isHardFail = hardFailReasons.some(r => errorReason.includes(r));
    
    if (isHardFail) {
      // Hard fail: leave in processedTaskIds so we never retry it
      log(`Task #${taskId} hard-failed: ${errorReason}`);
    } else {
      // Remove from processed so it can be retried after cooldown
      processedTaskIds.delete(taskId);

      // Count this as a real attempt: START was clicked and the claim failed.
      // Scheduled refreshes that find nothing never reach here, so they don't burn a strike.
      const attempts = (dripAttempts.get(taskId) || 0) + 1;
      dripAttempts.set(taskId, attempts);
      saveDripState();
      log(`Task #${taskId} attempt ${attempts}/${CONFIG.DRIP_MAX_ATTEMPTS}`);

      if (attempts >= CONFIG.DRIP_MAX_ATTEMPTS) {
        blockTaskPermanently(taskId, `${attempts} failed attempts`);
        return;
      }

      // "Unable to Proceed" / slots full → 15s cooldown. A drip batch typically releases
      // ~60s later, and the scheduled snipe clears this cooldown explicitly anyway.
      const isSlotsFullFail = errorReason.includes('Unable to Proceed') || errorReason.includes('No slots') || errorReason.includes('quota');
      
      // If we know this task has a very small total slot pool, it's not worth sniping
      const totalSlots = taskTotalSlotsCache.get(taskId);
      if (totalSlots !== undefined && totalSlots < 30) {
        log(`Task #${taskId} skipped drip scheduling (Total slots: ${totalSlots} < 30)`);
        blockTaskPermanently(taskId, `Total slots < 30 (${totalSlots})`);
        return;
      }

      const cooldownMs = 30000;
      const cooldownLabel = '30s';
      
      sendBlackboxLog(`TASK_FAILED: ID=${taskId}, Reason="${errorReason}", Cooldown=30s`);
      
      failedTaskCooldowns.set(taskId, Date.now() + cooldownMs);
      log(`Task #${taskId} placed on ${cooldownLabel} cooldown (${errorReason})`);
      
      // Ask radar when this task's next batch drops so we can snipe it
      dripRearms.delete(taskId);
      queryDripSchedule([taskId]);
    }
  }
}

/** Extract the task URL from the modal content.
 *  @param {Element|null} scope - modal container; falls back to document when absent. */
function extractTaskUrl(scope = null) {
  const root = scope && scope.isConnected ? scope : document;
  try {
    // Strategy 1: Find the text next to the "Copy" button
    const elements = root.querySelectorAll('button, div, span');
    const copyBtn = Array.from(elements).find(el => {
      const t = normText(el.textContent);
      return t === 'copy' || t === 'copy link';
    });
    if (copyBtn && copyBtn.parentElement) {
      const text = copyBtn.parentElement.innerText || '';
      const match = text.match(/https?:\/\/[^\s]+/);
      if (match) return match[0];
    }
    
    // Strategy 1.5: Direct check for the FoxiGrow link element class
    const linkEl = root.querySelector('.qm-link-scroll');
    if (linkEl) {
      const text = linkEl.textContent.trim();
      if (text.startsWith('http')) return text;
    }
    
    // Strategy 2: Regex the scoped text and grab the last URL (ignores tutorial links)
    const scopeText = (root === document ? document.body.innerText : root.innerText) || '';
    const urls = scopeText.match(/https?:\/\/[^\s]+/g);
    if (urls) {
      const filtered = urls.filter(u => !u.toLowerCase().includes('tutorial') && !u.includes('youtube.com/shorts'));
      if (filtered.length > 0) {
        return filtered[filtered.length - 1]; // Task link is usually at the bottom
      }
    }
  } catch (e) {
    console.error('[FoxiExt] Error extracting URL:', e);
  }
  return '';
}

/** The main claim sequence for a single task */
async function claimTask(task) {
  const taskId = task.taskId || 'unknown';
  const taskTitle = task.taskTitle || `Task #${taskId}`;
  const button = task.button;
  
  // Mark as processed immediately so it's never retried by another loop if it fails early
  if (taskId !== 'unknown') {
    processedTaskIds.add(taskId);
  }

  logDiagnostic(taskId, 'Claim sequence initiated');
  sendBlackboxLog(`TASK_STARTING: ID=${taskId}, Title="${taskTitle}", Element="${button.textContent.trim().substring(0,25)}"`);
  log(`Starting claim sequence for ${taskTitle} (ID: #${taskId})`);

  // ── Step 0: Snapshot pre-existing DOM state ──
  // A task started moments ago keeps its 30s timer card (TIME LEFT / Copy Link /
  // Upload Screenshot) mounted in the list. Recording what already exists lets us
  // detect THIS task's modal by identity instead of by "does a marker exist anywhere",
  // which previously made the modal wait return true instantly against stale DOM.
  const preCancels = new Set(findAllElementsByText('button', 'cancel'));
  const preStartedMarkers = snapshotStartedMarkers();

  // ── Step 1: Click START ──
  currentState = STATE.CLICKING_START;
  
  if (userSettings.competitiveMode) {
    await sleep(CONFIG.COMPETITIVE_START_CLICK + Math.random() * 20); // bypass 150ms hard limit
  } else {
    await sleep(humanDelay(CONFIG.DELAY_BEFORE_START_CLICK));
  }
  
  if (!isEnabled) return; // Check if disabled during delay
  
  logDiagnostic(taskId, 'Clicking START button');
  log(`Clicking START on task #${taskId}`);
  currentState = STATE.CLAIMING;
  const startClickTime = Date.now();
  await humanClick(button);

  // ── Step 2: Wait for THIS task's modal to appear ──
  // Identity-based: we require a Cancel button that did NOT exist before the click.
  // Stale DOM can never satisfy this, so we no longer race ahead at 0ms.
  // Polling is unchanged (10ms in competitive mode), so a fast modal costs no extra delay.
  currentState = STATE.WAITING_MODAL;
  const modalTimeout = userSettings.competitiveMode ? CONFIG.COMPETITIVE_TIMEOUT : CONFIG.MODAL_WAIT_TIMEOUT;
  const pollInterval = userSettings.competitiveMode ? CONFIG.COMPETITIVE_POLL_INTERVAL : CONFIG.MODAL_WAIT_INTERVAL;
  
  let modalContainer = null;
  const modalWaitStart = Date.now();
  const modalAppeared = await waitForCondition(
    () => {
      const freshCancel = findAllElementsByText('button', 'cancel')
        .find(el => !preCancels.has(el) && isInViewport(el));
      if (freshCancel) {
        modalContainer = getModalContainer(freshCancel);
        return true;
      }
      return false;
    },
    pollInterval,
    modalTimeout
  );

  if (!modalAppeared) {
    log(`Modal did not appear for ${taskTitle}, skipping`);
    consecutiveErrors++;
    handleTaskFailure(taskId, 'modal did not appear');
    await sendMessage({ type: 'TASK_FAILED', taskId, taskTitle, usdtReward: task.usdtReward, reason: 'modal did not appear' });
    await dismissAndReturn();
    return false;
  }
  log(`Modal for #${taskId} appeared after ${Date.now() - modalWaitStart}ms`);

  // ── Step 3: Wait for GO ACTION button to render and click it ──
  currentState = STATE.CLICKING_GO;
  
  logDiagnostic(taskId, 'Modal appeared, searching for GO button');
  
  let goButton = null;
  const goButtonAppeared = await waitForCondition(
    () => {
      // Re-resolve the container each poll: React may replace the subtree as it renders
      const liveCancel = findAllElementsByText('button', 'cancel')
        .find(el => !preCancels.has(el) && isInViewport(el));
      if (liveCancel) modalContainer = getModalContainer(liveCancel);
      if (!modalContainer || !modalContainer.isConnected) return false;
      goButton = findGoActionButton(modalContainer);
      if (goButton && goButton.textContent.toLowerCase().includes('loading')) {
        return false; // Wait until it finishes loading
      }
      return !!goButton;
    },
    pollInterval,
    modalTimeout
  );

  if (!goButtonAppeared || !goButton) {
    logDiagnostic(taskId, 'GO button failed to appear (timeout)');
    log(`GO action button not found for ${taskTitle}`);
    consecutiveErrors++;
    handleTaskFailure(taskId, 'GO button not found');
    await sendMessage({ type: 'TASK_FAILED', taskId, taskTitle, usdtReward: task.usdtReward, reason: 'GO button not found' });
    // Still need to dismiss modal
    await dismissAndReturn();
    return false;
  }

  if (userSettings.competitiveMode) {
    await sleep(CONFIG.COMPETITIVE_GO_CLICK); // 0ms after it renders
  } else {
    await sleep(humanDelay(CONFIG.DELAY_BEFORE_GO_CLICK));
  }
  
  if (!isEnabled) return false;

  // ── Wait for GO button to actually be in viewport (modal slide-up animation) ──
  const GO_VIEWPORT_POLL_MS = 30;
  const GO_VIEWPORT_MAX_WAIT = CONFIG.GO_VIEWPORT_MAX_WAIT;
  const goWaitStart = Date.now();
  let goRect = goButton.getBoundingClientRect();
  // Wait until the bottom is fully visible in the viewport so humanClick() doesn't fall back to synthetic .click()
  while (goRect.top < 0 || goRect.bottom > window.innerHeight) {
    if (Date.now() - goWaitStart > GO_VIEWPORT_MAX_WAIT) {
      console.warn(`[FoxiExt] GO button still off-screen after ${GO_VIEWPORT_MAX_WAIT}ms (top=${Math.round(goRect.top)}), proceeding anyway`);
      break;
    }
    await sleep(GO_VIEWPORT_POLL_MS);
    goRect = goButton.getBoundingClientRect();
  }
  const goAnimWait = Date.now() - goWaitStart;
  if (goAnimWait > 0) {
    log(`GO button entered viewport after ${goAnimWait}ms`);
  }

  logDiagnostic(taskId, 'Clicking GO button');
  log(`Clicking GO action for task #${taskId}: "${goButton.textContent.trim()}"`);
  
  // ── Extract Task URL (attempt 1: before GO click) ──
  let taskUrl = '';
  taskUrl = extractTaskUrl(modalContainer);
  
  if (userSettings.competitiveMode) {
    const elapsedSinceStart = Date.now() - startClickTime;
    if (elapsedSinceStart < 350) {
      const remainingWait = 350 - elapsedSinceStart;
      logDiagnostic(taskId, `Enforcing strict 350ms gap. Waiting ${remainingWait}ms...`);
      await sleep(remainingWait);
    }
  }
  
  await humanClick(goButton);
  
  // ── Extract Task URL (attempt 2: after GO click, content may have rendered now) ──
  if (!taskUrl) {
    await sleep(100); // Give the page a moment to update after click
    taskUrl = extractTaskUrl(modalContainer);
    if (taskUrl) {
      log(`Task URL found on second attempt (after GO click): ${taskUrl}`);
    }
  }

  // ── Step 4: Check if task started (or if error screen appeared) ──
  currentState = STATE.CHECKING;

  let started = false;
  let errorReason = 'task did not start';
  
  // Custom wait loop to check for both Success and "Got It" error screen
  const checkStartTime = Date.now();
  const resultTimeout = userSettings.competitiveMode ? CONFIG.COMPETITIVE_TIMEOUT : CONFIG.RESULT_WAIT_TIMEOUT;
  
  logDiagnostic(taskId, 'Waiting for verification');
  
  while (Date.now() - checkStartTime < resultTimeout) {
    if (isTaskStarted(preStartedMarkers)) {
      started = true;
      break;
    }
    
    // Check if an "Unable to Proceed" error screen appeared
    const errorScreen = findErrorScreen();
    if (errorScreen) {
      log(`Error screen detected for ${taskTitle}: ${errorScreen.reason}`);
      errorReason = errorScreen.reason;
      // Click the dismiss button ("Got It", "Browse Other Quests", etc.)
      await humanClick(errorScreen.button);
      // Wait for it to close before continuing
      await sleep(userSettings.competitiveMode ? 200 : 1000);
      break; 
    }
    
    await sleep(CONFIG.RESULT_WAIT_INTERVAL);
  }

  // ── Step 5: Handle result and dismiss modal ──
  if (started) {
    logDiagnostic(taskId, 'Verification succeeded');
    log(`✅ Task #${taskId} started successfully!`);
    await sendMessage({ type: 'TASK_SUCCESS', taskId: task.taskId });

    // Won it — clear the retry counters so a future drip starts from a clean slate
    if (dripAttempts.has(taskId)) {
      dripAttempts.delete(taskId);
      dripRearms.delete(taskId);
      saveDripState();
    }
    
    if (task.usdtReward > 0) {
        log(`Recording reward: ${task.usdtReward} USDT`);
        await sendMessage({ type: 'RECORD_REWARD', usdtAmount: task.usdtReward });
    }

    // ── Extract Task URL (attempt 3: post-start UI is now rendered) ──
    // The "Copy Link" element only exists in the started view, so this is the first
    // point where the URL is reliably present in the DOM.
    if (!taskUrl) {
      taskUrl = extractTaskUrl(modalContainer) || extractTaskUrl();
      if (taskUrl) log(`Task URL found on third attempt (post-start): ${taskUrl}`);
    }

    consecutiveErrors = 0;
    await sendMessage({ type: 'TASK_STARTED', taskId, taskTitle, taskUrl, usdtReward: task.usdtReward });
  } else {
    logDiagnostic(taskId, `Verification failed (${errorReason})`);
    log(`❌ ${taskTitle} failed to start (${errorReason})`);
    consecutiveErrors++;
    handleTaskFailure(taskId, errorReason);
    await sendMessage({ type: 'TASK_FAILED', taskId, taskTitle, usdtReward: task.usdtReward, reason: errorReason });
  }

  // ── Step 5: Dismiss modal ──
  await dismissAndReturn();
  
  // ── Step 6: Recover from Stale Cache ──
  // If FoxiGrow said the account wasn't linked, their React Query profile cache might be stuck/stale 
  // (which happens if the JWT token was swapped or a previous background API call failed).
  // We force a hard reload so the next task doesn't fail for the same fake reason.
  if (!started && (errorReason.includes('Account not linked') || errorReason.includes('not connected'))) {
    log('🔄 Forcing page reload to clear stale profile cache...');
    await sendMessage({ type: 'ADD_LOG', text: '🔄 Refreshing stale account cache...' });
    setTimeout(() => {
      window.location.reload();
    }, 1000); // Give the modal time to finish its closing animation
  }

  return started;
}

/** Dismiss the modal and return to the task list */
async function dismissAndReturn() {
  currentState = STATE.DISMISSING;
  if (userSettings.competitiveMode) {
    await sleep(0); // Instant dismiss in competitive mode
  } else {
    await sleep(humanDelay(CONFIG.DELAY_BEFORE_DISMISS));
  }

  dismissModal();
  
  // Wait for the modal to actually close
  await sleep(userSettings.competitiveMode ? 100 : 300);

  // If modal is still open, try again
  if (isModalOpen()) {
    log('Modal still open, trying dismiss again...');
    dismissModal();
    await sleep(userSettings.competitiveMode ? 150 : 500);
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

/** The main scanning and claiming loop */
async function mainLoop() {
  if (isMainLoopRunning) return;
  isMainLoopRunning = true;
  
  try {
    if (!isEnabled) {
      currentState = STATE.PAUSED;
      log('Extension is disabled, waiting...');
      return;
    }
  
  if (isPaused) {
    currentState = STATE.PAUSED;
    log('Bot is paused, waiting...');
    return;
  }

  // Safety: pause after too many consecutive errors
  if (consecutiveErrors >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
    if (userSettings.competitiveMode) {
      log(`Hit ${consecutiveErrors} consecutive errors, but ignoring pause due to Competitive Mode!`);
      consecutiveErrors = 0; // Reset and keep fighting
    } else {
      currentState = STATE.ERROR;
      log(`Too many consecutive errors (${consecutiveErrors}), pausing for 30s...`);
      await logStatus(`Paused: ${consecutiveErrors} consecutive errors`);
      await sleep(30000);
      consecutiveErrors = 0;
    }
  }

  currentState = STATE.INITIALIZING;

  // Make sure we're on the Tasks tab
  if (!isOnTasksTab()) {
    log('Not on Tasks tab, navigating...');
    await logStatus('Navigating to Tasks tab...');
    navigateToTasksTab();
    await sleep(2000); // Wait for tab to load
    if (!isOnTasksTab()) {
      log('Failed to navigate to Tasks tab');
      scheduleNextScan();
      return;
    }
  }

  currentState = STATE.SCANNING;
  await logStatus('Scanning for tasks...');

  // Find startable tasks FIRST
  const startableTasks = findStartableTasks();

  if (startableTasks.length === 0) {
    // Only process scheduled reloads if the screen is empty
    if (Date.now() >= nextHardReloadTime) {
      log('🔄 Performing scheduled hard reload to flush caches...');
      await sendMessage({ type: 'ADD_LOG', text: '🔄 Scheduled hard reload...' });
      window.location.reload();
      return;
    }

    if (Date.now() >= nextReloadTime) {
      const reloadBtn = findReloadButton();
      if (reloadBtn) {
        log('Clicking reload button...');
        await logStatus('Reloading tasks...');
        lastRefreshClickAt = Date.now();
        await humanClick(reloadBtn);
        nextReloadTime = Date.now() + randomDelay(CONFIG.RELOAD_INTERVAL);
        await sleep(2000); 
      } else {
        nextReloadTime = Date.now() + 5000;
      }
    }

    // No tasks to start — wait and try again
    log('No startable tasks found, waiting...');
    if (!isFidgeting) {
      idleFidget();
    }
    scheduleNextScan();
    return;
  }

  // Found tasks! Abort any ongoing fidgets
  abortFidget = true;

  log(`Found ${startableTasks.length} startable task(s)`);

  // Process the first startable task
  const task = startableTasks[0];
  await claimTask(task);

  // After claiming, immediately scan for more (don't wait for the full interval)
  if (userSettings.competitiveMode) {
    await sleep(500); // Strict 500ms minimum delay between consecutive tasks
  } else {
    // Ensure delay is at least 500ms even with random variation
    const delay = Math.max(500, humanDelay(CONFIG.DELAY_BEFORE_NEXT_SCAN));
    await sleep(delay);
  }
  
  if (isEnabled && !isPaused) {
    // Break recursion by scheduling the next iteration asynchronously
    setTimeout(mainLoop, 0); 
  }
  
  } finally {
    isMainLoopRunning = false;
  }
}

/** Schedule the next scan (UNTHROTTLED — works in background tabs) */
function scheduleNextScan() {
  if (scanTimer) clearTimeout(scanTimer);
  // Variable scan interval with occasional longer pauses
  let interval = randomDelay(CONFIG.SCAN_INTERVAL);
  if (Math.random() < 0.1) interval += 5000 + Math.random() * 7000; // 10% chance of 5-12s pause
  scanTimer = workerTimeout(() => {
    if (isEnabled && !isPaused) mainLoop();
  }, interval);
}

// ─── Idle Fidgeting ──────────────────────────────────────────────────────────
async function idleFidget() {
  if (isFidgeting) return;
  isFidgeting = true;
  abortFidget = false;
  
  while (isEnabled && !isPaused && currentState === STATE.SCANNING && !abortFidget) {
    // Variable wait between fidgets — sometimes rapid, sometimes calm
    let waitTime;
    const roll = Math.random();
    if (roll < 0.05) {
      waitTime = 15000 + Math.random() * 15000; // 5% chance: long pause 15-30s
    } else if (roll < 0.25) {
      waitTime = 8000 + Math.random() * 7000;   // 20% chance: medium pause 8-15s
    } else if (roll < 0.5) {
      waitTime = 4000 + Math.random() * 4000;   // 25% chance: normal 4-8s
    } else {
      waitTime = 2000 + Math.random() * 2000;   // 50% chance: quick 2-4s
    }
    
    const waited = await fidgetSleep(waitTime);
    if (!waited) break;
    
    // Weighted random action selection (not 50/50)
    const action = Math.random();
    if (action < 0.35) {
      // 35%: Aimless scroll
      const maxScroll = window.innerHeight * 0.4;
      const scrollAmt = (Math.random() * maxScroll * 2) - maxScroll;
      window.scrollBy({ top: scrollAmt, behavior: 'smooth' });
    } else if (action < 0.55) {
      // 20%: Wandering mouse
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * window.innerHeight;
      await sendMessage({ type: 'SIMULATE_MOUSE_MOVE', x, y });
    } else if (action < 0.70) {
      // 15%: Small scroll + mouse combo
      window.scrollBy({ top: (Math.random() - 0.5) * 100, behavior: 'smooth' });
      await fidgetSleep(300 + Math.random() * 400);
      if (abortFidget) break;
      const x = Math.random() * window.innerWidth;
      const y = Math.random() * window.innerHeight;
      await sendMessage({ type: 'SIMULATE_MOUSE_MOVE', x, y });
    } else {
      // 30%: Do nothing — just wait (humans zone out)
    }
  }
  
  isFidgeting = false;
}

// ─── MutationObserver Setup ──────────────────────────────────────────────────

/** Set up a MutationObserver to detect new tasks appearing in the DOM */
function setupObserver() {
  if (observer) {
    observer.disconnect();
  }

  observer = new MutationObserver((mutations) => {
    if (!isEnabled || isPaused || currentState !== STATE.SCANNING) return;

    // Check if any new START buttons appeared
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const buttons = node.querySelectorAll ? node.querySelectorAll('button') : [];
          for (const btn of buttons) {
            if (btn.textContent.trim().toLowerCase() === 'start') {
              // Extract ID right away just for the log
              const detectedId = extractTaskId(node);
              log(`⚡ TASK DETECTED in HTML: #${detectedId}`);
              
              // Micro-delay: fast human reflex, not instant bot
              if (scanTimer) clearTimeout(scanTimer);
              abortFidget = true;
              
              const baseWait = userSettings.competitiveMode ? CONFIG.COMPETITIVE_REFLEX_MIN : 200;
              const varWait = userSettings.competitiveMode ? CONFIG.COMPETITIVE_REFLEX_VAR : 300;
              
              workerTimeout(() => {
                if (isEnabled && !isPaused) mainLoop();
              }, baseWait + Math.random() * varWait);
              return;
            }
          }
        }
      }
    }
  });

  // Observe the entire document body for changes
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  log('MutationObserver set up');
}

// ─── Message Handling (from background) ──────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STATE_CHANGED') {
    isEnabled = message.isEnabled;
    if (message.isPaused !== undefined) {
      isPaused = message.isPaused;
    }
    
    log('State changed: Enabled:', isEnabled, 'Paused:', isPaused);
    
    if (isEnabled && !isPaused) {
      mainLoop();
    } else {
      currentState = STATE.PAUSED;
      abortFidget = true;
      if (scanTimer) clearTimeout(scanTimer);
    }
    sendResponse({ ok: true });
  } else if (message.type === 'FOXIEXT_FETCH_COMPLETED') {
    logDiagnostic('system', 'Intercepted XHR/Fetch completion');
    if (isEnabled && !isPaused && currentState === STATE.SCANNING) {
      startAggressiveRAFScan(2000);
    }
    sendResponse({ ok: true });
  } else if (message.type === 'RADAR_RELOAD') {
    const scheduled = !!message.scheduled;
    logDiagnostic('system', scheduled ? 'Drip snipe refresh' : 'Radar Drop signal received');
    log(scheduled ? '🎯 Drip snipe refresh + immediate scan' : '⚡ Radar signal! Lightweight refresh + immediate scan');
    
    // ── PHASE 1: Start scanning IMMEDIATELY (zero delay) ──
    startAggressiveRAFScan(scheduled ? CONFIG.DRIP_SCAN_WINDOW : 8000);
    
    // ── PHASE 2: Click the native refresh button, unless it's still inside FoxiGrow's
    // client-side ~10s cooldown. In that case the native tab bounce background.js already
    // performed is our refetch: it drives React's window-focus refetch through a different
    // path that the disabled button doesn't gate. ──
    const sinceClick = Date.now() - lastRefreshClickAt;
    if (sinceClick >= CONFIG.DRIP_REFRESH_LOCK_MS) {
      const reloadBtn = findReloadButton();
      if (reloadBtn) {
          logDiagnostic('system', 'Radar Drop: Clicking native refresh button');
          lastRefreshClickAt = Date.now();
          humanClick(reloadBtn);
      }
    } else {
      log(`Refresh button locked (${Math.ceil((CONFIG.DRIP_REFRESH_LOCK_MS - sinceClick) / 1000)}s), relying on tab bounce`);
      logDiagnostic('system', 'Refresh button on cooldown, tab bounce only');
    }
    
    // ── PHASE 3: Wait for DOM Update (Native Tab Bounce should trigger React Query) ──
    setTimeout(() => {
      if (isEnabled && !isPaused && currentState === STATE.SCANNING) {
        const startable = findStartableTasks();
        if (startable.length === 0) {
          log('🔄 Task not found yet. Extending scan window for API lag...');
          // Extend the RAF scan to cover any network lag from the Native Tab Bounce fetch
          startAggressiveRAFScan(6000);
        }
      }
    }, 500);

    sendResponse({ ok: true });
  } else if (message.type === 'DRIP_SCHEDULE' || message.type === 'DRIP_INFO') {
    // Drip tasks are no longer refreshed, only new tasks.
    sendResponse({ ok: true });
  } else if (message.type === 'CANCEL_SNIPE') {
    const idToCancel = message.taskId;
    for (const [releaseAt, snipe] of scheduledSnipes) {
      if (snipe.taskIds.has(idToCancel)) {
        snipe.taskIds.delete(idToCancel);
        log(`❌ Cancelled scheduled snipe for #${idToCancel}`);
        if (snipe.taskIds.size === 0) {
          if (snipe.preArmId) clearWorkerTimeout(snipe.preArmId);
          if (snipe.fireId) clearWorkerTimeout(snipe.fireId);
          if (snipe.rearmId) clearWorkerTimeout(snipe.rearmId);
          scheduledSnipes.delete(releaseAt);
        }
      }
    }
    broadcastSnipes();
    sendResponse({ ok: true });
  }
  return true;
});

  chrome.storage.onChanged.addListener(async (changes, namespace) => {
    if (namespace === 'local' && changes.settings) {
      const oldSettings = userSettings;
      userSettings = changes.settings.newValue || {};
      log('Settings updated from storage');
      
      // If competitive mode was toggled, let the user know in the UI
      if (oldSettings.competitiveMode !== userSettings.competitiveMode) {
        if (userSettings.competitiveMode) {
          await sendMessage({ type: 'ADD_LOG', text: '⚡ Competitive Mode ENABLED' });
        } else {
          await sendMessage({ type: 'ADD_LOG', text: '🐢 Safe Mode ENABLED' });
        }
      }
    }
  });

// ─── Initialization ──────────────────────────────────────────────────────────

async function init() {
  log('Content script loaded on', window.location.href);

  // Load settings
  const data = await chrome.storage.local.get(['settings']);
  userSettings = data.settings || {};

  // Load persisted drip attempt counters / blocklist. Must happen before the first scan:
  // page reloads wipe in-memory state, so this is what makes the 3-strike rule stick.
  await loadDripState();

  // Check if extension is enabled
  const response = await sendMessage({ type: 'GET_ENABLED' });
  isEnabled = response?.isEnabled || false;
  isPaused = response?.isPaused || false;

  log('Extension enabled:', isEnabled, 'Paused:', isPaused);
  
  // Set initial reload times
  nextReloadTime = Date.now() + randomDelay(CONFIG.RELOAD_INTERVAL);
  nextHardReloadTime = Date.now() + randomDelay(CONFIG.HARD_RELOAD_INTERVAL);

  // ── Visibility Change Tracking ──
  // Log when the tab goes to background so you can see if performance degrades
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      log('👁️ Tab is now HIDDEN (background) — Worker timing keeps us alive');
      sendMessage({ type: 'STATUS_UPDATE', status: '👁️ Tab hidden — Worker timing active' });
    } else {
      log('👁️ Tab is now VISIBLE (foreground)');
      sendMessage({ type: 'STATUS_UPDATE', status: '👁️ Tab visible — full speed' });
      // Immediately re-scan when user comes back (tasks may have appeared while hidden)
      if (isEnabled && !isPaused && currentState === STATE.SCANNING) {
        startAggressiveRAFScan(3000);
      }
    }
  });

  // Set up MutationObserver regardless of enabled state
  // (it will only trigger actions when enabled)
  setupObserver();

  // Start main loop if enabled and not paused
  if (isEnabled && !isPaused) {
    // Wait a moment for the page to fully render
    await sleep(2000);
    mainLoop();
  }
}

// Start
init();
