# Drip Retry Plan — schedule DOM refresh on next drip release

## Status

**Extension side implemented** (`content.js`, `background.js`, `popup.html`, `popup.js`),
44-assertion harness passing.

**Radar side implemented and deployed** (`TaskRadarServer/server.js`, commit `cef1bf6`,
pushed to `shuvan-vibe/polling` main). Verified live over `wss://` against the deployed
instance: 9/9 checks passing, including `TASK_DROP` firing for repeat drip batches — which
the previous build never did.

**Deployment URL is `polling-production-9dd0.up.railway.app`**, not the
`polling-production-db64` host hardcoded in the old `background.js` fetch. That old host
404s on every path; the `db64` reference is gone from the extension now, and the radar WS
URL is user-configured in the popup (`radarServerUrl`).

Remaining: set the popup's Radar Server URL to
`wss://polling-production-9dd0.up.railway.app`, then run the end-to-end claim test and the
tab-bounce check (§3e) in the live mini app.

## Refresh policy — exactly two triggers

This is the hard rule. Only two things may cause a DOM refresh:

1. **A brand-new task appears.** Radar sends `TASK_DROP` with **no** `taskId`; background
   refreshes, gated by the existing 12s cooldown. Identical to the pre-existing behaviour.
2. **A scheduled snipe for a task we already tried and lost.** content.js arms it off
   `releaseAt` and sends `TRIGGER_DIRECT_REFRESH { scheduled: true }`, which bypasses the 12s
   gate because missing the scheduled instant is the failure being fixed.

A **drip-batch release is deliberately not refreshed.** Radar announces every drip release,
including tasks never attempted, so refreshing on it would add traffic for tasks we are not
chasing. Tasks we *are* chasing already have their own snipe, timed off `releaseAt` rather
than reacting after the fact. background.js therefore ignores any `TASK_DROP` carrying a
`taskId`, and does not consume the 12s gate for it.

`DRIP_SCHEDULE` / `DRIP_INFO` never cause a refresh: they are forwarded to content.js, which
only sets timers.

## Message contract (implemented in the extension, required from radar)

Radar → extension, over the existing WebSocket:

```js
// broadcast whenever dripSummary.nextReleaseAt changes (~every 60s)
{ type: 'DRIP_SCHEDULE', releaseAt: 1787041769, questIds: ['24923','24960'],
  serverTime: 1787041709, serverTimeMs: 1787041709123 }

// reply to a DRIP_QUERY
{ type: 'DRIP_INFO', releaseAt: 1787041769, pending: ['24923'], unknown: ['24960'],
  serverTime: 1787041709, serverTimeMs: 1787041709123 }

// existing signal, now also for repeat drips
{ type: 'TASK_DROP', taskId: '24923', timestamp: 1787041769123 }
```

Extension → radar:

```js
{ type: 'DRIP_QUERY', taskIds: ['24923','24960'] }
```

Field notes:
- `releaseAt` — unix **seconds**, straight from `dripSummary.nextReleaseAt`.
- `questIds` / `pending` — string IDs. The extension coerces with `String()` but sending
  strings avoids a type mismatch against DOM-scraped IDs.
- `serverTimeMs` — **send this.** With only whole-second `serverTime` the extension has to
  quantize skew to whole seconds to avoid up to 1s of truncation noise, which would push the
  refresh as late as `releaseAt + 1.9s`, outside the window where slots still exist.
  `serverTimeMs` removes the guesswork.
- `unknown` is accepted but currently unused by the extension.

## What the data actually supports

Verified against the live FoxiGrow API (`/api/v1/quests?lang=en&page=1&pageSize=10`):

- `dripSummary.nextReleaseAt` — unix seconds of the next drip release. Present on every poll.
- `dripSummary.questIds` — quest IDs with pending drips. These are **absent from `items`**
  until their batch releases.
- Releases observed ~60s apart (041409 → 041467 → 041529 → 041709 → 041769).
- Task appears in the API within ~0.6s of `nextReleaseAt`.
- Batch drains fast: 15 slots → 1 in ~10.5s.
- A release may include only a **subset** of `questIds` (at 041769, 24964 and 24923
  appeared, 24960 did not).

Two things do **not** work and must not be relied on:

- `limits.drip.schedule` on the task-detail endpoint contains **only past batches**
  (24918: 33 past / 0 future; 24812: 260 past / 0 future). There is no per-task future
  release time anywhere in the API. `fetchDripSchedule` at `content.js:1171` can never
  succeed and its `nextDrop` is always null.
- `server.js:118` requests `api-user.foxigrow.com/quests/${taskId}`, which 404s. Correct
  path is `/api/v1/quests/${taskId}`.

Consequence: the schedule is **global, not per-task**. We cannot ask "when does task X
drip next". We can only ask "is X pending, and when is the next release". Because the
timestamp is shared, one refresh naturally covers every pending task at once — the
"coalesce refreshes within 10s" rule the user described falls out for free.

## Architecture decision

Radar server owns all FoxiGrow polling. The extension never fetches the quests API
directly. This avoids new `host_permissions`, adds zero request volume, and keeps the
detection surface unchanged. Radar already has `dripSummary` on every poll and discards it.

Scheduling lives in **content.js**, not background.js. The service worker can be killed
and `chrome.alarms` has 1-minute granularity, which is useless for a ~60s cycle needing
sub-second accuracy. content.js already has the unthrottled Web Worker timer
(`workerTimeout`, `content.js:146`). background.js is only a WebSocket relay.

## Changes

### 1. `TaskRadarServer/server.js` — publish and answer drip queries — **DONE, DEPLOYED**

**1a. Dedup bug fixed (root cause).** The old `server.js:67` only broadcast a task ID the
first time it was ever seen; a drip is the same ID reappearing, so drips 2+ signalled
nothing. Now a task listed in the *previous* poll's `dripSummary.questIds` that becomes
visible in `items` is announced as `TASK_DROP { taskId, reason: 'drip batch released' }`,
rate-limited per task by `DROP_DEDUP_MS` (5s). Using the pending list as the candidate set
makes this immune to the page-boundary churn that flickers low-ranked tasks in and out of
page 1.

**1b. `dripSummary` cached** in `lastDripSummary = { releaseAt, questIds, fetchedAt }`.

**1c. `DRIP_SCHEDULE` broadcast** when `releaseAt` or the `questIds` set changes, and pushed
immediately on client connect so a mid-cycle reconnect doesn't wait for the next change.

**1d. `DRIP_QUERY` → `DRIP_INFO`** answered from cache: `pending` = requested IDs in
`questIds`, `unknown` = the rest. Zero extra FoxiGrow requests.

**1e. `serverTime` + `serverTimeMs`** on every message.

**1f. Detail URL fixed** to `/api/v1/quests/${taskId}`. `/drip-schedule/:taskId` is now
explicitly debug-only and reports `futureBatches` (always 0) plus a warning note.

**1g. Deployed.** Live at `polling-production-9dd0.up.railway.app`.

Also fixed while in there: `knownTasks.clear()` at 1000 entries wiped the whole set, which
made every task look brand new on the next poll and would have produced a burst of false
`TASK_DROP`s. Replaced with a low-ID prune. Added `/drip` and drip/client info on `/`.

### 2. `background.js` — relay only — **DONE**

- `DRIP_SCHEDULE` / `DRIP_INFO` are forwarded to the FoxiGrow tab from `radarWs.onmessage`
  via `forwardToFoxiTab()`. They never trigger a refresh.
- `TASK_DROP` **with** a `taskId` (a drip release) is logged and ignored — no refresh, no tab
  bounce, and the 12s gate is left untouched. See the refresh policy above.
- `TASK_DROP` **without** a `taskId` (a brand-new task) refreshes exactly as before, still
  gated by the 12s cooldown.
- `DRIP_QUERY` writes to `radarWs` when open, else replies `{ ok:false, reason:'ws_closed' }`.
- `TRIGGER_DIRECT_REFRESH` with `scheduled: true` sets `lastRadarReloadTime` and calls
  `triggerRadarRefresh({ scheduled: true })`, bypassing the 12s gate.
- The dead `FETCH_DRIP_SCHEDULE` case is removed.

### 3. `content.js` — drip retry module — **DONE**

Implemented state:

```js
let dripAttempts = new Map();     // taskId -> real START attempts that failed
let permaBlocked = new Map();     // taskId -> { at, reason }
let dripRearms = new Map();       // taskId -> snipe arms in the current chase
let scheduledSnipes = new Map();  // releaseAt(sec) -> { preArmId, fireId, rearmId, taskIds:Set }
let lastRefreshClickAt = 0;       // 10s client-side refresh-button lock
```

New `CONFIG` block: `DRIP_MAX_ATTEMPTS 3`, `DRIP_PREARM_MS 2000`, `DRIP_JITTER_MIN 200`,
`DRIP_JITTER_VAR 700`, `DRIP_SCAN_WINDOW 12000`, `DRIP_REARM_DELAY 3000`,
`DRIP_MAX_REARMS 5`, `DRIP_COALESCE_MS 10000`, `DRIP_REFRESH_LOCK_MS 10000`,
`DRIP_BLOCK_TTL_MS 7d`.

**3a. Count attempts, not scheduling events.** `handleTaskFailure` increments `dripAttempts`
only on the soft-fail path, i.e. only when START was clicked and the claim failed. A
scheduled refresh that finds nothing never reaches it, so a release that excludes our task
cannot burn a strike.

**3b. At 3 attempts, block permanently.** `blockTaskPermanently()` writes to `permaBlocked`,
clears the counters, adds to `processedTaskIds`, persists, and logs to the popup.
`findStartableTasks` filters `permaBlocked` first. Hard-fail reasons still block on the
first failure, unchanged.

**3c. `queryDripSchedule(taskIds)`** replaces `fetchDripSchedule`. It sends `DRIP_QUERY`
through background; the answer arrives asynchronously as `DRIP_INFO`. The dead
`limits.drip.schedule` logic is gone.

**3d. `handleDripInfo` + `scheduleDripSnipe`.** Skew is corrected from `serverTimeMs`, or
quantized to whole seconds when only `serverTime` is present. Only tasks with
`0 < attempts < 3` and `arms < DRIP_MAX_REARMS` are armed, so a broadcast never arms a task
we never tried. Releases already past, or more than an hour out, are ignored. Snipes within
`DRIP_COALESCE_MS` merge into one — since `nextReleaseAt` is global this normally means every
pending task shares a single refresh, which is what keeps us inside the 10s cooldown.

Three `workerTimeout` timers per snipe:
- **T-2s pre-arm** — clears `failedTaskCooldowns`, `preScrollToTasks()`,
  `startAggressiveRAFScan(12000)`. DOM only, zero network.
- **T+jitter fire** — one `TRIGGER_DIRECT_REFRESH { scheduled: true }`. Never a burst.
- **T+jitter+3s re-arm** — if the task still isn't startable, `queryDripSchedule` again.
  Not an attempt.

**3e. Refresh routing under the 10s lock.** In the `RADAR_RELOAD` handler, the reload button
is clicked only when `Date.now() - lastRefreshClickAt >= DRIP_REFRESH_LOCK_MS`; otherwise the
handler logs and relies on the native tab bounce background.js already performed.
`lastRefreshClickAt` is set on both the radar-path click and the scheduled reload in
`mainLoop`. **The assumption that the tab bounce is not gated by the button's cooldown is
still unverified in the live mini app.** If it turns out to be gated, the fallback is the
pre-armed 16ms scanner catching the next natural refetch.

**3f. Re-arm** — implemented as the third timer, capped by `DRIP_MAX_REARMS`.

**3g. Slots-full cooldown** lowered from 60s to 15s.

Also: a successful claim clears `dripAttempts` / `dripRearms` for that task so a future drip
starts from a clean slate.

### 4. Persistence — **DONE**

`chrome.storage.local` under one key:

```js
dripState = {
  attempts: { '24923': 2, ... },
  blocked:  { '24923': { at: 1787041769, reason: '3 attempts' }, ... }
}
```

This must be persisted, not in-memory. `content.js` calls `window.location.reload()` on
stale-cache errors (`content.js:1511`) and hard-reloads every 10–15 minutes
(`content.js:1600`), each of which wipes `processedTaskIds` and `failedTaskCooldowns`. An
in-memory counter would reset before reaching 3 and the task would be retried forever.

Load in `init()` (`content.js:1838`), write on every mutation. Prune `blocked` entries
older than 7 days so the list does not grow without bound.

Firestore sync is intentionally out of scope. The blocklist is per-device claim behavior,
`firebase.js` has no such collection, and adding a network write to the failure path adds
latency and detection surface for no benefit. Revisit only if the blocklist needs to be
shared across devices.

### 5. Popup — **DONE**

- `Drip snipe armed: #24923 in 42s` goes through the existing `ADD_LOG` channel, along with
  `🚫 Task #x blocked after 3 attempts`.
- Settings has a "Blocked Drip Tasks" count and a reset button that clears `dripState`.
  Without a reset, a bad 3-strike run silently removes a task forever with no way back.

## Detection surface

Refreshes are limited to the two triggers in the policy above. A drip release for a task we
never attempted produces nothing. Measured against the deployed radar, drip releases arrived
roughly once per 100s; under the current policy every one of those is ignored unless it is a
task we are chasing, in which case its own snipe was already scheduled.

Deliberately avoided:
- No burst refreshes — rejected on both the 10s cooldown and the fact that fixed-offset
  repeats are a stronger fingerprint than volume.
- No refresh on drip releases for tasks we are not chasing.
- No fixed offset from `releaseAt` — 200–900ms jitter, re-rolled per drip.
- Pre-arm is DOM-only (scroll + local scanner), zero network.
- No new FoxiGrow requests from the extension: `DRIP_QUERY` is answered from radar's cache,
  and radar's own poll pattern (URL, headers, randomized 700–1200ms interval) is unchanged.

Pre-existing surface not addressed here: worker-driven timers keep firing while the tab is
hidden, producing traffic a genuinely backgrounded tab cannot. That is independent of this
change but worth knowing it exists.

## Verification

Extension (offline):

- `node --check` passes on `content.js`, `background.js`, `popup.js`.
- A vm-sandbox harness loads `content.js` with stubbed `chrome`/DOM and captured timers,
  asserting 44 cases: 3-strike counting and permanent block, 15s cooldown, hard-fail
  exclusion, arming only tried tasks, skipping blocked tasks, two tasks sharing one refresh,
  coalescing inside 10s, separate snipes outside it, skew correction from both `serverTimeMs`
  and whole-second `serverTime`, jitter distribution and bounds, stale/far-future rejection,
  re-broadcast churn *not* consuming chase arms, arms accruing only on a passed release that
  missed us, arm counter clearing when the task appears, chase cap, pre-arm doing no network,
  exactly one refresh flagged `scheduled`, nothing firing while paused, blocks surviving a
  reload, and 7-day pruning.
- A second vm-sandbox harness loads `background.js` with stubbed `chrome` APIs and a fake
  WebSocket, capturing every `RADAR_RELOAD` sent to the tab. 16 cases enforcing the two-trigger
  refresh policy: a new-task drop refreshes; a drip-release drop does not refresh, does not tab
  bounce, and does not consume the 12s gate; 10 consecutive drip releases produce zero
  refreshes; a scheduled snipe refreshes even with the gate fully hot; new-task drops still
  respect the gate on both sides of 12s; 12 `DRIP_SCHEDULE` messages produce zero refreshes but
  all 12 forward to content.js; `DRIP_QUERY` reaches the socket; a disabled bot never refreshes.

Radar (live, deployed instance):

- `node --check server.js` clean.
- Local run confirmed against real FoxiGrow traffic before pushing.
- WSS test against `polling-production-9dd0` — 9/9 passing: handshake, `DRIP_SCHEDULE` on
  connect, `serverTimeMs` present, `releaseAt` advancing, `DRIP_INFO` resolving pending vs
  unknown IDs, `TASK_DROP` firing for repeat drip batches, and drops landing within 5s of an
  announced `releaseAt`.
- Idle WS connection held open for 150s with no disconnect.
- Measured clock skew local-vs-Railway: 921ms — real, and exactly why `serverTimeMs` matters.

Still to verify in the live mini app:

1. Set the popup Radar Server URL to `wss://polling-production-9dd0.up.railway.app`.
2. End-to-end: force a slots-full failure on a real drip task, confirm the snipe arms, fires,
   and the next batch is claimed.
3. Snipe accuracy: log actual refresh time minus `releaseAt`. Target under 2s against the
   ~10.5s drain window.
4. Whether the native tab bounce actually refetches while the reload button is inside its 10s
   cooldown (§3e assumption).

## Known loose ends

- `manifest.json` still declares `host_permissions` for
  `polling-production-db64.up.railway.app`. That host is dead (404 on every path) and the
  fetch that needed the permission is gone; WebSocket connections do not require it. The
  entry is harmless but wrong, and can simply be removed. Left in place because the radar
  URL is user-configured in the popup, so hardcoding `9dd0` here would be equally wrong.
- `DEBUG = true` at `content.js:14` is still on from the earlier GO-button investigation.
  It only gates `console.log`, but the drip logging is verbose; turn it off for a quiet
  production build.

## Order of work

1. ~~`background.js` §2 relay + cooldown exemption~~ — done.
2. ~~`content.js` §3 scheduling, attempt limit, cooldown, refresh routing~~ — done.
3. ~~§4 persistence, §5 popup~~ — done.
4. ~~`server.js` §1a–1g~~ — done, deployed, live-verified.
5. ~~Two-trigger refresh policy in `background.js`~~ — done, 16/16 harness passing.
6. Live mini-app verification 1–4 above.
