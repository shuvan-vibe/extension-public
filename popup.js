/**
 * FoxiGrow Auto-Claimer — Popup Script
 */

// ─── Elements ────────────────────────────────────────────────────────────────
// Views
const dashboardView = document.getElementById('dashboardView');
const settingsView = document.getElementById('settingsView');
const loginView = document.getElementById('loginView');

// Header
const settingsBtn = document.getElementById('settingsBtn');
const disableBtn = document.getElementById('disableBtn');
const backBtn = document.getElementById('backBtn');
const mainLogo = document.getElementById('mainLogo');

// Dashboard
const playPauseBtn = document.getElementById('playPauseBtn');
const toggleIcon = playPauseBtn.querySelector('.toggle-icon');
const toggleText = playPauseBtn.querySelector('.toggle-text');
const statusText = document.getElementById('statusText');
const tasksStartedEl = document.getElementById('tasksStarted');
const tasksFailedEl = document.getElementById('tasksFailed');
const sessionTimeEl = document.getElementById('sessionTime');
const statUsdtEl = document.getElementById('statUsdt');
const logContainer = document.getElementById('logContainer');
const radarText = document.getElementById('radarText');
const radarDot = document.getElementById('radarDot');
const snipesSection = document.getElementById('snipesSection');
const snipesContainer = document.getElementById('snipesContainer');

// Settings Inputs
const blockedKeywordsInput = document.getElementById('blockedKeywordsInput');
const blockedTaskIdsInput = document.getElementById('blockedTaskIdsInput');
const tgBotTokenInput = document.getElementById('tgBotTokenInput');
const tgChatIdInput = document.getElementById('tgChatIdInput');
const radarServerUrlInput = document.getElementById('radarServerUrlInput');
const competitiveModeToggle = document.getElementById('competitiveModeToggle');
const chromeNotifToggle = document.getElementById('chromeNotifToggle');
const tgNotifToggle = document.getElementById('tgNotifToggle');
const tgTaskFailedToggle = document.getElementById('tgTaskFailedToggle');
const diagnosticModeToggle = document.getElementById('diagnosticModeToggle');
const exportDiagnosticsBtn = document.getElementById('exportDiagnosticsBtn');
const dripBlockedCount = document.getElementById('dripBlockedCount');
const resetDripBlocksBtn = document.getElementById('resetDripBlocksBtn');
const inlineEditBtns = document.querySelectorAll('.inline-edit-btn');
const dpOptions = document.querySelectorAll('.dp-option');

// Login
const licenseInput = document.getElementById('licenseInput');
const loginBtn = document.getElementById('loginBtn');
const loginError = document.getElementById('loginError');

// ─── State ───────────────────────────────────────────────────────────────────
let isEnabled = false;
let isPaused = false;
let deviceId = '';
let currentLicense = '';

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function switchView(viewElement) {
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('active');
    v.classList.add('hidden');
  });
  viewElement.classList.remove('hidden');
  viewElement.classList.add('active');
}

// ─── Auth Logic ──────────────────────────────────────────────────────────────
const AUTH_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours

async function verifyAuth() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['deviceId', 'licenseKey', 'lastAuthCheck'], async (data) => {
            if (!data.deviceId) {
                deviceId = generateUUID();
                chrome.storage.local.set({ deviceId });
            } else {
                deviceId = data.deviceId;
            }
            
            if (data.licenseKey) {
                currentLicense = data.licenseKey;

                // Use cached verification result for 24h to avoid the Firebase round-trip
                // (the background license-check alarm still enforces expiry every 30 min)
                if (data.lastAuthCheck && (Date.now() - data.lastAuthCheck) < AUTH_CACHE_MS) {
                    return resolve(true);
                }
                
                const license = await globalThis.FirebaseApi.getLicense(currentLicense);
                if (license && license.active && license.expiresAt > Date.now()) {
                    if (!license.deviceId || license.deviceId === deviceId) {
                        if (!license.deviceId) {
                            await globalThis.FirebaseApi.activateLicense(currentLicense, deviceId);
                        }
                        chrome.storage.local.set({ lastAuthCheck: Date.now() });
                        return resolve(true);
                    }
                }
                // Verification failed — drop the stale cache
                chrome.storage.local.remove('lastAuthCheck');
            }
            resolve(false);
        });
    });
}

// ─── Initialize ──────────────────────────────────────────────────────────────
async function init() {
  const isAuth = await verifyAuth();

  if (isAuth) {
      switchView(dashboardView);
  } else {
      switchView(loginView);
      // Wait for login
      loginBtn.addEventListener('click', handleLogin);
      licenseInput.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') handleLogin();
      });
      return; // Do not initialize the rest until logged in
  }

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (response) {
      isEnabled = response.isEnabled;
      isPaused = response.isPaused;
      updateUI(isEnabled, isPaused, response.stats);
    }
  });

  // Load settings
  chrome.storage.local.get(['settings'], (data) => {
    const s = data.settings || {};
    blockedKeywordsInput.value = s.blockedKeywords || '';
    blockedTaskIdsInput.value = s.blockedTaskIds || '';
    tgBotTokenInput.value = s.tgBotToken || '';
    tgChatIdInput.value = s.tgChatId || '';
    radarServerUrlInput.value = s.radarServerUrl || '';
    competitiveModeToggle.checked = s.competitiveMode || false;
    diagnosticModeToggle.checked = s.diagnosticMode || false;
    chromeNotifToggle.checked = s.chromeNotif !== false; 
    tgNotifToggle.checked = s.tgNotif || false;
    tgTaskFailedToggle.checked = s.tgTaskFailed !== false; // Default true

    // Load Display Picture
    const dpSrc = s.displayPicture || 'icons/icon48.png';
    mainLogo.src = dpSrc;
    dpOptions.forEach(opt => {
      if (opt.getAttribute('data-src') === dpSrc) {
        opt.classList.add('selected');
      } else {
        opt.classList.remove('selected');
      }
    });
  });

  // Display Picture selection
  dpOptions.forEach(opt => {
    opt.addEventListener('click', (e) => {
      dpOptions.forEach(o => o.classList.remove('selected'));
      e.target.classList.add('selected');
      const src = e.target.getAttribute('data-src');
      mainLogo.src = src;
      chrome.runtime.sendMessage({ type: 'UPDATE_ICON', src });
      saveSettings();
    });
  });

  // View Navigation
  settingsBtn.addEventListener('click', () => {
    switchView(settingsView);
  });

  backBtn.addEventListener('click', () => {
    switchView(dashboardView);
  });

  // Action Buttons
  disableBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'DISABLE_BOT' }, (response) => {
      if (response) {
        isEnabled = response.isEnabled;
        isPaused = response.isPaused;
        updateToggleUI(isEnabled, isPaused);
      }
    });
  });

  playPauseBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'TOGGLE_PAUSE' }, (response) => {
      if (response) {
        isEnabled = response.isEnabled;
        isPaused = response.isPaused;
        updateToggleUI(isEnabled, isPaused);
      }
    });
  });

  // Inline Edit Buttons
  inlineEditBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const inputEl = document.getElementById(targetId);
      
      if (btn.classList.contains('saving')) {
        // Save Mode -> Lock
        inputEl.readOnly = true;
        btn.textContent = 'Edit';
        btn.classList.remove('saving');
        saveSettings();
      } else {
        // Edit Mode -> Unlock
        inputEl.readOnly = false;
        inputEl.focus();
        btn.textContent = 'Save';
        btn.classList.add('saving');
      }
    });
  });

  // Toggles auto-save
  competitiveModeToggle.addEventListener('change', saveSettings);
  diagnosticModeToggle.addEventListener('change', saveSettings);
  chromeNotifToggle.addEventListener('change', saveSettings);
  tgNotifToggle.addEventListener('change', saveSettings);
  tgTaskFailedToggle.addEventListener('change', saveSettings);

  exportDiagnosticsBtn.addEventListener('click', () => {
    exportDiagnosticsBtn.textContent = 'Generating...';
    chrome.runtime.sendMessage({ type: 'EXPORT_DIAGNOSTICS' }, (response) => {
      exportDiagnosticsBtn.textContent = '📥 Export Diagnostics';
      if (response && response.data) {
        const blob = new Blob([response.data], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `foxigrow-diagnostics-${Date.now()}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        alert('No diagnostic logs available or error generating file.');
      }
    });
  });

  // Refresh stats every second
  setInterval(refreshStats, 1000);

  // ── Blocked drip tasks ──
  refreshDripBlocked();
  resetDripBlocksBtn.addEventListener('click', () => {
    chrome.storage.local.get(['dripState'], (data) => {
      const state = data.dripState || {};
      const count = Object.keys(state.blocked || {}).length;
      if (count === 0) return;
      chrome.storage.local.set({ dripState: { attempts: {}, blocked: {} } }, () => {
        refreshDripBlocked();
        resetDripBlocksBtn.textContent = `♻️ Cleared ${count}`;
        setTimeout(() => { resetDripBlocksBtn.textContent = '♻️ Reset Blocked Tasks'; }, 1500);
      });
    });
  });

  // Handle click to copy for task IDs in activity log
  logContainer.addEventListener('click', (e) => {
    if (e.target.classList.contains('copy-id')) {
      const id = e.target.getAttribute('data-id');
      navigator.clipboard.writeText(id).then(() => {
        const originalText = e.target.textContent;
        e.target.textContent = 'Copied!';
        setTimeout(() => {
          e.target.textContent = originalText;
        }, 1000);
      });
    }
  });

  // Snipes Container Event Delegation
  snipesContainer.addEventListener('click', (e) => {
    if (e.target.classList.contains('snipe-cancel-btn')) {
      const taskId = e.target.getAttribute('data-id');
      
      // Add to blocklist
      let blockedIds = blockedTaskIdsInput.value.split(',').map(id => id.trim()).filter(id => id.length > 0);
      if (!blockedIds.includes(taskId)) {
        blockedIds.push(taskId);
        blockedTaskIdsInput.value = blockedIds.join(', ');
        saveSettings();
      }

      // Send cancel message
      chrome.runtime.sendMessage({ type: 'CANCEL_SNIPE', taskId });
      e.target.textContent = 'Cancelling...';
      e.target.disabled = true;
    }
  });
}

/** Show how many tasks are permanently skipped after burning all drip attempts */
function refreshDripBlocked() {
  chrome.storage.local.get(['dripState'], (data) => {
    const blocked = (data.dripState || {}).blocked || {};
    dripBlockedCount.textContent = Object.keys(blocked).length;
  });
}

function saveSettings() {
  const settings = {
    blockedKeywords: blockedKeywordsInput.value,
    blockedTaskIds: blockedTaskIdsInput.value,
    tgBotToken: tgBotTokenInput.value,
    tgChatId: tgChatIdInput.value,
    radarServerUrl: radarServerUrlInput.value,
    competitiveMode: competitiveModeToggle.checked,
    diagnosticMode: diagnosticModeToggle.checked,
    chromeNotif: chromeNotifToggle.checked,
    tgNotif: tgNotifToggle.checked,
    tgTaskFailed: tgTaskFailedToggle.checked,
    displayPicture: document.querySelector('.dp-option.selected')?.getAttribute('data-src') || 'icons/icon48.png'
  };
  chrome.storage.local.set({ settings });
}

// ─── Login Handlers ──────────────────────────────────────────────────────────
async function handleLogin() {
    loginError.style.display = 'none';
    const key = licenseInput.value.trim();
    if (!key) return;

    loginBtn.textContent = 'Checking...';
    loginBtn.disabled = true;

    const license = await globalThis.FirebaseApi.getLicense(key);
    
    if (license && license.active && license.expiresAt > Date.now()) {
        if (!license.deviceId || license.deviceId === deviceId) {
            if (!license.deviceId) {
                await globalThis.FirebaseApi.activateLicense(key, deviceId);
            }
            chrome.storage.local.set({ licenseKey: key }, () => {
                currentLicense = key;
                loginBtn.removeEventListener('click', handleLogin);
                init();
            });
        } else {
            loginError.textContent = 'License key is already used on another device.';
            loginError.style.display = 'block';
        }
    } else {
        loginError.textContent = 'Invalid or expired license key.';
        loginError.style.display = 'block';
    }
    
    loginBtn.textContent = 'Verify Key';
    loginBtn.disabled = false;
}

// ─── UI Updates ──────────────────────────────────────────────────────────────
function updateUI(enabled, paused, stats) {
  updateToggleUI(enabled, paused);
  updateStats(stats);
  updateLog(stats?.activityLog || []);
}

function updateToggleUI(enabled, paused) {
  if (!enabled) {
    playPauseBtn.classList.remove('on');
    playPauseBtn.classList.add('off');
    toggleIcon.textContent = '▶';
    toggleText.textContent = 'START BOT';
    statusText.textContent = 'Bot is disabled (Tabs closed)';
  } else if (paused) {
    playPauseBtn.classList.remove('on');
    playPauseBtn.classList.add('off');
    toggleIcon.textContent = '▶';
    toggleText.textContent = 'RESUME BOT';
    statusText.textContent = 'Bot is paused';
  } else {
    playPauseBtn.classList.remove('off');
    playPauseBtn.classList.add('on');
    toggleIcon.textContent = '⏸';
    toggleText.textContent = 'PAUSE BOT';
    statusText.textContent = 'Scanning for tasks...';
  }
}

function updateStats(stats) {
  if (!stats) return;

  tasksStartedEl.textContent = stats.tasksStarted || 0;
  tasksFailedEl.textContent = stats.tasksFailed || 0;
  statUsdtEl.textContent = (stats.usdtEarned || 0).toFixed(2);

  if (stats.sessionStart) {
    const elapsed = Date.now() - stats.sessionStart;
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 60) {
      sessionTimeEl.textContent = `${minutes}m`;
    } else {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      sessionTimeEl.textContent = `${hours}h ${mins}m`;
    }
  }
}

function updateLog(activityLog) {
  if (!activityLog || activityLog.length === 0) {
    logContainer.innerHTML = '<div class="log-empty">No activity yet</div>';
    return;
  }

  logContainer.innerHTML = activityLog.map(entry => {
    const time = new Date(entry.time);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.' + time.getMilliseconds().toString().padStart(3, '0');
    return `<div class="log-entry">
      <span class="log-time">${timeStr}</span>
      <span>${entry.text}</span>
    </div>`;
  }).join('');
}

function updateSnipes(activeSnipes) {
  if (!activeSnipes || activeSnipes.length === 0) {
    snipesSection.style.display = 'none';
    snipesContainer.innerHTML = '';
    return;
  }

  snipesSection.style.display = 'block';
  snipesContainer.innerHTML = activeSnipes.map(snipe => {
    const remainingSecs = Math.max(0, (snipe.releaseAt - Date.now()) / 1000).toFixed(0);
    return `
      <div class="snipe-item">
        <div class="snipe-info">
          <span class="snipe-title">${snipe.title}</span>
          <span>Task #${snipe.taskId} • in ${remainingSecs}s</span>
        </div>
        <button class="snipe-cancel-btn" data-id="${snipe.taskId}">Cancel</button>
      </div>
    `;
  }).join('');
}

function refreshStats() {
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (response) {
      updateStats(response.stats);
      updateLog(response.stats?.activityLog || []);
      
      // Update status text from last log entry if active
      if (response.isEnabled && !response.isPaused && response.stats?.activityLog?.length > 0) {
        const lastEntry = response.stats.activityLog[0];
        if (lastEntry.text.startsWith('ℹ️')) {
          statusText.textContent = lastEntry.text.replace('ℹ️ ', '');
        }
      }

      // Update radar status indicator
      if (response.radarConnected !== undefined) {
        if (response.radarConnected) {
          radarDot.style.backgroundColor = '#4caf50'; // green
          radarText.textContent = response.radarHighestId ? `Radar: #${response.radarHighestId}` : 'Radar: Connected';
        } else {
          radarDot.style.backgroundColor = '#f44336'; // red
          radarText.textContent = 'Radar: Disconnected';
          radarText.textContent = 'Radar: Disconnected';
        }
      }

      // Update Snipes
      updateSnipes(response.stats?.activeSnipes || []);
    }
  });
}

// Start (init is called inside itself now, we don't need it at the very bottom, but let's call it just to be safe if it wasn't called)
// The bad replacement removed the original init() call, but wait, my chunk above DID call init() at the bottom.
// Oh actually I didn't include init() in this chunk. I will put it back.
// Wait, `init()` was removed because I replaced to the end. Let me add it.
init();
