/* disso_client.js - Dissolution dual-ESP test client + power-resume modal */
(function () {
  'use strict';

  var _pollTimer = null;
  var _sse = null;
  var _tempPollTimer = null;
  var _autoTempArmed = false;

  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (window.currentUser) {
      if (window.currentUser.role) headers['X-User-Role'] = window.currentUser.role;
      if (window.currentUser.username) headers['X-User-Username'] = window.currentUser.username;
      if (window.currentUser.name) headers['X-User-Name'] = window.currentUser.name;
    }
    return fetch((window.API_BASE || '') + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        return { ok: r.ok, status: r.status, body: body };
      });
    });
  }

  var _resumeBaseMsg = '';

  function resumeBtnStyle(primary) {
    if (primary === 'danger') {
      return 'padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;border:none;background:#b91c1c;color:#ffffff;';
    }
    if (primary) {
      return 'padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;border:none;background:#2563eb;color:#ffffff;';
    }
    return 'padding:12px 20px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;border:1px solid #94a3b8;background:#e2e8f0;color:#0f172a;';
  }

  function setResumeBusy(busy) {
    var box = document.getElementById('disso-resume-actions');
    if (!box) return;
    var buttons = box.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !!busy;
  }

  function resumeErrorText(res, fallback) {
    var raw = (res && res.body && res.body.error) || '';
    if (typeof window.friendlyHardwareError === 'function') {
      return window.friendlyHardwareError(raw, fallback);
    }
    return raw || fallback;
  }

  function showResumeCardError(text) {
    var msg = document.getElementById('disso-resume-msg');
    if (msg) msg.textContent = text || 'Could not complete that action.';
    setResumeActions('choose');
  }

  function submitResumeContinue() {
    setResumeBusy(true);
    api('/api/disso/test/continue', { method: 'POST' }).then(function (res) {
      if (!res.ok || !(res.body && res.body.ok)) {
        showResumeCardError(resumeErrorText(res, 'Could not continue test.'));
        return;
      }
      var st = (res.body && res.body.state) || {};
      if (!restoreTestRunFromServerState(st)) {
        showResumeCardError('Could not open the test. Press Continue again.');
        return;
      }
      hideResumeModal();
      if (typeof goToPage === 'function') goToPage('test-run');
      startStatePolling();
      if (typeof window.dissoPollStateNow === 'function') window.dissoPollStateNow();
    }).catch(function () {
      showResumeCardError('Could not continue test.');
    });
  }

  function submitResumeAbort() {
    setResumeBusy(true);
    api('/api/disso/test/claim-abort', { method: 'POST' }).then(function (res) {
      if (!res.ok || !(res.body && res.body.ok)) {
        showResumeCardError(resumeErrorText(res, 'Could not abort test.'));
        return;
      }
      hideResumeModal();
      if (typeof goToPage === 'function') goToPage('home');
      if (res.body && res.body.reportId && typeof finishTestRunReportSaved === 'function') {
        finishTestRunReportSaved(res.body.reportId);
      }
    }).catch(function () {
      showResumeCardError('Could not abort test.');
    });
  }

  function setResumeActions(kind) {
    var box = document.getElementById('disso-resume-actions');
    if (!box) return;
    if (kind === 'confirm-abort') {
      box.innerHTML =
        '<button type="button" id="disso-resume-back" style="' + resumeBtnStyle(false) + '">Back</button>' +
        '<button type="button" id="disso-resume-confirm-abort" style="' + resumeBtnStyle('danger') + '">Confirm</button>';
      document.getElementById('disso-resume-back').onclick = function () {
        var msg = document.getElementById('disso-resume-msg');
        if (msg) msg.textContent = _resumeBaseMsg;
        setResumeActions('choose');
      };
      document.getElementById('disso-resume-confirm-abort').onclick = submitResumeAbort;
      return;
    }
    box.innerHTML =
      '<button type="button" id="disso-resume-abort" style="' + resumeBtnStyle(false) + '">Abort</button>' +
      '<button type="button" id="disso-resume-continue" style="' + resumeBtnStyle(true) + '">Continue</button>';
    document.getElementById('disso-resume-abort').onclick = function () {
      var msg = document.getElementById('disso-resume-msg');
      if (msg) msg.textContent = 'Abort this test? It will be saved as aborted.';
      setResumeActions('confirm-abort');
    };
    document.getElementById('disso-resume-continue').onclick = submitResumeContinue;
  }

  function ensureResumeModal() {
    var existing = document.getElementById('disso-resume-modal');
    if (existing && existing.getAttribute('data-disso-resume-v') !== '3') {
      existing.remove();
      existing = null;
    }
    if (existing) return;
    var wrap = document.createElement('div');
    wrap.id = 'disso-resume-modal';
    wrap.setAttribute('data-disso-resume-v', '3');
    wrap.style.cssText = 'display:none;position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);align-items:center;justify-content:center;';
    wrap.innerHTML =
      '<div style="background:#ffffff;max-width:520px;width:92%;padding:24px 28px;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.25);font-family:inherit;color:#0f172a;">' +
      '<h2 style="margin:0 0 12px;font-size:1.25rem;color:#0f172a;font-weight:700;">Test in progress</h2>' +
      '<p id="disso-resume-msg" style="margin:0 0 20px;line-height:1.45;color:#1e293b;"></p>' +
      '<div id="disso-resume-actions" style="display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap;"></div>' +
      '</div>';
    document.body.appendChild(wrap);
    setResumeActions('choose');
  }

  /** After power-claim Continue: rebuild local test UI from server state (includes recipe). */
  function restoreTestRunFromServerState(st) {
    st = st || {};
    var recipe = st.recipe;
    if (!recipe || typeof initDissolutionTestRun !== 'function') {
      return false;
    }
    initDissolutionTestRun(recipe, { skipPrepare: true });
    var dt = window._dissolutionTest;
    if (!dt) return false;
    dt.recipeUploaded = true;
    dt.preparingStart = false;
    var rsEarly = String(st.runStatus || '').toUpperCase();
    if (rsEarly === 'PREHEAT' || rsEarly === 'READY') {
      dt.needsPreheat = true;
      dt.preheatDone = false;
      dt.preheating = false;
      dt.running = false;
      dt.paused = false;
      window._dissoServerRunActive = false;
      if (typeof _dtSetPrimaryButton === 'function') _dtSetPrimaryButton('preheat');
      if (typeof _dtSetStatus === 'function') _dtSetStatus('Press Preheat when ready.', 'ready');
      if (typeof _dtSyncEquipVisuals === 'function') _dtSyncEquipVisuals();
      return true;
    }
    if (rsEarly === 'REFLUSHING' || rsEarly === 'FINALIZING') {
      dt.needsPreheat = false;
      dt.preheatDone = true;
      dt.preheating = false;
      dt.running = false;
      dt.paused = false;
      window._dissoServerRunActive = true;
      return true;
    }
    dt.needsPreheat = false;
    dt.preheatDone = true;
    dt.preheating = false;
    dt.stepIndex = parseInt(st.stepIndex, 10) || 0;
    if (st.setSecInStep != null) dt.setSec = parseInt(st.setSecInStep, 10) || 0;
    if (st.remainingSecInStep != null) dt.remainingSec = parseInt(st.remainingSecInStep, 10) || 0;
    if (typeof _dtApplyStep === 'function') {
      _dtApplyStep(dt.stepIndex, false);
    }
    if (st.setSecInStep != null) dt.setSec = parseInt(st.setSecInStep, 10) || dt.setSec;
    if (st.remainingSecInStep != null) dt.remainingSec = parseInt(st.remainingSecInStep, 10) || dt.remainingSec;
    if (typeof _dtSetText === 'function' && typeof _dtFormatHms === 'function') {
      _dtSetText('dt-hero-timer', _dtFormatHms(dt.remainingSec || 0));
    }
    var rs = String(st.runStatus || '').toUpperCase();
    if (rs === 'PAUSED') {
      dt.running = true;
      dt.paused = true;
      if (typeof _dtSetControlsPaused === 'function') _dtSetControlsPaused();
      if (typeof _dtSetStatus === 'function') _dtSetStatus('Test paused', 'paused');
    } else {
      dt.running = true;
      dt.paused = false;
      if (typeof _dtSetControlsRunning === 'function') _dtSetControlsRunning();
      if (typeof _dtSetStatus === 'function') {
        _dtSetStatus('Test running… Step ' + (dt.stepIndex + 1) + '/' + (dt.steps.length || '?'), 'running');
      }
      if (typeof _dtStartTicker === 'function') _dtStartTicker();
    }
    window._dissoServerRunActive = true;
    if (typeof _dtUpdateProgress === 'function') _dtUpdateProgress();
    if (typeof _dtRefreshDurationTiles === 'function') _dtRefreshDurationTiles();
    return true;
  }

  function showResumeModal(state) {
    ensureResumeModal();
    var el = document.getElementById('disso-resume-modal');
    var msg = document.getElementById('disso-resume-msg');
    var starter = (state.startedBy && (state.startedBy.name || state.startedBy.username)) || 'Another user';
    var product = state.productName || 'Dissolution test';
    var step = ((state.stepIndex || 0) + 1) + '/' + (state.stepCount || '?');
    var status = state.runStatus || 'RUNNING';
    _resumeBaseMsg = starter + ' started "' + product + '" (Step ' + step + '). Status: ' + status +
      '. The test may already be running in the background after power restore. Continue or Abort — all operators are recorded on the report (Performed by).';
    msg.textContent = _resumeBaseMsg;
    setResumeActions('choose');
    if (typeof window.closeOSK === 'function') window.closeOSK();
    try { document.body.classList.remove('keyboard-open'); } catch (eKb) { /* ignore */ }
    el.style.display = 'flex';
  }

  function hideResumeModal() {
    var el = document.getElementById('disso-resume-modal');
    if (el) el.style.display = 'none';
  }

  window.dissoAfterLoginCheck = function () {
    return api('/api/disso/test/state?public=1').then(function (res) {
      var st = (res.body && res.body.state) || {};
      if (st.active) {
        showResumeModal(st);
        return true;
      }
      return false;
    }).catch(function () { return false; });
  };

  window.dissoUploadRecipe = function (recipe, opts) {
    opts = opts || {};
    return api('/api/hardware/disso/recipe/upload', {
      method: 'POST',
      body: {
        recipe: recipe,
        fromStepIndex: opts.fromStepIndex || 0,
        remainingSecInStep: opts.remainingSecInStep
      }
    }).then(function (res) {
      if (!res.ok || !(res.body && res.body.ok)) {
        throw new Error((res.body && res.body.error) || 'Recipe prepare failed');
      }
      return res.body;
    });
  };

  window.dissoPreheat = function (timeoutSec, opts) {
    opts = opts || {};
    // Production: PRE-HEAT ACK = heating started. PRE-DONE is async (waitDone).
    var waitDone = opts.waitDone === true;
    return api('/api/hardware/disso/preheat', {
      method: 'POST',
      body: {
        timeout: timeoutSec != null ? timeoutSec : 120,
        waitDone: waitDone
      }
    }).then(function (res) {
      if (!res.ok || !(res.body && res.body.ok)) {
        throw new Error((res.body && res.body.error) || 'Preheat failed');
      }
      return res.body;
    });
  };

  window.dissoSetTemp = function (temperature) {
    return api('/api/hardware/disso/temperature/set', {
      method: 'POST',
      body: { temperature: temperature }
    }).then(function (res) {
      if (!res.ok || !(res.body && res.body.ok)) {
        throw new Error((res.body && res.body.error) || 'Set temperature failed');
      }
      return res.body;
    });
  };

  window.dissoHeaterOn = function (temperature, opts) {
    opts = opts || {};
    return api('/api/hardware/disso/heater/on', {
      method: 'POST',
      body: {
        temperature: temperature,
        waitDone: !!opts.waitDone,
        timeout: opts.timeout != null ? opts.timeout : 180
      }
    }).then(function (res) {
      if (!res.ok || !(res.body && res.body.ok)) {
        throw new Error((res.body && res.body.error) || 'Heater on failed');
      }
      return res.body;
    });
  };

  window.dissoHeaterOff = function () {
    return api('/api/hardware/disso/heater/off', {
      method: 'POST',
      body: {}
    }).then(function (res) {
      if (!res.ok || !(res.body && res.body.ok)) {
        throw new Error((res.body && res.body.error) || 'Heater off failed');
      }
      return res.body;
    });
  };

  window.dissoBeep = function (count) {
    return api('/api/hardware/disso/beep', {
      method: 'POST',
      body: { count: count != null ? count : 1 }
    }).then(function (res) {
      return res.body || {};
    }).catch(function () { return {}; });
  };

  window.dissoResetRunEndedLatches = function () {
    _runEndedApplied = false;
    _runEndedUiCleared = false;
    window._dissoCompletionBeepPlayed = false;
    try { window._lastOpenedEndedReportId = null; } catch (e0) { /* ignore */ }
  };

  window.dissoPrepareNewRun = function () {
    window.dissoResetRunEndedLatches();
    return api('/api/disso/test/prepare', { method: 'POST' }).then(function (res) {
      if (!res.ok || !(res.body && res.body.ok)) {
        var err = new Error((res.body && res.body.error) || 'Could not prepare for a new test run.');
        err.body = res.body;
        throw err;
      }
      window._dissoServerRunActive = false;
      if (res.body.state) applyStateToUi(res.body.state);
      return res.body;
    });
  };

  window.dissoStartTest = function (recipe, meta) {
    meta = meta || {};
    return api('/api/disso/test/start', {
      method: 'POST',
      body: {
        recipe: recipe,
        arNumber: meta.arNumber,
        batchNumber: meta.batchNumber,
        powerFailure: meta.powerFailure || recipe.powerFailure
      }
    }).then(function (res) {
      if (!res.ok || !(res.body && res.body.ok)) {
        var err = new Error((res.body && res.body.error) || 'Failed to start Dissolution test on ESP');
        err.errorCode = res.body && res.body.errorCode;
        err.phase = res.body && res.body.phase;
        err.body = res.body;
        throw err;
      }
      startStatePolling();
      return res.body.state;
    });
  };

  window.dissoPauseTest = function () {
    return api('/api/disso/test/pause', { method: 'POST' });
  };

  window.dissoResumeTest = function () {
    return api('/api/disso/test/resume', { method: 'POST' });
  };

  window.dissoAbortTest = function () {
    return api('/api/disso/test/abort', { method: 'POST' });
  };

  var _samplingOverlayPhase = null;
  var _runEndedApplied = false;
  var _runEndedUiCleared = false;
  var _reportOpenRetryTimer = null;

  function showSamplingOverlay(message) {
    var chip = document.getElementById('dt-sampling-chip');
    if (!chip) return;
    chip.textContent = message || 'Sampling';
    chip.hidden = false;
  }

  function hideSamplingOverlay() {
    _samplingOverlayPhase = null;
    var chip = document.getElementById('dt-sampling-chip');
    if (!chip) return;
    chip.hidden = true;
    chip.textContent = '';
  }

  function applySamplingPhaseEvent(type) {
    if (type === 'SAMPLE-COLLECT') {
      if (_samplingOverlayPhase === 'collect') return;
      _samplingOverlayPhase = 'collect';
      showSamplingOverlay('Collecting sample');
    } else if (type === 'SAMPLE-FLUSH') {
      if (_samplingOverlayPhase === 'flush') return;
      _samplingOverlayPhase = 'flush';
      showSamplingOverlay('Flushing');
    } else if (type === 'AIR-CLEAN') {
      if (_samplingOverlayPhase === 'air') return;
      _samplingOverlayPhase = 'air';
      showSamplingOverlay('Air cleaning');
    } else if (type === 'SAMPLE-CYCLE-DONE' || type === 'AIR-CLEAN-DONE') {
      hideSamplingOverlay();
    }
  }

  function _clearEndedSessionUi(st) {
    if (_runEndedUiCleared) return;
    _runEndedUiCleared = true;
    hideSamplingOverlay();
    disarmAutoTemp('test-ended');
    window._dissoServerRunActive = false;
    var dt = window._dissolutionTest;
    if (dt) {
      if (typeof _dtStopTimer === 'function') _dtStopTimer();
      dt.running = false;
      dt.paused = false;
      dt.preheating = false;
      dt.preheatDone = false;
      dt.preparingStart = false;
      dt._displayedStepIndex = null;
      dt._aborting = false;
      if (typeof _dtClearThermalFlags === 'function') _dtClearThermalFlags();
      if (typeof _dtSetControlsIdle === 'function') _dtSetControlsIdle();
      if (typeof _dtSetPrimaryButton === 'function') _dtSetPrimaryButton('disabled');
      if (typeof _dtSetStatus === 'function') {
        var aborted = String((st && st.runStatus) || '').toUpperCase() === 'ABORTED';
        _dtSetStatus(aborted ? 'Test aborted' : 'Test completed', aborted ? 'aborted' : 'done');
      }
    }
    if (typeof window._dtCloseReturnableSession === 'function') {
      window._dtCloseReturnableSession();
    } else if (typeof refreshHomeTestScreenCard === 'function') {
      refreshHomeTestScreenCard();
    }
    if (typeof applyDtRunLockUi === 'function') applyDtRunLockUi();
  }

  function markRunEndedApplied() {
    _runEndedApplied = true;
    if (_reportOpenRetryTimer) {
      clearTimeout(_reportOpenRetryTimer);
      _reportOpenRetryTimer = null;
    }
    stopStatePolling();
  }

  /** Latch closed so abort UI + END-TEST / state poll do not double-open the pending report. */
  window.dissoMarkRunEndedApplied = markRunEndedApplied;

  function _openPendingReportWhenReady(rid) {
    if (_runEndedApplied) return;
    if (!rid) return;
    markRunEndedApplied();
    if (typeof finishTestRunReportSaved === 'function') {
      try { finishTestRunReportSaved(rid); } catch (e) { /* ignore */ }
    }
  }

  function _retryOpenPendingReport(attempt) {
    attempt = attempt || 0;
    if (_runEndedApplied) return;
    api('/api/disso/test/state').then(function (res) {
      var st = (res && res.body && res.body.state) || {};
      var rid = st.lastReportId || st.reportId;
      if (rid) {
        _clearEndedSessionUi(st);
        _openPendingReportWhenReady(rid);
        return;
      }
      if (attempt < 24) {
        _reportOpenRetryTimer = setTimeout(function () {
          _retryOpenPendingReport(attempt + 1);
        }, 250);
      } else {
        // Give up opening preview but still leave session cleared.
        _runEndedApplied = true;
        stopStatePolling();
      }
    }).catch(function () {
      if (attempt < 24) {
        _reportOpenRetryTimer = setTimeout(function () {
          _retryOpenPendingReport(attempt + 1);
        }, 250);
      }
    });
  }

  function applyDissolutionRunEndedFromServer(st) {
    st = st || {};
    if (_runEndedApplied) return;
    var status = String(st.runStatus || '').toUpperCase();
    var liveRs = window._dissoServerState
      ? String(window._dissoServerState.runStatus || '').toUpperCase()
      : '';
    // END-TEST arrives at the start of the 4-minute reflush. Do not clear the
    // screen or open a report until the server has actually finished.
    if ((liveRs === 'REFLUSHING' || liveRs === 'FINALIZING') && !(st.lastReportId || st.reportId)) {
      return;
    }
    // Still saving report on the server — keep polling; do not latch closed.
    if (status === 'FINALIZING') {
      return;
    }
    _clearEndedSessionUi(st);
    // Long beep once when the dissolution test completes successfully.
    if (status === 'COMPLETE' && !window._dissoCompletionBeepPlayed) {
      window._dissoCompletionBeepPlayed = true;
      if (typeof window.kioskBeep === 'function') {
        try { window.kioskBeep('long'); } catch (e) { /* ignore */ }
      } else if (typeof window.dissoBeep === 'function') {
        try { window.dissoBeep(2); } catch (e2) { /* ignore */ }
      }
    }
    var rid = st.lastReportId || st.reportId;
    if (rid) {
      _openPendingReportWhenReady(rid);
      return;
    }
    if (status === 'COMPLETE' || status === 'ABORTED' || st.active === false) {
      // COMPLETE arrived without id (race) — retry until lastReportId appears.
      if (!_reportOpenRetryTimer) {
        _retryOpenPendingReport(0);
      }
    }
  }

  window.applyDissolutionRunEndedFromServer = applyDissolutionRunEndedFromServer;

  function applyStateToUi(st) {
    if (!st) return;
    window._dissoServerState = st;
    var serverLive = !!(st.active && (
      st.runStatus === 'RUNNING' ||
      st.runStatus === 'PAUSED' ||
      st.runStatus === 'POWER_RESUME_PENDING' ||
      st.runStatus === 'FINALIZING' ||
      st.runStatus === 'REFLUSHING'
    ));
    if (serverLive) {
      _runEndedApplied = false;
      _runEndedUiCleared = false;
      var rsLive = String(st.runStatus || '').toUpperCase();
      // Do not clear the completion beep during reflush — that retriggered BEEP-2 on every poll.
      if (rsLive === 'RUNNING' || rsLive === 'PAUSED' || rsLive === 'POWER_RESUME_PENDING') {
        window._dissoCompletionBeepPlayed = false;
        try { window._lastOpenedEndedReportId = null; } catch (eClr) { /* ignore */ }
      }
    }
    window._dissoServerRunActive = serverLive;
    var dt = window._dissolutionTest;
    if (dt && dt._aborting) {
      window._dissoServerRunActive = false;
      dt.running = false;
      dt.paused = false;
    } else if (dt) {
      // Ignore timers/recipe from a finished run — they overwrote new Quick/Load sessions.
      if (serverLive) {
        var prevStepIndex = dt._displayedStepIndex;
        if (st.stepIndex != null) dt.stepIndex = st.stepIndex;
        if (st.remainingSecInStep != null) dt.remainingSec = st.remainingSecInStep;
        if (st.setSecInStep != null) {
          dt.setSec = st.setSecInStep;
        } else if (!(parseInt(dt.setSec, 10) > 0) && dt.steps && dt.steps[dt.stepIndex]) {
          dt.setSec = parseInt(dt.steps[dt.stepIndex].durationSeconds, 10) || dt.setSec || 0;
        }
        if (st.runStatus === 'RUNNING' || st.runStatus === 'FINALIZING' || st.runStatus === 'REFLUSHING') {
          dt.running = st.runStatus === 'RUNNING';
          dt.paused = false;
        } else if (st.runStatus === 'PAUSED') {
          dt.running = true;
          dt.paused = true;
        }
        if (st.stepIndex != null && st.stepIndex !== prevStepIndex) {
          var liveStep = dt.steps && dt.steps[dt.stepIndex];
          if (liveStep && typeof _dtSetText === 'function') {
            var rpmLabel = (typeof _dtFormatRpm === 'function')
              ? _dtFormatRpm(liveStep.rpm)
              : String(liveStep.rpm != null ? liveStep.rpm : '--');
            _dtSetText('dt-rpm', rpmLabel);
          }
          if (typeof _dtSyncEquipVisuals === 'function') _dtSyncEquipVisuals();
          dt._displayedStepIndex = st.stepIndex;
        }
      } else if (st.runStatus === 'ABORTED' || st.runStatus === 'COMPLETE') {
        dt.running = false;
        dt.paused = false;
        dt.preheating = false;
        dt.preheatDone = false;
        dt.preparingStart = false;
        window._dissoServerRunActive = false;
        dt._returnableClosed = true;
      } else if (st.active === false) {
        // Idle between recipe load / preheat / start — do not wipe preheatDone (was cleared every poll).
        dt.running = false;
        dt.paused = false;
        dt.preparingStart = false;
        window._dissoServerRunActive = false;
      }
    }
    if (st.preheatReady && dt && dt.preheating && dt.needsPreheat && !dt.running && !dt.paused && !dt.preheatDone) {
      if (typeof window.applyPreheatDoneFromEsp === 'function') {
        window.applyPreheatDoneFromEsp({ type: 'PRE-DONE', source: 'server-state' });
      }
    }
    if (typeof _dtSetText === 'function') {
      if (serverLive && st.stepCount != null) {
        var stepLabel = ((st.stepIndex || 0) + 1) + ' / ' + st.stepCount;
        _dtSetText('dt-current-step', stepLabel);
        _dtSetText('dt-step', stepLabel);
      }
      if (serverLive && st.remainingSecInStep != null) {
        var remHms = (typeof formatHms === 'function')
          ? formatHms(st.remainingSecInStep)
          : (typeof _dtFormatHms === 'function' ? _dtFormatHms(st.remainingSecInStep) : String(st.remainingSecInStep) + 's');
        _dtSetText('dt-hero-timer', remHms);
      }
      if (typeof _dtRefreshDurationTiles === 'function') {
        _dtRefreshDurationTiles();
      } else if (st.setSecInStep != null) {
        var setHms = (typeof formatHms === 'function')
          ? formatHms(st.setSecInStep)
          : (typeof _dtFormatHms === 'function' ? _dtFormatHms(st.setSecInStep) : String(st.setSecInStep) + 's');
        _dtSetText('dt-step-duration', setHms);
      }
      if (st.runStatus && !(dt && dt._aborting)) {
        var rs = String(st.runStatus).toLowerCase();
        if (typeof _dtSetStatus === 'function') {
          if (rs === 'running') _dtSetStatus('Test running… Step ' + ((st.stepIndex || 0) + 1) + '/' + (st.stepCount || '?'), 'running');
          else if (rs === 'paused') _dtSetStatus('Test paused', 'paused');
          else if (rs === 'reflushing') _dtSetStatus('Reflushing…', 'running');
          else if (rs === 'finalizing') _dtSetStatus('Saving report…', 'running');
          else if (rs !== 'complete' && rs !== 'aborted') _dtSetStatus(st.runStatus, rs);
        }
      }
    }
    if (typeof _dtUpdateProgress === 'function') {
      _dtUpdateProgress();
    }
    applyLiveTempsToUi(st.temps || {});
    if (typeof window.syncReflushLockFromState === 'function') {
      window.syncReflushLockFromState(st);
    }
    if (st.runStatus === 'COMPLETE' || st.runStatus === 'ABORTED') {
      applyDissolutionRunEndedFromServer(st);
    }
  }

  function _fmtTempC(v) {
    if (v == null || v === '' || isNaN(Number(v))) return '—';
    return Number(v).toFixed(1) + ' \u00B0C';
  }

  function applyLiveTempsToUi(temps) {
    temps = temps || {};
    var bath = temps.bath;
    var ext = temps.external != null ? temps.external : temps.ext;
    var vessels = temps.vessels || [];

    // Test-run Step Timer panel live bath temp
    var liveEl = document.getElementById('dt-live-temp');
    if (liveEl) {
      if (bath != null && bath !== '' && !isNaN(Number(bath))) {
        liveEl.textContent = Number(bath).toFixed(1);
      } else {
        liveEl.textContent = '--';
      }
    }

    // System info page (no vessel V1–V6 tiles there anymore — bath/ext only)
    var sysBath = document.getElementById('sysinfo-bath');
    if (sysBath && bath != null) sysBath.textContent = _fmtTempC(bath);
    var sysExt = document.getElementById('sysinfo-ext');
    if (sysExt && ext != null) sysExt.textContent = _fmtTempC(ext);

    // Vessel info page: update max/min/current from real UART-2 samples
    var vtPage = document.getElementById('page-vessel-temperature');
    if (vtPage && vtPage.classList.contains('active')) {
      if (typeof _vtUpdateStatsFromLive === 'function') _vtUpdateStatsFromLive(temps);
      if (typeof renderVesselTemperaturePage === 'function') renderVesselTemperaturePage(temps);
    }
  }

  function fetchStateNow() {
    return api('/api/disso/test/state').then(function (res) {
      if (res.body && res.body.state) applyStateToUi(res.body.state);
      return res.body && res.body.state;
    }).catch(function () {});
  }

  function startTempUiPolling() {
    stopTempUiPolling();
    var tick = function () {
      window.dissoFetchTemps(false).then(function (data) {
        if (data) applyLiveTempsToUi(data);
      }).catch(function () {});
    };
    tick();
    _tempPollTimer = setInterval(tick, 1000);
  }

  function stopTempUiPolling() {
    if (_tempPollTimer) {
      clearInterval(_tempPollTimer);
      _tempPollTimer = null;
    }
  }

  function armAutoTemp(reason) {
    _autoTempArmed = true;
    startTempUiPolling();
    return api('/api/hardware/disso/temperature/auto', {
      method: 'POST',
      body: { armed: true, reason: reason || 'ui' }
    }).then(function (res) {
      return res.body || {};
    }).catch(function () { return {}; });
  }

  function disarmAutoTemp(reason) {
    _autoTempArmed = false;
    stopTempUiPolling();
    return api('/api/hardware/disso/temperature/auto', {
      method: 'POST',
      body: { armed: false, reason: reason || 'ui' }
    }).then(function (res) {
      return res.body || {};
    }).catch(function () { return {}; });
  }

  function startStatePolling() {
    stopStatePolling();
    fetchStateNow();
    armAutoTemp('test-state');
    // Pull server state every 1s while a test is live (step timer + progress).
    _pollTimer = setInterval(function () {
      fetchStateNow();
    }, 1000);
  }

  function stopStatePolling() {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = null;
    if (_sse) {
      try { _sse.close(); } catch (e) {}
      _sse = null;
    }
  }

  window.dissoPollStateNow = fetchStateNow;
  window.dissoApplyLiveTemps = applyLiveTempsToUi;
  window.dissoArmAutoTemp = armAutoTemp;
  window.dissoDisarmAutoTemp = disarmAutoTemp;
  window.dissoStartTempUiPolling = startTempUiPolling;
  window.dissoStopTempUiPolling = stopTempUiPolling;

  window.dissoStartStatePolling = startStatePolling;
  window.dissoStopStatePolling = stopStatePolling;
  window.dissoLift = function (action) {
    return api('/api/hardware/disso/lift/' + action, { method: 'POST' });
  };

  var _eventsPollTimer = null;
  var _eventsPollRef = 0;

  function handleCmdEvents(events) {
    if (!events || !events.length) return;
    events.forEach(function (evt) {
      if (!evt || !evt.type) return;
      if (evt.type === 'LIFT-HOME') {
        if (typeof window.applyShaftHomeFromEsp === 'function') {
          window.applyShaftHomeFromEsp(evt);
        }
      } else if (evt.type === 'PRE-DONE') {
        if (typeof window.applyPreheatDoneFromEsp === 'function') {
          window.applyPreheatDoneFromEsp(evt);
        }
      } else if (evt.type === 'HOLD-TEMP-RCH') {
        if (typeof window.applyHoldTempReached === 'function') {
          window.applyHoldTempReached(evt);
        }
      } else if (
        evt.type === 'SAMPLE-COLLECT' ||
        evt.type === 'SAMPLE-FLUSH' ||
        evt.type === 'SAMPLE-CYCLE-DONE' ||
        evt.type === 'AIR-CLEAN' ||
        evt.type === 'AIR-CLEAN-DONE'
      ) {
        applySamplingPhaseEvent(evt.type);
      } else if (evt.type === 'END-TEST') {
        hideSamplingOverlay();
        var tryEnd = function (attempt) {
          fetchStateNow().then(function (st) {
            var rs = st ? String(st.runStatus || '').toUpperCase() : '';
            var rid = st && (st.lastReportId || st.reportId);
            if (rs === 'REFLUSHING' || rs === 'FINALIZING') {
              setTimeout(function () { tryEnd(attempt); }, 1000);
              return;
            }
            if ((rs === 'COMPLETE' || rs === 'ABORTED') && rid) {
              applyDissolutionRunEndedFromServer(st);
              return;
            }
            if (rs === 'COMPLETE' || rs === 'ABORTED') {
              applyDissolutionRunEndedFromServer(st || { runStatus: rs });
              return;
            }
            if (attempt < 24) {
              setTimeout(function () { tryEnd(attempt + 1); }, 250);
            }
          });
        };
        tryEnd(0);
      }
    });
  }

  function pollCmdEventsOnce() {
    return api('/api/hardware/disso/events?clear=1').then(function (res) {
      var events = (res && res.body && res.body.events) || [];
      handleCmdEvents(events);
      return events;
    }).catch(function () { return []; });
  }

  function startCmdEventsPolling() {
    _eventsPollRef += 1;
    if (_eventsPollTimer) return;
    pollCmdEventsOnce();
    _eventsPollTimer = setInterval(function () {
      pollCmdEventsOnce();
    }, 500);
  }

  function stopCmdEventsPolling() {
    _eventsPollRef = Math.max(0, _eventsPollRef - 1);
    if (_eventsPollRef > 0) return;
    if (_eventsPollTimer) {
      clearInterval(_eventsPollTimer);
      _eventsPollTimer = null;
    }
  }

  window.dissoStartCmdEventsPolling = startCmdEventsPolling;
  window.dissoStopCmdEventsPolling = stopCmdEventsPolling;
  window.dissoPollCmdEventsNow = pollCmdEventsOnce;

  window.dissoFetchTemps = function (poll) {
    var q = (poll === false) ? '' : '?poll=1';
    return api('/api/hardware/disso/temperature/live' + q).then(function (res) {
      return (res.body && res.body.data) || {};
    });
  };
  window.dissoFetchStatus = function (poll) {
    var q = (poll === false) ? '?poll=0' : '?poll=1';
    return api('/api/hardware/disso/status/live' + q).then(function (res) {
      return (res.body && res.body.data) || {};
    });
  };

  // Hook stirrer buttons if present
  document.addEventListener('DOMContentLoaded', function () {
    ensureResumeModal();
  });
})();
