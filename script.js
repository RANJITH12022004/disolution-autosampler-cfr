    // Dissolution Tester - navigation + API
document.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '0' || e.key === '=')) e.preventDefault();
});

var API_BASE = (function () {
    try {
        if (window.location && window.location.protocol.indexOf('http') === 0) {
            var port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
            if (port === '5000' || port === '5050' || port === '80' || port === '443') {
                return '';
            }
        }
    } catch (e) {}
    return 'http://127.0.0.1:5000';
})();

var testHardwareEnabled = true;
var _hwStreamSource = null;
var _hwStreamListeners = [];

function friabilityHardwareStart(rpm, mode) {
    var body = { rpm: rpm };
    if (mode) body.mode = mode;
    return apiRequest(API_BASE + '/api/hardware/friability/start', {
        method: 'POST',
        body: body
    });
}

function friabilityHardwareStartValidation(rpm) {
    return friabilityHardwareStart(rpm, 'validation');
}

function friabilityHardwarePause() {
    return apiRequest(API_BASE + '/api/hardware/friability/pause', { method: 'POST' });
}

function friabilityHardwareResume() {
    return apiRequest(API_BASE + '/api/hardware/friability/resume', { method: 'POST' });
}

function friabilityHardwareStop() {
    return apiRequest(API_BASE + '/api/hardware/friability/stop', { method: 'POST' });
}

/** Send stop* and retry until ESP acknowledges ok (or attempts exhausted). */
function friabilityHardwareStopWithRetry(maxAttempts) {
    var attempts = Math.max(1, maxAttempts || 5);
    function tryStop(n) {
        return friabilityHardwareStop().then(function (res) {
            if (res && res.ok === true) return res;
            if (n >= attempts) return res || { ok: false, error: 'stop not acknowledged' };
            return tryStop(n + 1);
        });
    }
    return tryStop(1);
}

function friabilityHardwareDispense() {
    return apiRequest(API_BASE + '/api/hardware/friability/dispense', { method: 'POST' });
}

function friabilityHardwareInitialise() {
    return apiRequest(API_BASE + '/api/hardware/friability/initialise', { method: 'POST' }).catch(function (err) {
        return apiRequest(API_BASE + '/api/hardware/friability/initialize', { method: 'POST' });
    });
}

function _parseHardwareStreamPayload(data) {
    try {
        var payload = JSON.parse(data);
        if (payload && !payload.ping) return payload;
    } catch (e) {}
    return null;
}

function ensureHardwareStream() {
    if (_hwStreamSource) return;
    var url = (API_BASE || '') + '/api/hardware/stream';
    _hwStreamSource = new EventSource(url);
    _hwStreamSource.onmessage = function (ev) {
        var payload = _parseHardwareStreamPayload(ev.data);
        if (!payload) return;
        _hwStreamListeners.forEach(function (fn) {
            try { fn(payload); } catch (e) { console.error(e); }
        });
    };
    _hwStreamSource.onerror = function () {
        try {
            if (_hwStreamSource) _hwStreamSource.close();
        } catch (e) {}
        _hwStreamSource = null;
        setTimeout(function () {
            if (_hwStreamListeners.length) ensureHardwareStream();
        }, 2000);
    };
}

function subscribeHardwareStream(listener) {
    ensureHardwareStream();
    if (typeof listener === 'function') _hwStreamListeners.push(listener);
    return function unsubscribe() {
        var idx = _hwStreamListeners.indexOf(listener);
        if (idx >= 0) _hwStreamListeners.splice(idx, 1);
    };
}

/** Parse rotation index from SSE / live API (integers or val lines like 5,24.56). */
function parseHardwareRotationCount(payload) {
    if (!payload) return null;
    if (payload.rotationCount != null && !isNaN(parseInt(payload.rotationCount, 10))) {
        return parseInt(payload.rotationCount, 10);
    }
    var norm = String(payload.normalized || payload.line || '').trim();
    var valMatch = norm.match(/^(\d+),(--|\d+(?:\.\d+)?)$/);
    if (valMatch) return parseInt(valMatch[1], 10);
    if (/^\d+$/.test(norm)) return parseInt(norm, 10);
    var m = norm.match(/(?:rot|count|rotation)[,:\s]+(\d+)/i);
    if (m) return parseInt(m[1], 10);
    return null;
}

/** Parse live RPM from ESP (val lines 5,24.56 / rpm,25) or live API field. */
function parseHardwareRpm(payload) {
    if (!payload) return null;
    if (payload.rpmPending) return null;
    if (payload.rpm != null && !isNaN(parseFloat(payload.rpm))) {
        return parseFloat(payload.rpm);
    }
    var norm = String(payload.normalized || payload.line || '').trim();
    var valMatch = norm.match(/^\d+,(--|(\d+(?:\.\d+)?))$/);
    if (valMatch) {
        if (valMatch[1] === '--') return null;
        return parseFloat(valMatch[2]);
    }
    var lower = norm.toLowerCase();
    var m = lower.match(/^(?:v,)?rpm[,:\s]+(\d+(?:\.\d+)?)$/i);
    if (m) return parseFloat(m[1]);
    return null;
}

function formatHardwareRpmDisplay(rpm) {
    if (rpm == null || isNaN(rpm)) return '--';
    var n = parseFloat(rpm);
    if (Math.abs(n - Math.round(n)) < 0.05) return String(Math.round(n));
    return n.toFixed(2);
}

var _hwLivePollId = null;

function fetchFriabilityLiveState() {
    return apiRequest(API_BASE + '/api/hardware/friability/live', { method: 'GET' });
}

function startHardwareLivePoll(handler) {
    stopHardwareLivePoll();
    if (typeof handler !== 'function') return;
    fetchFriabilityLiveState().then(handler).catch(function () {});
    _hwLivePollId = setInterval(function () {
        fetchFriabilityLiveState().then(handler).catch(function () {});
    }, 400);
}

function stopHardwareLivePoll() {
    if (_hwLivePollId != null) {
        clearInterval(_hwLivePollId);
        _hwLivePollId = null;
    }
}

function applyHardwareTelemetry(state, opts) {
    opts = opts || {};
    if (!state) return;
    var count = parseHardwareRotationCount(state);
    var rpm = parseHardwareRpm(state);
    if (typeof opts.onRotation === 'function' && count != null) {
        opts.onRotation(count, state);
    }
    if (typeof opts.onRpm === 'function' && rpm != null) {
        opts.onRpm(rpm, state);
    }
}

function fetchEspPiLog(lines) {
    var n = lines != null ? lines : 200;
    return apiRequest(API_BASE + '/api/hardware/log?lines=' + encodeURIComponent(n), { method: 'GET' });
}

function closeHardwareStream() {
    if (_hwStreamSource) {
        try { _hwStreamSource.close(); } catch (e) {}
        _hwStreamSource = null;
    }
    _hwStreamListeners = [];
}

function normalizeTestCommaCredential(val) {
    return String(val == null ? '' : val).trim();
}
var currentReportFilter = null;
var lastReportListFilter = 'all';
var _auditViewLogPending = false;
var membersCache = [];
var FACTORY_USERNAME = 'RLERLT';
var currentMemberIdForRoleEdit = null;
var appModalResolve = null;
/** USP friability validation (single procedure). */
/** Dissolution stirrer / paddle RPM setpoint limits (Quick Test, recipes, RPM validation). */
var DISSOLUTION_RPM_MIN = 20;
var DISSOLUTION_RPM_MAX = 300;

function getDissolutionRpmMin() { return DISSOLUTION_RPM_MIN; }
function getDissolutionRpmMax() { return DISSOLUTION_RPM_MAX; }

function dissolutionRpmRangeMessage(prefix) {
    var range = DISSOLUTION_RPM_MIN + '–' + DISSOLUTION_RPM_MAX;
    if (prefix) return String(prefix) + ' RPM must be between ' + range + '.';
    return 'RPM must be between ' + range + '.';
}

function isDissolutionRpmInRange(rpm) {
    var n = typeof rpm === 'number' ? rpm : parseFloat(rpm);
    return !isNaN(n) && n >= DISSOLUTION_RPM_MIN && n <= DISSOLUTION_RPM_MAX;
}

/** Block out-of-range RPM entry: clear field and optionally show a modal. Returns true if empty or in range. */
function enforceDissolutionRpmInput(el, opts) {
    opts = opts || {};
    if (!el) return true;
    var raw = String(el.value == null ? '' : el.value).trim();
    if (raw === '') return true;
    var n = parseFloat(raw);
    if (isNaN(n) || n < DISSOLUTION_RPM_MIN || n > DISSOLUTION_RPM_MAX) {
        el.value = '';
        if (opts.showModal !== false && typeof showAppModal === 'function') {
            showAppModal(dissolutionRpmRangeMessage(opts.prefix || ''), opts.title || 'RPM');
        }
        return false;
    }
    if (opts.asInt) el.value = String(Math.round(n));
    return true;
}

function bindDissolutionRpmInput(el, opts) {
    if (!el || el._dissolutionRpmBound) return;
    el._dissolutionRpmBound = true;
    el.min = String(DISSOLUTION_RPM_MIN);
    el.max = String(DISSOLUTION_RPM_MAX);
    el.setAttribute('min', String(DISSOLUTION_RPM_MIN));
    el.setAttribute('max', String(DISSOLUTION_RPM_MAX));
    var check = function () { enforceDissolutionRpmInput(el, opts); };
    el.addEventListener('change', check);
    el.addEventListener('blur', check);
}

var VALIDATION_USP_RPM = 25;
var VALIDATION_USP_TIME_MIN = 4;
var VALIDATION_USP_ROTATION_TARGET = 100;
var VALIDATION_USP_ROTATION_TOLERANCE = 5;
var VALIDATION_USP_RPM_TOLERANCE = 1;
var VALIDATION_USP_DROP_MM = 14;
var VALIDATION_STARTUP_RPM_VALUES = [24.8, 25.1, 24.9, 25.3, 25.0];

var lastValidationType = 'usp'; // 'usp' = USP friability (25 RPM, 4 min, 100 rotations)
var validationRunState = 'idle'; // 'idle' | 'running' | 'completed'
var validationRunIntervalId = null;
var validationRunTimerIntervalId = null;
var validationRunCurrentCount = 0;
var validationRunElapsedSec = 0;
var validationRunExpected = VALIDATION_USP_ROTATION_TARGET;
var validationRunTarget = VALIDATION_USP_ROTATION_TARGET;
var validationRunTolerance = VALIDATION_USP_ROTATION_TOLERANCE;
var validationRunMin = VALIDATION_USP_ROTATION_TARGET - VALIDATION_USP_ROTATION_TOLERANCE;
var validationRunMax = VALIDATION_USP_ROTATION_TARGET + VALIDATION_USP_ROTATION_TOLERANCE;
var validationRunBackendPending = false;
var validationRunLiveRpm = null;
var validationRunLiveRpmLastMs = null;
var validationRunRpmAllPass = true;
var validationHardwareEnabled = true;
var validationRunHwUnsubscribe = null;
var validationHwAwaitingStart = false;
var validationRunLastHwCount = 0;
var validationRunLastHwCountMs = null;
var validationRunStartedAtIso = null;
var validationCompletion = { usp: false };
var biometricEnabledSetting = true;
var currentReportId = null;
var currentReportData = null;
var currentRecipeForPrint = null;
var lastKnownDateTime = null;
var dateTimeClockInterval = null;
var lastDisplayedRecipes = [];
var pendingRecipeToLoad = null;
var pendingRecipeLoadContext = null;
var recipeListMode = 'manage'; // 'manage' | 'load'
var _suppressTestRunNavGuardOnce = false;
var _suppressValidationRunNavGuardOnce = false;
var _suppressValidationSuiteNavGuardOnce = false;
var _suppressCalibrationNavGuardOnce = false;
var _validationAbortInProgress = false;
var testRunButtonState = 'start';
var _reportApprovalPollTimerId = null;
var approvalVerifyResolve = null;
var approvalVerifyReject = null;
var adminApprovalVerifyResolve = null;
var adminApprovalVerifyReject = null;
var _approvalVerifyModalOriginal = null;
var _approvalVerifyButtonOriginal = null;
var _approvalVerifyEmptyCredentialsMessage = 'Enter QA username and password.';
var _approvalVerifyPurpose = 'recipe';
/** Display label: Supervisor role shown as Reviewer (stored value unchanged). */
function displayRoleLabel(role) {
    var r = String(role || '').trim();
    if (String(r).toLowerCase() === 'supervisor') return 'Reviewer';
    return r || '--';
}

function formatAuditDetailsText(details) {
    var s = String(details || '');
    s = s.replace(/\s*\(\s*\d+\s*min\s+limit\s*\)/gi, '');
    s = s.replace(/\(\s*supervisor\s*\)/gi, '(Reviewer)');
    return s.trim();
}

var _auditActivePage = null;
var _auditSkipPages = { login: true, 'password-expired-reset': true };
var _auditEventQueue = Promise.resolve();

var PAGE_AUDIT_LABELS = {
    home: 'Home',
    'quick-test': 'Quick Test',
    'manage-recipes': 'Manage Recipes',
    'create-recipe-step1': 'Create Recipe',
    'create-recipe-step2': 'Configure Steps',
    'create-recipe-step3': 'Cylinder Size',
    'manage-members': 'Manage Profiles',
    'locked-members': 'Locked Members',
    'disabled-members': 'Disabled Members',
    'add-member': 'Add New Member',
    validate: 'Validation',
    'validate-type-select': 'Select Validation Type',
    'temperature-validation': 'Temperature Validation',
    'temperature-validation-result': 'Test Data',
    'rpm-validation': 'RPM Validation',
    'rpm-validation-result': 'Test Data',
    'physical-parameters': 'Physical Parameters',
    'sample-volume-validation': 'Sample Volume Validation',
    'sample-volume-validation-result': 'Test Data',
    'validation-suite-review': 'Save Validation',
    'system-settings': 'Test Settings',
    'wakeup-schedule': 'Wakeup Schedule',
    'ip-config': 'IP Config',
    'ip-config-result': 'IP Config',
    'hardware-init': 'Hardware Initialise',
    'heater-control': 'Heater',
    calibration: 'Calibration',
    'calibration-type-select': 'Select Calibration Type',
    'load-calibration': 'Load Calibration',
    'distance-zero-calibration': 'Distance Calibration',
    settings: 'Settings',
    datetime: 'Date and Time',
    'factory-settings': 'Factory Settings',
    reports: 'Reports',
    export: 'Export',
    'report-preview': 'Report Preview',
    'user-profile': 'User Profile',
    'view-recipes': 'View Recipe',
    'recipe-print-preview': 'Recipe Print',
    'validation-run': 'Validation Test',
    'disable-recipes': 'Disabled Recipes'
};

function auditPageLabel(pageName) {
    if (pageName === 'manage-recipes') {
        return (typeof recipeListMode !== 'undefined' && recipeListMode === 'load')
            ? 'Load Recipe'
            : 'Manage Recipes';
    }
    if (PAGE_AUDIT_LABELS[pageName]) return PAGE_AUDIT_LABELS[pageName];
    if (PAGE_TITLES[pageName]) return PAGE_TITLES[pageName];
    return pageName || '';
}

function logAuditEvent(action, details, options) {
    options = options || {};
    var auditUser = window.currentUser ? {
        username: window.currentUser.username || '',
        name: window.currentUser.name || '',
        role: window.currentUser.role || ''
    } : null;
    if (!auditUser || (!auditUser.username && !auditUser.name)) return Promise.resolve();
    var body = {
        action: action,
        details: details || '',
        outcome: options.outcome || 'success',
        eventType: options.eventType || 'lifecycle',
        entityType: options.entityType || '',
        entityName: options.entityName || '',
        entityId: options.entityId,
        reason: options.reason || '',
        extra: options.extra || {}
    };
    var headers = {};
    if (auditUser.role) headers['X-User-Role'] = auditUser.role;
    if (auditUser.name) headers['X-User-Name'] = auditUser.name;
    if (auditUser.username) headers['X-User-Username'] = auditUser.username;
    var send = function () {
        return apiRequest(API_BASE + '/api/data/audit-log/event', {
            method: 'POST',
            headers: headers,
            body: body
        }).catch(function (err) {
            var msg = err && err.message ? err.message : err;
            console.error('[audit]', action, details, msg);
        });
    };
    _auditEventQueue = _auditEventQueue.catch(function () {}).then(send);
    return _auditEventQueue;
}

function flushAuditEventQueue() {
    return _auditEventQueue.catch(function () {});
}

function auditExitActiveScreenBeforeSessionEnd() {
    var active = _auditActivePage;
    if (!active || _auditSkipPages[active] || !window.currentUser) {
        _auditActivePage = null;
        return Promise.resolve();
    }
    _auditActivePage = null;
    return logAuditEvent('Exited screen', auditPageLabel(active), { eventType: 'navigation' });
}

function auditTestRunStarted(rec) {
    var recipe = rec || window.activeTestRecipe || {};
    if (!recipe || (!recipe.productName && !recipe.name)) return;
    var isQuick = !!(recipe.quickTest) || String(recipe.productName || '').trim() === 'Quick Test';
    var modeLabel = (_tr && _tr.completionMode === 'TIME') ? 'TIME' : 'COUNT';
    var targetLabel = (_tr && _tr.completionMode === 'TIME')
        ? formatSecondsAsMmSs(_tr.targetSeconds || 0)
        : ((_tr && _tr.targetRotations) ? (_tr.targetRotations + ' rotations') : '--');
    var action = isQuick ? 'Quick test started' : 'Test started';
    var details = (recipe.productName || recipe.name || 'Test') + ', batch ' + (recipe.batchNumber || '--')
        + ', ' + modeLabel + ', ' + targetLabel + ', ' + ((_tr && _tr.rpm) ? _tr.rpm : '--') + ' RPM';
    logAuditEvent(action, details, {
        eventType: 'lifecycle',
        entityType: 'test',
        entityName: recipe.productName || recipe.name || '',
        extra: {
            productName: recipe.productName || recipe.name,
            batchNumber: recipe.batchNumber,
            rpm: _tr ? _tr.rpm : null,
            mode: modeLabel,
            target: targetLabel
        }
    });
}

function auditTestRunFinished(reportId) {
    logAuditEvent('Test finished', 'Test run completed | report id ' + (reportId != null ? reportId : '--'), {
        eventType: 'lifecycle',
        entityType: 'report',
        entityId: reportId != null ? reportId : '',
        extra: { reportId: reportId }
    });
}

function auditTestRunAborted(reason) {
    var rec = window.activeTestRecipe || {};
    logAuditEvent('Test aborted', reason || ('User aborted test for ' + (rec.productName || rec.name || 'recipe')), {
        eventType: 'lifecycle',
        entityType: 'test',
        outcome: 'aborted',
        extra: {
            productName: rec.productName || rec.name,
            batchNumber: rec.batchNumber
        }
    });
}

function auditTestRunAutoAborted(reason) {
    logAuditEvent('Test auto-aborted', reason || 'Hardware stopped the test run', {
        eventType: 'lifecycle',
        entityType: 'test',
        outcome: 'failed',
        extra: { reason: reason || '' }
    });
}

function refreshAuditTrailIfVisible() {
    if (currentReportFilter !== 'audit') return;
    if (typeof canViewAuditLog === 'function' && !canViewAuditLog()) return;
    if (typeof loadReports === 'function') loadReports('audit');
}

function _auditReportLabel(payload) {
    var p = payload || {};
    var recipe = p.recipe || (p.testData && p.testData.recipe) || {};
    var name = p.name || recipe.productName || recipe.name || 'Report';
    var batch = recipe.batchNumber || p.batchNumber || '';
    return batch ? (name + ', batch ' + batch) : name;
}

function logTestReportSavedAudit(reportId, payload) {
    if (reportId == null) return Promise.resolve();
    var label = _auditReportLabel(payload);
    var recipe = (payload && payload.recipe) || (payload && payload.testData && payload.testData.recipe) || window.activeTestRecipe || {};
    var isQuick = !!(recipe && recipe.quickTest) || !!(payload && payload.recipe && payload.recipe.quickTest);
    var isAborted = !!(payload && (payload.status === 'Aborted' || (payload.testData && payload.testData.status === 'aborted')));
    var type = (payload && payload.type) ? String(payload.type).toLowerCase() : 'test';
    var entityOpts = {
        eventType: 'lifecycle',
        entityType: 'report',
        entityId: reportId,
        entityName: label
    };

    if (type === 'validation') {
        return logAuditEvent('Report generated', label + ' | report id ' + reportId, entityOpts).then(function () {
            return logAuditEvent('Report saved', label + ' | report id ' + reportId, entityOpts);
        }).then(function () {
            refreshAuditTrailIfVisible();
        });
    }

    var chain = Promise.resolve();
    if (isAborted) {
        chain = chain.then(function () {
            return logAuditEvent('Test aborted', label + ' | report id ' + reportId, entityOpts);
        });
    } else {
        chain = chain.then(function () {
            return logAuditEvent(
                isQuick ? 'Quick test performed' : 'Test performed',
                label + ' | report id ' + reportId,
                entityOpts
            );
        });
    }
    return chain.then(function () {
        return logAuditEvent('Report saved', label + ' | report id ' + reportId, entityOpts);
    }).then(function () {
        refreshAuditTrailIfVisible();
    });
}

function logReportApprovedAudit(reportId, passFail, remarks) {
    if (reportId == null) return Promise.resolve();
    var pf = passFail ? String(passFail).toUpperCase() : '';
    var detail = 'Report id ' + reportId + (pf ? ' | ' + pf : '');
    if (remarks) detail += ' | ' + remarks;
    return logAuditEvent('Report approved', detail, {
        eventType: 'lifecycle',
        entityType: 'report',
        entityId: reportId,
        entityName: 'Report ' + reportId
    }).then(function () {
        refreshAuditTrailIfVisible();
    });
}

function auditNavPageChange(newPage) {
    if (_auditSkipPages[newPage]) {
        _auditActivePage = null;
        return;
    }
    if (newPage === _auditActivePage) return;
    var prev = _auditActivePage;
    _auditActivePage = newPage;
    if (!window.currentUser) return;
    if (prev && !_auditSkipPages[prev]) {
        logAuditEvent('Exited screen', auditPageLabel(prev), { eventType: 'navigation' });
    }
    if (newPage === 'validation-run') {
        logAuditEvent('Entered USP validation', 'USP friability validation screen', { eventType: 'navigation' });
    } else if (newPage && !_auditSkipPages[newPage]) {
        logAuditEvent('Entered screen', auditPageLabel(newPage), { eventType: 'navigation' });
    }
}

var editingMemberId = null;
var _addMemberFeatureOverrides = { allow: [], deny: [] };
var _addMemberLastSavedId = null;

/** Approved-by line may contain "(supervisor)" from stored reports — show as Reviewer. */
function formatApprovedByLine(line) {
    var s = String(line || '').trim();
    if (!s || s === '--') return '--';
    return s.replace(/\(\s*supervisor\s*\)/gi, '(Reviewer)');
}

function getActivePageName() {
    var active = document.querySelector('.page.active');
    if (!active || !active.id) return '';
    return active.id.indexOf('page-') === 0 ? active.id.slice(5) : active.id;
}

function isEditableTarget(el) {
    if (!el) return false;
    var tag = String(el.tagName || '').toLowerCase();
    if (el.isContentEditable) return true;
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    var t = String(el.type || 'text').toLowerCase();
    return t !== 'button' && t !== 'checkbox' && t !== 'radio' && t !== 'submit' && t !== 'reset';
}

function isDissolutionTestActive() {
    // Lock navigation only after Start (running / paused).
    // Preheat and "recipe loaded but not started" must allow free navigation.
    var dt = (typeof _dissolutionTest !== 'undefined' && _dissolutionTest) || window._dissolutionTest || null;
    if (dt && (dt.running || dt.paused)) return true;
    try {
        if (window._dissoServerRunActive === true) return true;
    } catch (e) { /* ignore */ }
    return false;
}

/** True once Preheat has been started (or test is running) — enables Home "Test Screen" card. */
function hasReturnableDissolutionSession() {
    var dt = (typeof _dissolutionTest !== 'undefined' && _dissolutionTest) || window._dissolutionTest || null;
    if (!dt || !dt.recipe) return false;
    return !!(dt.preheating || dt.preheatDone || dt.running || dt.paused);
}

function refreshHomeTestScreenCard() {
    var card = document.getElementById('home-test-screen-card');
    var grid = document.getElementById('home-test-options');
    var show = typeof hasReturnableDissolutionSession === 'function' && hasReturnableDissolutionSession();
    if (card) {
        if (show) card.removeAttribute('hidden');
        else card.setAttribute('hidden', '');
        card.style.display = show ? '' : 'none';
    }
    if (grid) grid.classList.toggle('has-test-screen', !!show);
}

function returnToDissolutionTestScreen() {
    if (typeof hasReturnableDissolutionSession !== 'function' || !hasReturnableDissolutionSession()) {
        refreshHomeTestScreenCard();
        return;
    }
    goToPage('test-run');
}

function restoreDissolutionTestRunUi() {
    var dt = _dissolutionTest;
    if (!dt) return;
    if (dt.running && dt.paused) _dtSetControlsPaused();
    else if (dt.running) _dtSetControlsRunning();
    else _dtSetControlsIdle();
    _dtSyncEquipVisuals();
    if (typeof _dtSyncStirrerLock === 'function') _dtSyncStirrerLock();
    if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
    if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
}

function isTestRunActive() {
    return typeof isDissolutionTestActive === 'function' && isDissolutionTestActive();
}

function _dtConfirmAbortForNavigation() {
    return showYesNoModal(
        'A dissolution test is in progress. Abort the test to leave this screen?',
        'Abort Test',
        'Abort',
        'Stay'
    ).then(function (ok) {
        if (!ok) return false;
        // Save pending aborted report and open locked preview; do not navigate away.
        return Promise.resolve(_dtPerformAbort({})).then(function () {
            if (typeof cleanupDissolutionTestOnLeave === 'function') cleanupDissolutionTestOnLeave();
            if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
            return false;
        }).catch(function () {
            if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
            return false;
        });
    });
}

function _confirmAbortValidationSuiteForNavigation() {
    if (typeof isValidationSuiteActive !== 'function' || !isValidationSuiteActive()) {
        return Promise.resolve(true);
    }
    var kindLabel = 'validation suite';
    if (typeof getValidationSuiteAbortLabel === 'function') {
        kindLabel = getValidationSuiteAbortLabel() || kindLabel;
    }
    return showConfirmModal(
        'Do you want to abort ' + kindLabel + '? Progress will be saved as an aborted report and requires approval.',
        'Abort Validation',
        { okLabel: 'Abort' }
    ).then(function (ok) {
        if (!ok) return false;
        var abortFn = typeof abortValidationSuite === 'function' ? abortValidationSuite : null;
        if (!abortFn) return true;
        return Promise.resolve(abortFn({ reason: 'navigation leave' })).then(function () {
            if (typeof stopRpmValidationMotor === 'function') stopRpmValidationMotor();
            if (typeof applyValidationSuiteLockUi === 'function') applyValidationSuiteLockUi();
            // Pending preview/lock opened by abort — stay on report screen.
            return false;
        }).catch(function () {
            if (typeof applyValidationSuiteLockUi === 'function') applyValidationSuiteLockUi();
            return false;
        });
    });
}

function isValidationSuiteNavAllowed(pageName) {
    var allowed = {
        'rpm-validation': 1,
        'rpm-validation-result': 1,
        'physical-parameters': 1,
        'sample-volume-validation': 1,
        'sample-volume-validation-result': 1,
        'temperature-validation': 1,
        'temperature-validation-result': 1,
        'validation-suite-review': 1,
        'report-preview': 1,
        'reports': 1
    };
    return !!allowed[pageName];
}

function applyDtRunLockUi() {
    var locked = typeof isDissolutionTestActive === 'function' && isDissolutionTestActive();
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('dt-run-locked', !!locked);
    var profileEl = document.querySelector('.sidebar .user-profile');
    var logoutBtn = document.querySelector('.sidebar .logout-btn');
    if (!app || !app.classList.contains('report-approval-locked')) {
        [profileEl, logoutBtn].forEach(function (el) {
            if (!el) return;
            var suiteLocked = app && app.classList.contains('validation-suite-locked');
            var block = locked || suiteLocked;
            el.style.pointerEvents = block ? 'none' : '';
            el.style.opacity = block ? '0.45' : '';
            if (block) el.setAttribute('aria-disabled', 'true');
            else el.removeAttribute('aria-disabled');
        });
    }
}

function applyValidationSuiteLockUi() {
    var locked = typeof isValidationSuiteActive === 'function' && isValidationSuiteActive();
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('validation-suite-locked', !!locked);
    if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
}

function setShellPageTitle(text) {
    var title = document.getElementById('header-title');
    if (title) title.textContent = text || '';
}

function isValidationRunActive() {
    return getActivePageName() === 'validation-run' && validationRunState === 'running';
}

function isValidationNavigationBlocked() {
    return getActivePageName() === 'validation-run' &&
        (validationRunState === 'running' || validationRunBackendPending === true || validationHwAwaitingStart === true);
}

function isValidationPartiallyCompleted() {
    return false;
}

function isValidationFullyCompleted() {
    return !!validationCompletion.usp;
}

function getMissingValidationLabel() {
    return '';
}

function stopActiveRunForLogout() {
    // Abort active validation hardware run before logout.
    if (validationRunState === 'running' || validationRunBackendPending) {
        if (validationRunIntervalId != null) {
            clearInterval(validationRunIntervalId);
            validationRunIntervalId = null;
        }
        return stopValidationOnBackend().catch(function () {}).finally(function () {
            validationRunState = 'idle';
            validationRunBackendPending = false;
        });
    }
    return Promise.resolve();
}

document.addEventListener('keydown', function (e) {
    if (e.key !== 'Backspace') return;
    if (isEditableTarget(e.target)) return;
    if (isTestRunActive() || isValidationRunActive() ||
        (typeof isValidationSuiteActive === 'function' && isValidationSuiteActive()) ||
        (typeof isReportPreviewLockedForCurrentUser === 'function' &&
            isReportPreviewLockedForCurrentUser(window._lastReportPreview))) {
        e.preventDefault();
    }
}, true);

function closeAppModal(ok) {
    var overlay = document.getElementById('app-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    if (appModalResolve) {
        appModalResolve(ok === true);
        appModalResolve = null;
    }
}

var _procedureCallback = null;
var PROCEDURE_VALIDATION_TACHOMETER = [
    'Please Measure The Paddle / Basket Speed With A Certified Tachometer.'
];
var PROCEDURE_VALIDATION_THERMOMETER = [
    '1. Confirm bath and external probe live readings are shown.',
    '2. Press Validate and wait 3 minutes while the reading stabilizes.',
    '3. Enter the measured temperature from a certified thermometer.',
    '4. Complete to record bath, external, and measured values in the suite report.'
];
var PROCEDURE_CALIBRATION_TEMPERATURE = [
    '1. Press Start and wait 3 minutes for bath and external readings to stabilize.',
    '2. Enter one Measured (Reference) thermometer value (15–55 °C).',
    '3. Press Calibrate to send the reference to Bath and External on the ESP.',
    '4. Confirm live readings after calibration completes.'
];

function showProcedureModal(title, stepsArray, onConfirm) {
    _procedureCallback = typeof onConfirm === 'function' ? onConfirm : null;
    var titleEl = document.getElementById('procedure-modal-title');
    var stepsEl = document.getElementById('procedure-modal-steps');
    var modal = document.getElementById('procedure-modal');
    if (titleEl) titleEl.textContent = title || 'Procedure';
    if (stepsEl) {
        stepsEl.innerHTML = '';
        if (Array.isArray(stepsArray)) {
            stepsArray.forEach(function (step) {
                var p = document.createElement('p');
                p.textContent = step;
                stepsEl.appendChild(p);
            });
        }
    }
    if (modal) modal.style.display = 'flex';
}

function closeProcedureModal() {
    _procedureCallback = null;
    var modal = document.getElementById('procedure-modal');
    if (modal) modal.style.display = 'none';
}

function confirmProcedureModal() {
    var cb = _procedureCallback;
    closeProcedureModal();
    if (typeof cb === 'function') cb();
}

function showAppModal(message, title, onClose) {
    var overlay = document.getElementById('app-modal-overlay');
    var titleEl = document.getElementById('app-modal-title');
    var msgEl = document.getElementById('app-modal-message');
    var buttonsEl = document.getElementById('app-modal-buttons');
    if (!overlay || !titleEl || !msgEl || !buttonsEl) {
        window.alert(message);
        if (typeof onClose === 'function') onClose();
        return;
    }
    titleEl.textContent = title || 'Message';
    msgEl.textContent = message || '';
    buttonsEl.innerHTML = '';
    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn-role-select btn-role-user';
    okBtn.textContent = 'OK';
    okBtn.onclick = function () {
        if (appModalResolve) {
            appModalResolve(true);
            appModalResolve = null;
        }
        overlay.style.display = 'none';
        if (typeof onClose === 'function') onClose();
    };
    buttonsEl.appendChild(okBtn);
    overlay.style.display = 'flex';
}

function showConfirmModal(message, title, options) {
    options = options || {};
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            var ok = window.confirm(message);
            resolve(ok);
            return;
        }
        appModalResolve = resolve;
        titleEl.textContent = title || 'Confirm';
        msgEl.textContent = message || '';
        buttonsEl.innerHTML = '';
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-role-select btn-confirm-cancel';
        cancelBtn.textContent = options.cancelLabel || 'Cancel';
        cancelBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(false);
                appModalResolve = null;
            }
        };
        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn-role-select btn-confirm-ok';
        var t = String(title || '').trim().toLowerCase();
        var defaultOk = 'OK';
        if (options.okLabel) defaultOk = options.okLabel;
        else if (t.indexOf('abort') !== -1) defaultOk = 'Abort';
        else if (t === 'test running') defaultOk = 'Abort Test';
        else if (t === 'operation in progress') defaultOk = 'Abort';
        okBtn.textContent = defaultOk;
        okBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(true);
                appModalResolve = null;
            }
        };
        buttonsEl.appendChild(cancelBtn);
        buttonsEl.appendChild(okBtn);
        overlay.style.display = 'flex';
    });
}

function showYesNoModal(message, title, yesLabel, noLabel) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            resolve(window.confirm(message));
            return;
        }
        appModalResolve = resolve;
        titleEl.textContent = title || 'Confirm';
        msgEl.textContent = message || '';
        buttonsEl.innerHTML = '';
        var noBtn = document.createElement('button');
        noBtn.type = 'button';
        noBtn.className = 'btn-role-select btn-confirm-cancel';
        noBtn.textContent = noLabel || 'No';
        noBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(false);
                appModalResolve = null;
            }
        };
        var yesBtn = document.createElement('button');
        yesBtn.type = 'button';
        yesBtn.className = 'btn-role-select btn-confirm-ok';
        yesBtn.textContent = yesLabel || 'Yes';
        yesBtn.onclick = function () {
            overlay.style.display = 'none';
            if (appModalResolve) {
                appModalResolve(true);
                appModalResolve = null;
            }
        };
        buttonsEl.appendChild(noBtn);
        buttonsEl.appendChild(yesBtn);
        overlay.style.display = 'flex';
    });
}

function _closeModalOSK() {
    if (typeof closeOSK === 'function') closeOSK();
}

function _focusInputWithOSK(input, promptText) {
    if (!input) return;
    if (promptText) input.setAttribute('data-osk-prompt', promptText);
    if (typeof attachInputFocusToSingle === 'function') {
        attachInputFocusToSingle(input);
    }
    setTimeout(function () {
        try { input.focus(); } catch (e) {}
        if (typeof window.openOSKForInput === 'function') {
            window.openOSKForInput(input);
        }
    }, 50);
}

function promptNumberModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            var raw = window.prompt(opts.message || 'Enter value', opts.defaultValue || '');
            if (raw == null) return resolve(null);
            var num = parseFloat(String(raw).trim());
            if (isNaN(num)) return resolve(null);
            resolve(num);
            return;
        }
        titleEl.textContent = opts.title || 'Enter value';
        msgEl.textContent = opts.message || '';
        buttonsEl.innerHTML = '';

        var inputWrap = document.createElement('div');
        inputWrap.className = 'form-group';
        inputWrap.style.marginTop = '10px';
        var input = document.createElement('input');
        input.type = 'text';
        input.inputMode = 'decimal';
        input.className = 'input-field decimal-input';
        input.setAttribute('data-decimal-input', 'true');
        input.setAttribute('autocomplete', 'off');
        input.placeholder = opts.placeholder || '';
        if (opts.defaultValue != null) input.value = String(opts.defaultValue);
        inputWrap.appendChild(input);
        msgEl.appendChild(inputWrap);

        var closePrompt = function (value) {
            _closeModalOSK();
            overlay.style.display = 'none';
            resolve(value);
        };

        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-role-select btn-confirm-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = function () {
            closePrompt(null);
        };
        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'btn-role-select btn-confirm-ok';
        okBtn.textContent = 'OK';
        okBtn.onclick = function () {
            var num = parseFloat(String(input.value || '').trim());
            if (isNaN(num) || (opts.min != null && num < opts.min)) {
                showAppModal(opts.invalidMessage || 'Please enter a valid number.', opts.title || 'Enter value');
                return;
            }
            closePrompt(num);
        };
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                okBtn.click();
            }
        });
        buttonsEl.appendChild(cancelBtn);
        buttonsEl.appendChild(okBtn);
        overlay.style.display = 'flex';
        _focusInputWithOSK(input, opts.title || opts.placeholder || 'Enter value');
    });
}

function updateProfileFromCurrentUser(user) {
    if (!user) return;
    var name = user.name || user.username || '';
    var role = user.role || '';
    var nameEl = document.getElementById('profile-name-display');
    if (nameEl) {
        nameEl.textContent = name || '---';
    }
    var roleEl = document.getElementById('profile-role-display');
    if (roleEl) {
        roleEl.textContent = displayRoleLabel(role);
    }
    var fullNameInput = document.getElementById('profile-fullname');
    if (fullNameInput && name) {
        fullNameInput.value = name;
    }
}

function apiRequest(path, options) {
    options = options || {};
    var base = API_BASE || '';
    var p = String(path || '');
    if (base && p.indexOf(base) === 0) {
        p = p.slice(base.length);
        if (p.charAt(0) !== '/') p = '/' + p;
    }
    var url = base + p;
    var headers = { 'Content-Type': 'application/json' };
    if (typeof window !== 'undefined' && window.currentUser) {
        var hdrRole = window.currentUser.role;
        if (!hdrRole && typeof getCurrentRole === 'function') {
            var gr = getCurrentRole();
            if (gr) hdrRole = gr;
        }
        if (hdrRole) headers['X-User-Role'] = hdrRole;
        if (window.currentUser.name) headers['X-User-Name'] = window.currentUser.name;
        if (window.currentUser.username) headers['X-User-Username'] = window.currentUser.username;
    }
    if (options.headers) for (var h in options.headers) headers[h] = options.headers[h];
    var opts = { method: options.method || 'GET', headers: headers };
    if (options.body !== undefined) opts.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    return fetch(url, opts).then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (!r.ok) {
            if (ct.indexOf('json') !== -1) {
                return r.json().then(function (data) {
                    var msg = (data && (data.error || data.message)) ? String(data.error || data.message) : (r.statusText || r.status);
                    throw new Error(msg);
                }).catch(function (err) {
                    throw err instanceof Error ? err : new Error(r.statusText || r.status);
                });
            }
            return r.text().then(function (text) {
                throw new Error(text || r.statusText || r.status);
            }).catch(function () {
                throw new Error(r.statusText || r.status);
            });
        }
        if (ct.indexOf('json') !== -1) return r.json();
        return r.text();
    });
}

function openApprovalVerifyModal(options) {
    return new Promise(function (resolve, reject) {
        _approvalVerifyReturnPage = (typeof getActivePageName === 'function' ? getActivePageName() : '') || 'home';
        if (typeof goToPage === 'function') goToPage('approval-verify');
        var els = _getApprovalVerifyModalElements();
        if (!els) {
            reject(new Error('QA verification UI is missing.'));
            return;
        }
        approvalVerifyResolve = resolve;
        approvalVerifyReject = reject;
        _storeApprovalVerifyModalOriginalUiOnce();
        _restoreApprovalVerifyModalOriginalUi();
        _setApprovalVerifyModalButtonHandlers(submitApprovalVerifyModal, cancelApprovalVerifyModal);
        var o = options == null ? {} : options;
        _approvalVerifyPurpose = o.purpose || 'recipe';
        if (o.titleText && els.titleEl) els.titleEl.textContent = o.titleText;
        if (o.subtitleText && els.subtitleEl) els.subtitleEl.textContent = o.subtitleText;
        if (o.usernameLabelText && els.usernameLabelEl) els.usernameLabelEl.textContent = o.usernameLabelText;
        if (o.usernamePlaceholder && els.usernameEl) els.usernameEl.setAttribute('placeholder', o.usernamePlaceholder);
        _approvalVerifyEmptyCredentialsMessage = o.emptyCredentialsMessage || 'Enter QA username and password.';
        if (els.errEl) {
            els.errEl.textContent = '';
            els.errEl.style.display = 'none';
        }
        els.usernameEl.value = '';
        els.passwordEl.value = '';
        if (!els.passwordEl._approvalVerifyEnterHandler) {
            els.passwordEl._approvalVerifyEnterHandler = function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (adminApprovalVerifyResolve) submitAdminApprovalVerifyModal();
                    else submitApprovalVerifyModal();
                }
            };
            els.passwordEl.addEventListener('keydown', els.passwordEl._approvalVerifyEnterHandler);
        }
        _focusInputWithOSK(els.usernameEl, els.usernameLabelEl ? els.usernameLabelEl.textContent : 'Username');
    });
}

function closeApprovalVerifyModal() {
    if (typeof goToPage === 'function') goToPage(_approvalVerifyReturnPage || 'home');
}

function cancelApprovalVerifyModal() {
    closeApprovalVerifyModal();
    _restoreApprovalVerifyModalOriginalUi();
    if (approvalVerifyResolve) {
        approvalVerifyResolve(null);
        approvalVerifyResolve = null;
    }
    if (approvalVerifyReject) approvalVerifyReject = null;
}

function submitApprovalVerifyModal() {
    var usernameEl = document.getElementById('approval-verify-username');
    var passwordEl = document.getElementById('approval-verify-password');
    var errEl = document.getElementById('approval-verify-error');
    var username = usernameEl ? String(usernameEl.value || '').trim() : '';
    var password = passwordEl ? String(passwordEl.value || '') : '';
    if (!username || !password) {
        if (errEl) {
            errEl.textContent = _approvalVerifyEmptyCredentialsMessage;
            errEl.style.display = 'block';
        }
        return;
    }
    apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: { method: 'credentials', username: username, password: password, purpose: _approvalVerifyPurpose }
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            if (errEl) {
                errEl.textContent = (data && data.error) ? String(data.error) : 'Verification failed.';
                errEl.style.display = 'block';
            }
            return;
        }
        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (approvalVerifyResolve) {
            approvalVerifyResolve(String(data.token));
            approvalVerifyResolve = null;
        }
        if (approvalVerifyReject) approvalVerifyReject = null;
    }).catch(function (err) {
        if (errEl) {
            errEl.textContent = 'Verification failed: ' + (err && err.message ? err.message : 'Error');
            errEl.style.display = 'block';
        }
    });
}

function submitApprovalVerifyBiometricModal() {
    var errEl = document.getElementById('approval-verify-error');
    if (!biometricEnabledSetting) {
        if (errEl) {
            errEl.textContent = 'Biometric verification is disabled by Factory Settings.';
            errEl.style.display = 'block';
        }
        return;
    }
    if (errEl) {
        errEl.textContent = '';
        errEl.style.display = 'none';
    }
    runBiometricVerifyWithRetry({
        purpose: _approvalVerifyPurpose,
        title: 'Verify Fingerprint',
        message: 'Place an Admin/QA fingerprint on the scanner to authorize this action.',
        failureHint: 'Place your finger on the scanner and tap Try again.'
    }).then(function (result) {
        if (!result || !result.ok) {
            if (result && result.error !== 'cancelled' && errEl) {
                errEl.textContent = result.message || result.error || 'Fingerprint verification failed.';
                errEl.style.display = 'block';
            }
            return;
        }
        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (approvalVerifyResolve) {
            approvalVerifyResolve(String(result.token));
            approvalVerifyResolve = null;
        }
        if (approvalVerifyReject) approvalVerifyReject = null;
    });
}

function _getApprovalVerifyModalElements() {
    var overlay = document.getElementById('page-approval-verify');
    var usernameEl = document.getElementById('approval-verify-username');
    var passwordEl = document.getElementById('approval-verify-password');
    var errEl = document.getElementById('approval-verify-error');
    if (!overlay || !usernameEl || !passwordEl || !errEl) return null;
    var usernameLabelEl = overlay.querySelector('label[for="approval-verify-username"]');
    var actionsRow = overlay.querySelector('.add-member-actions');
    var userBtn = actionsRow ? actionsRow.querySelector('button.btn-primary') : null;
    var cancelBtn = null;
    if (actionsRow) {
        var secs = actionsRow.querySelectorAll('button.btn-secondary');
        for (var i = 0; i < secs.length; i++) {
            var oc = secs[i].getAttribute('onclick') || '';
            if (oc.indexOf('cancelApprovalVerifyModal') >= 0 || oc.indexOf('cancelAdminApprovalVerifyModal') >= 0) {
                cancelBtn = secs[i];
                break;
            }
        }
    }
    var titleEl = document.getElementById('approval-verify-title');
    var subtitleEl = document.getElementById('approval-verify-subtitle');
    return { overlay: overlay, usernameEl: usernameEl, passwordEl: passwordEl, errEl: errEl, usernameLabelEl: usernameLabelEl, userBtn: userBtn, cancelBtn: cancelBtn, titleEl: titleEl, subtitleEl: subtitleEl };
}

function _storeApprovalVerifyModalOriginalUiOnce() {
    if (_approvalVerifyModalOriginal) return;
    var els = _getApprovalVerifyModalElements();
    if (!els) return;
    _approvalVerifyModalOriginal = {
        titleText: els.titleEl ? els.titleEl.textContent : null,
        subtitleText: els.subtitleEl ? els.subtitleEl.textContent : null,
        usernameLabelText: els.usernameLabelEl ? els.usernameLabelEl.textContent : null,
        usernamePlaceholder: els.usernameEl ? els.usernameEl.getAttribute('placeholder') : null
    };
    _approvalVerifyButtonOriginal = {
        userBtnOnclick: els.userBtn ? els.userBtn.onclick : null,
        cancelBtnOnclick: els.cancelBtn ? els.cancelBtn.onclick : null
    };
}

function _restoreApprovalVerifyModalOriginalUi() {
    var els = _getApprovalVerifyModalElements();
    if (!els || !_approvalVerifyModalOriginal) return;
    if (els.titleEl && _approvalVerifyModalOriginal.titleText != null) els.titleEl.textContent = _approvalVerifyModalOriginal.titleText;
    if (els.subtitleEl && _approvalVerifyModalOriginal.subtitleText != null) els.subtitleEl.textContent = _approvalVerifyModalOriginal.subtitleText;
    if (els.usernameLabelEl && _approvalVerifyModalOriginal.usernameLabelText != null) els.usernameLabelEl.textContent = _approvalVerifyModalOriginal.usernameLabelText;
    if (els.usernameEl && _approvalVerifyModalOriginal.usernamePlaceholder != null) els.usernameEl.setAttribute('placeholder', _approvalVerifyModalOriginal.usernamePlaceholder);
    if (_approvalVerifyButtonOriginal) {
        if (els.userBtn) els.userBtn.onclick = _approvalVerifyButtonOriginal.userBtnOnclick;
        if (els.cancelBtn) els.cancelBtn.onclick = _approvalVerifyButtonOriginal.cancelBtnOnclick;
    }
}

function _setApprovalVerifyModalButtonHandlers(verifyFn, cancelFn) {
    var els = _getApprovalVerifyModalElements();
    if (!els) return;
    if (els.userBtn) els.userBtn.onclick = verifyFn;
    if (els.cancelBtn) els.cancelBtn.onclick = cancelFn;
}

function _normUserKey(v) {
    return String(v || '').trim().toLowerCase();
}

// Admin-only verification modal for starting a test run.
function openAdminApprovalVerifyModal(options) {
    return new Promise(function (resolve, reject) {
        _approvalVerifyReturnPage = (typeof getActivePageName === 'function' ? getActivePageName() : '') || 'home';
        if (typeof goToPage === 'function') goToPage('approval-verify');
        var els = _getApprovalVerifyModalElements();
        var opts = options || {};
        if (!els) {
            reject(new Error('Admin verification UI is missing.'));
            return;
        }

        _storeApprovalVerifyModalOriginalUiOnce();
        adminApprovalVerifyResolve = resolve;
        adminApprovalVerifyReject = reject;

        els.errEl.textContent = '';
        els.errEl.style.display = 'none';
        els.usernameEl.value = '';
        els.passwordEl.value = '';

        if (els.titleEl) els.titleEl.textContent = opts.titleText || 'Admin approval required';
        if (els.subtitleEl) els.subtitleEl.textContent = opts.subtitleText || 'Enter admin credentials to continue.';
        if (els.usernameLabelEl) els.usernameLabelEl.textContent = 'Admin username';
        if (els.usernameEl) els.usernameEl.setAttribute('placeholder', 'Enter admin username');

        _setApprovalVerifyModalButtonHandlers(submitAdminApprovalVerifyModal, cancelAdminApprovalVerifyModal);

        _focusInputWithOSK(els.usernameEl, 'Admin username');
    });
}

function cancelAdminApprovalVerifyModal() {
    closeApprovalVerifyModal();
    _restoreApprovalVerifyModalOriginalUi();
    if (adminApprovalVerifyResolve) {
        adminApprovalVerifyResolve(null);
        adminApprovalVerifyResolve = null;
    }
    if (adminApprovalVerifyReject) adminApprovalVerifyReject = null;
}

function submitAdminApprovalVerifyModal() {
    var els = _getApprovalVerifyModalElements();
    if (!els) return;

    var username = els.usernameEl ? String(els.usernameEl.value || '').trim() : '';
    var password = els.passwordEl ? String(els.passwordEl.value || '') : '';

    if (!username || !password) {
        els.errEl.textContent = 'Enter admin username and password.';
        els.errEl.style.display = 'block';
        return;
    }

    apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: { method: 'credentials', username: username, password: password, purpose: 'recipe' }
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            els.errEl.textContent = (data && data.error) ? String(data.error) : 'Verification failed.';
            els.errEl.style.display = 'block';
            return;
        }

        closeApprovalVerifyModal();
        _restoreApprovalVerifyModalOriginalUi();
        if (adminApprovalVerifyResolve) {
            adminApprovalVerifyResolve({
                token: String(data.token),
                username: _normUserKey(data.verifier && data.verifier.username),
                role: role
            });
            adminApprovalVerifyResolve = null;
        }
        if (adminApprovalVerifyReject) adminApprovalVerifyReject = null;
    }).catch(function (err) {
        els.errEl.textContent = 'Verification failed: ' + (err && err.message ? err.message : 'Error');
        els.errEl.style.display = 'block';
    });
}

function distributeTotalTaps(total, stepCount) {
    var t = parseInt(total, 10);
    var n = Math.max(1, parseInt(stepCount, 10) || 1);
    if (isNaN(t) || t < n) return null;
    var base = Math.floor(t / n);
    var rem = t - base * n;
    var arr = [];
    for (var i = 0; i < n; i++) {
        arr.push(base + (i < rem ? 1 : 0));
    }
    return arr;
}

function computeStandardUspTaps(stepCount) {
    var taps = [];
    var n = Math.max(1, parseInt(stepCount, 10) || 1);
    for (var i = 0; i < n; i++) {
        taps.push(i === 0 ? 10 : (i === 1 ? 500 : 1250));
    }
    return taps;
}

function computeCreateRecipeStepTapsForStepCount(stepCount) {
    var mode = getCreateUspMode();
    if (mode === 'CUSTOM') {
        var totalEl = document.getElementById('create-custom-total-taps');
        var total = totalEl ? parseInt(totalEl.value, 10) : 0;
        return distributeTotalTaps(total, stepCount);
    }
    return computeStandardUspTaps(stepCount);
}

function refreshActiveQaCount() {
    return apiRequest(API_BASE + '/api/data/members').then(function (data) {
        var list = (data && data.members) ? data.members : [];
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (String(m.role || '').toLowerCase() !== 'qa') continue;
            if (String(m.status || 'active').toLowerCase() === 'active') n++;
        }
        window._activeQaCount = n;
    }).catch(function () { window._activeQaCount = 0; });
}

function refreshActiveSupervisorCount() {
    return apiRequest(API_BASE + '/api/data/members').then(function (data) {
        var list = (data && data.members) ? data.members : [];
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (String(m.role || '').toLowerCase() !== 'supervisor') continue;
            if (String(m.status || 'active').toLowerCase() === 'active') n++;
        }
        window._activeSupervisorCount = n;
    }).catch(function () { window._activeSupervisorCount = 0; });
}

function normalizeReportUsername(u) {
    return String(u || '').trim().toLowerCase();
}

function getCurrentReportUsername() {
    var u = window.currentUser;
    if (!u) return '';
    return normalizeReportUsername(u.username || u.name || '');
}

function getReportOperatedByUsername(preview) {
    var p = preview || window._lastReportPreview || {};
    var td = p.testData || {};
    return normalizeReportUsername(p.operatedByUsername || td.operatedByUsername || td.employeeId || p.employeeId);
}

function isReportPendingApproval(preview) {
    var st = String((preview || window._lastReportPreview || {}).reportApprovalStatus || '').trim().toLowerCase();
    return st === 'pending';
}

function isReportApproved(preview) {
    var st = String((preview || window._lastReportPreview || {}).reportApprovalStatus || '').trim().toLowerCase();
    return st === 'approved';
}

function isCurrentUserReportOperator(preview) {
    var op = getReportOperatedByUsername(preview);
    var cur = getCurrentReportUsername();
    return !!(op && cur && op === cur);
}

function isReportPreviewLockedForCurrentUser(preview) {
    // Hard-lock the operator on pending test/validation/calibration reports until approved.
    // No Factory bypass: Factory can approve to unlock, but cannot navigate away unapproved.
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    if (reportTypeNorm !== 'test' && reportTypeNorm !== 'validation' && reportTypeNorm !== 'calibration') {
        return false;
    }
    if (!isReportPendingApproval(p)) return false;
    var rid = currentReportId != null ? currentReportId : (p.id != null ? p.id : null);
    var gate = window._reportApprovalGate;
    if (gate && gate.reportId != null && rid != null && String(gate.reportId) === String(rid)) {
        return true;
    }
    return isCurrentUserReportOperator(p);
}

function setReportApprovalGate(reportId, operatedByUsername) {
    if (reportId == null) {
        window._reportApprovalGate = null;
        return;
    }
    window._reportApprovalGate = {
        reportId: reportId,
        operatedByUsername: normalizeReportUsername(operatedByUsername)
    };
}

function clearReportApprovalGate() {
    window._reportApprovalGate = null;
    stopReportApprovalPoll();
}

function setReportApprovalGateFromPreview(preview, reportId) {
    if (!isReportPendingApproval(preview)) {
        clearReportApprovalGate();
        return;
    }
    var reportTypeNorm = String((preview || {}).type || 'test').trim().toLowerCase();
    var isApprovalType = reportTypeNorm === 'test' || reportTypeNorm === 'validation' ||
        reportTypeNorm === 'calibration';
    // Gate for the operator (including Factory) so exit stays blocked until approve.
    if (isApprovalType && isCurrentUserReportOperator(preview)) {
        setReportApprovalGate(reportId, getReportOperatedByUsername(preview));
        return;
    }
    // Keep an existing gate for this same pending report (finish/abort path).
    var gate = window._reportApprovalGate;
    if (gate && gate.reportId != null && reportId != null && String(gate.reportId) === String(reportId)) {
        return;
    }
    clearReportApprovalGate();
}

function stopReportApprovalPoll() {
    if (_reportApprovalPollTimerId != null) {
        clearInterval(_reportApprovalPollTimerId);
        _reportApprovalPollTimerId = null;
    }
}

function startReportApprovalPollIfLocked() {
    stopReportApprovalPoll();
    if (!isReportPreviewLockedForCurrentUser(window._lastReportPreview)) return;
    var rid = currentReportId;
    if (rid == null) return;
    _reportApprovalPollTimerId = setInterval(function () {
        if (!isReportPreviewLockedForCurrentUser(window._lastReportPreview)) {
            stopReportApprovalPoll();
            return;
        }
        apiRequest(API_BASE + '/api/reports/' + rid + '/preview').then(function (data) {
            if (!data || !data.preview) return;
            var st = String(data.preview.reportApprovalStatus || '').trim().toLowerCase();
            if (st === 'approved') {
                populateReportPreview(data.preview);
                clearReportApprovalGate();
                applyReportPreviewLockUi(data.preview);
                _saveReportPdfSilent(rid);
                showAppModal('Report has been approved. You may now print or leave this screen.', 'Report');
            }
        }).catch(function () {});
    }, 5000);
}

function setReportApproveBiometricRetryVisible(visible) {
    var btn = document.getElementById('btn-report-approve-biometric-retry');
    if (btn) btn.style.display = visible ? '' : 'none';
}

function clearReportApproveVerifyError() {
    var errEl = document.getElementById('report-approve-verify-error');
    if (!errEl) return;
    errEl.textContent = '';
    errEl.style.display = 'none';
    setReportApproveBiometricRetryVisible(false);
}

function resetReportApproveForm() {
    var ta = document.getElementById('report-approve-remarks-input');
    if (ta) ta.value = '';
    var userEl = document.getElementById('report-approve-verifier-username');
    var passEl = document.getElementById('report-approve-verifier-password');
    if (userEl) userEl.value = '';
    if (passEl) passEl.value = '';
    var passRadio = document.querySelector('input[name="report-approve-pass-fail"][value="PASS"]');
    var failRadio = document.querySelector('input[name="report-approve-pass-fail"][value="FAIL"]');
    if (passRadio) passRadio.checked = false;
    if (failRadio) failRadio.checked = false;
    clearReportApproveVerifyError();
}

function setReportApproveVerifyError(message, options) {
    options = options || {};
    var errEl = document.getElementById('report-approve-verify-error');
    if (!errEl) return;
    errEl.textContent = message ? String(message) : '';
    errEl.style.display = message ? 'block' : 'none';
    if (options.showBiometricRetry) {
        setReportApproveBiometricRetryVisible(true);
    }
}

function wireReportApproveVerifierListeners() {
    if (window._reportApproveVerifierListenersWired) return;
    window._reportApproveVerifierListenersWired = true;
    var userEl = document.getElementById('report-approve-verifier-username');
    if (!userEl) return;
    userEl.addEventListener('input', function () {
        setReportApprovePanelInteractionState(window._lastReportPreview);
    });
}

function setReportApprovePanelInteractionState(preview) {
    var apprPanel = document.getElementById('report-approve-panel');
    if (!apprPanel) return;
    wireReportApproveVerifierListeners();
    var pending = isReportPendingApproval(preview);
    var isOp = isCurrentUserReportOperator(preview);
    var isFactory = typeof isFactorySessionUser === 'function' && isFactorySessionUser();
    var fieldsEnabled = !!pending;
    var usernameEl = document.getElementById('report-approve-verifier-username');
    var entered = usernameEl && typeof normalizeReportUsername === 'function'
        ? normalizeReportUsername(usernameEl.value)
        : (usernameEl ? String(usernameEl.value || '').trim().toLowerCase() : '');
    var opUser = typeof getReportOperatedByUsername === 'function'
        ? getReportOperatedByUsername(preview) : '';
    var canCredentialSubmit = fieldsEnabled && (!isOp || isFactory || (entered && opUser && entered !== opUser));
    apprPanel.classList.toggle('is-operator-view', !!(pending && isOp && !isFactory));
    var hintEl = document.getElementById('report-approve-operator-hint');
    if (hintEl) hintEl.style.display = (pending && isOp && !isFactory) ? 'block' : 'none';
    ['#report-approve-remarks-input', 'input[name="report-approve-pass-fail"]',
        '#report-approve-verifier-username', '#report-approve-verifier-password'].forEach(function (sel) {
        apprPanel.querySelectorAll(sel).forEach(function (el) { el.disabled = !fieldsEnabled; });
    });
    var submitBtn = document.getElementById('btn-report-approve-submit');
    if (submitBtn) submitBtn.disabled = !canCredentialSubmit;
    var bioBtn = document.getElementById('btn-report-approve-biometric');
    if (bioBtn) bioBtn.disabled = !fieldsEnabled;
    apprPanel.querySelectorAll('.report-approve-card-wrap').forEach(function (wrap) {
        if (fieldsEnabled) wrap.classList.remove('is-disabled');
        else wrap.classList.add('is-disabled');
    });
}

function updateReportApprovePanelForPreview(preview) {
    var apprPanel = document.getElementById('report-approve-panel');
    if (!apprPanel) return;
    var pending = isReportPendingApproval(preview);
    var rid = currentReportId;
    if (pending && rid != null && rid !== window._reportApproveFormReportId) {
        resetReportApproveForm();
        window._reportApproveFormReportId = rid;
    }
    if (!pending) {
        window._reportApproveFormReportId = null;
    }
    var reportTypeNorm = String((preview || {}).type || 'test').trim().toLowerCase();
    var titleEl = document.getElementById('report-approve-panel-title') || apprPanel.querySelector('h3');
    if (titleEl) {
        if (reportTypeNorm === 'validation') titleEl.textContent = 'Validation report approval';
        else if (reportTypeNorm === 'calibration') titleEl.textContent = 'Calibration report approval';
        else titleEl.textContent = 'Test report approval';
    }
    apprPanel.style.display = pending ? 'block' : 'none';
    if (!pending) clearReportApproveVerifyError();
    setReportApprovePanelInteractionState(preview);
    var bioBtn = document.getElementById('btn-report-approve-biometric');
    var bioWrap = document.getElementById('report-approve-biometric-wrap');
    var showBio = typeof biometricEnabledSetting === 'undefined' || biometricEnabledSetting;
    if (bioBtn) bioBtn.style.display = showBio ? '' : 'none';
    if (bioWrap) bioWrap.style.display = showBio ? '' : 'none';
}

function scrollReportApprovePanelIntoView() {
    var panel = document.getElementById('report-approve-panel');
    if (!panel || panel.style.display === 'none') return;
    try {
        panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
        panel.scrollIntoView(true);
    }
}

function scrollReportPendingBannerIntoView() {
    var banner = document.getElementById('report-pending-lock-banner');
    if (!banner || banner.style.display === 'none') return;
    try {
        banner.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
        banner.scrollIntoView(true);
    }
}

function applyReportPreviewLockUi(preview) {
    preview = preview || window._lastReportPreview;
    var locked = isReportPreviewLockedForCurrentUser(preview);
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('report-approval-locked', !!locked);
    var banner = document.getElementById('report-pending-lock-banner');
    if (banner) banner.style.display = locked ? 'block' : 'none';
    var closeBtn = document.querySelector('#report-preview-actions .btn-close');
    if (closeBtn) closeBtn.style.display = locked ? 'none' : '';
    var backBtn = document.getElementById('header-back-btn');
    if (backBtn) backBtn.style.visibility = locked ? 'hidden' : '';
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.style.pointerEvents = locked ? 'none' : '';
        btn.style.opacity = locked ? '0.45' : '';
    });
    var profileEl = document.querySelector('.sidebar .user-profile');
    var logoutBtn = document.querySelector('.sidebar .logout-btn');
    [profileEl, logoutBtn].forEach(function (el) {
        if (!el) return;
        el.style.pointerEvents = locked ? 'none' : '';
        el.style.opacity = locked ? '0.45' : '';
        if (locked) el.setAttribute('aria-disabled', 'true');
        else el.removeAttribute('aria-disabled');
    });
    updateReportApprovePanelForPreview(preview);
    updateReportPreviewPrintExportButtons(preview);
}

function stampOperatorOnTestReportPayload(payload) {
    if (!payload) return payload;
    var u = window.currentUser || {};
    var un = normalizeReportUsername(u.username || u.name || '');
    var name = String(u.name || u.username || '—').trim();
    var emp = String(u.username || un || '').trim();
    payload.operatedByUsername = un;
    payload.operatorName = name;
    payload.employeeId = emp;
    payload.testData = payload.testData || {};
    payload.testData.operatedByUsername = un;
    payload.testData.operatorName = name;
    payload.testData.employeeId = emp;
    return payload;
}

function abortPendingReportOnLogout() {
    // Pending approval reports must not be cleared on logout; logout is blocked while locked.
    var gate = window._reportApprovalGate;
    if (!gate || gate.reportId == null) return Promise.resolve();
    return Promise.resolve();
}

/** Close / leave report preview only when not hard-locked for approval. */
function leaveReportPreviewIfAllowed() {
    if (typeof isReportPreviewLockedForCurrentUser === 'function' &&
        isReportPreviewLockedForCurrentUser(window._lastReportPreview)) {
        showAppModal(
            'This report is awaiting approval. You must stay on the report screen until a reviewer approves it.',
            'Report'
        );
        return;
    }
    goToPage('reports');
}

/** Always open preview and apply pending approval gate when applicable. */
function openPendingReportPreview(reportId) {
    if (reportId == null) return;
    openReportPreview(reportId, { setGate: true });
}

function finishTestRunReportSaved(reportId) {
    if (typeof resetQuickTestFormAfterRunIfPending === 'function') resetQuickTestFormAfterRunIfPending();
    if (reportId) {
        openPendingReportPreview(reportId);
    } else {
        goToPage('reports');
        if (typeof loadReports === 'function') loadReports();
    }
}

function denyPermission(actionLabel) {
    showAppModal(
        'You do not have permission to ' + (actionLabel || 'perform this action') + '.',
        'Permission'
    );
}

function userCanRunValidation(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return typeof canAccess === 'function' && canAccess(u, 'validation-test');
}

function userCanApproveByQaRule() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var hasQa = typeof window._activeQaCount === 'number' ? window._activeQaCount >= 1 : false;
    if (hasQa) return role === 'qa';
    return role === 'admin';
}

/** Test reports: Reviewer (supervisor) or Admin may approve; QA may not. */
function userCanApproveTestReport() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    return role === 'admin' || role === 'supervisor';
}

/** Recipe approval modal copy; server allows QA only when QA exists, else Admin only. */
function _approvalVerifyModalOptionsForRecipe() {
    var hasQa = typeof window._activeQaCount === 'number' && window._activeQaCount >= 1;
    if (hasQa) return { purpose: 'recipe' };
    return {
        purpose: 'recipe',
        titleText: 'Admin approval required',
        subtitleText: 'No active QA users. An admin must verify to continue.',
        usernameLabelText: 'Admin username',
        usernamePlaceholder: 'Enter admin username',
        emptyCredentialsMessage: 'Enter admin username and password.'
    };
}

/** Test report approval: Reviewer (Supervisor) or Admin verifier; not QA. */
function _approvalVerifyModalOptionsForReport() {
    return {
        purpose: 'report',
        titleText: 'Test report approval',
        subtitleText: 'Enter Reviewer or Admin credentials to approve this test.',
        usernameLabelText: 'Username',
        usernamePlaceholder: 'Reviewer or Admin username',
        emptyCredentialsMessage: 'Enter username and password.'
    };
}

function getEffectiveRecipeApprovalStatus(recipe) {
    if (!recipe) return 'approved';
    var st = recipe.recipeApprovalStatus;
    if (st == null || st === '') return 'approved';
    return st;
}

function getCreateUspMode() {
    var r = document.querySelector('input[name="create-usp-mode"]:checked');
    if (!r) return 'USP';
    var v = String(r.value || '').toUpperCase();
    if (v === 'CUSTOM') return 'CUSTOM';
    return 'USP';
}

function applyCreateUspModeToSpeedHeight() {
    if (typeof applyRecipeModeToFields === 'function') applyRecipeModeToFields();
}

var PAGE_TITLES = {
    'home': 'Dissolution Tester',
    'create-recipe-step1': 'Create Recipe',
    'create-recipe-step2': 'Configure Steps',
    'create-recipe-step3': 'Cylinder Size',
    'manage-recipes': null,
    'manage-members': 'Manage Profiles',
    'load-validation': 'Validation',
    'distance-validation': 'Validation',
    'add-member': 'Add New Member',
    'validate': 'Validation',
    'validate-type-select': 'Select Validation Type',
    'temperature-validation': null,
    'temperature-validation-result': 'Test Data',
    'rpm-validation': null,
    'rpm-validation-result': 'Test Data',
    'physical-parameters': null,
    'sample-volume-validation': null,
    'sample-volume-validation-result': 'Test Data',
    'validation-suite-review': 'Save Validation',
    'system-settings': 'Test Settings',
    'wakeup-schedule': 'Wakeup Schedule',
    'ip-config': 'IP Config',
    'ip-config-result': 'IP Config',
    'calibration': 'Calibration',
    'calibration-type-select': 'Select Calibration Type',
    'load-calibration': 'Load Calibration',
    'distance-zero-calibration': 'Distance Calibration',
    'settings': 'Settings',
    'system-info': 'System Info',
    'cleaning-cycle': 'Cleaning Cycle',
    'hardware-init': 'Hardware Initialise',
    'heater-control': 'Heater',
    'datetime': 'Date and Time',
    'factory-settings': 'Factory Settings',
    'reports': 'Reports',
    'export': 'Export',
    'report-preview': 'Report Preview',
    'user-profile': 'User Profile',
    'view-recipes': 'View Recipe',
    'recipe-print-preview': 'Recipe Print',
    'validation-run': 'Validation',
    'quick-test': 'Quick Test',
    'test-run': 'Dissolution Test',
    'vessel-temperature': 'Vessel Temperature',
    'shaft-position': 'Shaft Position'
};

async function fetchDateTimeFromBackend() {
    try {
        var r = await fetch((API_BASE || '') + '/api/get_datetime');
        if (r.ok) {
            var data = await r.json();
            if (data && (data.datetime || data.date)) return data;
        }
    } catch (e) {}
    return null;
}

function updateDateTime() {
    fetchDateTimeFromBackend().then(function (data) {
        var timeString = '--:--:--';
        var dateString = '--/--/----';
        if (data && data.datetime) {
            var dt = new Date(data.datetime.replace('Z', ''));
            if (!isNaN(dt.getTime())) {
                var d = dt.getDate();
                var m = dt.getMonth() + 1;
                var y = dt.getFullYear();
                var h = dt.getHours();
                var min = String(dt.getMinutes()).padStart(2, '0');
                var sec = String(dt.getSeconds()).padStart(2, '0');
                dateString = String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y;
                timeString = String(h).padStart(2, '0') + ':' + min + ':' + sec;
                lastKnownDateTime = { timeString: timeString, dateString: dateString };
            }
        } else if (data && data.date && data.time) {
            dateString = (data.date || '').replace(/-/g, '/');
            timeString = (data.time || '--:--').split(':').slice(0, 2).join(':');
            if (data.time && data.time.split(':').length >= 3) timeString = data.time;
            else timeString = timeString + ':00';
            lastKnownDateTime = { timeString: timeString, dateString: dateString };
        } else if (lastKnownDateTime) {
            timeString = lastKnownDateTime.timeString;
            dateString = lastKnownDateTime.dateString;
        }
        var timeEl = document.getElementById('current-time');
        var dateEl = document.getElementById('current-date');
        if (timeEl) timeEl.textContent = timeString;
        if (dateEl) dateEl.textContent = dateString;
    });
}

function getDisplayedKioskDateTimeIso() {
    var dateText = '';
    var timeText = '';
    var dateEl = document.getElementById('current-date');
    var timeEl = document.getElementById('current-time');
    if (dateEl) dateText = String(dateEl.textContent || '').trim();
    if (timeEl) timeText = String(timeEl.textContent || '').trim();
    if ((!dateText || dateText.indexOf('--') >= 0) && lastKnownDateTime) {
        dateText = lastKnownDateTime.dateString || '';
    }
    if ((!timeText || timeText.indexOf('--') >= 0) && lastKnownDateTime) {
        timeText = lastKnownDateTime.timeString || '';
    }
    var parts = dateText.split(/[\/-]/);
    if (parts.length !== 3 || !timeText || timeText.indexOf('--') >= 0) {
        return new Date().toISOString();
    }
    var dd;
    var mm;
    var yyyy;
    if (parts[0].length === 4) {
        yyyy = parts[0];
        mm = parts[1].padStart(2, '0');
        dd = parts[2].padStart(2, '0');
    } else {
        dd = parts[0].padStart(2, '0');
        mm = parts[1].padStart(2, '0');
        yyyy = parts[2];
    }
    if (yyyy.length !== 4) {
        return new Date().toISOString();
    }
    var timeParts = timeText.split(':');
    var hh = (timeParts[0] || '00').padStart(2, '0');
    var mi = (timeParts[1] || '00').padStart(2, '0');
    var ss = (timeParts[2] || '00').padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd + 'T' + hh + ':' + mi + ':' + ss;
}

function subtractSecondsFromIso(iso, seconds) {
    var dt = new Date(String(iso || '').replace('Z', ''));
    if (isNaN(dt.getTime())) return iso;
    dt.setSeconds(dt.getSeconds() - (parseInt(seconds, 10) || 0));
    var y = dt.getFullYear();
    var m = String(dt.getMonth() + 1).padStart(2, '0');
    var d = String(dt.getDate()).padStart(2, '0');
    var h = String(dt.getHours()).padStart(2, '0');
    var mi = String(dt.getMinutes()).padStart(2, '0');
    var s = String(dt.getSeconds()).padStart(2, '0');
    return y + '-' + m + '-' + d + 'T' + h + ':' + mi + ':' + s;
}

/** Minutes (0 = off). Updated from factory settings API / localStorage. */
var factoryAutoLogoutMinutes = 0;
var _autoLogoutLastActivityMs = 0;
var _autoLogoutIntervalId = null;
var _autoLogoutListenersAttached = false;

function applyFactoryAutoLogoutSetting(settings) {
    var raw = settings && settings.autoLogoutMinutes != null ? settings.autoLogoutMinutes : 0;
    var m = parseInt(raw, 10);
    if (isNaN(m)) m = 0;
    m = Math.max(0, Math.min(10080, m));
    factoryAutoLogoutMinutes = m;
    if (m < 1) {
        stopAutoLogoutWatcher();
    } else {
        markAutoLogoutActivity();
        if (window.currentUser && (window.currentUser.username || window.currentUser.name)) {
            ensureAutoLogoutWatcher();
        }
    }
}

function markAutoLogoutActivity() {
    _autoLogoutLastActivityMs = Date.now();
}

function isAutoLogoutRunBlocked() {
    return (typeof isTestRunActive === 'function' && isTestRunActive()) ||
        (validationRunState === 'running') ||
        (validationRunBackendPending === true);
}

function ensureAutoLogoutListeners() {
    if (_autoLogoutListenersAttached) return;
    _autoLogoutListenersAttached = true;
    var opts = { capture: true, passive: true };
    ['pointerdown', 'touchstart', 'click', 'keydown', 'wheel'].forEach(function (ev) {
        document.addEventListener(ev, markAutoLogoutActivity, opts);
    });
}

function stopAutoLogoutWatcher() {
    if (_autoLogoutIntervalId != null) {
        clearInterval(_autoLogoutIntervalId);
        _autoLogoutIntervalId = null;
    }
}

function ensureAutoLogoutWatcher() {
    ensureAutoLogoutListeners();
    if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) return;
    if (factoryAutoLogoutMinutes < 1) return;
    markAutoLogoutActivity();
    if (_autoLogoutIntervalId != null) return;
    _autoLogoutIntervalId = setInterval(autoLogoutTick, 10000);
}

function autoLogoutTick() {
    if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) {
        stopAutoLogoutWatcher();
        return;
    }
    var app = document.querySelector('.app-container');
    if (!app || app.style.display === 'none') return;
    if (isAutoLogoutRunBlocked()) {
        markAutoLogoutActivity();
        return;
    }
    if (factoryAutoLogoutMinutes < 1) return;
    var limitMs = factoryAutoLogoutMinutes * 60000;
    if (Date.now() - _autoLogoutLastActivityMs >= limitMs) {
        stopAutoLogoutWatcher();
        performAutoLogoutDueToInactivity();
    }
}

function performAutoLogoutDueToInactivity() {
    var pendingLocked = (typeof isReportPreviewLockedForCurrentUser === 'function' &&
        isReportPreviewLockedForCurrentUser(window._lastReportPreview)) ||
        (window._reportApprovalGate && window._reportApprovalGate.reportId != null);
    var finish = function () {
        auditExitActiveScreenBeforeSessionEnd()
            .then(flushAuditEventQueue)
            .then(function () {
                return apiRequest(API_BASE + '/api/data/auth/logout', { method: 'POST', body: { reason: 'inactivity' } });
            })
            .catch(function () {})
            .finally(function () {
                window.currentUser = null;
                try { localStorage.removeItem('currentUser'); } catch (e) {}
                if (typeof currentUser !== 'undefined') currentUser = null;
                if (typeof window._reportApprovalGate !== 'undefined') window._reportApprovalGate = null;
                showLoginScreen();
                setTimeout(function () {
                    showAppModal('You were logged out due to inactivity.', 'Session');
                }, 200);
            });
    };
    if (pendingLocked) {
        markAutoLogoutActivity();
        return;
    }
    if (typeof isTestRunActive === 'function' && isTestRunActive() && typeof _trDoStop === 'function') {
        _trDoStop();
        setTimeout(finish, 500);
        return;
    }
    finish();
}

function showLoginScreen() {
    _auditActivePage = null;
    _auditViewLogPending = false;
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    if (app) app.style.display = 'none';
    if (login) login.style.display = 'flex';
    stopAutoLogoutWatcher();
    resetLoginFormFields();
    if (typeof loadLoginFactorySettingsDisplay === 'function') loadLoginFactorySettingsDisplay();
}

function resetLoginFormFields() {
    var loginUid = document.getElementById('login-uid');
    var loginPwd = document.getElementById('login-pwd');
    if (loginUid) loginUid.value = '';
    if (loginPwd) loginPwd.value = '';
}

function showAppContainer() {
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    if (login) login.style.display = 'none';
    if (app) app.style.display = 'flex';
    updateDateTime();
    if (!dateTimeClockInterval) {
        dateTimeClockInterval = setInterval(updateDateTime, 1000);
    }
    setTimeout(function () {
        if (typeof refreshShellAccessVisibility === 'function') refreshShellAccessVisibility();
    }, 0);
    if (window.currentUser && (window.currentUser.username || window.currentUser.name)) {
        ensureAutoLogoutWatcher();
    }
}

function completeSuccessfulLogin(user) {
    window.currentUser = user;
    try { localStorage.setItem('currentUser', JSON.stringify(user)); } catch (e) {}
    if (typeof currentUser !== 'undefined') currentUser = user;
    _auditViewLogPending = false;
    ensureHardwareStream();
    updateProfileFromCurrentUser(user);
    if (typeof refreshAuditUiAfterAuth === 'function') refreshAuditUiAfterAuth();
    showAppContainer();
    if (typeof refreshActiveQaCount === 'function') refreshActiveQaCount();
    var goHome = function () { goToPage('home'); };
    if (typeof window.dissoAfterLoginCheck === 'function') {
        window.dissoAfterLoginCheck().then(function (hasActive) {
            if (!hasActive) goHome();
        }).catch(goHome);
    } else {
        goHome();
    }
}

function showPasswordExpiredResetScreen(username, oldPassword) {
    window._passwordResetScreenMode = 'expired';
    window._mandatoryPasswordResetPending = false;
    var titleEl = document.getElementById('password-reset-page-title');
    var subEl = document.getElementById('password-reset-page-subtitle');
    if (titleEl) titleEl.textContent = 'Reset Expired Password';
    if (subEl) subEl.textContent = 'Your password has expired. Set a new password to continue.';
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (login) login.style.display = 'none';
    if (sidebar) {
        sidebar.setAttribute('data-prev-display', sidebar.style.display || '');
        sidebar.style.display = 'none';
    }
    if (header) {
        header.setAttribute('data-prev-display', header.style.display || '');
        header.style.display = 'none';
    }
    if (app) app.style.display = 'flex';
    goToPage('password-expired-reset');
    setTimeout(function () {
        var userEl = document.getElementById('expired-reset-username');
        var oldEl = document.getElementById('expired-reset-old-password');
        var newEl = document.getElementById('expired-reset-new-password');
        var confEl = document.getElementById('expired-reset-confirm-password');
        if (userEl) userEl.value = username || '';
        if (oldEl) oldEl.value = oldPassword || '';
        if (newEl) { newEl.value = ''; }
        if (confEl) { confEl.value = ''; }
        if (newEl && typeof newEl.focus === 'function') newEl.focus();
    }, 60);
}

function showMandatoryPasswordResetScreen(username) {
    window._passwordResetScreenMode = 'mandatory';
    window._mandatoryPasswordResetPending = true;
    var titleEl = document.getElementById('password-reset-page-title');
    var subEl = document.getElementById('password-reset-page-subtitle');
    if (titleEl) titleEl.textContent = 'Reset your password';
    if (subEl) {
        subEl.textContent = 'Your account was created with a temporary password. Choose a new password that only you know before you can use the app.';
    }
    var login = document.getElementById('page-login');
    var app = document.querySelector('.app-container');
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (login) login.style.display = 'none';
    if (sidebar) {
        sidebar.setAttribute('data-prev-display', sidebar.style.display || '');
        sidebar.style.display = 'none';
    }
    if (header) {
        header.setAttribute('data-prev-display', header.style.display || '');
        header.style.display = 'none';
    }
    if (app) app.style.display = 'flex';
    goToPage('password-expired-reset');
    setTimeout(function () {
        var userEl = document.getElementById('expired-reset-username');
        var oldEl = document.getElementById('expired-reset-old-password');
        var newEl = document.getElementById('expired-reset-new-password');
        var confEl = document.getElementById('expired-reset-confirm-password');
        if (userEl) userEl.value = username || '';
        if (oldEl) oldEl.value = '';
        if (newEl) { newEl.value = ''; }
        if (confEl) { confEl.value = ''; }
        if (oldEl && typeof oldEl.focus === 'function') oldEl.focus();
    }, 60);
}

function _restoreSidebarAndHeaderAfterExpiredReset() {
    var sidebar = document.querySelector('.app-container .sidebar');
    var header = document.querySelector('.app-container .app-header');
    if (sidebar) {
        var prev = sidebar.getAttribute('data-prev-display');
        sidebar.style.display = prev != null ? prev : '';
        sidebar.removeAttribute('data-prev-display');
    }
    if (header) {
        var prevH = header.getAttribute('data-prev-display');
        header.style.display = prevH != null ? prevH : '';
        header.removeAttribute('data-prev-display');
    }
}

function submitPasswordResetFromLoginPage() {
    if (window._passwordResetScreenMode === 'mandatory') {
        submitMandatoryPasswordReset();
    } else {
        submitExpiredPasswordReset();
    }
}

function submitMandatoryPasswordReset() {
    var userEl = document.getElementById('expired-reset-username');
    var oldEl = document.getElementById('expired-reset-old-password');
    var newEl = document.getElementById('expired-reset-new-password');
    var confEl = document.getElementById('expired-reset-confirm-password');
    var username = userEl ? String(userEl.value || '').trim() : '';
    var oldPassword = oldEl ? String(oldEl.value || '') : '';
    var newPassword = newEl ? String(newEl.value || '') : '';
    var confirmPassword = confEl ? String(confEl.value || '') : '';

    if (!username || !oldPassword || !newPassword || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Reset Password');
        return;
    }
    if (newPassword !== confirmPassword) {
        showAppModal('New Password and Confirm Password do not match.', 'Reset Password');
        return;
    }
    if (oldPassword === newPassword) {
        showAppModal('New password must be different from your current password.', 'Reset Password');
        return;
    }
    var passwordError = getStrongPasswordError(newPassword);
    if (passwordError) {
        showAppModal(passwordError, 'Reset Password');
        return;
    }

    fetch((API_BASE || '') + '/api/data/auth/mandatory-password-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, oldPassword: oldPassword, newPassword: newPassword })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('json') !== -1) {
            return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        }
        return res.text().then(function (text) { return { ok: res.ok, status: res.status, body: { error: text } }; });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.ok && data.user) {
            window._mandatoryPasswordResetPending = false;
            window._passwordResetScreenMode = 'expired';
            _restoreSidebarAndHeaderAfterExpiredReset();
            completeSuccessfulLogin(data.user);
            return;
        }
        var msg = (data && data.error) ? String(data.error) : ('Password reset failed (HTTP ' + result.status + ').');
        showAppModal(msg, 'Reset Password');
    }).catch(function (err) {
        showAppModal('Password reset failed: ' + (err && err.message ? err.message : 'Network error'), 'Reset Password');
    });
}

function submitExpiredPasswordReset() {
    var userEl = document.getElementById('expired-reset-username');
    var oldEl = document.getElementById('expired-reset-old-password');
    var newEl = document.getElementById('expired-reset-new-password');
    var confEl = document.getElementById('expired-reset-confirm-password');
    var username = userEl ? String(userEl.value || '').trim() : '';
    var oldPassword = oldEl ? String(oldEl.value || '') : '';
    var newPassword = newEl ? String(newEl.value || '') : '';
    var confirmPassword = confEl ? String(confEl.value || '') : '';

    if (!username || !oldPassword || !newPassword || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Reset Password');
        return;
    }
    if (newPassword !== confirmPassword) {
        showAppModal('New Password and Confirm Password do not match.', 'Reset Password');
        return;
    }
    if (oldPassword === newPassword) {
        showAppModal('New password must be different from your current password.', 'Reset Password');
        return;
    }
    var passwordError = getStrongPasswordError(newPassword);
    if (passwordError) {
        showAppModal(passwordError, 'Reset Password');
        return;
    }

    fetch((API_BASE || '') + '/api/data/auth/password-expired-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, oldPassword: oldPassword, newPassword: newPassword })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (ct.indexOf('json') !== -1) {
            return res.json().then(function (body) { return { ok: res.ok, status: res.status, body: body }; });
        }
        return res.text().then(function (text) { return { ok: res.ok, status: res.status, body: { error: text } }; });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.ok) {
            _restoreSidebarAndHeaderAfterExpiredReset();
            showLoginScreen();
            var loginUid = document.getElementById('login-uid');
            var loginPwd = document.getElementById('login-pwd');
            if (loginUid) loginUid.value = username;
            if (loginPwd) loginPwd.value = '';
            showAppModal('Password updated. Please log in with your new password.', 'Reset Password');
            return;
        }
        var msg = (data && data.error) ? String(data.error) : ('Password reset failed (HTTP ' + result.status + ').');
        showAppModal(msg, 'Reset Password');
    }).catch(function (err) {
        showAppModal('Password reset failed: ' + (err && err.message ? err.message : 'Network error'), 'Reset Password');
    });
}

function getStrongPasswordError(password) {
    var pwd = String(password || '');
    if (
        pwd.length >= 8 &&
        /[A-Z]/.test(pwd) &&
        /[a-z]/.test(pwd) &&
        /[0-9]/.test(pwd) &&
        /[^A-Za-z0-9]/.test(pwd)
    ) {
        return '';
    }
    return (
        'Password must meet all of the following:\n\n' +
        '• At least 8 characters long.\n' +
        '• At least one uppercase letter (A–Z).\n' +
        '• At least one lowercase letter (a–z).\n' +
        '• At least one number (0–9).\n' +
        '• At least one symbol (not only letters and digits).\n\n' +
        'Update your password to satisfy every item, then try again.'
    );
}





function updateSettingsVisibility() {
    var u = window.currentUser;
    var role = typeof getCurrentRole === 'function' ? getCurrentRole() : null;

    function canSee(feature) {
        if (u && typeof canAccess === 'function') return canAccess(u, feature);
        if (typeof canAccess === 'function' && role) return canAccess(role, feature);
        return role === 'factory' || role === 'admin';
    }

    var cardFeatures = [
        ['.settings-system', 'system-settings'],
        ['.settings-wakeup', 'wakeup-schedule'],
        ['.settings-cleaning', 'cleaning-cycle'],
    ];
    cardFeatures.forEach(function (pair) {
        var card = document.querySelector(pair[0]);
        if (card) card.style.display = canSee(pair[1]) ? '' : 'none';
    });

    var disableCard = document.querySelector('.settings-disable');
    if (disableCard) {
        disableCard.style.display = canSee('disable-recipes') ? '' : 'none';
    }
    var factoryCard = document.querySelector('.settings-factory');
    if (factoryCard) {
        factoryCard.style.display = String(role || '').toLowerCase() === 'factory' ? '' : 'none';
    }
}

/** Hide sidebar / home tiles the current user cannot access (RBAC). */
function refreshShellAccessVisibility() {
    var u = window.currentUser;
    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        var page = btn.getAttribute('data-page');
        var feat = btn.getAttribute('data-rbac-nav');
        if (!feat && typeof SCREEN_FEATURE_MAP !== 'undefined' && SCREEN_FEATURE_MAP[page]) {
            feat = SCREEN_FEATURE_MAP[page];
        }
        if (!feat) feat = page;
        var ok = true;
        if (page === 'home') {
            ok = true;
        } else if (u && typeof canAccess === 'function') {
            ok = canAccess(u, feat);
        } else if (!u) {
            ok = false;
        }
        btn.style.display = ok ? '' : 'none';
    });
    document.querySelectorAll('.test-card[data-rbac-nav]').forEach(function (el) {
        var feat = el.getAttribute('data-rbac-nav');
        var ok = u && typeof canAccess === 'function' && feat ? canAccess(u, feat) : false;
        el.style.display = ok ? '' : 'none';
    });
    var mp = document.querySelector('.profile-actions button[onclick*="manage-members"]');
    var am = document.querySelector('.profile-actions button[onclick*="openAddMember"]');
    if (mp) mp.style.display = u && typeof canAccess === 'function' && canAccess(u, 'user-manage') ? '' : 'none';
    if (am) am.style.display = u && typeof canAccess === 'function' && canAccess(u, 'user-add') ? '' : 'none';
    if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
    if (typeof initAuditReportsVisibility === 'function') initAuditReportsVisibility();
    if (typeof updateSettingsVisibility === 'function') updateSettingsVisibility();
}


function goToPage(pageName) {
    var prevPage = getActivePageName();
    if (prevPage === 'temperature-validation' && pageName !== 'temperature-validation' &&
        typeof stopTemperatureValidationLive === 'function') {
        stopTemperatureValidationLive();
    }
    if (prevPage === 'rpm-validation' && pageName !== 'rpm-validation' &&
        typeof stopRpmValidationLive === 'function') {
        stopRpmValidationLive();
    }
    if (prevPage === 'rpm-validation' && pageName !== 'rpm-validation' &&
        typeof _rpmValClearShaftTimers === 'function') {
        _rpmValClearShaftTimers();
    }
    if (prevPage === 'test-run' && pageName !== 'test-run' && pageName !== 'vessel-temperature' && pageName !== 'shaft-position' &&
        typeof cleanupDissolutionTestOnLeave === 'function' &&
        !(typeof isDissolutionTestActive === 'function' && isDissolutionTestActive()) &&
        !(typeof hasReturnableDissolutionSession === 'function' && hasReturnableDissolutionSession())) {
        cleanupDissolutionTestOnLeave();
    }
    if (prevPage === 'hardware-init' && pageName !== 'hardware-init' &&
        typeof cleanupHardwareInitOnLeave === 'function') {
        cleanupHardwareInitOnLeave();
    }
    if (prevPage === 'heater-control' && pageName !== 'heater-control' &&
        typeof cleanupHeaterControlOnLeave === 'function') {
        cleanupHeaterControlOnLeave();
    }
    if (prevPage === 'system-info' && pageName !== 'system-info' && pageName !== 'vessel-temperature') {
        if (typeof window.dissoDisarmAutoTemp === 'function') {
            window.dissoDisarmAutoTemp('leave-system-info');
        }
    }
    if (prevPage === 'vessel-temperature' && pageName !== 'vessel-temperature' && pageName !== 'test-run' && pageName !== 'system-info') {
        if (typeof window.dissoDisarmAutoTemp === 'function') {
            window.dissoDisarmAutoTemp('leave-vessel-temperature');
        }
    }
    if (prevPage === 'calibration' && pageName !== 'calibration' &&
        typeof stopTemperatureCalibrationLive === 'function') {
        stopTemperatureCalibrationLive();
    }
    if (!_suppressValidationRunNavGuardOnce && typeof isValidationNavigationBlocked === 'function' &&
        isValidationNavigationBlocked() && pageName !== 'validation-run') {
        confirmAbortValidationForNavigation().then(function (didAbort) {
            if (!didAbort) return;
            _suppressValidationRunNavGuardOnce = true;
            goToPage(pageName);
        });
        return;
    }
    if (!_suppressTestRunNavGuardOnce && typeof isDissolutionTestActive === 'function' && isDissolutionTestActive()) {
        if (pageName !== 'vessel-temperature' && pageName !== 'shaft-position' && pageName !== 'test-run') {
            _dtConfirmAbortForNavigation().then(function (didAbort) {
                if (!didAbort) return;
                _suppressTestRunNavGuardOnce = true;
                goToPage(pageName);
            });
            return;
        }
    }
    if (!_suppressValidationSuiteNavGuardOnce && typeof isValidationSuiteActive === 'function' &&
        isValidationSuiteActive() && !isValidationSuiteNavAllowed(pageName)) {
        _confirmAbortValidationSuiteForNavigation().then(function (didAbort) {
            if (!didAbort) return;
            _suppressValidationSuiteNavGuardOnce = true;
            goToPage(pageName);
        });
        return;
    }
    if (!_suppressCalibrationNavGuardOnce && typeof isTemperatureCalibrationActive === 'function' &&
        isTemperatureCalibrationActive() && pageName !== 'calibration' && pageName !== 'report-preview') {
        showConfirmModal(
            'Do you want to abort calibration? Progress will be saved as an aborted report and requires approval.',
            'Abort Calibration',
            { okLabel: 'Abort' }
        ).then(function (ok) {
            if (!ok) return;
            Promise.resolve(
                typeof abortTemperatureCalibrationHold === 'function'
                    ? abortTemperatureCalibrationHold({ reason: 'navigation leave' })
                    : null
            ).then(function () {
                // Locked preview opened by abort — do not continue to destination.
            });
        });
        return;
    }
    _suppressTestRunNavGuardOnce = false;
    _suppressValidationRunNavGuardOnce = false;
    _suppressValidationSuiteNavGuardOnce = false;
    _suppressCalibrationNavGuardOnce = false;
    if (pageName !== 'report-preview' && typeof isReportPreviewLockedForCurrentUser === 'function' &&
        isReportPreviewLockedForCurrentUser(window._lastReportPreview)) {
        showAppModal('This report is awaiting approval. You must stay on the report screen until a reviewer approves it.', 'Report');
        var active = document.querySelector('.page.active');
        if (!active || active.id !== 'page-report-preview') {
            var rid = currentReportId || (window._reportApprovalGate && window._reportApprovalGate.reportId);
            if (rid) openReportPreview(rid);
        }
        return;
    }
    if (window._mandatoryPasswordResetPending && pageName !== 'password-expired-reset') {
        showAppModal('Please reset your password to continue.', 'Reset Password');
        return;
    }
    if (pageName === 'factory-settings') {
        var role = (typeof getCurrentRole === 'function') ? getCurrentRole() : null;
        if (String(role || '').toLowerCase() !== 'factory') {
            showAppModal('Only Factory user can access Factory Settings.', 'Permission');
            pageName = 'settings';
        }
    }
    // Dissolution: keep Validation / Calibration landing; block old Friability run flows
    if (pageName === 'validation-run' ||
        pageName === 'calibration-type-select' || pageName === 'calibration-load' ||
        pageName === 'calibration-distance' || pageName === 'load-calibration' ||
        pageName === 'distance-zero-calibration') {
        showAppModal('Friability validation and calibration are not part of Dissolution Tester.', 'Unavailable');
        pageName = 'home';
    }
    if (pageName !== 'login' && pageName !== 'password-expired-reset') {
        if (!window.currentUser || !(window.currentUser.username || window.currentUser.name)) {
            showAppModal('Please log in.', 'Session');
            if (typeof showLoginScreen === 'function') showLoginScreen();
            return;
        }
        if (typeof checkNavigationAccess === 'function' && !checkNavigationAccess(pageName)) {
            showAppModal('You do not have permission to open this screen.', 'Permission');
            return;
        }
    }
    document.querySelectorAll('.page').forEach(function (p) {
        p.classList.remove('active');
    });
    var page = document.getElementById('page-' + pageName);
    if (page) {
        page.classList.add('active');
    }
    var navActivePage = pageName;
    if (pageName === 'validate-type-select' || pageName === 'calibration' ||
        pageName === 'validation-run' || pageName === 'calibration-type-select' ||
        pageName === 'temperature-validation' || pageName === 'temperature-validation-result' ||
        pageName === 'rpm-validation' || pageName === 'rpm-validation-result' ||
        pageName === 'physical-parameters' ||
        pageName === 'sample-volume-validation' || pageName === 'sample-volume-validation-result' ||
        pageName === 'validation-suite-review') {
        navActivePage = 'validate';
    } else if (pageName === 'vessel-temperature') {
        navActivePage = (_vesselTempReturnPage === 'system-info') ? 'settings' : 'manage-recipes';
    } else if (pageName === 'shaft-position' || pageName === 'test-run') {
        navActivePage = 'manage-recipes';
    } else if (pageName === 'report-preview' || pageName === 'view-recipes' || pageName === 'recipe-print-preview') {
        navActivePage = 'reports';
    } else if (pageName === 'datetime' || pageName === 'factory-settings' ||
        pageName === 'system-settings' ||
        pageName === 'wakeup-schedule' || pageName === 'system-info' ||
        pageName === 'cleaning-cycle' || pageName === 'hardware-init' ||
        pageName === 'heater-control' ||
        pageName === 'ip-config' || pageName === 'ip-config-result') {
        navActivePage = 'settings';
    }
    document.querySelectorAll('.nav-item').forEach(function (item) {
        item.classList.toggle('active', item.getAttribute('data-page') === navActivePage);
    });
    var sidebarProfile = document.querySelector('.sidebar .user-profile');
    if (sidebarProfile) {
        if (pageName === 'user-profile') sidebarProfile.classList.add('active');
        else sidebarProfile.classList.remove('active');
    }
    var title = document.getElementById('header-title');
    if (title) {
        if (pageName === 'temperature-validation' || pageName === 'rpm-validation' ||
            pageName === 'physical-parameters' ||
            pageName === 'sample-volume-validation') {
            title.textContent = '';
        } else if (pageName === 'manage-recipes') {
            title.textContent = 'Manage Recipes';
        } else if (pageName === 'test-run') {
            var recipeTitle = '';
            var dtLive = (typeof _dissolutionTest !== 'undefined' && _dissolutionTest) || window._dissolutionTest;
            var liveRecipe = (dtLive && dtLive.recipe) || window.activeTestRecipe || null;
            if (liveRecipe) {
                recipeTitle = liveRecipe.productName || liveRecipe.name || '';
                if (typeof _dtPopulateRunRecipeFields === 'function') {
                    _dtPopulateRunRecipeFields(liveRecipe);
                }
            }
            title.textContent = recipeTitle || PAGE_TITLES['test-run'] || 'Dissolution Test';
        } else if (PAGE_TITLES[pageName]) {
            title.textContent = PAGE_TITLES[pageName];
        }
    }
    var logoEl = document.getElementById('header-logo');
    var backBtnEl = document.getElementById('header-back-btn');
    if (pageName === 'home') {
        if (logoEl) logoEl.style.display = 'block';
        if (backBtnEl) backBtnEl.style.display = 'none';
        setTimeout(function () {
            if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
        }, 30);
    } else {
        if (logoEl) logoEl.style.display = 'none';
        if (backBtnEl) backBtnEl.style.display = 'block';
    }
    if (pageName === 'reports' && typeof loadReports === 'function') {
        if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
        setTimeout(function () { loadReports(currentReportFilter || null); }, 50);
    }
    if (pageName === 'report-preview' && typeof refreshReportsActionButtons === 'function') {
        setTimeout(refreshReportsActionButtons, 50);
    }
    if (pageName === 'settings') {
        setTimeout(function () {
            if (typeof updateSettingsVisibility === 'function') updateSettingsVisibility();
        }, 50);
    }
    if (pageName === 'factory-settings') {
        setTimeout(function () {
            if (typeof initFactorySettings === 'function') initFactorySettings();
        }, 50);
    }
    if (pageName === 'system-settings') {
        setTimeout(function () {
            if (typeof initSystemSettingsPage === 'function') initSystemSettingsPage();
        }, 50);
    }
    if (pageName === 'wakeup-schedule') {
        setTimeout(function () {
            if (typeof initWakeupSchedulePage === 'function') initWakeupSchedulePage();
        }, 50);
    }
    if (pageName === 'system-info') {
        setTimeout(function () {
            if (typeof initSystemInfoPage === 'function') initSystemInfoPage();
        }, 50);
    }
    if (pageName === 'cleaning-cycle') {
        setTimeout(function () {
            if (typeof initCleaningCyclePage === 'function') initCleaningCyclePage();
        }, 50);
    }
    if (pageName === 'hardware-init') {
        setTimeout(function () {
            if (typeof initHardwareInitPage === 'function') initHardwareInitPage();
        }, 50);
    }
    if (pageName === 'heater-control') {
        setTimeout(function () {
            if (typeof initHeaterControlPage === 'function') initHeaterControlPage();
        }, 50);
    }
    if (pageName === 'ip-config') {
        setTimeout(function () {
            if (typeof initIpConfigPage === 'function') initIpConfigPage();
        }, 50);
    }
    if (pageName === 'ip-config-result') {
        setTimeout(function () {
            if (typeof initIpConfigResultPage === 'function') initIpConfigResultPage();
        }, 50);
    }
    if (pageName === 'manage-members' || pageName === 'locked-members' || pageName === 'disabled-members') {
        setTimeout(function () {
            if (typeof loadMembersAndRender === 'function') loadMembersAndRender();
        }, 50);
    }
    if (pageName === 'manage-recipes') {
        setTimeout(function () {
            if (typeof loadManageRecipes === 'function') loadManageRecipes();
        }, 50);
    }
    if (pageName === 'validate-type-select') {
        setTimeout(function () {
            // Clear selection when entering the validation type page.
            // This prevents retaining the previous selection.
            lastValidationType = null;
            var r1 = document.querySelector('input[name="val-type"][value="distance"]');
            var r2 = document.querySelector('input[name="val-type"][value="load"]');
            if (r1) r1.checked = false;
            if (r2) r2.checked = false;
        }, 0);
    }
    if (pageName === 'quick-test') {
        setTimeout(function () {
            if (typeof onQuickDissolutionStepCountChange === 'function') onQuickDissolutionStepCountChange();
        }, 50);
    }
    if (pageName === 'test-run') {
        setTimeout(function () {
            if (typeof restoreDissolutionTestRunUi === 'function') restoreDissolutionTestRunUi();
        }, 40);
    }
    if (pageName === 'disable-recipes') {
        logAuditEvent('Opened disabled recipes', 'Disabled recipes list opened', { eventType: 'navigation' });
        setTimeout(function () {
            if (typeof loadDisableRecipes === 'function') loadDisableRecipes();
        }, 50);
    }
    if (pageName === 'create-recipe-step1') {
        setTimeout(function () {
            if (window.currentEditingRecipeId && typeof loadRecipeForEdit === 'function') {
                loadRecipeForEdit();
            }
        }, 50);
    }
    if (pageName === 'create-recipe-step2') {
        setTimeout(function () {
            var countEl = document.getElementById('recipe-step-count');
            var stepCount = countEl ? parseInt(countEl.value, 10) : NaN;
            if (isNaN(stepCount) || stepCount < 1) return;
            var list = document.getElementById('create-recipe-steps-list');
            if (list && !list.querySelector('.dissolution-step-row')) {
                renderDissolutionStepRows(stepCount, 'create-recipe-steps-list', window._createRecipeStepPrefill);
            }
        }, 50);
    }
    if (pageName === 'view-recipes') {
        setTimeout(function () {
            if (typeof loadViewRecipes === 'function') loadViewRecipes();
        }, 50);
    }
    if (pageName === 'validation-run') {
        setTimeout(function () {
            if (typeof initValidationRunPage === 'function') initValidationRunPage();
        }, 50);
    }
    if (pageName === 'temperature-validation') {
        setTimeout(function () {
            if (typeof initTemperatureValidationPage === 'function') initTemperatureValidationPage();
        }, 50);
    }
    if (pageName === 'temperature-validation-result') {
        setTimeout(function () {
            if (typeof initTemperatureValidationResultPage === 'function') initTemperatureValidationResultPage();
        }, 50);
    }
    if (pageName === 'rpm-validation') {
        setTimeout(function () {
            if (typeof initRpmValidationPage === 'function') initRpmValidationPage();
        }, 50);
    }
    if (pageName === 'rpm-validation-result') {
        setTimeout(function () {
            if (typeof initRpmValidationResultPage === 'function') initRpmValidationResultPage();
        }, 50);
    }
    if (pageName === 'physical-parameters') {
        setTimeout(function () {
            if (typeof initPhysicalParametersPage === 'function') initPhysicalParametersPage();
        }, 50);
    }
    if (pageName === 'calibration') {
        setTimeout(function () {
            if (typeof initTemperatureCalibrationPage === 'function') initTemperatureCalibrationPage();
        }, 50);
    }
    if (pageName === 'sample-volume-validation') {
        setTimeout(function () {
            if (typeof initSampleVolumeValidationPage === 'function') initSampleVolumeValidationPage();
        }, 50);
    }
    if (pageName === 'sample-volume-validation-result') {
        setTimeout(function () {
            if (typeof initSampleVolumeValidationResultPage === 'function') initSampleVolumeValidationResultPage();
        }, 50);
    }
    if (pageName === 'datetime') {
        setTimeout(function () {
            if (typeof initializeDatetime === 'function') initializeDatetime();
        }, 50);
    }
    if (pageName === 'add-member') {
        setTimeout(function () {
            if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
                _refreshAddMemberPermissionsPanelVisibility();
            }
            if (typeof ensureAddMemberPageScroll === 'function') {
                ensureAddMemberPageScroll();
            }
        }, 50);
    }
    if (pageName === 'validate-type-select') {
        setTimeout(function () {
            if (typeof ensureValidationPageScroll === 'function') {
                ensureValidationPageScroll(pageName);
            }
        }, 50);
    }
    if (pageName === 'user-profile') {
        setTimeout(function () {
            var u = (typeof window.currentUser !== 'undefined' && window.currentUser) ? window.currentUser : (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
            if (typeof updateProfileFromCurrentUser === 'function') updateProfileFromCurrentUser(u);
        }, 50);
    }
    setTimeout(function () {
        if (typeof refreshShellAccessVisibility === 'function') refreshShellAccessVisibility();
    }, 0);
    auditNavPageChange(pageName);
}

function goBack() {
    var activePage = document.querySelector('.page.active');
    var pageId = activePage ? activePage.id : '';
    if (pageId === 'page-create-recipe-step1') {
        goToPage('home');
    } else if (pageId === 'page-create-recipe-step2') {
        goToPage('create-recipe-step1');
    } else if (pageId === 'page-report-preview') {
        leaveReportPreviewIfAllowed();
    } else if (pageId === 'page-recipe-print-preview') {
        goToPage('view-recipes');
    } else if (pageId === 'page-view-recipes') {
        goToPage('reports');
    } else if (pageId === 'page-ip-config') {
        goToPage('settings');
    } else if (pageId === 'page-ip-config-result') {
        goToPage('ip-config');
    } else if (pageId === 'page-system-info') {
        goToPage('settings');
    } else if (pageId === 'page-cleaning-cycle') {
        goToPage('settings');
    } else if (pageId === 'page-hardware-init') {
        if (typeof cleanupHardwareInitOnLeave === 'function') cleanupHardwareInitOnLeave();
        goToPage('settings');
    } else if (pageId === 'page-heater-control') {
        if (typeof cleanupHeaterControlOnLeave === 'function') cleanupHeaterControlOnLeave();
        goToPage('settings');
    } else if (pageId === 'page-factory-settings') {
        goToPage('settings');
    } else if (pageId === 'page-system-settings') {
        goToPage('settings');
    } else if (pageId === 'page-wakeup-schedule') {
        goToPage('settings');
    } else if (pageId === 'page-vessel-temperature') {
        closeVesselTemperaturePage();
    } else if (pageId === 'page-shaft-position') {
        closeShaftPositionPage();
    } else if (pageId === 'page-test-run') {
        if (typeof dissolutionTestBack === 'function') dissolutionTestBack();
        else goToPage('manage-recipes');
    } else if (pageId === 'page-temperature-validation' || pageId === 'page-rpm-validation' ||
        pageId === 'page-physical-parameters' ||
        pageId === 'page-sample-volume-validation' ||
        pageId === 'page-validation-suite-review') {
        if (typeof isValidationSuiteActive === 'function' && isValidationSuiteActive() &&
            typeof onValidationSuiteBack === 'function') {
            onValidationSuiteBack();
        } else {
            goToPage('validate-type-select');
        }
    } else if (pageId === 'page-temperature-validation-result') {
        goToPage('temperature-validation');
    } else if (pageId === 'page-rpm-validation-result') {
        goToPage('rpm-validation');
    } else if (pageId === 'page-sample-volume-validation-result') {
        goToPage('sample-volume-validation');
    } else if (pageId === 'page-validation-run') {
        if (typeof goBackFromValidationRun === 'function') goBackFromValidationRun();
        return;
    } else if (pageId === 'page-validate-type-select' || pageId === 'page-validate') {
        if (pageId === 'page-validate-type-select') {
            goToPage('validate');
        } else {
            goToPage('home');
        }
        return;
    } else if (pageId === 'page-calibration') {
        goToPage('validate');
    } else if (pageId === 'page-calibration-type-select') {
        goToPage('validate');
    } else if (pageId === 'page-load-calibration' || pageId === 'page-distance-zero-calibration') {
        goToPage('calibration-type-select');
    } else if (pageId === 'page-datetime') {
        goToPage('settings');
    } else if (pageId === 'page-locked-members' || pageId === 'page-disabled-members') {
        goToPage('manage-members');
    } else if (pageId === 'page-manage-recipes') {
        goToPage('home');
    } else if (pageId === 'page-export') {
        goToPage('reports');
    } else if (pageId === 'page-settings' || pageId === 'page-reports' || pageId === 'page-user-profile') {
        goToPage('home');
    } else {
        goToPage('home');
    }
}

function login() {
    var uidEl = document.getElementById('login-uid');
    var pwdEl = document.getElementById('login-pwd');
    var username = normalizeTestCommaCredential((uidEl && uidEl.value) ? uidEl.value : '');
    var password = normalizeTestCommaCredential((pwdEl && pwdEl.value) ? pwdEl.value : '');
    if (!username || !password) {
        showAppModal('Please enter User/Employee ID and Password.', 'Login');
        return;
    }
    // Use raw fetch here so we can show backend error messages (lockout, disabled, etc.)
    fetch((API_BASE || '') + '/api/data/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
    }).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        var isJson = ct.indexOf('json') !== -1;
        if (isJson) {
            return res.json().then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }
        return res.text().then(function (text) {
            return { ok: res.ok, status: res.status, body: { error: text } };
        });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.success && data.user) {
            completeSuccessfulLogin(data.user);
            return;
        }
        var msg = data.error || '';
        var remaining = (typeof data.remainingAttempts === 'number') ? data.remainingAttempts : null;
        if (result.status === 403 && data && data.passwordChangeRequired) {
            showMandatoryPasswordResetScreen(data.username || username);
            return;
        }
        if (result.status === 403 && data && data.passwordExpired) {
            showPasswordExpiredResetScreen(data.username || username, password);
            return;
        }
        if (result.status === 401) {
            if (remaining != null && remaining > 0) {
                msg = 'Incorrect password. ' + remaining + ' tr' + (remaining === 1 ? 'y' : 'ies') + ' remaining.';
            } else {
                msg = msg || 'Invalid username or password.';
            }
        } else if (result.status === 403) {
            msg = msg || 'Account locked. Contact admin.';
        } else if (!msg) {
            msg = 'Login failed (HTTP ' + result.status + ').';
        }
        showAppModal(msg, 'Login Failed');
    }).catch(function (err) {
        showAppModal('Login failed: ' + (err && err.message ? err.message : 'Network error'), 'Login Error');
    });
}

function logout() {
    var runActive =
        (typeof isTestRunActive === 'function' && isTestRunActive()) ||
        (typeof isDissolutionTestActive === 'function' && isDissolutionTestActive()) ||
        (typeof isValidationSuiteActive === 'function' && isValidationSuiteActive()) ||
        (typeof isTemperatureCalibrationActive === 'function' && isTemperatureCalibrationActive()) ||
        (validationRunState === 'running') ||
        (validationRunBackendPending === true);
    var pendingGate = (typeof isReportPreviewLockedForCurrentUser === 'function' &&
            isReportPreviewLockedForCurrentUser(window._lastReportPreview)) ||
        (window._reportApprovalGate && window._reportApprovalGate.reportId != null);

    var doLogout = function () {
        abortPendingReportOnLogout().then(function () {
            return stopActiveRunForLogout();
        }).then(function () {
            if (typeof stopRpmValidationMotor === 'function') stopRpmValidationMotor();
            return auditExitActiveScreenBeforeSessionEnd();
        }).then(flushAuditEventQueue).then(function () {
            return apiRequest(API_BASE + '/api/data/auth/logout', { method: 'POST', body: { reason: 'user' } });
        }).catch(function () {
        }).finally(function () {
            window.currentUser = null;
            try { localStorage.removeItem('currentUser'); } catch (e) {}
            if (typeof currentUser !== 'undefined') currentUser = null;
            clearReportApprovalGate();
            if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
            if (typeof applyValidationSuiteLockUi === 'function') applyValidationSuiteLockUi();
            showLoginScreen();
        });
    };

    var abortActiveRunForPendingPreview = function () {
        var chain = Promise.resolve(null);
        if (typeof isValidationSuiteActive === 'function' && isValidationSuiteActive() &&
            typeof abortValidationSuite === 'function') {
            chain = chain.then(function () {
                return abortValidationSuite({ reason: 'logout' });
            });
        }
        if (typeof isTemperatureCalibrationActive === 'function' && isTemperatureCalibrationActive() &&
            typeof abortTemperatureCalibrationHold === 'function') {
            chain = chain.then(function () {
                return abortTemperatureCalibrationHold({ reason: 'logout' });
            });
        }
        if (typeof isDissolutionTestActive === 'function' && isDissolutionTestActive() &&
            typeof _dtPerformAbort === 'function') {
            chain = chain.then(function () {
                return _dtPerformAbort({});
            });
        }
        if (validationRunState === 'running' || validationRunBackendPending) {
            chain = chain.then(function () {
                return abortValidationRun({ openPreview: true });
            });
        }
        return chain;
    };

    if (runActive) {
        showConfirmModal(
            'A run is in progress. Abort and open the pending report for approval? You cannot log out until it is approved.',
            'Operation in progress'
        ).then(function (ok) {
            if (!ok) return;
            abortActiveRunForPendingPreview().then(function () {
                showAppModal('You cannot log out until this report has been approved by a reviewer.', 'Report');
            }).catch(function () {
                showAppModal('You cannot log out until this report has been approved by a reviewer.', 'Report');
            });
        });
        return;
    }

    if (pendingGate) {
        showAppModal('You cannot log out until this report has been approved by a reviewer.', 'Report');
        var rid = currentReportId || (window._reportApprovalGate && window._reportApprovalGate.reportId);
        if (rid && typeof openPendingReportPreview === 'function') openPendingReportPreview(rid);
        else if (rid && typeof openReportPreview === 'function') openReportPreview(rid);
        return;
    }

    doLogout();
}

function normalizeBiometricEnabled(value) {
    if (typeof value === 'string') {
        var v = value.trim().toLowerCase();
        if (v === 'disabled' || v === 'false' || v === '0' || v === 'off' || v === 'no') return false;
        if (v === 'enabled' || v === 'true' || v === '1' || v === 'on' || v === 'yes') return true;
    }
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'boolean') return value;
    return true;
}

function applyBiometricSetting(enabled) {
    biometricEnabledSetting = normalizeBiometricEnabled(enabled);
    var loginDivider = document.getElementById('login-divider');
    if (loginDivider) {
        loginDivider.style.display = biometricEnabledSetting ? '' : 'none';
    }
    var loginBtn = document.getElementById('login-biometric-btn');
    if (loginBtn) {
        loginBtn.style.display = biometricEnabledSetting ? '' : 'none';
        loginBtn.disabled = !biometricEnabledSetting;
    }
    var enrollBtn = document.getElementById('enroll-biometric-btn');
    if (enrollBtn) {
        enrollBtn.style.display = biometricEnabledSetting ? '' : 'none';
        enrollBtn.disabled = !biometricEnabledSetting;
    }
}

function loginBiometric() {
    if (!biometricEnabledSetting) {
        showAppModal('Biometric login is disabled by Factory Settings.', 'Biometric Disabled');
        return;
    }
    if (window._loginBiometricInFlight) return;
    window._loginBiometricInFlight = true;
    var abortCtrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    window._loginBiometricAbort = function () {
        if (abortCtrl) abortCtrl.abort();
    };
    showBiometricProgressOverlay(
        'Biometric Login',
        'Activating fingerprint scanner. Place your finger on the sensor.'
    );
    var fetchOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    };
    if (abortCtrl) fetchOpts.signal = abortCtrl.signal;
    fetch((API_BASE || '') + '/api/data/auth/login-biometric', fetchOpts).then(function (res) {
        var ct = res.headers.get('content-type') || '';
        var isJson = ct.indexOf('json') !== -1;
        if (isJson) {
            return res.json().then(function (body) {
                return { ok: res.ok, status: res.status, body: body };
            });
        }
        return res.text().then(function (text) {
            return { ok: res.ok, status: res.status, body: { error: text } };
        });
    }).then(function (result) {
        var data = result.body || {};
        if (result.ok && data.success && data.user) {
            completeSuccessfulLogin(data.user);
            return;
        }
        if (result.status === 403 && data && data.passwordChangeRequired && data.username) {
            showMandatoryPasswordResetScreen(data.username);
            return;
        }
        var msg = (data && data.error) ? String(data.error) : 'Biometric login failed.';
        showAppModal(msg, 'Biometric Login');
    }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        showAppModal('Biometric login failed: ' + (err && err.message ? err.message : 'Network error'), 'Biometric Login');
    }).finally(function () {
        hideBiometricProgressOverlay();
        window._loginBiometricInFlight = false;
        window._loginBiometricAbort = null;
    });
}

var _biometricEnrollUsername = null;
var _biometricEnrollCancelled = false;

function _getBiometricEnrollUsername() {
    var bioUserEl = document.getElementById('member-biometric-username');
    var formUserEl = document.getElementById('add-userid');
    if (bioUserEl && bioUserEl.textContent && bioUserEl.textContent.trim() !== '--') {
        return bioUserEl.textContent.trim();
    }
    if (formUserEl && formUserEl.value) return formUserEl.value.trim();
    return '';
}

function _setBioEnrollStepActive(step) {
    var steps = document.querySelectorAll('#bio-enroll-steps .bio-enroll-step');
    steps.forEach(function (el) {
        var n = parseInt(el.getAttribute('data-step'), 10);
        el.classList.remove('active', 'done');
        if (n < step) el.classList.add('done');
        else if (n === step) el.classList.add('active');
    });
}

function _setBioFingerAnimState(state) {
    var stage = document.getElementById('bio-finger-stage');
    if (!stage) return;
    stage.classList.remove('state-place', 'state-scan', 'state-remove', 'state-done');
    if (state) stage.classList.add('state-' + state);
}

function setBiometricOverlayRetryVisible(visible) {
    var retryBtn = document.getElementById('biometric-progress-retry-btn');
    if (retryBtn) retryBtn.style.display = visible ? '' : 'none';
}

function showBiometricEnrollUi(opts) {
    opts = opts || {};
    var overlay = document.getElementById('biometric-progress-overlay');
    var titleEl = document.getElementById('biometric-progress-title');
    var msgEl = document.getElementById('biometric-progress-message');
    var hintEl = document.getElementById('biometric-progress-hint');
    var spinner = document.getElementById('biometric-progress-spinner');
    var stepsWrap = document.getElementById('bio-enroll-steps');
    var fingerStage = document.getElementById('bio-finger-stage');
    var enrollMode = !!opts.enrollMode;
    var verifyMode = !!opts.verifyMode;
    if (stepsWrap) stepsWrap.style.display = enrollMode ? 'flex' : 'none';
    if (fingerStage) fingerStage.style.display = (enrollMode || verifyMode) ? 'block' : 'none';
    if (titleEl && opts.title) titleEl.textContent = opts.title;
    if (msgEl && opts.message !== undefined) msgEl.textContent = opts.message || '';
    if (hintEl) hintEl.textContent = opts.hint || '';
    if (spinner) spinner.style.display = opts.scanning ? 'block' : 'none';
    if (opts.step) _setBioEnrollStepActive(opts.step);
    if (opts.fingerState) _setBioFingerAnimState(opts.fingerState);
    else if (verifyMode && opts.scanning) _setBioFingerAnimState('scan');
    else if (verifyMode && !opts.scanning) _setBioFingerAnimState('place');
    if (overlay) overlay.style.display = 'flex';
}

function showBiometricProgressOverlay(title, message) {
    setBiometricOverlayRetryVisible(false);
    showBiometricEnrollUi({
        title: title,
        message: message,
        enrollMode: false,
        verifyMode: true,
        scanning: true
    });
}

function showBiometricVerifyFailedOverlay(message, hint) {
    showBiometricEnrollUi({
        title: 'Fingerprint not recognized',
        message: message || 'Fingerprint verification failed.',
        hint: hint || 'Place your finger on the scanner and tap Try again.',
        enrollMode: false,
        verifyMode: true,
        scanning: false,
        fingerState: 'place'
    });
    setBiometricOverlayRetryVisible(true);
}

function hideBiometricProgressOverlay() {
    var overlay = document.getElementById('biometric-progress-overlay');
    if (overlay) overlay.style.display = 'none';
    _setBioFingerAnimState('');
    _biometricEnrollUsername = null;
    _biometricEnrollCancelled = false;
    setBiometricOverlayRetryVisible(false);
    window._biometricVerifyRetryFn = null;
    window._biometricVerifyCancelResolve = null;
    window._biometricVerifyActive = false;
}

function retryBiometricProgress() {
    setBiometricOverlayRetryVisible(false);
    if (typeof window._biometricVerifyRetryFn === 'function') {
        window._biometricVerifyRetryFn();
    }
}

function runBiometricVerifyWithRetry(opts) {
    opts = opts || {};
    var purpose = opts.purpose || 'report';
    if (window._biometricVerifyActive) {
        return Promise.resolve({ ok: false, error: 'cancelled', message: '' });
    }
    return new Promise(function (resolve) {
        if (!biometricEnabledSetting) {
            resolve({ ok: false, error: 'Biometric verification is disabled by Factory Settings.' });
            return;
        }
        window._biometricVerifyActive = true;
        var cancelled = false;
        var lastError = 'Fingerprint verification failed.';

        function finish(result) {
            window._biometricVerifyActive = false;
            resolve(result);
        }

        function finishCancel() {
            cancelled = true;
            hideBiometricProgressOverlay();
            finish({ ok: false, error: 'cancelled', message: lastError });
        }

        function attempt() {
            if (cancelled) return;
            showBiometricProgressOverlay(
                opts.title || 'Verify Fingerprint',
                opts.message || 'Place your finger on the scanner.'
            );
            var verifyBody = { method: 'biometric', purpose: purpose };
            if (opts.reportId != null) verifyBody.reportId = opts.reportId;
            if (opts.reportType) verifyBody.reportType = opts.reportType;
            apiRequest(API_BASE + '/api/data/auth/approval-verify', {
                method: 'POST',
                body: verifyBody
            }).then(function (data) {
                if (cancelled) return;
                if (data && data.ok && data.token) {
                    hideBiometricProgressOverlay();
                    finish({ ok: true, token: String(data.token) });
                    return;
                }
                lastError = (data && data.error) ? String(data.error) : 'Fingerprint verification failed.';
                showBiometricVerifyFailedOverlay(lastError, opts.failureHint);
                window._biometricVerifyRetryFn = attempt;
            }).catch(function (err) {
                if (cancelled) return;
                lastError = 'Fingerprint verification failed: ' + (err && err.message ? err.message : 'Error');
                showBiometricVerifyFailedOverlay(lastError, opts.failureHint);
                window._biometricVerifyRetryFn = attempt;
            });
        }

        window._biometricVerifyCancelResolve = finishCancel;
        window._biometricVerifyRetryFn = attempt;
        attempt();
    });
}

function _cancelBiometricEnrollSession() {
    var username = _biometricEnrollUsername;
    if (!username) return Promise.resolve();
    return apiRequest(API_BASE + '/api/biometric/enroll/cancel', {
        method: 'POST',
        body: { username: username }
    }).catch(function () {});
}

function cancelBiometricProgress() {
    _biometricEnrollCancelled = true;
    var stopSensor = function () {
        return apiRequest(API_BASE + '/api/biometric/cancel', { method: 'POST', body: {} }).catch(function () {});
    };
    if (typeof window._loginBiometricAbort === 'function') {
        window._loginBiometricAbort();
        hideBiometricProgressOverlay();
        window._loginBiometricInFlight = false;
        window._loginBiometricAbort = null;
        stopSensor();
        return;
    }
    if (typeof window._biometricVerifyCancelResolve === 'function') {
        var cancelVerify = window._biometricVerifyCancelResolve;
        window._biometricVerifyCancelResolve = null;
        cancelVerify();
        stopSensor();
        return;
    }
    stopSensor().finally(function () {
        _cancelBiometricEnrollSession().finally(function () {
            hideBiometricProgressOverlay();
        });
    });
}

function _delayMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function _biometricEnrollCaptureStep(username, step) {
    return apiRequest(API_BASE + '/api/biometric/enroll/capture', {
        method: 'POST',
        body: { username: username, step: step }
    });
}

function enrollMemberBiometric() {
    if (!biometricEnabledSetting) {
        showAppModal('Biometric enrollment is disabled by Factory Settings.', 'Biometric Disabled');
        return;
    }
    var username = _getBiometricEnrollUsername();
    if (!username) {
        showAppModal('No member selected for fingerprint enrollment. Save the member first.', 'Register Fingerprint');
        return;
    }
    _biometricEnrollUsername = username;
    _biometricEnrollCancelled = false;

    showBiometricEnrollUi({
        enrollMode: true,
        title: 'Register Fingerprint — Scan 1 of 2',
        message: 'Place your finger flat on the scanner.',
        hint: 'Hold still until the first scan is captured.',
        step: 1,
        fingerState: 'scan',
        scanning: true
    });

    _biometricEnrollCaptureStep(username, 1).then(function (data) {
        if (_biometricEnrollCancelled) return;
        if (!data || !data.ok) {
            hideBiometricProgressOverlay();
            showAppModal((data && data.error) || 'First scan failed.', 'Register Fingerprint');
            return;
        }
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Remove your finger',
            message: 'Lift your finger off the scanner.',
            hint: 'Wait a moment, then you will scan the same finger again.',
            step: 1,
            fingerState: 'remove',
            scanning: false
        });
        return _delayMs(1800);
    }).then(function () {
        if (_biometricEnrollCancelled) return;
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Register Fingerprint — Scan 2 of 2',
            message: 'Place the same finger on the scanner again.',
            hint: 'Use the same finger as the first scan. Hold still until complete.',
            step: 2,
            fingerState: 'scan',
            scanning: true
        });
        return _biometricEnrollCaptureStep(username, 2);
    }).then(function (data) {
        if (_biometricEnrollCancelled) return;
        if (!data) return;
        if (!data.ok) {
            hideBiometricProgressOverlay();
            showAppModal((data && data.error) || 'Second scan failed.', 'Register Fingerprint');
            return;
        }
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Saving fingerprint',
            message: 'Matching scans and saving template…',
            hint: '',
            step: 2,
            fingerState: 'scan',
            scanning: true
        });
        return _delayMs(400).then(function () { return data; });
    }).then(function (data) {
        if (_biometricEnrollCancelled || !data || !data.ok) return;
        showBiometricEnrollUi({
            enrollMode: true,
            title: 'Fingerprint registered',
            message: 'Both scans captured successfully.',
            hint: '',
            step: 2,
            fingerState: 'done',
            scanning: false
        });
        document.querySelectorAll('#bio-enroll-steps .bio-enroll-step').forEach(function (el) {
            el.classList.add('done');
            el.classList.remove('active');
        });
        return _delayMs(900);
    }).then(function () {
        if (_biometricEnrollCancelled) return;
        hideBiometricProgressOverlay();
        _addMemberLastSavedId = null;
        showAppModal('Fingerprint enrolled successfully.', 'Register Fingerprint');
        goToPage('user-profile');
    }).catch(function (err) {
        if (_biometricEnrollCancelled) return;
        hideBiometricProgressOverlay();
        showAppModal('Fingerprint enrollment failed: ' + (err && err.message ? err.message : 'Network error'), 'Register Fingerprint');
    });
}

function startRecipeTest() {
    recipeListMode = 'load';
    logAuditEvent('Opened Load Recipe', 'Load Recipe list opened', { eventType: 'navigation' });
    goToPage('manage-recipes');
}

function goToLoadRecipeAfterSave() {
    if (typeof startRecipeTest === 'function') {
        startRecipeTest();
        return;
    }
    recipeListMode = 'load';
    goToPage('manage-recipes');
}

function getQuickRecipeMode() {
    var selected = document.querySelector('input[name="quick-usp-mode"]:checked');
    var mode = selected ? String(selected.value || '').toUpperCase() : 'USP';
    return mode === 'CUSTOM' ? 'CUSTOM' : 'USP';
}

function getQuickRecipeDrumCount() {
    var selected = document.querySelector('input[name="quick-recipe-drum-count"]:checked');
    var n = selected ? parseInt(selected.value, 10) : 2;
    return n === 1 ? 1 : 2;
}

function parseMmSsToSeconds(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return NaN;
    if (s.indexOf(':') >= 0) {
        var parts = s.split(':');
        if (parts.length === 3) {
            return parseHhMmSsToSeconds(s);
        }
        if (parts.length !== 2) return NaN;
        var mm = parseInt(parts[0], 10);
        var ss = parseInt(parts[1], 10);
        if (isNaN(mm) || isNaN(ss) || mm < 0 || ss < 0 || ss > 59) return NaN;
        return (mm * 60) + ss;
    }
    var mins = parseFloat(s);
    if (isNaN(mins) || mins <= 0) return NaN;
    return Math.round(mins * 60);
}

function parseHhMmSsToSeconds(value) {
    var s = String(value == null ? '' : value).trim();
    if (!s) return NaN;
    var parts = s.split(':');
    if (parts.length !== 3) return NaN;
    var hh = parseInt(parts[0], 10);
    var mm = parseInt(parts[1], 10);
    var ss = parseInt(parts[2], 10);
    if (isNaN(hh) || isNaN(mm) || isNaN(ss)) return NaN;
    if (hh < 0 || mm < 0 || mm > 59 || ss < 0 || ss > 59) return NaN;
    return (hh * 3600) + (mm * 60) + ss;
}

function formatSecondsAsHhMmSs(seconds) {
    var total = Math.max(0, parseInt(seconds, 10) || 0);
    var hh = Math.floor(total / 3600);
    var mm = Math.floor((total % 3600) / 60);
    var ss = total % 60;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

function formatSecondsAsMmSs(seconds) {
    var total = Math.max(0, parseInt(seconds, 10) || 0);
    var mm = Math.floor(total / 60);
    var ss = total % 60;
    return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

function _setQuickRecipeParamFieldState(el, enabled) {
    if (!el) return;
    var on = !!enabled;
    el.disabled = !on;
    el.readOnly = !on;
    el.classList.toggle('input-disabled-like', !on);
    if (!on && typeof el.blur === 'function') el.blur();
}

function applyQuickRecipeModeToFields() {
    var mode = getQuickRecipeMode();
    var speedEl = document.getElementById('quick-recipe-speed');
    var timeEl = document.getElementById('quick-recipe-time');
    var countEl = document.getElementById('quick-recipe-tablet-count');
    var completionWrap = document.getElementById('quick-custom-completion-wrap');
    if (!speedEl || !timeEl || !countEl) return;

    speedEl.min = '20';
    speedEl.max = '70';
    timeEl.min = '1';
    countEl.min = '1';
    countEl.max = '10000';

    var isUsp = mode === 'USP';
    if (completionWrap) completionWrap.style.display = isUsp ? 'none' : '';

    if (isUsp) {
        speedEl.value = '25';
        timeEl.value = '4';
        countEl.value = '100';
        _setQuickRecipeParamFieldState(speedEl, false);
        _setQuickRecipeParamFieldState(timeEl, false);
        _setQuickRecipeParamFieldState(countEl, false);
        return;
    }

    var completionRadio = document.querySelector('input[name="quick-recipe-custom-completion"]:checked');
    var completionMode = completionRadio ? String(completionRadio.value || '').toUpperCase() : 'COUNT';
    var isTimeMode = completionMode === 'TIME';

    _setQuickRecipeParamFieldState(speedEl, true);
    _setQuickRecipeParamFieldState(timeEl, isTimeMode);
    _setQuickRecipeParamFieldState(countEl, !isTimeMode);

    if (isTimeMode) {
        countEl.value = '';
    } else {
        timeEl.value = '';
    }
}

function onQuickDissolutionStepCountChange() {
    var countEl = document.getElementById('quick-step-count');
    var stepCount = countEl ? parseInt(countEl.value, 10) : NaN;
    if (countEl && countEl.value !== '' && !isNaN(stepCount) && stepCount > 12) {
        showAppModal('Maximum 12 steps.', 'Number of Steps');
        countEl.value = '12';
        stepCount = 12;
    } else if (countEl && countEl.value !== '' && !isNaN(stepCount) && stepCount < 1) {
        showAppModal('Number of steps must be between 1 and 12.', 'Number of Steps');
        countEl.value = '';
        var emptyList = document.getElementById('quick-create-recipe-steps-list');
        if (emptyList) emptyList.innerHTML = '';
        return;
    }
    if (isNaN(stepCount) || stepCount < 1) {
        var list = document.getElementById('quick-create-recipe-steps-list');
        if (list) list.innerHTML = '';
        return;
    }
    renderDissolutionStepRows(stepCount, 'quick-create-recipe-steps-list');
}

function startQuickTest() {
    var ids = [
        'quick-product-name', 'quick-temperature', 'quick-step-count',
        'quick-sample-volume', 'quick-rinse-volume',
        'quick-power-failure', 'quick-media', 'quick-media-volume', 'quick-media-ph', 'quick-batch-size'
    ];
    ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var modeEl = document.getElementById('quick-mode');
    var uspEl = document.getElementById('quick-usp');
    var repEl = document.getElementById('quick-replenishment');
    if (modeEl) modeEl.value = 'Auto';
    if (uspEl) uspEl.value = 'USP 1';
    if (repEl) repEl.value = 'Yes';
    var list = document.getElementById('quick-create-recipe-steps-list');
    if (list) list.innerHTML = '';
    window._quickTestFormPendingReset = true;
    logAuditEvent('Opened Quick Test', 'Quick Test screen opened', { eventType: 'navigation' });
    goToPage('quick-test');
}

function startQuickTestRunFromParams() {
    var nameEl = document.getElementById('quick-product-name');
    var tempEl = document.getElementById('quick-temperature');
    var countEl = document.getElementById('quick-step-count');
    var modeEl = document.getElementById('quick-mode');
    var uspEl = document.getElementById('quick-usp');
    var sampleEl = document.getElementById('quick-sample-volume');
    var rinseEl = document.getElementById('quick-rinse-volume');
    var repEl = document.getElementById('quick-replenishment');
    var pfEl = document.getElementById('quick-power-failure');
    var mediaEl = document.getElementById('quick-media');
    var mediaVolEl = document.getElementById('quick-media-volume');
    var mediaPhEl = document.getElementById('quick-media-ph');
    var batchSizeEl = document.getElementById('quick-batch-size');

    var productName = nameEl && nameEl.value ? nameEl.value.trim() : '';
    var temperature = tempEl ? parseFloat(tempEl.value) : NaN;
    var stepCount = countEl ? parseInt(countEl.value, 10) : NaN;
    var mode = modeEl ? String(modeEl.value || '').trim() : '';
    var usp = uspEl ? String(uspEl.value || '').trim() : '';
    var sampleVolume = sampleEl && sampleEl.value ? sampleEl.value.trim() : '';
    var rinseVolume = rinseEl && rinseEl.value ? rinseEl.value.trim() : '';
    var replenishment = repEl ? String(repEl.value || '').trim() : '';
    var powerFailureMin = pfEl ? parseInt(pfEl.value, 10) : NaN;
    var media = mediaEl && mediaEl.value ? mediaEl.value.trim() : '';
    var mediaVolume = mediaVolEl && mediaVolEl.value ? mediaVolEl.value.trim() : '';
    var mediaPh = mediaPhEl ? parseFloat(mediaPhEl.value) : NaN;
    var batchSize = batchSizeEl && batchSizeEl.value ? batchSizeEl.value.trim() : '';
    var autoDispense = (mode === 'Auto');

    if (!productName) {
        showAppModal('Please enter recipe name.', 'Quick Test');
        return;
    }
    if (isNaN(temperature) || temperature < 20 || temperature > 50) {
        showAppModal('Please enter a temperature between 20 and 50 °C.', 'Quick Test');
        return;
    }
    if (!isNaN(stepCount) && stepCount > 12) {
        showAppModal('Maximum 12 steps.', 'Number of Steps');
        if (countEl) countEl.value = '12';
        return;
    }
    if (isNaN(stepCount) || stepCount < 1 || stepCount > 12) {
        showAppModal('Please enter number of steps between 1 and 12.', 'Quick Test');
        return;
    }
    if (mode !== 'Auto' && mode !== 'Manual') {
        showAppModal('Please select Sample Drop (Auto or Manual).', 'Quick Test');
        return;
    }
    if (usp !== 'USP 1' && usp !== 'USP 2') {
        showAppModal('Please select USP 1 or USP 2.', 'Quick Test');
        return;
    }
    if (!media) {
        showAppModal('Please enter media.', 'Quick Test');
        return;
    }
    if (!mediaVolume) {
        showAppModal('Please enter media volume.', 'Quick Test');
        return;
    }
    if (isNaN(mediaPh) || mediaPh < 0 || mediaPh > 14) {
        showAppModal('Please enter media pH between 0 and 14.', 'Quick Test');
        return;
    }
    if (!batchSize) {
        showAppModal('Please enter batch size.', 'Quick Test');
        return;
    }
    if (!sampleVolume) {
        showAppModal('Please enter sample volume.', 'Quick Test');
        return;
    }
    if (!rinseVolume) {
        showAppModal('Please enter flush volume.', 'Quick Test');
        return;
    }
    if (replenishment !== 'Yes' && replenishment !== 'No') {
        showAppModal('Please select replenishment (Yes or No).', 'Quick Test');
        return;
    }
    if (isNaN(powerFailureMin) || powerFailureMin < 1 || powerFailureMin > 60) {
        showAppModal('Please enter power failure between 1 and 60 minutes.', 'Quick Test');
        return;
    }

    renderDissolutionStepRows(stepCount, 'quick-create-recipe-steps-list');
    var collected = collectDissolutionStepsFromDom({
        listId: 'quick-create-recipe-steps-list',
        tempId: 'quick-temperature'
    });
    if (collected.error) {
        showAppModal(collected.error, 'Quick Test');
        return;
    }
    if (collected.steps.length !== stepCount) {
        showAppModal('Please complete all ' + stepCount + ' steps.', 'Quick Test');
        return;
    }

    var recipe = {
        productName: productName,
        name: productName,
        temperature: temperature,
        stepCount: collected.steps.length,
        steps: collected.steps,
        mode: mode,
        usp: usp,
        uspMode: usp,
        media: media,
        mediaVolume: mediaVolume,
        mediaPh: mediaPh,
        batchSize: batchSize,
        autoDispense: autoDispense,
        sampleVolume: sampleVolume,
        rinseVolume: rinseVolume,
        replenishment: replenishment,
        powerFailure: powerFailureMin,
        recipeType: 'dissolution',
        quickTest: true,
        createdAt: new Date().toISOString()
    };

    window._quickTestFormPendingReset = true;
    pendingRecipeToLoad = recipe;
    pendingRecipeLoadContext = { drumCount: 1, step: 1, dissolution: true, fromQuickTest: true };
    openBatchNumberModal();
}

function resetQuickTestFormAfterRunIfPending() {
    if (!window._quickTestFormPendingReset) return;
    window._quickTestFormPendingReset = false;
    // Form is cleared next time startQuickTest() opens; keep values until then if user navigates back.
}

function manageRecipes() {
    recipeListMode = 'manage';
    logAuditEvent('Opened Manage Recipe', 'Manage Recipe list opened', { eventType: 'navigation' });
    goToPage('manage-recipes');
}

function getRecipeMode() {
    var selected = document.querySelector('input[name="create-usp-mode"]:checked');
    var mode = selected ? String(selected.value || '').toUpperCase() : 'USP';
    return mode === 'CUSTOM' ? 'CUSTOM' : 'USP';
}

function getRecipeDrumCount() {
    var selected = document.querySelector('input[name="recipe-drum-count"]:checked');
    var n = selected ? parseInt(selected.value, 10) : 2;
    return n === 1 ? 1 : 2;
}

function applyRecipeModeToFields() {
    var mode = getRecipeMode();
    var speedEl = document.getElementById('recipe-speed');
    var timeEl = document.getElementById('recipe-time');
    var countEl = document.getElementById('recipe-tablet-count');
    var completionWrap = document.getElementById('create-custom-completion-wrap');
    if (!speedEl || !timeEl || !countEl) return;

    speedEl.min = '20';
    speedEl.max = '70';
    timeEl.min = '1';
    countEl.min = '1';
    countEl.max = '10000';

    var isUsp = mode === 'USP';
    if (isUsp) {
        speedEl.value = '25';
        timeEl.value = '4';
        countEl.value = '100';
        _setQuickRecipeParamFieldState(speedEl, false);
        _setQuickRecipeParamFieldState(timeEl, false);
        _setQuickRecipeParamFieldState(countEl, false);
        if (completionWrap) completionWrap.style.display = 'none';
        return;
    }

    if (completionWrap) completionWrap.style.display = '';
    var completionRadio = document.querySelector('input[name="recipe-custom-completion"]:checked');
    var completionMode = completionRadio ? String(completionRadio.value || '').toUpperCase() : 'COUNT';
    var isTimeMode = completionMode === 'TIME';

    _setQuickRecipeParamFieldState(speedEl, true);
    _setQuickRecipeParamFieldState(timeEl, isTimeMode);
    _setQuickRecipeParamFieldState(countEl, !isTimeMode);

    if (isTimeMode) {
        countEl.value = '';
    } else {
        timeEl.value = '';
    }
}

function startRecipeCreation() {
    window.currentEditingRecipeId = null;
    window._createRecipeDraft = null;
    window._dissolutionStepIndex = 0;
    var ids = [
        'recipe-product-name', 'recipe-temperature', 'recipe-step-count',
        'recipe-sample-volume', 'recipe-rinse-volume',
        'recipe-power-failure', 'recipe-media', 'recipe-media-volume', 'recipe-media-ph', 'recipe-batch-size'
    ];
    ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var modeEl = document.getElementById('recipe-mode');
    var uspEl = document.getElementById('recipe-usp');
    var repEl = document.getElementById('recipe-replenishment');
    if (modeEl) modeEl.value = 'Auto';
    if (uspEl) uspEl.value = 'USP 1';
    if (repEl) repEl.value = 'Yes';
    window._createRecipeStepPrefill = null;
    var list = document.getElementById('create-recipe-steps-list');
    if (list) list.innerHTML = '';
    logAuditEvent('Opened Create Recipe', 'Create Recipe screen opened', { eventType: 'navigation' });
    goToPage('create-recipe-step1');
}

function syncAutoDispenseFieldVisibility(which) {
    // Sample Drop (mode) replaced Auto Dispense; keep no-op for callers.
    return;
}

function onDissolutionStepCountChange() {
    var countEl = document.getElementById('recipe-step-count');
    if (!countEl) return;
    var stepCount = parseInt(countEl.value, 10);
    if (countEl.value !== '' && !isNaN(stepCount) && stepCount > 12) {
        showAppModal('Maximum 12 steps.', 'Number of Steps');
        countEl.value = '12';
    } else if (countEl.value !== '' && !isNaN(stepCount) && stepCount < 1) {
        showAppModal('Number of steps must be between 1 and 12.', 'Number of Steps');
        countEl.value = '';
    }
    // Step rows are rendered on create-recipe-step2 after Continue.
}

function _dissolutionStepListIncludesSampleVolume(listId) {
    return listId === 'create-recipe-steps-list';
}

function renderDissolutionStepRows(n, listId, prefillSteps) {
    listId = listId || 'create-recipe-steps-list';
    var list = document.getElementById(listId);
    if (!list) return;
    var includeSample = _dissolutionStepListIncludesSampleVolume(listId);
    var prevValues = {};
    list.querySelectorAll('.dissolution-step-row').forEach(function (row) {
        var idx = row.getAttribute('data-step');
        var rpm = row.querySelector('.dissolution-step-rpm');
        var dur = row.querySelector('.dissolution-step-duration');
        var sample = row.querySelector('.dissolution-step-sample');
        prevValues[idx] = {
            rpm: rpm ? rpm.value : '',
            duration: dur ? dur.value : '',
            sampleVolume: sample ? sample.value : ''
        };
    });
    var prefill = Array.isArray(prefillSteps) ? prefillSteps : (window._createRecipeStepPrefill || []);
    list.innerHTML = '';
    if (includeSample) {
        list.classList.add('dissolution-steps-list--4col');
    } else {
        list.classList.remove('dissolution-steps-list--4col');
    }
    for (var i = 1; i <= n; i++) {
        var prev = prevValues[String(i)] || {};
        var pf = prefill[i - 1] || {};
        var rpmVal = prev.rpm || (pf.rpm != null ? String(pf.rpm) : '');
        var durVal = prev.duration || pf.durationHms || (typeof formatSecondsAsHhMmSs === 'function'
            ? formatSecondsAsHhMmSs(pf.durationSeconds || 0)
            : '');
        if (durVal === '00:00:00' && !prev.duration && !pf.durationHms && !pf.durationSeconds) durVal = '';
        var sampleVal = prev.sampleVolume || pf.sampleVolume || '';
        var row = document.createElement('div');
        row.className = 'dissolution-step-row' + (includeSample ? ' dissolution-step-row--4col' : '');
        row.setAttribute('data-step', String(i));
        var sampleField = includeSample
            ? ('<input type="text" class="input-field dissolution-step-sample" placeholder="Sample vol." ' +
                'value="' + sampleVal + '" ' +
                'onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)">')
            : '';
        row.innerHTML =
            '<span class="dissolution-step-label">Step ' + i + '</span>' +
            '<input type="number" class="input-field dissolution-step-rpm" min="' + DISSOLUTION_RPM_MIN + '" max="' + DISSOLUTION_RPM_MAX + '" step="1" placeholder="RPM" ' +
            'value="' + rpmVal + '" ' +
            'onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)" ' +
            'onchange="if(typeof enforceDissolutionRpmInput === \'function\') enforceDissolutionRpmInput(this, { title: \'RPM\', asInt: true })" ' +
            'onblur="if(typeof enforceDissolutionRpmInput === \'function\') enforceDissolutionRpmInput(this, { title: \'RPM\', asInt: true })">' +
            '<input type="text" class="input-field dissolution-step-duration" inputmode="numeric" placeholder="HH:MM:SS" ' +
            'value="' + durVal + '" ' +
            'onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)">' +
            sampleField;
        list.appendChild(row);
    }
}

function collectDissolutionStepsFromDom(opts) {
    opts = opts || {};
    var listId = opts.listId || 'create-recipe-steps-list';
    var list = document.getElementById(listId);
    if (!list) return { error: 'Step list not found.', steps: [] };
    var includeSample = opts.includeSampleVolume != null
        ? !!opts.includeSampleVolume
        : _dissolutionStepListIncludesSampleVolume(listId);
    var rows = list.querySelectorAll('.dissolution-step-row');
    var steps = [];
    var tempEl = document.getElementById(opts.tempId || 'recipe-temperature');
    var temperature = tempEl ? parseFloat(tempEl.value) : NaN;
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var stepNum = parseInt(row.getAttribute('data-step'), 10) || (i + 1);
        var rpmEl = row.querySelector('.dissolution-step-rpm');
        var durEl = row.querySelector('.dissolution-step-duration');
        var sampleEl = row.querySelector('.dissolution-step-sample');
        var rpm = rpmEl ? parseFloat(rpmEl.value) : NaN;
        var durationHms = durEl ? String(durEl.value || '').trim() : '';
        var durationSeconds = parseHhMmSsToSeconds(durationHms);
        var sampleVolume = sampleEl ? String(sampleEl.value || '').trim() : '';
        if (isNaN(rpm) || rpm <= 0) {
            return { error: 'Please enter a valid RPM for Step ' + stepNum + '.', steps: [] };
        }
        if (!isDissolutionRpmInRange(rpm)) {
            return { error: dissolutionRpmRangeMessage('Step ' + stepNum + ':'), steps: [] };
        }
        if (isNaN(durationSeconds) || durationSeconds < 1) {
            return { error: 'Please enter duration as HH:MM:SS for Step ' + stepNum + '.', steps: [] };
        }
        if (includeSample && !sampleVolume) {
            return { error: 'Please enter sample volume for Step ' + stepNum + '.', steps: [] };
        }
        var stepObj = {
            step: stepNum,
            rpm: rpm,
            durationHms: formatSecondsAsHhMmSs(durationSeconds),
            durationSeconds: durationSeconds,
            temperature: isNaN(temperature) ? null : temperature
        };
        if (includeSample) stepObj.sampleVolume = sampleVolume;
        steps.push(stepObj);
    }
    if (!steps.length) {
        return { error: 'Enter number of steps and complete each step.', steps: [] };
    }
    return { error: null, steps: steps };
}

function validateCreateRecipeStep1Fields() {
    var nameEl = document.getElementById('recipe-product-name');
    var tempEl = document.getElementById('recipe-temperature');
    var countEl = document.getElementById('recipe-step-count');
    var modeEl = document.getElementById('recipe-mode');
    var uspEl = document.getElementById('recipe-usp');
    var rinseEl = document.getElementById('recipe-rinse-volume');
    var sampleEl = document.getElementById('recipe-sample-volume');
    var repEl = document.getElementById('recipe-replenishment');
    var pfEl = document.getElementById('recipe-power-failure');
    var mediaEl = document.getElementById('recipe-media');
    var mediaVolEl = document.getElementById('recipe-media-volume');
    var mediaPhEl = document.getElementById('recipe-media-ph');
    var batchSizeEl = document.getElementById('recipe-batch-size');

    var productName = nameEl && nameEl.value ? nameEl.value.trim() : '';
    var temperature = tempEl ? parseFloat(tempEl.value) : NaN;
    var stepCount = countEl ? parseInt(countEl.value, 10) : NaN;
    var mode = modeEl ? String(modeEl.value || '').trim() : '';
    var usp = uspEl ? String(uspEl.value || '').trim() : '';
    var rinseVolume = rinseEl && rinseEl.value ? rinseEl.value.trim() : '';
    var sampleVolume = sampleEl && sampleEl.value ? sampleEl.value.trim() : '';
    var replenishment = repEl ? String(repEl.value || '').trim() : '';
    var powerFailureMin = pfEl ? parseInt(pfEl.value, 10) : NaN;
    var media = mediaEl && mediaEl.value ? mediaEl.value.trim() : '';
    var mediaVolume = mediaVolEl && mediaVolEl.value ? mediaVolEl.value.trim() : '';
    var mediaPh = mediaPhEl ? parseFloat(mediaPhEl.value) : NaN;
    var batchSize = batchSizeEl && batchSizeEl.value ? batchSizeEl.value.trim() : '';

    if (!productName) {
        showAppModal('Please enter recipe name.', 'Create Recipe');
        return null;
    }
    if (isNaN(temperature) || temperature < 20 || temperature > 50) {
        showAppModal('Please enter a temperature between 20 and 50 °C.', 'Create Recipe');
        return null;
    }
    if (!isNaN(stepCount) && stepCount > 12) {
        showAppModal('Maximum 12 steps.', 'Number of Steps');
        if (countEl) countEl.value = '12';
        return null;
    }
    if (isNaN(stepCount) || stepCount < 1 || stepCount > 12) {
        showAppModal('Please enter number of steps between 1 and 12.', 'Create Recipe');
        return null;
    }
    if (mode !== 'Auto' && mode !== 'Manual') {
        showAppModal('Please select Sample Drop (Auto or Manual).', 'Create Recipe');
        return null;
    }
    if (usp !== 'USP 1' && usp !== 'USP 2') {
        showAppModal('Please select USP 1 or USP 2.', 'Create Recipe');
        return null;
    }
    if (!media) {
        showAppModal('Please enter media.', 'Create Recipe');
        return null;
    }
    if (!mediaVolume) {
        showAppModal('Please enter media volume.', 'Create Recipe');
        return null;
    }
    if (isNaN(mediaPh) || mediaPh < 0 || mediaPh > 14) {
        showAppModal('Please enter Media PH between 0 and 14.', 'Create Recipe');
        return null;
    }
    if (!batchSize) {
        showAppModal('Please enter batch size.', 'Create Recipe');
        return null;
    }
    if (!sampleVolume) {
        showAppModal('Please enter sample volume.', 'Create Recipe');
        return null;
    }
    if (!rinseVolume) {
        showAppModal('Please enter flush volume.', 'Create Recipe');
        return null;
    }
    if (replenishment !== 'Yes' && replenishment !== 'No') {
        showAppModal('Please select replenishment (Yes or No).', 'Create Recipe');
        return null;
    }
    if (isNaN(powerFailureMin) || powerFailureMin < 1 || powerFailureMin > 60) {
        showAppModal('Please enter power failure between 1 and 60 minutes.', 'Create Recipe');
        return null;
    }
    return { stepCount: stepCount, sampleVolume: sampleVolume, media: media, mediaVolume: mediaVolume, mediaPh: mediaPh, batchSize: batchSize };
}

function continueCreateRecipeToSteps() {
    var validated = validateCreateRecipeStep1Fields();
    if (!validated) return;
    var nameEl = document.getElementById('recipe-product-name');
    var summaryEl = document.getElementById('create-recipe-step2-summary');
    if (summaryEl && nameEl) {
        var recipeName = nameEl.value ? nameEl.value.trim() : '';
        summaryEl.textContent = (recipeName ? recipeName + ' — ' : '') +
            validated.stepCount + ' step' + (validated.stepCount === 1 ? '' : 's') +
            '. Enter RPM, duration (HH:MM:SS), and sample volume for each step.';
    }
    renderDissolutionStepRows(validated.stepCount, 'create-recipe-steps-list', window._createRecipeStepPrefill);
    goToPage('create-recipe-step2');
}

function saveDissolutionRecipe() {
    var validated = validateCreateRecipeStep1Fields();
    if (!validated) {
        goToPage('create-recipe-step1');
        return;
    }
    var stepCount = validated.stepCount;

    var nameEl = document.getElementById('recipe-product-name');
    var tempEl = document.getElementById('recipe-temperature');
    var modeEl = document.getElementById('recipe-mode');
    var uspEl = document.getElementById('recipe-usp');
    var rinseEl = document.getElementById('recipe-rinse-volume');
    var sampleEl = document.getElementById('recipe-sample-volume');
    var repEl = document.getElementById('recipe-replenishment');
    var pfEl = document.getElementById('recipe-power-failure');
    var mediaEl = document.getElementById('recipe-media');
    var mediaVolEl = document.getElementById('recipe-media-volume');
    var mediaPhEl = document.getElementById('recipe-media-ph');
    var batchSizeEl = document.getElementById('recipe-batch-size');

    var productName = nameEl && nameEl.value ? nameEl.value.trim() : '';
    var temperature = tempEl ? parseFloat(tempEl.value) : NaN;
    var mode = modeEl ? String(modeEl.value || '').trim() : '';
    var usp = uspEl ? String(uspEl.value || '').trim() : '';
    var rinseVolume = rinseEl && rinseEl.value ? rinseEl.value.trim() : '';
    var recipeSampleVolume = sampleEl && sampleEl.value ? sampleEl.value.trim() : '';
    var replenishment = repEl ? String(repEl.value || '').trim() : '';
    var powerFailureMin = pfEl ? parseInt(pfEl.value, 10) : NaN;
    var media = mediaEl && mediaEl.value ? mediaEl.value.trim() : '';
    var mediaVolume = mediaVolEl && mediaVolEl.value ? mediaVolEl.value.trim() : '';
    var mediaPh = mediaPhEl ? parseFloat(mediaPhEl.value) : NaN;
    var batchSize = batchSizeEl && batchSizeEl.value ? batchSizeEl.value.trim() : (validated.batchSize || '');
    var autoDispense = (mode === 'Auto');

    renderDissolutionStepRows(stepCount, 'create-recipe-steps-list', window._createRecipeStepPrefill);
    var collected = collectDissolutionStepsFromDom({ includeSampleVolume: true });
    if (collected.error) {
        showAppModal(collected.error, 'Create Recipe');
        goToPage('create-recipe-step2');
        return;
    }
    if (collected.steps.length !== stepCount) {
        showAppModal('Please complete all ' + stepCount + ' steps.', 'Create Recipe');
        goToPage('create-recipe-step2');
        return;
    }

    var sampleVolume = recipeSampleVolume ||
        (collected.steps[0] && collected.steps[0].sampleVolume
            ? collected.steps[0].sampleVolume
            : '');

    var recipe = {
        productName: productName,
        name: productName,
        temperature: temperature,
        stepCount: collected.steps.length,
        steps: collected.steps,
        mode: mode,
        usp: usp,
        uspMode: usp,
        media: media,
        mediaVolume: mediaVolume,
        mediaPh: mediaPh,
        autoDispense: autoDispense,
        sampleVolume: sampleVolume,
        rinseVolume: rinseVolume,
        batchSize: batchSize,
        replenishment: replenishment,
        powerFailure: powerFailureMin,
        recipeType: 'dissolution',
        createdAt: new Date().toISOString()
    };

    var editId = window.currentEditingRecipeId;
    if (editId) recipe.id = editId;
    var url = editId ? (API_BASE + '/api/data/recipes/' + editId) : (API_BASE + '/api/data/recipes');
    var method = editId ? 'PUT' : 'POST';

    apiRequest(url, {
        method: method,
        body: recipe
    }).then(function (result) {
        window._createRecipeDraft = null;
        window.currentEditingRecipeId = null;
        window._createRecipeStepPrefill = null;
        window._dissolutionStepIndex = 0;
        var rid = (result && result.id != null)
            ? result.id
            : ((result && result.recipe && result.recipe.id != null) ? result.recipe.id : null);
        var role = (typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '');
        var isFactory = role === 'factory' ||
            (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(role, window.currentUser));
        if (rid != null && isFactory) {
            showAppModal('Recipe saved and approved.', 'Save Recipe');
            goToLoadRecipeAfterSave();
        } else if (rid != null && typeof approveSavedRecipeWithCredentials === 'function') {
            setTimeout(function () {
                approveSavedRecipeWithCredentials(rid, 'Save Recipe', '').then(function (res) {
                    if (res && res.cancelled) {
                        showAppModal('Recipe saved. It stays pending until a QA or Admin approves it.', 'Save Recipe');
                    } else if (res && res.ok) {
                        showAppModal('Recipe saved successfully.', 'Save Recipe');
                    }
                    goToLoadRecipeAfterSave();
                });
            }, 50);
        } else {
            showAppModal('Recipe saved successfully.', 'Save Recipe');
            goToLoadRecipeAfterSave();
        }
    }).catch(function (err) {
        var msg = (err && err.message) ? String(err.message) : 'Unknown error';
        showAppModal('Failed to save recipe: ' + msg, 'Save Recipe');
    });
}

function continueDissolutionRecipe() {
    continueCreateRecipeToSteps();
}

function continueToRecipeParams() {
    continueDissolutionRecipe();
}

function saveRecipeFromParams() {
    saveDissolutionRecipe();
}

function selectOperation(type) {
    showAppModal('Friability validation and calibration are not part of Dissolution Tester.', 'Unavailable');
}

function openDissolutionCalibration() {
    showProcedureModal(
        'Calibration Procedure',
        PROCEDURE_CALIBRATION_TEMPERATURE,
        function () {
            goToPage('calibration');
        }
    );
}

function openDissolutionValidationOption(kind) {
    if (kind === 'temperature') {
        showProcedureModal(
            'Validation Procedure',
            PROCEDURE_VALIDATION_THERMOMETER,
            function () {
                goToPage('temperature-validation');
            }
        );
        return;
    }
    if (kind === 'rpm') {
        showProcedureModal(
            'Validation Procedure',
            PROCEDURE_VALIDATION_TACHOMETER,
            function () {
                goToPage('rpm-validation');
            }
        );
        return;
    }
    if (kind === 'sample-volume') {
        goToPage('sample-volume-validation');
        return;
    }
    if (kind === 'physical') {
        goToPage('physical-parameters');
        return;
    }
    var labels = {
        temperature: 'Temperature Validation',
        rpm: 'RPM Validation',
        physical: 'Physical Parameters',
        'sample-volume': 'Sample Volume Validation'
    };
    var label = labels[kind] || 'Validation';
    showAppModal(label + ' will be configured later.', 'Validation');
}

var _rpmValLiveTimer = null;
var _rpmValLive = null;

function stopRpmValidationLive() {
    if (_rpmValLiveTimer != null) {
        clearInterval(_rpmValLiveTimer);
        _rpmValLiveTimer = null;
    }
}

function setRpmValLiveDisplay(value) {
    /* Live RPM display removed — tachometer entry is used instead. */
}

function ensureRpmValLiveForValidation(target) {
    return false;
}

function fetchRpmValidationLive() {
    return Promise.resolve(null);
}

function refreshRpmValidationLive() {
    return Promise.resolve(null);
}

function startRpmValidationLive() {
    stopRpmValidationLive();
}

function initRpmValidationPage() {
    var targetEl = document.getElementById('rpm-val-target');
    if (targetEl) {
        targetEl.value = '';
        targetEl.disabled = false;
        bindDissolutionRpmInput(targetEl, { title: 'RPM Validation', asInt: true });
    }
    var tachEl = document.getElementById('rpm-val-tachometer');
    if (tachEl) tachEl.value = '';
    _rpmValLive = null;
    _rpmValMeasuredReady = false;
    _rpmValAbortLocal();
    stopRpmValidationLive();
    _rpmValResetShaftButtons();
}

function initPhysicalParametersPage() {
    var agree = document.getElementById('phys-params-agree');
    var page = document.getElementById('page-physical-parameters');
    if (agree) agree.checked = false;
    if (page) page.scrollTop = 0;
    updatePhysicalParametersDoneState();
}

function updatePhysicalParametersDoneState() {
    var agree = document.getElementById('phys-params-agree');
    var doneBtn = document.getElementById('phys-params-done-btn');
    if (!doneBtn) return;
    doneBtn.disabled = !(agree && agree.checked);
}

function confirmPhysicalParameters() {
    var agree = document.getElementById('phys-params-agree');
    if (!agree || !agree.checked) {
        if (typeof showAppModal === 'function') {
            showAppModal('Please confirm you have read all agreements and parameters.', 'Physical Parameters');
        }
        return;
    }
    if (typeof logAuditEvent === 'function') {
        logAuditEvent(
            'Physical parameters acknowledged',
            'User confirmed reading physical parameters',
            { eventType: 'validation' }
        );
    }
    goToPage('validate-type-select');
}

function startRpmValidationMotor() {
    var targetEl = document.getElementById('rpm-val-target');
    if (targetEl && !enforceDissolutionRpmInput(targetEl, { title: 'RPM Validation', asInt: true })) {
        return;
    }
    var target = targetEl ? parseInt(targetEl.value, 10) : NaN;
    if (isNaN(target) || target <= 0) {
        showAppModal('Please enter a valid target RPM before starting the motor.', 'RPM Validation');
        return;
    }
    if (!isDissolutionRpmInRange(target)) {
        showAppModal(dissolutionRpmRangeMessage('Target'), 'RPM Validation');
        return;
    }
    if (typeof apiRequest !== 'function') {
        showAppModal('API unavailable.', 'RPM Validation');
        return;
    }
    var startBtn = document.getElementById('rpm-val-start-motor-btn');
    if (startBtn) startBtn.disabled = true;
    if (typeof logAuditEvent === 'function') {
        logAuditEvent('Validation started', 'RPM validation motor ' + target, {
            eventType: 'lifecycle',
            entityType: 'validation',
            extra: { validationType: 'rpm', rpm: target }
        });
    }
    return apiRequest(API_BASE + '/api/hardware/disso/rpm/start', {
        method: 'POST',
        body: { rpm: target }
    }).then(function (result) {
        if (startBtn) startBtn.disabled = false;
        if (!result || result.ok === false) {
            showAppModal((result && result.error) || 'Failed to start arm motor (START-PLD).', 'RPM Validation');
            return;
        }
        window._rpmValMotorRunning = true;
        window._rpmValMotorRpm = target;
    }).catch(function (err) {
        if (startBtn) startBtn.disabled = false;
        showAppModal((err && err.message) || 'Failed to start arm motor.', 'RPM Validation');
    });
}

function stopRpmValidationMotor() {
    var rpm = window._rpmValMotorRpm;
    if (rpm == null) {
        var targetEl = document.getElementById('rpm-val-target');
        rpm = targetEl ? parseInt(targetEl.value, 10) : 0;
    }
    if (typeof apiRequest !== 'function') return Promise.resolve();
    return apiRequest(API_BASE + '/api/hardware/disso/rpm/stop', {
        method: 'POST',
        body: { rpm: rpm || 0 }
    }).then(function () {
        window._rpmValMotorRunning = false;
    }).catch(function () {
        window._rpmValMotorRunning = false;
    });
}

var _rpmValShaftUpTimerId = null;
var _rpmValShaftState = { upDisabled: false, downDisabled: false, cmd: 'stop' };

function _rpmValClearShaftTimers() {
    if (_rpmValShaftUpTimerId != null) {
        clearTimeout(_rpmValShaftUpTimerId);
        _rpmValShaftUpTimerId = null;
    }
}

function _rpmValResetShaftButtons() {
    _rpmValClearShaftTimers();
    _rpmValShaftState = { upDisabled: false, downDisabled: false, cmd: 'stop' };
    ['rpm-val-shaft-up', 'rpm-val-shaft-stop', 'rpm-val-shaft-down'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        el.disabled = false;
        el.classList.toggle('is-active', id === 'rpm-val-shaft-stop');
    });
    var statusEl = document.getElementById('rpm-val-shaft-status');
    if (statusEl) statusEl.textContent = 'Stopped';
}

function rpmValShaftCommand(cmd) {
    if (cmd !== 'up' && cmd !== 'down' && cmd !== 'stop') return;
    if (cmd === 'up' && _rpmValShaftState.upDisabled) return;
    if (cmd === 'down' && _rpmValShaftState.downDisabled) return;

    _rpmValShaftState.cmd = cmd;
    var labels = { up: 'Raising', down: 'Lowering', stop: 'Stopped' };
    var statusEl = document.getElementById('rpm-val-shaft-status');
    if (statusEl) statusEl.textContent = labels[cmd] || 'Stopped';
    var map = { up: 'rpm-val-shaft-up', stop: 'rpm-val-shaft-stop', down: 'rpm-val-shaft-down' };
    Object.keys(map).forEach(function (key) {
        var el = document.getElementById(map[key]);
        if (el) el.classList.toggle('is-active', key === cmd);
    });

    if (typeof window.dissoLift === 'function') {
        window.dissoLift(cmd).then(function (res) {
            var body = (res && res.body) ? res.body : res;
            var ok = !!(res && res.ok !== false) && !(body && body.ok === false);
            if (!ok) return res;
            if (cmd === 'down') {
                _rpmValShaftState.downDisabled = true;
                var downEl = document.getElementById('rpm-val-shaft-down');
                if (downEl) {
                    downEl.disabled = true;
                    downEl.classList.remove('is-active');
                }
                if (statusEl) statusEl.textContent = 'Down (home)';
            }
            if (cmd === 'up') {
                _rpmValClearShaftTimers();
                _rpmValShaftUpTimerId = setTimeout(function () {
                    _rpmValShaftUpTimerId = null;
                    _rpmValShaftState.upDisabled = true;
                    var upEl = document.getElementById('rpm-val-shaft-up');
                    if (upEl) {
                        upEl.disabled = true;
                        upEl.classList.remove('is-active');
                    }
                    var st = document.getElementById('rpm-val-shaft-status');
                    if (st) st.textContent = 'Up';
                }, 20000);
            }
            if (cmd === 'stop') {
                _rpmValClearShaftTimers();
            }
            return res;
        }).catch(function () {});
    } else if (cmd === 'stop') {
        _rpmValClearShaftTimers();
    }
}

var _rpmValRunTimerId = null;
var _rpmValRunLeft = 60;
var _rpmValRunActive = false;
var _rpmValMeasuredReady = false;

function _rpmValFmtTimer(sec) {
    var s = Math.max(0, Math.floor(sec));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
}

function _rpmValSetPrimary(label, abortMode) {
    var btn = document.getElementById('rpm-val-primary-btn');
    if (!btn) return;
    btn.textContent = label;
    btn.disabled = false;
    btn.classList.toggle('btn-danger', !!abortMode);
    btn.classList.toggle('is-stop', !!abortMode);
    btn.classList.toggle('btn-primary', !abortMode);
}

function _rpmValSetNextEnabled(on) {
    var btn = document.getElementById('rpm-val-next-btn');
    if (btn) btn.disabled = !on;
}

function _rpmValStopRunTimer() {
    if (_rpmValRunTimerId != null) {
        clearInterval(_rpmValRunTimerId);
        _rpmValRunTimerId = null;
    }
}

function _rpmValPromptMeasured() {
    var tach = document.getElementById('rpm-val-tachometer');
    var current = tach ? tach.value : '';
    var overlay = document.getElementById('app-modal-overlay');
    var titleEl = document.getElementById('app-modal-title');
    var msgEl = document.getElementById('app-modal-message');
    var buttonsEl = document.getElementById('app-modal-buttons');
    if (!overlay || !msgEl || !buttonsEl) {
        var v = window.prompt('Enter measured RPM (tachometer):', current || '');
        if (v == null) return;
        var n = parseFloat(v);
        if (isNaN(n) || n <= 0) {
            showAppModal('Please enter a valid measured RPM.', 'RPM Validation');
            return;
        }
        if (tach) tach.value = String(n);
        _rpmValMeasuredReady = true;
        _rpmValSetNextEnabled(true);
        var hint = document.getElementById('rpm-val-timer-hint');
        if (hint) hint.textContent = 'Measured RPM recorded. Press Next to continue.';
        return;
    }
    titleEl.textContent = 'Measured RPM';
    msgEl.innerHTML = '';
    var p = document.createElement('p');
    p.textContent = 'Enter the RPM measured with a certified tachometer.';
    p.style.marginBottom = '12px';
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'input-field';
    input.min = '1';
    input.max = '300';
    input.step = '0.1';
    input.value = current || '';
    input.style.fontSize = '24px';
    input.style.minHeight = '56px';
    input.style.textAlign = 'center';
    input.style.width = '100%';
    input.onfocus = function () {
        if (typeof openOSKForInput === 'function') openOSKForInput(input);
    };
    msgEl.appendChild(p);
    msgEl.appendChild(input);
    buttonsEl.innerHTML = '';
    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-role-select btn-confirm-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = function () { overlay.style.display = 'none'; };
    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn-role-select btn-confirm-ok';
    okBtn.textContent = 'Confirm';
    okBtn.onclick = function () {
        var n = parseFloat(input.value);
        if (isNaN(n) || n <= 0) {
            showAppModal('Please enter a valid measured RPM.', 'RPM Validation');
            return;
        }
        if (tach) tach.value = String(n);
        _rpmValMeasuredReady = true;
        _rpmValSetNextEnabled(true);
        var hint = document.getElementById('rpm-val-timer-hint');
        if (hint) hint.textContent = 'Measured RPM recorded. Press Next to continue.';
        overlay.style.display = 'none';
    };
    buttonsEl.appendChild(cancelBtn);
    buttonsEl.appendChild(okBtn);
    overlay.style.display = 'flex';
    setTimeout(function () { try { input.focus(); } catch (e) {} }, 50);
}

function onRpmValidationPrimary() {
    if (_rpmValRunActive) {
        showConfirmModal(
            'Do you want to abort RPM validation? Progress will be saved as an aborted report and requires approval.',
            'Abort RPM Validation',
            { okLabel: 'Abort' }
        ).then(function (ok) {
            if (!ok) return;
            if (typeof abortValidationSuite === 'function' && typeof isValidationSuiteActive === 'function' && isValidationSuiteActive()) {
                abortValidationSuite({ reason: 'rpm abort' });
            } else {
                _rpmValAbortLocal();
            }
        });
        return;
    }
    var targetEl = document.getElementById('rpm-val-target');
    if (targetEl && !enforceDissolutionRpmInput(targetEl, { title: 'RPM Validation', asInt: true })) {
        return;
    }
    var target = targetEl ? parseInt(targetEl.value, 10) : NaN;
    if (isNaN(target) || target <= 0) {
        showAppModal('Please enter a valid target RPM before starting.', 'RPM Validation');
        return;
    }
    if (!isDissolutionRpmInRange(target)) {
        showAppModal(dissolutionRpmRangeMessage('Target'), 'RPM Validation');
        return;
    }
    _rpmValMeasuredReady = false;
    _rpmValSetNextEnabled(false);
    var tach = document.getElementById('rpm-val-tachometer');
    if (tach) tach.value = '';
    _rpmValRunActive = true;
    _rpmValRunLeft = 60;
    _rpmValSetPrimary('Abort', true);
    var timerEl = document.getElementById('rpm-val-timer');
    var hint = document.getElementById('rpm-val-timer-hint');
    if (timerEl) timerEl.textContent = _rpmValFmtTimer(_rpmValRunLeft);
    if (hint) hint.textContent = 'Measure paddle / basket RPM with a tachometer';
    if (targetEl) targetEl.disabled = true;

    var startPromise = Promise.resolve();
    if (typeof startRpmValidationMotor === 'function') {
        startPromise = Promise.resolve(startRpmValidationMotor()) || Promise.resolve();
    }
    Promise.resolve(startPromise).catch(function () {}).then(function () {
        _rpmValStopRunTimer();
        _rpmValRunTimerId = setInterval(function () {
            _rpmValRunLeft -= 1;
            if (timerEl) timerEl.textContent = _rpmValFmtTimer(_rpmValRunLeft);
            if (_rpmValRunLeft <= 0) {
                _rpmValStopRunTimer();
                _rpmValRunActive = false;
                if (typeof stopRpmValidationMotor === 'function') stopRpmValidationMotor();
                _rpmValSetPrimary('Start Validation', false);
                if (targetEl) targetEl.disabled = false;
                if (hint) hint.textContent = 'Timer complete. Enter measured RPM.';
                _rpmValPromptMeasured();
            }
        }, 1000);
    });
}

function _rpmValAbortLocal() {
    _rpmValStopRunTimer();
    _rpmValRunActive = false;
    if (typeof stopRpmValidationMotor === 'function') stopRpmValidationMotor();
    _rpmValSetPrimary('Start Validation', false);
    _rpmValSetNextEnabled(false);
    var targetEl = document.getElementById('rpm-val-target');
    if (targetEl) targetEl.disabled = false;
    var timerEl = document.getElementById('rpm-val-timer');
    var hint = document.getElementById('rpm-val-timer-hint');
    if (timerEl) timerEl.textContent = '01:00';
    if (hint) hint.textContent = 'Press Start Validation to begin';
}

function onRpmValidationNext() {
    if (!_rpmValMeasuredReady) {
        showAppModal('Complete the validation timer and enter measured RPM first.', 'RPM Validation');
        return;
    }
    if (typeof runRpmValidation === 'function') runRpmValidation();
}

function runRpmValidation() {
    var targetEl = document.getElementById('rpm-val-target');
    var tachEl = document.getElementById('rpm-val-tachometer');
    if (targetEl && !enforceDissolutionRpmInput(targetEl, { title: 'RPM Validation', asInt: true })) {
        return;
    }
    var target = targetEl ? parseFloat(targetEl.value) : NaN;
    var tachometer = tachEl ? parseFloat(tachEl.value) : NaN;
    if (isNaN(target) || target <= 0) {
        showAppModal('Please enter a valid target RPM.', 'RPM Validation');
        return;
    }
    if (!isDissolutionRpmInRange(target)) {
        showAppModal(dissolutionRpmRangeMessage('Target'), 'RPM Validation');
        return;
    }
    if (isNaN(tachometer) || tachometer <= 0) {
        showAppModal('Please enter the RPM measured with a certified tachometer.', 'RPM Validation');
        return;
    }

    var finishValidation = function () {
        var delta = tachometer - target;
        var nowIso = (typeof getDisplayedKioskDateTimeIso === 'function')
            ? getDisplayedKioskDateTimeIso()
            : new Date().toISOString();
        window._rpmValLastResult = {
            target: target,
            live: tachometer,
            tachometer: tachometer,
            delta: delta,
            usedDummy: false,
            source: 'tachometer',
            completedAt: nowIso,
            startedAt: nowIso
        };

        if (typeof logAuditEvent === 'function') {
            logAuditEvent(
                'Validation finished',
                'RPM validation completed',
                {
                    eventType: 'lifecycle',
                    entityType: 'validation',
                    extra: {
                        validationType: 'rpm',
                        target: target,
                        tachometer: tachometer,
                        delta: delta,
                        source: 'tachometer'
                    }
                }
            );
        }

        stopRpmValidationLive();
        goToPage('rpm-validation-result');
    };

    // Ensure motor is commanded for this target, then stop before recording result.
    var motorChain = Promise.resolve();
    if (typeof apiRequest === 'function') {
        motorChain = apiRequest(API_BASE + '/api/hardware/disso/rpm/start', {
            method: 'POST',
            body: { rpm: Math.round(target) }
        }).then(function (result) {
            if (!result || result.ok === false) {
                throw new Error((result && result.error) || 'START-PLD failed');
            }
            window._rpmValMotorRunning = true;
            window._rpmValMotorRpm = Math.round(target);
            return stopRpmValidationMotor();
        });
    }
    motorChain.then(finishValidation).catch(function (err) {
        showAppModal((err && err.message) || 'Arm motor command failed.', 'RPM Validation');
    });
}

function initRpmValidationResultPage() {
    var data = window._rpmValLastResult;
    var targetEl = document.getElementById('rpm-val-result-target');
    var tachResultEl = document.getElementById('rpm-val-result-tachometer');
    var deltaResultEl = document.getElementById('rpm-val-result-delta');
    var tbody = document.getElementById('rpm-val-result-tbody');
    var openBtn = document.getElementById('rpm-val-open-report-btn');
    var banner = document.getElementById('rpm-val-result-banner');
    var bannerStatus = document.getElementById('rpm-val-result-banner-status');
    var bannerNote = document.getElementById('rpm-val-result-banner-note');

    if (!data) {
        if (targetEl) targetEl.textContent = '—';
        if (tachResultEl) tachResultEl.textContent = '—';
        if (deltaResultEl) deltaResultEl.textContent = '—';
        if (tbody) tbody.innerHTML = '<tr><td colspan="3">No validation data. Run RPM Validation first.</td></tr>';
        if (openBtn) openBtn.disabled = true;
        if (banner) banner.classList.remove('is-pass', 'is-fail');
        if (bannerStatus) bannerStatus.textContent = 'No data';
        if (bannerNote) bannerNote.textContent = '';
        return;
    }

    var measured = (data.tachometer != null) ? Number(data.tachometer) : Number(data.live);
    var dlt = (data.delta >= 0 ? '+' : '') + Number(data.delta).toFixed(2);
    if (openBtn) openBtn.disabled = false;
    if (targetEl) targetEl.textContent = String(data.target);
    if (tachResultEl) {
        tachResultEl.textContent = (typeof formatHardwareRpmDisplay === 'function')
            ? formatHardwareRpmDisplay(measured)
            : String(measured);
    }
    if (deltaResultEl) deltaResultEl.textContent = dlt;
    if (banner) banner.classList.remove('is-pass', 'is-fail');
    if (bannerStatus) bannerStatus.textContent = 'Completed';
    if (bannerNote) bannerNote.textContent = 'Measured with certified tachometer.';
    if (!tbody) return;
    tbody.innerHTML =
        '<tr>' +
            '<td>Paddle / Basket</td>' +
            '<td>' + ((typeof formatHardwareRpmDisplay === 'function')
                ? formatHardwareRpmDisplay(measured)
                : String(measured)) + '</td>' +
            '<td>' + dlt + '</td>' +
        '</tr>';
}

function buildRpmValidationReportPayload() {
    var data = window._rpmValLastResult;
    if (!data) return null;
    var user = window.currentUser || {};
    var nowIso = data.completedAt || ((typeof getDisplayedKioskDateTimeIso === 'function')
        ? getDisplayedKioskDateTimeIso()
        : new Date().toISOString());
    var startIso = data.startedAt || nowIso;
    var statusLabel = data.statusText || 'Completed';
    var measured = (data.tachometer != null) ? data.tachometer : data.live;
    var reportPayload = {
        name: 'RPM Validation - ' + statusLabel,
        type: 'validation',
        validationSubtype: 'rpm',
        status: statusLabel,
        rpm: data.target,
        currentRpm: measured,
        tachometerRpm: measured,
        delta: data.delta,
        validationStartTime: startIso,
        validationEndTime: nowIso,
        createdAt: nowIso,
        completedAt: nowIso,
        testData: {
            validationSubtype: 'rpm',
            rpm: data.target,
            currentRpm: measured,
            tachometerRpm: measured,
            delta: data.delta,
            source: 'tachometer',
            status: statusLabel,
            validationStartTime: startIso,
            validationEndTime: nowIso,
            testStartTime: startIso,
            testEndTime: nowIso,
            operatorName: user.name || user.username || '--',
            employeeId: user.username || '--',
            operatorUsername: user.username || '--',
            createdAt: nowIso,
            completedAt: nowIso
        }
    };
    if (typeof stampOperatorOnTestReportPayload === 'function') {
        return stampOperatorOnTestReportPayload(reportPayload);
    }
    return reportPayload;
}

function saveRpmValidationReportAndOpenPreview() {
    var payload = buildRpmValidationReportPayload();
    if (!payload) {
        showAppModal('No RPM validation data to save.', 'Validation Report');
        return Promise.resolve(null);
    }
    currentReportFilter = 'validation';
    var openBtn = document.getElementById('rpm-val-open-report-btn');
    if (openBtn) openBtn.disabled = true;
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            var reportId = result && result.id;
            if (!reportId) {
                goToPage('reports');
                return null;
            }
            if (typeof logTestReportSavedAudit === 'function') logTestReportSavedAudit(reportId, payload);
            if (typeof openReportPreview === 'function') openReportPreview(reportId, { setGate: true });
            else goToPage('reports');
            return reportId;
        })
        .catch(function (err) {
            console.error('Failed to save RPM validation report', err);
            if (openBtn) openBtn.disabled = false;
            currentReportFilter = 'validation';
            showAppModal('Failed to save validation report.', 'Validation Report');
            goToPage('reports');
            return null;
        });
}

function openRpmValidationReport() {
    return saveRpmValidationReportAndOpenPreview();
}

function resetRpmValidation() {
    if (typeof stopRpmValidationMotor === 'function') {
        stopRpmValidationMotor();
    }
    var target = document.getElementById('rpm-val-target');
    var tach = document.getElementById('rpm-val-tachometer');
    if (target) target.value = '';
    if (tach) tach.value = '';
    _rpmValLive = null;
    _rpmValResetShaftButtons();
    initRpmValidationPage();
}

function initSampleVolumeValidationPage() {
    setTempValResultBadge(document.getElementById('sv-val-overall'), null);
    var deltaEl = document.getElementById('sv-val-delta');
    var resultEl = document.getElementById('sv-val-result');
    if (deltaEl) deltaEl.textContent = '—';
    setTempValResultBadge(resultEl, null);
}

function runSampleVolumeValidation() {
    var targetEl = document.getElementById('sv-val-target');
    var tolEl = document.getElementById('sv-val-tolerance');
    var measuredEl = document.getElementById('sv-val-measured');
    var target = targetEl ? parseFloat(targetEl.value) : NaN;
    var tolerance = tolEl ? parseFloat(tolEl.value) : NaN;
    var measured = measuredEl ? parseFloat(measuredEl.value) : NaN;
    if (isNaN(target) || target <= 0) {
        showAppModal('Please enter a valid target volume (mL).', 'Sample Volume Validation');
        return;
    }
    if (isNaN(tolerance) || tolerance < 0) {
        showAppModal('Please enter a valid tolerance (≥ 0 mL).', 'Sample Volume Validation');
        return;
    }
    if (isNaN(measured) || measured < 0) {
        showAppModal('Please enter the measured volume (mL).', 'Sample Volume Validation');
        return;
    }

    var delta = measured - target;
    var pass = Math.abs(delta) <= tolerance;
    var deltaEl = document.getElementById('sv-val-delta');
    if (deltaEl) deltaEl.textContent = (delta >= 0 ? '+' : '') + delta.toFixed(2);
    setTempValResultBadge(document.getElementById('sv-val-result'), pass ? 'pass' : 'fail');
    setTempValResultBadge(document.getElementById('sv-val-overall'), pass ? 'pass' : 'fail');

    var nowIso = (typeof getDisplayedKioskDateTimeIso === 'function')
        ? getDisplayedKioskDateTimeIso()
        : new Date().toISOString();
    window._svValLastResult = {
        allPass: pass,
        statusText: pass ? 'Pass' : 'Fail',
        target: target,
        tolerance: tolerance,
        measured: measured,
        delta: delta,
        completedAt: nowIso,
        startedAt: nowIso
    };

    if (typeof logAuditEvent === 'function') {
        logAuditEvent(
            'Validation finished',
            'Sample volume validation: ' + (pass ? 'Pass' : 'Fail'),
            {
                eventType: 'lifecycle',
                entityType: 'validation',
                extra: {
                    validationType: 'sample-volume',
                    status: pass ? 'Pass' : 'Fail',
                    target: target,
                    tolerance: tolerance,
                    measured: measured
                }
            }
        );
    }

    goToPage('sample-volume-validation-result');
}

function initSampleVolumeValidationResultPage() {
    var data = window._svValLastResult;
    var overallEl = document.getElementById('sv-val-result-overall');
    var targetEl = document.getElementById('sv-val-result-target');
    var toleranceEl = document.getElementById('sv-val-result-tolerance');
    var tbody = document.getElementById('sv-val-result-tbody');
    var openBtn = document.getElementById('sv-val-open-report-btn');
    var banner = document.getElementById('sv-val-result-banner');
    var bannerStatus = document.getElementById('sv-val-result-banner-status');
    var bannerNote = document.getElementById('sv-val-result-banner-note');

    if (!data) {
        setTempValResultBadge(overallEl, null);
        if (targetEl) targetEl.textContent = '—';
        if (toleranceEl) toleranceEl.textContent = '—';
        if (tbody) tbody.innerHTML = '<tr><td colspan="4">No validation data. Run Sample Volume Validation first.</td></tr>';
        if (openBtn) openBtn.disabled = true;
        if (banner) banner.classList.remove('is-pass', 'is-fail');
        if (bannerStatus) bannerStatus.textContent = 'No data';
        if (bannerNote) bannerNote.textContent = '';
        return;
    }

    if (openBtn) openBtn.disabled = false;
    setTempValResultBadge(overallEl, data.allPass ? 'pass' : 'fail');
    if (targetEl) targetEl.textContent = Number(data.target).toFixed(1) + ' mL';
    if (toleranceEl) toleranceEl.textContent = '± ' + Number(data.tolerance).toFixed(1) + ' mL';
    if (banner) {
        banner.classList.remove('is-pass', 'is-fail');
        banner.classList.add(data.allPass ? 'is-pass' : 'is-fail');
    }
    if (bannerStatus) bannerStatus.textContent = data.allPass ? 'PASS' : 'FAIL';
    if (bannerNote) bannerNote.textContent = 'Measured volume entered by operator.';
    if (!tbody) return;
    var passLabel = data.allPass ? 'PASS' : 'FAIL';
    var passClass = data.allPass ? 'is-pass' : 'is-fail';
    var dlt = (data.delta >= 0 ? '+' : '') + Number(data.delta).toFixed(2);
    tbody.innerHTML =
        '<tr>' +
            '<td>Sample volume</td>' +
            '<td>' + Number(data.measured).toFixed(2) + '</td>' +
            '<td>' + dlt + '</td>' +
            '<td><span class="temp-val-result-badge ' + passClass + '">' + passLabel + '</span></td>' +
        '</tr>';
}

function buildSampleVolumeValidationReportPayload() {
    var data = window._svValLastResult;
    if (!data) return null;
    var user = window.currentUser || {};
    var nowIso = data.completedAt || ((typeof getDisplayedKioskDateTimeIso === 'function')
        ? getDisplayedKioskDateTimeIso()
        : new Date().toISOString());
    var startIso = data.startedAt || nowIso;
    var statusLabel = data.statusText || (data.allPass ? 'Pass' : 'Fail');
    var reportPayload = {
        name: 'Sample Volume Validation - ' + statusLabel,
        type: 'validation',
        validationSubtype: 'sample-volume',
        status: statusLabel,
        sampleVolumeTarget: data.target,
        sampleVolumeMeasured: data.measured,
        sampleVolumeTolerance: data.tolerance,
        sampleVolumePass: data.allPass,
        delta: data.delta,
        validationStartTime: startIso,
        validationEndTime: nowIso,
        createdAt: nowIso,
        completedAt: nowIso,
        testData: {
            validationSubtype: 'sample-volume',
            sampleVolumeTarget: data.target,
            sampleVolumeMeasured: data.measured,
            sampleVolumeTolerance: data.tolerance,
            sampleVolumePass: data.allPass,
            delta: data.delta,
            status: statusLabel,
            validationStartTime: startIso,
            validationEndTime: nowIso,
            testStartTime: startIso,
            testEndTime: nowIso,
            operatorName: user.name || user.username || '--',
            employeeId: user.username || '--',
            operatorUsername: user.username || '--',
            createdAt: nowIso,
            completedAt: nowIso
        }
    };
    if (typeof stampOperatorOnTestReportPayload === 'function') {
        return stampOperatorOnTestReportPayload(reportPayload);
    }
    return reportPayload;
}

function saveSampleVolumeValidationReportAndOpenPreview() {
    var payload = buildSampleVolumeValidationReportPayload();
    if (!payload) {
        showAppModal('No sample volume validation data to save.', 'Validation Report');
        return Promise.resolve(null);
    }
    currentReportFilter = 'validation';
    var openBtn = document.getElementById('sv-val-open-report-btn');
    if (openBtn) openBtn.disabled = true;
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            var reportId = result && result.id;
            if (!reportId) {
                goToPage('reports');
                return null;
            }
            if (typeof logTestReportSavedAudit === 'function') logTestReportSavedAudit(reportId, payload);
            if (typeof openReportPreview === 'function') openReportPreview(reportId, { setGate: true });
            else goToPage('reports');
            return reportId;
        })
        .catch(function (err) {
            console.error('Failed to save sample volume validation report', err);
            if (openBtn) openBtn.disabled = false;
            currentReportFilter = 'validation';
            showAppModal('Failed to save validation report.', 'Validation Report');
            goToPage('reports');
            return null;
        });
}

function openSampleVolumeValidationReport() {
    return saveSampleVolumeValidationReportAndOpenPreview();
}

function resetSampleVolumeValidation() {
    var target = document.getElementById('sv-val-target');
    var tolerance = document.getElementById('sv-val-tolerance');
    var measured = document.getElementById('sv-val-measured');
    if (target) target.value = '10';
    if (tolerance) tolerance.value = '10';
    if (measured) measured.value = '';
    initSampleVolumeValidationPage();
}

var TEMP_VAL_VESSEL_COUNT = 6;
var TEMP_VAL_TEMP_MIN = 15;
var TEMP_VAL_TEMP_MAX = 55;
var TEMP_VAL_TOLERANCE = 0.5;
var _tempValLiveTimer = null;
var _tempValLive = {
    bath: null,
    external: null,
    vessels: [null, null, null, null, null, null]
};

function stopTemperatureValidationLive() {
    if (_tempValLiveTimer != null) {
        clearInterval(_tempValLiveTimer);
        _tempValLiveTimer = null;
    }
}

function setTempValResultBadge(el, status) {
    if (!el) return;
    el.classList.remove('is-pass', 'is-fail', 'is-pending');
    if (status === 'pass') {
        el.textContent = 'PASS';
        el.classList.add('is-pass');
    } else if (status === 'fail') {
        el.textContent = 'FAIL';
        el.classList.add('is-fail');
    } else {
        el.textContent = '—';
        el.classList.add('is-pending');
    }
}

function clearTempValPairResult(prefix) {
    var deltaEl = document.getElementById(prefix + '-delta');
    var resultEl = document.getElementById(prefix + '-result');
    if (deltaEl) deltaEl.textContent = '—';
    setTempValResultBadge(resultEl, null);
}

function formatTempValLive(value) {
    if (value == null || isNaN(value)) return '--.- °C';
    return Number(value).toFixed(1) + ' °C';
}

function setTempValLiveDisplay(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = formatTempValLive(value);
}

function getTempValReferenceValue(inputId) {
    var el = document.getElementById(inputId);
    return el ? parseFloat(String(el.value || '').trim()) : NaN;
}

function resolveTempValExternalLive(data) {
    if (!data) return null;
    if (data.external != null && !isNaN(Number(data.external))) {
        return Number(data.external);
    }
    var vessels = Array.isArray(data.vessels) ? data.vessels : [];
    for (var i = 0; i < vessels.length; i++) {
        if (vessels[i] != null && !isNaN(Number(vessels[i]))) {
            return Number(vessels[i]);
        }
    }
    return null;
}

function applyTemperatureHardwareLive(data) {
    if (!data) return;
    var bath = (data.bath != null && !isNaN(Number(data.bath))) ? Number(data.bath) : null;
    _tempValLive.bath = bath;
    setTempValLiveDisplay('temp-val-bath-live', bath);
    var external = resolveTempValExternalLive(data);
    _tempValLive.external = external;
    setTempValLiveDisplay('temp-val-external-live', external);
    var vessels = Array.isArray(data.vessels) ? data.vessels : [];
    for (var i = 0; i < TEMP_VAL_VESSEL_COUNT; i++) {
        var v = vessels[i];
        var num = (v != null && !isNaN(Number(v))) ? Number(v) : null;
        _tempValLive.vessels[i] = num;
        setTempValLiveDisplay('temp-val-v' + (i + 1) + '-live', num);
    }
}

function fetchTemperatureHardwareLive() {
    return apiRequest(API_BASE + '/api/hardware/disso/temperature/live', { method: 'GET' })
        .then(function (res) {
            if (res && res.data) return res.data;
            return res || {};
        })
        .catch(function () {
            return apiRequest(API_BASE + '/api/hardware/temperature/live', { method: 'GET' });
        });
}

function refreshTemperatureValidationLive() {
    return fetchTemperatureHardwareLive().then(function (data) {
        applyTemperatureHardwareLive(data || {});
        return data;
    }).catch(function () {
        // Keep last good readings; show dashes only if never received
        if (_tempValLive.bath == null) {
            setTempValLiveDisplay('temp-val-bath-live', null);
            setTempValLiveDisplay('temp-val-external-live', null);
            for (var i = 0; i < TEMP_VAL_VESSEL_COUNT; i++) {
                setTempValLiveDisplay('temp-val-v' + (i + 1) + '-live', null);
            }
        }
        return null;
    });
}

function startTemperatureValidationLive() {
    stopTemperatureValidationLive();
    refreshTemperatureValidationLive();
    _tempValLiveTimer = setInterval(function () {
        if (typeof getActivePageName === 'function' && getActivePageName() !== 'temperature-validation') {
            stopTemperatureValidationLive();
            return;
        }
        refreshTemperatureValidationLive();
    }, 1000);
}

function evaluateTempValLiveVsReference(liveValue, reference) {
    var live = (liveValue == null) ? NaN : Number(liveValue);
    var ref = (reference == null) ? NaN : Number(reference);
    if (isNaN(ref)) {
        return { ok: false, missing: true, delta: null, live: isNaN(live) ? null : live, reference: null };
    }
    if (isNaN(live)) {
        return { ok: false, missing: true, delta: null, live: null, reference: ref };
    }
    var delta = live - ref;
    return { ok: true, missing: false, delta: delta, live: live, reference: ref };
}

function buildTemperatureValidationVessels() {
    var grid = document.getElementById('temp-val-vessel-grid');
    if (!grid) return;
    var html = '';
    for (var i = 1; i <= TEMP_VAL_VESSEL_COUNT; i++) {
        html +=
            '<div class="temp-val-vessel" data-vessel="' + i + '">' +
                '<div class="temp-val-vessel-label">Vessel ' + i + '</div>' +
                '<div class="temp-val-vessel-art">' +
                    '<img src="assets/vessel.svg" alt="" class="temp-val-vessel-img" draggable="false">' +
                    '<div class="temp-val-vessel-temp" id="temp-val-v' + i + '-live" aria-live="polite">--.- °C</div>' +
                '</div>' +
                '<div class="temp-val-vessel-reference">' +
                    '<label for="temp-val-v' + i + '-actual">Actual (°C)</label>' +
                    '<input type="number" id="temp-val-v' + i + '-actual" class="input-field"' +
                        ' min="15" max="55" step="0.1" inputmode="decimal" placeholder="Thermometer"' +
                        ' aria-label="Vessel ' + i + ' reference temperature degrees Celsius"' +
                        ' onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)">' +
                '</div>' +
            '</div>';
    }
    grid.innerHTML = html;
}

function initTemperatureValidationPage() {
    buildTemperatureValidationVessels();
    startTemperatureValidationLive();
}

function runTemperatureValidation() {
    var bathRef = getTempValReferenceValue('temp-val-bath-actual');
    var externalRef = getTempValReferenceValue('temp-val-external-actual');
    var vesselRefs = [];
    var i;
    for (i = 1; i <= TEMP_VAL_VESSEL_COUNT; i++) {
        vesselRefs.push(getTempValReferenceValue('temp-val-v' + i + '-actual'));
    }

    function isValidRef(val) {
        return !isNaN(val) && val >= TEMP_VAL_TEMP_MIN && val <= TEMP_VAL_TEMP_MAX;
    }

    if (!isValidRef(bathRef) || !isValidRef(externalRef)) {
        showAppModal(
            'Please enter bath and external reference temperatures between ' +
            TEMP_VAL_TEMP_MIN + ' and ' + TEMP_VAL_TEMP_MAX + ' °C.',
            'Temperature Validation'
        );
        return;
    }
    for (i = 0; i < vesselRefs.length; i++) {
        if (!isValidRef(vesselRefs[i])) {
            showAppModal(
                'Please enter a reference temperature for every vessel (' +
                TEMP_VAL_TEMP_MIN + '–' + TEMP_VAL_TEMP_MAX + ' °C).',
                'Temperature Validation'
            );
            return;
        }
    }

    refreshTemperatureValidationLive().then(function () {
        var bathResult = evaluateTempValLiveVsReference(_tempValLive.bath, bathRef);
        var externalResult = evaluateTempValLiveVsReference(_tempValLive.external, externalRef);
        var vesselResults = [];
        for (i = 0; i < TEMP_VAL_VESSEL_COUNT; i++) {
            vesselResults.push(evaluateTempValLiveVsReference(_tempValLive.vessels[i], vesselRefs[i]));
        }

        var channels = [
            {
                key: 'bath',
                label: 'Bath',
                live: bathResult.live,
                reference: bathRef,
                delta: bathResult.delta
            },
            {
                key: 'external',
                label: 'External',
                live: externalResult.live,
                reference: externalRef,
                delta: externalResult.delta
            }
        ];
        for (i = 1; i <= TEMP_VAL_VESSEL_COUNT; i++) {
            var vr = vesselResults[i - 1];
            channels.push({
                key: 'v' + i,
                label: 'Vessel ' + i,
                live: vr.live,
                reference: vesselRefs[i - 1],
                delta: vr.delta
            });
        }

        var allPass = true;
        var hasComparable = false;
        channels.forEach(function (ch) {
            if (ch.delta == null || isNaN(ch.delta)) return;
            hasComparable = true;
            if (Math.abs(Number(ch.delta)) > TEMP_VAL_TOLERANCE) allPass = false;
        });
        if (!hasComparable) allPass = false;

        var nowIso = (typeof getDisplayedKioskDateTimeIso === 'function')
            ? getDisplayedKioskDateTimeIso()
            : new Date().toISOString();
        window._tempValLastResult = {
            channels: channels,
            tolerance: TEMP_VAL_TOLERANCE,
            allPass: allPass,
            statusText: allPass ? 'Pass' : 'Fail',
            completedAt: nowIso,
            startedAt: nowIso
        };

        if (typeof logAuditEvent === 'function') {
            logAuditEvent(
                'Validation finished',
                'Temperature validation ' + (allPass ? 'passed' : 'failed'),
                {
                    eventType: 'lifecycle',
                    entityType: 'validation',
                    extra: {
                        validationType: 'temperature',
                        allPass: allPass,
                        tolerance: TEMP_VAL_TOLERANCE
                    }
                }
            );
        }

        if (typeof stopTemperatureValidationLive === 'function') stopTemperatureValidationLive();
        goToPage('temperature-validation-result');
    });
}

function formatTempValDelta(delta) {
    if (delta == null || isNaN(delta)) return '—';
    var n = Number(delta);
    return (n >= 0 ? '+' : '') + n.toFixed(2);
}

function initTemperatureValidationResultPage() {
    var data = window._tempValLastResult;
    var statusEl = document.getElementById('temp-val-result-status');
    var tbody = document.getElementById('temp-val-result-tbody');
    var openBtn = document.getElementById('temp-val-open-report-btn');
    var banner = document.getElementById('temp-val-result-banner');
    var bannerStatus = document.getElementById('temp-val-result-banner-status');
    var bannerNote = document.getElementById('temp-val-result-banner-note');

    if (!data) {
        if (statusEl) statusEl.textContent = '—';
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="4">No validation data. Run Temperature Validation first.</td></tr>';
        }
        if (openBtn) openBtn.disabled = true;
        if (banner) banner.classList.remove('is-pass', 'is-fail');
        if (bannerStatus) bannerStatus.textContent = 'No data';
        if (bannerNote) bannerNote.textContent = '';
        return;
    }

    if (openBtn) openBtn.disabled = false;
    if (statusEl) statusEl.textContent = data.statusText || (data.allPass ? 'Pass' : 'Fail');

    if (banner) {
        banner.classList.remove('is-pass', 'is-fail');
        if (data.allPass) banner.classList.add('is-pass');
        else banner.classList.add('is-fail');
    }
    if (bannerStatus) bannerStatus.textContent = data.statusText || (data.allPass ? 'Pass' : 'Fail');
    if (bannerNote) {
        bannerNote.textContent = 'Tolerance ±' + Number(data.tolerance || TEMP_VAL_TOLERANCE).toFixed(1) + ' °C (live vs reference).';
    }

    if (!tbody) return;
    var rows = (data.channels || []).map(function (ch) {
        return '<tr>' +
            '<td>' + (ch.label || '--') + '</td>' +
            '<td>' + (ch.live != null ? Number(ch.live).toFixed(1) : '--') + '</td>' +
            '<td>' + (ch.reference != null ? Number(ch.reference).toFixed(1) : '--') + '</td>' +
            '<td>' + formatTempValDelta(ch.delta) + '</td>' +
            '</tr>';
    });
    tbody.innerHTML = rows.join('') || '<tr><td colspan="4">No channel data.</td></tr>';
}

function buildTemperatureValidationReportPayload() {
    var data = window._tempValLastResult;
    if (!data) return null;
    var user = window.currentUser || {};
    var nowIso = data.completedAt || ((typeof getDisplayedKioskDateTimeIso === 'function')
        ? getDisplayedKioskDateTimeIso()
        : new Date().toISOString());
    var startIso = data.startedAt || nowIso;
    var statusLabel = data.statusText || (data.allPass ? 'Pass' : 'Fail');
    var channels = data.channels || [];
    var reportPayload = {
        name: 'Temperature Validation - ' + statusLabel,
        type: 'validation',
        validationSubtype: 'temperature',
        status: statusLabel,
        usp: 'Temperature',
        tolerance: data.tolerance != null ? data.tolerance : TEMP_VAL_TOLERANCE,
        allPass: !!data.allPass,
        temperatureChannels: channels,
        validationStartTime: startIso,
        validationEndTime: nowIso,
        createdAt: nowIso,
        completedAt: nowIso,
        testData: {
            validationSubtype: 'temperature',
            usp: 'Temperature',
            tolerance: data.tolerance != null ? data.tolerance : TEMP_VAL_TOLERANCE,
            allPass: !!data.allPass,
            temperatureChannels: channels,
            status: statusLabel,
            validationStartTime: startIso,
            validationEndTime: nowIso,
            testStartTime: startIso,
            testEndTime: nowIso,
            operatorName: user.name || user.username || '--',
            employeeId: user.username || '--',
            operatorUsername: user.username || '--',
            createdAt: nowIso,
            completedAt: nowIso
        }
    };
    if (typeof stampOperatorOnTestReportPayload === 'function') {
        return stampOperatorOnTestReportPayload(reportPayload);
    }
    return reportPayload;
}

function saveTemperatureValidationReportAndOpenPreview() {
    var payload = buildTemperatureValidationReportPayload();
    if (!payload) {
        showAppModal('No temperature validation data to save.', 'Validation Report');
        return Promise.resolve(null);
    }
    currentReportFilter = 'validation';
    var openBtn = document.getElementById('temp-val-open-report-btn');
    if (openBtn) openBtn.disabled = true;
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            var reportId = result && result.id;
            if (!reportId) {
                goToPage('reports');
                return null;
            }
            if (typeof logTestReportSavedAudit === 'function') {
                logTestReportSavedAudit(reportId, payload);
            }
            if (typeof openReportPreview === 'function') {
                openReportPreview(reportId, { setGate: true });
            } else {
                goToPage('reports');
            }
            return reportId;
        })
        .catch(function (err) {
            console.error('Failed to save temperature validation report', err);
            if (openBtn) openBtn.disabled = false;
            currentReportFilter = 'validation';
            showAppModal('Failed to save validation report.', 'Validation Report');
            goToPage('reports');
            return null;
        });
}

function openTemperatureValidationReport() {
    return saveTemperatureValidationReportAndOpenPreview();
}

function resetTemperatureValidation() {
    ['temp-val-bath-actual', 'temp-val-external-actual'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    for (var i = 1; i <= TEMP_VAL_VESSEL_COUNT; i++) {
        var vEl = document.getElementById('temp-val-v' + i + '-actual');
        if (vEl) vEl.value = '';
    }
    initTemperatureValidationPage();
}

function startValidationFromType() {
    showAppModal('Friability validation is not available on Dissolution Tester.', 'Unavailable');
}

function goBackFromValidationRun() {
    if (typeof isValidationNavigationBlocked === 'function' && isValidationNavigationBlocked()) {
        confirmAbortValidationForNavigation().then(function (didAbort) {
            if (!didAbort) return;
            _suppressValidationRunNavGuardOnce = true;
            goToPage('validate-type-select');
        });
        return;
    }
    if (validationRunIntervalId != null) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
    }
    if (validationRunTimerIntervalId != null) {
        clearInterval(validationRunTimerIntervalId);
        validationRunTimerIntervalId = null;
    }
    validationRunState = 'idle';
    resetValidationRpmTracking();
    setValidationDrumSpinning(false);
    goToPage('validate-type-select');
}

function setValRunEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
}

function setValidationRotationDisplay(count) {
    var v = String(count == null ? 0 : count);
    setValRunEl('val-run-rotation-count', v);
    setValRunEl('val-drum-rotation', v);
}

function setValidationTimeDisplay(value) {
    var v = String(value == null ? '00:00' : value);
    setValRunEl('val-run-time-min', v);
    setValRunEl('val-drum-timer', v);
    setValRunEl('val-run-timer-digital', v);
}

function setValRunStatusText(statusText) {
    setValRunEl('val-run-status', statusText);
    var el = document.getElementById('val-run-status');
    if (!el) return;
    var norm = String(statusText || '').toLowerCase();
    el.classList.remove('is-ready', 'is-running', 'is-completed', 'is-aborted');
    if (norm === 'running' || norm === 'starting') el.classList.add('is-running');
    else if (norm === 'completed') el.classList.add('is-completed');
    else if (norm === 'aborted') el.classList.add('is-aborted');
    else el.classList.add('is-ready');
}

function setValResultCardVisible(visible) {
    var resultCard = document.getElementById('val-result-card');
    if (!resultCard) return;
    if (visible) {
        resultCard.hidden = false;
        resultCard.removeAttribute('hidden');
        try { resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) {}
    } else {
        resultCard.hidden = true;
    }
}

function setValRunPrimaryButton(mode) {
    var btn = document.getElementById('btn-validation-start-abort');
    if (!btn) return;
    if (mode === 'abort') {
        btn.className = 'btn btn-primary val-run-start-btn is-abort';
        btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9726;</span><span id="btn-validation-label">Abort</span>';
        return;
    }
    btn.className = 'btn btn-primary val-run-start-btn';
    btn.innerHTML = '<span class="ctrl-icon" aria-hidden="true">&#9654;</span><span id="btn-validation-label">Start Validation</span>';
}

function formatValidationElapsed(sec) {
    var s = Math.max(0, parseInt(sec, 10) || 0);
    var mm = Math.floor(s / 60);
    var ss = s % 60;
    return String(mm).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

function setValidationDrumSpinning(spinning) {
    var inner = document.getElementById('val-drum-inner');
    if (!inner) return;
    inner.style.animationDuration = (60 / VALIDATION_USP_RPM) + 's';
    inner.classList.toggle('tr-spinning', !!spinning);
}

function getValidationRpmMin() {
    return VALIDATION_USP_RPM - VALIDATION_USP_RPM_TOLERANCE;
}

function getValidationRpmMax() {
    return VALIDATION_USP_RPM + VALIDATION_USP_RPM_TOLERANCE;
}

function resetValidationRpmTracking() {
    validationRunLiveRpm = null;
    validationRunLiveRpmLastMs = null;
    validationRunLastHwCount = 0;
    validationRunLastHwCountMs = null;
    validationRunRpmAllPass = true;
    setValRunEl('val-run-current-rpm', '--');
    var curEl = document.getElementById('val-run-current-rpm');
    if (curEl) {
        curEl.classList.remove('validation-rpm-ok', 'validation-rpm-fail');
    }
    setValRunEl('val-run-rpm-sub', VALIDATION_USP_RPM + ' ±' + VALIDATION_USP_RPM_TOLERANCE + ' · live');
}

function getValidationStartupMaskedRpm(count) {
    var n = parseInt(count, 10);
    if (isNaN(n) || n < 1 || n > VALIDATION_STARTUP_RPM_VALUES.length) return null;
    return VALIDATION_STARTUP_RPM_VALUES[n - 1];
}

function isValidationEspRpmMissing(state) {
    if (!state) return false;
    if (state.rpmPending) return true;
    var norm = String(state.normalized || state.line || '').trim();
    return /^\d+,--$/.test(norm);
}

function computeValidationRpmFromRotations(rotationDelta, windowSec) {
    var delta = Math.max(0, parseInt(rotationDelta, 10) || 0);
    var sec = Math.max(1, parseInt(windowSec, 10) || 1);
    return Math.round((delta * 60) / sec);
}

function fetchValidationHardwareRpm() {
    return fetchFriabilityLiveState().then(function (state) {
        if (!state || state.rpm == null || isNaN(parseFloat(state.rpm))) return null;
        return parseFloat(state.rpm);
    }).catch(function () { return null; });
}

function updateValidationCurrentRpmDisplay(measuredRpm, inRange) {
    var el = document.getElementById('val-run-current-rpm');
    if (!el) return;
    el.textContent = formatHardwareRpmDisplay(measuredRpm);
    el.classList.remove('validation-rpm-ok', 'validation-rpm-fail');
    if (measuredRpm != null && !isNaN(measuredRpm)) {
        el.classList.add(inRange ? 'validation-rpm-ok' : 'validation-rpm-fail');
    }
}

function applyValidationLiveRpm(measuredRpm, opts) {
    opts = opts || {};
    if (measuredRpm == null || isNaN(measuredRpm)) return;
    var measured = parseFloat(measuredRpm);
    validationRunLiveRpm = measured;
    var minRpm = getValidationRpmMin();
    var maxRpm = getValidationRpmMax();
    var inRange = measured >= minRpm && measured <= maxRpm;
    if (!inRange && !opts.startupMask) validationRunRpmAllPass = false;
    updateValidationCurrentRpmDisplay(measured, inRange);
    if (!inRange && !opts.startupMask && validationRunState === 'running') {
        setValRunEl('val-run-status-sub', 'RPM out of range (' + formatHardwareRpmDisplay(measured) + ' RPM, need ' + minRpm + '–' + maxRpm + ')');
    }
}

/** Live RPM from rotation timing (hardware path used when validationHardwareEnabled). */
function updateValidationLiveRpm(rotationDelta, windowSec) {
    if (validationRunState !== 'running') return Promise.resolve();
    var delta = Math.max(0, parseInt(rotationDelta, 10) || 0);
    var sec = Math.max(0.2, parseFloat(windowSec) || 0.2);
    if (delta < 1) return Promise.resolve();
    var computedRpm = computeValidationRpmFromRotations(delta, sec);
    if (!validationHardwareEnabled) {
        applyValidationLiveRpm(computedRpm);
        return Promise.resolve();
    }
    return fetchValidationHardwareRpm().then(function (hwRpm) {
        var measured = (hwRpm != null && !isNaN(hwRpm)) ? hwRpm : computedRpm;
        applyValidationLiveRpm(measured);
    });
}

function updateValidationLiveRpmFromTick() {
    var nowMs = Date.now();
    if (validationRunLiveRpmLastMs == null) {
        validationRunLiveRpmLastMs = nowMs;
        return;
    }
    var sec = Math.max(0.2, (nowMs - validationRunLiveRpmLastMs) / 1000);
    validationRunLiveRpmLastMs = nowMs;
    updateValidationLiveRpm(1, sec);
}

function validationOnTimerTick() {
    validationRunElapsedSec++;
    setValidationTimeDisplay(formatValidationElapsed(validationRunElapsedSec));
    if (validationRunState === 'running' && validationRunElapsedSec >= (VALIDATION_USP_TIME_MIN * 60)) {
        validationFinishDueToTimer();
    }
}

function _validationApplyRotationCount(n, opts) {
    opts = opts || {};
    if (validationRunState !== 'running' || n == null || isNaN(n)) return;
    var nowMs = Date.now();
    if (validationRunLastHwCountMs != null && n > validationRunLastHwCount) {
        if (!opts.skipRpmUpdate) {
            var startupRpm = getValidationStartupMaskedRpm(n);
            if (startupRpm != null) {
                applyValidationLiveRpm(startupRpm, { startupMask: true });
            } else {
                var sec = Math.max(0.2, (nowMs - validationRunLastHwCountMs) / 1000);
                var delta = n - validationRunLastHwCount;
                var computedRpm = computeValidationRpmFromRotations(delta, sec);
                if (validationRunLiveRpm == null) {
                    applyValidationLiveRpm(computedRpm);
                } else if (validationHardwareEnabled) {
                    fetchValidationHardwareRpm().then(function (hwRpm) {
                        if (hwRpm == null || isNaN(hwRpm)) {
                            applyValidationLiveRpm(computedRpm);
                        }
                    });
                } else {
                    applyValidationLiveRpm(computedRpm);
                }
            }
        }
    }
    validationRunLastHwCount = n;
    validationRunLastHwCountMs = nowMs;
    validationRunCurrentCount = n;
    setValidationRotationDisplay(validationRunCurrentCount);
}

function _validationSyncFromLiveState(state) {
    if (!state) return;
    if (validationRunState !== 'running' && !validationHwAwaitingStart) return;
    var n = parseHardwareRotationCount(state);
    var rpm = parseHardwareRpm(state);
    var rpmMissing = isValidationEspRpmMissing(state);
    var startupCount = n != null ? n : (validationRunCurrentCount > 0 ? validationRunCurrentCount : 1);
    var startupRpm = getValidationStartupMaskedRpm(startupCount);
    if (startupRpm != null && validationRunState === 'running') {
        if (n != null) _validationApplyRotationCount(n, { skipRpmUpdate: true });
        applyValidationLiveRpm(startupRpm, { startupMask: true });
        return;
    }
    if (n != null) {
        _validationApplyRotationCount(n, {
            skipRpmUpdate: validationHardwareEnabled && (rpm != null || rpmMissing)
        });
    }
    if (rpmMissing) {
        setValRunEl('val-run-current-rpm', '--');
        var curEl = document.getElementById('val-run-current-rpm');
        if (curEl) curEl.classList.remove('validation-rpm-ok', 'validation-rpm-fail');
        validationRunLiveRpm = null;
    }
    if (rpm != null) applyValidationLiveRpm(rpm);
}

function _validationApplyHardwareStream(payload) {
    if (validationRunState !== 'running' && !validationHwAwaitingStart) return;
    _validationSyncFromLiveState(payload);
    if (payload && payload.kind && payload.kind !== 'ping' &&
        parseHardwareRotationCount(payload) == null && parseHardwareRpm(payload) == null &&
        !payload.rpmPending) {
        console.debug('[ESP-Pi] unmapped validation line:', payload);
    }
}

function _validationApplyLiveState(state) {
    _validationSyncFromLiveState(state);
}

function _validationCleanupHardwareStream() {
    if (validationRunHwUnsubscribe) {
        validationRunHwUnsubscribe();
        validationRunHwUnsubscribe = null;
    }
}

function validationFinishDueToTimer() {
    if (validationRunState !== 'running') return;
    if (validationRunIntervalId != null) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
    }
    if (validationRunTimerIntervalId != null) {
        clearInterval(validationRunTimerIntervalId);
        validationRunTimerIntervalId = null;
    }
    validationRunState = 'completed';
    setValidationDrumSpinning(false);
    stopHardwareLivePoll();
    _validationCleanupHardwareStream();
    stopValidationOnBackend().catch(function () {}).finally(function () {
        finalizeValidationMeasuredRpm();
        completeValidationRun();
    });
}

function initValidationRunPage() {
    if (validationRunState === 'running' || validationRunBackendPending) return;
    lastValidationType = 'usp';
    var usp = 'USP (Friability)';
    validationRunTarget = VALIDATION_USP_ROTATION_TARGET;
    validationRunTolerance = VALIDATION_USP_ROTATION_TOLERANCE;
    validationRunMin = validationRunTarget - validationRunTolerance;
    validationRunMax = validationRunTarget + validationRunTolerance;
    validationRunExpected = validationRunTarget;

    setValRunEl('val-run-usp', usp);
    setValRunEl('val-run-rpm', String(VALIDATION_USP_RPM));
    resetValidationRpmTracking();
    setValidationTimeDisplay(formatValidationElapsed(0));
    setValRunEl('val-run-height', String(VALIDATION_USP_DROP_MM));
    setValRunEl('val-run-expected', String(validationRunTarget));
    setValidationRotationDisplay(0);
    setValRunStatusText('Ready');
    setValRunEl('val-run-status-sub', 'Press Start to begin');

    setValResultCardVisible(false);

    validationRunCurrentCount = 0;
    validationRunElapsedSec = 0;
    validationRunStartedAtIso = null;
    validationCompletion.usp = false;
    validationRunState = 'idle';
    if (validationRunIntervalId != null) {
        clearInterval(validationRunIntervalId);
        validationRunIntervalId = null;
    }
    if (validationRunTimerIntervalId != null) {
        clearInterval(validationRunTimerIntervalId);
        validationRunTimerIntervalId = null;
    }
    stopHardwareLivePoll();
    _validationCleanupHardwareStream();
    setValidationDrumSpinning(false);

    setValRunPrimaryButton('start');
}

function startCalibrationFromType() {
    var radio = document.querySelector('input[name="cal-type"]:checked');
    if (radio && radio.value === 'load') goToPage('load-calibration');
    else if (radio && radio.value === 'distance-zero') goToPage('distance-zero-calibration');
    else goToPage('load-calibration');
}

function viewRecipe() {
    goToPage('view-recipes');
}

// ----- Members: manage, locked, disabled -----
function loadMembersAndRender() {
    apiRequest(API_BASE + '/api/data/members', {
        method: 'GET'
    }).then(function (data) {
        var members = (data && data.members && Array.isArray(data.members)) ? data.members : [];
        membersCache = members;
        renderMembersView();
    }).catch(function (err) {
        console.error('Failed to load members', err);
        renderMembersView(); // still clear tables / empty state
    });
}

function renderMembersView() {
    var members = Array.isArray(membersCache) ? membersCache : [];
    var active = [];
    var locked = [];
    var disabled = [];
    members.forEach(function (m) {
        var status = (m && m.status ? String(m.status) : 'active').toLowerCase();
        if (status === 'locked') locked.push(m);
        else if (status === 'disabled') disabled.push(m);
        else active.push(m);
    });

    function renderTable(bodyId, emptyId, rows, options) {
        options = options || {};
        var tbody = document.getElementById(bodyId);
        var emptyEl = document.getElementById(emptyId);
        if (!tbody) return;
        tbody.innerHTML = '';
        if (!rows || rows.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';
        var u = window.currentUser;
        var canUnlock = typeof canPerformAction === 'function' ? canPerformAction(u, 'user-unlock', 'change') : true;
        var canEnable = typeof canPerformAction === 'function' ? canPerformAction(u, 'user-enable', 'change') : true;
        var canEdit = typeof canEditMembers === 'function' && canEditMembers();
        var canChangeRole = typeof canPerformAction === 'function' ? canPerformAction(u, 'user-change-role', 'change') : true;
        var canDisable = typeof canPerformAction === 'function' ? canPerformAction(u, 'user-delete', 'delete') : true;
        // Sort by name for a consistent list
        rows.slice().sort(function (a, b) {
            var an = (a && a.name ? String(a.name) : '').toLowerCase();
            var bn = (b && b.name ? String(b.name) : '').toLowerCase();
            if (an < bn) return -1;
            if (an > bn) return 1;
            return 0;
        }).forEach(function (m) {
            var tr = document.createElement('tr');
            var name = m.name || '';
            var username = m.username || '';
            var role = m.role || '';
            if (options.style === 'active') {
                var roleKey = String(role || '').toLowerCase();
                var roleClass = 'member-role-badge ';
                if (roleKey === 'admin') roleClass += 'member-role-admin';
                else if (roleKey === 'supervisor') roleClass += 'member-role-supervisor';
                else if (roleKey === 'qa') roleClass += 'member-role-qa';
                else roleClass += 'member-role-user';
                var editBtn = canEdit
                    ? '<button class="btn-member-action btn-edit" onclick="openEditMember(' + (m.id || 0) + ')">Edit Profile</button>'
                    : '';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + (username || '-') + '</td>' +
                    '<td><span class="' + roleClass + '">' + displayRoleLabel(role) + '</span></td>' +
                    '<td class="member-actions-cell">' +
                    editBtn +
                    (canChangeRole ? '<button class="btn-member-action btn-role" onclick="openRoleModal(' + (m.id || 0) + ')">Change Role</button>' : '') +
                    (canDisable ? '<button class="btn-member-action btn-disable" onclick="disableMember(' + (m.id || 0) + ')">Disable</button>' : '') +
                    '</td>';
            } else {
                var actionBtn = '';
                if (options.style === 'locked') {
                    actionBtn = '<button class="btn-member-action btn-unlock" ' + (canUnlock ? '' : 'disabled') + ' onclick="unlockMember(' + (m.id || 0) + ')">Unlock</button>';
                } else if (options.style === 'disabled') {
                    actionBtn = '<button class="btn-member-action btn-enable" ' + (canEnable ? '' : 'disabled') + ' onclick="enableMember(' + (m.id || 0) + ')">Enable</button>';
                }
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + (username || '-') + '</td>' +
                    '<td>' + displayRoleLabel(role) + '</td>' +
                    '<td class="member-actions-cell">' + actionBtn + '</td>';
            }
            tbody.appendChild(tr);
        });
    }

    renderTable('members-list-body', 'members-empty-state', active, { style: 'active' });
    renderTable('locked-members-table-body', 'locked-members-empty-state', locked, { style: 'locked' });
    renderTable('disabled-members-table-body', 'disabled-members-empty-state', disabled, { style: 'disabled' });
}

function unlockMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-unlock', 'change')) {
            showAppModal('Only Admin/Factory can unlock accounts.', 'Permission');
            return;
        }
    }
    showConfirmModal('Unlock this account?', 'Unlock Account').then(function (ok) {
        if (!ok) return;
        var headers = { 'Content-Type': 'application/json' };
        if (window.currentUser && window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
        fetch((API_BASE || '') + '/api/data/members/' + id + '/unlock', { method: 'POST', headers: headers })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error((res.body && res.body.error) ? res.body.error : ('HTTP ' + res.status));
                loadMembersAndRender();
                showAppModal('Account unlocked.', 'Unlock');
            })
            .catch(function (err) {
                showAppModal('Failed to unlock: ' + (err && err.message ? err.message : 'Unknown error'), 'Unlock');
            });
    });
}

function enableMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-enable', 'change')) {
            showAppModal('Only Admin/Factory can enable accounts.', 'Permission');
            return;
        }
    }
    showConfirmModal('Enable this account?', 'Enable Account').then(function (ok) {
        if (!ok) return;
        var headers = { 'Content-Type': 'application/json' };
        if (window.currentUser && window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
        fetch((API_BASE || '') + '/api/data/members/' + id + '/enable', { method: 'POST', headers: headers })
            .then(function (r) { return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, status: r.status, body: b }; }); })
            .then(function (res) {
                if (!res.ok) throw new Error((res.body && res.body.error) ? res.body.error : ('HTTP ' + res.status));
                loadMembersAndRender();
                showAppModal('Account enabled.', 'Enable');
            })
            .catch(function (err) {
                showAppModal('Failed to enable: ' + (err && err.message ? err.message : 'Unknown error'), 'Enable');
            });
    });
}

// ----- Loading overlay, audit filters, USB export (DUMMY parity) -----
var _appLoadingCancelHandler = null;

function showLoadingOverlay(title, message, options) {
    var opts = options || {};
    if (!opts.auditLoading && typeof clearAuditTrailsLoadingTimers === 'function') {
        clearAuditTrailsLoadingTimers();
    }
    var overlay = document.getElementById('app-loading-overlay');
    var titleEl = document.getElementById('app-loading-title');
    var msgEl = document.getElementById('app-loading-message');
    var detailEl = document.getElementById('app-loading-detail');
    var cancelBtn = document.getElementById('app-loading-cancel-btn');
    if (titleEl) titleEl.textContent = title || 'Working...';
    if (msgEl) msgEl.textContent = message || 'Please wait.';
    if (detailEl) detailEl.textContent = '';
    _appLoadingCancelHandler = typeof opts.onCancel === 'function' ? opts.onCancel : null;
    if (cancelBtn) {
        cancelBtn.style.display = opts.cancellable === false ? 'none' : '';
        if (opts.cancellable !== false) cancelBtn.disabled = false;
    }
    var spinner = document.getElementById('app-loading-spinner');
    var pwrap = document.getElementById('app-loading-progress-wrap');
    var pbar = document.getElementById('app-loading-progress-bar');
    var ppct = document.getElementById('app-loading-progress-pct');
    if (opts.progress === true) {
        if (spinner) spinner.style.display = 'none';
        if (pwrap) pwrap.style.display = '';
        if (pbar) pbar.style.width = '0%';
        if (ppct) ppct.textContent = '0%';
    } else {
        if (spinner) spinner.style.display = '';
        if (pwrap) pwrap.style.display = 'none';
    }
    if (overlay) overlay.style.display = 'flex';
}

function setLoadingMessage(message, detail) {
    var msgEl = document.getElementById('app-loading-message');
    var detailEl = document.getElementById('app-loading-detail');
    if (msgEl && message != null) msgEl.textContent = String(message);
    if (detailEl && detail != null) detailEl.textContent = String(detail);
}

function setLoadingProgress(percent, message, detail) {
    var spinner = document.getElementById('app-loading-spinner');
    var pwrap = document.getElementById('app-loading-progress-wrap');
    var pbar = document.getElementById('app-loading-progress-bar');
    var ppct = document.getElementById('app-loading-progress-pct');
    if (spinner) spinner.style.display = 'none';
    if (pwrap) pwrap.style.display = '';
    var pct = parseFloat(percent);
    if (!isFinite(pct)) pct = 0;
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    if (pbar) pbar.style.width = pct.toFixed(1) + '%';
    if (ppct) ppct.textContent = Math.round(pct) + '%';
    if (message != null) setLoadingMessage(message, detail != null ? detail : undefined);
    else if (detail != null) setLoadingMessage(null, detail);
}

function hideLoadingOverlay() {
    var overlay = document.getElementById('app-loading-overlay');
    if (overlay) overlay.style.display = 'none';
    _appLoadingCancelHandler = null;
}

function cancelLoadingOverlay() {
    var fn = _appLoadingCancelHandler;
    _appLoadingCancelHandler = null;
    hideLoadingOverlay();
    if (typeof fn === 'function') {
        try { fn(); } catch (e) { /* ignore */ }
    }
}

function _friendlyExportError(err) {
    var raw = '';
    if (err && err.message) raw = String(err.message);
    else if (typeof err === 'string') raw = err;
    var t = raw.toLowerCase();
    if (t.indexOf('no external pendrive') !== -1 || t.indexOf('not detected') !== -1) {
        return 'No external pendrive detected. Please connect a USB pendrive and try again.';
    }
    if (t.indexOf('multiple pendrives') !== -1) {
        return 'Multiple pendrives detected. Please disconnect extras and try again.';
    }
    if (t.indexOf('could not access') !== -1 || t.indexOf('not authorized') !== -1 || t.indexOf('mount') !== -1) {
        return 'Could not access the pendrive. Reconnect it and try again.';
    }
    if (t.indexOf('disk full') !== -1 || t.indexOf('no space') !== -1) {
        return 'Pendrive is full. Free space or use a different pendrive.';
    }
    return 'Failed to export. Please format the pendrive (FAT32 or exFAT) and try again.';
}

var _auditLoadMessageTimers = [];

function clearAuditTrailsLoadingTimers() {
    _auditLoadMessageTimers.forEach(function (id) { clearTimeout(id); });
    _auditLoadMessageTimers = [];
}

function showAuditTrailsLoadingOverlay() {
    hideAuditTrailsLoadingOverlay();
    showLoadingOverlay('Audit Trails', 'Fetching audit trails...', { cancellable: false, auditLoading: true });
    _auditLoadMessageTimers.push(setTimeout(function () {
        setLoadingMessage('Processing audit trails...', 'Please wait.');
    }, 450));
    _auditLoadMessageTimers.push(setTimeout(function () {
        setLoadingMessage('Loading audit trails...', 'Please wait.');
    }, 950));
}

function hideAuditTrailsLoadingOverlay() {
    clearAuditTrailsLoadingTimers();
    hideLoadingOverlay();
}

function _populateAuditFilterDropdowns(userEl, actionEl, fullList) {
    var users = [];
    var actions = [];
    (fullList || []).forEach(function (e) {
        var u = e.user || '--';
        if (users.indexOf(u) === -1) users.push(u);
        var a = e.action || '';
        if (a && actions.indexOf(a) === -1) actions.push(a);
    });
    var coreActions = [
        'Login', 'Logout', 'Logout (inactivity timeout)', 'Power interruption logout', 'Power interruption', 'User logged in',
        'Entered screen', 'Exited screen',
        'Opened Quick Test', 'Opened Load Recipe', 'Opened Manage Recipe', 'Loaded recipe',
        'Opened disabled recipes',
        'Test started', 'Quick test started', 'Test paused', 'Test resumed', 'Test finished', 'Test aborted', 'Test auto-aborted',
        'Test performed', 'Quick test performed',
        'Entered USP validation',
        'Validation started', 'Validation finished', 'Validation aborted', 'Validation performed',
        'Temperature Validation', 'RPM Validation', 'Physical Parameters', 'Sample Volume Validation',
        'Calibration', 'Cleaning Cycle', 'Wakeup Schedule', 'Test Settings',
        'Temperature calibration started', 'Temperature calibration completed',
        'Cleaning cycle started', 'Cleaning cycle stopped', 'Wakeup schedule saved',
        'System settings saved', 'Test settings saved',
        'Report saved', 'Report generated', 'Report approved', 'Report deleted',
        'Report aborted', 'Report aborted (power loss)', 'Report PDF generated',
        'Recipe created', 'Recipe edited', 'Recipe approved', 'Approval verification',
        'Disable Recipe', 'Recipe disabled', 'Recipe enabled',
        'Added new user', 'Password changed', 'Profile updated', 'User create', 'User update',
        'Audit log viewed', 'Print A4',
        'System date change', 'RTC date set', 'Factory settings changed',
        'Hardware calibration', 'Validation load'
    ];
    coreActions.forEach(function (a) {
        if (actions.indexOf(a) === -1) actions.push(a);
    });
    users.sort();
    actions.sort();
    if (userEl) {
        userEl.innerHTML = '<option value="">All</option>';
        users.forEach(function (u) { userEl.appendChild(new Option(u, u)); });
    }
    if (actionEl) {
        actionEl.innerHTML = '<option value="">All</option>';
        actions.forEach(function (a) { actionEl.appendChild(new Option(a, a)); });
    }
}

var _usbPickerResolve = null;

function pickPendrive(devices) {
    return new Promise(function (resolve) {
        var overlay = document.getElementById('usb-picker-overlay');
        var list = document.getElementById('usb-picker-list');
        if (!overlay || !list) {
            resolve(null);
            return;
        }
        list.innerHTML = '';
        (devices || []).forEach(function (d) {
            var card = document.createElement('div');
            card.className = 'usb-picker-card';
            var label = d.label || '(no label)';
            var size = d.size_human || '';
            var fs = (d.fs_type || '').toUpperCase();
            var path = d.path || '';
            card.innerHTML =
                '<div class="usb-picker-card-meta">' +
                    '<span class="usb-picker-card-label">' + label + '</span>' +
                    '<span class="usb-picker-card-sub">' + path + ' — ' + size + (fs ? ' — ' + fs : '') + '</span>' +
                '</div>' +
                '<button type="button" class="btn btn-primary">Choose</button>';
            card.addEventListener('click', function () {
                hideUsbPicker();
                if (_usbPickerResolve) { _usbPickerResolve(d.path); _usbPickerResolve = null; }
            });
            list.appendChild(card);
        });
        _usbPickerResolve = resolve;
        overlay.style.display = 'flex';
    });
}

function hideUsbPicker() {
    var overlay = document.getElementById('usb-picker-overlay');
    if (overlay) overlay.style.display = 'none';
}

function cancelUsbPicker() {
    hideUsbPicker();
    if (_usbPickerResolve) {
        _usbPickerResolve(null);
        _usbPickerResolve = null;
    }
}

// ----- Reports and audit from API -----
function setReportsAuditMode(isAudit) {
    var container = document.querySelector('#page-reports .reports-container');
    if (container) {
        container.classList.toggle('reports-container--audit', !!isAudit);
    }
}

function loadReports(filterType) {
    currentReportFilter = filterType || null;
    if (filterType === 'test' || filterType === 'validation' || filterType === 'calibration') {
        lastReportListFilter = filterType;
    } else if (!filterType || filterType === 'all') {
        lastReportListFilter = 'all';
    }
    var tbody = document.getElementById('reports-table-body');
    var theadRow = document.getElementById('reports-thead-row');
    var bar = document.getElementById('audit-filters-bar');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (filterType === 'audit') {
        if (typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
            setReportsAuditMode(false);
            showAppModal("You Don't Have Access to Audit Trail", 'Audit');
            return;
        }
        setReportsAuditMode(true);
        if (typeof initAuditReportsVisibility === 'function') initAuditReportsVisibility();
        if (bar) bar.style.display = '';
        if (theadRow) theadRow.innerHTML = '<th>Date & Time</th><th>User</th><th>Role</th><th>Action</th><th>Details</th>';
        var userEl = document.getElementById('audit-filter-user');
        var roleEl = document.getElementById('audit-filter-role');
        var actionEl = document.getElementById('audit-filter-action');
        var fromDate = document.getElementById('audit-filter-from-date');
        var fromTime = document.getElementById('audit-filter-from-time');
        var toDate = document.getElementById('audit-filter-to-date');
        var toTime = document.getElementById('audit-filter-to-time');
        var fromTs = '';
        var toTs = '';
        if (fromDate && fromDate.value) {
            var parts = fromDate.value.split('-');
            var h = fromTime && fromTime.value ? parseInt(fromTime.value.slice(0, 2), 10) : 0;
            var m = fromTime && fromTime.value ? parseInt(fromTime.value.slice(3, 5), 10) : 0;
            fromTs = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), h, m, 0, 0).getTime();
        }
        if (toDate && toDate.value) {
            var parts2 = toDate.value.split('-');
            var h2 = toTime && toTime.value ? parseInt(toTime.value.slice(0, 2), 10) : 23;
            var m2 = toTime && toTime.value ? parseInt(toTime.value.slice(3, 5), 10) : 59;
            toTs = new Date(parseInt(parts2[0], 10), parseInt(parts2[1], 10) - 1, parseInt(parts2[2], 10), h2, m2, 59, 999).getTime();
        }
        var q = [];
        if (userEl && userEl.value) q.push('user=' + encodeURIComponent(userEl.value));
        if (roleEl && roleEl.value) q.push('role=' + encodeURIComponent(roleEl.value));
        if (actionEl && actionEl.value) q.push('action=' + encodeURIComponent(actionEl.value));
        if (fromTs) q.push('from=' + fromTs);
        if (toTs) q.push('to=' + toTs);
        if (_auditViewLogPending) {
            q.push('log_view=1');
            _auditViewLogPending = false;
        }
        var auditUrl = API_BASE + '/api/data/audit-log' + (q.length ? '?' + q.join('&') : '');
        showAuditTrailsLoadingOverlay();
        apiRequest(auditUrl).then(function (data) {
            var list = (data && data.entries) ? data.entries : [];
            var filterTask = Promise.resolve();
            if (userEl && userEl.options.length <= 1) {
                filterTask = apiRequest(API_BASE + '/api/data/audit-log').then(function (full) {
                    var fullList = (full && full.entries) ? full.entries : [];
                    _populateAuditFilterDropdowns(userEl, actionEl, fullList);
                }).catch(function () {});
            }
            return filterTask.then(function () {
                _renderAuditLogRows(tbody, list);
            });
        }).catch(function () {
            tbody.innerHTML = '';
            var emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="5">Unable to load audit log.</td>';
            tbody.appendChild(emptyRow);
        }).finally(function () {
            hideAuditTrailsLoadingOverlay();
        });
        return;
    }

    setReportsAuditMode(false);
    if (bar) bar.style.display = 'none';
    if (theadRow) theadRow.innerHTML = '<th>SL No</th><th>Report Name</th><th>Creation Time</th><th>Action</th>';
    var filter = (filterType === 'test' || filterType === 'validation' || filterType === 'calibration')
        ? filterType
        : 'all';
    apiRequest(API_BASE + '/api/data/reports?filter=' + encodeURIComponent(filter)).then(function (data) {
        var list = (data && data.reports) ? data.reports : [];
        if (!list.length) {
            var emptyRow = document.createElement('tr');
            emptyRow.innerHTML = '<td colspan="4">No reports.</td>';
            tbody.appendChild(emptyRow);
        } else {
            list.forEach(function (r, i) {
                var row = document.createElement('tr');
                var name = r.name;
                if (!name && r.type === 'validation') {
                    name = 'Validation Report';
                }
                if (!name && r.type === 'calibration') {
                    var cst = r.calibrationSubtype || (r.testData && r.testData.calibrationSubtype) || '';
                    name = 'Calibration' + (cst ? ' - ' + String(cst) : '');
                }
                if (!name) name = (r.recipe && r.recipe.productName) || 'Report ' + (r.id || (i + 1));
                var created = r.createdAt || r.created || '';
                if (created && created.length > 10) created = created.slice(0, 10) + ' ' + created.slice(11, 19);
                row.innerHTML = '<td>' + (i + 1) + '</td><td>' + name + '</td><td>' + created + '</td><td><button class="reports-open-btn" onclick="openReportPreview(' + (r.id || 0) + ')">Open</button></td>';
                tbody.appendChild(row);
            });
        }
    }).catch(function () {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="4">Unable to load reports.</td>';
        tbody.appendChild(emptyRow);
    });
}

function canViewAuditLog() {
    var role = (typeof getCurrentRole === 'function' ? getCurrentRole() : '') || '';
    role = String(role).toLowerCase();
    if (role === 'factory') return true;
    var u = window.currentUser;
    if (u && typeof userHasInternalKey === 'function') {
        return userHasInternalKey(u, 'audit-view');
    }
    return false;
}

function isFactorySessionUser(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    var role = (u.role != null ? String(u.role) : '').toLowerCase();
    if (typeof isFactoryLikeRole === 'function') return isFactoryLikeRole(role, u);
    return role === 'factory';
}

function userCanViewReports(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return typeof canAccess === 'function' && canAccess(u, 'reports-view');
}

function userCanPrintReports(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    return userCanViewReports(u);
}

function userCanExportToUsb(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (isFactorySessionUser(u)) return true;
    if (typeof userHasInternalKey === 'function' && userHasInternalKey(u, 'export-usb')) return true;
    return false;
}

function _ensureExportApprovalToken() {
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';
    if (role === 'factory') return Promise.resolve('');
    return openApprovalVerifyModal({
        purpose: 'export',
        titleText: 'Export approval',
        subtitleText: 'Enter credentials of a user with export approval permission.',
        usernameLabelText: 'Verifier username',
        usernamePlaceholder: 'Username',
        emptyCredentialsMessage: 'Enter verifier username and password.'
    }).then(function (token) {
        return token || '';
    });
}

function _renderAuditLogRows(tbody, list) {
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!list || !list.length) {
        var emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="5">No audit entries match the filters.</td>';
        tbody.appendChild(emptyRow);
        return;
    }
    list.forEach(function (entry) {
        var row = document.createElement('tr');
        row.innerHTML = '<td>' + (entry.dateTime || '') + '</td><td>' + (entry.user || '--') + '</td><td>' + displayRoleLabel(entry.role || '--') + '</td><td>' + (entry.action || '') + '</td><td>' + formatAuditDetailsText(entry.details || '') + '</td>';
        tbody.appendChild(row);
    });
}

function refreshAuditUiAfterAuth() {
    if (typeof initAuditReportsVisibility === 'function') initAuditReportsVisibility();
    if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
}

function initAuditReportsVisibility() {
    var auditBtn = document.querySelector('.reports-filter-audit');
    if (auditBtn) {
        auditBtn.style.display = canViewAuditLog() ? '' : 'none';
    }
    var exportAuditCard = document.getElementById('export-audit-trails-card');
    if (exportAuditCard) {
        exportAuditCard.style.display = canViewAuditLog() ? '' : 'none';
    }
}

function filterReports(type) {
    if (type === 'audit' && typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
        showAppModal("You Don't Have Access to Audit Trail", 'Audit');
        return;
    }
    if (type === 'audit') {
        _auditViewLogPending = true;
    }
    loadReports(type);
}

function applyAuditFiltersAndRefresh() {
    loadReports('audit');
}

/** USB export verify/retention modals (audit trails and reports). */
function showUsbExportVerifyModal(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !titleEl || !msgEl || !buttonsEl) {
            resolve(window.confirm(opts.fallbackConfirm || 'Was the export successful?'));
            return;
        }
        appModalResolve = resolve;
        titleEl.textContent = opts.title || 'Verify Export';
        msgEl.textContent = opts.message || 'Verify the file on the USB pendrive, then tap OK.';
        buttonsEl.innerHTML =
            '<button type="button" class="btn-role-select btn-role-cancel" onclick="closeAppModal(false)">Cancel</button>' +
            '<button type="button" class="btn-role-select btn-audit-export-verify-ok" onclick="closeAppModal(true)">OK</button>';
        overlay.style.display = 'flex';
    });
}

var _stylesCssCache = null;

function _fetchStylesCss() {
    if (_stylesCssCache != null) return Promise.resolve(_stylesCssCache);
    return fetch('styles.css', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('styles.css HTTP ' + r.status);
        return r.text();
    }).then(function (txt) {
        _stylesCssCache = String(txt || '');
        return _stylesCssCache;
    }).catch(function () {
        _stylesCssCache = '';
        return '';
    });
}

function _wrapPreviewHtmlAsDocument(innerHtml, cssText) {
    var docCss =
        '@page { size: A4; margin: 6mm 5mm; }' +
        'html, body { margin: 0; padding: 0; background: #ffffff; color: #000; }' +
        'body { font-family: Inter, "Segoe UI", Roboto, system-ui, sans-serif; }' +
        '.modal-overlay, .sidebar, .app-header, .header-back-btn, header.app-header, ' +
        '.test-run-controls, .report-preview-actions { display: none !important; }' +
        '#page-report-preview, .page, .page.active { display: block !important; position: static !important; ' +
            'background: #ffffff !important; color: #000 !important; padding: 0 !important; margin: 0 !important; ' +
            'opacity: 1 !important; overflow: visible !important; height: auto !important; max-height: none !important; }' +
        '#page-report-preview * { color: #000 !important; background: transparent !important; }' +
        '#page-report-preview table { border-collapse: collapse; width: 100%; }' +
        '#page-report-preview th, #page-report-preview td { border: 1px solid #888; padding: 4px 6px; }' +
        '.report-preview-container.report-pdf-compact { min-height: auto !important; max-height: none !important; padding: 3mm 5mm !important; margin: 0 !important; box-shadow: none !important; font-size: 9pt !important; line-height: 1.2 !important; }';
    return (
        '<!doctype html><html><head><meta charset="utf-8"><title>Report</title>' +
        '<style>' + (cssText || '') + '</style>' +
        '<style>' + docCss + '</style>' +
        '</head><body>' + (innerHtml || '') + '</body></html>'
    );
}

function buildReportPreviewHtmlById(reportId) {
    var id = parseInt(reportId, 10);
    if (isNaN(id) || id < 1) return Promise.reject(new Error('Invalid report id'));
    return Promise.all([
        apiRequest(API_BASE + '/api/reports/' + id + '/preview'),
        _fetchStylesCss()
    ]).then(function (results) {
        var data = results[0];
        var css = results[1];
        if (!data || !data.preview) throw new Error('No preview for report ' + id);
        try { populateReportPreview(data.preview); } catch (e) {}
        var pageEl = document.getElementById('page-report-preview');
        var containerEl = pageEl ? pageEl.querySelector('.report-preview-container') : null;
        if (containerEl) containerEl.classList.add('report-pdf-compact');
        var inner = pageEl ? pageEl.outerHTML : '';
        var doc = _wrapPreviewHtmlAsDocument(inner, css);
        if (containerEl) containerEl.classList.remove('report-pdf-compact');
        return doc;
    });
}

function _saveReportPdfSilent(reportId) {
    var id = parseInt(reportId, 10);
    if (isNaN(id) || id < 1) return Promise.resolve(false);
    return apiRequest(API_BASE + '/api/reports/' + id + '/preview').then(function (data) {
        var st = String((data && data.preview && data.preview.reportApprovalStatus) || '').trim().toLowerCase();
        if (st !== 'approved' && st !== 'aborted') return false;
        return buildReportPreviewHtmlById(id);
    }).then(function (html) {
        if (!html) return false;
        return apiRequest(API_BASE + '/api/reports/' + id + '/pdf', {
            method: 'POST',
            body: { html: html }
        }).then(function () { return true; }).catch(function () { return false; });
    }).catch(function () { return false; });
}

function _summariseExportResult(result) {
    var count = (result && result.count) ? result.count : 0;
    var fails = (result && result.failed && result.failed.length) ? result.failed.length : 0;
    if (count > 0 && !fails) {
        return (count === 1)
            ? 'Report export successful.\n\nExported rows will be purged from this device 24 hours after verification.'
            : count + ' reports exported successfully.\n\nExported rows will be purged from this device 24 hours after verification.';
    }
    if (count > 0 && fails) {
        return count + ' exported, ' + fails + ' failed.';
    }
    return 'Export completed with no files written.';
}

function _exportReportsWithFlow(reportIds, opts) {
    var ids = (reportIds || []).map(function (x) { return parseInt(x, 10); }).filter(function (x) { return !isNaN(x) && x > 0; });
    if (!ids.length) {
        showAppModal('No reports selected to export.', 'Export');
        return Promise.resolve(null);
    }
    var u = window.currentUser;
    if (!userCanExportToUsb(u)) {
        showAppModal('You do not have permission to export reports to USB.', 'Export');
        return Promise.resolve(null);
    }
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';
    var titleText = (opts && opts.title) ? opts.title : 'Export Reports';
    var batchId = null;

    return apiRequest(API_BASE + '/api/reports/export/stage', {
        method: 'POST',
        body: { report_ids: ids }
    }).then(function (stageRes) {
        if (!stageRes || !stageRes.success) {
            throw new Error((stageRes && stageRes.error) || 'Failed to stage report export.');
        }
        batchId = stageRes.batchId;
        return showUsbExportVerifyModal({
            title: 'Verify USB Pendrive',
            message: 'Connect the USB pendrive and confirm it is ready for export. Tap OK to continue.',
            fallbackConfirm: 'USB pendrive ready?'
        });
    }).then(function (usbOk) {
        if (!usbOk) return null;
        return _ensureExportApprovalToken().then(function (token) {
            if (role !== 'factory' && !token) {
                showAppModal('Export cancelled — approval is required.', titleText);
                return null;
            }
            var exportHeaders = token ? { 'X-Approval-Verify-Token': token } : {};
            showLoadingOverlay(titleText, 'Detecting external pendrive...', { cancellable: false });
            return apiRequest(API_BASE + '/api/usb/list').then(function (data) {
                var devices = (data && data.devices) ? data.devices : [];
                if (!devices.length) {
                    hideLoadingOverlay();
                    showAppModal('No external pendrive detected. Please connect a USB pendrive and try again.', titleText);
                    return null;
                }
                var pickPromise = devices.length === 1 ? Promise.resolve(devices[0].path) : pickPendrive(devices);
                if (devices.length > 1) hideLoadingOverlay();
                return pickPromise.then(function (devicePath) {
                    if (!devicePath) return null;
                    showLoadingOverlay(titleText, 'Preparing report PDFs...', { cancellable: false, progress: true });
                    setLoadingProgress(10, 'Preparing report PDFs...', 'Step 1 of 2: rendering previews');
                    return _gatherPdfHtmlByIdSequentialWithProgress(ids, titleText).then(function (pdfHtmlByIdNeeded) {
                        setLoadingProgress(25, 'Mounting pendrive...', devicePath);
                        var payload = { report_ids: ids, device_path: devicePath, batch_id: batchId };
                        if (pdfHtmlByIdNeeded && Object.keys(pdfHtmlByIdNeeded).length) {
                            payload.pdf_html_by_id = pdfHtmlByIdNeeded;
                        }
                        setTimeout(function () { setLoadingProgress(60, 'Generating report PDF files...', ''); }, 600);
                        return apiRequest(API_BASE + '/api/reports/export', {
                            method: 'POST',
                            headers: exportHeaders,
                            body: payload
                        }).then(function (res) {
                            if (res && res.success) {
                                setLoadingProgress(95, 'Writing to pendrive...', '');
                                setTimeout(function () {
                                    setLoadingProgress(100, 'Export complete', '');
                                    setTimeout(function () {
                                        hideLoadingOverlay();
                                        showAppModal(_summariseExportResult(res), titleText);
                                    }, 350);
                                }, 350);
                                return res;
                            }
                            hideLoadingOverlay();
                            showAppModal(_friendlyExportError((res && res.error) || 'report export failed'), titleText);
                            return res;
                        });
                    });
                });
            });
        });
    }).catch(function (err) {
        hideLoadingOverlay();
        showAppModal(_friendlyExportError(err), titleText);
        return null;
    });
}

function _streamExportReports(payload, titleText, exportHeaders) {
    var hdrs = { 'Content-Type': 'application/json' };
    if (exportHeaders && exportHeaders['X-Approval-Verify-Token']) {
        hdrs['X-Approval-Verify-Token'] = exportHeaders['X-Approval-Verify-Token'];
    }
    return fetch(API_BASE + '/api/reports/export/stream', {
        method: 'POST',
        headers: hdrs,
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    }).then(function (resp) {
        if (!resp.ok && resp.status !== 200) {
            return resp.json().catch(function () { return {}; }).then(function (j) {
                throw new Error((j && j.error) || ('HTTP ' + resp.status));
            });
        }
        if (!resp.body || !resp.body.getReader) {
            return resp.text().then(function (txt) { return _consumeNdjsonText(txt, titleText); });
        }
        var reader = resp.body.getReader();
        var decoder = new TextDecoder('utf-8');
        var buffer = '';
        var lastEvent = null;
        function pump() {
            return reader.read().then(function (r) {
                if (r.done) {
                    if (buffer.trim()) {
                        try { lastEvent = JSON.parse(buffer); _handleExportEvent(lastEvent, titleText); } catch (e) {}
                    }
                    return lastEvent;
                }
                buffer += decoder.decode(r.value, { stream: true });
                var idx;
                while ((idx = buffer.indexOf('\n')) >= 0) {
                    var line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (!line) continue;
                    try {
                        var evt = JSON.parse(line);
                        lastEvent = evt;
                        _handleExportEvent(evt, titleText);
                    } catch (e) {}
                }
                return pump();
            });
        }
        return pump();
    }).catch(function (err) {
        hideLoadingOverlay();
        showAppModal(_friendlyExportError(err), titleText);
        return null;
    });
}

function _consumeNdjsonText(text, titleText) {
    var lines = String(text || '').split('\n');
    var last = null;
    for (var i = 0; i < lines.length; i++) {
        var s = lines[i].trim();
        if (!s) continue;
        try { var evt = JSON.parse(s); last = evt; _handleExportEvent(evt, titleText); } catch (e) {}
    }
    return last;
}

function _handleExportEvent(evt, titleText) {
    if (!evt || typeof evt !== 'object') return;
    var ev = evt.event;
    if (ev === 'start') {
        setLoadingProgress(0, 'Starting export of ' + (evt.total || '?') + ' report(s)...', '');
        return;
    }
    if (ev === 'stage') {
        setLoadingProgress(typeof evt.percent === 'number' ? evt.percent : null,
            evt.message || ('Stage: ' + evt.stage), '');
        return;
    }
    if (ev === 'report') {
        var detail = 'Report ' + evt.current + ' of ' + evt.total + ' — ' + (evt.status || '');
        setLoadingProgress(typeof evt.percent === 'number' ? evt.percent : null,
            evt.message || ('Exporting report ' + evt.current + ' of ' + evt.total + '...'), detail);
        return;
    }
    if (ev === 'done') {
        setLoadingProgress(100, 'Export complete', '');
        setTimeout(function () {
            hideLoadingOverlay();
            if (evt.ok) {
                showAppModal(_summariseExportResult(evt), titleText);
            } else {
                showAppModal(
                    (evt.failed && evt.failed.length)
                        ? 'Failed to export. Please format the pendrive (FAT32 or exFAT) and try again.'
                        : 'Export finished but no files were written.',
                    titleText);
            }
        }, 350);
        return;
    }
    if (ev === 'error') {
        hideLoadingOverlay();
        showAppModal(_friendlyExportError(evt.message || 'Export failed.'), titleText);
    }
}

function _gatherPdfHtmlByIdSequentialWithProgress(ids, titleText) {
    var collected = {};
    var i = 0;
    var savedReportId = currentReportId;
    var savedReportData = currentReportData;
    function step() {
        if (i >= ids.length) {
            setLoadingProgress(25, 'Previews rendered. Connecting to pendrive...', '');
            return Promise.resolve(collected);
        }
        var id = ids[i];
        var pct = 10 + ((i / ids.length) * 15);
        setLoadingProgress(pct, 'Rendering preview ' + (i + 1) + ' of ' + ids.length + '...', 'Report id ' + id);
        return buildReportPreviewHtmlById(id).then(function (html) {
            if (html) collected[String(id)] = html;
        }).catch(function () {}).then(function () {
            i++;
            return step();
        });
    }
    currentReportId = savedReportId;
    currentReportData = savedReportData;
    return Promise.resolve().then(step);
}

function exportAuditTrails() {
    if (typeof canViewAuditLog === 'function' && !canViewAuditLog()) {
        showAppModal("You Don't Have Access to Audit Trail", 'Audit');
        return;
    }
    var u = window.currentUser;
    if (!userCanExportToUsb(u)) {
        showAppModal('You do not have permission to export audit trails to USB.', 'Export');
        return;
    }
    var role = typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '';

    var userEl = document.getElementById('audit-filter-user');
    var roleEl = document.getElementById('audit-filter-role');
    var actionEl = document.getElementById('audit-filter-action');
    var fromDate = document.getElementById('audit-filter-from-date');
    var fromTime = document.getElementById('audit-filter-from-time');
    var toDate = document.getElementById('audit-filter-to-date');
    var toTime = document.getElementById('audit-filter-to-time');

    var fromTs = '';
    var toTs = '';
    if (fromDate && fromDate.value) {
        var parts = fromDate.value.split('-');
        var h = fromTime && fromTime.value ? parseInt(fromTime.value.slice(0, 2), 10) : 0;
        var m = fromTime && fromTime.value ? parseInt(fromTime.value.slice(3, 5), 10) : 0;
        fromTs = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), h, m, 0, 0).getTime();
    }
    if (toDate && toDate.value) {
        var parts2 = toDate.value.split('-');
        var h2 = toTime && toTime.value ? parseInt(toTime.value.slice(0, 2), 10) : 23;
        var m2 = toTime && toTime.value ? parseInt(toTime.value.slice(3, 5), 10) : 59;
        toTs = new Date(parseInt(parts2[0], 10), parseInt(parts2[1], 10) - 1, parseInt(parts2[2], 10), h2, m2, 59, 999).getTime();
    }

    var filters = {};
    if (userEl && userEl.value) filters.user = userEl.value;
    if (roleEl && roleEl.value) filters.role = roleEl.value;
    if (actionEl && actionEl.value) filters.action = actionEl.value;
    if (fromTs) filters.from = fromTs;
    if (toTs) filters.to = toTs;

    var titleText = 'Export Audit';
    var batchId = null;

    apiRequest(API_BASE + '/api/audit/export/stage', {
        method: 'POST',
        body: { filters: filters }
    }).then(function (stageRes) {
        if (!stageRes || !stageRes.success) {
            throw new Error((stageRes && stageRes.error) || 'Failed to stage audit export.');
        }
        if (!stageRes.entryCount) {
            showAppModal('No audit entries match the current filters.', titleText);
            return null;
        }
        batchId = stageRes.batchId;
        return showUsbExportVerifyModal({
            title: 'Verify USB Pendrive',
            message: 'Connect the USB pendrive and confirm it is ready. After export, verify the PDF on the pendrive, then tap OK.',
            fallbackConfirm: 'USB pendrive ready?'
        });
    }).then(function (usbOk) {
        if (!usbOk) return;
        return _ensureExportApprovalToken().then(function (token) {
            if (role !== 'factory' && !token) {
                showAppModal('Export cancelled — approval is required.', titleText);
                return;
            }
            var exportHeaders = token ? { 'X-Approval-Verify-Token': token } : {};
            showLoadingOverlay(titleText, 'Detecting external pendrive...', { cancellable: false, progress: true });
            setLoadingProgress(5, 'Detecting external pendrive...', '');
            return apiRequest(API_BASE + '/api/usb/list').then(function (data) {
                var devices = (data && data.devices) ? data.devices : [];
                if (!devices.length) {
                    hideLoadingOverlay();
                    showAppModal('No external pendrive detected. Please connect a USB pendrive and try again.', titleText);
                    return;
                }
                var pickPromise = devices.length === 1 ? Promise.resolve(devices[0].path) : pickPendrive(devices);
                if (devices.length > 1) hideLoadingOverlay();
                return pickPromise.then(function (devicePath) {
                    if (!devicePath) return;
                    showLoadingOverlay(titleText, 'Generating audit-trail PDF...', { cancellable: false, progress: true });
                    setLoadingProgress(25, 'Mounting pendrive...', devicePath);
                    return apiRequest(API_BASE + '/api/audit/export', {
                        method: 'POST',
                        headers: exportHeaders,
                        body: { filters: filters, device_path: devicePath, batch_id: batchId }
                    }).then(function (res) {
                        hideLoadingOverlay();
                        if (res && res.success) {
                            return showUsbExportVerifyModal({
                                title: 'Verify Audit Export',
                                message: 'Open the audit PDF on the USB pendrive and confirm the export is correct. Exported rows will be purged from this device after 24 hours.',
                                fallbackConfirm: 'Audit PDF verified on USB?'
                            }).then(function (verified) {
                                if (verified) {
                                    showAppModal(
                                        'Audit trail export successful.\n\n' + (res.retentionNote || 'Exported audit rows will be purged after 24 hours.'),
                                        titleText
                                    );
                                }
                            });
                        }
                        showAppModal(_friendlyExportError((res && res.error) || 'audit export failed'), titleText);
                    });
                });
            });
        });
    }).catch(function (err) {
        hideLoadingOverlay();
        showAppModal(_friendlyExportError(err), titleText);
    });
}

function exportFilteredReports() {
    goToPage('export');
}

function exportFromSelection(type) {
    if (type === 'audit') {
        exportAuditTrails();
        return;
    }
    var exportFilter = (currentReportFilter === 'test' || currentReportFilter === 'validation' || currentReportFilter === 'calibration')
        ? currentReportFilter
        : (lastReportListFilter || 'all');
    apiRequest(API_BASE + '/api/data/reports?filter=' + encodeURIComponent(exportFilter)).then(function (data) {
        var list = (data && data.reports) ? data.reports : [];
        var reportIds = [];
        list.forEach(function (r) {
            var parsed = Number(r && r.id);
            if (Number.isFinite(parsed) && parsed > 0 && reportIds.indexOf(parsed) === -1) {
                reportIds.push(parsed);
            }
        });
        if (!reportIds.length) {
            showAppModal('No reports available for export in the selected filter.', 'Export Reports');
            return;
        }
        _exportReportsWithFlow(reportIds, { title: 'Export Reports' });
    }).catch(function (err) {
        showAppModal('Failed to export reports: ' + (err && err.message ? err.message : 'Unknown error'), 'Export Reports');
    });
}

function reportActionsBlockedForPreview(preview) {
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    var approvalSt = String(p.reportApprovalStatus || '').trim().toLowerCase();
    return approvalSt === 'pending' &&
        (reportTypeNorm === 'test' || reportTypeNorm === 'validation' || reportTypeNorm === 'calibration');
}

function buildReportPrintPayload(preview, reportId) {
    if (!preview) return null;
    var td = preview.testData || preview;
    if (!td || typeof td !== 'object') td = {};
    var recipe = preview.recipe || td.recipe || {};
    var approvalPassFail = preview.approvalPassFail || td.approvalPassFail || '';
    if (!approvalPassFail && Array.isArray(td.stepResults)) {
        for (var i = 0; i < td.stepResults.length; i++) {
            var row = td.stepResults[i] || {};
            var rowResult = row.resultText || row.result || '';
            if (rowResult && !/pending approval/i.test(String(rowResult))) {
                approvalPassFail = rowResult;
                break;
            }
        }
    }
    if (approvalPassFail && !td.approvalPassFail) {
        td = Object.assign({}, td, { approvalPassFail: approvalPassFail });
    }
    return {
        id: reportId != null ? reportId : preview.id,
        type: preview.type || 'test',
        testData: td,
        recipe: recipe,
        factorySettings: preview.factorySettings || {},
        statistics: {},
        remarks: preview.approvalRemarks || preview.remarks || td.remarks || '',
        reportApprovalStatus: preview.reportApprovalStatus,
        approvalPassFail: approvalPassFail,
        drumPassFail: preview.drumPassFail || td.drumPassFail || {
            drum1: getReportDrumPassFail({ testData: td, approvalPassFail: approvalPassFail }, 0),
            drum2: getReportDrumPassFail({ testData: td, approvalPassFail: approvalPassFail }, 1)
        },
        approvalRemarks: preview.approvalRemarks,
        approvedBy: preview.approvedBy,
        approvedAt: preview.approvedAt,
        createdAt: preview.createdAt || td.createdAt,
        completedAt: preview.completedAt || td.completedAt,
        operatorName: preview.operatorName || td.operatorName,
        employeeId: preview.employeeId || td.employeeId,
        validationRuns: preview.validationRuns || td.validationRuns
    };
}

function getReportDrumPassFail(preview, index) {
    var p = preview || {};
    var td = p.testData || p || {};
    var rows = Array.isArray(td.stepResults) ? td.stepResults : [];
    var row = rows[index] || {};
    var value = row.approvalPassFail || row.resultText || row.result || '';
    if (!value || /pending approval/i.test(String(value))) {
        var drumMap = td.drumPassFail || p.drumPassFail || {};
        value = index === 0 ? drumMap.drum1 : drumMap.drum2;
    }
    if (!value || /pending approval/i.test(String(value))) {
        value = td.approvalPassFail || p.approvalPassFail || '';
    }
    return value ? String(value).toUpperCase() : '--';
}

function resolveReportDataForPrint(callback) {
    var rid = currentReportId;
    if (!rid) {
        callback(null);
        return;
    }
    var fromPreview = typeof buildReportPrintPayload === 'function'
        ? buildReportPrintPayload(window._lastReportPreview, rid) : null;
    if (fromPreview && fromPreview.testData) {
        currentReportData = fromPreview;
        callback(fromPreview);
        return;
    }
    if (currentReportData && currentReportData.testData) {
        callback(currentReportData);
        return;
    }
    apiRequest(API_BASE + '/api/data/reports/' + rid).then(function (data) {
        var reportData = data.report || data;
        if (reportData) {
            reportData.id = reportData.id != null ? reportData.id : rid;
            currentReportData = reportData;
            callback(reportData);
        } else {
            callback(null);
        }
    }).catch(function () { callback(null); });
}

function handlePrintReport() {
    if (!userCanPrintReports()) {
        showAppModal('You do not have permission to print reports.', 'Print');
        return;
    }
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before printing.', 'Print');
        return;
    }
    if (!currentReportId) {
        showAppModal('No report selected to print.', 'Print');
        return;
    }
    resolveReportDataForPrint(function (reportData) {
        if (!reportData) {
            showAppModal('Could not load report data. Please try again.', 'Print');
            return;
        }
        fetch((API_BASE || '') + '/api/print/a4', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_data: reportData })
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (result) {
            if (result.success !== false && !result.error) {
                showAppModal('Sent to A4 printer.', 'Print');
            } else {
                showAppModal(result.error || 'A4 print failed. Check printer connection.', 'Print');
            }
        }).catch(function (e) {
            showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
        });
    });
}

function handlePrintThermal() {
    showAppModal('Thermal printer is not available on Dissolution Tester.', 'Print');
}

function handleExportReport() {
    if (typeof reportActionsBlockedForPreview === 'function' && reportActionsBlockedForPreview()) {
        showAppModal('This report must be approved before export.', 'Export');
        return;
    }
    if (!currentReportId) {
        showAppModal('No report selected to export.', 'Export');
        return;
    }
    _exportReportsWithFlow([currentReportId], { title: 'Export Report' });
}

function setRecipePrintEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value != null && value !== '' ? value : 'N/A';
}

function populateRecipePrintPreview(recipe, factorySettings) {
    if (!recipe) return;
    currentRecipeForPrint = recipe;
    var fs = factorySettings || recipe.factorySettings || {};
    setRecipePrintEl('recipe-print-company-name', fs.companyName || 'N/A');
    setRecipePrintEl('recipe-print-model-no', fs.modelNo || 'N/A');
    setRecipePrintEl('recipe-print-serial-no', fs.serialNo || 'N/A');
    setRecipePrintEl('recipe-print-location', fs.companyLocation || fs.location || 'N/A');
    setRecipePrintEl('recipe-print-instrument-no', fs.instrumentId || 'N/A');
    setRecipePrintEl('recipe-print-previous-val', fs.lastValidationDate || 'N/A');
    setRecipePrintEl('recipe-print-next-validation', fs.nextValidationDate || 'N/A');
    setRecipePrintEl('recipe-print-product', recipe.productName || recipe.name || '--');
    var usp = recipe.usp || recipe.uspMode || '';
    if (!usp && String(recipe.uspMode || '').toUpperCase() === 'CUSTOM') usp = 'Custom';
    if (!usp) usp = 'USP';
    setRecipePrintEl('recipe-print-usp', usp || '--');
    var speed = recipe.speed || (recipe.steps && recipe.steps.length ? recipe.steps[0].speed : null);
    setRecipePrintEl('recipe-print-speed', speed != null ? (speed + ' RPM') : '--');
    var tbody = document.getElementById('recipe-print-tolerance-body');
    if (tbody) {
        var stepCount = (recipe.stepCount != null) ? recipe.stepCount : (recipe.steps ? recipe.steps.length : '--');
        tbody.innerHTML =
            '<tr><td>Steps</td><td>' + stepCount + '</td><td></td></tr>';
    }
}

function openRecipePrintPreview(recipeIdOrRecipe) {
    var recipeId = typeof recipeIdOrRecipe === 'object' && recipeIdOrRecipe !== null ? recipeIdOrRecipe.id : recipeIdOrRecipe;
    var recipe = typeof recipeIdOrRecipe === 'object' && recipeIdOrRecipe !== null ? recipeIdOrRecipe : null;
    function openWithRecipe(r, fs) {
        populateRecipePrintPreview(r, fs);
        goToPage('recipe-print-preview');
        resetRecipePrintPreviewScroll();
        setTimeout(function () {
            resetRecipePrintPreviewScroll();
        }, 50);
    }
    if (recipe && recipe.id) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            openWithRecipe(recipe, fs);
        }).catch(function () {
            openWithRecipe(recipe, null);
        });
        return;
    }
    if (!recipeId) return;
    apiRequest(API_BASE + '/api/data/recipes/' + recipeId).then(function (data) {
        var r = data.recipe || data;
        if (!r) {
            showAppModal('Recipe not found.', 'View Recipe');
            return;
        }
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (fsData) {
            var fs = (fsData && fsData.settings) ? fsData.settings : (fsData || {});
            openWithRecipe(r, fs);
        }).catch(function () {
            openWithRecipe(r, null);
        });
    }).catch(function () {
        showAppModal('Recipe not found.', 'View Recipe');
    });
}

function handlePrintRecipeA4() {
    if (!currentRecipeForPrint) {
        showAppModal('No recipe to print. Open a recipe from View Recipe first.', 'Print');
        return;
    }
    var payload = { type: 'recipe', recipe_data: currentRecipeForPrint };
    if (!currentRecipeForPrint.factorySettings) {
        apiRequest(API_BASE + '/api/data/factory-settings').then(function (data) {
            var fs = (data && data.settings) ? data.settings : (data || {});
            payload.recipe_data = Object.assign({}, currentRecipeForPrint, { factorySettings: fs });
            doPrintA4();
        }).catch(function () { doPrintA4(); });
    } else {
        doPrintA4();
    }
    function doPrintA4() {
        fetch((API_BASE || '') + '/api/print/a4', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (result) {
            if (result.success !== false && !result.error) {
                showAppModal('Sent to A4 printer.', 'Print');
            } else {
                showAppModal(result.error || 'A4 print failed. Check printer connection.', 'Print');
            }
        }).catch(function (e) {
            showAppModal('Print failed: ' + (e && e.message ? e.message : 'Check printer connection.'), 'Print');
        });
    }
}

function handlePrintRecipeThermal() {
    showAppModal('Thermal printer is not available on Dissolution Tester.', 'Print');
}
function scrollReportPreviewActionsIntoView() {
    var bar = document.getElementById('report-preview-actions');
    if (!bar) return;
    bar.classList.remove('report-actions-highlight');
    void bar.offsetWidth;
    bar.classList.add('report-actions-highlight');
    try {
        bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) {
        bar.scrollIntoView(true);
    }
}

function resetReportPreviewScroll() {
    var page = document.getElementById('page-report-preview');
    var scroller = page ? page.querySelector('.reports-container') : null;
    if (page) page.scrollTop = 0;
    if (scroller) scroller.scrollTop = 0;
}

function resetRecipePrintPreviewScroll() {
    var page = document.getElementById('page-recipe-print-preview');
    var scroller = page ? page.querySelector('.reports-container') : null;
    if (page) page.scrollTop = 0;
    if (scroller) scroller.scrollTop = 0;
}

function openReportPreview(reportId, options) {
    if (!reportId) return;
    if (!userCanViewReports()) {
        denyPermission('view reports');
        return;
    }
    options = options || {};
    apiRequest(API_BASE + '/api/reports/' + reportId + '/preview').then(function (data) {
        if (data.preview) {
            currentReportId = reportId;
            currentReportData = null;
            populateReportPreview(data.preview);
            if (options.setGate && isReportPendingApproval(data.preview)) {
                var forceOp = getReportOperatedByUsername(data.preview) || getCurrentReportUsername();
                setReportApprovalGate(reportId, forceOp);
            } else {
                setReportApprovalGateFromPreview(data.preview, reportId);
            }
            applyReportPreviewLockUi(data.preview);
            goToPage('report-preview');
            resetReportPreviewScroll();
            startReportApprovalPollIfLocked();
            setTimeout(function () {
                resetReportPreviewScroll();
                if (isReportPreviewLockedForCurrentUser(data.preview)) {
                    scrollReportPendingBannerIntoView();
                    return;
                }
                if (isReportPendingApproval(data.preview)) {
                    scrollReportApprovePanelIntoView();
                }
            }, 250);
        } else {
            showAppModal('Report preview is not available.', 'Reports');
        }
    }).catch(function () {
        showAppModal('Could not open report preview. Check your connection and try again from Reports.', 'Reports');
    });
}

function setReportEl(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value != null && value !== '' ? value : 'N/A';
}

function escapeReportHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatReportDate(isoStr) {
    if (!isoStr) return '--';
    var d = new Date(isoStr);
    if (isNaN(d.getTime())) return '--';
    var dd = String(d.getDate()).padStart(2, '0');
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var yy = d.getFullYear();
    var h = String(d.getHours()).padStart(2, '0');
    var m = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    return dd + '/' + mm + '/' + yy + ' ' + h + ':' + m + ':' + s;
}

function populateReportPreview(preview) {
    if (!preview) return;
    var a4Pre = document.getElementById('report-a4-pre');
    if (a4Pre) {
        var a4 = preview.a4Text;
        if (a4 == null || String(a4).trim() === '') {
            a4Pre.textContent = 'Report text unavailable.';
        } else {
            a4Pre.textContent = String(a4);
        }
    }

    window._lastReportPreview = preview;
    if (currentReportId != null && typeof buildReportPrintPayload === 'function') {
        currentReportData = buildReportPrintPayload(preview, currentReportId);
    }
    applyReportPreviewLockUi(preview);
}

function updateReportPreviewPrintExportButtons(preview) {
    var peGroup = document.getElementById('report-preview-print-export-group');
    if (!peGroup) return;
    var p = preview || window._lastReportPreview || {};
    var reportTypeNorm = String(p.type || 'test').trim().toLowerCase();
    var approvalSt = String(p.reportApprovalStatus || '').trim().toLowerCase();
    var blockActions = approvalSt === 'pending' &&
        (reportTypeNorm === 'test' || reportTypeNorm === 'validation' || reportTypeNorm === 'calibration');
    var canPrint = typeof userCanPrintReports === 'function' && userCanPrintReports() && !blockActions;
    var canExport = typeof userCanExportToUsb === 'function' && userCanExportToUsb() && !blockActions;
    peGroup.style.display = (canPrint || canExport) ? 'flex' : 'none';
    peGroup.querySelectorAll('.btn-print, .btn-print-thermal').forEach(function (btn) {
        btn.style.display = canPrint ? '' : 'none';
    });
    var expBtn = peGroup.querySelector('.btn-export');
    if (expBtn) expBtn.style.display = canExport ? '' : 'none';
}

function verifyReportApproverInline(method) {
    method = method === 'biometric' ? 'biometric' : 'credentials';
    clearReportApproveVerifyError();
    var preview = window._lastReportPreview || {};
    var reportType = String(preview.type || 'test').trim().toLowerCase() || 'test';
    var reportId = currentReportId != null ? currentReportId
        : (window._reportApprovalGate && window._reportApprovalGate.reportId);
    if (method === 'biometric') {
        return runBiometricVerifyWithRetry({
            purpose: 'report',
            reportId: reportId,
            reportType: reportType,
            title: 'Verify Fingerprint',
            message: 'Place a Reviewer or Admin fingerprint on the scanner to approve this report.',
            failureHint: 'Place your finger on the scanner and tap Try again.'
        }).then(function (result) {
            if (!result || !result.ok) {
                if (result && result.error !== 'cancelled') {
                    setReportApproveVerifyError(
                        result.message || result.error || 'Fingerprint verification failed.',
                        { showBiometricRetry: true }
                    );
                } else if (result && result.error === 'cancelled' && result.message) {
                    setReportApproveVerifyError(result.message, { showBiometricRetry: true });
                }
                return null;
            }
            setReportApproveBiometricRetryVisible(false);
            return result.token;
        });
    }
    var usernameEl = document.getElementById('report-approve-verifier-username');
    var passwordEl = document.getElementById('report-approve-verifier-password');
    var username = usernameEl ? String(usernameEl.value || '').trim() : '';
    var password = passwordEl ? String(passwordEl.value || '') : '';
    if (!username || !password) {
        setReportApproveVerifyError('Enter Reviewer or Admin User ID and password.');
        return Promise.resolve(null);
    }
    if (typeof isCurrentUserReportOperator === 'function' && isCurrentUserReportOperator(window._lastReportPreview)) {
        var opUser = typeof getReportOperatedByUsername === 'function'
            ? getReportOperatedByUsername(window._lastReportPreview) : '';
        var enteredNorm = typeof normalizeReportUsername === 'function'
            ? normalizeReportUsername(username) : String(username).trim().toLowerCase();
        if (opUser && enteredNorm && enteredNorm === opUser) {
            setReportApproveVerifyError('You cannot approve your own report. A Reviewer or Admin must sign below.');
            return Promise.resolve(null);
        }
    }
    var verifyBody = {
        method: 'credentials',
        username: username,
        password: password,
        purpose: 'report',
        reportType: reportType
    };
    if (reportId != null) verifyBody.reportId = reportId;
    return apiRequest(API_BASE + '/api/data/auth/approval-verify', {
        method: 'POST',
        body: verifyBody
    }).then(function (data) {
        if (!data || !data.ok || !data.token) {
            setReportApproveVerifyError((data && data.error) ? String(data.error) : 'Verification failed.');
            return null;
        }
        return String(data.token);
    }).catch(function (err) {
        setReportApproveVerifyError('Verification failed: ' + (err && err.message ? err.message : 'Error'));
        return null;
    });
}

function approveReportWithVerifier(reportId, passFail, remarks, verifyMethod) {
    verifyMethod = verifyMethod === 'biometric' ? 'biometric' : 'credentials';
    var role = (typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '');

    function postReportApprove(extraHeaders) {
        return apiRequest(API_BASE + '/api/data/reports/' + reportId + '/approve', {
            method: 'POST',
            headers: extraHeaders || {},
            body: { passFail: passFail, remarks: remarks }
        }).then(function (data) {
            if (data && data.ok) return data;
            var msg = (data && data.error) ? String(data.error) : 'Approval failed.';
            setReportApproveVerifyError(msg);
            return null;
        });
    }

    if (role === 'factory') {
        return postReportApprove({});
    }

    return verifyReportApproverInline(verifyMethod).then(function (token) {
        if (!token) return null;
        return postReportApprove({ 'X-Approval-Verify-Token': token });
    });
}

function applyApprovedReportResponse(data, reportId) {
    if (data && (data.preview || data.report) && typeof populateReportPreview === 'function') {
        var preview = data.preview || data.report;
        currentReportId = reportId;
        currentReportData = null;
        populateReportPreview(preview);
        clearReportApprovalGate();
        applyReportPreviewLockUi(preview);
    } else {
        clearReportApprovalGate();
        openReportPreview(reportId);
    }
}

function submitReportApprove() {
    var id = currentReportId;
    if (id == null) return;
    var pfEl = document.querySelector('input[name="report-approve-pass-fail"]:checked');
    var pf = pfEl ? String(pfEl.value).toUpperCase() : '';
    if (pf !== 'PASS' && pf !== 'FAIL') {
        setReportApproveVerifyError('Select Pass or Fail.');
        return;
    }
    var ta = document.getElementById('report-approve-remarks-input');
    var remarks = ta ? ta.value.trim() : '';
    clearReportApproveVerifyError();
    approveReportWithVerifier(id, pf, remarks, 'credentials').then(function (data) {
        if (data && data.ok) {
            resetReportApproveForm();
            window._reportApproveFormReportId = null;
            applyApprovedReportResponse(data, id);
            showAppModal('Report approved.', 'Report');
            setTimeout(function () {
                _saveReportPdfSilent(id);
                var row = document.getElementById('report-approved-by');
                if (row) {
                    try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { row.scrollIntoView(true); }
                }
                scrollReportPreviewActionsIntoView();
            }, 600);
        }
    }).catch(function (err) {
        setReportApproveVerifyError('Approval failed: ' + (err && err.message ? err.message : 'Error'));
    });
}

function submitReportApproveBiometric() {
    var id = currentReportId;
    if (id == null) return;
    var pfEl = document.querySelector('input[name="report-approve-pass-fail"]:checked');
    var pf = pfEl ? String(pfEl.value).toUpperCase() : '';
    if (pf !== 'PASS' && pf !== 'FAIL') {
        setReportApproveVerifyError('Select Pass or Fail.');
        return;
    }
    var ta = document.getElementById('report-approve-remarks-input');
    var remarks = ta ? ta.value.trim() : '';
    clearReportApproveVerifyError();-
    setReportApproveBiometricRetryVisible(false);
    approveReportWithVerifier(id, pf, remarks, 'biometric').then(function (data) {
        if (data && data.ok) {
            resetReportApproveForm();
            window._reportApproveFormReportId = null;
            applyApprovedReportResponse(data, id);
            showAppModal('Report approved.', 'Report');
            setTimeout(function () {
                _saveReportPdfSilent(id);
                var row = document.getElementById('report-approved-by');
                if (row) {
                    try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { row.scrollIntoView(true); }
                }
                scrollReportPreviewActionsIntoView();
            }, 600);
        }
    }).catch(function (err) {
        setReportApproveVerifyError('Approval failed: ' + (err && err.message ? err.message : 'Error'));
    });
}


function isDissolutionRecipe(recipe) {
    if (!recipe) return false;
    if (String(recipe.recipeType || '').toLowerCase() === 'dissolution') return true;
    return !!(recipe.steps && recipe.steps.length && recipe.temperature != null && recipe.mode);
}

function closeTestRunCompletionApprovalModal() {}

function openRecipeActionsModal(recipeId) {
    window._recipeActionsId = recipeId;
    var recipe = lastDisplayedRecipes && lastDisplayedRecipes.find(function (r) { return r.id === recipeId; });
    var titleEl = document.getElementById('recipe-actions-modal-title');
    if (titleEl) titleEl.textContent = (recipe && (recipe.productName || recipe.name)) ? (recipe.productName || recipe.name) : 'Recipe';
    var apprBtn = document.getElementById('recipe-action-approve-btn');
    if (apprBtn) {
        var st = recipe ? recipe.recipeApprovalStatus : null;
        var showAppr = !!(recipe && st === 'pending' && userCanApproveByQaRule());
        apprBtn.style.display = showAppr ? '' : 'none';
    }
    var overlay = document.getElementById('recipe-actions-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRecipeActionsModal() {
    window._recipeActionsId = null;
    var overlay = document.getElementById('recipe-actions-modal-overlay');
    if (overlay) overlay.style.display = 'none';
}

function confirmRecipeAction(action) {
    var id = window._recipeActionsId;
    closeRecipeActionsModal();
    if (id == null) return;
    if (action === 'edit') {
        editRecipe(id);
    } else if (action === 'disable') {
        disableRecipe(id);
    } else if (action === 'load') {
        loadRecipeById(id);
    } else if (action === 'approve') {
        openRecipeApproveModal(id);
    }
}

function openRecipeApproveModal(recipeId) {
    window._recipeApproveId = recipeId;
    var ta = document.getElementById('recipe-approve-remarks');
    if (ta) ta.value = '';
    var overlay = document.getElementById('recipe-approve-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRecipeApproveModal() {
    window._recipeApproveId = null;
    var overlay = document.getElementById('recipe-approve-overlay');
    if (overlay) overlay.style.display = 'none';
}

function submitRecipeApprove() {
    var id = window._recipeApproveId;
    if (id == null) return;
    var ta = document.getElementById('recipe-approve-remarks');
    var remarks = ta ? ta.value.trim() : '';
    var name = (window.currentUser && (window.currentUser.name || window.currentUser.username)) ? (window.currentUser.name || window.currentUser.username) : '';
    refreshActiveQaCount().then(function () {
        return openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
            if (!token) return;
            return apiRequest(API_BASE + '/api/data/recipes/' + id + '/approve', {
                method: 'POST',
                headers: { 'X-Approval-Verify-Token': token },
                body: { remarks: remarks, approverName: name }
            }).then(function (data) {
                closeRecipeApproveModal();
                if (data && data.ok) {
                    showAppModal('Recipe approved.', 'Recipes');
                    loadManageRecipes();
                } else {
                    showAppModal((data && data.error) ? String(data.error) : 'Approval failed.', 'Recipes');
                }
            });
        });
    }).catch(function (err) {
        showAppModal('Approval failed: ' + (err && err.message ? err.message : 'Error'), 'Recipes');
    });
}

/** Opens credential modal and approves recipe; resolves { ok }, { cancelled: true }, or { ok: false }. */
function approveSavedRecipeWithCredentials(recipeId, modalTitle, remarks) {
    var title = modalTitle || 'Recipes';
    var name = (window.currentUser && (window.currentUser.name || window.currentUser.username)) ? (window.currentUser.name || window.currentUser.username) : '';
    var remarksStr = remarks != null ? String(remarks).trim() : '';
    var rid = parseInt(recipeId, 10);
    if (isNaN(rid) || rid < 1) {
        showAppModal('Invalid recipe id for approval.', title);
        return Promise.resolve({ ok: false });
    }
    return refreshActiveQaCount().then(function () {
        return openApprovalVerifyModal(_approvalVerifyModalOptionsForRecipe()).then(function (token) {
            if (!token) return { cancelled: true };
            return apiRequest(API_BASE + '/api/data/recipes/' + rid + '/approve', {
                method: 'POST',
                headers: { 'X-Approval-Verify-Token': token },
                body: { remarks: remarksStr, approverName: name }
            }).then(function (data) {
                if (data && data.ok) {
                    showAppModal('Recipe approved.', title);
                    loadManageRecipes();
                    return { ok: true };
                }
                showAppModal((data && data.error) ? String(data.error) : 'Approval failed.', title);
                return { ok: false };
            });
        });
    }).catch(function (err) {
        var msg = err && err.message ? String(err.message) : 'Error';
        if (msg.toLowerCase() === 'forbidden') {
            msg += ' — restart the Dissolution Tester server after updating, or hard-refresh the page (cached UI).';
        }
        showAppModal('Approval failed: ' + msg, title);
        return { ok: false };
    });
}

function editRecipe(id) {
    window.currentEditingRecipeId = id;
    goToPage('create-recipe-step1');
}

function loadRecipeForEdit() {
    var id = window.currentEditingRecipeId;
    if (!id) return;
    apiRequest(API_BASE + '/api/data/recipes/' + id).then(function (data) {
        var r = data.recipe || data;
        if (!r) return;

        if (typeof isDissolutionRecipe === 'function' && isDissolutionRecipe(r)) {
            var nameEl = document.getElementById('recipe-product-name');
            var tempEl = document.getElementById('recipe-temperature');
            var countEl = document.getElementById('recipe-step-count');
            var modeEl = document.getElementById('recipe-mode');
            var uspEl = document.getElementById('recipe-usp');
            var rinseEl = document.getElementById('recipe-rinse-volume');
            var sampleEl = document.getElementById('recipe-sample-volume');
            var repEl = document.getElementById('recipe-replenishment');
            var pfEl = document.getElementById('recipe-power-failure');
            var mediaEl = document.getElementById('recipe-media');
            var mediaVolEl = document.getElementById('recipe-media-volume');
            var mediaPhEl = document.getElementById('recipe-media-ph');
            var batchSizeEl = document.getElementById('recipe-batch-size');

            if (nameEl) nameEl.value = r.productName || r.name || '';
            if (tempEl && r.temperature != null) tempEl.value = String(r.temperature);
            var steps = Array.isArray(r.steps) ? r.steps : [];
            var stepCount = parseInt(r.stepCount, 10);
            if (isNaN(stepCount) || stepCount < 1) stepCount = steps.length || 1;
            if (countEl) countEl.value = String(stepCount);
            if (modeEl) {
                if (r.mode === 'Manual' || r.sampleDrop === 'Manual') modeEl.value = 'Manual';
                else if (r.mode === 'Auto' || r.sampleDrop === 'Auto' || r.autoDispense) modeEl.value = 'Auto';
                else modeEl.value = r.autoDispense === false ? 'Manual' : 'Auto';
            }
            if (uspEl) uspEl.value = (r.usp === 'USP 1' || r.uspMode === 'USP 1') ? 'USP 1' : 'USP 2';
            if (rinseEl) rinseEl.value = r.rinseVolume || '';
            if (sampleEl) sampleEl.value = r.sampleVolume || '';
            if (mediaEl) mediaEl.value = r.media || '';
            if (mediaVolEl) mediaVolEl.value = r.mediaVolume || '';
            if (mediaPhEl && r.mediaPh != null) mediaPhEl.value = String(r.mediaPh);
            if (batchSizeEl) batchSizeEl.value = r.batchSize != null ? String(r.batchSize) : '';
            if (repEl) repEl.value = (r.replenishment === 'No') ? 'No' : 'Yes';
            if (pfEl) {
                var pfMin = parseInt(r.powerFailure, 10);
                pfEl.value = (!isNaN(pfMin) && pfMin >= 1 && pfMin <= 60) ? String(pfMin) : '';
            }
            if (typeof renderDissolutionStepRows === 'function') {
                var recipeSample = r.sampleVolume || '';
                window._createRecipeStepPrefill = steps.map(function (step) {
                    var copy = Object.assign({}, step || {});
                    if (!copy.sampleVolume && recipeSample) copy.sampleVolume = recipeSample;
                    return copy;
                });
                renderDissolutionStepRows(stepCount, 'create-recipe-steps-list', window._createRecipeStepPrefill);
                goToPage('create-recipe-step2');
            }
            return;
        }

        var nameEl2 = document.getElementById('recipe-product-name');
        if (nameEl2) nameEl2.value = r.productName || r.name || '';
    }).catch(function () {});
}

function _getDisabledRecipesFromStorage() {
    try {
        var raw = localStorage.getItem('disabledRecipes');
        if (raw) return JSON.parse(raw) || [];
    } catch (e) {}
    return [];
}

function _saveDisabledRecipesToStorage(list) {
    try {
        localStorage.setItem('disabledRecipes', JSON.stringify(list || []));
    } catch (e) {}
}

function _resolveDisabledRecipeEntry(entry) {
    if (!entry) return null;
    if (entry.steps || entry.productName || entry.name) return entry;
    if (entry.recipe && (entry.recipe.steps || entry.recipe.productName || entry.recipe.name)) {
        return entry.recipe;
    }
    return null;
}

function userCanEnableRecipe(userObj) {
    var u = userObj || window.currentUser;
    if (!u) return false;
    if (typeof isFactorySessionUser === 'function' && isFactorySessionUser(u)) return true;
    return typeof canPerformAction === 'function' && canPerformAction(u, 'recipe-enable', 'change');
}

function disableRecipe(id) {
    apiRequest(API_BASE + '/api/data/recipes/' + id, { method: 'DELETE' }).then(function () {
        try {
            var disabled = _getDisabledRecipesFromStorage();
            var recipe = null;
            if (Array.isArray(lastDisplayedRecipes)) {
                recipe = lastDisplayedRecipes.find(function (r) { return r.id === id; }) || null;
            }

            if (recipe) {
                var snapshot = JSON.parse(JSON.stringify(recipe));
                disabled = disabled.filter(function (d) {
                    var rid = d && d.id != null ? d.id : (_resolveDisabledRecipeEntry(d) || {}).id;
                    return rid !== snapshot.id;
                });
                disabled.push(snapshot);
                _saveDisabledRecipesToStorage(disabled);
            }
        } catch (e) {}

        loadManageRecipes();
        showAppModal('Recipe disabled.', 'Disable Recipe');
    }).catch(function (err) {
        var msg = (err && err.message) ? err.message : 'Failed to disable recipe.';
        showAppModal(msg, 'Disable Recipe');
    });
}

function enableRecipe(id) {
    if (!userCanEnableRecipe()) {
        showAppModal('You do not have permission to enable recipes.', 'Enable Recipe');
        return;
    }
    showConfirmModal('Enable this recipe?', 'Enable Recipe').then(function (ok) {
        if (!ok) return;
        var disabled = _getDisabledRecipesFromStorage();
        var entry = disabled.find(function (d) {
            var rid = d && d.id != null ? d.id : (_resolveDisabledRecipeEntry(d) || {}).id;
            return rid === id;
        });
        var recipe = _resolveDisabledRecipeEntry(entry);
        if (!recipe) {
            showAppModal('Recipe data not found or incomplete. Re-create the recipe if needed.', 'Enable Recipe');
            return;
        }
        var payload = JSON.parse(JSON.stringify(recipe));
        apiRequest(API_BASE + '/api/data/recipes', { method: 'POST', body: payload }).then(function () {
            disabled = disabled.filter(function (d) {
                var rid = d && d.id != null ? d.id : (_resolveDisabledRecipeEntry(d) || {}).id;
                return rid !== id;
            });
            _saveDisabledRecipesToStorage(disabled);
            if (typeof logAuditEvent === 'function') {
                var label = payload.productName || payload.name || ('id ' + id);
                logAuditEvent('Recipe enabled', 'Recipe id ' + id + ': ' + label, {
                    eventType: 'lifecycle',
                    entityType: 'recipe',
                    entityId: id,
                    entityName: label
                });
            }
            loadDisableRecipes();
            loadManageRecipes();
            showAppModal('Recipe enabled.', 'Enable Recipe');
        }).catch(function (err) {
            var msg = (err && err.message) ? err.message : 'Failed to enable recipe.';
            showAppModal(msg, 'Enable Recipe');
        });
    });
}

function loadRecipeById(recipeId) {
    apiRequest(API_BASE + '/api/data/recipes/' + recipeId).then(function (data) {
        var r = data.recipe || data;
        if (!r) {
            showAppModal('Recipe not found.', 'Load Recipe');
            return;
        }
        pendingRecipeToLoad = r;
        pendingRecipeLoadContext = null;
        openBatchNumberModal();
    }).catch(function (err) {
        showAppModal('Recipe not found or failed to load.', 'Load Recipe');
    });
}

function openBatchNumberModal() {
    var overlay = document.getElementById('batch-number-modal');
    var batchInput = document.getElementById('load-recipe-batch-input');
    var arInput = document.getElementById('load-recipe-ar-input');
    var titleEl = overlay ? overlay.querySelector('.param-config-modal-title') : null;
    if (pendingRecipeToLoad && !isDissolutionRecipe(pendingRecipeToLoad)) {
        showAppModal('Only Dissolution recipes can be loaded. Friability/drum recipes are not supported.', 'Load Recipe');
        pendingRecipeToLoad = null;
        pendingRecipeLoadContext = null;
        return;
    }
    if (!pendingRecipeLoadContext) {
        pendingRecipeLoadContext = {
            drumCount: 1,
            step: 1,
            batchNumber1: '',
            arNumber: '',
            dissolution: true
        };
    }
    if (titleEl) titleEl.textContent = 'Enter AR Number & Batch Number';
    if (overlay) overlay.style.display = 'flex';
    if (arInput) arInput.value = '';
    if (batchInput) {
        batchInput.value = '';
        batchInput.focus();
    }
    if (arInput) arInput.focus();
}

function closeBatchNumberModal() {
    var overlay = document.getElementById('batch-number-modal');
    if (overlay) overlay.style.display = 'none';
    var batchInput = document.getElementById('load-recipe-batch-input');
    var arInput = document.getElementById('load-recipe-ar-input');
    if (batchInput) batchInput.value = '';
    if (arInput) arInput.value = '';
    pendingRecipeToLoad = null;
    pendingRecipeLoadContext = null;
}

function promptAutoDispenseSelection(recipe) {
    // Sample Drop Auto/Manual maps to AUTO-DROP; derive autoDispense for compatibility.
    if (isDissolutionRecipe(recipe)) {
        var mode = String(recipe.mode || recipe.sampleDrop || '').trim();
        if (mode === 'Auto' || mode === 'Manual') {
            recipe.autoDispense = (mode === 'Auto');
        } else if (recipe.autoDispense == null) {
            recipe.autoDispense = false;
            recipe.mode = 'Manual';
        }
        return Promise.resolve(!!recipe.autoDispense);
    }
    return showYesNoModal(
        'Auto Dispense before test start?',
        'Auto Dispense',
        'Yes',
        'No'
    ).then(function (yes) {
        recipe.autoDispense = !!yes;
        return recipe.autoDispense;
    });
}

function _finalizeRecipeLoad(recipe, ctx) {
    var resolvedCtx = ctx || {};
    if (!isDissolutionRecipe(recipe) && !resolvedCtx.dissolution) {
        showAppModal('Only Dissolution recipes can be loaded. Friability/drum recipes are not supported.', 'Load Recipe');
        pendingRecipeLoadContext = null;
        pendingRecipeToLoad = null;
        return;
    }
    // Keep a full copy of the loaded recipe (API payload includes media / steps / etc.).
    var runRecipe;
    try {
        runRecipe = JSON.parse(JSON.stringify(recipe));
    } catch (e) {
        runRecipe = Object.assign({}, recipe);
        if (Array.isArray(recipe.steps)) runRecipe.steps = recipe.steps.slice();
    }
    runRecipe.batchNumber1 = (resolvedCtx.batchNumber1 || runRecipe.batchNumber || '--');
    runRecipe.batchNumber = runRecipe.batchNumber1;
    runRecipe.batchNumber2 = null;
    runRecipe.arNumber = (resolvedCtx.arNumber || runRecipe.arNumber || '--');
    if (!runRecipe.recipeType) runRecipe.recipeType = 'dissolution';
    pendingRecipeLoadContext = null;
    pendingRecipeToLoad = null;
    logAuditEvent('Loaded recipe', (runRecipe.productName || 'Recipe') + ', AR ' + (runRecipe.arNumber || '--') + ', batch ' + (runRecipe.batchNumber || '--'), {
        eventType: 'lifecycle'
    });
    window.activeTestRecipe = runRecipe;
    startTestRun(runRecipe);
}

function confirmBatchNumberAndLoad() {
    var batchInput = document.getElementById('load-recipe-batch-input');
    var arInput = document.getElementById('load-recipe-ar-input');
    var batch = batchInput ? batchInput.value.trim() : '';
    var arNumber = arInput ? arInput.value.trim() : '';
    if (!pendingRecipeToLoad) {
        closeBatchNumberModal();
        return;
    }
    if (!isDissolutionRecipe(pendingRecipeToLoad)) {
        showAppModal('Only Dissolution recipes can be loaded. Friability/drum recipes are not supported.', 'Load Recipe');
        closeBatchNumberModal();
        return;
    }
    if (!pendingRecipeLoadContext || !pendingRecipeLoadContext.fromQuickTest) {
        if (getEffectiveRecipeApprovalStatus(pendingRecipeToLoad) === 'pending') {
            showAppModal('This recipe is pending QA approval and cannot be loaded for testing.', 'Load Recipe');
            return;
        }
    }
    if (!arNumber) {
        showAppModal('Please enter AR number.', 'Load Recipe');
        return;
    }
    if (!batch) {
        showAppModal('Please enter batch number.', 'Load Recipe');
        return;
    }
    var ctx = pendingRecipeLoadContext || { drumCount: 1, step: 1, dissolution: true };
    var recipe = Object.assign({}, pendingRecipeToLoad);
    var overlay = document.getElementById('batch-number-modal');
    if (overlay) overlay.style.display = 'none';
    ctx.batchNumber1 = batch;
    ctx.arNumber = arNumber;
    _finalizeRecipeLoad(recipe, ctx);
}

function updateCreateRecipeContinueButton() {
    var nameEl = document.getElementById('recipe-product-name');
    var recipeName = nameEl && nameEl.value ? nameEl.value.trim() : '';
    var mode = getCreateUspMode();
    var speedRadio = document.querySelector('input[name="create-speed"]:checked');
    var heightRadio = document.querySelector('input[name="create-height"]:checked');
    var btn = document.getElementById('create-recipe-continue-btn');

    var needSpeedHeight = mode === 'CUSTOM';
    var speedOk = needSpeedHeight ? !!speedRadio : true;
    var heightOk = needSpeedHeight ? !!heightRadio : true;
    var customOk = true;
    if (mode === 'CUSTOM') {
        var totalEl = document.getElementById('create-custom-total-taps');
        var tv = totalEl ? parseInt(totalEl.value, 10) : 0;
        customOk = !isNaN(tv) && tv >= 1;
    }
    var canContinue = !!(recipeName && speedOk && heightOk && customOk);
    if (btn) {
        btn.disabled = !canContinue;
    }

    var summaryEl = document.getElementById('create-recipe-continue-summary');
    if (summaryEl) {
        if (mode === 'USP') {
            summaryEl.textContent = 'USP — 25 RPM, 4 min, 100 rotations';
        } else if (speedRadio && heightRadio) {
            summaryEl.textContent =
                'Custom — Speed: ' + speedRadio.value + ' Taps/Min, Height: ' + heightRadio.value + ' mm';
        } else {
            summaryEl.textContent = 'Custom — select speed and height';
        }
    }
}

function openCreateRecipeContinueModal() {
    updateCreateRecipeContinueButton();
    var btn = document.getElementById('create-recipe-continue-btn');
    if (btn && btn.disabled) return;
    var overlay = document.getElementById('create-recipe-continue-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeCreateRecipeContinueModal() {
    var overlay = document.getElementById('create-recipe-continue-overlay');
    if (overlay) overlay.style.display = 'none';
}

function updateCreateRecipeStepsView() {
    var n = (typeof window.currentRecipeStepCount === 'number' && window.currentRecipeStepCount > 0)
        ? window.currentRecipeStepCount
        : 10;

    var taps = window._createRecipeStepTaps;
    if (!taps || taps.length !== n) {
        taps = computeStandardUspTaps(n);
    }

    var note = document.getElementById('create-recipe-steps-note');
    if (note) {
        var mode = getCreateUspMode();
        if (mode === 'CUSTOM') {
            note.textContent =
                'Configuring ' + n + ' step' + (n === 1 ? '' : 's') + ' — custom total taps split as below.';
        } else {
            note.textContent =
                'Configuring ' + n + ' step' + (n === 1 ? '' : 's') +
                ' (Step 1: 10 taps, Step 2: 500 taps, remaining: 1250 taps).';
        }
    }

    for (var i = 1; i <= 10; i++) {
        var row = document.getElementById('create-recipe-step-row-' + i);
        if (!row) continue;
        row.style.display = i <= n ? '' : 'none';
        if (i <= n) {
            var spans = row.querySelectorAll('span');
            if (spans.length >= 2) {
                spans[1].textContent = String(taps[i - 1] != null ? taps[i - 1] : '');
            }
        }
    }
}

function confirmCreateRecipeContinue() {
    var stepCountEl = document.getElementById('create-recipe-step-count');
    var stepCount = stepCountEl ? parseInt(stepCountEl.value, 10) || 10 : 10;
    var taps = computeCreateRecipeStepTapsForStepCount(stepCount);
    if (getCreateUspMode() === 'CUSTOM' && !taps) {
        showAppModal('Enter total taps (at least ' + stepCount + ', one tap per step).', 'Create Recipe');
        return;
    }
    window._createRecipeStepTaps = taps || computeStandardUspTaps(stepCount);
    window.currentRecipeStepCount = stepCount;
    closeCreateRecipeContinueModal();
    updateCreateRecipeStepsView();
    goToPage('create-recipe-step2');
}

function getRecipes() {
    return apiRequest(API_BASE + '/api/data/recipes', {
        method: 'GET'
    }).then(function (data) {
        return (data && data.recipes) ? data.recipes : [];
    }).catch(function (err) {
        console.error('Failed to fetch recipes:', err);
        return [];
    });
}

function loadViewRecipes() {
    var tbody = document.getElementById('view-recipes-table-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    getRecipes().then(function (recipes) {
        if (!recipes.length) {
            var tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="2">No recipes.</td>';
            tbody.appendChild(tr);
            return;
        }
        recipes.forEach(function (r) {
            var tr = document.createElement('tr');
            var name = r.productName || r.name || '--';
            tr.innerHTML =
                '<td>' + name + '</td>' +
                '<td class="view-col"><button class="reports-open-btn view-recipe-btn" onclick="openRecipePrintPreview(' + (r.id || 0) + ')" title="View">View</button></td>';
            tbody.appendChild(tr);
        });
    }).catch(function () {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="2">Unable to load recipes.</td>';
        tbody.appendChild(tr);
    });
}

function recipeDropHeightMm(r) {
    if (!r) return null;
    if (r.dropHeight != null && r.dropHeight !== '') {
        var d = parseFloat(r.dropHeight);
        return isNaN(d) ? null : d;
    }
    if (r.steps && r.steps[0] && r.steps[0].dropHeight != null && r.steps[0].dropHeight !== '') {
        var d2 = parseFloat(r.steps[0].dropHeight);
        return isNaN(d2) ? null : d2;
    }
    return null;
}

function recipeTotalTapCount(r) {
    if (!r || !r.steps || !r.steps.length) return null;
    var total = 0;
    for (var i = 0; i < r.steps.length; i++) {
        total += parseInt(r.steps[i].tapCount, 10) || 0;
    }
    return total;
}

function recipeTapSpeed(r) {
    if (!r) return null;
    if (r.speed != null && r.speed !== '') {
        var s = parseInt(r.speed, 10);
        return isNaN(s) ? null : s;
    }
    if (r.steps && r.steps[0]) {
        if (r.steps[0].rpm != null && r.steps[0].rpm !== '') {
            var rpm = parseFloat(r.steps[0].rpm);
            return isNaN(rpm) ? null : rpm;
        }
        if (r.steps[0].speed != null && r.steps[0].speed !== '') {
            var s2 = parseInt(r.steps[0].speed, 10);
            return isNaN(s2) ? null : s2;
        }
    }
    return null;
}

function recipeTestModeLabel(r) {
    if (!r) return '--';
    if (String(r.recipeType || '').toLowerCase() === 'dissolution' || r.mode) {
        var parts = [];
        if (r.mode) parts.push(String(r.mode));
        if (r.usp || r.uspMode) parts.push(String(r.usp || r.uspMode));
        return parts.length ? parts.join(' / ') : 'Dissolution';
    }
    var mode = String(r.uspMode || r.usp || '').toUpperCase();
    if (mode === 'USP') return 'USP';
    if (mode === 'CUSTOM') {
        var comp = String(r.customCompletionMode || '').toUpperCase();
        if (comp === 'TIME') return 'Custom (Time)';
        return 'Custom (Count)';
    }
    return '--';
}

function loadManageRecipes() {
    var msgEl = document.getElementById('manage-recipes-message');
    var tableEl = document.querySelector('.manage-recipes-table');
    var tbody = document.getElementById('manage-recipes-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';
    refreshActiveQaCount();

    getRecipes().then(function (recipes) {
        var mode = recipeListMode === 'load' ? 'load' : 'manage';
        var createBtn = document.querySelector('#page-manage-recipes .btn-create-recipe');
        if (createBtn) createBtn.style.display = (mode === 'load') ? 'none' : '';

        // Adjust header to match mode (Actions vs Load).
        if (tableEl) {
            var headRow = tableEl.querySelector('thead tr');
            if (headRow) {
                if (mode === 'load') {
                    headRow.innerHTML =
                        '<th>Product Name</th>' +
                        '<th>Mode / USP</th>' +
                        '<th>Temp</th>' +
                        '<th>Steps</th>' +
                        '<th>Approval</th>' +
                        '<th class="actions-col">Load</th>';
                } else {
                    headRow.innerHTML =
                        '<th>Product Name</th>' +
                        '<th>Mode / USP</th>' +
                        '<th>Temp</th>' +
                        '<th>Steps</th>' +
                        '<th>Approval</th>' +
                        '<th class="actions-col">Actions</th>';
                }
            }
        }

        if (mode === 'load') {
            recipes = (recipes || []).filter(function (r) {
                return getEffectiveRecipeApprovalStatus(r) === 'approved' && isDissolutionRecipe(r);
            });
        } else {
            recipes = (recipes || []).filter(function (r) { return isDissolutionRecipe(r); });
        }

        if (!recipes.length) {
            if (msgEl) msgEl.style.display = '';
            if (tableEl) tableEl.style.display = 'none';
            if (mode === 'load' && msgEl) {
                msgEl.textContent = 'No approved recipes available.';
            }
            return;
        }

        lastDisplayedRecipes = recipes;
        if (msgEl) msgEl.style.display = 'none';
        if (tableEl) tableEl.style.display = '';

        recipes.forEach(function (r) {
            var tr = document.createElement('tr');
            var name = r.productName || r.name || '--';
            var testModeLabel = recipeTestModeLabel(r);
            var tempStr = (r.temperature != null && r.temperature !== '') ? (String(r.temperature) + ' °C') : '--';
            var stepsStr = (r.stepCount != null ? r.stepCount : (r.steps && r.steps.length ? r.steps.length : '--'));
            var appr = getEffectiveRecipeApprovalStatus(r);
            var apprLabel = appr === 'pending' ? 'Pending' : 'Approved';

            if (mode === 'load') {
                var loadBtnHtml = '<button type="button" class="btn-action btn-load" onclick="loadRecipeById(' + (r.id || 0) + ')" title="Load">Load</button>';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + testModeLabel + '</td>' +
                    '<td>' + tempStr + '</td>' +
                    '<td>' + stepsStr + '</td>' +
                    '<td>' + apprLabel + '</td>' +
                    '<td class="actions-cell actions-col">' + loadBtnHtml + '</td>';
            } else {
                var actionsBtnHtml = '<button type="button" class="btn-action btn-actions" onclick="openRecipeActionsModal(' + (r.id || 0) + ')" title="Edit / Delete / Load">' +
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
                    '<circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg> Actions</button>';
                tr.innerHTML =
                    '<td>' + name + '</td>' +
                    '<td>' + testModeLabel + '</td>' +
                    '<td>' + tempStr + '</td>' +
                    '<td>' + stepsStr + '</td>' +
                    '<td>' + apprLabel + '</td>' +
                    '<td class="actions-cell">' +
                        actionsBtnHtml +
                    '</td>';
            }

            tbody.appendChild(tr);
        });
    });
}

function loadDisableRecipes() {
    var msgEl = document.getElementById('disable-recipes-message');
    var tableEl = document.querySelector('#page-disable-recipes .manage-recipes-table');
    var tbody = document.getElementById('disable-recipes-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    var disabled = _getDisabledRecipesFromStorage();
    var canEnable = userCanEnableRecipe();

    if (!disabled || !disabled.length) {
        if (msgEl) {
            msgEl.textContent = 'No disabled recipes.';
            msgEl.style.display = '';
        }
        if (tableEl) tableEl.style.display = 'none';
        return;
    }

    if (msgEl) msgEl.style.display = 'none';
    if (tableEl) tableEl.style.display = '';

    disabled.forEach(function (entry) {
        var recipe = _resolveDisabledRecipeEntry(entry);
        var entryId = entry && entry.id != null ? entry.id : (recipe && recipe.id);
        var tr = document.createElement('tr');
        var name = recipe
            ? (recipe.productName || recipe.name || '--')
            : (entry.name || '--');
        var modeLabel = recipe ? recipeTestModeLabel(recipe) : '--';
        var stepsCount = recipe
            ? (recipe.stepCount || (recipe.steps && recipe.steps.length) || '--')
            : (entry.stepsCount || '--');
        var enableBtnHtml = '';
        if (canEnable && recipe) {
            enableBtnHtml = '<button type="button" class="btn-member-action btn-enable" onclick="enableRecipe(' + entryId + ')">Enable</button>';
        } else if (canEnable) {
            enableBtnHtml = '<button type="button" class="btn-member-action btn-enable" disabled title="Full recipe data unavailable">Enable</button>';
        }
        tr.innerHTML =
            '<td>' + name + '</td>' +
            '<td>' + modeLabel + '</td>' +
            '<td>' + stepsCount + '</td>' +
            '<td class="actions-cell actions-col">' + enableBtnHtml + '</td>';

        tbody.appendChild(tr);
    });
}

function completeRecipeFromStep2() {
    // Read from Step 1
    var nameEl = document.getElementById('recipe-product-name');
    var productName = nameEl && nameEl.value ? nameEl.value.trim() : '';

    var mode = getCreateUspMode();
    var speedRadio = document.querySelector('input[name="create-speed"]:checked');
    var heightRadio = document.querySelector('input[name="create-height"]:checked');
    var speed = speedRadio ? parseInt(speedRadio.value, 10) || 300 : null;
    var dropHeight = heightRadio ? parseFloat(heightRadio.value) || 14 : null;
    if (mode === 'USP') {
        speed = 25;
        dropHeight = 14;
    }

    // Cylinder (from step 3 if chosen; default 100 ml)
    var cylinderRadio = document.querySelector('input[name="create-cylinder"]:checked');
    var cylinderVolume = cylinderRadio ? parseFloat(cylinderRadio.value) || 100 : 100;

    var stepCount = (typeof window.currentRecipeStepCount === 'number' && window.currentRecipeStepCount > 0)
        ? window.currentRecipeStepCount
        : 10;

    if (!productName || speed == null || dropHeight == null) {
        showAppModal('Please complete recipe name, speed and height before saving.', 'Save Recipe');
        return;
    }

    var taps = window._createRecipeStepTaps;
    if (!taps || taps.length !== stepCount) {
        taps = computeCreateRecipeStepTapsForStepCount(stepCount);
    }
    if (mode === 'CUSTOM' && !taps) {
        showAppModal('Invalid custom tap total for this step count.', 'Save Recipe');
        return;
    }
    if (!taps || taps.length !== stepCount) {
        taps = computeStandardUspTaps(stepCount);
    }

    var steps = [];
    for (var i = 0; i < stepCount; i++) {
        steps.push({
            speed: speed,
            dropHeight: dropHeight,
            tapCount: taps[i]
        });
    }

    var uspLabel = mode === 'USP' ? 'USP' : 'Custom';
    var recipe = {
        productName: productName,
        steps: steps,
        stepCount: stepCount,
        cylinder: { volume: cylinderVolume },
        createdAt: new Date().toISOString(),
        speed: speed,
        dropHeight: dropHeight,
        usp: uspLabel,
        uspMode: mode
    };
    if (mode === 'CUSTOM') {
        var totalEl = document.getElementById('create-custom-total-taps');
        var ct = totalEl ? parseInt(totalEl.value, 10) : 0;
        if (!isNaN(ct) && ct > 0) recipe.customTotalTaps = ct;
        else {
            var s2 = 0;
            for (var ti = 0; ti < taps.length; ti++) s2 += parseInt(taps[ti], 10) || 0;
            recipe.customTotalTaps = s2;
        }
    }
    var editId = window.currentEditingRecipeId;
    if (editId) {
        recipe.id = editId;
    }

    var url = editId ? (API_BASE + '/api/data/recipes/' + editId) : (API_BASE + '/api/data/recipes');
    var method = editId ? 'PUT' : 'POST';
    apiRequest(url, {
        method: method,
        body: recipe
    }).then(function (result) {
        window.currentEditingRecipeId = null;
        var rid = (result && result.id != null) ? result.id : ((result && result.recipe && result.recipe.id != null) ? result.recipe.id : null);
        goToPage('manage-recipes');
        loadManageRecipes();
        if (rid != null) {
            var role = (typeof getCurrentRole === 'function' ? String(getCurrentRole() || '').toLowerCase() : '');
            if (role === 'factory') {
                showAppModal('Recipe saved and approved.', 'Save Recipe');
            } else {
                setTimeout(function () {
                    approveSavedRecipeWithCredentials(rid, 'Save Recipe', '').then(function (res) {
                        if (res && res.cancelled) {
                            showAppModal('Recipe saved. It stays pending until a QA or Admin approves it.', 'Save Recipe');
                        }
                    });
                }, 50);
            }
        } else {
            showAppModal('Recipe saved, but approval could not be started (missing recipe id).', 'Save Recipe');
        }
    }).catch(function (err) {
        console.error('Failed to save recipe:', err);
        var msg = (err && err.message) ? String(err.message) : 'Unknown error';
        showAppModal('Failed to save recipe: ' + msg, 'Save Recipe');
    });
}
function getValidationTickIntervalMs() {
    if (validationHardwareEnabled) return 30;
    return Math.max(200, Math.round(60000 / VALIDATION_USP_RPM));
}

function finalizeValidationMeasuredRpm() {
    if (validationRunLiveRpm != null) return;
    if (validationRunCurrentCount > 0 && validationRunElapsedSec > 0) {
        applyValidationLiveRpm(computeValidationRpmFromRotations(
            validationRunCurrentCount,
            validationRunElapsedSec
        ));
    }
}

function buildValidationReportPayload(opts) {
    opts = opts || {};
    var aborted = !!opts.aborted;
    var actualCount = validationRunCurrentCount;
    var resultInfo = aborted
        ? {
            isPass: false,
            rotationPass: false,
            rpmPass: false,
            statusText: 'Aborted',
            detailText: 'Validation aborted by user. Rotations: ' + actualCount + '.'
        }
        : buildValidationResult(actualCount);
    var isPass = resultInfo.isPass;
    var usp = 'USP (Friability)';
    var rpm = VALIDATION_USP_RPM;
    var timeMinutes = VALIDATION_USP_TIME_MIN;
    var dropHeight = VALIDATION_USP_DROP_MM;
    var user = window.currentUser || {};
    var nowIso = getDisplayedKioskDateTimeIso();
    var startIso = validationRunStartedAtIso || subtractSecondsFromIso(nowIso, validationRunElapsedSec);
    var statusLabel = aborted ? 'Aborted' : (isPass ? 'Pass' : 'Fail');
    var testStatus = aborted ? 'aborted' : (isPass ? 'Pass' : 'Fail');
    var reportPayload = {
        name: 'Validation - ' + statusLabel,
        type: 'validation',
        validationSubtype: 'usp',
        status: statusLabel,
        usp: usp,
        rpm: rpm,
        currentRpm: validationRunLiveRpm,
        rpmTolerance: VALIDATION_USP_RPM_TOLERANCE,
        rotationPass: resultInfo.rotationPass,
        rpmPass: resultInfo.rpmPass,
        timeMinutes: timeMinutes,
        tapsMin: rpm,
        dropHeight: dropHeight,
        expectedTapCount: validationRunTarget,
        expectedTolerance: validationRunTolerance,
        expectedTapCountMin: validationRunMin,
        expectedTapCountMax: validationRunMax,
        actualTapCount: actualCount,
        durationSeconds: validationRunElapsedSec,
        validationDurationSec: validationRunElapsedSec,
        createdAt: nowIso,
        completedAt: nowIso,
        validationStartTime: startIso,
        validationEndTime: nowIso,
        testData: {
            usp: usp,
            rpm: rpm,
            currentRpm: validationRunLiveRpm,
            rpmTolerance: VALIDATION_USP_RPM_TOLERANCE,
            rotationPass: resultInfo.rotationPass,
            rpmPass: resultInfo.rpmPass,
            timeMinutes: timeMinutes,
            tapsMin: rpm,
            dropHeight: dropHeight,
            expectedTapCount: validationRunTarget,
            expectedTolerance: validationRunTolerance,
            expectedTapCountMin: validationRunMin,
            expectedTapCountMax: validationRunMax,
            actualTapCount: actualCount,
            durationSeconds: validationRunElapsedSec,
            validationDurationSec: validationRunElapsedSec,
            validationStartTime: startIso,
            validationEndTime: nowIso,
            testStartTime: startIso,
            testEndTime: nowIso,
            status: testStatus,
            operatorName: user.name || user.username || '--',
            employeeId: user.username || '--',
            operatorUsername: user.username || '--',
            createdAt: nowIso,
            completedAt: nowIso
        }
    };
    return stampOperatorOnTestReportPayload(reportPayload);
}

function saveValidationReportAndOpenPreview(opts) {
    opts = opts || {};
    var payload = buildValidationReportPayload(opts);
    currentReportFilter = 'validation';
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            var reportId = result && result.id;
            if (!reportId) {
                goToPage('reports');
                return null;
            }
            logTestReportSavedAudit(reportId, payload);
            if (opts.aborted) {
                _saveReportPdfSilent(reportId);
                if (opts.openPreview !== false) openReportPreview(reportId);
            } else {
                openReportPreview(reportId, { setGate: true });
            }
            return reportId;
        })
        .catch(function (err) {
            console.error('Failed to save validation report', err);
            currentReportFilter = 'validation';
            goToPage('reports');
            return null;
        });
}

function buildValidationResult(actualCount) {
    var inRange = actualCount >= validationRunMin && actualCount <= validationRunMax;
    var rpmOk = false;
    if (validationRunLiveRpm != null) {
        rpmOk = validationRunLiveRpm >= getValidationRpmMin() && validationRunLiveRpm <= getValidationRpmMax();
    }
    var isPass = inRange && rpmOk;
    var targetLabel = String(validationRunTarget) + ' ± ' + String(validationRunTolerance)
        + ' (' + String(validationRunMin) + '-' + String(validationRunMax) + ')';
    var rpmRange = getValidationRpmMin() + '–' + getValidationRpmMax();
    var detailParts = ['Expected ' + targetLabel + ' rotations, actual ' + actualCount + '.'];
    if (validationRunLiveRpm != null) {
        detailParts.push('RPM ' + rpmRange + ' (live): ' + validationRunLiveRpm + ' — ' + (rpmOk ? 'in range' : 'out of range') + '.');
    } else {
        detailParts.push('No live RPM recorded.');
        isPass = false;
    }
    return {
        isPass: isPass,
        rotationPass: inRange,
        rpmPass: rpmOk,
        statusText: isPass ? 'Pass' : 'Fail',
        detailText: detailParts.join(' ')
    };
}

function validationRunTick() {
    validationRunCurrentCount++;
    setValidationRotationDisplay(validationRunCurrentCount);
    updateValidationLiveRpmFromTick();
}

function completeValidationRun() {
        var resultInfoEarly = buildValidationResult(validationRunCurrentCount);
        logAuditEvent('Validation finished', 'USP friability validation: ' + (resultInfoEarly.isPass ? 'Pass' : 'Fail'), {
            eventType: 'lifecycle',
            entityType: 'validation',
            extra: {
                validationType: 'usp',
                status: resultInfoEarly.isPass ? 'Pass' : 'Fail',
                actualRotationCount: validationRunCurrentCount,
                expectedRotationCount: validationRunTarget
            }
        });
        setValRunStatusText('Completed');
        setValRunEl('val-run-status-sub', 'Validation run finished');
        var resultEl = document.getElementById('val-run-result');
        var detailEl = document.getElementById('val-run-result-detail');
        var resultInfo = buildValidationResult(validationRunCurrentCount);
        var isPass = resultInfo.isPass;
        setValResultCardVisible(true);
        if (resultEl) {
            resultEl.textContent = resultInfo.statusText;
            resultEl.classList.remove('is-pass', 'is-fail', 'validation-result-pass', 'validation-result-fail');
            resultEl.classList.add(isPass ? 'is-pass' : 'is-fail');
        }
        if (detailEl) {
            detailEl.textContent = resultInfo.detailText;
        }
        setValRunPrimaryButton('start');
        validationCompletion.usp = true;
        saveValidationReportAndOpenPreview({ aborted: false });
}

function startValidationOnBackend() {
    if (!validationHardwareEnabled) return Promise.resolve({ ok: true, skipped: true });
    return friabilityHardwareStartValidation(VALIDATION_USP_RPM);
}

function stopValidationOnBackend() {
    if (!validationHardwareEnabled) return Promise.resolve({ ok: true, skipped: true });
    return friabilityHardwareStop();
}

function abortValidationRun(opts) {
    opts = opts || {};
    if (_validationAbortInProgress) return Promise.resolve(false);
    if (validationRunState !== 'running' && !validationRunBackendPending && !validationHwAwaitingStart) {
        return Promise.resolve(true);
    }
    _validationAbortInProgress = true;
    validationRunBackendPending = true;
    var btn = document.getElementById('btn-validation-start-abort');
    if (btn) btn.disabled = true;
    return stopValidationOnBackend().catch(function () {}).then(function () {
        if (validationRunIntervalId != null) {
            clearInterval(validationRunIntervalId);
            validationRunIntervalId = null;
        }
        if (validationRunTimerIntervalId != null) {
            clearInterval(validationRunTimerIntervalId);
            validationRunTimerIntervalId = null;
        }
        stopHardwareLivePoll();
        _validationCleanupHardwareStream();
        validationHwAwaitingStart = false;
        validationRunState = 'idle';
        logAuditEvent('Validation aborted', 'USP friability validation aborted by user', {
            eventType: 'lifecycle',
            entityType: 'validation',
            extra: { validationType: 'usp', rotationCount: validationRunCurrentCount }
        });
        setValidationDrumSpinning(false);
        setValRunStatusText('Aborted');
        setValRunEl('val-run-status-sub', 'Rotation count: ' + validationRunCurrentCount);
        setValRunPrimaryButton('start');
        return saveValidationReportAndOpenPreview({
            aborted: true,
            openPreview: opts.openPreview !== false
        }).catch(function () { return null; }).then(function () {
            return true;
        });
    }).finally(function () {
        if (btn) btn.disabled = false;
        validationRunBackendPending = false;
        _validationAbortInProgress = false;
    });
}

function confirmAbortValidationForNavigation() {
    return showConfirmModal(
        'Do you want to abort the validation?',
        'Abort Validation'
    ).then(function (ok) {
        if (!ok) return false;
        return abortValidationRun({ openPreview: false });
    });
}

function toggleValidationRunState() {
    if (validationRunBackendPending) return;
    if (validationRunState === 'idle' || validationRunState === 'completed') {
        var btn = document.getElementById('btn-validation-start-abort');
        validationRunBackendPending = true;
        if (btn) btn.disabled = true;
        setValRunStatusText('Starting');
        setValRunEl('val-run-status-sub', validationHardwareEnabled ? 'Waiting for hardware' : 'Starting');
        _validationCleanupHardwareStream();
        stopHardwareLivePoll();
        validationRunCurrentCount = 0;
        validationRunLastHwCount = 0;
        validationRunLastHwCountMs = null;
        validationRunStartedAtIso = null;
        ensureHardwareStream();
        if (validationHardwareEnabled) {
            validationRunHwUnsubscribe = subscribeHardwareStream(_validationApplyHardwareStream);
            startHardwareLivePoll(_validationApplyLiveState);
        }
        validationHwAwaitingStart = true;
        startValidationOnBackend().then(function (res) {
            if (!res || res.ok !== true) {
                throw new Error((res && (res.error || res.response)) || 'Hardware did not acknowledge start');
            }
            validationHwAwaitingStart = false;
            validationRunState = 'running';
            logAuditEvent('Validation started', 'USP friability validation run started', {
                eventType: 'lifecycle',
                entityType: 'validation',
                extra: { validationType: 'usp', rpm: VALIDATION_USP_RPM }
            });
            resetValidationRpmTracking();
            validationRunLastHwCount = 0;
            validationRunLastHwCountMs = Date.now();
            validationRunElapsedSec = 0;
            validationRunStartedAtIso = getDisplayedKioskDateTimeIso();
            setValidationRotationDisplay(0);
            setValidationTimeDisplay(formatValidationElapsed(0));
            setValRunStatusText('Running');
            setValRunEl('val-run-status-sub', 'Rotation count in progress · live RPM');
            setValidationDrumSpinning(true);
            setValResultCardVisible(false);
            setValRunPrimaryButton('abort');
            fetchFriabilityLiveState().then(_validationApplyLiveState).catch(function () {});
            if (!validationHardwareEnabled) {
                validationRunIntervalId = setInterval(validationRunTick, getValidationTickIntervalMs());
            }
            validationRunTimerIntervalId = setInterval(validationOnTimerTick, 1000);
        }).catch(function (err) {
            validationHwAwaitingStart = false;
            validationRunState = 'idle';
            validationRunStartedAtIso = null;
            stopHardwareLivePoll();
            _validationCleanupHardwareStream();
            setValidationDrumSpinning(false);
            if (validationRunTimerIntervalId != null) {
                clearInterval(validationRunTimerIntervalId);
                validationRunTimerIntervalId = null;
            }
            setValRunStatusText('Ready');
            setValRunEl('val-run-status-sub', 'Failed to start hardware validation');
            var msg = err && err.message ? err.message : 'Unknown error';
            if (/unauthorized/i.test(msg)) {
                msg = 'Session expired. Please log in again.';
            }
            showAppModal('Failed to start validation: ' + msg, 'Validation');
        }).finally(function () {
            validationRunBackendPending = false;
            if (btn) btn.disabled = false;
        });
    } else {
        abortValidationRun({ openPreview: true });
    }
}

function selectRole(roleName) {
    var hidden = document.getElementById('selected-role');
    if (hidden) {
        hidden.value = roleName;
    }
    var container = document.querySelector('.role-selection-container .role-options');
    if (container) {
        var buttons = container.querySelectorAll('.role-btn');
        var roleNorm = String(roleName || '').trim();
        buttons.forEach(function (btn) {
            btn.classList.remove('active');
            var btnRole = (btn.getAttribute('data-role') || '').trim();
            if (btnRole && btnRole === roleNorm) {
                btn.classList.add('active');
            }
        });
    }
    if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
        _refreshAddMemberPermissionsPanelVisibility();
    } else if (typeof renderAddMemberPermissionCards === 'function') {
        renderAddMemberPermissionCards();
    }
    if (typeof ensureAddMemberPageScroll === 'function') {
        ensureAddMemberPageScroll();
    }
}

function getStrongPasswordError(password) {
    var pwd = String(password || '');
    if (
        pwd.length >= 8 &&
        /[A-Z]/.test(pwd) &&
        /[a-z]/.test(pwd) &&
        /[0-9]/.test(pwd) &&
        /[^A-Za-z0-9]/.test(pwd)
    ) {
        return '';
    }
    return (
        'Password must meet all of the following:\n\n' +
        '• At least 8 characters long.\n' +
        '• At least one uppercase letter (A–Z).\n' +
        '• At least one lowercase letter (a–z).\n' +
        '• At least one number (0–9).\n' +
        '• At least one symbol (not only letters and digits).\n\n' +
        'Update your password to satisfy every item, then try again.'
    );
}

function updateProfilePageActions() {
    var u = window.currentUser;
    var manageBtn = document.getElementById('profile-manage-members-btn');
    var addBtn = document.getElementById('profile-add-member-btn');
    if (manageBtn) {
        manageBtn.style.display = (u && typeof canAccess === 'function' && canAccess(u, 'user-manage')) ? '' : 'none';
    }
    if (addBtn) {
        addBtn.style.display = (u && typeof canAccess === 'function' && canAccess(u, 'user-add')) ? '' : 'none';
    }
    if (typeof refreshReportsActionButtons === 'function') refreshReportsActionButtons();
}

function sessionCanAssignFeatureOverrides() {
    var u = window.currentUser;
    var role = (typeof getCurrentRole === 'function') ? String(getCurrentRole() || '').toLowerCase() : '';
    if (role === 'factory' || (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(role, u))) {
        return true;
    }
    if (u && typeof canPerformAction === 'function') {
        return canPerformAction(u, 'user-add', 'create');
    }
    return false;
}

function _isEditingOwnMemberProfile(memberId) {
    if (memberId == null) return false;
    var u = window.currentUser;
    if (!u) return false;
    if (u.id != null && Number(u.id) === Number(memberId)) return true;
    var members = Array.isArray(membersCache) ? membersCache : [];
    var target = members.find(function (m) { return Number(m.id) === Number(memberId); });
    if (!target) return false;
    var curUn = String(u.username || '').trim().toLowerCase();
    var tgtUn = String(target.username || '').trim().toLowerCase();
    return !!(curUn && tgtUn && curUn === tgtUn);
}

function _isProtectedFeatureKey(key) {
    return key === 'dashboard' || key === 'factory-settings' || key === 'factory-reset';
}

function _addMemberPermissionsPanelShouldShow() {
    return typeof sessionCanAssignFeatureOverrides === 'function' && sessionCanAssignFeatureOverrides();
}

function _refreshAddMemberPermissionsPanelVisibility() {
    var panel = document.getElementById('add-member-permissions-panel');
    if (!panel) return;
    var show = _addMemberPermissionsPanelShouldShow();
    panel.classList.toggle('is-hidden', !show);
    panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show && typeof renderAddMemberPermissionCards === 'function') {
        renderAddMemberPermissionCards();
    }
    if (show && typeof ensureAddMemberPageScroll === 'function') {
        setTimeout(ensureAddMemberPageScroll, 0);
    }
}

function _loadMemberOverridesIntoPanel(overrides) {
    var norm = (typeof normalizeFeatureOverrides === 'function')
        ? normalizeFeatureOverrides(overrides)
        : { allow: [], deny: [] };
    _addMemberFeatureOverrides = {
        allow: (norm.allow || []).slice(),
        deny: []
    };
}

function ensureAddMemberPageScroll() {
    var page = document.getElementById('page-add-member');
    if (!page) return;
    page.scrollTop = 0;
}

function _setAddMemberPageMode(isEdit, isSelfEdit) {
    var titleEl = document.getElementById('add-member-page-title');
    var saveBtn = document.getElementById('add-member-save-btn');
    var userIdEl = document.getElementById('add-userid');
    var pwdLabel = document.getElementById('add-password-label');
    var confirmPwdLabel = document.getElementById('add-confirm-password-label');
    var roleContainer = document.querySelector('#page-add-member .role-selection-container');
    var headerTitle = document.getElementById('header-title');
    var bioBtn = document.getElementById('enroll-biometric-btn');
    if (titleEl) titleEl.textContent = isEdit ? 'Edit Profile' : 'Add New Member';
    if (saveBtn) saveBtn.textContent = isEdit ? 'Update Profile' : 'Save Profile';
    if (headerTitle) headerTitle.textContent = isEdit ? 'Edit Profile' : (PAGE_TITLES['add-member'] || 'Add New Member');
    if (userIdEl) {
        userIdEl.readOnly = !!isEdit;
        userIdEl.disabled = !!isEdit;
        if (isEdit) userIdEl.classList.add('input-readonly');
        else userIdEl.classList.remove('input-readonly');
    }
    if (pwdLabel) pwdLabel.textContent = isEdit ? 'New Password (optional)' : 'Password';
    if (confirmPwdLabel) confirmPwdLabel.textContent = isEdit ? 'Confirm New Password (optional)' : 'Confirm Password';
    if (roleContainer) roleContainer.style.display = isSelfEdit ? 'none' : '';
    if (bioBtn) bioBtn.classList.toggle('is-hidden', !!isEdit);
    if (isSelfEdit) {
        var panel = document.getElementById('add-member-permissions-panel');
        if (panel) {
            panel.classList.add('is-hidden');
            panel.setAttribute('aria-hidden', 'true');
        }
    } else if (typeof _refreshAddMemberPermissionsPanelVisibility === 'function') {
        _refreshAddMemberPermissionsPanelVisibility();
    }
}

function _clearAddMemberForm() {
    editingMemberId = null;
    ['add-fullname', 'add-userid', 'add-password', 'add-confirm-password'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var userIdEl = document.getElementById('add-userid');
    if (userIdEl) {
        userIdEl.readOnly = false;
        userIdEl.disabled = false;
        userIdEl.classList.remove('input-readonly');
    }
    if (typeof selectRole === 'function') selectRole('User');
    _addMemberFeatureOverrides = { allow: [], deny: [] };
    _setAddMemberPageMode(false, false);
}

function _resetAddMemberForm() {
    _clearAddMemberForm();
}

function refreshReportsActionButtons() {
    var u = window.currentUser;
    var expBtn = document.querySelector('.reports-filter-export');
    if (expBtn) {
        expBtn.style.display = u && typeof userCanExportToUsb === 'function' && userCanExportToUsb(u) ? '' : 'none';
    }
    var audEx = document.querySelector('.audit-filter-export');
    if (audEx) {
        audEx.style.display = u && typeof userCanExportToUsb === 'function' && userCanExportToUsb(u) ? '' : 'none';
    }
}

function canEditMembers() {
    var u = window.currentUser;
    if (typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(u && u.role, u)) return true;
    return u && typeof canPerformAction === 'function' && canPerformAction(u, 'user-manage', 'edit');
}

function renderAddMemberPermissionCards() {
    var grid = document.getElementById('permission-cards-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var catalog = (typeof getPermissionCardCatalog === 'function')
        ? getPermissionCardCatalog()
        : [];
    if (!_addMemberFeatureOverrides) _addMemberFeatureOverrides = { allow: [], deny: [] };
    _addMemberFeatureOverrides.deny = [];
    catalog.forEach(function (feature) {
        var key = feature.key;
        if (_isProtectedFeatureKey(key)) return;
        var selected = _addMemberFeatureOverrides.allow.indexOf(key) !== -1;
        var accent = feature.accent != null ? feature.accent : 0;
        var card = document.createElement('div');
        card.className = 'permission-card' + (selected ? ' is-selected permission-card--accent-' + accent : '');
        card.setAttribute('data-feature-key', key);
        card.setAttribute('title', 'Select or clear this functionality');
        card.innerHTML =
            '<div class="permission-card-title">' + feature.label + '</div>' +
            '<div class="permission-card-desc">' + (feature.description || '') + '</div>';
        card.addEventListener('click', function () { togglePermissionCardAllow(key); });
        grid.appendChild(card);
    });
}

function togglePermissionCardAllow(featureKey) {
    if (!featureKey || _isProtectedFeatureKey(featureKey)) return;
    if (!_addMemberFeatureOverrides) _addMemberFeatureOverrides = { allow: [], deny: [] };
    var i = _addMemberFeatureOverrides.allow.indexOf(featureKey);
    if (i === -1) _addMemberFeatureOverrides.allow.push(featureKey);
    else _addMemberFeatureOverrides.allow.splice(i, 1);
    _addMemberFeatureOverrides.deny = [];
    renderAddMemberPermissionCards();
}

function openEditMember(id) {
    if (!id) return;
    if (typeof canEditMembers === 'function' && !canEditMembers()) {
        showAppModal('You do not have permission to edit profiles.', 'Permission');
        return;
    }
    apiRequest(API_BASE + '/api/data/members/' + id, { method: 'GET' })
        .then(function (data) {
            var member = (data && data.member) ? data.member : null;
            if (!member || member.id == null) throw new Error('Member not found');
            var uname = String(member.username || '').trim().toUpperCase();
            if (uname === FACTORY_USERNAME) {
                showAppModal('The factory account cannot be edited here.', 'Edit Profile');
                return;
            }
            editingMemberId = member.id;
            var isSelf = _isEditingOwnMemberProfile(member.id);
            ['add-password', 'add-confirm-password'].forEach(function (fid) {
                var el = document.getElementById(fid);
                if (el) el.value = '';
            });
            var fullNameEl = document.getElementById('add-fullname');
            var userIdEl = document.getElementById('add-userid');
            if (fullNameEl) fullNameEl.value = member.name || '';
            if (userIdEl) userIdEl.value = member.username || '';
            if (!isSelf && typeof selectRole === 'function') {
                selectRole(member.role || 'User');
            }
            if (!isSelf) _loadMemberOverridesIntoPanel(member.featureOverrides);
            _setAddMemberPageMode(true, isSelf);
            goToPage('add-member');
            setTimeout(function () {
                if (typeof ensureAddMemberPageScroll === 'function') ensureAddMemberPageScroll();
            }, 60);
        })
        .catch(function (err) {
            showAppModal('Failed to load profile: ' + (err && err.message ? err.message : 'Unknown error'), 'Edit Profile');
        });
}

function saveMemberForm() {
    if (editingMemberId != null) {
        saveEditedMember();
        return;
    }
    saveNewMember();
}

function saveEditedMember() {
    var memberId = editingMemberId;
    if (memberId == null) return;
    var modalTitle = 'Edit Profile';
    var fullNameEl = document.getElementById('add-fullname');
    var userIdEl = document.getElementById('add-userid');
    var pwdEl = document.getElementById('add-password');
    var confirmPwdEl = document.getElementById('add-confirm-password');
    var roleHidden = document.getElementById('selected-role');

    var fullName = fullNameEl && fullNameEl.value ? fullNameEl.value.trim() : '';
    var username = userIdEl && userIdEl.value ? userIdEl.value.trim() : '';
    var password = pwdEl && pwdEl.value ? pwdEl.value : '';
    var confirmPassword = confirmPwdEl && confirmPwdEl.value ? confirmPwdEl.value : '';
    var role = roleHidden && roleHidden.value ? roleHidden.value : 'User';
    var isSelf = _isEditingOwnMemberProfile(memberId);

    if (!fullName || !username) {
        showAppModal('Full name and User ID are required.', modalTitle);
        return;
    }
    if (username.toUpperCase() === FACTORY_USERNAME) {
        showAppModal('This User ID is reserved for the factory account.', modalTitle);
        return;
    }
    if (password || confirmPassword) {
        if (password !== confirmPassword) {
            showAppModal('Password and Confirm Password do not match.', modalTitle);
            return;
        }
        var pwdErr = getStrongPasswordError(password);
        if (pwdErr) {
            showAppModal(pwdErr, modalTitle);
            return;
        }
    }

    apiRequest(API_BASE + '/api/data/members/' + memberId, { method: 'GET' })
        .then(function (data) {
            var member = (data && data.member) ? data.member : null;
            if (!member) throw new Error('Member not found');
            member.name = fullName;
            member.username = username;
            if (!isSelf) {
                member.role = role;
            }
            if (password) {
                member.password = password;
            }
            if (!isSelf && _addMemberPermissionsPanelShouldShow()) {
                var overrides = _addMemberFeatureOverrides || { allow: [], deny: [] };
                var allowList = (overrides.allow || []).slice();
                if (allowList.length < 1) {
                    showAppModal('Select at least one user functionality to continue.', modalTitle);
                    return Promise.reject(new Error('permissions'));
                }
                if (!sessionCanAssignFeatureOverrides()) {
                    showAppModal('You do not have permission to change permission cards.', modalTitle);
                    return Promise.reject(new Error('permissions'));
                }
                member.featureOverrides = { allow: allowList, deny: [] };
            }
            return apiRequest(API_BASE + '/api/data/members/' + memberId, {
                method: 'PUT',
                body: member
            });
        })
        .then(function () {
            editingMemberId = null;
            _clearAddMemberForm();
            loadMembersAndRender();
            showAppModal('Profile updated successfully.', modalTitle);
            goToPage('manage-members');
        })
        .catch(function (err) {
            if (err && err.message === 'permissions') return;
            showAppModal('Failed to update profile: ' + (err && err.message ? err.message : 'Unknown error'), modalTitle);
        });
}

function saveNewMember() {
    var fullNameEl = document.getElementById('add-fullname');
    var userIdEl = document.getElementById('add-userid');
    var pwdEl = document.getElementById('add-password');
    var confirmPwdEl = document.getElementById('add-confirm-password');
    var roleHidden = document.getElementById('selected-role');

    var fullName = fullNameEl && fullNameEl.value ? fullNameEl.value.trim() : '';
    var username = userIdEl && userIdEl.value ? userIdEl.value.trim() : '';
    var password = pwdEl && pwdEl.value ? pwdEl.value : '';
    var confirmPassword = confirmPwdEl && confirmPwdEl.value ? confirmPwdEl.value : '';
    var role = roleHidden && roleHidden.value ? roleHidden.value : 'User';

    if (!fullName || !username || !password || !confirmPassword) {
        showAppModal('Please fill all fields.', 'Add Member');
        return;
    }
    if (username.toUpperCase() === FACTORY_USERNAME) {
        showAppModal('This User ID is reserved for the factory account and cannot be used.', 'Add Member');
        return;
    }
    if (password !== confirmPassword) {
        showAppModal('Password and Confirm Password do not match.', 'Add Member');
        return;
    }
    var passwordError = getStrongPasswordError(password);
    if (passwordError) {
        showAppModal(passwordError, 'Add Member');
        return;
    }

    var allowList = (_addMemberFeatureOverrides && _addMemberFeatureOverrides.allow) ? _addMemberFeatureOverrides.allow.slice() : [];
    if (allowList.length < 1) {
        showAppModal('Select at least one user functionality to continue.', 'Add Member');
        return;
    }
    if (!sessionCanAssignFeatureOverrides()) {
        showAppModal('You do not have permission to assign permission cards.', 'Add Member');
        return;
    }

    var payload = {
        name: fullName,
        username: username,
        role: role,
        password: password,
        featureOverrides: { allow: allowList, deny: [] }
    };

    apiRequest(API_BASE + '/api/data/members', {
        method: 'POST',
        body: payload
    }).then(function (data) {
        if (data && data.id) {
            _addMemberLastSavedId = data.id;
            var savedMember = (data && data.member) ? data.member : {
                id: data.id, name: fullName, username: username, role: role
            };
            _clearAddMemberForm();
            if (biometricEnabledSetting) {
                _populateMemberBiometricSummary(savedMember);
                goToPage('member-biometric');
            } else {
                showAppModal('Member saved successfully.', 'Add Member');
                loadMembersAndRender();
                goToPage('manage-members');
            }
        } else {
            showAppModal((data && data.error) || 'Failed to save member.', 'Add Member');
        }
    }).catch(function (err) {
        showAppModal('Failed to save member: ' + (err && err.message ? err.message : 'Network error'), 'Add Member');
    });
}

function cancelAddMemberEdit() {
    var returnToManage = editingMemberId != null;
    _clearAddMemberForm();
    goToPage(returnToManage ? 'manage-members' : 'user-profile');
}
function closeRoleModal() {
    var overlay = document.getElementById('role-modal-overlay');
    if (overlay) overlay.style.display = 'none';
    currentMemberIdForRoleEdit = null;
}

function openRoleModal(id) {
    if (!id) return;
    var members = Array.isArray(membersCache) ? membersCache : [];
    var member = members.find(function (m) { return m.id === id; });
    if (!member) return;
    currentMemberIdForRoleEdit = id;
    var titleEl = document.getElementById('role-modal-title');
    var currentEl = document.getElementById('role-modal-current');
    if (titleEl) titleEl.textContent = 'Change Role for ' + (member.name || member.username || '');
    if (currentEl) currentEl.textContent = 'Current Role: ' + displayRoleLabel(member.role);
    var overlay = document.getElementById('role-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function confirmRoleChange(newRole) {
    if (!currentMemberIdForRoleEdit) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-change-role', 'change')) {
            showAppModal('You do not have permission to change user roles.', 'Permission');
            closeRoleModal();
            return;
        }
    }
    var id = currentMemberIdForRoleEdit;
    apiRequest(API_BASE + '/api/data/members/' + id, {
        method: 'GET'
    }).then(function (data) {
        var member = data && data.member ? data.member : null;
        if (!member) throw new Error('Member not found');
        member.role = newRole;
        return apiRequest(API_BASE + '/api/data/members/' + id, {
            method: 'PUT',
            body: JSON.stringify(member)
        });
    }).then(function () {
        closeRoleModal();
        loadMembersAndRender();
    }).catch(function (err) {
        console.error('Failed to update member role', err);
        showAppModal('Failed to update role: ' + (err && err.message ? err.message : 'Unknown error'), 'Members');
    });
}

function disableMember(id) {
    if (!id) return;
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'user-delete', 'delete')) {
            showAppModal('You do not have permission to disable members.', 'Permission');
            return;
        }
    }
    showConfirmModal('Are you sure you want to disable this member?', 'Disable Member').then(function (ok) {
        if (!ok) return;
        apiRequest(API_BASE + '/api/data/members/' + id, { method: 'GET' })
            .then(function (data) {
                var member = (data && data.member) ? data.member : data;
                if (!member || member.id == null) throw new Error('Member not found');
                member.status = 'disabled';
                return apiRequest(API_BASE + '/api/data/members/' + id, {
                    method: 'PUT',
                    body: member
                });
            })
            .then(function () {
                loadMembersAndRender();
            })
            .catch(function (err) {
                console.error('Failed to disable member', err);
                showAppModal('Failed to disable member: ' + (err && err.message ? err.message : 'Unknown error'), 'Members');
            });
    });
}

function openAddMember() {
    if (typeof canPerformAction === 'function') {
        var u = window.currentUser;
        if (u && !canPerformAction(u, 'user-add', 'create') &&
            !(typeof isFactoryLikeRole === 'function' && isFactoryLikeRole(u.role, u))) {
            showAppModal('You do not have permission to add new members.', 'Permission');
            return;
        }
    }
    editingMemberId = null;
    _clearAddMemberForm();
    _refreshAddMemberPermissionsPanelVisibility();
    goToPage('add-member');
    setTimeout(function () {
        if (typeof ensureAddMemberPageScroll === 'function') ensureAddMemberPageScroll();
    }, 60);
}

function saveUserProfile() {
    var fullNameEl = document.getElementById('profile-fullname');
    var passwordEl = document.getElementById('profile-password');
    var newName = fullNameEl ? (fullNameEl.value || '').trim() : '';
    var newPassword = passwordEl ? (passwordEl.value || '') : '';
    if (newPassword) {
        var profilePasswordError = getStrongPasswordError(newPassword);
        if (profilePasswordError) {
            if (typeof showAppModal === 'function') showAppModal(profilePasswordError, 'User Profile');
            return;
        }
    }

    var user = (typeof window.currentUser !== 'undefined' && window.currentUser) ? window.currentUser : (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
    if (!user) {
        if (typeof showAppModal === 'function') showAppModal('No user logged in.', 'User Profile');
        return;
    }

    var memberId = user.id;
    var isFactory = (memberId === 0 || memberId === undefined || memberId === null);

    function updateLocalName(name) {
        if (window.currentUser) window.currentUser.name = name;
        if (typeof currentUser !== 'undefined') { currentUser = currentUser || {}; currentUser.name = name; }
        try { localStorage.setItem('currentUser', JSON.stringify(window.currentUser || currentUser)); } catch (e) {}
        var displayEl = document.getElementById('profile-name-display');
        if (displayEl) displayEl.textContent = name || '---';
    }

    if (isFactory) {
        updateLocalName(newName || user.name || user.username || 'Factory');
        if (passwordEl) passwordEl.value = '';
        if (typeof showAppModal === 'function') showAppModal('Profile updated.', 'User Profile');
        return;
    }

    var payload = {};
    if (newName) payload.name = newName;
    if (newPassword) payload.password = newPassword;
    if (!payload.name && !payload.password) {
        if (typeof showAppModal === 'function') {
            showAppModal('Enter a new full name and/or password to save.', 'User Profile');
        }
        return;
    }
    if (!payload.name) {
        payload.name = (user.name || user.username || '').trim();
    }

    apiRequest(API_BASE + '/api/data/auth/profile', {
        method: 'PUT',
        body: payload
    })
        .then(function (result) {
            var updated = (result && result.member) ? result.member : result;
            var nameToSet = (updated && updated.name) ? updated.name : newName;
            updateLocalName(nameToSet || newName || (user.name || user.username));
            if (passwordEl) passwordEl.value = '';
            if (typeof showAppModal === 'function') showAppModal('Profile updated.', 'User Profile');
        })
        .catch(function (err) {
            var msg = (err && err.message) ? err.message : 'Failed to update profile.';
            if (typeof showAppModal === 'function') showAppModal(msg, 'User Profile');
        });
}

function initializeDatetime() {
    var dateInput = document.getElementById('edit-date');
    var timeInput = document.getElementById('edit-time');
    if (!dateInput || !timeInput) return;
    function applyToInputs(now) {
        if (!dateInput.value) {
            var day = String(now.getDate()).padStart(2, '0');
            var month = String(now.getMonth() + 1).padStart(2, '0');
            var year = now.getFullYear();
            dateInput.value = day + '-' + month + '-' + year;
        }
        if (!timeInput.value) {
            var hours = String(now.getHours()).padStart(2, '0');
            var minutes = String(now.getMinutes()).padStart(2, '0');
            timeInput.value = hours + ':' + minutes;
        }
    }
    fetchDateTimeFromBackend().then(function (data) {
        var now = null;
        if (data && data.datetime) {
            now = new Date(data.datetime.replace('Z', ''));
        }
        if (!now || isNaN(now.getTime())) {
            if (data && data.date && data.time) {
                var parts = (data.date || '').split('-');
                var tparts = (data.time || '').split(':');
                if (parts.length >= 3 && tparts.length >= 2) {
                    var d = parseInt(parts[0], 10);
                    var m = parseInt(parts[1], 10) - 1;
                    var y = parseInt(parts[2], 10);
                    var h = parseInt(tparts[0], 10) || 0;
                    var min = parseInt(tparts[1], 10) || 0;
                    now = new Date(y, m, d, h, min, 0);
                }
            }
        }
        if (!now || isNaN(now.getTime())) now = new Date();
        applyToInputs(now);
    }).catch(function () {
        applyToInputs(new Date());
    });
}

function openDatePickerForEditDate() {
    var textInput = document.getElementById('edit-date');
    var hiddenInput = document.getElementById('edit-date-picker-hidden');
    if (!textInput || !hiddenInput) return;
    var val = (textInput.value || '').trim();
    if (val) {
        var parts = val.split('-');
        if (parts.length === 3) {
            var d = parseInt(parts[0], 10);
            var m = parseInt(parts[1], 10);
            var y = parseInt(parts[2], 10);
            if (!isNaN(d) && !isNaN(m) && !isNaN(y) && d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2000 && y <= 2100) {
                hiddenInput.value = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            }
        }
    }
    if (!hiddenInput.value) {
        var now = new Date();
        hiddenInput.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    }
    function onDateChange() {
        var v = hiddenInput.value;
        if (!v) return;
        var ymd = v.split('-');
        if (ymd.length >= 3) {
            textInput.value = String(parseInt(ymd[2], 10)).padStart(2, '0') + '-' + String(parseInt(ymd[1], 10)).padStart(2, '0') + '-' + ymd[0];
        }
        hiddenInput.removeEventListener('change', onDateChange);
    }
    hiddenInput.addEventListener('change', onDateChange);
    hiddenInput.focus();
    if (typeof hiddenInput.showPicker === 'function') {
        try { hiddenInput.showPicker(); } catch (e) { hiddenInput.click(); }
    } else {
        hiddenInput.click();
    }
}

function applyDateTime() {
    var dateVal = (document.getElementById('edit-date').value || '').trim();
    var timeVal = (document.getElementById('edit-time').value || '').trim();
    if (!dateVal || !timeVal) {
        showAppModal('Please enter both date and time.', 'Error');
        return;
    }
    var dateParts = dateVal.split('-').map(Number);
    if (dateParts.length !== 3) {
        showAppModal('Enter date as DD-MM-YYYY.', 'Error');
        return;
    }
    var day = dateParts[0];
    var month = dateParts[1];
    var year = dateParts[2];
    var timeParts = timeVal.split(':');
    var hours = parseInt(timeParts[0], 10);
    var minutes = timeParts.length >= 2 ? parseInt(timeParts[1], 10) : 0;
    if (isNaN(hours)) hours = 0;
    if (isNaN(minutes)) minutes = 0;
    hours = Math.max(0, Math.min(23, hours));
    minutes = Math.max(0, Math.min(59, minutes));
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var dtStr = year + '-' + pad(month) + '-' + pad(day) + 'T' + pad(hours) + ':' + pad(minutes) + ':00';
    var headers = {};
    if (typeof window.currentUser !== 'undefined' && window.currentUser && window.currentUser.role) {
        headers['X-User-Role'] = window.currentUser.role;
    }
    fetch((API_BASE || '') + '/api/set_datetime', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
        body: JSON.stringify({ datetime: dtStr })
    }).then(function (r) {
        if (r.ok) {
            updateDateTime();
            showAppModal('Date and time updated.', 'Success', function () {
                goBack();
            });
            return;
        }
        return r.json().catch(function () { return {}; }).then(function (err) {
            showAppModal(err.error || 'Failed to set date and time.', 'Error');
        });
    }).catch(function (err) {
        showAppModal('Failed to update date and time: ' + (err && err.message ? err.message : 'Network error'), 'Error');
    });
}

function openDatePicker(inputId) {
    var el = document.getElementById(inputId);
    if (el) {
        el.focus();
        try { el.showPicker && el.showPicker(); } catch (e) {}
    }
}

function updateLoginFactorySettingsDisplay(settings) {
    var s = settings || {};
    var model = s.modelNo && String(s.modelNo).trim() ? String(s.modelNo).trim() : '';
    var serial = s.serialNo && String(s.serialNo).trim() ? String(s.serialNo).trim() : '';
    var company = s.companyName && String(s.companyName).trim() ? String(s.companyName).trim() : '';

    var modelEl = document.getElementById('login-footer-model-no');
    var serialEl = document.getElementById('login-footer-serial-no');
    var footerInfo = document.getElementById('login-footer-info');
    if (modelEl) modelEl.textContent = model || '—';
    if (serialEl) serialEl.textContent = serial || '—';

    var show = !!(model || serial || company);
    if (footerInfo) footerInfo.style.display = show ? 'block' : 'none';
}

function loadLoginFactorySettingsDisplay() {
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        updateLoginFactorySettingsDisplay(settings);
    }).catch(function () {
        try {
            var stored = localStorage.getItem('factorySettings');
            var settings = stored ? JSON.parse(stored) : {};
            updateLoginFactorySettingsDisplay(settings);
        } catch (e) {
            updateLoginFactorySettingsDisplay({});
        }
    });
}

var SYSTEM_SETTINGS_DEFAULTS = {
    beep: 'Enable',
    tempTolerance: 'Disable',
    tempToleranceValue: null
};

function selectSystemSettingCard(btn) {
    if (!btn) return;
    var group = btn.getAttribute('data-group');
    var value = btn.getAttribute('data-value');
    if (!group) return;
    document.querySelectorAll('.system-settings-page [data-group="' + group + '"]').forEach(function (el) {
        el.classList.toggle('is-selected', el === btn);
    });
    if (group === 'beep') {
        var beepHidden = document.getElementById('sys-beep');
        if (beepHidden) beepHidden.value = value;
    } else if (group === 'tempTolerance') {
        var tolHidden = document.getElementById('sys-temp-tolerance');
        if (tolHidden) tolHidden.value = value;
        syncTempToleranceFieldVisibility();
    }
}

function _sysApplyCardGroup(group, value) {
    var cards = document.querySelectorAll('.system-settings-page [data-group="' + group + '"]');
    var matched = false;
    cards.forEach(function (el) {
        var on = el.getAttribute('data-value') === String(value);
        el.classList.toggle('is-selected', on);
        if (on) matched = true;
    });
    if (!matched && cards.length) {
        cards[0].classList.add('is-selected');
        value = cards[0].getAttribute('data-value');
    }
    if (group === 'beep') {
        var beepHidden = document.getElementById('sys-beep');
        if (beepHidden) beepHidden.value = value;
    } else if (group === 'tempTolerance') {
        var tolHidden = document.getElementById('sys-temp-tolerance');
        if (tolHidden) tolHidden.value = value;
    }
}

function syncTempToleranceFieldVisibility() {
    var selectEl = document.getElementById('sys-temp-tolerance');
    var wrapEl = document.getElementById('sys-temp-tolerance-value-wrap');
    var valueEl = document.getElementById('sys-temp-tolerance-value');
    if (!selectEl || !wrapEl) return;
    var enabled = selectEl.value === 'Enable';
    wrapEl.hidden = !enabled;
    if (valueEl) valueEl.disabled = !enabled;
}

function applyTempToleranceFromSettings(settings) {
    var s = settings || {};
    if (String(s.tempTolerance || '') === 'Enable' && s.tempToleranceValue != null && !isNaN(Number(s.tempToleranceValue))) {
        TEMP_VAL_TOLERANCE = Number(s.tempToleranceValue);
    } else {
        TEMP_VAL_TOLERANCE = 0.5;
    }
    if (typeof window !== 'undefined') window.TEMP_VAL_TOLERANCE = TEMP_VAL_TOLERANCE;
}

function setSystemSettingsForm(settings) {
    var s = Object.assign({}, SYSTEM_SETTINGS_DEFAULTS, settings || {});
    _sysApplyCardGroup('beep', s.beep || 'Enable');
    _sysApplyCardGroup('tempTolerance', s.tempTolerance || 'Disable');
    var valueEl = document.getElementById('sys-temp-tolerance-value');
    if (valueEl) {
        valueEl.value = (s.tempToleranceValue != null && !isNaN(Number(s.tempToleranceValue)))
            ? String(s.tempToleranceValue)
            : '';
    }
    syncTempToleranceFieldVisibility();
    applyTempToleranceFromSettings(s);
}

function collectSystemSettingsForm() {
    var valueEl = document.getElementById('sys-temp-tolerance-value');
    var tempTolerance = (document.getElementById('sys-temp-tolerance') || {}).value || 'Disable';
    var rawValue = valueEl ? String(valueEl.value || '').trim() : '';
    var parsedValue = rawValue === '' ? null : parseFloat(rawValue);
    return {
        beep: (document.getElementById('sys-beep') || {}).value || 'Enable',
        tempTolerance: tempTolerance,
        tempToleranceValue: tempTolerance === 'Enable' ? parsedValue : null
    };
}

function initSystemSettingsPage() {
    setSystemSettingsForm(SYSTEM_SETTINGS_DEFAULTS);
    apiRequest(API_BASE + '/api/data/system-settings', { method: 'GET' }).then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        setSystemSettingsForm(settings);
    }).catch(function () {
        setSystemSettingsForm(SYSTEM_SETTINGS_DEFAULTS);
    });
}

function saveSystemSettings() {
    var payload = collectSystemSettingsForm();
    if (payload.tempTolerance === 'Enable') {
        var tolVal = payload.tempToleranceValue;
        if (tolVal == null || isNaN(tolVal) || tolVal <= 0) {
            showAppModal('Please enter a tolerance value greater than 0 °C.', 'Test Settings');
            return;
        }
    }
    var saveBtn = document.getElementById('sys-settings-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    apiRequest(API_BASE + '/api/data/system-settings', { method: 'POST', body: payload })
        .then(function (result) {
            var settings = (result && result.settings) ? result.settings : payload;
            setSystemSettingsForm(settings);
            if (typeof logAuditEvent === 'function') {
                logAuditEvent('Test settings saved', 'Instrument test settings updated', {
                    eventType: 'lifecycle',
                    entityType: 'settings'
                });
            }
            showAppModal('Test settings saved.', 'Test Settings');
        })
        .catch(function (err) {
            showAppModal((err && err.message) || 'Failed to save test settings.', 'Test Settings');
        })
        .finally(function () {
            if (saveBtn) saveBtn.disabled = false;
        });
}

var WAKEUP_SCHEDULE_DEFAULTS = {
    enabled: false,
    wakeupTime: '',
    targetTemperature: null,
    days: []
};

var _wakeupScheduleEnabled = false;

function setWakeupToggleUi(enabled) {
    _wakeupScheduleEnabled = !!enabled;
    var offBtn = document.getElementById('wakeup-enable-off');
    var onBtn = document.getElementById('wakeup-enable-on');
    if (offBtn) {
        offBtn.classList.toggle('is-active', !_wakeupScheduleEnabled);
        offBtn.setAttribute('aria-pressed', !_wakeupScheduleEnabled ? 'true' : 'false');
    }
    if (onBtn) {
        onBtn.classList.toggle('is-active', _wakeupScheduleEnabled);
        onBtn.setAttribute('aria-pressed', _wakeupScheduleEnabled ? 'true' : 'false');
    }
}

function setWakeupScheduleEnabled(enabled) {
    setWakeupToggleUi(!!enabled);
}

function toggleWakeupScheduleEnabled() {
    setWakeupToggleUi(!_wakeupScheduleEnabled);
}

function toggleWakeupDay(btn) {
    if (!btn) return;
    btn.classList.toggle('is-selected');
    btn.setAttribute('aria-pressed', btn.classList.contains('is-selected') ? 'true' : 'false');
}

function setWakeupScheduleForm(settings) {
    var s = Object.assign({}, WAKEUP_SCHEDULE_DEFAULTS, settings || {});
    setWakeupToggleUi(!!s.enabled);
    var timeEl = document.getElementById('wakeup-time');
    if (timeEl) timeEl.value = s.wakeupTime ? String(s.wakeupTime) : '';
    var tempEl = document.getElementById('wakeup-temp');
    if (tempEl) {
        tempEl.value = (s.targetTemperature != null && s.targetTemperature !== '')
            ? String(s.targetTemperature)
            : '';
    }
    var selected = {};
    (s.days || []).forEach(function (d) {
        selected[String(d).toLowerCase()] = true;
    });
    var dayBtns = document.querySelectorAll('#wakeup-days-list .wakeup-day-btn');
    dayBtns.forEach(function (btn) {
        var day = (btn.getAttribute('data-day') || '').toLowerCase();
        var on = !!selected[day];
        btn.classList.toggle('is-selected', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
}

function collectWakeupScheduleForm() {
    var timeEl = document.getElementById('wakeup-time');
    var tempEl = document.getElementById('wakeup-temp');
    var days = [];
    document.querySelectorAll('#wakeup-days-list .wakeup-day-btn.is-selected').forEach(function (btn) {
        var day = btn.getAttribute('data-day');
        if (day) days.push(day);
    });
    var tempVal = tempEl ? String(tempEl.value || '').trim() : '';
    var targetTemperature = null;
    if (tempVal !== '') {
        var parsed = parseFloat(tempVal);
        if (!isNaN(parsed)) targetTemperature = parsed;
    }
    return {
        enabled: !!_wakeupScheduleEnabled,
        wakeupTime: timeEl ? String(timeEl.value || '').trim() : '',
        targetTemperature: targetTemperature,
        days: days
    };
}

function _isValidWakeupTime(value) {
    if (!value) return true;
    var m = String(value).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return false;
    var h = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

function initWakeupSchedulePage() {
    setWakeupScheduleForm(WAKEUP_SCHEDULE_DEFAULTS);
    apiRequest(API_BASE + '/api/data/wakeup-schedule', { method: 'GET' }).then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        setWakeupScheduleForm(settings);
    }).catch(function () {
        setWakeupScheduleForm(WAKEUP_SCHEDULE_DEFAULTS);
    });
}

function saveWakeupSchedule() {
    var payload = collectWakeupScheduleForm();
    if (!_isValidWakeupTime(payload.wakeupTime)) {
        showAppModal('Wakeup Time must be in HH:MM format (00:00–23:59).', 'Wakeup Schedule');
        return;
    }
    if (payload.targetTemperature != null &&
        (payload.targetTemperature < 20 || payload.targetTemperature > 50)) {
        showAppModal('Target Temperature must be between 20 and 50 °C.', 'Wakeup Schedule');
        return;
    }
    if (payload.enabled && !payload.wakeupTime) {
        showAppModal('Enter a Wakeup Time before enabling the schedule.', 'Wakeup Schedule');
        return;
    }
    if (payload.enabled && (!payload.days || !payload.days.length)) {
        showAppModal('Select at least one day before enabling the schedule.', 'Wakeup Schedule');
        return;
    }
    var saveBtn = document.getElementById('wakeup-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    apiRequest(API_BASE + '/api/data/wakeup-schedule', { method: 'POST', body: payload })
        .then(function (result) {
            var settings = (result && result.settings) ? result.settings : payload;
            setWakeupScheduleForm(settings);
            if (typeof logAuditEvent === 'function') {
                logAuditEvent('Wakeup schedule saved', 'Instrument wakeup schedule updated', {
                    eventType: 'lifecycle',
                    entityType: 'settings'
                });
            }
            showAppModal('Wakeup schedule saved.', 'Wakeup Schedule');
        })
        .catch(function (err) {
            console.error('Failed to save wakeup schedule', err);
            var msg = (err && err.message) ? String(err.message) : 'Failed to save wakeup schedule.';
            if (/method not allowed/i.test(msg) || msg === 'Failed to fetch' ||
                msg === 'NetworkError when attempting to fetch resource.') {
                msg = 'Wakeup Schedule API is unavailable (METHOD NOT ALLOWED). Restart the Dissolution kiosk server and try Save again.';
            }
            showAppModal(msg, 'Wakeup Schedule');
        })
        .finally(function () {
            if (saveBtn) saveBtn.disabled = false;
        });
}

function initFactorySettings() {
    var screen = document.getElementById('page-factory-settings');
    if (!screen) return;
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        setFactorySettingsForm(settings);
        applyFactoryAutoLogoutSetting(settings);
    }).catch(function () {
        var stored = null;
        try { stored = localStorage.getItem('factorySettings'); } catch (e) {}
        var settings = stored ? JSON.parse(stored) : {};
        setFactorySettingsForm(settings);
        applyFactoryAutoLogoutSetting(settings);
    });
}

function setFactorySettingsForm(settings) {
    var idMap = [
        ['factory-company-name', 'companyName'],
        ['factory-company-location', 'companyLocation'],
        ['factory-serial-no', 'serialNo'],
        ['factory-model-no', 'modelNo'],
        ['factory-instrument-id', 'instrumentId'],
        ['factory-installation-date', 'installationDate'],
        ['factory-firmware', null],
        ['factory-installed-by', 'installedBy'],
        ['factory-max-recipes', 'maxRecipes'],
        ['factory-max-users', 'maxUsers'],
        ['factory-max-admins', 'maxAdmins'],
        ['factory-max-supervisors', 'maxSupervisors'],
        ['factory-max-qa', 'maxQa'],
        ['factory-password-reset-days', 'passwordResetPeriodDays'],
        ['factory-auto-logout-minutes', 'autoLogoutMinutes']
    ];
    idMap.forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (!el) return;
        if (pair[1] === null) {
            if (pair[0] === 'factory-firmware') el.value = 'RD-TDT v1.0.0';
            return;
        }
        var val = settings[pair[1]];
        if (pair[1] === 'maxRecipes') el.value = String(val || 150);
        else if (pair[1] === 'maxUsers') el.value = String(val || 10);
        else if (pair[1] === 'maxAdmins') el.value = String(val || 2);
        else if (pair[1] === 'maxSupervisors') el.value = String(val || 3);
        else if (pair[1] === 'maxQa') el.value = String(val != null ? val : 3);
        else if (pair[1] === 'passwordResetPeriodDays') el.value = String(val != null ? val : 30);
        else if (pair[1] === 'autoLogoutMinutes') el.value = String(val != null ? val : 0);
        else el.value = val || '';
    });
    var biometricEl = document.getElementById('factory-biometric-enabled');
    var biometricEnabled = normalizeBiometricEnabled(settings.biometricEnabled);
    if (biometricEl) biometricEl.value = biometricEnabled ? 'enabled' : 'disabled';
    applyBiometricSetting(biometricEnabled);
    updateLoginFactorySettingsDisplay(settings);
}

function saveFactorySettings() {
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        var role = getCurrentRole();
        if (!canPerformAction(role, 'factory-settings', 'save')) {
            showAppModal('You do not have permission to save factory settings.', 'Permission');
            return;
        }
    }
    var companyNameEl = document.getElementById('factory-company-name');
    var companyLocationEl = document.getElementById('factory-company-location');
    var serialNoEl = document.getElementById('factory-serial-no');
    var modelNoEl = document.getElementById('factory-model-no');
    var instrumentIdEl = document.getElementById('factory-instrument-id');
    var installationDateEl = document.getElementById('factory-installation-date');
    var installedByEl = document.getElementById('factory-installed-by');
    var maxRecipesEl = document.getElementById('factory-max-recipes');
    var maxUsersEl = document.getElementById('factory-max-users');
    var maxAdminsEl = document.getElementById('factory-max-admins');
    var maxSupervisorsEl = document.getElementById('factory-max-supervisors');
    var maxQaEl = document.getElementById('factory-max-qa');
    var passwordResetDaysEl = document.getElementById('factory-password-reset-days');
    var autoLogoutEl = document.getElementById('factory-auto-logout-minutes');
    var biometricEnabledEl = document.getElementById('factory-biometric-enabled');

    var companyName = companyNameEl && companyNameEl.value ? companyNameEl.value.trim() : '';
    var companyLocation = companyLocationEl && companyLocationEl.value ? companyLocationEl.value.trim() : '';
    if (!companyName || !companyLocation) {
        showAppModal('Company Name and Company Location are required.', 'Factory Settings');
        return;
    }
    var maxRecipes = Math.max(1, Math.min(999, parseInt(maxRecipesEl && maxRecipesEl.value ? maxRecipesEl.value : 150, 10)));
    var maxUsers = Math.max(1, Math.min(999, parseInt(maxUsersEl && maxUsersEl.value ? maxUsersEl.value : 10, 10)));
    var maxAdmins = Math.max(1, Math.min(99, parseInt(maxAdminsEl && maxAdminsEl.value ? maxAdminsEl.value : 2, 10)));
    var maxSupervisors = Math.max(1, Math.min(99, parseInt(maxSupervisorsEl && maxSupervisorsEl.value ? maxSupervisorsEl.value : 3, 10)));
    var maxQa = Math.max(1, Math.min(99, parseInt(maxQaEl && maxQaEl.value ? maxQaEl.value : 3, 10)));
    if (isNaN(maxUsers)) maxUsers = 10;
    if (isNaN(maxAdmins)) maxAdmins = 2;
    if (isNaN(maxSupervisors)) maxSupervisors = 3;
    if (isNaN(maxQa)) maxQa = 3;
    var passwordResetPeriodDays = Math.max(0, Math.min(3650, parseInt(passwordResetDaysEl && passwordResetDaysEl.value ? passwordResetDaysEl.value : 30, 10)));
    if (isNaN(passwordResetPeriodDays)) passwordResetPeriodDays = 30;
    var autoLogoutMinutes = Math.max(0, Math.min(10080, parseInt(autoLogoutEl && autoLogoutEl.value !== '' ? autoLogoutEl.value : '0', 10)));
    if (isNaN(autoLogoutMinutes)) autoLogoutMinutes = 0;

    var data = {
        companyName: companyName,
        companyLocation: companyLocation,
        serialNo: serialNoEl && serialNoEl.value ? serialNoEl.value.trim() : '',
        modelNo: modelNoEl && modelNoEl.value ? modelNoEl.value.trim() : '',
        instrumentId: instrumentIdEl && instrumentIdEl.value ? instrumentIdEl.value.trim() : '',
        installationDate: installationDateEl && installationDateEl.value ? installationDateEl.value : '',
        firmware: 'RD-TDT v1.0.0',
        installedBy: installedByEl && installedByEl.value ? installedByEl.value.trim() : '',
        maxRecipes: maxRecipes,
        maxUsers: maxUsers,
        maxAdmins: maxAdmins,
        maxSupervisors: maxSupervisors,
        maxQa: maxQa,
        passwordResetPeriodDays: passwordResetPeriodDays,
        autoLogoutMinutes: autoLogoutMinutes,
        biometricEnabled: normalizeBiometricEnabled(biometricEnabledEl ? biometricEnabledEl.value : true)
    };
    showConfirmModal('Save factory settings?', 'Factory Settings').then(function (ok) {
        if (!ok) return;
        apiRequest(API_BASE + '/api/data/factory-settings', { method: 'POST', body: data }).then(function () {
            try { localStorage.setItem('factorySettings', JSON.stringify(data)); } catch (e) {}
            applyBiometricSetting(data.biometricEnabled);
            applyFactoryAutoLogoutSetting(data);
            updateLoginFactorySettingsDisplay(data);
            showAppModal('Factory settings saved successfully.', 'Factory Settings');
        }).catch(function (err) {
            try { localStorage.setItem('factorySettings', JSON.stringify(data)); } catch (e) {}
            applyBiometricSetting(data.biometricEnabled);
            applyFactoryAutoLogoutSetting(data);
            updateLoginFactorySettingsDisplay(data);
            showAppModal('Factory settings saved locally.', 'Factory Settings');
        });
    });
}

function showFactoryResetConfirm() {
    showConfirmModal(
        'Are you sure you want to factory reset? This will permanently delete all reports, recipes, and users. This action cannot be undone.',
        'Factory Reset'
    ).then(function (ok) {
        if (!ok) return;
        apiRequest((API_BASE || '') + '/api/data/factory-reset', { method: 'POST', body: {} })
            .then(function (result) {
                showAppModal('Factory reset completed. All reports, recipes, and users have been deleted.', 'Factory Reset');
                if (typeof loadManageRecipes === 'function') loadManageRecipes();
                if (typeof loadReports === 'function') loadReports();
                if (typeof loadMembersAndRender === 'function') loadMembersAndRender();
            })
            .catch(function (err) {
                var msg = (err && err.message) ? err.message : 'Factory reset failed.';
                showAppModal(msg, 'Factory Reset');
            });
    });
}

function loadBiometricSetting() {
    apiRequest(API_BASE + '/api/data/factory-settings').then(function (result) {
        var settings = (result && result.settings) ? result.settings : (result || {});
        applyBiometricSetting(settings.biometricEnabled);
    }).catch(function () {
        try {
            var stored = localStorage.getItem('factorySettings');
            var settings = stored ? JSON.parse(stored) : {};
            applyBiometricSetting(settings.biometricEnabled);
        } catch (e) {
            applyBiometricSetting(true);
        }
    });
}

// ----- On-Screen Keyboard: attach to text-like inputs on focus / click -----
function attachKeyboardToInputs() {
    if (typeof window.openOSKForInput !== 'function') return;
    var selectors = [
        'input[type="text"]',
        'input[type="number"]',
        'input[type="password"]',
        'input[type="email"]',
        'input[type="tel"]',
        'input[type="search"]',
        'input[type="url"]',
        'textarea'
    ].join(', ');
    document.querySelectorAll(selectors).forEach(function (input) {
        if (!input || input.closest('#keyboard-root')) return;
        if (input.readOnly || input.disabled) return;
        if (input.type === 'hidden' || input.type === 'checkbox' || input.type === 'radio' || input.type === 'file' || input.type === 'range' || input.type === 'color') return;

        if (input._keyboardFocusHandler) {
            input.removeEventListener('focus', input._keyboardFocusHandler);
        }
        input._keyboardFocusHandler = function () {
            if (typeof window.openOSKForInput === 'function') {
                window.openOSKForInput(input);
            }
        };
        input.addEventListener('focus', input._keyboardFocusHandler);

        if (input._keyboardClickHandler) {
            input.removeEventListener('click', input._keyboardClickHandler);
        }
        input._keyboardClickHandler = function () {
            if (typeof window.openOSKForInput === 'function') {
                window.openOSKForInput(input);
            }
        };
        input.addEventListener('click', input._keyboardClickHandler);
    });
}

function _attachAllKeyboardHandlers(root) {
    if (typeof attachInputFocusHandlers === 'function') {
        attachInputFocusHandlers(root || document);
    } else {
        attachKeyboardToInputs();
    }
}

document.addEventListener('DOMContentLoaded', function () {
    if (typeof closeOSK === 'function') closeOSK();
    _attachAllKeyboardHandlers(document);
    loadBiometricSetting();
    loadLoginFactorySettingsDisplay();
    if (typeof initAuditReportsVisibility === 'function') initAuditReportsVisibility();
    if (typeof wireTestRunControlsOnce === 'function') wireTestRunControlsOnce();

    document.querySelectorAll('.nav-item[data-page]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var page = btn.getAttribute('data-page');
            if (!page) return;
            if (typeof isDissolutionTestActive === 'function' && isDissolutionTestActive()) {
                _dtConfirmAbortForNavigation().then(function (didAbort) {
                    if (!didAbort) return;
                    _suppressTestRunNavGuardOnce = true;
                    goToPage(page);
                });
                return;
            }
            if (typeof isValidationSuiteActive === 'function' && isValidationSuiteActive()) {
                _confirmAbortValidationSuiteForNavigation().then(function (didAbort) {
                    if (!didAbort) return;
                    _suppressValidationSuiteNavGuardOnce = true;
                    goToPage(page);
                });
                return;
            }
            goToPage(page);
        });
    });

    var originalGoToPage = goToPage;
    goToPage = function (pageName) {
        if (originalGoToPage) originalGoToPage(pageName);
        setTimeout(function () {
            _attachAllKeyboardHandlers(document);
        }, 200);
    };

    document.querySelectorAll('input[name="create-usp-mode"]').forEach(function (el) {
        el.addEventListener('change', applyRecipeModeToFields);
    });
    document.querySelectorAll('input[name="recipe-custom-completion"]').forEach(function (el) {
        el.addEventListener('change', applyRecipeModeToFields);
    });
    document.querySelectorAll('input[name="quick-usp-mode"]').forEach(function (el) {
        el.addEventListener('change', applyQuickRecipeModeToFields);
    });
    document.querySelectorAll('input[name="quick-recipe-custom-completion"]').forEach(function (el) {
        el.addEventListener('change', applyQuickRecipeModeToFields);
    });
    if (typeof applyRecipeModeToFields === 'function') applyRecipeModeToFields();

    function resetKioskSessionAndShowLogin() {
        try { localStorage.removeItem('currentUser'); } catch (e) {}
        window.currentUser = null;
        if (typeof currentUser !== 'undefined') currentUser = null;
        if (typeof clearReportApprovalGate === 'function') clearReportApprovalGate();
        window._lastReportPreview = null;
        var app = document.querySelector('.app-container');
        if (app) app.classList.remove('report-approval-locked');
        var resetUrl = (API_BASE || '') + '/api/data/auth/session-ui-reset';
        fetch(resetUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .catch(function () {})
            .finally(function () {
                showLoginScreen();
            });
    }
    resetKioskSessionAndShowLogin();
});

function skipMemberBiometricEnrollment() {
    _addMemberLastSavedId = null;
    goToPage('user-profile');
}

function backToMemberAfterBiometric() {
    _addMemberLastSavedId = null;
    goToPage('user-profile');
}

function _populateMemberBiometricSummary(member) {
    if (!member) return;
    var nameEl = document.getElementById('member-biometric-name');
    var userEl = document.getElementById('member-biometric-username');
    var roleEl = document.getElementById('member-biometric-role');
    if (nameEl) nameEl.textContent = member.name || '--';
    if (userEl) userEl.textContent = member.username || '--';
    if (roleEl) {
        var roleLabel = (typeof displayRoleLabel === 'function')
            ? displayRoleLabel(member.role)
            : (member.role || '--');
        roleEl.textContent = roleLabel;
    }
}

// ----- Add Member: form, permission overrides, biometric enrollment -----
function _isProtectedFeatureKey(key) {
    return key === 'dashboard' || key === 'factory-settings' || key === 'factory-reset';
}

function _addMemberPermissionsPanelShouldShow() {
    return typeof sessionCanAssignFeatureOverrides === 'function' && sessionCanAssignFeatureOverrides();
}

function _refreshAddMemberPermissionsPanelVisibility() {
    var panel = document.getElementById('add-member-permissions-panel');
    if (!panel) return;
    var show = _addMemberPermissionsPanelShouldShow();
    panel.classList.toggle('is-hidden', !show);
    panel.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) renderAddMemberPermissionCards();
    if (show && typeof ensureAddMemberPageScroll === 'function') {
        setTimeout(ensureAddMemberPageScroll, 0);
    }
}

function renderAddMemberPermissionCards() {
    var grid = document.getElementById('permission-cards-grid');
    if (!grid) return;
    grid.innerHTML = '';
    var catalog = (typeof getPermissionCardCatalog === 'function')
        ? getPermissionCardCatalog()
        : ((typeof getFeatureCatalog === 'function') ? getFeatureCatalog() : []);
    if (!_addMemberFeatureOverrides) _addMemberFeatureOverrides = { allow: [], deny: [] };
    _addMemberFeatureOverrides.deny = [];
    catalog.forEach(function (feature) {
        var key = feature.key;
        if (_isProtectedFeatureKey(key)) return;
        var selected = _addMemberFeatureOverrides.allow.indexOf(key) !== -1;
        var accent = feature.accent != null ? feature.accent : 0;
        var card = document.createElement('div');
        card.className = 'permission-card' + (selected ? ' is-selected permission-card--accent-' + accent : '');
        card.setAttribute('data-feature-key', key);
        card.setAttribute('title', 'Select or clear this functionality');
        card.innerHTML =
            '<div class="permission-card-title">' + feature.label + '</div>' +
            '<div class="permission-card-desc">' + (feature.description || '') + '</div>';
        card.addEventListener('click', function () { togglePermissionCardAllow(key); });
        grid.appendChild(card);
    });
}

function togglePermissionCardAllow(featureKey) {
    if (!featureKey || _isProtectedFeatureKey(featureKey)) return;
    if (!_addMemberFeatureOverrides) _addMemberFeatureOverrides = { allow: [], deny: [] };
    var i = _addMemberFeatureOverrides.allow.indexOf(featureKey);
    if (i === -1) _addMemberFeatureOverrides.allow.push(featureKey);
    else _addMemberFeatureOverrides.allow.splice(i, 1);
    _addMemberFeatureOverrides.deny = [];
    renderAddMemberPermissionCards();
}

function cyclePermissionCardState(featureKey) {
    togglePermissionCardAllow(featureKey);
}

function resetPermissionOverrides() {
    _addMemberFeatureOverrides = { allow: [], deny: [] };
    renderAddMemberPermissionCards();
}

function setAllPermissionOverrides() {
    renderAddMemberPermissionCards();
}

function _clearAddMemberForm() {
    editingMemberId = null;
    ['add-fullname', 'add-userid', 'add-password', 'add-confirm-password'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var userIdEl = document.getElementById('add-userid');
    if (userIdEl) {
        userIdEl.readOnly = false;
        userIdEl.disabled = false;
        userIdEl.classList.remove('input-readonly');
    }
    if (typeof selectRole === 'function') selectRole('User');
    _addMemberFeatureOverrides = { allow: [], deny: [] };
    _setAddMemberPageMode(false, false);
}


/* =====================================================
   TEST RUN PAGE — Dual Rotating Drum Logic
   ===================================================== */

function _recipeProcedureMode(recipe) {
    var m = String((recipe && (recipe.uspMode || recipe.usp)) || '').trim().toUpperCase();
    return (m === 'CUSTOM' || m.indexOf('CUSTOM') >= 0) ? 'CUSTOM' : 'USP';
}

function _recipeRpmFromPayload(recipe) {
    if (_recipeProcedureMode(recipe) === 'USP') return 25;
    var rpm = parseInt(recipe && recipe.speed, 10);
    if (isNaN(rpm) && recipe && recipe.steps && recipe.steps[0]) {
        rpm = parseInt(recipe.steps[0].speed, 10);
    }
    if (!isNaN(rpm) && rpm >= 20 && rpm <= 70) return rpm;
    return 25;
}

function _recipeRotationTargetFromPayload(recipe) {
    if (_recipeProcedureMode(recipe) === 'USP') return 100;
    var n = parseInt(recipe && recipe.tabletCount, 10);
    if (isNaN(n)) n = parseInt(recipe && recipe.customTotalTaps, 10);
    if (isNaN(n) && recipe && recipe.steps && recipe.steps[0]) {
        n = parseInt(recipe.steps[0].tapCount, 10);
    }
    return Math.max(1, isNaN(n) ? 100 : n);
}

function _recipeTimeTargetSecondsFromPayload(recipe) {
    if (_recipeProcedureMode(recipe) === 'USP') return 240;
    var exactSeconds = parseInt(recipe && (recipe.timeSeconds != null ? recipe.timeSeconds : recipe.targetSeconds), 10);
    if (!isNaN(exactSeconds) && exactSeconds > 0) return exactSeconds;
    return Math.max(1, (parseInt(recipe && recipe.timeMinutes, 10) || 4) * 60);
}

var _tr = {
    recipe: null,
    drumCount: 2,
    batchNumber1: '--',
    batchNumber2: '--',
    running: false,
    paused: false,
    done: false,
    rotationCount: 0,
    targetRotations: 100,
    completionMode: 'COUNT',
    targetSeconds: 240,
    elapsedSeconds: 0,
    rpm: 25,
    hardwareInitialized: false,
    initialWeightsCaptured: false,
    testFinished: false,
    dispenseComplete: false,
    dispensing: false,
    initializing: false,
    abortedRun: false,
    initialWeight1: null,
    initialWeight2: null,
    initialWeight: null,
    finalWeight1: null,
    finalWeight2: null,
    finalWeight: null,
    dispenseTimer: null,
    timerInterval: null,
    rotationInterval: null,
    hwUnsubscribe: null,
    useHardware: false,
    runDurationSec: 240,
    pauseResumePending: false
};
var _trHwAwaitingStart = false;
var _trInitGeneration = 0;

function _trUpdatePrimaryButtonLabel() {
    var start = _trEl('tr-start-btn');
    if (!start) return;
    if (!_tr.hardwareInitialized) {
        start.textContent = 'Initialize';
    } else {
        start.textContent = 'Start';
    }
}

function _trPromptInitialWeights() {
    // Dissolution: no friability initial-weight capture.
    _tr.initialWeightsCaptured = true;
    return Promise.resolve(true);
}

function _trRound3(value) {
    var n = Number(value);
    if (!isFinite(n)) return null;
    return Math.round(n * 1000) / 1000;
}

function _trWeightResult(label, batchNumber, initialWeight, finalWeight) {
    var w1 = Number(initialWeight);
    var w2 = Number(finalWeight);
    var hasWeights = isFinite(w1) && isFinite(w2);
    var difference = hasWeights ? (w2 - w1) : null;
    var loss = hasWeights ? (w1 - w2) : null;
    var friability = hasWeights && w1 > 0 ? ((w1 - w2) / w1) * 100 : null;
    var trend = 'No change';
    if (difference != null && difference > 0) trend = 'Increased';
    else if (difference != null && difference < 0) trend = 'Decreased';
    return {
        drumLabel: label,
        batchNumber: batchNumber || '--',
        initialWeight: hasWeights ? _trRound3(w1) : null,
        finalWeight: hasWeights ? _trRound3(w2) : null,
        weightLoss: loss != null ? _trRound3(loss) : null,
        weightDifference: difference != null ? _trRound3(difference) : null,
        friabilityPercent: friability != null ? _trRound3(friability) : null,
        weightTrend: trend,
        // Final PASS/FAIL is set only at report approval time.
        resultText: 'Pending approval'
    };
}

function _trBuildStepResults() {
    // Dissolution: step rows without friability weights / drums.
    return [{
        rpm: _tr.rpm,
        setTime: _tr.completionMode === 'TIME'
            ? (typeof formatSecondsAsMmSs === 'function' ? formatSecondsAsMmSs(_tr.targetSeconds) : String(_tr.targetSeconds || '--'))
            : '--',
        status: _tr.abortedRun ? 'Aborted' : 'Completed',
        resultText: 'Pending approval'
    }];
}

function _trNumbersFromRows(rows, key) {
    return (rows || []).map(function (row) {
        return row && row[key] != null ? Number(row[key]) : NaN;
    }).filter(function (n) {
        return isFinite(n);
    });
}

function _trMeanMinMax(values) {
    if (!values || !values.length) return null;
    var sum = values.reduce(function (acc, n) { return acc + n; }, 0);
    return {
        mean: _trRound3(sum / values.length),
        min: _trRound3(Math.min.apply(Math, values)),
        max: _trRound3(Math.max.apply(Math, values))
    };
}

function _trBuildWeightStatistics(rows, totalInitial, totalFinal, totalLoss, overallFriability) {
    var stats = {};
    var friabilityStats = _trMeanMinMax(_trNumbersFromRows(rows, 'friabilityPercent'));
    if (friabilityStats) stats['Friability (%)'] = friabilityStats;
    var lossStats = _trMeanMinMax(_trNumbersFromRows(rows, 'weightLoss'));
    if (lossStats) stats['Weight loss (g)'] = lossStats;
    if (overallFriability != null) stats['Overall friability (%)'] = { value: _trRound3(overallFriability) };
    if (totalInitial != null) stats['Initial weight total (g)'] = { value: _trRound3(totalInitial) };
    if (totalFinal != null) stats['Final weight total (g)'] = { value: _trRound3(totalFinal) };
    if (totalLoss != null) stats['Total weight loss (g)'] = { value: _trRound3(totalLoss) };
    stats['Drum count'] = { value: _tr.drumCount };
    stats['Rotations completed'] = { value: _tr.rotationCount };
    return stats;
}

function _trPromptFinalWeights() {
    // Dissolution: no friability final-weight capture.
    return Promise.resolve(true);
}

function _trBeginDispenseSpin() {
    ['tr-drum1-inner', 'tr-drum2-inner'].forEach(function (id) {
        var el = _trEl(id);
        if (el) {
            el.style.animationDirection = 'reverse';
            el.classList.add('tr-spinning');
        }
    });
}

function _trEndDispenseSpin() {
    ['tr-drum1-inner', 'tr-drum2-inner'].forEach(function (id) {
        var el = _trEl(id);
        if (el) {
            el.classList.remove('tr-spinning');
            el.style.animationDirection = 'normal';
        }
    });
}

function _trGetRunDurationSeconds() {
    if (_tr.completionMode === 'TIME') {
        return Math.max(1, _tr.targetSeconds || 1);
    }
    var rpm = Math.max(1, _tr.rpm || 25);
    var count = Math.max(1, _tr.targetRotations || 1);
    return Math.max(1, Math.round((count / rpm) * 60));
}

function _trCleanupHardwareStream() {
    if (_tr.hwUnsubscribe) {
        _tr.hwUnsubscribe();
        _tr.hwUnsubscribe = null;
    }
}

function _trApplyHardwareRotationCount(sessionCount) {
    var n = parseInt(sessionCount, 10);
    if (isNaN(n) || n < 0) return;
    _tr.rotationCount = n;
    _trSetText('tr-count1', _tr.rotationCount);
    _trSetText('tr-count2', _tr.rotationCount);
    _trRefreshProgressUi();
    if (_tr.completionMode === 'COUNT' && _trGetProgressData().done) {
        _trFinishDueToTimer();
    }
}

function _trMaybeCompleteRun() {
    if (!_tr.running || _tr.paused) return;
    if (_trGetProgressData().done) {
        _trFinishDueToTimer();
    }
}

function _trHandleHardwareStreamPayload(payload) {
    if (_tr.paused) return;
    if (!_tr.running && !_trHwAwaitingStart) return;
    var n = parseHardwareRotationCount(payload);
    if (n != null) {
        _trApplyHardwareRotationCount(n);
    } else if (payload && payload.kind && payload.kind !== 'ping' && !payload.rpmPending) {
        console.debug('[ESP-Pi] unmapped test line:', payload);
    }
}

function _trApplyLiveState(state) {
    if (_tr.paused || !state) return;
    if (!_tr.running && !_trHwAwaitingStart) return;
    var n = parseHardwareRotationCount(state);
    if (n != null) _trApplyHardwareRotationCount(n);
}

function _trGetProgressData() {
    if (_tr.completionMode === 'TIME') {
        var targetTime = Math.max(1, _tr.targetSeconds || 1);
        return {
            pct: Math.min(100, (_tr.elapsedSeconds / targetTime) * 100),
            text: _tr.rotationCount + ' rot · ' + _tr.elapsedSeconds + 's / ' + targetTime + 's',
            done: _tr.elapsedSeconds >= targetTime
        };
    }
    var targetCount = Math.max(1, _tr.targetRotations || 1);
    return {
        pct: Math.min(100, (_tr.rotationCount / targetCount) * 100),
        text: _tr.rotationCount + ' / ' + targetCount,
        done: _tr.rotationCount >= targetCount
    };
}

function _trRefreshProgressUi() {
    var progress = _trGetProgressData();
    var progressFillEl = _trEl('tr-progress-fill');
    if (progressFillEl) progressFillEl.style.width = progress.pct.toFixed(1) + '%';
    var progressTextEl = _trEl('tr-progress-text');
    if (progressTextEl) progressTextEl.textContent = progress.text;
}

function initTestRunPage(recipe) {
    _tr.recipe = recipe || {};
    _tr.drumCount = parseInt(_tr.recipe.drumCount, 10) === 1 ? 1 : 2;
    _tr.running = false;
    _tr.paused = false;
    _tr.pauseResumePending = false;
    _tr.done = false;
    _tr.hardwareInitialized = false;
    _tr.initialWeightsCaptured = false;
    _tr.testFinished = false;
    _tr.dispenseComplete = false;
    _tr.dispensing = false;
    _tr.rotationCount = 0;
    _tr.elapsedSeconds = 0;
    _tr.batchNumber1 = _tr.recipe.batchNumber1 || _tr.recipe.batchNumber || '--';
    _tr.batchNumber2 = _tr.recipe.batchNumber2 || '--';
    _tr.initialWeight1 = null;
    _tr.initialWeight2 = null;
    _tr.initialWeight = null;
    _tr.finalWeight1 = null;
    _tr.finalWeight2 = null;
    _tr.finalWeight = null;

    _tr.rpm = _recipeRpmFromPayload(_tr.recipe);

    var storedMode = String((_tr.recipe && _tr.recipe.customCompletionMode) || '').toUpperCase();
    if (_recipeProcedureMode(_tr.recipe) === 'USP') {
        storedMode = 'COUNT';
    }
    _tr.completionMode = storedMode === 'TIME' ? 'TIME' : 'COUNT';
    _tr.targetRotations = _recipeRotationTargetFromPayload(_tr.recipe);
    _tr.targetSeconds = _recipeTimeTargetSecondsFromPayload(_tr.recipe);

    _trEl('tr-product-name').textContent = recipe.productName || recipe.name || '--';
    _trEl('tr-batch-number').textContent = _tr.drumCount === 2
        ? ('D1: ' + _tr.batchNumber1 + ' | D2: ' + _tr.batchNumber2)
        : _tr.batchNumber1;
    _trEl('tr-speed').textContent = _tr.rpm + ' RPM';
    var trTargetEl = _trEl('tr-target-rot');
    var trModeEl = _trEl('tr-mode');
    var trIw1Block = _trEl('tr-header-iw1-block');
    var trIw2Block = _trEl('tr-header-iw2-block');
    var trIw1Val = _trEl('tr-initial-weight1');
    var trIw2Val = _trEl('tr-initial-weight2');
    var trProgressLabelEl = _trEl('tr-progress-label');
    if (_tr.completionMode === 'TIME') {
        if (trTargetEl) trTargetEl.textContent = formatSecondsAsMmSs(_tr.targetSeconds);
        if (trModeEl) trModeEl.textContent = _tr.drumCount === 2 ? '2 Drums • Time' : '1 Drum • Time';
        if (trProgressLabelEl) trProgressLabelEl.textContent = 'Progress (Time)';
    } else {
        if (trTargetEl) trTargetEl.textContent = _tr.targetRotations + ' Rotations';
        if (trModeEl) trModeEl.textContent = _tr.drumCount === 2 ? '2 Drums • Count' : '1 Drum • Count';
        if (trProgressLabelEl) trProgressLabelEl.textContent = 'Progress (Count)';
    }
    if (trIw1Val) trIw1Val.textContent = _tr.initialWeight1 != null ? _tr.initialWeight1.toFixed(3) : '--';
    if (trIw2Val) trIw2Val.textContent = _tr.initialWeight2 != null ? _tr.initialWeight2.toFixed(3) : '--';
    if (trIw1Block) trIw1Block.style.display = '';
    if (trIw2Block) trIw2Block.style.display = _tr.drumCount === 2 ? '' : 'none';

    _trSetText('tr-timer', '00:00');
    _trSetText('tr-count1', '0');
    _trSetText('tr-count2', '0');
    _trEl('tr-progress-fill').style.width = '0%';
    _trRefreshProgressUi();
    _trEl('tr-footer-note').textContent = 'Press Start to begin the test.';

    var drumsRow = _trEl('tr-drums-row');
    var drum2Wrap = _trEl('tr-drum-wrapper-2');
    if (drumsRow) drumsRow.classList.toggle('one-drum', _tr.drumCount === 1);
    if (drum2Wrap) drum2Wrap.style.display = _tr.drumCount === 1 ? 'none' : '';

    _trSetStatus(1, 'idle');
    if (_tr.drumCount === 2) _trSetStatus(2, 'idle');
    _trSetButtons('uninitialized');
    _trUpdatePrimaryButtonLabel();

    _trStopSpin();

    var secPerRev = 60 / _tr.rpm;
    var css = secPerRev + 's';
    ['tr-drum1-inner', 'tr-drum2-inner'].forEach(function (id) {
        var el = _trEl(id);
        if (el) {
            el.style.animationDuration = css;
        }
    });

}

function _trEl(id) {
    return document.getElementById(id);
}

function _trSetText(id, value) {
    var el = _trEl(id);
    if (el) el.textContent = value;
}

function _trSetStatus(drumNum, state) {
    var el = _trEl('tr-status' + drumNum);
    if (!el) return;
    el.className = 'tr-drum-status';
    if (state === 'running') {
        el.classList.add('tr-running');
        el.textContent = 'Running';
    } else if (state === 'paused') {
        el.classList.add('tr-paused');
        el.textContent = 'Paused';
    } else if (state === 'done') {
        el.classList.add('tr-done');
        el.textContent = 'Done';
    } else {
        el.textContent = 'Idle';
    }
}

function _trSetButtons(state) {
    var start = _trEl('tr-start-btn');
    var pause = _trEl('tr-pause-btn');
    var resume = _trEl('tr-resume-btn');
    var dispense = _trEl('tr-dispense-btn');
    var stop = _trEl('tr-stop-btn');
    var busy = state === 'pausing' || state === 'resuming' || state === 'initializing' || state === 'dispensing';

    if (dispense) {
        dispense.style.display = (state === 'await-dispense' || state === 'dispensing') ? '' : 'none';
        dispense.disabled = state === 'dispensing';
    }

    if (state === 'uninitialized' || state === 'ready') {
        if (start) { start.style.display = ''; start.disabled = false; }
        if (pause) { pause.style.display = 'none'; pause.disabled = false; }
        if (resume) { resume.style.display = 'none'; resume.disabled = false; }
        if (stop) { stop.style.display = ''; stop.disabled = false; }
        _trUpdatePrimaryButtonLabel();
    } else if (state === 'initializing') {
        if (start) { start.style.display = ''; start.disabled = true; }
        if (pause) pause.style.display = 'none';
        if (resume) resume.style.display = 'none';
        if (stop) { stop.style.display = ''; stop.disabled = false; }
    } else if (state === 'await-dispense') {
        if (start) { start.style.display = ''; start.disabled = true; }
        if (pause) pause.style.display = 'none';
        if (resume) resume.style.display = 'none';
        if (stop) { stop.style.display = ''; stop.disabled = false; }
    } else if (state === 'dispensing') {
        if (start) start.style.display = 'none';
        if (pause) pause.style.display = 'none';
        if (resume) resume.style.display = 'none';
        if (stop) { stop.style.display = ''; stop.disabled = true; }
    } else if (state === 'done') {
        if (start) { start.style.display = ''; start.disabled = true; }
        if (pause) { pause.style.display = 'none'; pause.disabled = false; }
        if (resume) { resume.style.display = 'none'; resume.disabled = false; }
        if (stop) { stop.style.display = ''; stop.disabled = true; }
    } else if (state === 'running') {
        if (start) start.style.display = 'none';
        if (pause) { pause.style.display = ''; pause.disabled = false; }
        if (resume) resume.style.display = 'none';
        if (stop) { stop.style.display = ''; stop.disabled = false; }
    } else if (state === 'paused' || state === 'pausing') {
        if (start) start.style.display = 'none';
        if (pause) pause.style.display = 'none';
        if (resume) {
            resume.style.display = state === 'pausing' ? 'none' : '';
            resume.disabled = busy;
        }
        if (stop) { stop.style.display = ''; stop.disabled = busy; }
    } else if (state === 'resuming') {
        if (start) start.style.display = 'none';
        if (pause) { pause.style.display = ''; pause.disabled = true; }
        if (resume) resume.style.display = 'none';
        if (stop) { stop.style.display = ''; stop.disabled = true; }
    }
}

function _trStartSpin() {
    ['tr-drum1-inner', 'tr-drum2-inner'].forEach(function (id) {
        var el = _trEl(id);
        if (el) {
            el.style.animationDirection = 'normal';
            el.classList.add('tr-spinning');
        }
    });
}

function _trStopSpin() {
    ['tr-drum1-inner', 'tr-drum2-inner'].forEach(function (id) {
        var el = _trEl(id);
        if (el) el.classList.remove('tr-spinning');
    });
}

function _trFormatTime(secs) {
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function _trBeginRunLoops(useHardware) {
    _tr.useHardware = !!useHardware;
    _tr.runDurationSec = _trGetRunDurationSeconds();
    _tr.running = true;
    _tr.paused = false;
    _trSetStatus(1, 'running');
    _trSetStatus(2, 'running');
    _trSetButtons('running');
    _trEl('tr-footer-note').textContent = 'Test in progress…';

    _trStartSpin();
    _tr.timerInterval = setInterval(function () {
        if (!_tr.running || _tr.paused) return;
        _tr.elapsedSeconds++;
        var ts = _trFormatTime(_tr.elapsedSeconds);
        _trSetText('tr-timer', ts);
        _trRefreshProgressUi();
        var timeLimitDone = _tr.elapsedSeconds >= _tr.runDurationSec;
        if (_tr.completionMode === 'TIME' && timeLimitDone) {
            _trFinishDueToTimer();
            return;
        }
        if (_tr.completionMode === 'TIME') {
            _trMaybeCompleteRun();
        }
    }, 1000);

    if (!_tr.useHardware) {
        var msPerRotation = Math.round(60000 / _tr.rpm);
        _tr.rotationInterval = setInterval(function () {
            if (!_tr.running || _tr.paused) return;
            _tr.rotationCount++;
            _trSetText('tr-count1', _tr.rotationCount);
            _trSetText('tr-count2', _tr.rotationCount);
            _trRefreshProgressUi();
            if (_tr.completionMode === 'COUNT') {
                _trMaybeCompleteRun();
            }
        }, msPerRotation);
    }
}

function _trStartRunLoop() {
    var tryHardware = testHardwareEnabled !== false;
    if (!tryHardware) {
        _trBeginRunLoops(false);
        return;
    }
    ensureHardwareStream();
    _trCleanupHardwareStream();
    _tr.rotationCount = 0;
    _tr.pauseResumePending = false;
    _trHwAwaitingStart = true;
    _tr.hwUnsubscribe = subscribeHardwareStream(_trHandleHardwareStreamPayload);
    startHardwareLivePoll(_trApplyLiveState);
    friabilityHardwareStart(_tr.rpm).then(function (res) {
        if (!res || res.ok !== true) {
            throw new Error((res && (res.error || res.response)) || 'Hardware did not acknowledge start');
        }
        _trHwAwaitingStart = false;
        _trBeginRunLoops(true);
        fetchFriabilityLiveState().then(_trApplyLiveState).catch(function () {});
    }).catch(function (err) {
        _trHwAwaitingStart = false;
        console.warn('Hardware start failed, using simulation:', err);
        stopHardwareLivePoll();
        _trCleanupHardwareStream();
        _trBeginRunLoops(false);
    });
}

function _trFinishDueToTimer() {
    if (!_tr.running) return;
    clearInterval(_tr.timerInterval);
    clearInterval(_tr.rotationInterval);
    _tr.timerInterval = null;
    _tr.rotationInterval = null;
    _tr.running = false;
    var finalize = function () {
        stopHardwareLivePoll();
        _trCleanupHardwareStream();
        _trCompleteTest();
    };
    if (_tr.useHardware) {
        friabilityHardwareStopWithRetry().catch(function () {}).finally(finalize);
    } else {
        finalize();
    }
}

function trInitialize() {
    if (_tr.hardwareInitialized || _tr.running || _tr.initializing) return;
    _trInitGeneration += 1;
    var initGen = _trInitGeneration;
    _tr.initializing = true;
    _trSetButtons('initializing');
    var footer = _trEl('tr-footer-note');
    if (footer) footer.textContent = 'Initializing drums…';

    var finalizeInit = function (ok, errMsg) {
        if (initGen !== _trInitGeneration) return;
        _tr.initializing = false;
        if (!ok) {
            _trSetButtons('uninitialized');
            if (footer) footer.textContent = 'Press Initialize to prepare the drums.';
            showAppModal(errMsg || 'Initialize failed. Check hardware connection.', 'Initialize');
            return;
        }
        _tr.hardwareInitialized = true;
        _trSetButtons('ready');
        if (footer) footer.textContent = 'Press Start to begin.';
        _trPromptInitialWeights().then(function (captured) {
            if (!captured) {
                _tr.hardwareInitialized = false;
                _tr.initialWeightsCaptured = false;
                _tr.initialWeight1 = null;
                _tr.initialWeight2 = null;
                _tr.initialWeight = null;
                var w1El = _trEl('tr-initial-weight1');
                var w2El = _trEl('tr-initial-weight2');
                if (w1El) w1El.textContent = '--';
                if (w2El) w2El.textContent = '--';
                _trSetButtons('uninitialized');
                if (footer) footer.textContent = 'Press Initialize to prepare the drums.';
                return;
            }
            if (footer) footer.textContent = 'Press Start to begin the test.';
        });
    };

    if (testHardwareEnabled === false) {
        setTimeout(function () { finalizeInit(true); }, 400);
        return;
    }
    friabilityHardwareInitialise().then(function (res) {
        if (!res || res.ok !== true) {
            throw new Error((res && (res.error || res.response)) || 'Hardware did not acknowledge initialize');
        }
        finalizeInit(true);
    }).catch(function (err) {
        var msg = err && err.message ? err.message : 'Initialize failed.';
        if (/method not allowed/i.test(msg)) {
            msg = 'Initialize API is unavailable. Restart the kiosk service (kiosk-bridge) and try again.';
        }
        finalizeInit(false, msg);
    });
}

function _trStopRunHardwareAndTimers() {
    clearInterval(_tr.timerInterval);
    clearInterval(_tr.rotationInterval);
    _tr.timerInterval = null;
    _tr.rotationInterval = null;
    stopHardwareLivePoll();
    _trCleanupHardwareStream();
    if (_tr.useHardware) {
        friabilityHardwareStopWithRetry().catch(function () {});
    }
    _tr.useHardware = false;
    _tr.running = false;
    _tr.paused = false;
    _tr.pauseResumePending = false;
    _trStopSpin();
}

function trDispenseTest(opts) {
    opts = opts || {};
    if (_tr.dispensing) {
        return Promise.reject(new Error('Dispense already in progress'));
    }
    if (!_tr.testFinished && !_tr.running) {
        return Promise.reject(new Error('No test to dispense'));
    }
    _tr.dispensing = true;
    _trSetButtons('dispensing');
    var footer = _trEl('tr-footer-note');
    if (footer) footer.textContent = 'Dispense in progress…';
    _trBeginDispenseSpin();

    return new Promise(function (resolve, reject) {
        var finishDispense = function (ok, errMsg) {
            if (_tr.dispenseTimer) {
                clearTimeout(_tr.dispenseTimer);
                _tr.dispenseTimer = null;
            }
            _tr.dispensing = false;
            _trEndDispenseSpin();
            if (!ok) {
                _trSetButtons('await-dispense');
                if (footer) {
                    footer.textContent = _tr.abortedRun
                        ? 'Test aborted. Press Dispense when ready.'
                        : 'Test complete. Press Dispense when ready.';
                }
                showAppModal(errMsg || 'Dispense failed. Check hardware connection.', 'Dispense');
                reject(new Error(errMsg || 'Dispense failed'));
                return;
            }
            _tr.dispenseComplete = true;
            _trPromptFinalWeightAndSaveReport({ aborted: !!opts.aborted || !!_tr.abortedRun }).then(resolve).catch(reject);
        };

        if (testHardwareEnabled === false) {
            _tr.dispenseTimer = setTimeout(function () { finishDispense(true); }, 1500);
            return;
        }
        friabilityHardwareDispense().then(function (res) {
            if (!res || res.ok !== true) {
                throw new Error((res && (res.error || res.response)) || 'Hardware did not complete dispense');
            }
            finishDispense(true);
        }).catch(function (err) {
            finishDispense(false, err && err.message ? err.message : 'Dispense failed.');
        });
    });
}

function trStartTest() {
    if (_tr.done || _tr.running || _tr.testFinished) return;
    if (!_tr.hardwareInitialized) {
        trInitialize();
        return;
    }
    if (!_tr.initialWeightsCaptured) {
        _trPromptInitialWeights().then(function (captured) {
            if (captured) trStartTest();
        });
        return;
    }
    auditTestRunStarted(window.activeTestRecipe);
    _trStartRunLoop();
}

function trPauseTest() {
    if (!_tr.running || _tr.paused || _tr.pauseResumePending) return;
    _tr.pauseResumePending = true;
    _trSetButtons('pausing');
    var footer = _trEl('tr-footer-note');
    if (footer) footer.textContent = 'Pausing test…';

    var applyPauseUi = function () {
        _tr.paused = true;
        _tr.pauseResumePending = false;
        _trStopSpin();
        _trSetStatus(1, 'paused');
        _trSetStatus(2, 'paused');
        _trSetButtons('paused');
        if (footer) footer.textContent = 'Test paused. Press Resume to continue.';
        var rec = window.activeTestRecipe || {};
        logAuditEvent('Test paused', (rec.productName || rec.name || 'Test') + ', ' + _tr.rotationCount + ' rotations', {
            eventType: 'lifecycle',
            entityType: 'test',
            extra: { rotationCount: _tr.rotationCount, elapsedSeconds: _tr.elapsedSeconds }
        });
    };

    if (_tr.useHardware) {
        friabilityHardwarePause().catch(function () {}).finally(applyPauseUi);
    } else {
        applyPauseUi();
    }
}

function trResumeTest() {
    if (!_tr.running || !_tr.paused || _tr.pauseResumePending) return;
    _tr.pauseResumePending = true;
    _trSetButtons('resuming');
    var footer = _trEl('tr-footer-note');
    if (footer) footer.textContent = 'Resuming test…';

    var applyResumeUi = function () {
        _tr.paused = false;
        _tr.pauseResumePending = false;
        _trStartSpin();
        _trSetStatus(1, 'running');
        _trSetStatus(2, 'running');
        _trSetButtons('running');
        if (footer) footer.textContent = 'Test in progress…';
        var rec = window.activeTestRecipe || {};
        logAuditEvent('Test resumed', (rec.productName || rec.name || 'Test') + ', from ' + _tr.rotationCount + ' rotations', {
            eventType: 'lifecycle',
            entityType: 'test',
            extra: { rotationCount: _tr.rotationCount, elapsedSeconds: _tr.elapsedSeconds }
        });
    };

    if (_tr.useHardware) {
        friabilityHardwareResume().then(function (res) {
            if (!res || res.ok !== true) {
                throw new Error((res && (res.error || res.response)) || 'Hardware did not acknowledge resume');
            }
            applyResumeUi();
        }).catch(function (err) {
            _tr.pauseResumePending = false;
            _trSetButtons('paused');
            if (footer) footer.textContent = 'Test paused. Press Resume to continue.';
            showAppModal('Failed to resume test: ' + (err && err.message ? err.message : 'Unknown error'), 'Test');
        });
    } else {
        applyResumeUi();
    }
}

function _trConfirmAbortAndDispense() {
    return showYesNoModal(
        'Do you want to abort the test and dispense?',
        'Abort Test',
        'OK',
        'Cancel'
    ).then(function (ok) {
        if (!ok) return Promise.resolve(false);
        _trStopRunHardwareAndTimers();
        _tr.testFinished = true;
        _tr.abortedRun = true;
        _trSetStatus(1, 'done');
        _trSetStatus(2, 'done');
        return trDispenseTest({ aborted: true }).then(function () { return true; }).catch(function () { return true; });
    });
}

function trStopTest() {
    if (_tr.initializing || _tr.dispensing) {
        _trInitGeneration += 1;
        _trDoStop();
        return;
    }
    if (_tr.running) {
        _trConfirmAbortAndDispense();
        return;
    }
    if (_tr.testFinished && !_tr.dispenseComplete) {
        showYesNoModal('Discard this completed test before dispense?', 'Test', 'OK', 'Cancel').then(function (ok) {
            if (!ok) return;
            _trDoStop();
        });
        return;
    }
    _trDoStop();
}

function _trDoStop() {
    _trInitGeneration += 1;
    _tr.initializing = false;
    _tr.dispensing = false;
    _trStopRunHardwareAndTimers();
    _tr.running = false;
    _pendingTestRunReportId = null;
    closeTestRunCompletionApprovalModal();
    if (_tr.dispenseTimer) {
        clearTimeout(_tr.dispenseTimer);
        _tr.dispenseTimer = null;
    }
    _trEndDispenseSpin();
    _tr.paused = false;
    _tr.pauseResumePending = false;
    _tr.done = false;
    _tr.hardwareInitialized = false;
    _tr.initialWeightsCaptured = false;
    _tr.testFinished = false;
    _tr.dispenseComplete = false;
    _tr.abortedRun = false;
    _trSetStatus(1, 'idle');
    _trSetStatus(2, 'idle');
    _tr.rotationCount = 0;
    _tr.elapsedSeconds = 0;
    _tr.initialWeight1 = null;
    _tr.initialWeight2 = null;
    _tr.initialWeight = null;
    _tr.finalWeight1 = null;
    _tr.finalWeight2 = null;
    _tr.finalWeight = null;
    _trSetText('tr-count1', '0');
    _trSetText('tr-count2', '0');
    _trSetText('tr-timer', '00:00');
    _trEl('tr-progress-fill').style.width = '0%';
    _trRefreshProgressUi();
    var w1El = _trEl('tr-initial-weight1');
    var w2El = _trEl('tr-initial-weight2');
    if (w1El) w1El.textContent = '--';
    if (w2El) w2El.textContent = '--';
    _trSetButtons('uninitialized');
    _trUpdatePrimaryButtonLabel();
    _trEl('tr-footer-note').textContent = 'Test aborted. Press Initialize to run again.';
}

function _trBuildCompletionReportPayload(opts) {
    opts = opts || {};
    var isAborted = !!opts.aborted;
    var recipe = _tr.recipe || {};
    var nowIso = getDisplayedKioskDateTimeIso();
    var stepResults = _trBuildStepResults();
    var currentUserSafe = window.currentUser || {};
    var modeLabel = _tr.completionMode === 'TIME' ? 'TIME' : 'COUNT';
    var targetLabel = _tr.completionMode === 'TIME'
        ? formatSecondsAsMmSs(_tr.targetSeconds)
        : (_tr.targetRotations + ' Rotations');
    var runDetails = (isAborted ? 'Aborted run. ' : '') + 'Mode: ' + modeLabel + ', Target: ' + targetLabel;
    return {
        name: 'Dissolution Test - ' + (recipe.productName || recipe.name || 'Recipe') + (isAborted ? ' (Aborted)' : ''),
        type: 'test',
        status: isAborted ? 'Aborted' : 'Completed',
        createdAt: nowIso,
        completedAt: nowIso,
        recipe: recipe,
        remarks: '',
        statistics: {},
        testData: {
            recipe: recipe,
            productName: recipe.productName || recipe.name || '--',
            batchNumber: recipe.batchNumber || '--',
            speed: _tr.rpm,
            rpm: _tr.rpm,
            mode: modeLabel,
            target: targetLabel,
            runDetails: runDetails,
            durationSeconds: _tr.elapsedSeconds,
            testStartTime: subtractSecondsFromIso(nowIso, _tr.elapsedSeconds),
            testEndTime: nowIso,
            stepCount: stepResults.length,
            completedSteps: isAborted ? 0 : stepResults.length,
            status: isAborted ? 'aborted' : 'completed',
            statistics: {},
            operatorName: currentUserSafe.name || currentUserSafe.username || '--',
            employeeId: currentUserSafe.username || '--',
            operatorUsername: currentUserSafe.username || '--',
            remarks: '',
            stepResults: stepResults
        }
    };
}

function _trPromptFinalWeightAndSaveReport(opts) {
    opts = opts || {};
    var isAborted = !!opts.aborted;
    _trSetButtons('done');
    return _trPromptFinalWeights().then(function () {
        var note = (isAborted ? 'Test aborted' : 'Test complete') + '! Total time: ' + _trFormatTime(_tr.elapsedSeconds);
        _trEl('tr-footer-note').textContent = note;
        return new Promise(function (resolve, reject) {
            var continueAfterComparison = function () {
                var payload = _trBuildCompletionReportPayload({ aborted: isAborted });
                if (typeof stampOperatorOnTestReportPayload === 'function') {
                    payload = stampOperatorOnTestReportPayload(payload);
                }
                apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
                    .then(function (result) {
                        var reportId = result && result.id;
                        if (reportId && typeof logTestReportSavedAudit === 'function') {
                            logTestReportSavedAudit(reportId, payload);
                        }
                        if (reportId && typeof openReportPreview === 'function') {
                            openReportPreview(reportId, { setGate: true });
                        } else {
                            goToPage('reports');
                        }
                        resolve(reportId || null);
                    })
                    .catch(function (err) {
                        console.error('Failed to save test report', err);
                        showAppModal('Failed to save test report.', 'Report');
                        reject(err);
                    });
            };
            continueAfterComparison();
        });
    });
}

function _trOfferDispenseAfterCompletion() {
    _tr.testFinished = true;
    _tr.abortedRun = false;
    _trSetStatus(1, 'done');
    _trSetStatus(2, 'done');
    return showYesNoModal(
        'The test has been completed. Do you want to dispense?',
        'Test Complete',
        'Dispense',
        'Cancel'
    ).then(function (wantDispense) {
        if (!wantDispense) {
            _trSetButtons('await-dispense');
            _trEl('tr-footer-note').textContent = 'Test complete. Press Dispense when ready.';
            return;
        }
        return trDispenseTest({ aborted: false });
    });
}

function _trCompleteTest() {
    _trStopRunHardwareAndTimers();
    _tr.done = false;
    _trOfferDispenseAfterCompletion();
}

function trExitTestRun() {
    if (_tr && _tr.running) {
        _trConfirmAbortAndDispense().then(function (didAbort) {
            if (!didAbort) return;
            _suppressTestRunNavGuardOnce = true;
            goToPage('home');
        });
        return;
    }
    if (typeof _trCleanupOnLeave === 'function') _trCleanupOnLeave();
    if (_tr && (_tr.initializing || _tr.dispensing || (_tr.testFinished && !_tr.dispenseComplete))) {
        _trDoStop();
    }
    _pendingTestRunReportId = null;
    closeTestRunCompletionApprovalModal();
    _suppressTestRunNavGuardOnce = true;
    goToPage('home');
}

function _trCleanupOnLeave() {
    _pendingTestRunReportId = null;
    closeTestRunCompletionApprovalModal();
    _trInitGeneration += 1;
    _tr.initializing = false;
    _tr.dispensing = false;
    if (_tr.dispenseTimer) {
        clearTimeout(_tr.dispenseTimer);
        _tr.dispenseTimer = null;
    }
    _trEndDispenseSpin();
    clearInterval(_tr.timerInterval);
    clearInterval(_tr.rotationInterval);
    _tr.timerInterval = null;
    _tr.rotationInterval = null;
    if (_tr.running && _tr.useHardware) {
        friabilityHardwareStopWithRetry().catch(function () {});
    }
    stopHardwareLivePoll();
    _trCleanupHardwareStream();
    _tr.running = false;
    _tr.paused = false;
    _tr.useHardware = false;
    _trStopSpin();
}

window.trStartTest = trStartTest;
window.trInitialize = trInitialize;
window.trDispenseTest = trDispenseTest; 
window.trPauseTest = trPauseTest;       
window.trResumeTest = trResumeTest;
window.trStopTest = trStopTest;
window.trExitTestRun = trExitTestRun;
window.trCompleteTest = trCompleteTest;

/* ── System Info ─────────────────────────────────────────────── */
function setSysinfoBath(val) {
    var el = document.getElementById('sysinfo-bath');
    if (!el) return;
    if (val === null || val === undefined || val === '') {
        el.textContent = '—';
        return;
    }
    if (typeof val === 'number') {
        el.textContent = Number(val).toFixed(1) + ' °C';
        return;
    }
    var text = String(val);
    if (/^\d+(\.\d+)?$/.test(text)) text = Number(text).toFixed(1) + ' °C';
    else if (/°C$/i.test(text) && text.indexOf(' ') === -1) text = text.replace(/°C$/i, ' °C');
    el.textContent = text;
}

function _sysinfoTempText(val) {
    if (val === null || val === undefined || val === '') return '—';
    if (typeof val === 'number') return Number(val).toFixed(1) + ' °C';
    var text = String(val);
    if (/^\d+(\.\d+)?$/.test(text)) return Number(text).toFixed(1) + ' °C';
    return text;
}

function setSysinfoStatus(id, val) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = (val === null || val === undefined || val === '') ? '—' : String(val);
}

function setSystemInfoLoading() {
    setSysinfoBath('…');
    ['sysinfo-ext', 'sysinfo-machine-state', 'sysinfo-float-switch', 'sysinfo-heater-sensor', 'sysinfo-pump',
     'sysinfo-sample-collector'].forEach(function (id) {
        setSysinfoStatus(id, '…');
    });
    var errEl = document.getElementById('sysinfo-error');
    if (errEl) {
        errEl.style.display = 'none';
        errEl.textContent = '';
    }
}

function applySystemInfoData(data) {
    data = data || {};
    var temps = data.temps || {};
    var bath = data.bath || data.bath_c;
    if (bath == null && temps.bath != null) bath = temps.bath;
    setSysinfoBath(bath);
    setSysinfoStatus('sysinfo-ext', _sysinfoTempText(temps.external != null ? temps.external : temps.ext));
    var stateText = data.machineState || data.runStatus || '—';
    if (data.stepCurrent != null && data.stepTotal != null) {
        stateText = String(stateText) + '  ·  Step ' + data.stepCurrent + '/' + data.stepTotal;
    } else if (data.remainingTime) {
        stateText = String(stateText) + '  ·  ' + data.remainingTime;
    }
    setSysinfoStatus('sysinfo-machine-state', stateText);
    setSysinfoStatus('sysinfo-float-switch', data.float_switch);
    setSysinfoStatus('sysinfo-heater-sensor', data.heater_sensor);
    setSysinfoStatus('sysinfo-pump', data.pump);
    setSysinfoStatus('sysinfo-sample-collector', data.sample_collector || data.collector);
    var errEl = document.getElementById('sysinfo-error');
    if (errEl) {
        if (data.error) {
            errEl.textContent = String(data.error);
            errEl.style.display = '';
        } else {
            errEl.textContent = '';
            errEl.style.display = 'none';
        }
    }
}

function loadSystemInfo() {
    setSystemInfoLoading();
    if (typeof apiRequest !== 'function') {
        applySystemInfoData({ error: 'API unavailable' });
        return;
    }
    apiRequest(API_BASE + '/api/system/info', { method: 'GET' })
        .then(function (data) {
            applySystemInfoData(data || {});
        })
        .catch(function (err) {
            applySystemInfoData({
                error: (err && err.message) ? err.message : 'Unable to load system info'
            });
        });
}

function initSystemInfoPage() {
    loadSystemInfo();
    if (typeof window.dissoArmAutoTemp === 'function') {
        window.dissoArmAutoTemp('system-info');
    }
}

var _hwInitAborted = false;
var _hwInitBusy = false;

function cleanupHardwareInitOnLeave() {
    _hwInitAborted = true;
    _hwInitBusy = false;
}

function openHardwareInitPage() {
    if (typeof isDissolutionTestActive === 'function' && isDissolutionTestActive()) {
        showAppModal('Finish or abort the dissolution test before initialising hardware.', 'Hardware Initialise');
        return;
    }
    goToPage('hardware-init');
}

/* ── Settings heater control ─────────────────────────────────── */
var _heaterCtrlOn = false;
var _heaterCtrlBusy = false;
var _heaterCtrlAborted = false;
var _heaterCtrlPollId = null;

function cleanupHeaterControlOnLeave() {
    _heaterCtrlAborted = true;
    _heaterCtrlBusy = false;
    if (_heaterCtrlPollId) {
        clearInterval(_heaterCtrlPollId);
        _heaterCtrlPollId = null;
    }
    if (typeof window.dissoDisarmAutoTemp === 'function') {
        window.dissoDisarmAutoTemp('leave-heater-control');
    }
}

function openHeaterControlPage() {
    if (typeof isDissolutionTestActive === 'function' && isDissolutionTestActive()) {
        showAppModal('Finish or abort the dissolution test before using manual heater control.', 'Heater');
        return;
    }
    goToPage('heater-control');
}

function _heaterCtrlReadTemp() {
    var el = document.getElementById('heater-ctrl-temp');
    if (!el) return NaN;
    return parseFloat(String(el.value || '').trim());
}

function _heaterCtrlValidateTemp() {
    var t = _heaterCtrlReadTemp();
    if (isNaN(t) || t < 20 || t > 50) {
        showAppModal('Enter a set temperature between 20 and 50 °C.', 'Heater');
        return null;
    }
    return Math.round(t * 10) / 10;
}

function _heaterCtrlSetStatus(text, state) {
    var el = document.getElementById('heater-ctrl-status');
    if (!el) return;
    el.textContent = text || '';
    el.classList.remove('is-busy', 'is-ok', 'is-fail');
    if (state) el.classList.add('is-' + state);
}

function _heaterCtrlSetUiOn(on) {
    _heaterCtrlOn = !!on;
    var visual = document.getElementById('heater-ctrl-visual');
    var stateEl = document.getElementById('heater-ctrl-state');
    var offBtn = document.getElementById('heater-ctrl-off');
    var onBtn = document.getElementById('heater-ctrl-on');
    if (visual) visual.setAttribute('data-on', _heaterCtrlOn ? 'true' : 'false');
    if (stateEl) stateEl.textContent = _heaterCtrlOn ? 'On' : 'Off';
    if (offBtn) {
        offBtn.classList.toggle('is-active', !_heaterCtrlOn);
        offBtn.setAttribute('aria-pressed', !_heaterCtrlOn ? 'true' : 'false');
    }
    if (onBtn) {
        onBtn.classList.toggle('is-active', _heaterCtrlOn);
        onBtn.setAttribute('aria-pressed', _heaterCtrlOn ? 'true' : 'false');
    }
}

function _heaterCtrlSetBusy(busy) {
    _heaterCtrlBusy = !!busy;
    var applyBtn = document.getElementById('heater-ctrl-apply-btn');
    var offBtn = document.getElementById('heater-ctrl-off');
    var onBtn = document.getElementById('heater-ctrl-on');
    if (applyBtn) applyBtn.disabled = !!busy;
    if (offBtn) offBtn.disabled = !!busy;
    if (onBtn) onBtn.disabled = !!busy;
}

function _heaterCtrlUpdateBath(data) {
    var bathEl = document.getElementById('heater-ctrl-bath');
    if (!bathEl) return;
    var bath = data && (data.bath != null ? data.bath : data.bathTemp);
    if (bath == null || bath === '' || isNaN(parseFloat(bath))) {
        bathEl.textContent = '—';
        return;
    }
    bathEl.textContent = parseFloat(bath).toFixed(1) + ' °C';
}

function _heaterCtrlPollBath() {
    if (typeof window.dissoFetchTemps !== 'function') return;
    window.dissoFetchTemps().then(function (data) {
        if (_heaterCtrlAborted) return;
        _heaterCtrlUpdateBath(data);
    }).catch(function () {});
}

function initHeaterControlPage() {
    _heaterCtrlAborted = false;
    _heaterCtrlBusy = false;
    _heaterCtrlSetUiOn(false);
    _heaterCtrlSetStatus('Set temperature, then turn the heater ON to send commands to the ESP.');
    var tempEl = document.getElementById('heater-ctrl-temp');
    if (tempEl && !String(tempEl.value || '').trim()) tempEl.value = '37.0';
    if (_heaterCtrlPollId) clearInterval(_heaterCtrlPollId);
    _heaterCtrlPollBath();
    _heaterCtrlPollId = setInterval(_heaterCtrlPollBath, 2000);
    if (typeof window.dissoArmAutoTemp === 'function') {
        window.dissoArmAutoTemp('heater-control');
    }
}

function applyHeaterControlTemp() {
    if (_heaterCtrlBusy) return;
    var t = _heaterCtrlValidateTemp();
    if (t == null) return;
    if (typeof window.dissoSetTemp !== 'function') {
        showAppModal('Heater API unavailable.', 'Heater');
        return;
    }
    _heaterCtrlSetBusy(true);
    _heaterCtrlSetStatus('Sending #SET-TEMP-' + t.toFixed(1) + '* …', 'busy');
    window.dissoSetTemp(t).then(function () {
        if (_heaterCtrlAborted) return;
        _heaterCtrlSetBusy(false);
        _heaterCtrlSetStatus('Set temperature ' + t.toFixed(1) + ' °C acknowledged by ESP.', 'ok');
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Heater set temp', t.toFixed(1) + ' C', {
                eventType: 'lifecycle', entityType: 'settings'
            });
        }
    }).catch(function (err) {
        if (_heaterCtrlAborted) return;
        _heaterCtrlSetBusy(false);
        var msg = (err && err.message) ? String(err.message) : 'Set temperature failed';
        _heaterCtrlSetStatus(msg, 'fail');
        showAppModal(msg, 'Heater');
    });
}

function setHeaterControlPower(on) {
    if (_heaterCtrlBusy) return;
    if (typeof isDissolutionTestActive === 'function' && isDissolutionTestActive()) {
        showAppModal('Finish or abort the dissolution test before using manual heater control.', 'Heater');
        return;
    }
    if (on) {
        var t = _heaterCtrlValidateTemp();
        if (t == null) return;
        if (typeof window.dissoHeaterOn !== 'function') {
            showAppModal('Heater API unavailable.', 'Heater');
            return;
        }
        _heaterCtrlSetBusy(true);
        _heaterCtrlSetStatus('Sending SET-TEMP + PRE-HEAT …', 'busy');
        window.dissoHeaterOn(t, { waitDone: false }).then(function () {
            if (_heaterCtrlAborted) return;
            _heaterCtrlSetBusy(false);
            _heaterCtrlSetUiOn(true);
            _heaterCtrlSetStatus('Heater ON — heating to ' + t.toFixed(1) + ' °C.', 'ok');
            if (typeof logAuditEvent === 'function') {
                logAuditEvent('Heater on', 'SET-TEMP ' + t.toFixed(1) + ' + PRE-HEAT', {
                    eventType: 'lifecycle', entityType: 'settings'
                });
            }
        }).catch(function (err) {
            if (_heaterCtrlAborted) return;
            _heaterCtrlSetBusy(false);
            _heaterCtrlSetUiOn(false);
            var msg = (err && err.message) ? String(err.message) : 'Heater on failed';
            _heaterCtrlSetStatus(msg, 'fail');
            showAppModal(msg, 'Heater');
        });
        return;
    }
    if (typeof window.dissoHeaterOff !== 'function') {
        showAppModal('Heater API unavailable.', 'Heater');
        return;
    }
    _heaterCtrlSetBusy(true);
    _heaterCtrlSetStatus('Sending #STOP-HEAT* …', 'busy');
    window.dissoHeaterOff().then(function () {
        if (_heaterCtrlAborted) return;
        _heaterCtrlSetBusy(false);
        _heaterCtrlSetUiOn(false);
        _heaterCtrlSetStatus('Heater OFF.', 'ok');
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Heater off', 'STOP-HEAT', {
                eventType: 'lifecycle', entityType: 'settings'
            });
        }
    }).catch(function (err) {
        if (_heaterCtrlAborted) return;
        _heaterCtrlSetBusy(false);
        var msg = (err && err.message) ? String(err.message) : 'Heater off failed';
        _heaterCtrlSetStatus(msg, 'fail');
        showAppModal(msg, 'Heater');
    });
}

function _hwInitSetUi(phaseText, detailText, opts) {
    opts = opts || {};
    var phase = document.getElementById('hw-init-phase');
    var detail = document.getElementById('hw-init-detail');
    var startBtn = document.getElementById('hw-init-start-btn');
    var doneBtn = document.getElementById('hw-init-done-btn');
    var band = document.getElementById('hw-init-status-band');
    if (phase) phase.textContent = phaseText || 'Ready';
    if (detail) detail.textContent = detailText || '';
    if (band) {
        band.classList.toggle('is-busy', !!opts.busy);
        band.classList.toggle('is-ok', !!opts.ok);
        band.classList.toggle('is-fail', !!opts.fail);
    }
    if (startBtn) startBtn.disabled = !!opts.disableStart;
    if (doneBtn) doneBtn.disabled = opts.enableDone ? false : true;
}

function initHardwareInitPage() {
    _hwInitAborted = false;
    _hwInitBusy = false;
    _hwInitSetUi('Ready', 'Press Initialize to send #INIT* to the ESP.', {
        disableStart: false,
        enableDone: false
    });
}

function startHardwareInitialise() {
    if (_hwInitBusy) return;
    if (typeof isDissolutionTestActive === 'function' && isDissolutionTestActive()) {
        showAppModal('Finish or abort the dissolution test before initialising hardware.', 'Hardware Initialise');
        return;
    }
    _hwInitBusy = true;
    _hwInitAborted = false;
    _hwInitSetUi('Initializing…', 'Waiting for #INIT,ACK* from ESP.', {
        busy: true,
        disableStart: true,
        enableDone: false
    });
    if (typeof apiRequest !== 'function') {
        _hwInitBusy = false;
        _hwInitSetUi('Failed', 'API unavailable', { fail: true, disableStart: false, enableDone: true });
        return;
    }
    apiRequest(API_BASE + '/api/hardware/disso/init', { method: 'POST', body: {} })
        .then(function (result) {
            if (_hwInitAborted) return;
            _hwInitBusy = false;
            if (result && result.ok !== false && !result.error) {
                _hwInitSetUi('Initialized', 'Initialisation done.', {
                    ok: true,
                    disableStart: false,
                    enableDone: true
                });
                if (typeof logAuditEvent === 'function') {
                    logAuditEvent('Hardware initialised', 'INIT ACK', {
                        eventType: 'lifecycle', entityType: 'settings'
                    });
                }
            } else {
                _hwInitSetUi('Failed', (result && result.error) || 'Hardware initialise failed.', {
                    fail: true,
                    disableStart: false,
                    enableDone: true
                });
            }
        })
        .catch(function (err) {
            if (_hwInitAborted) return;
            _hwInitBusy = false;
            var msg = (err && err.message) ? err.message : 'Hardware initialise request failed.';
            if (err && err.body && err.body.error) msg = err.body.error;
            _hwInitSetUi('Failed', msg, { fail: true, disableStart: false, enableDone: true });
        });
}

function confirmHardwareInitialise() {
    openHardwareInitPage();
}

/* ── Cleaning Cycle ──────────────────────────────────────────── */
var _cleaningRunning = false;

function getCleaningCycleInputs() {
    var volEl = document.getElementById('cleaning-sample-volume');
    var cycEl = document.getElementById('cleaning-cycle-count');
    var volume = volEl ? parseFloat(String(volEl.value || '').trim()) : NaN;
    var cycles = cycEl ? parseInt(String(cycEl.value || '').trim(), 10) : NaN;
    return { volume: volume, cycles: cycles, volEl: volEl, cycEl: cycEl };
}

function initCleaningCyclePage() {
    _cleaningRunning = false;
    updateCleaningUI();
}

function updateCleaningUI() {
    var startBtn = document.getElementById('cleaning-start-btn');
    var banner = document.getElementById('cleaning-status-banner');
    var statusTxt = document.getElementById('cleaning-status-text');
    var inputs = getCleaningCycleInputs();

    if (inputs.volEl) inputs.volEl.disabled = _cleaningRunning;
    if (inputs.cycEl) inputs.cycEl.disabled = _cleaningRunning;

    if (startBtn) {
        startBtn.disabled = false;
        if (_cleaningRunning) {
            startBtn.textContent = 'Stop Cleaning';
            startBtn.classList.add('is-stop');
            startBtn.classList.remove('btn-primary');
            startBtn.classList.add('btn-danger');
        } else {
            startBtn.textContent = 'Start Cleaning';
            startBtn.classList.remove('is-stop', 'btn-danger');
            startBtn.classList.add('btn-primary');
        }
    }

    if (banner) banner.classList.toggle('is-running', _cleaningRunning);
    if (statusTxt) {
        if (_cleaningRunning) {
            var volTxt = isNaN(inputs.volume) ? '—' : String(inputs.volume);
            var cycTxt = isNaN(inputs.cycles) ? '—' : String(inputs.cycles);
            statusTxt.textContent = 'Cleaning in progress — ' + volTxt + ' mL, ' + cycTxt + ' cycle(s).';
        } else {
            statusTxt.textContent = 'Enter volume and cycles, then start.';
        }
    }
}

function cleaningCyclePrimaryAction() {
    if (_cleaningRunning) stopCleaningCycle();
    else startCleaningCycle();
}

function startCleaningCycle() {
    if (_cleaningRunning) return;

    var inputs = getCleaningCycleInputs();
    if (isNaN(inputs.volume) || inputs.volume <= 0) {
        if (typeof showAppModal === 'function') {
            showAppModal('Please enter cleaning sample volume.', 'Cleaning Cycle');
        }
        return;
    }
    if (isNaN(inputs.cycles) || inputs.cycles < 1) {
        if (typeof showAppModal === 'function') {
            showAppModal('Please enter number of cycles.', 'Cleaning Cycle');
        }
        return;
    }

    _cleaningRunning = true;
    updateCleaningUI();

    if (typeof logAuditEvent === 'function') {
        logAuditEvent(
            'Cleaning cycle started',
            inputs.volume + ' mL × ' + inputs.cycles,
            {
                eventType: 'lifecycle',
                entityType: 'settings',
                extra: { sampleVolume: inputs.volume, cycles: inputs.cycles }
            }
        );
    }

    if (typeof apiRequest !== 'function') return;
    apiRequest(API_BASE + '/api/hardware/command', {
        method: 'POST',
        body: {
            command: 'cleaning,start,' + inputs.volume + ',' + inputs.cycles
        }
    }).catch(function () { /* hardware not wired yet */ });
}

function stopCleaningCycle() {
    if (!_cleaningRunning) return;
    _cleaningRunning = false;
    updateCleaningUI();

    if (typeof logAuditEvent === 'function') {
        logAuditEvent('Cleaning cycle stopped', 'Stop', {
            eventType: 'lifecycle', entityType: 'settings'
        });
    }

    if (typeof apiRequest !== 'function') return;
    apiRequest(API_BASE + '/api/hardware/command', {
        method: 'POST',
        body: { command: 'cleaning,stop' }
    }).catch(function () { /* hardware not wired yet */ });
}

/* ── IP Config (LAN / WLAN, no sign-in) ──────────────────────── */

function _escapeIpConfigureText(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _renderIpConfigureList(payload) {
    var listEl = document.getElementById('ip-configure-list');
    if (!listEl) return;
    if (!payload || payload.ok === false) {
        var errMsg = (payload && (payload.error || payload.message))
            ? (payload.error || payload.message)
            : 'Could not load network information.';
        listEl.innerHTML = '<div class="ip-configure-error">' + _escapeIpConfigureText(errMsg) + '</div>';
        return;
    }
    var wlan = payload.wlan != null && payload.wlan !== '' ? String(payload.wlan) : null;
    var lan = payload.lan != null && payload.lan !== '' ? String(payload.lan) : null;
    if (!wlan && !lan) {
        listEl.innerHTML = '<div class="ip-configure-empty">No IP address found. Check that this device is connected to the LAN or WLAN.</div>';
        return;
    }
    var rows = [
        { label: 'WLAN', address: wlan || '—' },
        { label: 'LAN', address: lan || '—' }
    ];
    var html = '';
    rows.forEach(function (row) {
        html += '<div class="ip-configure-row">' +
            '<span class="ip-configure-iface">' + _escapeIpConfigureText(row.label) + '</span>' +
            '<span class="ip-configure-address">' + _escapeIpConfigureText(row.address) + '</span>' +
            '</div>';
    });
    listEl.innerHTML = html;
}

function refreshIpConfigureAddresses() {
    var listEl = document.getElementById('ip-configure-list');
    var refreshBtn = document.querySelector('.btn-refresh-ip-configure');
    if (listEl) {
        listEl.innerHTML = '<div class="ip-configure-loading">Loading addresses…</div>';
    }
    if (refreshBtn) refreshBtn.disabled = true;
    fetch((API_BASE || '') + '/api/system/network-addresses')
        .then(function (res) {
            return res.json().catch(function () { return { ok: false, error: 'Invalid response from server.' }; })
                .then(function (data) {
                    if (!res.ok && data && !data.error) {
                        data.ok = false;
                        data.error = data.error || ('Request failed (' + res.status + ').');
                    }
                    return data;
                });
        })
        .then(function (data) {
            _renderIpConfigureList(data);
        })
        .catch(function () {
            _renderIpConfigureList({ ok: false, error: 'Could not reach the device network service.' });
        })
        .finally(function () {
            if (refreshBtn) refreshBtn.disabled = false;
        });
}

function initIpConfigPage() {
    refreshIpConfigureAddresses();
}

function initIpConfigResultPage() {
    goToPage('ip-config');
}

/* ── Temperature Calibration ─────────────────────────────────── */
var _tempCalLiveTimer = null;
var _tempCalRunning = false;
var TEMP_CAL_MIN = 15;
var TEMP_CAL_MAX = 55;
var TEMP_CAL_VESSEL_COUNT = 6;

function stopTemperatureCalibrationLive() {
    if (_tempCalLiveTimer != null) {
        clearInterval(_tempCalLiveTimer);
        _tempCalLiveTimer = null;
    }
}

function formatTempCalDisplay(value) {
    if (value == null || isNaN(value)) return '--.- °C';
    return Number(value).toFixed(1) + ' °C';
}

function setTempCalCurrentDisplay(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = formatTempCalDisplay(value);
}

function setTempCalStatus(text, state) {
    var el = document.getElementById('temp-cal-status');
    if (!el) return;
    el.textContent = text || 'Ready';
    el.classList.remove('is-running', 'is-success', 'is-error');
    if (state) el.classList.add(state);
}

function applyTemperatureCalibrationLive(data) {
    if (!data) return;
    var bath = (data.bath != null && !isNaN(Number(data.bath))) ? Number(data.bath) : null;
    setTempCalCurrentDisplay('temp-cal-bath-current', bath);
    var external = null;
    if (data.external != null && !isNaN(Number(data.external))) {
        external = Number(data.external);
    } else {
        var vesselsForExternal = Array.isArray(data.vessels) ? data.vessels : [];
        for (var e = 0; e < vesselsForExternal.length; e++) {
            if (vesselsForExternal[e] != null && !isNaN(Number(vesselsForExternal[e]))) {
                external = Number(vesselsForExternal[e]);
                break;
            }
        }
    }
    setTempCalCurrentDisplay('temp-cal-external-current', external);
    var vessels = Array.isArray(data.vessels) ? data.vessels : [];
    for (var i = 0; i < TEMP_CAL_VESSEL_COUNT; i++) {
        var v = vessels[i];
        var num = (v != null && !isNaN(Number(v))) ? Number(v) : null;
        setTempValLiveDisplay('temp-cal-v' + (i + 1) + '-live', num);
    }
}

function buildTemperatureCalibrationVesselRows() {
    var grid = document.getElementById('temp-cal-vessel-grid');
    if (!grid || grid.children.length > 0) return;
    var html = '';
    for (var i = 1; i <= TEMP_CAL_VESSEL_COUNT; i++) {
        html +=
            '<div class="temp-val-vessel" data-vessel="' + i + '">' +
                '<div class="temp-val-vessel-label">Vessel ' + i + '</div>' +
                '<div class="temp-val-vessel-art">' +
                    '<img src="assets/vessel.svg" alt="" class="temp-val-vessel-img" draggable="false">' +
                    '<div class="temp-val-vessel-temp" id="temp-cal-v' + i + '-live" aria-live="polite">--.- °C</div>' +
                '</div>' +
                '<div class="temp-cal-vessel-actual">' +
                    '<span class="temp-val-live-label">Actual (°C)</span>' +
                    '<input type="number" id="temp-cal-v' + i + '-actual" class="input-field"' +
                        ' min="15" max="55" step="0.1" inputmode="decimal" placeholder="e.g. 37.0"' +
                        ' aria-label="Vessel ' + i + ' actual temperature degrees Celsius"' +
                        ' onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)">' +
                '</div>' +
            '</div>';
    }
    grid.innerHTML = html;
}

function refreshTemperatureCalibrationLive() {
    if (typeof fetchTemperatureHardwareLive !== 'function') return Promise.resolve();
    return fetchTemperatureHardwareLive().then(function (data) {
        applyTemperatureCalibrationLive(data || {});
        return data;
    }).catch(function () {
        return null;
    });
}

function getTempCalActualValue(inputId) {
    var el = document.getElementById(inputId);
    return el ? parseFloat(String(el.value || '').trim()) : NaN;
}

function updateTemperatureCalibrationUI() {
    var btn = document.getElementById('temp-cal-btn');
    var bathInput = document.getElementById('temp-cal-bath-actual');
    var extInput = document.getElementById('temp-cal-external-actual');
    if (btn) btn.disabled = _tempCalRunning;
    if (bathInput) bathInput.disabled = _tempCalRunning;
    if (extInput) extInput.disabled = _tempCalRunning;
    for (var i = 1; i <= TEMP_CAL_VESSEL_COUNT; i++) {
        var vesselInput = document.getElementById('temp-cal-v' + i + '-actual');
        if (vesselInput) vesselInput.disabled = _tempCalRunning;
    }
}

function initTemperatureCalibrationPage() {
    buildTemperatureCalibrationVesselRows();
    _tempCalRunning = false;
    updateTemperatureCalibrationUI();
    setTempCalStatus('Ready', null);
    stopTemperatureCalibrationLive();
    refreshTemperatureCalibrationLive();
    _tempCalLiveTimer = setInterval(function () {
        if (typeof getActivePageName === 'function' && getActivePageName() !== 'calibration') {
            stopTemperatureCalibrationLive();
            return;
        }
        refreshTemperatureCalibrationLive();
    }, 2000);
}

function buildTemperatureCalibrationReportPayload(opts) {
    opts = opts || {};
    var user = window.currentUser || {};
    var nowIso = (typeof getDisplayedKioskDateTimeIso === 'function')
        ? getDisplayedKioskDateTimeIso()
        : new Date().toISOString();
    var startIso = opts.startedAt || nowIso;
    var channels = opts.channels || [];
    var aborted = !!opts.aborted;
    var statusLabel = aborted ? 'Aborted' : 'Completed';
    var reportPayload = {
        name: 'Temperature Calibration - ' + statusLabel,
        type: 'calibration',
        calibrationSubtype: 'temperature',
        status: statusLabel,
        calibrationStartTime: startIso,
        calibrationEndTime: nowIso,
        createdAt: nowIso,
        completedAt: nowIso,
        temperatureChannels: channels,
        testData: {
            calibrationSubtype: 'temperature',
            status: statusLabel,
            aborted: aborted,
            calibrationStartTime: startIso,
            calibrationEndTime: nowIso,
            testStartTime: startIso,
            testEndTime: nowIso,
            temperatureChannels: channels,
            operatorName: user.name || user.username || '--',
            employeeId: user.username || '--',
            operatorUsername: user.username || '--',
            createdAt: nowIso,
            completedAt: nowIso
        }
    };
    if (typeof stampOperatorOnTestReportPayload === 'function') {
        return stampOperatorOnTestReportPayload(reportPayload);
    }
    return reportPayload;
}

function saveTemperatureCalibrationReportAndOpenPreview(opts) {
    var payload = buildTemperatureCalibrationReportPayload(opts);
    if (!payload) return Promise.resolve(null);
    currentReportFilter = 'calibration';
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            var reportId = result && result.id;
            if (!reportId) {
                goToPage('reports');
                return null;
            }
            if (typeof logTestReportSavedAudit === 'function') logTestReportSavedAudit(reportId, payload);
            if (typeof openPendingReportPreview === 'function') openPendingReportPreview(reportId);
            else if (typeof openReportPreview === 'function') openReportPreview(reportId, { setGate: true });
            else goToPage('reports');
            return reportId;
        })
        .catch(function (err) {
            console.error('Failed to save temperature calibration report', err);
            showAppModal(
                (opts && opts.aborted ? 'Calibration aborted' : 'Calibration completed') +
                ' but saving the report failed.',
                'Calibration'
            );
            return null;
        });
}

function _sendDissoTempCalTarget(target, value) {
    return apiRequest(API_BASE + '/api/hardware/disso/cal/temp', {
        method: 'POST',
        body: { target: target, value: value }
    }).then(function (result) {
        if (!result || result.ok === false || result.error) {
            var err = new Error((result && result.error) || ('Calibration failed for ' + target));
            err.result = result;
            throw err;
        }
        return result;
    });
}

function runTemperatureCalibration() {
    if (_tempCalRunning) return;
    var bathActual = getTempCalActualValue('temp-cal-bath-actual');
    var externalActual = getTempCalActualValue('temp-cal-external-actual');
    function isValidTemp(val) {
        return !isNaN(val) && val >= TEMP_CAL_MIN && val <= TEMP_CAL_MAX;
    }
    if (!isValidTemp(bathActual) || !isValidTemp(externalActual)) {
        if (typeof showAppModal === 'function') {
            showAppModal(
                'Please enter Actual temperatures between ' + TEMP_CAL_MIN + ' and ' + TEMP_CAL_MAX +
                ' °C for Bath and External only.',
                'Calibration'
            );
        }
        return;
    }

    _tempCalRunning = true;
    updateTemperatureCalibrationUI();
    setTempCalStatus('Calibrating…', 'is-running');

    var bathTxt = bathActual.toFixed(1);
    var externalTxt = externalActual.toFixed(1);
    var startedAt = (typeof getDisplayedKioskDateTimeIso === 'function')
        ? getDisplayedKioskDateTimeIso()
        : new Date().toISOString();

    if (typeof logAuditEvent === 'function') {
        logAuditEvent(
            'Temperature calibration started',
            'Bath ' + bathTxt + ' °C, External ' + externalTxt + ' °C',
            {
                eventType: 'lifecycle',
                entityType: 'calibration',
                extra: {
                    bathActual: bathActual,
                    externalActual: externalActual
                }
            }
        );
    }

    if (typeof apiRequest !== 'function') {
        _tempCalRunning = false;
        updateTemperatureCalibrationUI();
        setTempCalStatus('Calibration command sent (offline).', 'is-success');
        return;
    }

    var liveSnapshot = null;
    refreshTemperatureCalibrationLive().then(function (data) {
        liveSnapshot = data || {};
        return _sendDissoTempCalTarget('BT', bathActual);
    }).then(function () {
        return _sendDissoTempCalTarget('EXT', externalActual);
    }).then(function () {
        _tempCalRunning = false;
        updateTemperatureCalibrationUI();
        setTempCalStatus('Calibration completed successfully.', 'is-success');
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Temperature calibration completed', bathTxt + ' / ' + externalTxt + ' °C', {
                eventType: 'lifecycle',
                entityType: 'calibration'
            });
        }
        var liveBath = liveSnapshot && liveSnapshot.bath != null ? Number(liveSnapshot.bath) : null;
        var liveExt = liveSnapshot && liveSnapshot.external != null ? Number(liveSnapshot.external) : null;
        var channels = [
            { label: 'Bath', live: liveBath, actual: bathActual, reference: bathActual },
            { label: 'External', live: liveExt, actual: externalActual, reference: externalActual }
        ];
        refreshTemperatureCalibrationLive();
        return saveTemperatureCalibrationReportAndOpenPreview({
            startedAt: startedAt,
            channels: channels
        });
    }).catch(function (err) {
        _tempCalRunning = false;
        updateTemperatureCalibrationUI();
        var msg = (err && err.message) ? err.message : 'Calibration request failed. Check hardware connection.';
        setTempCalStatus(msg, 'is-error');
    });
}

/* =========================================================
   DISSOLUTION TEST RUN  (ported from Dissolution 1)
   ========================================================= */

function startTestRun(recipe) {
    if (!recipe) return;
    if (!isDissolutionRecipe(recipe)) {
        showAppModal('Only Dissolution recipes can be loaded for testing.', 'Load Recipe');
        return;
    }
    // Deep-clone so Load Recipe / Quick Test always carry media, AR, batch, steps, etc.
    var runRecipe;
    try {
        runRecipe = JSON.parse(JSON.stringify(recipe));
    } catch (e) {
        runRecipe = Object.assign({}, recipe);
        if (Array.isArray(recipe.steps)) runRecipe.steps = recipe.steps.slice();
    }
    window.activeTestRecipe = runRecipe;
    // Init first so goToPage title/populate can read _dissolutionTest.recipe.
    initDissolutionTestRun(runRecipe);
    goToPage('test-run');
    // Ensure fields bind after the page is active (RBAC / paint race).
    _dtPopulateRunRecipeFields(runRecipe);
    if (_dissolutionTest && _dissolutionTest.steps && _dissolutionTest.steps.length) {
        _dtApplyStep(_dissolutionTest.stepIndex || 0, false);
    }
    setTimeout(function () {
        if (!_dissolutionTest || !_dissolutionTest.recipe) return;
        _dtPopulateRunRecipeFields(_dissolutionTest.recipe);
        if (_dissolutionTest.steps && _dissolutionTest.steps.length) {
            _dtApplyStep(_dissolutionTest.stepIndex || 0, false);
        }
    }, 50);
    // On Load: send SET-TEMP → TS → RPM → DUR → SML → FL → AUTO-DROP (Start only sends START-TEST).
    _dtUploadRecipeToEsp(runRecipe);
}

function _dtUploadRecipeToEsp(recipe) {
    if (typeof window.dissoUploadRecipe !== 'function') {
        if (_dissolutionTest) _dissolutionTest.recipeUploaded = true;
        return;
    }
    _dtSetPrimaryButton('disabled');
    _dtSetStatus('Preparing recipe…', 'ready');
    window.dissoUploadRecipe(recipe).then(function () {
        if (_dissolutionTest) _dissolutionTest.recipeUploaded = true;
        if (_dissolutionTest && !_dissolutionTest.running) {
            _dtResetPreheatUi();
        }
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('ESP recipe uploaded', (recipe.productName || recipe.name || 'Recipe') + ' loaded to ESP', {
                eventType: 'lifecycle'
            });
        }
        _dtSetStatus('Press Preheat when ready.', 'ready');
    }).catch(function () {
        // Silent product UX: no protocol / ESP error modal. Allow retry via Preheat/Start path.
        if (_dissolutionTest) _dissolutionTest.recipeUploaded = false;
        _dtResetPreheatUi();
        _dtSetStatus('Press Preheat when ready.', 'ready');
        // One quiet retry
        setTimeout(function () {
            if (!_dissolutionTest || _dissolutionTest.recipeUploaded || _dissolutionTest.running) return;
            window.dissoUploadRecipe(recipe).then(function () {
                if (_dissolutionTest) _dissolutionTest.recipeUploaded = true;
                if (_dissolutionTest && !_dissolutionTest.running) _dtResetPreheatUi();
                _dtSetStatus('Press Preheat when ready.', 'ready');
            }).catch(function () {});
        }, 1500);
    });
}

var _dissolutionTest = null;

function _dtStopTimer() {
    if (_dissolutionTest && _dissolutionTest.timerId != null) {
        clearInterval(_dissolutionTest.timerId);
        _dissolutionTest.timerId = null;
    }
}

function _dtEl(id) { return document.getElementById(id); }

function _dtSetText(id, text) {
    var el = _dtEl(id);
    if (el) el.textContent = text != null ? String(text) : '--';
}

/** Push recipe identity + run params into the test-run DOM (AR/batch/media/etc.). */
function _dtPopulateRunRecipeFields(recipe) {
    recipe = recipe || {};
    var usp = recipe.usp || recipe.uspMode || '';
    var recipeName = recipe.productName || recipe.name || '--';
    var hiddenName = document.getElementById('dt-recipe-name');
    if (hiddenName) hiddenName.textContent = recipeName;

    _dtSetText('dt-batch-number', recipe.batchNumber || recipe.batchNumber1 || '--');
    _dtSetText('dt-batch-size', recipe.batchSize != null && String(recipe.batchSize).trim() !== '' ? recipe.batchSize : '--');
    _dtSetText('dt-mode', recipe.mode || '--');
    _dtSetText('dt-usp', usp || '--');
    _dtSetText('dt-ar-number', recipe.arNumber || '--');
    _dtSetText('dt-media', recipe.media || '--');
    _dtSetText('dt-media-volume', _dtFormatMediaVolume(recipe.mediaVolume));
    _dtSetText('dt-media-ph', recipe.mediaPh != null && recipe.mediaPh !== '' ? recipe.mediaPh : '--');
    _dtSetText('dt-replenishment', recipe.replenishment != null && String(recipe.replenishment).trim() !== '' ? recipe.replenishment : '--');
    _dtSetText('dt-power-failure', _dtFormatPowerFailValue(recipe.powerFailure));
    _dtSetText('dt-temperature', _dtFormatTemp(recipe.temperature));
    _dtSetText('dt-sample-volume', _dtFormatVolume(recipe.sampleVolume));
    _dtSetText('dt-rinse-volume', _dtFormatVolume(recipe.rinseVolume));
}

function _dtFormatTemp(val) {
    if (val == null || val === '') return '--';
    var n = parseFloat(val);
    if (isNaN(n)) return String(val);
    // Unit (°C) lives in the HTML span beside #dt-temperature.
    return n.toFixed(1);
}

function _dtFormatRpm(val) {
    if (val == null || val === '') return '--';
    var n = parseFloat(val);
    if (isNaN(n)) return String(val);
    // Unit (rpm) lives in the HTML span beside #dt-rpm.
    return String(Math.round(n * 10) / 10);
}

function _dtFormatPowerFailValue(val) {
    var n = parseInt(val, 10);
    if (isNaN(n) || n < 1) return '--';
    // Unit (min) lives in the HTML span beside #dt-power-failure.
    return String(n);
}

function _dtFormatVolume(val) {
    if (val == null || val === '') return '--';
    var s = String(val).trim();
    if (!s) return '--';
    var n = parseFloat(s);
    if (isNaN(n)) return s;
    return n.toFixed(1);
}

function _dtFormatMediaVolume(val) {
    if (val == null || val === '') return '--';
    var s = String(val).trim();
    if (!s) return '--';
    if (/ml/i.test(s)) return s;
    var n = parseFloat(s);
    if (isNaN(n)) return s;
    return ((Math.abs(n % 1) < 1e-9) ? String(Math.round(n)) : String(n)) + ' mL';
}

window._dtPopulateRunRecipeFields = _dtPopulateRunRecipeFields;

function _dtFormatHms(sec) {
    if (typeof formatSecondsAsHhMmSs === 'function') return formatSecondsAsHhMmSs(sec);
    var n = Math.max(0, parseInt(sec, 10) || 0);
    var hh = Math.floor(n / 3600);
    var mm = Math.floor((n % 3600) / 60);
    var ss = n % 60;
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
}

function _dtSetStatus(message, state) {
    var banner = _dtEl('dt-status-banner');
    if (banner) {
        banner.textContent = message || '';
        banner.className = 'dt-status-banner' + (state ? (' is-' + state) : '');
        banner.hidden = true;
        banner.setAttribute('aria-hidden', 'true');
    }
    var msg = _dtEl('dt-status-msg');
    if (msg) msg.textContent = message || '';
    var runState = _dtEl('dt-run-state');
    if (runState) {
        var label = 'Ready';
        if (state === 'running') label = 'Running';
        else if (state === 'paused') label = 'Paused';
        else if (state === 'done') label = 'Completed';
        else if (state === 'aborted') label = 'Aborted';
        runState.textContent = label;
        runState.className = 'dt-run-state' + (state ? (' is-' + state) : '');
    }
    _dtSyncEquipVisuals();
}

function _dtSyncEquipVisuals() {
    var dt = _dissolutionTest;
    // Heater + circulation pump stay on from preheat start through end/abort.
    var thermalOn = !!(dt && (
        dt.running || dt.paused || dt.preheating || dt.heaterForcedOn ||
        (dt.preheatDone && dt.needsPreheat)
    ));
    var heaterOn = thermalOn;
    var pumpOn = thermalOn;
    var step = dt && dt.steps && dt.steps[dt.stepIndex] ? dt.steps[dt.stepIndex] : null;
    var rpm = step && step.rpm != null ? parseFloat(step.rpm) : 0;
    if (isNaN(rpm)) rpm = 0;
    var stirrerOn = !!(dt && dt.running && !dt.paused && rpm > 0);

    var heaterEl = _dtEl('dt-heater-equip');
    var heaterLabel = _dtEl('dt-heater-label');
    if (heaterEl) {
        heaterEl.classList.toggle('is-on', heaterOn);
        heaterEl.classList.toggle('is-off', !heaterOn);
        heaterEl.setAttribute('data-on', heaterOn ? 'true' : 'false');
    }
    if (heaterLabel) {
        heaterLabel.textContent = (dt && dt.preheating) ? 'Preheating' : (heaterOn ? 'On' : 'Off');
    }
    var pumpEl = _dtEl('dt-pump-equip');
    var pumpLabel = _dtEl('dt-pump-label');
    if (pumpEl) {
        pumpEl.classList.toggle('is-on', pumpOn);
        pumpEl.classList.toggle('is-off', !pumpOn);
        pumpEl.setAttribute('data-on', pumpOn ? 'true' : 'false');
    }
    if (pumpLabel) pumpLabel.textContent = pumpOn ? 'On' : 'Off';
    var paddleEl = _dtEl('dt-paddle-equip');
    var paddleLabel = _dtEl('dt-paddle-label');
    var rotor = _dtEl('dt-paddle-rotor');
    if (paddleEl) {
        paddleEl.classList.toggle('is-on', stirrerOn);
        paddleEl.classList.toggle('is-off', !stirrerOn);
        paddleEl.setAttribute('data-on', stirrerOn ? 'true' : 'false');
    }
    if (paddleLabel) {
        paddleLabel.textContent = stirrerOn ? ('On' + (rpm ? ' · ' + rpm + ' RPM' : '')) : 'Off';
    }
    var stirrerSvg = paddleEl ? paddleEl.querySelector('.dt-equipment-icon svg') : null;
    if (stirrerSvg) {
        var rotSec = stirrerOn ? Math.max(0.45, Math.min(2.2, 90 / Math.max(rpm, 25))) : 0;
        stirrerSvg.style.animationDuration = rotSec ? (rotSec + 's') : '';
    }
    if (rotor) {
        var rotorSec = stirrerOn ? Math.max(0.45, Math.min(2.2, 90 / Math.max(rpm, 25))) : 0;
        rotor.style.animationDuration = rotorSec ? (rotorSec + 's') : '';
    }
}

function _dtStopPreheatTimer() {
    var dt = _dissolutionTest;
    if (dt && dt.preheatTimerId != null) { clearTimeout(dt.preheatTimerId); dt.preheatTimerId = null; }
}

function _dtClearThermalFlags() {
    var dt = _dissolutionTest;
    if (!dt) return;
    dt.heaterForcedOn = false;
    dt.preheating = false;
    _dtSyncEquipVisuals();
}

function _dtResetPreheatUi() {
    var dt = _dissolutionTest;
    var preheatBtn = _dtEl('dt-preheat-btn');
    if (preheatBtn) preheatBtn.style.display = 'none';
    if (!dt) return;
    if (dt.running || dt.paused) {
        _dtSyncEquipVisuals();
        return;
    }
    if (dt.preheating) {
        _dtSetPrimaryButton('preheating');
    } else if (!dt.preheatDone) {
        _dtSetPrimaryButton(dt.recipeUploaded === false ? 'disabled' : 'preheat');
    } else {
        _dtSetPrimaryButton('start');
    }
    _dtSyncEquipVisuals();
}

function dissolutionPreheatStart() {
    var dt = _dissolutionTest;
    if (!dt || dt.preheatDone || dt.preheating || dt.running || dt.paused) return;
    dt.needsPreheat = true;
    dt.preheating = true;
    dt.heaterForcedOn = true;
    _dtSetPrimaryButton('preheating');
    _dtSyncEquipVisuals();
    _dtSyncStirrerLock();
    if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
    if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
    _dtSetStatus('Preheating… waiting for set temperature', 'ready');
    _dtStopPreheatTimer();
    var preheatFn = (typeof window.dissoPreheat === 'function')
        ? window.dissoPreheat
        : null;
    function onPreheatDone() {
        var live = _dissolutionTest;
        if (!live) return;
        live.preheating = false;
        live.preheatDone = true;
        live.heaterForcedOn = true;
        live.preheatTimerId = null;
        _dtSetPrimaryButton('start');
        _dtSyncEquipVisuals();
        _dtSyncStirrerLock();
        if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
        if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
        _dtSetStatus('Preheat complete. Press Start to begin.', 'ready');
        if (typeof window.dissoBeep === 'function') {
            window.dissoBeep(1);
        }
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Preheat complete', 'ESP reached set temperature (PRE-DONE)', { eventType: 'lifecycle' });
        }
    }
    if (!preheatFn) {
        dt.preheatTimerId = setTimeout(onPreheatDone, 8000);
        return;
    }
    preheatFn(180).then(onPreheatDone).catch(function (err) {
        var live = _dissolutionTest;
        if (!live) return;
        live.preheating = false;
        live.preheatDone = false;
        live.heaterForcedOn = false;
        live.preheatTimerId = null;
        _dtSetPrimaryButton('preheat');
        _dtSyncEquipVisuals();
        _dtSyncStirrerLock();
        if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
        if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
        _dtSetStatus('Preheat failed', 'aborted');
        showAppModal((err && err.message) || 'Preheat failed (PRE-HEAT / PRE-DONE).', 'Preheat');
    });
}

function _dtUpdateProgress() {
    var dt = _dissolutionTest;
    var pctEl = _dtEl('dt-progress-pct');
    var fillEl = _dtEl('dt-progress-fill');
    if (!dt || !dt.steps.length) {
        if (pctEl) pctEl.textContent = '0%';
        if (fillEl) fillEl.style.width = '0%';
        return;
    }
    var total = dt.steps.length;
    var done = dt.stepIndex;
    var frac = 0;
    if (dt.setSec > 0) frac = Math.max(0, Math.min(1, (dt.setSec - (dt.remainingSec || 0)) / dt.setSec));
    if (!dt.running && !dt.paused && dt.remainingSec === dt.setSec && dt.stepIndex === 0) frac = 0;
    var pct = Math.round(((done + frac) / total) * 100);
    pct = Math.max(0, Math.min(100, pct));
    if (pctEl) pctEl.textContent = pct + '%';
    if (fillEl) fillEl.style.width = pct + '%';
}

function formatPowerFailureDisplay(val) {
    var n = parseInt(val, 10);
    if (isNaN(n) || n < 1) return '--';
    return n + ' min';
}

function initDissolutionTestRun(recipe) {
    _dtStopPreheatTimer();
    _dtStopTimer();
    _dtClearShaftTimers();
    recipe = recipe || {};
    _dissolutionTest = {
        recipe: recipe,
        steps: Array.isArray(recipe.steps) ? recipe.steps.slice() : [],
        stepIndex: 0,
        remainingSec: 0,
        setSec: 0,
        running: false,
        paused: false,
        timerId: null,
        testStartTime: null,
        reportSaved: false,
        needsPreheat: true,
        preheating: false,
        preheatDone: false,
        preheatTimerId: null,
        heaterForcedOn: false,
        recipeUploaded: false,
        liftPositionBlocked: false,
        tempLog: [],
        shaftUpDisabled: false,
        shaftDownDisabled: false
    };
    window._dissolutionTest = _dissolutionTest;
    window.activeTestRecipe = recipe;

    var recipeName = recipe.productName || recipe.name || '--';
    // Recipe name only in app header — not duplicated inside the test page.
    if (typeof setShellPageTitle === 'function') {
        setShellPageTitle(recipeName);
    } else {
        var titleEl = document.getElementById('header-title') || document.getElementById('page-title');
        if (titleEl) titleEl.textContent = recipeName;
    }
    _dtPopulateRunRecipeFields(recipe);

    _dtApplyStep(0, true);
    _dtSetControlsIdle();
    _dtSetPrimaryButton('disabled');
    _dtSetStatus('Press Preheat to begin.', 'ready');
    _dtResetShaftButtons();
    stirrerUnitCommand('stop');
    // Re-apply after paint — page may still be toggling .active when goToPage runs.
    setTimeout(function () {
        if (_dissolutionTest && _dissolutionTest.recipe) {
            _dtPopulateRunRecipeFields(_dissolutionTest.recipe);
            if (_dissolutionTest.steps && _dissolutionTest.steps.length) {
                _dtApplyStep(_dissolutionTest.stepIndex || 0, false);
            }
        }
    }, 0);
    // UART-2 live vessel temps are shown on the Vessels info page only.
    // Keep server state polling for the run; do not arm temp UI stream for this screen.
    if (typeof window.dissoStartStatePolling === 'function') {
        window.dissoStartStatePolling();
    }
}

function _dtApplyStep(index, resetRemaining) {
    var dt = _dissolutionTest;
    if (!dt) return;
    dt.stepIndex = index;
    var step = dt.steps[index] || {};
    var setSec = parseInt(step.durationSeconds, 10);
    if (isNaN(setSec) || setSec < 1) setSec = 0;
    dt.setSec = setSec;
    if (resetRemaining) dt.remainingSec = setSec;
    var total = dt.steps.length || 0;
    _dtSetText('dt-current-step', (index + 1) + ' / ' + total);
    _dtSetText('dt-rpm', _dtFormatRpm(step.rpm));
    _dtSetText('dt-set-time', _dtFormatHms(setSec));
    _dtSetText('dt-remaining-time', _dtFormatHms(dt.remainingSec));
    _dtSetText('dt-hero-timer', _dtFormatHms(dt.remainingSec));
    _dtUpdateProgress();
    _dtSyncEquipVisuals();
}

function _dtSetPrimaryButton(mode) {
    var startBtn = _dtEl('dt-start-btn');
    if (!startBtn) return;
    startBtn.style.display = '';
    startBtn.classList.remove('dt-start-grey', 'dt-start-ready', 'is-abort', 'dt-start-preheat', 'dt-start-preheating');
    if (mode === 'abort') {
        startBtn.textContent = 'Abort';
        startBtn.disabled = false;
        startBtn.classList.add('is-abort');
        startBtn.setAttribute('data-dt-action', 'abort');
        return;
    }
    if (mode === 'resume') {
        startBtn.textContent = 'Resume';
        startBtn.disabled = false;
        startBtn.classList.add('dt-start-ready');
        startBtn.setAttribute('data-dt-action', 'resume');
        return;
    }
    if (mode === 'preheat') {
        startBtn.textContent = 'Preheat';
        startBtn.disabled = false;
        startBtn.classList.add('dt-start-preheat');
        startBtn.setAttribute('data-dt-action', 'preheat');
        return;
    }
    if (mode === 'preheating') {
        startBtn.textContent = 'Preheating…';
        startBtn.disabled = true;
        startBtn.classList.add('dt-start-preheating');
        startBtn.setAttribute('data-dt-action', 'preheat');
        return;
    }
    if (mode === 'disabled') {
        startBtn.textContent = 'Preheat';
        startBtn.disabled = true;
        startBtn.classList.add('dt-start-grey');
        startBtn.setAttribute('data-dt-action', 'preheat');
        return;
    }
    // ready / start
    startBtn.textContent = 'Start';
    startBtn.disabled = false;
    startBtn.classList.add('dt-start-ready');
    startBtn.setAttribute('data-dt-action', 'start');
}

function _dtSetControlsIdle() {
    var pauseBtn = _dtEl('dt-pause-btn');
    var abortBtn = _dtEl('dt-abort-btn');
    var startBtn = _dtEl('dt-start-btn');
    var preheatBtn = _dtEl('dt-preheat-btn');
    if (preheatBtn) preheatBtn.style.display = 'none';
    if (startBtn) startBtn.style.display = '';
    var dt = _dissolutionTest;
    if (dt && dt.preheatDone) _dtSetPrimaryButton('start');
    else if (dt && dt.preheating) _dtSetPrimaryButton('preheating');
    else _dtSetPrimaryButton('preheat');
    if (pauseBtn) pauseBtn.style.display = 'none';
    if (abortBtn) abortBtn.style.display = 'none';
    _dtSyncStirrerLock();
    if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
    if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
}

function _dtSetControlsRunning() {
    var pauseBtn = _dtEl('dt-pause-btn');
    var abortBtn = _dtEl('dt-abort-btn');
    var startBtn = _dtEl('dt-start-btn');
    var preheatBtn = _dtEl('dt-preheat-btn');
    if (startBtn) startBtn.style.display = 'none';
    if (preheatBtn) preheatBtn.style.display = 'none';
    if (pauseBtn) {
        pauseBtn.style.display = '';
        pauseBtn.disabled = false;
        pauseBtn.textContent = 'Pause';
        pauseBtn.onclick = function () { dissolutionTestPause(); };
    }
    if (abortBtn) {
        abortBtn.style.display = '';
        abortBtn.disabled = false;
        abortBtn.onclick = function () { dissolutionTestAbort(); };
    }
    _dtSyncStirrerLock();
    if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
    if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
}

function _dtSetControlsPaused() {
    var pauseBtn = _dtEl('dt-pause-btn');
    var abortBtn = _dtEl('dt-abort-btn');
    var startBtn = _dtEl('dt-start-btn');
    if (startBtn) startBtn.style.display = 'none';
    if (pauseBtn) {
        pauseBtn.style.display = '';
        pauseBtn.disabled = false;
        pauseBtn.textContent = 'Resume';
        pauseBtn.onclick = function () { dissolutionTestStart(); };
    }
    if (abortBtn) {
        abortBtn.style.display = '';
        abortBtn.disabled = false;
        abortBtn.onclick = function () { dissolutionTestAbort(); };
    }
    _dtSyncStirrerLock();
    if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
    if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
}

function dissolutionTestPrimaryAction() {
    var startBtn = _dtEl('dt-start-btn');
    var action = startBtn ? (startBtn.getAttribute('data-dt-action') || 'start') : 'start';
    if (action === 'abort') {
        dissolutionTestAbort();
        return;
    }
    if (action === 'preheat') {
        dissolutionPreheatStart();
        return;
    }
    dissolutionTestStart();
}

var _stirrerUnitState = 'stop';
var _dtShaftUpTimerId = null;

function _dtClearShaftTimers() {
    if (_dtShaftUpTimerId != null) {
        clearTimeout(_dtShaftUpTimerId);
        _dtShaftUpTimerId = null;
    }
}

function _dtResetShaftButtons() {
    _dtClearShaftTimers();
    var dt = _dissolutionTest;
    if (dt) {
        dt.shaftUpDisabled = false;
        dt.shaftDownDisabled = false;
    }
    ['dt-stirrer-up', 'dt-stirrer-stop', 'dt-stirrer-down'].forEach(function (id) {
        var el = _dtEl(id);
        if (!el) return;
        el.disabled = false;
        el.classList.remove('is-shaft-locked');
    });
    var stopEl = _dtEl('dt-stirrer-stop');
    if (stopEl) stopEl.classList.add('is-active');
    ['dt-stirrer-up', 'dt-stirrer-down'].forEach(function (id) {
        var el = _dtEl(id);
        if (el) el.classList.remove('is-active');
    });
    var statusEl = _dtEl('dt-stirrer-status');
    if (statusEl) statusEl.textContent = 'Stopped';
    _stirrerUnitState = 'stop';
}

function _dtSyncStirrerLock() {
    var dt = _dissolutionTest;
    // Shaft Up/Down/Stop only before start and after abort/complete — not while test is active.
    var locked = !!(dt && (dt.running || dt.paused || dt.preheating));
    ['dt-stirrer-up', 'dt-stirrer-stop', 'dt-stirrer-down'].forEach(function (id) {
        var el = _dtEl(id);
        if (!el) return;
        if (locked) {
            el.disabled = true;
            return;
        }
        if (id === 'dt-stirrer-up' && dt && dt.shaftUpDisabled) {
            el.disabled = true;
            return;
        }
        if (id === 'dt-stirrer-down' && dt && dt.shaftDownDisabled) {
            el.disabled = true;
            return;
        }
        el.disabled = false;
    });
}

function stirrerUnitCommand(cmd) {
    if (cmd !== 'up' && cmd !== 'down' && cmd !== 'stop') return;
    var dt = _dissolutionTest;
    if (dt && (dt.running || dt.paused || dt.preheating)) {
        showAppModal('Shaft controls are unavailable while a test is running or preheating. Abort the test first.', 'Shaft Position');
        return;
    }
    if (cmd === 'up' && dt && dt.shaftUpDisabled) return;
    if (cmd === 'down' && dt && dt.shaftDownDisabled) return;

    _stirrerUnitState = cmd;
    var labels = { up: 'Raising', down: 'Lowering', stop: 'Stopped' };
    var statusEl = _dtEl('dt-stirrer-status');
    if (statusEl) statusEl.textContent = labels[cmd] || 'Stopped';
    var map = { up: 'dt-stirrer-up', stop: 'dt-stirrer-stop', down: 'dt-stirrer-down' };
    Object.keys(map).forEach(function (key) {
        var el = _dtEl(map[key]);
        if (!el) return;
        el.classList.toggle('is-active', key === cmd);
    });
    if (typeof window.dissoLift === 'function') {
        window.dissoLift(cmd).then(function (res) {
            var body = (res && res.body) ? res.body : res;
            var ok = !!(res && res.ok !== false) && !(body && body.ok === false);
            if (!ok) return res;
            if (cmd === 'down') {
                if (dt) {
                    dt.shaftDownDisabled = true;
                    dt.liftPositionBlocked = false;
                }
                var downEl = _dtEl('dt-stirrer-down');
                if (downEl) {
                    downEl.disabled = true;
                    downEl.classList.remove('is-active');
                }
                if (statusEl) statusEl.textContent = 'Down (home)';
                _dtSetStatus('Lifting column lowered. Ready when Preheat/Start is available.', 'ready');
            }
            if (cmd === 'up') {
                _dtClearShaftTimers();
                _dtShaftUpTimerId = setTimeout(function () {
                    _dtShaftUpTimerId = null;
                    if (_dissolutionTest) _dissolutionTest.shaftUpDisabled = true;
                    var upEl = _dtEl('dt-stirrer-up');
                    if (upEl) {
                        upEl.disabled = true;
                        upEl.classList.remove('is-active');
                    }
                    var st = _dtEl('dt-stirrer-status');
                    if (st) st.textContent = 'Up';
                }, 20000);
            }
            if (cmd === 'stop') {
                _dtClearShaftTimers();
            }
            return res;
        }).catch(function () {});
    }
    if (typeof logAuditEvent === 'function') {
        logAuditEvent('Shaft position ' + cmd, 'Shaft command: ' + (labels[cmd] || cmd), { eventType: 'lifecycle' });
    }
}

function dissolutionTestStart() {
    var dt = _dissolutionTest;
    if (!dt || !dt.steps.length) { showAppModal('No recipe steps available.', 'Test'); return; }
    if (dt.needsPreheat && !dt.preheatDone) { showAppModal('Complete Preheat before starting the test.', 'Preheat'); return; }
    if (dt.preheating) { showAppModal('Preheat is still in progress.', 'Preheat'); return; }
    if (dt.running && !dt.paused) return;
    if (!dt.paused && dt.recipeUploaded === false) {
        showAppModal('Recipe is still preparing. Please wait a moment, then try again.', 'Test');
        return;
    }

    // Server-authoritative ESP path
    if (typeof window.dissoResumeTest === 'function' && dt.paused) {
        window.dissoResumeTest().then(function (res) {
            if (!res.ok || !(res.body && res.body.ok)) {
                var msg = (res.body && res.body.error) || 'ESP resume failed';
                if ((res.body && res.body.errorCode) === 'lift_position' || /lift|column|position/i.test(msg)) {
                    dt.liftPositionBlocked = true;
                    _dtSetControlsIdle();
                    msg = 'Lifting column is not in position. Move the lifting column Down using Shaft Position, then press Start again.';
                }
                showAppModal(msg, 'Test');
                return;
            }
            dt.paused = false;
            dt.running = true;
            dt.liftPositionBlocked = false;
            _dtSetControlsRunning();
            _dtSetStatus('Test running…', 'running');
            if (typeof window.dissoStartStatePolling === 'function') window.dissoStartStatePolling();
        });
        return;
    }
    if (typeof window.dissoStartTest === 'function' && !dt.paused) {
        var startBtn = _dtEl('dt-start-btn');
        if (startBtn) startBtn.disabled = true;
        window.dissoStartTest(dt.recipe, {
            arNumber: dt.recipe.arNumber,
            batchNumber: dt.recipe.batchNumber,
            powerFailure: dt.recipe.powerFailure
        }).then(function () {
            dt.running = true;
            dt.paused = false;
            dt.liftPositionBlocked = false;
            if (!dt.testStartTime && typeof getDisplayedKioskDateTimeIso === 'function') {
                dt.testStartTime = getDisplayedKioskDateTimeIso();
            }
            if (!dt.testStartTime) dt.testStartTime = new Date().toISOString();
            _dtSetControlsRunning();
            _dtSetStatus('Test running… Step ' + (dt.stepIndex + 1) + '/' + dt.steps.length, 'running');
            logAuditEvent('Started dissolution test', (dt.recipe.productName || 'Recipe') + ' via ESP', { eventType: 'lifecycle' });
            if (typeof window.dissoStartStatePolling === 'function') window.dissoStartStatePolling();
        }).catch(function (err) {
            if (startBtn) startBtn.disabled = false;
            var msg = (err && err.message) ? err.message : 'Failed to start test on ESP';
            var code = err && err.errorCode;
            if (code === 'lift_position' || /lift|column|position/i.test(msg)) {
                dt.running = false;
                dt.paused = false;
                dt.liftPositionBlocked = true;
                _dtSetControlsIdle();
                msg = 'Lifting column is not in position. Move the lifting column Down using Shaft Position controls, then press Start again.';
            }
            showAppModal(msg, 'Test');
        });
        return;
    }

    // Legacy local timer fallback
    if (dt.paused) {
        dt.paused = false;
        dt.running = true;
        _dtSetControlsRunning();
        _dtSetStatus('Test running… Step ' + (dt.stepIndex + 1) + '/' + dt.steps.length, 'running');
        _dtStartTicker();
        return;
    }
    dt.running = true;
    dt.paused = false;
    if (!dt.testStartTime && typeof getDisplayedKioskDateTimeIso === 'function') {
        dt.testStartTime = getDisplayedKioskDateTimeIso();
    }
    if (!dt.testStartTime) dt.testStartTime = new Date().toISOString();
    if (dt.remainingSec <= 0) _dtApplyStep(dt.stepIndex, true);
    _dtSetControlsRunning();
    _dtSetStatus('Test running… Step ' + (dt.stepIndex + 1) + '/' + dt.steps.length, 'running');
    logAuditEvent('Started dissolution test', (dt.recipe.productName || 'Recipe') + ' step ' + (dt.stepIndex + 1), { eventType: 'lifecycle' });
    _dtStartTicker();
}

function dissolutionTestPause() {
    var dt = _dissolutionTest;
    if (!dt || !dt.running || dt.paused) return;
    if (typeof window.dissoPauseTest === 'function') {
        window.dissoPauseTest().then(function (res) {
            if (!res.ok || !(res.body && res.body.ok)) {
                showAppModal((res.body && res.body.error) || 'ESP pause failed', 'Test');
                return;
            }
            dt.paused = true;
            _dtStopTimer();
            _dtSetControlsPaused();
            _dtSetStatus('Test paused', 'paused');
        });
        return;
    }
    dt.paused = true;
    _dtStopTimer();
    _dtSetControlsPaused();
    _dtSetStatus('Test paused', 'paused');
}

function _dtAppendTempLogSample() {
    var dt = _dissolutionTest;
    if (!dt || !dt.running) return;
    if (!Array.isArray(dt.tempLog)) dt.tempLog = [];
    var recipe = dt.recipe || {};
    var setTemp = (recipe.temperature != null && !isNaN(Number(recipe.temperature)))
        ? Number(recipe.temperature) : null;
    var step = dt.steps && dt.steps[dt.stepIndex] ? dt.steps[dt.stepIndex] : null;
    var rpm = step && step.rpm != null ? step.rpm : null;
    var nowIso = typeof getDisplayedKioskDateTimeIso === 'function'
        ? getDisplayedKioskDateTimeIso()
        : new Date().toISOString();
    var timeStr = nowIso;
    try {
        var d = new Date(nowIso);
        if (!isNaN(d.getTime())) {
            var hh = String(d.getHours()).padStart(2, '0');
            var mi = String(d.getMinutes()).padStart(2, '0');
            var ss = String(d.getSeconds()).padStart(2, '0');
            timeStr = hh + ':' + mi + ':' + ss;
        }
    } catch (e) {}

    function pushSample(bathTemp) {
        var bath = (bathTemp != null && !isNaN(Number(bathTemp))) ? Number(bathTemp) : null;
        var deviation = (bath != null && setTemp != null) ? Math.round((bath - setTemp) * 100) / 100 : null;
        dt.tempLog.push({
            time: timeStr,
            rpm: rpm,
            setTemp: setTemp,
            bathTemp: bath != null ? Math.round(bath * 100) / 100 : null,
            deviation: deviation
        });
        if (dt.tempLog.length > 3600) dt.tempLog.shift();
    }

    if (typeof window.dissoFetchTemps === 'function') {
        window.dissoFetchTemps(true).then(function (data) {
            if (!_dissolutionTest) return;
            pushSample(data && data.bath);
        }).catch(function () {
            pushSample(null);
        });
    } else {
        pushSample(null);
    }
}

function _dtStartTicker() {
    var dt = _dissolutionTest;
    if (!dt) return;
    _dtStopTimer();
    dt.timerId = setInterval(function () {
        if (!_dissolutionTest || !_dissolutionTest.running || _dissolutionTest.paused) return;
        _dissolutionTest.remainingSec = Math.max(0, (_dissolutionTest.remainingSec || 0) - 1);
        var remHms = _dtFormatHms(_dissolutionTest.remainingSec);
        _dtSetText('dt-remaining-time', remHms);
        _dtSetText('dt-hero-timer', remHms);
        _dtUpdateProgress();
        _dtAppendTempLogSample();
        if (_dissolutionTest.remainingSec <= 0) _dtOnStepComplete();
    }, 1000);
}

function _dtOnStepComplete() {
    var dt = _dissolutionTest;
    if (!dt) return;
    var next = dt.stepIndex + 1;
    if (next < dt.steps.length) {
        _dtApplyStep(next, true);
        _dtSetStatus('Running… Step ' + (next + 1) + '/' + dt.steps.length, 'running');
        return;
    }
    _dtStopTimer();
    dt.running = false;
    dt.paused = false;
    dt.preheating = false;
    dt.preheatDone = false;
    _dtClearThermalFlags();
    _dtResetShaftButtons();
    _dtSetControlsIdle();
    _dtSetPrimaryButton('disabled');
    var pctEl = _dtEl('dt-progress-pct');
    var fillEl = _dtEl('dt-progress-fill');
    if (pctEl) pctEl.textContent = '100%';
    if (fillEl) fillEl.style.width = '100%';
    _dtSetStatus('Test completed', 'done');
    logAuditEvent('Completed dissolution test', (dt.recipe.productName || 'Recipe') + ' finished', { eventType: 'lifecycle' });
    if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
    _dtSaveCompletionReport({ aborted: false });
}

function _dtBuildStepResults(isAborted) {
    var dt = _dissolutionTest;
    if (!dt || !dt.steps || !dt.steps.length) return [];
    return dt.steps.map(function (step, i) {
        var status = 'Completed';
        if (isAborted) {
            if (i < dt.stepIndex) status = 'Completed';
            else if (i === dt.stepIndex) status = 'Aborted';
            else status = 'Not run';
        }
        var durSec = parseInt(step.durationSeconds, 10) || 0;
        var durHms = step.durationHms || _dtFormatHms(durSec);
        return { step: i + 1, rpm: step.rpm, durationSeconds: durSec, durationHms: durHms, setTime: durHms, status: status };
    });
}

function _dtBuildCompletionReportPayload(opts) {
    opts = opts || {};
    var isAborted = !!opts.aborted;
    var dt = _dissolutionTest;
    if (!dt) return null;
    var recipe = dt.recipe || {};
    var nowIso = typeof getDisplayedKioskDateTimeIso === 'function' ? getDisplayedKioskDateTimeIso() : new Date().toISOString();
    var stepResults = _dtBuildStepResults(isAborted);
    var elapsed = 0;
    if (dt.testStartTime) {
        elapsed = Math.max(0, Math.floor((new Date(nowIso).getTime() - new Date(dt.testStartTime).getTime()) / 1000));
    } else {
        stepResults.forEach(function (s) { if (s.status === 'Completed' && s.durationSeconds) elapsed += parseInt(s.durationSeconds, 10) || 0; });
    }
    var detailParts = [];
    if (recipe.mode) detailParts.push('Sample Drop: ' + recipe.mode);
    if (recipe.usp || recipe.uspMode) detailParts.push('USP: ' + (recipe.usp || recipe.uspMode));
    if (recipe.temperature != null) detailParts.push('Temp: ' + recipe.temperature + ' °C');
    if (recipe.media) detailParts.push('Media: ' + recipe.media);
    if (recipe.mediaVolume) detailParts.push('Media volume: ' + recipe.mediaVolume);
    if (recipe.mediaPh != null) detailParts.push('Media pH: ' + recipe.mediaPh);
    if (recipe.sampleVolume) detailParts.push('Sample: ' + recipe.sampleVolume);
    if (recipe.rinseVolume) detailParts.push('Rinse: ' + recipe.rinseVolume);
    if (recipe.batchSize) detailParts.push('Batch size: ' + recipe.batchSize);
    if (recipe.arNumber) detailParts.push('AR: ' + recipe.arNumber);
    if (recipe.replenishment != null) detailParts.push('Replenishment: ' + recipe.replenishment);
    if (recipe.powerFailure != null) detailParts.push('Power Failure: ' + formatPowerFailureDisplay(recipe.powerFailure));
    var runDetails = (isAborted ? 'Aborted run. ' : '') + detailParts.join(', ');
    var completedSteps = isAborted ? Math.max(0, dt.stepIndex) : dt.steps.length;
    var tempLog = Array.isArray(dt.tempLog) ? dt.tempLog.slice() : [];
    return {
        name: 'Dissolution Test - ' + (recipe.productName || recipe.name || 'Recipe') + (isAborted ? ' (Aborted)' : ''),
        type: 'test',
        status: isAborted ? 'Aborted' : 'Completed',
        createdAt: nowIso,
        completedAt: nowIso,
        recipe: recipe,
        remarks: '',
        testData: {
            recipe: recipe,
            productName: recipe.productName || recipe.name || '--',
            batchNumber: recipe.batchNumber || recipe.batchNumber1 || '--',
            mode: recipe.mode,
            usp: recipe.usp || recipe.uspMode,
            uspMode: recipe.usp || recipe.uspMode,
            temperature: recipe.temperature,
            media: recipe.media || recipe.mediaVolume,
            mediaVolume: recipe.mediaVolume,
            mediaPh: recipe.mediaPh,
            autoDispense: (String(recipe.mode || '').toLowerCase() === 'auto') || !!recipe.autoDispense,
            sampleVolume: recipe.sampleVolume,
            rinseVolume: recipe.rinseVolume,
            batchSize: recipe.batchSize,
            arNumber: recipe.arNumber,
            replenishment: recipe.replenishment,
            powerFailure: recipe.powerFailure,
            steps: dt.steps,
            stepResults: stepResults,
            tempLog: tempLog,
            stepCount: dt.steps.length,
            completedSteps: completedSteps,
            durationSeconds: elapsed,
            testStartTime: dt.testStartTime || (typeof subtractSecondsFromIso === 'function' ? subtractSecondsFromIso(nowIso, elapsed) : nowIso),
            testEndTime: nowIso,
            status: isAborted ? 'aborted' : 'completed',
            runDetails: runDetails
        }
    };
}

function _dtSaveCompletionReport(opts) {
    opts = opts || {};
    var dt = _dissolutionTest;
    if (!dt || dt.reportSaved) return Promise.resolve(null);
    var payload = _dtBuildCompletionReportPayload(opts);
    if (!payload) return Promise.resolve(null);
    if (typeof stampOperatorOnTestReportPayload === 'function') payload = stampOperatorOnTestReportPayload(payload);
    currentReportFilter = 'test';
    return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
        .then(function (result) {
            var reportId = result && result.id;
            dt.reportSaved = true;
            if (reportId != null) {
                if (opts.aborted) {
                    if (typeof auditTestRunAborted === 'function') auditTestRunAborted('User aborted dissolution test');
                } else {
                    if (typeof auditTestRunFinished === 'function') auditTestRunFinished(reportId);
                }
                if (typeof logTestReportSavedAudit === 'function') logTestReportSavedAudit(reportId, payload);
                if (!opts.skipPreview) {
                    if (typeof finishTestRunReportSaved === 'function') finishTestRunReportSaved(reportId);
                }
                return reportId;
            }
            showAppModal((opts.aborted ? 'Test aborted' : 'Test completed') + ', but report id was not returned.', 'Report');
            return null;
        })
        .catch(function (err) {
            var msg = (err && err.message) ? String(err.message) : 'Unknown error';
            showAppModal((opts.aborted ? 'Test aborted' : 'Test completed') + ', but report could not be saved: ' + msg, 'Report');
            return null;
        });
}

function _dtPerformAbort(opts) {
    opts = opts || {};
    var live = _dissolutionTest;
    if (!live || live._aborting) return Promise.resolve(null);
    live._aborting = true;
    _dtStopTimer();
    _dtStopPreheatTimer();
    live.running = false;
    live.paused = false;
    live.preheating = false;
    live.preheatDone = false;
    _dtClearThermalFlags();
    _dtResetShaftButtons();
    _dtApplyStep(live.stepIndex, true);
    _dtSetControlsIdle();
    _dtSetStatus('Test aborted', 'aborted');
    logAuditEvent('Aborted dissolution test', (live.recipe.productName || 'Recipe') + ' aborted', { eventType: 'lifecycle' });
    if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
    if (typeof window.dissoAbortTest === 'function') {
        return window.dissoAbortTest().then(function (res) {
            if (typeof window.dissoStopStatePolling === 'function') window.dissoStopStatePolling();
            live.reportSaved = true;
            var rid = res && res.body && res.body.reportId;
            if (rid && !opts.skipPreview && typeof finishTestRunReportSaved === 'function') {
                finishTestRunReportSaved(rid);
            }
            return rid;
        }).catch(function () {
            return _dtSaveCompletionReport({ aborted: true, skipPreview: !!opts.skipPreview });
        }).finally(function () {
            if (_dissolutionTest) _dissolutionTest._aborting = false;
        });
    }
    return _dtSaveCompletionReport({ aborted: true, skipPreview: !!opts.skipPreview }).finally(function () {
        if (_dissolutionTest) _dissolutionTest._aborting = false;
    });
}

function dissolutionTestAbort() {
    var dt = _dissolutionTest;
    if (!dt || dt._aborting) return;
    showYesNoModal('Abort the dissolution test? The run will be saved as aborted.', 'Abort Test', 'Abort', 'Cancel')
        .then(function (ok) { if (ok) _dtPerformAbort(); });
}

function dissolutionTestBack() {
    if (typeof isDissolutionTestActive === 'function' && isDissolutionTestActive()) {
        _dtConfirmAbortForNavigation().then(function (didAbort) {
            if (!didAbort) return;
            _suppressTestRunNavGuardOnce = true;
            goToPage('home');
        });
        return;
    }
    if (typeof hasReturnableDissolutionSession === 'function' && hasReturnableDissolutionSession()) {
        goToPage('home');
        return;
    }
    _dtStopTimer();
    _dtStopPreheatTimer();
    _dtClearThermalFlags();
    _dtClearShaftTimers();
    if (_dissolutionTest) {
        _dissolutionTest.running = false;
        _dissolutionTest.paused = false;
        _dissolutionTest.preheating = false;
        _dissolutionTest.preheatDone = false;
    }
    if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
    goToPage('home');
}

function cleanupDissolutionTestOnLeave() {
    _dtStopPreheatTimer();
    _dtStopTimer();
    _dtClearShaftTimers();
    _dtClearThermalFlags();
    if (_dissolutionTest) {
        _dissolutionTest.running = false;
        _dissolutionTest.paused = false;
        _dissolutionTest.preheating = false;
        _dissolutionTest.preheatDone = false;
        _dissolutionTest.heaterForcedOn = false;
    }
    if (typeof window.dissoDisarmAutoTemp === 'function') {
        window.dissoDisarmAutoTemp('leave-test-run');
    }
    if (typeof window.dissoStopStatePolling === 'function') {
        window.dissoStopStatePolling();
    }
    if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
    if (typeof refreshHomeTestScreenCard === 'function') refreshHomeTestScreenCard();
}

var _vesselTempReturnPage = 'test-run';
/** Per-vessel UART-2 stats: current = live, max/min from observed live samples. */
var _vtTempStats = null;
var _vtBathExt = { bath: null, external: null };

function _vtResetTempStats() {
    _vtTempStats = [];
    for (var i = 0; i < 6; i++) {
        _vtTempStats.push({ current: null, max: null, min: null });
    }
    _vtBathExt = { bath: null, external: null };
}

function _vtFmt(v) {
    if (v == null || isNaN(Number(v))) return '—';
    return Number(v).toFixed(1);
}

function _vtUpdateStatsFromLive(live) {
    if (!_vtTempStats) _vtResetTempStats();
    live = live || {};
    if (live.bath != null && !isNaN(Number(live.bath))) _vtBathExt.bath = Number(live.bath);
    var ext = live.external != null ? live.external : live.ext;
    if (ext != null && !isNaN(Number(ext))) _vtBathExt.external = Number(ext);
    var vessels = Array.isArray(live.vessels) ? live.vessels : [];
    for (var i = 0; i < 6; i++) {
        if (vessels[i] == null || isNaN(Number(vessels[i]))) continue;
        var cur = Number(vessels[i]);
        var st = _vtTempStats[i];
        st.current = cur;
        st.max = (st.max == null) ? cur : Math.max(st.max, cur);
        st.min = (st.min == null) ? cur : Math.min(st.min, cur);
    }
}

function openShaftPositionPage() {
    goToPage('shaft-position');
}

function closeShaftPositionPage() {
    goToPage('test-run');
}

function openVesselTemperaturePage(returnPage) {
    var from = String(returnPage || '').trim();
    if (!from) {
        var active = typeof getActivePageName === 'function' ? getActivePageName() : '';
        from = (active === 'system-info') ? 'system-info' : 'test-run';
    }
    _vesselTempReturnPage = (from === 'system-info') ? 'system-info' : 'test-run';
    _vtResetTempStats();
    if (typeof renderVesselTemperaturePage === 'function') renderVesselTemperaturePage();
    goToPage('vessel-temperature');
    if (typeof window.dissoArmAutoTemp === 'function') {
        window.dissoArmAutoTemp('vessel-temperature');
    }
    if (typeof window.dissoFetchTemps === 'function') {
        window.dissoFetchTemps(true).then(function (data) {
            if (data) {
                _vtUpdateStatsFromLive(data);
                if (typeof renderVesselTemperaturePage === 'function') renderVesselTemperaturePage(data);
            }
        }).catch(function () {});
    }
}

function closeVesselTemperaturePage() {
    if (_vesselTempReturnPage !== 'test-run' && typeof window.dissoDisarmAutoTemp === 'function') {
        window.dissoDisarmAutoTemp('leave-vessel-temperature');
    }
    goToPage(_vesselTempReturnPage || 'test-run');
}

function renderVesselTemperaturePage(live) {
    if (live) _vtUpdateStatsFromLive(live);
    if (!_vtTempStats) _vtResetTempStats();

    var setpoint = (_dissolutionTest && _dissolutionTest.recipe && _dissolutionTest.recipe.temperature)
        ? parseFloat(_dissolutionTest.recipe.temperature)
        : NaN;
    var warnDelta = 0.5;

    var bathEl = document.getElementById('vt-bath-temp');
    if (bathEl) {
        bathEl.textContent = _vtBathExt.bath != null ? (_vtFmt(_vtBathExt.bath) + ' °C') : '—';
    }
    var extEl = document.getElementById('vt-ext-temp');
    if (extEl) {
        extEl.textContent = _vtBathExt.external != null ? (_vtFmt(_vtBathExt.external) + ' °C') : '—';
    }

    var highId = null, lowId = null, highVal = -Infinity, lowVal = Infinity;
    var vessels = [];
    for (var i = 0; i < 6; i++) {
        var st = _vtTempStats[i] || { current: null, max: null, min: null };
        var cur = st.current;
        vessels.push({
            id: i + 1,
            current: cur,
            max: st.max,
            min: st.min
        });
        if (cur != null && !isNaN(cur)) {
            if (cur > highVal) { highVal = cur; highId = i + 1; }
            if (cur < lowVal) { lowVal = cur; lowId = i + 1; }
        }
    }

    var vesselTones = {
        1: { main: '#38bdf8', deep: '#0284c7', glow: '#7dd3fc' },
        2: { main: '#f87171', deep: '#dc2626', glow: '#fca5a5' },
        3: { main: '#fb923c', deep: '#ea580c', glow: '#fdba74' },
        4: { main: '#facc15', deep: '#ca8a04', glow: '#fde047' },
        5: { main: '#4ade80', deep: '#16a34a', glow: '#86efac' },
        6: { main: '#22d3ee', deep: '#0891b2', glow: '#67e8f9' }
    };

    function _vtVesselIconSvg(id) {
        var tone = vesselTones[id] || vesselTones[1];
        var gid = 'vt' + id;
        return (
            '<svg class="vt-vessel-svg" viewBox="0 0 64 88" aria-hidden="true">' +
                '<defs>' +
                    '<linearGradient id="' + gid + '-glass" x1="12" y1="14" x2="52" y2="14" gradientUnits="userSpaceOnUse">' +
                        '<stop offset="0%" stop-color="#94a3b8" stop-opacity="0.35"/>' +
                        '<stop offset="35%" stop-color="#f8fafc" stop-opacity="0.55"/>' +
                        '<stop offset="70%" stop-color="#e2e8f0" stop-opacity="0.28"/>' +
                        '<stop offset="100%" stop-color="#64748b" stop-opacity="0.4"/>' +
                    '</linearGradient>' +
                    '<linearGradient id="' + gid + '-liq" x1="32" y1="40" x2="32" y2="78" gradientUnits="userSpaceOnUse">' +
                        '<stop offset="0%" stop-color="' + tone.glow + '"/>' +
                        '<stop offset="55%" stop-color="' + tone.main + '"/>' +
                        '<stop offset="100%" stop-color="' + tone.deep + '"/>' +
                    '</linearGradient>' +
                    '<linearGradient id="' + gid + '-rim" x1="8" y1="10" x2="56" y2="18" gradientUnits="userSpaceOnUse">' +
                        '<stop offset="0%" stop-color="#64748b"/>' +
                        '<stop offset="45%" stop-color="#f1f5f9"/>' +
                        '<stop offset="100%" stop-color="#475569"/>' +
                    '</linearGradient>' +
                    '<clipPath id="' + gid + '-clip">' +
                        '<path d="M18 20 V58 C18 72 24 78 32 78 C40 78 46 72 46 58 V20 Z"/>' +
                    '</clipPath>' +
                '</defs>' +
                // outer glass body
                '<path d="M18 20 V58 C18 72 24 78 32 78 C40 78 46 72 46 58 V20 Z" ' +
                    'fill="url(#' + gid + '-glass)" stroke="#cbd5e1" stroke-width="1.6" stroke-linejoin="round"/>' +
                // liquid fill
                '<g clip-path="url(#' + gid + '-clip)">' +
                    '<path d="M18 42 V58 C18 72 24 78 32 78 C40 78 46 72 46 58 V42 Z" fill="url(#' + gid + '-liq)"/>' +
                    '<ellipse cx="32" cy="42" rx="14" ry="3.2" fill="' + tone.glow + '" opacity="0.95"/>' +
                    '<ellipse cx="32" cy="41" rx="8" ry="1.4" fill="#ffffff" opacity="0.35"/>' +
                '</g>' +
                // flared rim
                '<ellipse cx="32" cy="16" rx="20" ry="5.5" fill="url(#' + gid + '-rim)" stroke="#94a3b8" stroke-width="1.4"/>' +
                '<ellipse cx="32" cy="14.5" rx="14" ry="3.2" fill="#f8fafc" opacity="0.55"/>' +
                // glass highlight
                '<path d="M23 24 V60" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" opacity="0.45"/>' +
                '<path d="M41 26 V58" stroke="#94a3b8" stroke-width="1.4" stroke-linecap="round" opacity="0.35"/>' +
            '</svg>'
        );
    }

    vessels.forEach(function (v) {
        var el = document.getElementById('vt-vessel-' + v.id);
        if (!el) return;
        var hasCur = v.current != null && !isNaN(v.current);
        var maxV = v.max != null ? v.max : v.current;
        var minV = v.min != null ? v.min : v.current;
        var deltaText = '—';
        if (hasCur && !isNaN(setpoint)) {
            var d = Math.round((v.current - setpoint) * 10) / 10;
            deltaText = (d > 0 ? '+' : '') + d.toFixed(1);
        } else if (hasCur && maxV != null && minV != null) {
            deltaText = (Math.round((maxV - minV) * 10) / 10).toFixed(1);
        }
        var warn = hasCur && !isNaN(setpoint) && Math.abs(v.current - setpoint) > warnDelta;
        el.classList.toggle('is-warn', !!warn);
        el.classList.toggle('is-high', hasCur && v.id === highId);
        el.classList.toggle('is-low', hasCur && v.id === lowId);
        el.classList.toggle('is-live', !!hasCur);
        el.innerHTML =
            '<div class="vt-vessel-top">' +
                '<span class="vt-badge">V' + v.id + '</span>' +
                '<span class="vt-live-pill' + (hasCur ? ' is-on' : '') + '">' +
                    '<span class="vt-live-dot" aria-hidden="true"></span>LIVE' +
                '</span>' +
            '</div>' +
            '<div class="vt-vessel-body">' +
                '<div class="vt-vessel-icon-wrap">' + _vtVesselIconSvg(v.id) + '</div>' +
                '<div class="vt-live-block">' +
                    '<span class="vt-live-label">LIVE</span>' +
                    '<div class="vt-temp-row">' +
                        '<span class="vt-temp-value">' + _vtFmt(v.current) + '</span>' +
                        (hasCur ? '<span class="vt-temp-unit">°C</span>' : '') +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="vt-meta">' +
                '<div class="vt-meta-item"><span class="vt-meta-key">MAX</span><span class="vt-meta-val">' +
                    (maxV != null && !isNaN(maxV) ? (_vtFmt(maxV) + ' °C') : '—') +
                '</span></div>' +
                '<div class="vt-meta-item"><span class="vt-meta-key">MIN</span><span class="vt-meta-val">' +
                    (minV != null && !isNaN(minV) ? (_vtFmt(minV) + ' °C') : '—') +
                '</span></div>' +
                '<div class="vt-meta-item"><span class="vt-meta-key">Δ</span><span class="vt-meta-val">' +
                    (deltaText === '—' ? '—' : (deltaText + ' °C')) +
                '</span></div>' +
            '</div>';
    });
}

