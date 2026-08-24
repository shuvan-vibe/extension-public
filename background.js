/**
 * FoxiGrow Auto-Claimer — Background Service Worker
 * 
 * Orchestrates the full flow:
 * 1. Opens Telegram Web → Launch App → Extract mini app URL
 * 2. Opens standalone tma.foxigrow.com tab for scanning
 * 3. Refreshes auth every hour by repeating step 1
 * 
 * Also manages ON/OFF state, Chrome notifications, and stats.
 */

// ─── Imports ─────────────────────────────────────────────────────────────────
importScripts('firebase.js');

// ─── Constants ───────────────────────────────────────────────────────────────
const TELEGRAM_URL = 'https://web.telegram.org/k/#@FoxiGrowbot';
const AUTH_REFRESH_MINUTES = 55; // Refresh 5 min before the 1-hour expiry
const ALARM_NAME = 'auth-refresh';

// ─── State ───────────────────────────────────────────────────────────────────
let isEnabled = false;
let isPaused = false;
let pendingLaunch = false; // True when we're waiting for Telegram to launch the mini app
let telegramTabId = null;
let foxigrowTabId = null;
let diagnosticLogs = []; // Stores high-precision profiling data

/** Automatically recover tab ID if Service Worker restarted */
async function getFoxiTabId() {
  if (foxigrowTabId) {
    try {
      await chrome.tabs.get(foxigrowTabId);
      return foxigrowTabId;
    } catch (e) {
      foxigrowTabId = null;
    }
  }
  const tabs = await chrome.tabs.query({ url: "*://tma.foxigrow.com/*" });
  if (tabs.length > 0) {
    foxigrowTabId = tabs[0].id;
    await ensureDebuggerAttached(foxigrowTabId);
    return foxigrowTabId;
  }
  return null;
}

let stats = {
  tasksStarted: 0,
  tasksFailed: 0,
  sessionStart: null,
  lastAction: null,
  lastAuthRefresh: null,
  activityLog: [],
  usdtEarned: 0,
  startedTaskIds: [],
  failedTaskIds: [],
  activeSnipes: []
};

// ─── Initialize ──────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['isEnabled', 'isPaused', 'stats'], (data) => {
    isEnabled = data.isEnabled || false;
    isPaused = data.isPaused || false;
    if (data.stats) stats = { ...stats, ...data.stats };
    console.log('[FoxiExt-BG] Extension installed. Enabled:', isEnabled);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function updateExtensionIcon(src) {
  if (!src) return;
  const url = chrome.runtime.getURL(src);
  fetch(url)
    .then(r => r.blob())
    .then(createImageBitmap)
    .then(bitmap => {
      const canvas = new OffscreenCanvas(128, 128);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, 128, 128);
      const imageData = ctx.getImageData(0, 0, 128, 128);
      chrome.action.setIcon({ imageData: { "128": imageData } }, () => {
        if (chrome.runtime.lastError) {
          console.error('[FoxiExt-BG] Error setting icon:', chrome.runtime.lastError);
        }
      });
    })
    .catch(err => console.error('[FoxiExt-BG] Failed to update icon:', err));
}

// Load state on startup
chrome.storage.local.get(['isEnabled', 'isPaused', 'stats', 'settings'], (data) => {
  isEnabled = data.isEnabled || false;
  isPaused = data.isPaused || false;
  if (data.stats) stats = { ...stats, ...data.stats };
  if (data.settings) {
    if (data.settings.radarServerUrl) {
      connectRadar(data.settings.radarServerUrl);
    }
    if (data.settings.displayPicture) {
      updateExtensionIcon(data.settings.displayPicture);
    }
  }
});

// ─── Radar Server (WebSocket) ────────────────────────────────────────────────
let radarWs = null;
let radarReconnectTimer = null;
let radarPingTimer = null;
let radarConnected = false;
let radarHighestId = 0;
let lastRadarReloadTime = 0;

/** Trigger the safe hardware-click fallback sequence via content.js.
 *  @param {object} opts
 *  @param {boolean} opts.scheduled - true for a drip snipe fired by content.js at a known
 *    release time. Scheduled snipes carry `bounceOnly` guidance and are never dropped by
 *    the 12s signal cooldown, since missing the scheduled instant defeats the whole point.
 *  @param {string[]} opts.taskIds - drip task IDs this refresh is targeting (for logging). */
function triggerRadarRefresh(opts = {}) {
  const { scheduled = false, taskIds = [] } = opts;
  getFoxiTabId().then(tabId => {
    if (!tabId) return;
    
    // 1. NATIVE TAB BOUNCE (Undetectable React Query Trigger)
    // To trigger React's `refetchOnWindowFocus` natively (with isTrusted=true),
    // we briefly switch the active tab to the Telegram tab, then instantly back.
    // This path is NOT gated by FoxiGrow's client-side refresh-button cooldown.
    if (telegramTabId && telegramTabId !== tabId) {
      chrome.tabs.update(telegramTabId, { active: true }).then(() => {
        chrome.tabs.update(tabId, { active: true }).catch(() => {});
      }).catch(() => {});
      addToLog('🔄 Triggered Native Tab Bounce (Focus Event)');
    }
    
    // 2. Notify content script to execute the safe, hardware-level refresh (native button click or DOM tab switch)
    chrome.tabs.sendMessage(tabId, { type: 'RADAR_RELOAD', scheduled, taskIds }).catch(() => {});
    if (scheduled) {
      addToLog(`🎯 Drip snipe refresh${taskIds.length ? ` for #${taskIds.join(', #')}` : ''}`);
    } else {
      addToLog('🔄 Triggered hardware-level DOM refresh');
    }
  });
}

/** Forward a radar message to the FoxiGrow content script. */
function forwardToFoxiTab(payload) {
  getFoxiTabId().then(tabId => {
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, payload).catch(() => {});
  });
}

function connectRadar(url) {
  if (radarWs) {
    radarWs.close();
    radarWs = null;
  }
  if (radarReconnectTimer) clearTimeout(radarReconnectTimer);
  if (!url || !url.startsWith('ws')) return;

  try {
    radarWs = new WebSocket(url);
    
    radarWs.onopen = () => {
      radarConnected = true;
      console.log('[FoxiExt-BG] Radar WS Connected');
      addToLog('📡 Radar Server Connected');
      radarWs.send(JSON.stringify({ type: 'STATUS', isEnabled }));
      
      // Keep WebSocket alive with a periodic ping to prevent reverse proxy idle timeouts (e.g. Cloudflare/Railway)
      if (radarPingTimer) clearInterval(radarPingTimer);
      radarPingTimer = setInterval(() => {
        if (radarWs && radarWs.readyState === WebSocket.OPEN) {
          radarWs.send(JSON.stringify({ type: 'PING' }));
        }
      }, 25000); // 25s is safe for most 30s/55s load balancer timeouts
    };

    radarWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        let isBrandNewTask = false;
        if (msg.taskId) {
           const tid = parseInt(msg.taskId, 10) || 0;
           if (tid > radarHighestId) {
             isBrandNewTask = true;
           }
           radarHighestId = Math.max(radarHighestId, tid);
        }
        
        if (msg.type === 'TASK_DROP') {
          console.log('[FoxiExt-BG] RADAR SIGNAL RECEIVED:', msg);

          // We trigger a DOM refresh if:
          // 1. The signal has NO taskId (legacy global drop)
          // 2. The signal HAS a taskId, but it's HIGHER than any task we've ever seen (Brand New Task!)
          // If it has a taskId we've seen before, it's just a recurring drip batch and we let the sniper handle it.
          const shouldRefresh = !msg.taskId || isBrandNewTask;

          if (!shouldRefresh) {
            console.log(`[FoxiExt-BG] Drip release for #${msg.taskId} — no refresh (sniper handles chased tasks)`);
          } else if (isEnabled && !isPaused && foxigrowTabId) {
            const now = Date.now();
            if (now - lastRadarReloadTime >= 12000) {
              lastRadarReloadTime = now;
              console.log(`[FoxiExt-BG] ${isBrandNewTask ? 'BRAND NEW TASK' : 'GLOBAL DROP'} detected! Refreshing DOM...`);
              triggerRadarRefresh();
            } else {
              const waitSec = Math.ceil((12000 - (now - lastRadarReloadTime)) / 1000);
              console.log(`[FoxiExt-BG] Radar signal ignored (12s cooldown active, wait ${waitSec}s)`);
            }
          }
        } else if (msg.type === 'DRIP_SCHEDULE' || msg.type === 'DRIP_INFO') {
          // Drip release clock / query answer. content.js owns all snipe scheduling
          // because the service worker can be evicted and chrome.alarms only has
          // 1-minute granularity, which is useless for a ~60s drip cycle.
          if (isEnabled && !isPaused) {
            forwardToFoxiTab(msg);
          }
        }
      } catch (e) {
        console.error('[FoxiExt-BG] Error parsing WS message:', e);
      }
    };

    radarWs.onclose = () => {
      if (radarPingTimer) clearInterval(radarPingTimer);
      radarConnected = false;
      console.log('[FoxiExt-BG] Radar WS Disconnected');
      radarReconnectTimer = setTimeout(() => connectRadar(url), 5000); // Reconnect in 5s
    };

    radarWs.onerror = (error) => {
      if (radarPingTimer) clearInterval(radarPingTimer);
      radarConnected = false;
      console.error('[FoxiExt-BG] Radar WS Error:', error);
    };
  } catch (err) {
    console.error('[FoxiExt-BG] Radar WS Setup Error:', err);
  }
}

// Watch for setting changes to reconnect WebSocket
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.settings) {
    const oldUrl = changes.settings.oldValue?.radarServerUrl;
    const newUrl = changes.settings.newValue?.radarServerUrl;
    if (newUrl !== oldUrl) {
      console.log(`[FoxiExt-BG] Radar URL changed from ${oldUrl} to ${newUrl}`);
      connectRadar(newUrl);
    }
  }
});

// ─── Auth Refresh Flow ───────────────────────────────────────────────────────

/** Start the full launch flow: open Telegram → Launch App → extract URL */
async function startLaunchFlow() {
  addToLog('🔄 Starting auth refresh flow...');
  pendingLaunch = true;

  // Open Telegram Web to FoxiGrowBot FIRST to avoid closing the last tab
  console.log('[FoxiExt-BG] Opening Telegram Web...');
  const tab = await chrome.tabs.create({ url: TELEGRAM_URL, active: true });
  const newTelegramTabId = tab.id;

  // Ensure window is not minimized so Telegram can actually load
  if (tab.windowId) {
    try {
      const win = await chrome.windows.get(tab.windowId);
      if (win.state === 'minimized') {
        await chrome.windows.update(tab.windowId, { state: 'normal', focused: true });
      }
    } catch (e) { /* ignore */ }
  }

  // Close existing foxigrow tab if any
  if (foxigrowTabId) {
    try {
      await chrome.tabs.remove(foxigrowTabId);
    } catch (e) { /* tab might already be closed */ }
    foxigrowTabId = null;
  }

  // Close existing telegram tab if any
  if (telegramTabId) {
    try {
      await chrome.tabs.remove(telegramTabId);
    } catch (e) { /* tab might already be closed */ }
  }

  telegramTabId = newTelegramTabId;
  addToLog('📱 Opened Telegram Web, waiting for page load...');

  // The telegram-content.js will be injected automatically
  // It will check with us via SHOULD_LAUNCH message and start the flow
}

/** Handle the mini app URL being found by telegram-content.js */
async function handleMiniAppUrl(url) {
  console.log('[FoxiExt-BG] Mini app URL received:', url);
  addToLog('✅ Got fresh auth URL');
  pendingLaunch = false;

  // Open the standalone foxigrow tab FIRST to avoid closing the browser
  const tab = await chrome.tabs.create({ url: url, active: true });
  const newFoxigrowTabId = tab.id;

  // Close the Telegram tab
  if (telegramTabId) {
    try {
      // Small delay to let the iframe fully load
      setTimeout(async () => {
        try {
          await chrome.tabs.remove(telegramTabId);
        } catch (e) { /* ignore */ }
        telegramTabId = null;
      }, 2000);
    } catch (e) { /* ignore */ }
  }

  foxigrowTabId = newFoxigrowTabId;
  
  // Attach debugger for anti-detect human clicks and stealth network interception
  try {
    await chrome.debugger.attach({ tabId: foxigrowTabId }, '1.3');
    console.log('[FoxiExt-BG] Debugger attached to FoxiGrow tab');
    // Enable Network tracking to detect API responses outside the sandbox
    await chrome.debugger.sendCommand({ tabId: foxigrowTabId }, 'Network.enable');
  } catch (err) {
    console.error('[FoxiExt-BG] Failed to attach debugger:', err);
  }
  
  stats.lastAuthRefresh = Date.now();
  chrome.storage.local.set({ stats });
  addToLog('🦊 Opened FoxiGrow standalone tab');

  // Set up the next auth refresh alarm
  setupAuthRefreshAlarm();
}

/** Set up the hourly auth refresh alarm */
function setupAuthRefreshAlarm() {
  chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: AUTH_REFRESH_MINUTES
  });
  console.log(`[FoxiExt-BG] Auth refresh alarm set for ${AUTH_REFRESH_MINUTES} minutes`);
  addToLog(`⏰ Next auth refresh in ${AUTH_REFRESH_MINUTES} min`);
}

async function verifyLicenseInBackground() {
  const data = await chrome.storage.local.get(['licenseKey', 'deviceId']);
  if (!data.licenseKey) return false;
  if (data.licenseKey === 'ADMIN-PERMANENT-KEY') return true;
  
  if (typeof globalThis.FirebaseApi === 'undefined') return false;
  try {
    const license = await globalThis.FirebaseApi.getLicense(data.licenseKey);
    if (license && license.error) {
      // Network error, assume valid for now to avoid stopping bot during brief disconnects
      return true;
    }
    if (license && license.active && license.expiresAt > Date.now()) {
        if (!license.deviceId || license.deviceId === data.deviceId) {
            return true;
        }
    }
  } catch (e) {
    return true; // Fail open on unexpected errors during background check
  }
  // Invalidate the popup's 24h auth cache so it stops showing the dashboard
  chrome.storage.local.remove('lastAuthCheck');
  return false;
}

// Check license every 30 minutes
chrome.alarms.get('license-check', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('license-check', { periodInMinutes: 30 });
  }
});

// Handle alarm firing
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'license-check' && isEnabled) {
    const valid = await verifyLicenseInBackground();
    if (!valid) {
      addToLog('🛑 License expired. Stopping bot.');
      sendTelegramMessage('🛑 <b>FoxiGrow Bot Stopped!</b>\nYour license key has expired or is invalid.');
      
      isEnabled = false;
      isPaused = false;
      chrome.storage.local.set({ isEnabled, isPaused });
      pendingLaunch = false;
      
      if (foxigrowTabId) chrome.tabs.remove(foxigrowTabId).catch(() => {});
      if (telegramTabId) chrome.tabs.remove(telegramTabId).catch(() => {});
      foxigrowTabId = null;
      telegramTabId = null;
      
      // Send session summary to Telegram and reset the session stats
      endSession();
      
      broadcastToContentScripts({ type: 'STATE_CHANGED', isEnabled, isPaused });
    }
    return;
  }

  if (alarm.name === ALARM_NAME && isEnabled) {
    console.log('[FoxiExt-BG] Auth refresh alarm fired');
    addToLog('⏰ Auth refresh alarm fired');
    
    // Always check license before refreshing auth
    const valid = await verifyLicenseInBackground();
    if (!valid) {
      addToLog('🛑 License expired. Stopping bot.');
      isEnabled = false;
      isPaused = false;
      chrome.storage.local.set({ isEnabled, isPaused });
      pendingLaunch = false;
      if (foxigrowTabId) chrome.tabs.remove(foxigrowTabId).catch(() => {});
      if (telegramTabId) chrome.tabs.remove(telegramTabId).catch(() => {});
      foxigrowTabId = null;
      telegramTabId = null;
      endSession();
      broadcastToContentScripts({ type: 'STATE_CHANGED', isEnabled, isPaused });
      return;
    }
    
    // Refresh auth even if paused, to preserve the session
    startLaunchFlow();
  }
});

// Handle tab close - detect if user manually closed our tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === foxigrowTabId) {
    console.log('[FoxiExt-BG] FoxiGrow tab was closed');
    foxigrowTabId = null;
  }
  if (tabId === telegramTabId) {
    console.log('[FoxiExt-BG] Telegram tab was closed');
    telegramTabId = null;
    if (pendingLaunch) {
      pendingLaunch = false;
      addToLog('❌ Telegram tab closed during launch flow');
    }
  }
});

// ─── Stealth Network Interception via Debugger ─────────────────────────────

// Captured API credentials from FoxiGrow's own requests (for direct API fetch)
let capturedAuthToken = null;
let capturedApiBaseUrl = null;

// Map to temporarily store intercepted URLs
const interceptedTaskUrls = new Map();

chrome.debugger.onEvent.addListener((source, method, params) => {
  // Capture auth tokens from FoxiGrow's own API requests
  if (method === 'Network.requestWillBeSent') {
    if (!foxigrowTabId) foxigrowTabId = source.tabId;
    
    if (source.tabId === foxigrowTabId) {
      const req = params.request;
      const url = req.url || '';
      
      // Capture Authorization header from any request to api-user.foxigrow.com
      if (url.includes('api-user.foxigrow.com')) {
        const authHeader = req.headers['Authorization'] || req.headers['authorization'];
        if (authHeader && authHeader.startsWith('Bearer ')) {
          capturedAuthToken = authHeader;
          // Extract the base URL (e.g., https://api-user.foxigrow.com)
          try {
            const urlObj = new URL(url);
            capturedApiBaseUrl = urlObj.origin;
          } catch (e) {}
        }
      }
    }
  }
  
  if (method === 'Network.responseReceived') {
    // Auto-recover foxigrowTabId if Service Worker restarted
    if (!foxigrowTabId) foxigrowTabId = source.tabId;
    
    if (source.tabId === foxigrowTabId) {
      const type = params.type;
      const url = params.response.url || '';
      
      if (type === 'XHR' || type === 'Fetch') {
        // Intercept claim responses to extract exact task URL passively
        const claimMatch = url.match(/\/quests\/(\d+)\/claim/);
        if (claimMatch) {
          const taskId = claimMatch[1];
          chrome.debugger.sendCommand(
            { tabId: source.tabId },
            'Network.getResponseBody',
            { requestId: params.requestId }
          ).then((result) => {
            if (result && result.body) {
              try {
                const data = JSON.parse(result.body);
                let taskUrl = data.targetUrl || '';
                if (!taskUrl && data.subTaskTargets && data.subTaskTargets.length > 0) {
                  taskUrl = data.subTaskTargets[0].targetUrl || '';
                }
                if (taskUrl) {
                  interceptedTaskUrls.set(taskId, taskUrl);
                  // Clean up map to prevent memory leak
                  if (interceptedTaskUrls.size > 100) {
                    const firstKey = interceptedTaskUrls.keys().next().value;
                    interceptedTaskUrls.delete(firstKey);
                  }
                }
              } catch (e) {}
            }
          }).catch(() => {});
        }

        chrome.tabs.sendMessage(foxigrowTabId, { 
          type: 'FOXIEXT_FETCH_COMPLETED',
          url: url 
        }).catch(() => {});
      }
    }
  }
});

// ─── Message Handling ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    // ── From Popup ──
    case 'GET_STATE':
      sendResponse({ isEnabled, isPaused, stats, foxigrowTabId, pendingLaunch, radarConnected, radarHighestId });
      break;

    case 'UPDATE_ICON':
      updateExtensionIcon(message.src);
      sendResponse({ ok: true });
      break;

    case 'ACTIVE_SNIPES_UPDATE':
      stats.activeSnipes = message.snipes || [];
      sendResponse({ ok: true });
      break;

    case 'CANCEL_SNIPE':
      if (foxigrowTabId) {
        chrome.tabs.sendMessage(foxigrowTabId, { type: 'CANCEL_SNIPE', taskId: message.taskId }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;

    case 'TOGGLE_PAUSE':
      if (!isEnabled) {
        // From completely disabled -> Start
        isEnabled = true;
        isPaused = false;
        chrome.storage.local.set({ isEnabled, isPaused });
        // Fresh session: reset counters and start the clock
        stats.tasksStarted = 0;
        stats.tasksFailed = 0;
        stats.usdtEarned = 0;
        stats.activityLog = [];
        stats.sessionStart = Date.now();
        chrome.storage.local.set({ stats });
        addToLog('▶️ Extension enabled (Starting)');
        sendTelegramMessage('🟢 <b>FoxiGrow Bot Started!</b>\nScanning for tasks...');
        startLaunchFlow();
      } else {
        // Toggle pause state
        isPaused = !isPaused;
        chrome.storage.local.set({ isPaused });
        addToLog(isPaused ? '⏸ Bot paused' : '▶️ Bot resumed');
        if (!isPaused) {
          sendTelegramMessage('▶️ <b>FoxiGrow Bot Resumed!</b>\nContinuing scan...');
        } else {
          sendTelegramMessage('⏸ <b>FoxiGrow Bot Paused</b>');
        }
      }
      
      // Notify content scripts
      broadcastToContentScripts({ type: 'STATE_CHANGED', isEnabled, isPaused });
      if (radarWs && radarWs.readyState === WebSocket.OPEN) {
        radarWs.send(JSON.stringify({ type: 'STATUS', isEnabled }));
      }
      sendResponse({ isEnabled, isPaused });
      break;

    case 'DISABLE_BOT':
      isEnabled = false;
      isPaused = false;
      chrome.storage.local.set({ isEnabled, isPaused });
      
      addToLog('🛑 Bot disabled (Closing tabs)');
      chrome.alarms.clear(ALARM_NAME);
      pendingLaunch = false;
      
      // Close tabs
      if (foxigrowTabId) {
        chrome.tabs.remove(foxigrowTabId).catch(() => {});
        foxigrowTabId = null;
      }
      if (telegramTabId) {
        chrome.tabs.remove(telegramTabId).catch(() => {});
        telegramTabId = null;
      }
      
      // Send session summary to Telegram and reset the session stats
      endSession();

      // Notify content scripts just in case
      broadcastToContentScripts({ type: 'STATE_CHANGED', isEnabled, isPaused });
      if (radarWs && radarWs.readyState === WebSocket.OPEN) {
        radarWs.send(JSON.stringify({ type: 'STATUS', isEnabled }));
      }
      sendResponse({ isEnabled, isPaused });
      break;

    // ── From Telegram Content Script ──
    case 'SHOULD_LAUNCH':
      sendResponse({ shouldLaunch: pendingLaunch });
      break;

    case 'MINIAPP_URL_FOUND':
      handleMiniAppUrl(message.url);
      sendResponse({ ok: true });
      break;

    case 'LAUNCH_FAILED':
      pendingLaunch = false;
      addToLog(`❌ Launch failed: ${message.reason}`);
      console.error('[FoxiExt-BG] Launch failed:', message.reason);
      
      // Notify the user
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'FoxiGrow Launch Failed',
        message: `Failed to launch mini app: ${message.reason}. Retrying in 30 seconds.`,
        priority: 2
      });

      // Retry after 30 seconds
      setTimeout(() => {
        if (isEnabled) {
          addToLog('🔄 Retrying launch...');
          startLaunchFlow();
        }
      }, 30000);
      sendResponse({ ok: true });
      break;

    // ── From FoxiGrow Content Script ──
    case 'TRIGGER_DIRECT_REFRESH':
      // A scheduled drip snipe bypasses the 12s radar cooldown: drips are ~60s apart so
      // this rarely collides, but a snipe swallowed by our own rate limiter is exactly the
      // failure this feature exists to fix.
      if (message.scheduled) {
        lastRadarReloadTime = Date.now();
        triggerRadarRefresh({ scheduled: true, taskIds: message.taskIds || [] });
      } else {
        triggerRadarRefresh();
      }
      sendResponse({ ok: true });
      break;

    case 'GET_ENABLED':
      sendResponse({ isEnabled, isPaused });
      break;
      
    case 'RECORD_REWARD':
      stats.usdtEarned += (message.usdtAmount || 0);
      chrome.storage.local.set({ stats });
      chrome.storage.local.get(['deviceId'], (data) => {
        if (data.deviceId && typeof globalThis.FirebaseApi !== 'undefined') {
          globalThis.FirebaseApi.recordReward(data.deviceId, message.usdtAmount);
        }
      });
      sendResponse({ ok: true });
      break;

    case 'TASK_STARTED':
      if (!stats.startedTaskIds) stats.startedTaskIds = [];
      if (!stats.failedTaskIds) stats.failedTaskIds = [];

      // If it was previously failed, remove it from the failed count
      if (stats.failedTaskIds.includes(message.taskId)) {
        stats.failedTaskIds = stats.failedTaskIds.filter(id => id !== message.taskId);
        stats.tasksFailed = Math.max(0, stats.tasksFailed - 1);
      }

      // Count it only if it hasn't been started already
      if (!stats.startedTaskIds.includes(message.taskId)) {
        stats.startedTaskIds.push(message.taskId);
        stats.tasksStarted++;
      }

      stats.lastAction = Date.now();
      addToLog(`✅ Started task <span class="copy-id" title="Click to copy" data-id="${message.taskId}">${message.taskId}</span>`);
      chrome.storage.local.set({ stats });
      
      // Delay the notification slightly to ensure Network.getResponseBody has time to parse the claim URL
      setTimeout(() => {
        chrome.storage.local.get(['settings'], (data) => {
          const s = data.settings || {};
          // Clean dynamic text to prevent Telegram HTML parsing errors
          const cleanTG = (str) => (String(str) || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const title = cleanTG(message.taskTitle) || `Task #${message.taskId}`;
          
          // Use intercepted URL from the API claim response (100% accurate)
          // Fall back to the DOM-scraped URL from content.js if missing
          const url = interceptedTaskUrls.get(String(message.taskId)) || message.taskUrl || 'No URL';
          
          // Chrome Notification
          if (s.chromeNotif !== false) {
            chrome.notifications.create(`task-${message.taskId}-${Date.now()}`, {
              type: 'basic',
              iconUrl: 'icons/icon128.png',
              title: 'Task Started!',
              message: `${title}\nURL: ${url}`,
              priority: 1
            });
          }

          // Telegram Notification
          if (s.tgNotif) {
            const safeTaskId = cleanTG(message.taskId);
            const usdtText = message.usdtReward ? `\n<b>Reward:</b> +${message.usdtReward} USDT` : '';
            const text = `🚀 <b>FoxiGrow Task Started!</b>\n\n<b>Task ID:</b> #${safeTaskId}\n<b>Title:</b> ${title}${usdtText}\n<b>Link:</b> ${url}`;
            sendTelegramMessage(text);
          }

          // ScamExposureBot Webhook
          fetch('https://expose-service-production.up.railway.app/task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: message.taskId,
              title: message.taskTitle,
              link: url,
              totalCount: message.totalCount || 0
            })
          }).catch(() => {
            // Silently ignore if ScamExposureBot is not running or unreachable
          });
        });
      }, 500);

      sendResponse({ ok: true });
      break;

    case 'TASK_FAILED':
      if (!stats.startedTaskIds) stats.startedTaskIds = [];
      if (!stats.failedTaskIds) stats.failedTaskIds = [];

      // If it hasn't succeeded yet and wasn't already failed, count it
      if (!stats.startedTaskIds.includes(message.taskId) && !stats.failedTaskIds.includes(message.taskId)) {
        stats.failedTaskIds.push(message.taskId);
        stats.tasksFailed++;
      }

      stats.lastAction = Date.now();
      addToLog(`❌ Failed task <span class="copy-id" title="Click to copy" data-id="${message.taskId}">${message.taskId}</span>: ${message.reason || 'unknown'}`);
      chrome.storage.local.set({ stats });

      // Telegram Notification for Failed Task
      chrome.storage.local.get('settings', (data) => {
        const s = data.settings || {};
        if (s.tgNotif && s.tgTaskFailed !== false) {
          const cleanTG = (str) => (String(str) || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const safeTaskId = cleanTG(message.taskId);
          const title = cleanTG(message.taskTitle) || `Task #${safeTaskId}`;
          const usdtText = message.usdtReward ? `\n<b>Reward:</b> +${message.usdtReward} USDT` : '';
          const reasonText = message.reason ? `\n<b>Reason:</b> ${cleanTG(message.reason)}` : '';
          const text = `⚠️ <b>FoxiGrow Task Failed!</b>\n\n<b>Task ID:</b> #${safeTaskId}\n<b>Title:</b> ${title}${usdtText}${reasonText}`;
          sendTelegramMessage(text);
        }
      });

      sendResponse({ ok: true });
      break;

    case 'STATUS_UPDATE':
      stats.lastAction = Date.now();
      addToLog(`ℹ️ ${message.status}`);
      sendResponse({ ok: true });
      break;

    case 'SIMULATE_CLICK':
      getFoxiTabId().then(tabId => {
        if (!tabId) {
          sendResponse({ error: 'No active FoxiGrow tab' });
          return;
        }
        simulateHumanClick(tabId, message.x, message.y, message.fast)
          .then(() => sendResponse({ ok: true }))
          .catch(err => {
            console.warn('[FoxiExt-BG] Click error (debugger detached?):', err.message);
            sendResponse({ error: err.message });
          });
      });
      return true; // async response

    case 'SIMULATE_MOUSE_MOVE':
      getFoxiTabId().then(tabId => {
        if (!tabId) {
          sendResponse({ error: 'No active FoxiGrow tab' });
          return;
        }
        simulateHumanMouseMove(tabId, message.x, message.y)
          .then(() => sendResponse({ ok: true }))
          .catch(err => sendResponse({ error: err.message }));
      });
      return true;

    case 'REATTACH_DEBUGGER':
      getFoxiTabId().then(tabId => {
        if (!tabId) {
          sendResponse({ ok: false });
          return;
        }
        ensureDebuggerAttached(tabId)
          .then(ok => sendResponse({ ok }))
          .catch(() => sendResponse({ ok: false }));
      });
      return true;

    case 'ADD_DIAGNOSTIC_LOG':
      const now = Date.now();
      diagnosticLogs.push({
        timestamp: now,
        message: message.text,
        taskId: message.taskId || 'system'
      });
      // Keep logs for 1 hour, hard cap at 20,000 lines to protect memory
      const oneHourAgo = now - 3600000;
      diagnosticLogs = diagnosticLogs.filter(log => log.timestamp > oneHourAgo);
      if (diagnosticLogs.length > 20000) {
        diagnosticLogs = diagnosticLogs.slice(-20000);
      }
      sendResponse({ ok: true });
      break;

    case 'EXPORT_DIAGNOSTICS':
      let output = "=== FoxiGrow Diagnostic Profiler Log ===\n";
      output += `Generated: ${new Date().toISOString()}\n\n`;
      
      if (diagnosticLogs.length === 0) {
        output += "No diagnostic data recorded yet. Make sure Diagnostic Mode is enabled and a task drop occurs.\n";
      } else {
        // Group by Task ID if possible
        diagnosticLogs.forEach(log => {
          const timeStr = new Date(log.timestamp).toISOString();
          output += `[${timeStr}] [${log.taskId}] ${log.message}\n`;
        });
      }
      
      sendResponse({ data: output });
      break;

    case 'DRIP_QUERY':
      // Ask the radar server when the next drip batch releases for these task IDs.
      // Radar answers from its cached dripSummary, so this costs FoxiGrow zero requests.
      // The reply arrives asynchronously as a DRIP_INFO message via radarWs.onmessage.
      if (radarWs && radarWs.readyState === 1) {
        try {
          radarWs.send(JSON.stringify({
            type: 'DRIP_QUERY',
            taskIds: (message.taskIds || []).map(String)
          }));
          sendResponse({ ok: true });
        } catch (e) {
          console.error('[FoxiExt-BG] DRIP_QUERY send failed:', e);
          sendResponse({ ok: false, reason: 'send_failed' });
        }
      } else {
        sendResponse({ ok: false, reason: 'ws_closed' });
      }
      break;

    case 'PING':
      // Heartbeat to keep service worker alive
      sendResponse({ pong: true });
      break;

    default:
      console.warn('[FoxiExt-BG] Unknown message type:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }

  return true;
});

// ─── Debugger Virtual Mouse ──────────────────────────────────────────────────────

/** Ensure debugger is attached, re-attach if needed */
async function ensureDebuggerAttached(tabId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: '1' });
    return true;
  } catch (e) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
      return true;
    } catch (e2) {
      return false;
    }
  }
}

async function simulateHumanClick(tabId, x, y, fast = false) {
  const target = { tabId };

  // Start from a random position 50-150px away
  const distance = 50 + Math.random() * 100;
  const angle = Math.random() * Math.PI * 2;
  const startX = x + Math.cos(angle) * distance;
  const startY = y + Math.sin(angle) * distance;

  // Bézier control point for natural curve
  const cpX = (startX + x) / 2 + (Math.random() - 0.5) * 60;
  const cpY = (startY + y) / 2 + (Math.random() - 0.5) * 60;

  // Final target with micro-wobble
  const finalX = Math.round(x + (Math.random() - 0.5) * 4);
  const finalY = Math.round(y + (Math.random() - 0.5) * 3);

  if (fast) {
    // Instant teleport and click (atomic to prevent swipe-to-hide triggers)
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: finalX, y: finalY
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', button: 'left', clickCount: 1, x: finalX, y: finalY
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', button: 'left', clickCount: 1, x: finalX, y: finalY
    });
    return;
  }

  // Move along quadratic Bézier curve (Faster steps)
  const steps = 4 + Math.floor(Math.random() * 4); // 4-7 steps
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const mx = (1-ease)**2 * startX + 2*(1-ease)*ease * cpX + ease**2 * finalX;
    const my = (1-ease)**2 * startY + 2*(1-ease)*ease * cpY + ease**2 * finalY;

    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(mx), y: Math.round(my)
    });
    
    const stepDelay = 5 + Math.random() * 10; // 5-15ms per step
    await new Promise(r => setTimeout(r, stepDelay));
  }

  // Small settle pause (human hand steadying - faster)
  const settleDelay = 10 + Math.random() * 20; // 10-30ms
  await new Promise(r => setTimeout(r, settleDelay));

  // Press and release ATOMICALLY.
  // We do not await a delay here because any page scrolling, layout shifts,
  // or physical mouse movements during the hold delay can cause FoxiGrow's 
  // touch-listeners to interpret the click as a "swipe to hide" drag gesture!
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', button: 'left', clickCount: 1, x: finalX, y: finalY
  });
  await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', button: 'left', clickCount: 1, x: finalX, y: finalY
  });
}

async function simulateHumanMouseMove(tabId, x, y) {
  const target = { tabId };
  // Move in 3-5 quick steps instead of teleporting
  const steps = 3 + Math.floor(Math.random() * 3);
  const startX = x + (Math.random() - 0.5) * 80;
  const startY = y + (Math.random() - 0.5) * 80;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mx = startX + (x - startX) * t;
    const my = startY + (y - startY) * t;
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: Math.round(mx), y: Math.round(my)
    });
    await new Promise(r => setTimeout(r, 20 + Math.random() * 30));
  }
}

// ─── Core Logic ──────────────────────────────────────────────────────────────

// Telegram helper
function sendTelegramMessage(text) {
  chrome.storage.local.get('settings', (data) => {
    const s = data.settings || {};
    if (s.tgNotif && s.tgBotToken && s.tgChatId) {
      const tgUrl = `https://api.telegram.org/bot${s.tgBotToken}/sendMessage`;
      fetch(tgUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: s.tgChatId,
          text: text,
          parse_mode: 'HTML'
        })
      }).then(res => res.json())
        .then(data => {
          if (!data.ok) addToLog(`⚠️ Telegram Error: ${data.description}`);
          console.log('[FoxiExt-BG] Telegram notification sent:', data);
        })
        .catch(err => {
          addToLog(`⚠️ Telegram Network Error`);
          console.error('[FoxiExt-BG] Telegram notification error:', err);
        });
    }
  });
}

/** Format the current session stats into a Telegram summary message */
function buildSessionSummary() {
  let durationText = 'N/A';
  if (stats.sessionStart) {
    const elapsed = Math.max(0, Date.now() - stats.sessionStart);
    const totalMinutes = Math.floor(elapsed / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    durationText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }

  return `📊 <b>FoxiGrow Session Summary</b>\n\n` +
    `⏱ <b>Duration:</b> ${durationText}\n` +
    `✅ <b>Tasks Started:</b> ${stats.tasksStarted || 0}\n` +
    `❌ <b>Tasks Failed:</b> ${stats.tasksFailed || 0}\n` +
    `💰 <b>USDT Earned:</b> ${(stats.usdtEarned || 0).toFixed(2)}\n\n` +
    `Bot has been stopped.`;
}

/**
 * Send the session summary to Telegram (if configured) and reset the session stats.
 * Called whenever the bot fully stops (manual stop or license expiry) — never on pause.
 */
function endSession() {
  sendTelegramMessage(buildSessionSummary());

  stats.tasksStarted = 0;
  stats.tasksFailed = 0;
  stats.usdtEarned = 0;
  stats.sessionStart = null;
  stats.activityLog = [];
  stats.startedTaskIds = [];
  stats.failedTaskIds = [];
  chrome.storage.local.set({ stats });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function addToLog(entry) {
  stats.activityLog.unshift({
    time: Date.now(),
    text: entry
  });
  if (stats.activityLog.length > 30) {
    stats.activityLog = stats.activityLog.slice(0, 30);
  }
  chrome.storage.local.set({ stats });
}

function broadcastToContentScripts(message) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}
