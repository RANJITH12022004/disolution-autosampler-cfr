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

  function ensureResumeModal() {
    if (document.getElementById('disso-resume-modal')) return;
    var wrap = document.createElement('div');
    wrap.id = 'disso-resume-modal';
    wrap.style.cssText = 'display:none;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.55);align-items:center;justify-content:center;';
    wrap.innerHTML =
      '<div style="background:#fff;max-width:520px;width:92%;padding:24px 28px;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.25);font-family:inherit;">' +
      '<h2 style="margin:0 0 12px;font-size:1.25rem;">Test in progress</h2>' +
      '<p id="disso-resume-msg" style="margin:0 0 20px;line-height:1.45;"></p>' +
      '<div style="display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap;">' +
      '<button type="button" id="disso-resume-abort" class="btn btn-secondary">Abort</button>' +
      '<button type="button" id="disso-resume-continue" class="btn btn-primary">Continue</button>' +
      '</div></div>';
    document.body.appendChild(wrap);
    document.getElementById('disso-resume-continue').onclick = function () {
      api('/api/disso/test/continue', { method: 'POST' }).then(function (res) {
        hideResumeModal();
        if (!res.ok || !(res.body && res.body.ok)) {
          if (typeof showAppModal === 'function') {
            var msg = (typeof window.friendlyHardwareError === 'function')
              ? window.friendlyHardwareError((res.body && res.body.error) || '', 'Could not continue test.')
              : ((res.body && res.body.error) || 'Could not continue test.');
            showAppModal(msg, 'Test');
          }
          return;
        }
        if (typeof goToPage === 'function') goToPage('test-run');
        startStatePolling();
        if (typeof window.dissoPollStateNow === 'function') window.dissoPollStateNow();
      });
    };
    document.getElementById('disso-resume-abort').onclick = function () {
      var doAbort = function () {
        api('/api/disso/test/claim-abort', { method: 'POST' }).then(function (res) {
          hideResumeModal();
          if (typeof goToPage === 'function') goToPage('home');
          if (res.body && res.body.reportId && typeof finishTestRunReportSaved === 'function') {
            finishTestRunReportSaved(res.body.reportId);
          }
        });
      };
      if (typeof showYesNoModal === 'function') {
        showYesNoModal('Abort the running dissolution test? It will be saved as aborted.', 'Abort Test', 'Abort', 'Cancel')
          .then(function (ok) { if (ok) doAbort(); });
      } else {
        doAbort();
      }
    };
  }

  function showResumeModal(state) {
    ensureResumeModal();
    var el = document.getElementById('disso-resume-modal');
    var msg = document.getElementById('disso-resume-msg');
    var starter = (state.startedBy && (state.startedBy.name || state.startedBy.username)) || 'Another user';
    var product = state.productName || 'Dissolution test';
    var step = ((state.stepIndex || 0) + 1) + '/' + (state.stepCount || '?');
    var status = state.runStatus || 'RUNNING';
    msg.textContent = starter + ' started "' + product + '" (Step ' + step + '). Status: ' + status +
      '. Continue the test or abort it. All operators are recorded on the report.';
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

  function applyStateToUi(st) {
    if (!st) return;
    window._dissoServerState = st;
    if (typeof _dtSetText === 'function') {
      if (st.stepCount != null) {
        var stepLabel = ((st.stepIndex || 0) + 1) + ' / ' + st.stepCount;
        _dtSetText('dt-current-step', stepLabel);
        _dtSetText('dt-step', stepLabel);
      }
      if (st.remainingSecInStep != null) {
        var remHms = (typeof formatHms === 'function')
          ? formatHms(st.remainingSecInStep)
          : (typeof _dtFormatHms === 'function' ? _dtFormatHms(st.remainingSecInStep) : String(st.remainingSecInStep) + 's');
        if (window._dissolutionTest) {
          window._dissolutionTest.remainingSec = st.remainingSecInStep;
        }
        // Left Step Timer only — live remaining for current step.
        _dtSetText('dt-hero-timer', remHms);
      }
      if (st.setSecInStep != null) {
        if (window._dissolutionTest) {
          window._dissolutionTest.setSec = st.setSecInStep;
        }
      }
      // Total Duration + Step Duration tiles from local recipe / step set length.
      if (typeof _dtRefreshDurationTiles === 'function') {
        _dtRefreshDurationTiles();
      } else if (st.setSecInStep != null) {
        var setHms = (typeof formatHms === 'function')
          ? formatHms(st.setSecInStep)
          : (typeof _dtFormatHms === 'function' ? _dtFormatHms(st.setSecInStep) : String(st.setSecInStep) + 's');
        _dtSetText('dt-step-duration', setHms);
      }
      if (st.runStatus) {
        var label = st.runStatus;
        if (typeof _dtSetStatus === 'function') _dtSetStatus(label, String(label).toLowerCase());
      }
    }
    var temps = st.temps || {};
    applyLiveTempsToUi(temps);
    if (st.runStatus === 'COMPLETE' || st.runStatus === 'ABORTED') {
      stopStatePolling();
      disarmAutoTemp('test-ended');
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
    // Pull server state every 2s while a test is live (UART-2 temps via auto stream + UI poll).
    _pollTimer = setInterval(function () {
      fetchStateNow();
    }, 2000);
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
