const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBzI75ErMSbA-yUUYb7aqGisGBpBYwkRFQ",
  projectId: "foxi-acf7d"
};

const DB_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;

/** Fetch a license document */
async function getLicense(key) {
  try {
    const res = await fetch(`${DB_URL}/licenses/${key}?key=${FIREBASE_CONFIG.apiKey}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error("Firebase getLicense error:", await res.text());
      return null;
    }
    const data = await res.json();
    return parseDocument(data);
  } catch (err) {
    console.error("Firebase getLicense error:", err);
    return null;
  }
}


/** Lock a license to a device */
async function activateLicense(key, deviceId) {
    const payload = {
        fields: {
            deviceId: { stringValue: deviceId }
        }
    };
    await fetch(`${DB_URL}/licenses/${key}?updateMask.fieldPaths=deviceId&key=${FIREBASE_CONFIG.apiKey}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
}

/** Record USDT reward (Increment) */
async function recordReward(deviceId, usdtAmount) {
    if (!deviceId) return;
    try {
        let total = 0;
        let daily = 0;
        const today = new Date().toISOString().split('T')[0];

        // Fetch current stats
        const res = await fetch(`${DB_URL}/users/${deviceId}?key=${FIREBASE_CONFIG.apiKey}`);
        if (res.ok) {
            const data = await res.json();
            const parsed = parseDocument(data);
            total = parsed.totalUsdt || 0;
            if (parsed.lastActiveDate === today) {
                daily = parsed.dailyUsdt || 0;
            }
        }
        
        total += usdtAmount;
        daily += usdtAmount;
        
        const payload = {
            fields: {
                totalUsdt: { doubleValue: total },
                lastActiveDate: { stringValue: today },
                dailyUsdt: { doubleValue: daily } 
            }
        };
        
        const patchRes = await fetch(`${DB_URL}/users?documentId=${deviceId}&key=${FIREBASE_CONFIG.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!patchRes.ok) {
            await fetch(`${DB_URL}/users/${deviceId}?key=${FIREBASE_CONFIG.apiKey}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }
    } catch(e) {
        console.error("Failed to record reward", e);
    }
}



/** Helper to parse Firestore REST format to normal JSON */
function parseDocument(doc) {
  if (!doc || !doc.fields) return {};
  const obj = {};
  for (const [key, value] of Object.entries(doc.fields)) {
    if (value.stringValue !== undefined) obj[key] = value.stringValue;
    if (value.integerValue !== undefined) obj[key] = parseInt(value.integerValue, 10);
    if (value.doubleValue !== undefined) obj[key] = parseFloat(value.doubleValue);
    if (value.booleanValue !== undefined) obj[key] = value.booleanValue;
  }
  return obj;
}

// Export functions for popup/background
globalThis.FirebaseApi = {
    getLicense,
    activateLicense,
    recordReward
};
