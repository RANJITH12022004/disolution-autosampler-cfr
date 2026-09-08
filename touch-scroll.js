/**
 * Mobile-style drag-to-scroll for Raspberry Pi Chromium kiosk.
 * Touchscreens often report as mouse pointers, so native overflow
 * pan does not work — only the scrollbar does. This polyfill lets
 * operators drag anywhere on a scrollable surface to scroll it.
 */
(function () {
  var active = null;
  var suppressClick = false;

  function closestInteractive(el) {
    if (!el || !el.closest) return null;
    return el.closest(
      'button, a, input, textarea, select, option, label, summary,' +
      '[role="button"], [contenteditable="true"],' +
      '.btn, .osk-key, #osk, #keyboard-root, .sidebar,' +
      '.reports-filter-btn, .nav-item, .user-profile'
    );
  }

  function canScroll(el) {
    if (!el || el.nodeType !== 1) return false;
    var style = window.getComputedStyle(el);
    var oy = style.overflowY;
    var ox = style.overflowX;
    var yOk = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
      el.scrollHeight > el.clientHeight + 2;
    var xOk = (ox === 'auto' || ox === 'scroll' || ox === 'overlay') &&
      el.scrollWidth > el.clientWidth + 2;
    return yOk || xOk;
  }

  function findScrollParent(start) {
    var node = start;
    while (node && node !== document.body && node !== document.documentElement) {
      if (canScroll(node)) return node;
      node = node.parentElement;
    }
    var pageContent = document.querySelector('.page-content');
    if (pageContent && canScroll(pageContent)) return pageContent;
    if (canScroll(document.scrollingElement)) return document.scrollingElement;
    return null;
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (closestInteractive(e.target)) return;

    var scroller = findScrollParent(e.target);
    if (!scroller) return;

    active = {
      scroller: scroller,
      startY: e.clientY,
      startX: e.clientX,
      startTop: scroller.scrollTop,
      startLeft: scroller.scrollLeft,
      moved: false,
      pointerId: e.pointerId,
      pointerType: e.pointerType || 'mouse'
    };
  }

  function onPointerMove(e) {
    if (!active) return;
    if (active.pointerId != null && e.pointerId !== active.pointerId) return;

    var dy = e.clientY - active.startY;
    var dx = e.clientX - active.startX;
    if (!active.moved) {
      if (Math.abs(dy) < 5 && Math.abs(dx) < 5) return;
      active.moved = true;
      suppressClick = true;
    }

    var scroller = active.scroller;
    if (Math.abs(dy) >= Math.abs(dx)) {
      scroller.scrollTop = active.startTop - dy;
    } else if (scroller.scrollWidth > scroller.clientWidth + 2) {
      scroller.scrollLeft = active.startLeft - dx;
    } else {
      scroller.scrollTop = active.startTop - dy;
    }

    if (e.cancelable) e.preventDefault();
  }

  function onPointerUp() {
    active = null;
    if (suppressClick) {
      setTimeout(function () { suppressClick = false; }, 0);
    }
  }

  function onClickCapture(e) {
    if (!suppressClick) return;
    e.preventDefault();
    e.stopPropagation();
    suppressClick = false;
  }

  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: false });
  document.addEventListener('pointerup', onPointerUp, { capture: true, passive: true });
  document.addEventListener('pointercancel', onPointerUp, { capture: true, passive: true });
  document.addEventListener('click', onClickCapture, true);
})();
