/**
 * Dissolution combined validation suite + redesigned temp/SV/calibration flows.
 * Loaded after script.js — overrides entry points used by the Validate menu.
 */
(function (global) {
    'use strict';

    var SUITE_ORDER_BASE = ['rpm', 'physical', 'sample-volume', 'temperature'];
    var HOLD_SEC = 180;
    function getTempTol() {
        var t = (typeof TEMP_VAL_TOLERANCE === 'number') ? TEMP_VAL_TOLERANCE : ((typeof global.TEMP_VAL_TOLERANCE === 'number') ? global.TEMP_VAL_TOLERANCE : 0.5);
        return t;
    }
    var TEMP_TOL = getTempTol();
    var SV_ENT_TIMEOUT_MS = 60000;

    var _tempValPhase = 'idle'; // idle | holding | measure
    var _tempValHoldTimer = null;
    var _tempValHoldLeft = HOLD_SEC;
    var _tempValSnapshot = { bath: null, external: null };
    var _tempValLive = { bath: null, external: null };

    var _tempCalPhase = 'idle'; // idle | holding | ready
    var _tempCalHoldTimer = null;
    var _tempCalHoldLeft = HOLD_SEC;
    var _tempCalLive = { bath: null, external: null };
    var _tempCalSnapshot = { bath: null, external: null };

    var _svPhase = 'idle'; // idle | waiting-ent | modal
    var _svPollTimer = null;
    var _svEntDeadline = 0;

    function nowIso() {
        return (typeof getDisplayedKioskDateTimeIso === 'function')
            ? getDisplayedKioskDateTimeIso()
            : new Date().toISOString();
    }

    function fmtHold(sec) {
        var s = Math.max(0, Math.floor(sec));
        var m = Math.floor(s / 60);
        var r = s % 60;
        return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
    }

    function isSuiteActive() {
        var s = global._validationSuite;
        return !!(s && s.active && !s.aborted);
    }

    function rotateOrder(entryKind) {
        var base = SUITE_ORDER_BASE.slice();
        var idx = base.indexOf(entryKind);
        if (idx < 0) idx = 0;
        return base.slice(idx).concat(base.slice(0, idx));
    }

    function pageForKind(kind) {
        if (kind === 'temperature') return 'temperature-validation';
        if (kind === 'rpm') return 'rpm-validation';
        if (kind === 'physical') return 'physical-parameters';
        if (kind === 'sample-volume') return 'sample-volume-validation';
        return 'validate-type-select';
    }

    function procedureForKind(kind, onContinue) {
        if (kind === 'temperature' && typeof showProcedureModal === 'function') {
            showProcedureModal('Validation Procedure',
                (typeof PROCEDURE_VALIDATION_THERMOMETER !== 'undefined') ? PROCEDURE_VALIDATION_THERMOMETER : ['Follow temperature validation procedure.'],
                onContinue);
            return;
        }
        if (kind === 'rpm' && typeof showProcedureModal === 'function') {
            showProcedureModal('Validation Procedure',
                (typeof PROCEDURE_VALIDATION_TACHOMETER !== 'undefined') ? PROCEDURE_VALIDATION_TACHOMETER : ['Follow RPM validation procedure.'],
                onContinue);
            return;
        }
        onContinue();
    }

    function openKindScreen(kind) {
        procedureForKind(kind, function () {
            goToPage(pageForKind(kind));
        });
    }

    function startValidationSuite(kind) {
        if (kind === 'temperature' || kind === 'rpm' || kind === 'physical' || kind === 'sample-volume') {
            /* ok */
        } else {
            showAppModal('Unknown validation type.', 'Validation');
            return;
        }
        if (isSuiteActive()) {
            showAppModal('A validation suite is already in progress. Abort it first or finish all steps.', 'Validation');
            return;
        }
        global._validationSuite = {
            active: true,
            aborted: false,
            entryKind: kind,
            order: rotateOrder(kind),
            index: 0,
            results: {},
            startedAt: nowIso()
        };
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Validation suite started', 'Entry: ' + kind, { eventType: 'validation' });
        }
        if (typeof applyValidationSuiteLockUi === 'function') applyValidationSuiteLockUi();
        openKindScreen(kind);
    }

    function buildAbortedSuiteValidationPayload(suite) {
        var s = suite || {};
        var r = s.results || {};
        var rpm = r.rpm || {};
        var phys = r.physical || {};
        var sv = r.sampleVolume || r['sample-volume'] || {};
        var temp = r.temperature || {};
        var completedAt = nowIso();
        var completedKinds = Object.keys(r);
        var validationRuns = [];
        if (rpm && (rpm.target != null || rpm.tachometer != null || rpm.pass != null)) {
            validationRuns.push({
                validationSubtype: 'rpm',
                status: rpm.pass === false ? 'Fail' : (rpm.target != null ? 'Pass' : 'Incomplete'),
                rpm: rpm.target,
                currentRpm: rpm.tachometer,
                tachometerRpm: rpm.tachometer,
                delta: rpm.delta,
                validationStartTime: rpm.startedAt || s.startedAt,
                validationEndTime: rpm.completedAt || completedAt
            });
        }
        if (phys && phys.acknowledged) {
            validationRuns.push({
                validationSubtype: 'physical',
                status: 'Pass',
                acknowledged: true,
                validationStartTime: phys.completedAt || s.startedAt,
                validationEndTime: phys.completedAt || completedAt
            });
        }
        if (sv && (sv.measured != null || sv.pass != null)) {
            validationRuns.push({
                validationSubtype: 'sample_volume',
                status: sv.pass ? 'Pass' : 'Fail',
                sampleVolumeTarget: sv.target,
                sampleVolumeTolerance: sv.tolerance,
                sampleVolumeMeasured: sv.measured,
                delta: sv.delta,
                sampleVolumePass: !!sv.pass,
                validationStartTime: sv.startedAt || s.startedAt,
                validationEndTime: sv.completedAt || completedAt
            });
        }
        if (temp && (temp.channels || temp.allPass != null || temp.bath != null)) {
            validationRuns.push({
                validationSubtype: 'temperature',
                status: temp.allPass ? 'Pass' : 'Fail',
                tolerance: getTempTol(),
                allPass: !!temp.allPass,
                temperatureChannels: temp.channels || [],
                bath: temp.bath,
                external: temp.external,
                measured: temp.measured,
                validationStartTime: temp.startedAt || s.startedAt,
                validationEndTime: temp.completedAt || completedAt
            });
        }
        var user = global.currentUser || {};
        var payload = {
            name: 'Dissolution Validation - Aborted',
            type: 'validation',
            validationSubtype: 'combined',
            status: 'Aborted',
            allPass: false,
            createdAt: completedAt,
            completedAt: completedAt,
            validationStartTime: s.startedAt,
            validationEndTime: completedAt,
            testData: {
                validationSubtype: 'combined',
                status: 'Aborted',
                aborted: true,
                allPass: false,
                completedSteps: completedKinds,
                rpm: rpm,
                physical: phys,
                sampleVolume: sv,
                temperature: temp,
                validationRuns: validationRuns,
                validationStartTime: s.startedAt,
                validationEndTime: completedAt,
                testStartTime: s.startedAt,
                testEndTime: completedAt,
                operatorName: user.name || user.username || '--',
                employeeId: user.username || '--',
                operatorUsername: user.username || '--',
                createdAt: completedAt,
                completedAt: completedAt
            }
        };
        if (typeof stampOperatorOnTestReportPayload === 'function') {
            payload = stampOperatorOnTestReportPayload(payload);
        }
        return payload;
    }

    function abortValidationSuite(opts) {
        opts = opts || {};
        stopTempValHold();
        stopSvEntPoll();
        if (typeof stopRpmValidationMotor === 'function') {
            try { stopRpmValidationMotor(); } catch (e) { /* ignore */ }
        }
        if (typeof rpmValShaftCommand === 'function') {
            try { rpmValShaftCommand('stop'); } catch (e2) { /* ignore */ }
        }
        if (typeof _rpmValAbortLocal === 'function') {
            try { _rpmValAbortLocal(); } catch (e3) { /* ignore */ }
        }
        var s = global._validationSuite;
        var wasActive = !!(s && s.active && !s.aborted);
        if (s) {
            s.active = false;
            s.aborted = true;
        }
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Validation suite aborted', opts.reason || '', { eventType: 'validation' });
        }
        global._validationSuite = null;
        if (typeof applyValidationSuiteLockUi === 'function') applyValidationSuiteLockUi();

        if (!wasActive) {
            if (!opts.silent) goToPage('validate-type-select');
            return Promise.resolve(null);
        }

        var payload = buildAbortedSuiteValidationPayload(s);
        currentReportFilter = 'validation';
        return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
            .then(function (result) {
                var reportId = result && result.id;
                if (reportId != null && typeof logTestReportSavedAudit === 'function') {
                    logTestReportSavedAudit(reportId, payload);
                }
                if (reportId != null) {
                    if (typeof openPendingReportPreview === 'function') openPendingReportPreview(reportId);
                    else if (typeof openReportPreview === 'function') openReportPreview(reportId, { setGate: true });
                    else if (!opts.silent) goToPage('reports');
                    return reportId;
                }
                if (!opts.silent) goToPage('validate-type-select');
                return null;
            })
            .catch(function (err) {
                console.error('Aborted validation report failed', err);
                if (!opts.silent) {
                    showAppModal('Validation aborted but saving the report failed.', 'Validation');
                    goToPage('validate-type-select');
                }
                return null;
            });
    }

    function currentSuiteKind() {
        var s = global._validationSuite;
        if (!s || !s.active) return null;
        return s.order[s.index] || s.entryKind || null;
    }

    function abortLabelForKind(kind) {
        if (kind === 'rpm') return 'RPM validation';
        if (kind === 'temperature') return 'temperature validation';
        if (kind === 'sample-volume') return 'sample volume validation';
        if (kind === 'physical') return 'physical parameters validation';
        return 'the validation suite';
    }

    function getValidationSuiteAbortLabel() {
        return abortLabelForKind(currentSuiteKind());
    }

    function onValidationSuiteBack() {
        if (!isSuiteActive()) {
            goToPage('validate-type-select');
            return;
        }
        var label = getValidationSuiteAbortLabel();
        showConfirmModal(
            'Do you want to abort ' + label + '? Progress will be saved as an aborted report and requires approval.',
            'Abort Validation',
            { okLabel: 'Abort' }
        ).then(function (ok) {
            if (ok) abortValidationSuite({ reason: 'operator back' });
        });
    }

    function completeSuiteStep(kind, result) {
        var s = global._validationSuite;
        if (!s || !s.active) return;
        s.results[kind] = result || {};
        s.index = (s.index || 0) + 1;
        if (s.index >= s.order.length) {
            s.allComplete = true;
            renderValidationSuiteReview();
            goToPage('validation-suite-review');
            return;
        }
        var nextKind = s.order[s.index];
        openKindScreen(nextKind);
    }

    function renderValidationSuiteReview() {
        var el = document.getElementById('val-suite-review-summary');
        if (!el) return;
        var s = global._validationSuite || {};
        var r = s.results || {};
        var rows = [
            ['RPM', r.rpm],
            ['Physical', r.physical],
            ['Sample volume', r.sampleVolume || r['sample-volume']],
            ['Temperature', r.temperature]
        ];
        var html = '';
        rows.forEach(function (pair) {
            var item = pair[1] || {};
            var status = item.status || (item.pass ? 'Pass' : (item.acknowledged ? 'Pass' : '—'));
            html += '<div class="val-suite-review-row"><span>' + pair[0] + '</span><strong>' + status + '</strong></div>';
        });
        el.innerHTML = html;
    }

    function saveValidationSuiteReport() {
        var s = global._validationSuite;
        if (!s || !s.allComplete) {
            showAppModal('Complete all validation steps before saving.', 'Validation');
            return;
        }
        finalizeCombinedValidationReport();
    }

    function advanceValidationSuite() {
        var s = global._validationSuite;
        if (!s || !s.active) return;
        if (s.index >= s.order.length) {
            finalizeCombinedValidationReport();
            return;
        }
        openKindScreen(s.order[s.index]);
    }

    /* ── Combined report ─────────────────────────────────────── */

    function finalizeCombinedValidationReport() {
        var s = global._validationSuite;
        if (!s) return;
        var r = s.results || {};
        var rpm = r.rpm || {};
        var phys = r.physical || {};
        var sv = r.sampleVolume || r['sample-volume'] || {};
        var temp = r.temperature || {};

        var rpmPass = rpm.pass !== false && rpm.target != null;
        var physPass = !!phys.acknowledged;
        var svPass = !!sv.pass;
        var tempPass = !!temp.allPass;
        var allPass = rpmPass && physPass && svPass && tempPass;
        var statusLabel = allPass ? 'Pass' : 'Fail';
        var completedAt = nowIso();

        var validationRuns = [
            {
                validationSubtype: 'rpm',
                status: rpmPass ? 'Pass' : 'Fail',
                rpm: rpm.target,
                currentRpm: rpm.tachometer,
                tachometerRpm: rpm.tachometer,
                delta: rpm.delta,
                validationStartTime: rpm.startedAt || s.startedAt,
                validationEndTime: rpm.completedAt || completedAt
            },
            {
                validationSubtype: 'physical',
                status: physPass ? 'Pass' : 'Fail',
                acknowledged: !!phys.acknowledged,
                validationStartTime: phys.completedAt || s.startedAt,
                validationEndTime: phys.completedAt || completedAt
            },
            {
                validationSubtype: 'sample_volume',
                status: svPass ? 'Pass' : 'Fail',
                sampleVolumeTarget: sv.target,
                sampleVolumeTolerance: sv.tolerance,
                sampleVolumeMeasured: sv.measured,
                delta: sv.delta,
                sampleVolumePass: !!sv.pass,
                validationStartTime: sv.startedAt || s.startedAt,
                validationEndTime: sv.completedAt || completedAt
            },
            {
                validationSubtype: 'temperature',
                status: tempPass ? 'Pass' : 'Fail',
                tolerance: getTempTol(),
                allPass: tempPass,
                temperatureChannels: temp.channels || [],
                bath: temp.bath,
                external: temp.external,
                measured: temp.measured,
                validationStartTime: temp.startedAt || s.startedAt,
                validationEndTime: temp.completedAt || completedAt
            }
        ];

        var user = global.currentUser || {};
        var payload = {
            name: 'Dissolution Validation - ' + statusLabel,
            type: 'validation',
            validationSubtype: 'combined',
            status: statusLabel,
            allPass: allPass,
            createdAt: completedAt,
            completedAt: completedAt,
            validationStartTime: s.startedAt,
            validationEndTime: completedAt,
            testData: {
                validationSubtype: 'combined',
                status: statusLabel,
                allPass: allPass,
                rpm: rpm,
                physical: phys,
                sampleVolume: sv,
                temperature: temp,
                validationRuns: validationRuns,
                validationStartTime: s.startedAt,
                validationEndTime: completedAt,
                testStartTime: s.startedAt,
                testEndTime: completedAt,
                operatorName: user.name || user.username || '--',
                employeeId: user.username || '--',
                operatorUsername: user.username || '--',
                createdAt: completedAt,
                completedAt: completedAt
            }
        };
        if (typeof stampOperatorOnTestReportPayload === 'function') {
            payload = stampOperatorOnTestReportPayload(payload);
        }

        s.active = false;
        global._validationSuite = null;
        if (typeof applyValidationSuiteLockUi === 'function') applyValidationSuiteLockUi();

        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Validation finished', 'Combined validation ' + statusLabel, {
                eventType: 'validation',
                entityType: 'validation'
            });
        }

        currentReportFilter = 'validation';
        apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
            .then(function (result) {
                var reportId = result && result.id;
                if (!reportId) {
                    goToPage('reports');
                    return;
                }
                if (typeof logTestReportSavedAudit === 'function') logTestReportSavedAudit(reportId, payload);
                if (typeof openPendingReportPreview === 'function') openPendingReportPreview(reportId);
                else if (typeof openReportPreview === 'function') openReportPreview(reportId, { setGate: true });
                else goToPage('reports');
            })
            .catch(function (err) {
                console.error('Combined validation report failed', err);
                showAppModal('Failed to save combined validation report.', 'Validation');
                goToPage('validate-type-select');
            });
    }

    /* ── Temperature validation ──────────────────────────────── */

    function stopTempValHold() {
        if (_tempValHoldTimer != null) {
            clearInterval(_tempValHoldTimer);
            _tempValHoldTimer = null;
        }
    }

    function setTempValPrimary(label, danger) {
        var btn = document.getElementById('temp-val-primary-btn');
        if (!btn) return;
        btn.textContent = label;
        btn.classList.toggle('btn-danger', !!danger);
        btn.classList.toggle('btn-primary', !danger);
    }

    function initTemperatureValidationPage() {
        stopTempValHold();
        _tempValPhase = 'idle';
        _tempValHoldLeft = HOLD_SEC;
        _tempValSnapshot = { bath: null, external: null };
        var hold = document.getElementById('temp-val-hold-stage');
        var meas = document.getElementById('temp-val-measured-wrap');
        var ring = document.getElementById('temp-val-hold-ring');
        var timeEl = document.getElementById('temp-val-hold-time');
        var measured = document.getElementById('temp-val-measured');
        if (hold) hold.style.display = 'none';
        if (meas) meas.style.display = 'none';
        if (ring) ring.classList.remove('is-holding');
        if (timeEl) timeEl.textContent = fmtHold(HOLD_SEC);
        if (measured) measured.value = '';
        setTempValPrimary('Start', false);
        var nextBtn = document.getElementById('temp-val-next-btn');
        if (nextBtn) nextBtn.disabled = true;
        var status = document.getElementById('temp-val-status');
        if (status) status.textContent = '';
        if (typeof startTemperatureValidationLive === 'function') startTemperatureValidationLive();
        else startTempValLiveLocal();
    }

    function startTempValLiveLocal() {
        if (global._tempValLiveTimer) clearInterval(global._tempValLiveTimer);
        refreshTempValLive();
        global._tempValLiveTimer = setInterval(function () {
            if (typeof getActivePageName === 'function' && getActivePageName() !== 'temperature-validation') {
                clearInterval(global._tempValLiveTimer);
                global._tempValLiveTimer = null;
                return;
            }
            refreshTempValLive();
        }, 1000);
    }

    function refreshTempValLive() {
        if (typeof fetchTemperatureHardwareLive !== 'function') return Promise.resolve();
        return fetchTemperatureHardwareLive().then(function (data) {
            data = data || {};
            var bath = data.bath != null ? Number(data.bath) : null;
            var ext = data.external != null ? Number(data.external) : (data.ext != null ? Number(data.ext) : null);
            _tempValLive.bath = isNaN(bath) ? null : bath;
            _tempValLive.external = isNaN(ext) ? null : ext;
            if (typeof setTempValLiveDisplay === 'function') {
                setTempValLiveDisplay('temp-val-bath-live', _tempValLive.bath);
                setTempValLiveDisplay('temp-val-external-live', _tempValLive.external);
            } else {
                var b = document.getElementById('temp-val-bath-live');
                var e = document.getElementById('temp-val-external-live');
                if (b) b.textContent = _tempValLive.bath != null ? _tempValLive.bath.toFixed(1) + ' °C' : '--.- °C';
                if (e) e.textContent = _tempValLive.external != null ? _tempValLive.external.toFixed(1) + ' °C' : '--.- °C';
            }
        }).catch(function () {});
    }

    function onTemperatureValidationPrimary() {
        if (_tempValPhase === 'idle') {
            startTempValHold();
            return;
        }
        if (_tempValPhase === 'holding' || _tempValPhase === 'measure') {
            showConfirmModal(
                'Do you want to abort temperature validation? Progress will be saved as an aborted report and requires approval.',
                'Abort Temperature Validation',
                { okLabel: 'Abort' }
            ).then(function (ok) {
                if (!ok) return;
                stopTempValHold();
                abortValidationSuite({ reason: 'temperature abort' });
            });
            return;
        }
    }

    function onTemperatureValidationNext() {
        if (_tempValPhase !== 'measure') {
            showAppModal('Complete temperature stabilization and enter the measured value first.', 'Temperature Validation');
            return;
        }
        completeTempValidationWithMeasured();
    }


    function startTempValHold() {
        _tempValPhase = 'holding';
        _tempValHoldLeft = HOLD_SEC;
        var hold = document.getElementById('temp-val-hold-stage');
        var ring = document.getElementById('temp-val-hold-ring');
        var timeEl = document.getElementById('temp-val-hold-time');
        var status = document.getElementById('temp-val-status');
        var meas = document.getElementById('temp-val-measured-wrap');
        if (hold) hold.style.display = '';
        if (meas) meas.style.display = 'none';
        if (ring) ring.classList.add('is-holding');
        if (timeEl) timeEl.textContent = fmtHold(_tempValHoldLeft);
        if (status) status.textContent = 'Stabilizing…';
        setTempValPrimary('Abort', true);
        stopTempValHold();
        _tempValHoldTimer = setInterval(function () {
            _tempValHoldLeft -= 1;
            if (timeEl) timeEl.textContent = fmtHold(_tempValHoldLeft);
            if (_tempValHoldLeft <= 0) {
                stopTempValHold();
                finishTempValHold();
            }
        }, 1000);
    }

    function finishTempValHold() {
        _tempValPhase = 'measure';
        _tempValSnapshot.bath = _tempValLive.bath;
        _tempValSnapshot.external = _tempValLive.external;
        var ring = document.getElementById('temp-val-hold-ring');
        var status = document.getElementById('temp-val-status');
        var meas = document.getElementById('temp-val-measured-wrap');
        if (ring) ring.classList.remove('is-holding');
        if (status) status.textContent = 'Enter measured thermometer temperature.';
        if (meas) meas.style.display = '';
            var nextBtn = document.getElementById('temp-val-next-btn');
            if (nextBtn) {
                nextBtn.disabled = true;
                var measuredEl = document.getElementById('temp-val-measured');
                if (measuredEl && !measuredEl._nextBound) {
                    measuredEl._nextBound = true;
                    measuredEl.addEventListener('input', function () {
                        var n = parseFloat(measuredEl.value);
                        nextBtn.disabled = !(n >= 15 && n <= 55);
                    });
                }
            }
        setTempValPrimary('Abort', true);
    }

    function completeTempValidationWithMeasured() {
        var el = document.getElementById('temp-val-measured');
        var measured = el ? parseFloat(String(el.value || '').trim()) : NaN;
        if (isNaN(measured) || measured < 15 || measured > 55) {
            showAppModal('Please enter a measured temperature between 15 and 55 °C.', 'Temperature Validation');
            return;
        }
        var bath = _tempValSnapshot.bath;
        var ext = _tempValSnapshot.external;
        var bathDelta = (bath != null) ? (bath - measured) : null;
        var extDelta = (ext != null) ? (ext - measured) : null;
        var bathPass = bathDelta != null && Math.abs(bathDelta) <= TEMP_TOL;
        var extPass = extDelta != null && Math.abs(extDelta) <= TEMP_TOL;
        var allPass = bathPass && extPass;
        var channels = [
            { label: 'Bath', live: bath, reference: measured, actual: measured, delta: bathDelta, pass: bathPass },
            { label: 'External', live: ext, reference: measured, actual: measured, delta: extDelta, pass: extPass }
        ];
        var result = {
            bath: bath,
            external: ext,
            measured: measured,
            tolerance: getTempTol(),
            channels: channels,
            allPass: allPass,
            pass: allPass,
            status: allPass ? 'Pass' : 'Fail',
            startedAt: (global._validationSuite && global._validationSuite.startedAt) || nowIso(),
            completedAt: nowIso()
        };
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Validation finished', 'Temperature validation ' + result.status, {
                eventType: 'validation',
                entityType: 'validation'
            });
        }
        if (isSuiteActive()) {
            completeSuiteStep('temperature', result);
        } else {
            showAppModal('Temperature validation ' + result.status, 'Temperature Validation');
            goToPage('validate-type-select');
        }
    }

    /* ── Temperature calibration ─────────────────────────────── */

    function stopTempCalHold() {
        if (_tempCalHoldTimer != null) {
            clearInterval(_tempCalHoldTimer);
            _tempCalHoldTimer = null;
        }
    }

    function initTemperatureCalibrationPage() {
        stopTempCalHold();
        _tempCalPhase = 'idle';
        _tempCalHoldLeft = HOLD_SEC;
        var hold = document.getElementById('temp-cal-hold-stage');
        var ring = document.getElementById('temp-cal-hold-ring');
        var timeEl = document.getElementById('temp-cal-hold-time');
        var abortBtn = document.getElementById('temp-cal-abort-btn');
        var btn = document.getElementById('temp-cal-btn');
        var measured = document.getElementById('temp-cal-measured');
        if (hold) hold.style.display = 'none';
        if (ring) ring.classList.remove('is-holding');
        if (timeEl) timeEl.textContent = fmtHold(HOLD_SEC);
        if (abortBtn) abortBtn.style.display = 'none';
        if (btn) {
            btn.textContent = 'Start';
            btn.disabled = false;
        }
        if (measured) measured.value = '';
        setTempCalStatus('Ready', null);
        startTempCalLive();
    }

    function setTempCalStatus(text, cls) {
        var el = document.getElementById('temp-cal-status');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'temp-cal-status' + (cls ? ' ' + cls : '');
    }

    function startTempCalLive() {
        if (global._tempCalLiveTimer) clearInterval(global._tempCalLiveTimer);
        refreshTempCalLive();
        global._tempCalLiveTimer = setInterval(function () {
            if (typeof getActivePageName === 'function' && getActivePageName() !== 'calibration') {
                clearInterval(global._tempCalLiveTimer);
                global._tempCalLiveTimer = null;
                return;
            }
            refreshTempCalLive();
        }, 2000);
    }

    function refreshTempCalLive() {
        if (typeof fetchTemperatureHardwareLive !== 'function') return Promise.resolve();
        return fetchTemperatureHardwareLive().then(function (data) {
            data = data || {};
            var bath = data.bath != null ? Number(data.bath) : null;
            var ext = data.external != null ? Number(data.external) : null;
            _tempCalLive.bath = isNaN(bath) ? null : bath;
            _tempCalLive.external = isNaN(ext) ? null : ext;
            var b = document.getElementById('temp-cal-bath-current');
            var e = document.getElementById('temp-cal-external-current');
            if (b) b.textContent = _tempCalLive.bath != null ? _tempCalLive.bath.toFixed(1) + ' °C' : '--.- °C';
            if (e) e.textContent = _tempCalLive.external != null ? _tempCalLive.external.toFixed(1) + ' °C' : '--.- °C';
        }).catch(function () {});
    }

    function onTemperatureCalibrationPrimary() {
        if (_tempCalPhase === 'idle') {
            startTempCalHold();
            return;
        }
        if (_tempCalPhase === 'ready') {
            runDissoTemperatureCalibration();
        }
    }

    function startTempCalHold() {
        _tempCalPhase = 'holding';
        _tempCalHoldLeft = HOLD_SEC;
        var hold = document.getElementById('temp-cal-hold-stage');
        var ring = document.getElementById('temp-cal-hold-ring');
        var timeEl = document.getElementById('temp-cal-hold-time');
        var abortBtn = document.getElementById('temp-cal-abort-btn');
        var btn = document.getElementById('temp-cal-btn');
        if (hold) hold.style.display = '';
        if (ring) ring.classList.add('is-holding');
        if (timeEl) timeEl.textContent = fmtHold(_tempCalHoldLeft);
        if (abortBtn) abortBtn.style.display = '';
        if (btn) {
            btn.textContent = 'Stabilizing…';
            btn.disabled = true;
        }
        setTempCalStatus('Stabilizing…', 'is-running');
        stopTempCalHold();
        _tempCalHoldTimer = setInterval(function () {
            _tempCalHoldLeft -= 1;
            if (timeEl) timeEl.textContent = fmtHold(_tempCalHoldLeft);
            if (_tempCalHoldLeft <= 0) {
                stopTempCalHold();
                finishTempCalHold();
            }
        }, 1000);
    }

    function finishTempCalHold() {
        _tempCalPhase = 'ready';
        _tempCalSnapshot.bath = _tempCalLive.bath;
        _tempCalSnapshot.external = _tempCalLive.external;
        var ring = document.getElementById('temp-cal-hold-ring');
        var abortBtn = document.getElementById('temp-cal-abort-btn');
        var btn = document.getElementById('temp-cal-btn');
        if (ring) ring.classList.remove('is-holding');
        if (abortBtn) abortBtn.style.display = 'none';
        if (btn) {
            btn.textContent = 'Calibrate';
            btn.disabled = false;
        }
        setTempCalStatus('Enter measured temperature, then press Calibrate.', null);
    }

    function isTemperatureCalibrationActive() {
        return _tempCalPhase === 'holding' || _tempCalPhase === 'ready' || _tempCalPhase === 'calibrating';
    }

    function abortTemperatureCalibrationHold(opts) {
        opts = opts || {};
        var wasActive = isTemperatureCalibrationActive();
        var startedAt = opts.startedAt || nowIso();
        stopTempCalHold();
        _tempCalPhase = 'idle';
        var hold = document.getElementById('temp-cal-hold-stage');
        var ring = document.getElementById('temp-cal-hold-ring');
        var abortBtn = document.getElementById('temp-cal-abort-btn');
        var btn = document.getElementById('temp-cal-btn');
        if (hold) hold.style.display = 'none';
        if (ring) ring.classList.remove('is-holding');
        if (abortBtn) abortBtn.style.display = 'none';
        if (btn) {
            btn.textContent = 'Start';
            btn.disabled = false;
        }
        setTempCalStatus('Aborted.', null);
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Temperature calibration aborted', opts.reason || '', {
                eventType: 'lifecycle',
                entityType: 'calibration'
            });
        }
        if (!wasActive) return Promise.resolve(null);
        var channels = [
            { label: 'Bath', live: _tempCalLive.bath, actual: null, reference: null },
            { label: 'External', live: _tempCalLive.external, actual: null, reference: null }
        ];
        if (typeof saveTemperatureCalibrationReportAndOpenPreview === 'function') {
            return saveTemperatureCalibrationReportAndOpenPreview({
                aborted: true,
                startedAt: startedAt,
                channels: channels
            });
        }
        return Promise.resolve(null);
    }

    function runDissoTemperatureCalibration() {
        var el = document.getElementById('temp-cal-measured');
        var measured = el ? parseFloat(String(el.value || '').trim()) : NaN;
        if (isNaN(measured) || measured < 15 || measured > 55) {
            showAppModal('Please enter a measured temperature between 15 and 55 °C.', 'Calibration');
            return;
        }
        var btn = document.getElementById('temp-cal-btn');
        if (btn) btn.disabled = true;
        _tempCalPhase = 'calibrating';
        setTempCalStatus('Calibrating…', 'is-running');
        var startedAt = nowIso();
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Temperature calibration started', 'Measured ' + measured.toFixed(1) + ' °C', {
                eventType: 'lifecycle',
                entityType: 'calibration'
            });
        }
        var send = function (target, value) {
            return apiRequest(API_BASE + '/api/hardware/disso/cal/temp', {
                method: 'POST',
                body: { target: target, value: value }
            }).then(function (result) {
                if (!result || result.ok === false || result.error) {
                    throw new Error((result && result.error) || ('Calibration failed for ' + target));
                }
                return result;
            });
        };
        send('BT', measured).then(function () {
            return send('EXT', measured);
        }).then(function () {
            _tempCalPhase = 'idle';
            setTempCalStatus('Calibration completed successfully.', 'is-success');
            if (typeof logAuditEvent === 'function') {
                logAuditEvent('Temperature calibration completed', measured.toFixed(1) + ' °C', {
                    eventType: 'lifecycle',
                    entityType: 'calibration'
                });
            }
            var channels = [
                { label: 'Bath', live: _tempCalSnapshot.bath, actual: measured, reference: measured },
                { label: 'External', live: _tempCalSnapshot.external, actual: measured, reference: measured }
            ];
            if (typeof buildTemperatureCalibrationReportPayload === 'function' &&
                typeof saveTemperatureCalibrationReportAndOpenPreview === 'function') {
                return saveTemperatureCalibrationReportAndOpenPreview({
                    startedAt: startedAt,
                    channels: channels
                });
            }
            // Fallback save
            var user = global.currentUser || {};
            var completedAt = nowIso();
            var payload = {
                name: 'Temperature Calibration - Completed',
                type: 'calibration',
                calibrationSubtype: 'temperature',
                status: 'Completed',
                calibrationStartTime: startedAt,
                calibrationEndTime: completedAt,
                createdAt: completedAt,
                completedAt: completedAt,
                temperatureChannels: channels,
                testData: {
                    calibrationSubtype: 'temperature',
                    status: 'Completed',
                    measured: measured,
                    bath: _tempCalSnapshot.bath,
                    external: _tempCalSnapshot.external,
                    temperatureChannels: channels,
                    calibrationStartTime: startedAt,
                    calibrationEndTime: completedAt,
                    operatorName: user.name || user.username || '--',
                    createdAt: completedAt
                }
            };
            if (typeof stampOperatorOnTestReportPayload === 'function') {
                payload = stampOperatorOnTestReportPayload(payload);
            }
            return apiRequest(API_BASE + '/api/data/reports', { method: 'POST', body: payload })
                .then(function (result) {
                    var id = result && result.id;
                    if (id && typeof openPendingReportPreview === 'function') openPendingReportPreview(id);
                    else if (id && typeof openReportPreview === 'function') openReportPreview(id, { setGate: true });
                });
        }).catch(function (err) {
            _tempCalPhase = 'ready';
            setTempCalStatus((err && err.message) || 'Calibration failed.', 'is-error');
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Calibrate';
            }
        });
    }

    /* ── Sample volume validation ────────────────────────────── */

    function stopSvEntPoll() {
        if (_svPollTimer != null) {
            clearInterval(_svPollTimer);
            _svPollTimer = null;
        }
    }

    function setSvStatus(text) {
        var el = document.getElementById('sv-val-status');
        if (el) el.textContent = text || '';
    }

    function setSvPrimary(label, danger) {
        var btn = document.getElementById('sv-val-primary-btn');
        if (!btn) return;
        btn.textContent = label;
        btn.disabled = false;
        btn.classList.toggle('btn-danger', !!danger);
        btn.classList.toggle('btn-primary', !danger);
    }

    function initSampleVolumeValidationPage() {
        stopSvEntPoll();
        _svPhase = 'idle';
        setSvStatus('Ready');
        setSvPrimary('Start', false);
        var nextBtn = document.getElementById('sv-val-next-btn');
        if (nextBtn) nextBtn.disabled = true;
        var t = document.getElementById('sv-val-target');
        var tol = document.getElementById('sv-val-tolerance');
        if (t && !t.value) t.value = '10';
        if (tol && !tol.value) tol.value = '10';
    }

    function onSampleVolumeValidationPrimary() {
        if (_svPhase === 'idle') {
            startSampleVolumeValidation();
            return;
        }
        if (_svPhase === 'waiting-ent' || _svPhase === 'ready-next' || _svPhase === 'modal') {
            showConfirmModal(
                'Do you want to abort sample volume validation? Progress will be saved as an aborted report and requires approval.',
                'Abort Sample Volume Validation',
                { okLabel: 'Abort' }
            ).then(function (ok) {
                if (!ok) return;
                stopSvEntPoll();
                abortValidationSuite({ reason: 'sample volume abort' });
            });
        }
    }

    function startSampleVolumeValidation() {
        var targetEl = document.getElementById('sv-val-target');
        var tolEl = document.getElementById('sv-val-tolerance');
        var target = targetEl ? parseFloat(targetEl.value) : NaN;
        var tolerance = tolEl ? parseFloat(tolEl.value) : NaN;
        if (isNaN(target) || target <= 0) {
            showAppModal('Please enter a valid target volume.', 'Sample Volume');
            return;
        }
        if (isNaN(tolerance) || tolerance < 0) {
            showAppModal('Please enter a valid tolerance.', 'Sample Volume');
            return;
        }
        _svPhase = 'waiting-ent';
        setSvPrimary('Abort', true);
        setSvStatus('Starting sampler…');
        apiRequest(API_BASE + '/api/hardware/disso/cal/sample-volume', {
            method: 'POST',
            body: { phase: 'start', target: target }
        }).then(function (result) {
            if (!result || result.ok === false) {
                throw new Error((result && result.error) || 'Failed to start sample volume validation');
            }
            setSvStatus('Waiting for sampler ready…');
            _svEntDeadline = Date.now() + SV_ENT_TIMEOUT_MS;
            stopSvEntPoll();
            _svPollTimer = setInterval(pollSampleCalReady, 500);
            // In simulate, ENT is delayed ~300ms via hardware; also accept immediate if events already queued
            pollSampleCalReady();
        }).catch(function (err) {
            _svPhase = 'idle';
            setSvPrimary('Start', false);
            setSvStatus('Ready');
            showAppModal((err && err.message) || 'Start failed.', 'Sample Volume');
        });
    }

    function pollSampleCalReady() {
        if (_svPhase !== 'waiting-ent') {
            stopSvEntPoll();
            return;
        }
        if (Date.now() > _svEntDeadline) {
            stopSvEntPoll();
            _svPhase = 'idle';
            setSvPrimary('Start', false);
            setSvStatus('Timeout waiting for sampler.');
            showAppModal('Timed out waiting for ESP ready signal. Try Start again.', 'Sample Volume');
            return;
        }
        apiRequest(API_BASE + '/api/hardware/disso/events').then(function (data) {
            var events = (data && data.events) ? data.events : [];
            var ready = events.some(function (e) {
                var t = String((e && e.type) || '').toUpperCase();
                return t === 'SAMPLE-CAL-READY' || t.indexOf('ENT-TSML') >= 0;
            });
            if (ready) {
                stopSvEntPoll();
                promptMeasuredSampleVolume();
            }
        }).catch(function () {});
    }

    function promptMeasuredSampleVolume() {
        _svPhase = 'modal';
        setSvStatus('Enter measured volume.');
        var targetEl = document.getElementById('sv-val-target');
        var tolEl = document.getElementById('sv-val-tolerance');
        var target = targetEl ? parseFloat(targetEl.value) : NaN;
        var tolerance = tolEl ? parseFloat(tolEl.value) : NaN;

        // Reuse app modal with an input via prompt-style OSK field
        var overlay = document.getElementById('app-modal-overlay');
        var titleEl = document.getElementById('app-modal-title');
        var msgEl = document.getElementById('app-modal-message');
        var buttonsEl = document.getElementById('app-modal-buttons');
        if (!overlay || !msgEl || !buttonsEl) {
            var measured = window.prompt('Enter measured volume (mL)');
            finishSampleVolumeMeasured(parseFloat(measured), target, tolerance);
            return;
        }
        titleEl.textContent = 'Measured Volume';
        msgEl.innerHTML = '';
        var label = document.createElement('p');
        label.textContent = 'Enter the measured suction volume (mL).';
        label.style.marginBottom = '12px';
        var input = document.createElement('input');
        input.type = 'number';
        input.id = 'sv-val-modal-measured';
        input.className = 'input-field';
        input.min = '0';
        input.step = '0.1';
        input.placeholder = 'e.g. 10.0';
        input.style.width = '100%';
        input.onfocus = function () {
            if (typeof openOSKForInput === 'function') openOSKForInput(input);
        };
        msgEl.appendChild(label);
        msgEl.appendChild(input);
        buttonsEl.innerHTML = '';
        var doneBtn = document.createElement('button');
        doneBtn.type = 'button';
        doneBtn.className = 'btn-role-select btn-role-user';
        doneBtn.textContent = 'Done';
        doneBtn.onclick = function () {
            var v = parseFloat(String(input.value || '').trim());
            overlay.style.display = 'none';
            finishSampleVolumeMeasured(v, target, tolerance);
        };
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-role-select';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = function () {
            overlay.style.display = 'none';
            _svPhase = 'idle';
            setSvPrimary('Start', false);
            setSvStatus('Ready');
        };
        buttonsEl.appendChild(doneBtn);
        buttonsEl.appendChild(cancelBtn);
        overlay.style.display = 'flex';
        setTimeout(function () { input.focus(); }, 50);
    }

    function finishSampleVolumeMeasured(measured, target, tolerance) {
        if (isNaN(measured) || measured < 0) {
            showAppModal('Please enter a valid measured volume.', 'Sample Volume');
            _svPhase = 'idle';
            setSvPrimary('Start', false);
            return;
        }
        var delta = measured - target;
        var pass = Math.abs(delta) <= tolerance;
        setSvStatus(pass ? 'Pass' : 'Fail');

        // Send measured to ESP (cal path)
        apiRequest(API_BASE + '/api/hardware/disso/cal/sample-volume', {
            method: 'POST',
            body: { value: measured }
        }).catch(function () {});

        var result = {
            target: target,
            tolerance: tolerance,
            measured: measured,
            delta: delta,
            pass: pass,
            status: pass ? 'Pass' : 'Fail',
            startedAt: (global._validationSuite && global._validationSuite.startedAt) || nowIso(),
            completedAt: nowIso()
        };
        global._svValLastResult = result;

        // Compact result page then continue suite
        var banner = document.getElementById('sv-val-result-banner-status');
        var note = document.getElementById('sv-val-result-banner-note');
        var tEl = document.getElementById('sv-val-result-target');
        var tolEl = document.getElementById('sv-val-result-tolerance');
        var mEl = document.getElementById('sv-val-result-measured');
        var oEl = document.getElementById('sv-val-result-overall');
        if (banner) banner.textContent = pass ? 'PASS' : 'FAIL';
        if (note) note.textContent = 'Measured volume entered by operator.';
        if (tEl) tEl.textContent = String(target) + ' mL';
        if (tolEl) tolEl.textContent = '± ' + String(tolerance) + ' mL';
        if (mEl) mEl.textContent = String(measured) + ' mL';
        if (oEl) oEl.textContent = pass ? 'Pass' : 'Fail';
        _svPhase = 'ready-next';
        setSvPrimary('Abort', true);
        var nextBtn = document.getElementById('sv-val-next-btn');
        if (nextBtn) nextBtn.disabled = false;
        var status = document.getElementById('sv-val-status');
        if (status) status.textContent = 'Measured volume recorded. Press Next to continue.';
    }

    function continueAfterSampleVolumeResult() {
        var result = global._svValLastResult;
        if (isSuiteActive() && result) {
            completeSuiteStep('sample-volume', result);
        } else {
            goToPage('validate-type-select');
        }
    }

    function onSampleVolumeValidationNext() {
        var result = global._svValLastResult;
        if (!result) {
            showAppModal('Complete sample volume collection first.', 'Sample Volume');
            return;
        }
        if (isSuiteActive()) {
            completeSuiteStep('sample-volume', result);
            return;
        }
        continueAfterSampleVolumeResult();
    }

    /* ── RPM / Physical hooks ────────────────────────────────── */

    var _origRunRpm = global.runRpmValidation;
    global.runRpmValidation = function () {
        var targetEl = document.getElementById('rpm-val-target');
        var tachEl = document.getElementById('rpm-val-tachometer');
        var target = targetEl ? parseFloat(targetEl.value) : NaN;
        var tachometer = tachEl ? parseFloat(tachEl.value) : NaN;
        if (isNaN(target) || target <= 0) {
            showAppModal('Please enter a valid target RPM.', 'RPM Validation');
            return;
        }
        if (typeof isDissolutionRpmInRange === 'function' && !isDissolutionRpmInRange(target)) {
            showAppModal(
                (typeof dissolutionRpmRangeMessage === 'function')
                    ? dissolutionRpmRangeMessage('Target')
                    : 'RPM must be between 20 and 300.',
                'RPM Validation'
            );
            return;
        }
        if (isNaN(tachometer) || tachometer <= 0) {
            showAppModal('Please enter the RPM measured with a certified tachometer.', 'RPM Validation');
            return;
        }
        var delta = tachometer - target;
        var completedAt = nowIso();
        var result = {
            target: target,
            tachometer: tachometer,
            live: tachometer,
            delta: delta,
            pass: true,
            status: 'Completed',
            startedAt: completedAt,
            completedAt: completedAt
        };
        global._rpmValLastResult = result;
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Validation finished', 'RPM validation completed', {
                eventType: 'validation',
                entityType: 'validation'
            });
        }
        if (isSuiteActive()) {
            completeSuiteStep('rpm', result);
            return;
        }
        if (typeof _origRunRpm === 'function') return _origRunRpm();
        goToPage('rpm-validation-result');
    };

    var _origPhys = global.confirmPhysicalParameters;
    global.confirmPhysicalParameters = function () {
        var agree = document.getElementById('phys-params-agree');
        if (!agree || !agree.checked) {
            showAppModal('Please confirm you have read all agreements and parameters.', 'Physical Parameters');
            return;
        }
        if (typeof logAuditEvent === 'function') {
            logAuditEvent('Physical parameters acknowledged', 'User confirmed reading physical parameters', {
                eventType: 'validation'
            });
        }
        var result = { acknowledged: true, pass: true, status: 'Pass', completedAt: nowIso() };
        if (isSuiteActive()) {
            completeSuiteStep('physical', result);
            return;
        }
        if (typeof _origPhys === 'function') return _origPhys();
        goToPage('validate-type-select');
    };

    /* ── Exports / overrides ─────────────────────────────────── */

    global.startValidationSuite = startValidationSuite;
    global.abortValidationSuite = abortValidationSuite;
    global.onValidationSuiteBack = onValidationSuiteBack;
    global.advanceValidationSuite = advanceValidationSuite;
    global.isValidationSuiteActive = isSuiteActive;
    global.getValidationSuiteAbortLabel = getValidationSuiteAbortLabel;
    global.saveValidationSuiteReport = saveValidationSuiteReport;
    global.onTemperatureValidationNext = onTemperatureValidationNext;
    global.onSampleVolumeValidationNext = onSampleVolumeValidationNext;
    global.onRpmValidationPrimary = global.onRpmValidationPrimary || null;

    global.openDissolutionValidationOption = function (kind) {
        if (isSuiteActive()) {
            showAppModal('Finish or abort the current validation suite first.', 'Validation');
            return;
        }
        startValidationSuite(kind);
    };

    global.openDissolutionCalibration = function () {
        if (isSuiteActive()) {
            showAppModal('Finish or abort the validation suite before opening calibration.', 'Calibration');
            return;
        }
        if (typeof showProcedureModal === 'function') {
            showProcedureModal(
                'Calibration Procedure',
                (typeof PROCEDURE_CALIBRATION_TEMPERATURE !== 'undefined')
                    ? PROCEDURE_CALIBRATION_TEMPERATURE
                    : ['Stabilize, enter measured reference, then calibrate.'],
                function () { goToPage('calibration'); }
            );
        } else {
            goToPage('calibration');
        }
    };

    global.initTemperatureValidationPage = initTemperatureValidationPage;
    global.onTemperatureValidationPrimary = onTemperatureValidationPrimary;
    global.initTemperatureCalibrationPage = initTemperatureCalibrationPage;
    global.onTemperatureCalibrationPrimary = onTemperatureCalibrationPrimary;
    global.abortTemperatureCalibrationHold = abortTemperatureCalibrationHold;
    global.isTemperatureCalibrationActive = isTemperatureCalibrationActive;
    global.initSampleVolumeValidationPage = initSampleVolumeValidationPage;
    global.onSampleVolumeValidationPrimary = onSampleVolumeValidationPrimary;
    global.continueAfterSampleVolumeResult = continueAfterSampleVolumeResult;

    // Patch applyTemperatureHardwareLive path used by existing live pollers
    var _origApplyTempVal = global.applyTemperatureHardwareLive;
    global.applyTemperatureHardwareLive = function (data) {
        if (typeof _origApplyTempVal === 'function') _origApplyTempVal(data);
        data = data || {};
        if (data.bath != null) _tempValLive.bath = Number(data.bath);
        if (data.external != null) _tempValLive.external = Number(data.external);
    };

})(window);
