// ============================================================================
// D&D Beyond Sync — Leader to Spectator map synchronization
//
// - Leader (DM): broadcasts pointer drag (pan), wheel (zoom), and HUD zoom button clicks.
// - Spectator (viewer): blocks local pan/zoom, hides toolbar, listens to leader and replays events.
// - Spectator mode: add ?spectator=true to the URL.
// - Room scope: derived from /games/<id>. If not found, uses full path and origin.
//
// Created by Nicolai D. Madsen (@nicodm13) 2025
// ============================================================================

(() => {
  // ---------- Role & Room ----------
  const sp = new URL(location.href).searchParams;
  const isSpectator = /^(1|true|yes)$/i.test((sp.get('spectator') ?? '').toString());
  const role = isSpectator ? 'follower' : 'leader';

  const room = (() => {
    const m = location.pathname.match(/\/games\/(\d+)/i);
    return m ? `game-${m[1]}` : `path:${location.origin}${location.pathname}`;
  })();

  // ---------- Role label ----------
  (function showRoleChip() {
    const chip = document.createElement('div');
    chip.style.cssText = `
      position: fixed; left: 10px; bottom: 10px; z-index: 2147483647;
      padding: 6px 10px; border-radius: 8px;
      font: 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #fff; pointer-events: none; user-select: none;
      box-shadow: 0 2px 10px rgba(0,0,0,.35);
      background: ${role === 'leader' ? 'rgba(0,128,255,.9)' : 'rgba(0,180,90,.9)'};
    `;
    chip.textContent = role === 'leader' ? 'Leader' : 'Spectator';
    document.documentElement.appendChild(chip);
  })();

  if (!('BroadcastChannel' in window)) return;
  const bc = new BroadcastChannel(`ddb-mirror:${room}`);

  // ---------- Bypass flag for spectator reset ----------
  let __spectatorHudBypass = false;

  // ---------- Canvas helpers ----------
  function largestCanvas(doc = document) {
    const canvases = Array.from(doc.querySelectorAll('canvas'));
    if (!canvases.length) return null;
    let best = null, bestArea = 0;
    for (const c of canvases) {
      const r = c.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area > bestArea) { best = c; bestArea = area; }
    }
    return best;
  }

  function findZoomHud(root = document) {
    const reset = root.querySelector('button[aria-label="Reset Zoom"]');
    const plus  = root.querySelector('button[aria-label="Zoom In"]');
    const minus = root.querySelector('button[aria-label="Zoom Out"]');
    if (!reset || !plus || !minus) return null;

    const synthClick = (btn) => {
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      btn.click();
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    };

    return { plus, minus, reset, synthClick };
  }
  

  // ---------- Tool and Cursor guards ----------
  function isAllowedToolActive() {
    const active = Array.from(document.querySelectorAll('button.variations_active__TdNXJ'));
    if (active.some(b => (b.getAttribute('data-dd-action-name')||'').toLowerCase().includes('pan'))) return true;
    const panBtn = document.querySelector('button[data-dd-action-name*="Pan"][data-active="true"], button[data-tooltip-id="pan"][data-active="true"]');
    return !!panBtn;
  }

  function hasActiveNonAllowedTool() {
    const active = Array.from(document.querySelectorAll('button.variations_active__TdNXJ'));
    if (active.length === 0) return false;

    return !active.every(btn => {
      const name = (btn.getAttribute('data-dd-action-name') || '').toLowerCase();
      const tip  = (btn.getAttribute('data-tooltip-id') || '').toLowerCase();

      // Allowed actives
      if (name.includes('pan')) return true;
      if (tip === 'token-browser' || tip === 'sticker-browser') return true;

      // Everything else is blocking
      return false; 
    });
  }

  function isGrabbingCursor() {
    const cur = (getComputedStyle(document.body).cursor || '').toLowerCase();
    if (!cur) return false;
    return /grab|grabb|grap|grapp/.test(cur);
  }

  // ---------- "Raycast" to canvas ----------
  function isPointerDirectlyOverCanvas(ev, canv) {
    if (!canv) return false;
    const r = canv.getBoundingClientRect();
    if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) {
      return false;
    }
    const top = document.elementFromPoint(ev.clientX, ev.clientY);
    // Canvas has no DOM children, so we require a direct hit on the <canvas> node.
    return top === canv;
  }

  function throttle(fn, ms) {
    let t = 0, id = null, lastArgs, lastThis;
    return function(...args) {
      const now = Date.now();
      lastArgs = args; lastThis = this;
      if (now - t >= ms) { t = now; fn.apply(lastThis, lastArgs); }
      else if (!id) id = setTimeout(() => {
        id = null; t = Date.now(); fn.apply(lastThis, lastArgs);
      }, ms - (now - t));
    };
  }

  function canBroadcastPan(ev = null) {
    // If the UI is in a grabbing state AND the Pan tool is NOT active; block.
    if (isGrabbingCursor() && !isAllowedToolActive()) return false;

    // If any non-pan tool is currently active; block.
    if (hasActiveNonAllowedTool()) return false;

    // If an event is provided, require a direct canvas hit (prevents dropdown/overlay cases).
    if (ev) {
      const canv = largestCanvas();
      if (!isPointerDirectlyOverCanvas(ev, canv)) return false;
    }

    // Allow the pan broadcast.
    return true; 
  }

  // ---------- Synth dispatch helpers ----------
  function dispatchMouse(el, type, opts) {
    const e = new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: opts.clientX, clientY: opts.clientY,
      button: opts.button ?? 0, buttons: opts.buttons ?? 0,
      altKey: !!opts.altKey, ctrlKey: !!opts.ctrlKey, shiftKey: !!opts.shiftKey, metaKey: !!opts.metaKey
    });
    el.dispatchEvent(e);
  }
  function dispatchWheel(el, opts) {
    const e = new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true,
      clientX: opts.clientX, clientY: opts.clientY,
      deltaX: opts.deltaX, deltaY: opts.deltaY, deltaMode: 0,
      altKey: !!opts.altKey, ctrlKey: !!opts.ctrlKey, shiftKey: !!opts.shiftKey, metaKey: !!opts.metaKey
    });
    el.dispatchEvent(e);
  }
  function dispatchPointer(target, type, opts) {
    const E = window.PointerEvent || MouseEvent;
    const e = new E(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: opts.clientX, clientY: opts.clientY,
      button: opts.button ?? 0, buttons: opts.buttons ?? 0,
      altKey: !!opts.altKey, ctrlKey: !!opts.ctrlKey, shiftKey: !!opts.shiftKey, metaKey: !!opts.metaKey,
      pointerId: opts.pointerId ?? 1,
      pointerType: opts.pointerType ?? 'mouse',
      isPrimary: true,
      pressure: opts.pressure ?? ((type === 'pointerdown' || opts.buttons) ? 0.5 : 0),
    });
    target.dispatchEvent(e);
  }
  function fanOutDispatch(type, opts, canv) {
    const mouseType = type.replace('pointer','mouse');
    if (type.endsWith('down')) {
      dispatchMouse(canv, mouseType, opts);
    } else if (type.endsWith('move') || type.endsWith('up')) {
      dispatchMouse(canv, mouseType, opts);
      dispatchMouse(document, mouseType, opts);
      dispatchMouse(window,   mouseType, opts);
    }
    if (type.endsWith('down')) {
      dispatchPointer(canv, type, opts);
    } else if (type.endsWith('move') || type.endsWith('up')) {
      dispatchPointer(canv, type, opts);
      dispatchPointer(document, type, opts);
      dispatchPointer(window,   type, opts);
    }
  }

  // ---------- Input Synchronization ----------
  if (role === 'leader') {
    function attachLeader() {
      const target = largestCanvas();
      if (!target) { setTimeout(attachLeader, 800); return; }

      function normPos(clientX, clientY) {
        const r = target.getBoundingClientRect();
        const x = (clientX - r.left) / (r.width || 1);
        const y = (clientY - r.top) / (r.height || 1);
        return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
      }

      // --- Mouse drag (pan) ---
      let dragging = false;
      target.addEventListener('mousedown', (ev) => {
        if (!canBroadcastPan(ev)) return;
        dragging = true;
        const n = normPos(ev.clientX, ev.clientY);
        bc.postMessage({ type: 'im_mouse', ev: 'mousedown', room,
          x: n.x, y: n.y, button: ev.button, buttons: ev.buttons ?? (1 << ev.button),
          altKey: ev.altKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey
        });
      });

      const sendMouseMove = throttle((payload) => { try { bc.postMessage(payload); } catch {} }, 8);
      window.addEventListener('mousemove', (ev) => {
        if (!dragging) return;
        // stop broadcasting if we leave the canvas or a dropdown covers it
        if (!isPointerDirectlyOverCanvas(ev, target)) { dragging = false; return; }
        if (!canBroadcastPan()) { dragging = false; return; }
        const n = normPos(ev.clientX, ev.clientY);
        sendMouseMove({ type: 'im_mouse', ev: 'mousemove', room,
          x: n.x, y: n.y, button: 0, buttons: ev.buttons,
          altKey: ev.altKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey
        });
      }, { passive: true });

      window.addEventListener('mouseup', (ev) => {
        if (!dragging) return;
        dragging = false;
        if (!isPointerDirectlyOverCanvas(ev, target)) return;
        if (!canBroadcastPan()) return;
        const n = normPos(ev.clientX, ev.clientY);
        bc.postMessage({ type: 'im_mouse', ev: 'mouseup', room,
          x: n.x, y: n.y, button: ev.button, buttons: ev.buttons,
          altKey: ev.altKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey
        });
      });

      // --- Pointer drag (pan) ---
      let pDragging = false;
      target.addEventListener('pointerdown', (ev) => {
        if (!canBroadcastPan(ev)) return;
        pDragging = true;
        const n = normPos(ev.clientX, ev.clientY);
        bc.postMessage({ type: 'im_ptr', ev: 'pointerdown', room,
          x: n.x, y: n.y, button: ev.button, buttons: ev.buttons ?? (1 << ev.button),
          altKey: ev.altKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey,
          pointerId: ev.pointerId, pointerType: ev.pointerType, pressure: ev.pressure
        });
      });

      const sendPtrMove = throttle((payload) => { try { bc.postMessage(payload); } catch {} }, 8);
      window.addEventListener('pointermove', (ev) => {
        if (!pDragging) return;
        if (!isPointerDirectlyOverCanvas(ev, target)) { pDragging = false; return; }
        if (!canBroadcastPan()) { pDragging = false; return; }
        const n = normPos(ev.clientX, ev.clientY);
        sendPtrMove({ type: 'im_ptr', ev: 'pointermove', room,
          x: n.x, y: n.y, button: 0, buttons: ev.buttons,
          altKey: ev.altKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey,
          pointerId: ev.pointerId, pointerType: ev.pointerType, pressure: ev.pressure
        });
      }, { passive: true });

      window.addEventListener('pointerup', (ev) => {
        if (!pDragging) return;
        pDragging = false;
        if (!isPointerDirectlyOverCanvas(ev, target)) return;
        if (!canBroadcastPan()) return;
        const n = normPos(ev.clientX, ev.clientY);
        bc.postMessage({ type: 'im_ptr', ev: 'pointerup', room,
          x: n.x, y: n.y, button: ev.button, buttons: ev.buttons,
          altKey: ev.altKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey,
          pointerId: ev.pointerId, pointerType: ev.pointerType, pressure: ev.pressure
        });
      });

      // --- Wheel (zoom) ---
      const sendWheel = throttle((payload) => { try { bc.postMessage(payload); } catch {} }, 8);
      window.addEventListener('wheel', (ev) => {
        if (!isPointerDirectlyOverCanvas(ev, target)) return;

        const n = normPos(ev.clientX, ev.clientY);
        sendWheel({ type: 'im_wheel', room,
          x: n.x, y: n.y,
          deltaX: ev.deltaX, deltaY: ev.deltaY,
          altKey: ev.altKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey
        });
      }, { passive: true });

      // --- HUD Buttons (zoom) ---
      function attachHudBroadcast() {
        const hud = findZoomHud();
        if (!hud) return false;
        const sendHud = (action) => bc.postMessage({ type: 'im_zoom_button', room, action });
        hud.plus.addEventListener('click',  () => sendHud('plus'),  true);
        hud.minus.addEventListener('click', () => sendHud('minus'), true);
        hud.reset.addEventListener('click', () => sendHud('reset'), true);
        return true;
      }
      attachHudBroadcast();

      const check = setInterval(() => {
        if (!document.contains(target)) { clearInterval(check); attachLeader(); return; }
        if (!findZoomHud()) attachHudBroadcast();
      }, 2000);
      window.addEventListener('beforeunload', () => clearInterval(check));
    }
    attachLeader();
  }

  // ---------- Spectator Input Block ----------
  function blockSpectatorInteractions() {
    if (role !== 'follower') return;

    const target = largestCanvas();
    if (!target) return;

    try { target.style.touchAction = 'none'; } catch {}

    const stopTrusted = (e) => {
      if (__spectatorHudBypass) return;
      if (!e.isTrusted) return;
      if (e.target !== target && !target.contains(e.target)) return;
      e.stopImmediatePropagation();
      if ('preventDefault' in e) e.preventDefault();
      return false;
    };

    target.addEventListener('wheel', stopTrusted, { capture: true, passive: false });
    ['mousedown','mousemove','mouseup','contextmenu','dragstart',
     'pointerdown','pointermove','pointerup']
      .forEach(t => target.addEventListener(t, stopTrusted, { capture: true }));
  }

  // ---------- Spectator UI Modifications ----------
  function enforceSpectatorHudAndToolbar() {
    const hud = findZoomHud();
    if (hud) {
      hud.plus.style.display = 'none';
      hud.minus.style.display = 'none';
      hud.reset.setAttribute('aria-disabled', 'true');
      hud.reset.tabIndex = -1;
      hud.reset.style.pointerEvents = 'none';
      hud.reset.style.opacity = '0.7';
      const block = (e) => {
        if (__spectatorHudBypass) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        return false;
      };
      ['click','mousedown','mouseup','keydown'].forEach(t =>
        hud.reset.addEventListener(t, block, true)
      );
    }

    const toolbar = document.querySelector('.styles_toolbarPlayer__U4Dop');
    if (toolbar) toolbar.style.display = 'none';
  }

  if (role === 'follower') {
    enforceSpectatorHudAndToolbar();
    blockSpectatorInteractions();

    const obs = new MutationObserver(() => {
      enforceSpectatorHudAndToolbar();
      blockSpectatorInteractions();
    });
    obs.observe(document.documentElement, { subtree: true, childList: true });

    window.addEventListener('load', () => {
      enforceSpectatorHudAndToolbar();
      blockSpectatorInteractions();
    });
  }

  // ---------- Message handling ----------
  bc.onmessage = (ev) => {
    const p = ev.data;
    if (!p || p.room !== room) return;
    if (role !== 'follower') return;

    const canv = largestCanvas();
    const r = canv ? canv.getBoundingClientRect() : { left: 0, top: 0, width: 1, height: 1 };
    const clientX = r.left + (p.x * r.width);
    const clientY = r.top + (p.y * r.height);

    if (p.type === 'im_mouse' && canv) {
      const opts = {
        clientX, clientY,
        button: p.button, buttons: p.buttons,
        altKey: p.altKey, ctrlKey: p.ctrlKey, shiftKey: p.shiftKey, metaKey: p.metaKey
      };
      if (p.ev === 'mousedown') {
        dispatchMouse(canv, 'mousedown', opts);
        dispatchPointer(canv, 'pointerdown', { ...opts, pointerType: 'mouse' });
      } else if (p.ev === 'mousemove') {
        fanOutDispatch('pointermove', { ...opts, pointerType: 'mouse' }, canv);
      } else if (p.ev === 'mouseup') {
        fanOutDispatch('pointerup',   { ...opts, pointerType: 'mouse' }, canv);
      }
      return;
    }

    if (p.type === 'im_ptr' && canv) {
      const opts = {
        clientX, clientY,
        button: p.button, buttons: p.buttons,
        altKey: p.altKey, ctrlKey: p.ctrlKey, shiftKey: p.shiftKey, metaKey: p.metaKey,
        pointerId: p.pointerId, pointerType: p.pointerType, pressure: p.pressure
      };
      if (p.ev === 'pointerdown') {
        dispatchPointer(canv, 'pointerdown', opts);
        dispatchMouse(canv, 'mousedown', opts);
      } else if (p.ev === 'pointermove') {
        fanOutDispatch('pointermove', opts, canv);
      } else if (p.ev === 'pointerup') {
        fanOutDispatch('pointerup', opts, canv);
      }
      return;
    }

    if (p.type === 'im_wheel' && canv) {
      dispatchWheel(canv, {
        clientX, clientY,
        deltaX: p.deltaX, deltaY: p.deltaY,
        altKey: p.altKey, ctrlKey: p.ctrlKey, shiftKey: p.shiftKey, metaKey: p.metaKey
      });
      return;
    }

    if (p.type === 'im_zoom_button') {
      const hud = findZoomHud();
      if (!hud) return;
      if (p.action === 'plus')  hud.synthClick(hud.plus);
      if (p.action === 'minus') hud.synthClick(hud.minus);
      if (p.action === 'reset') {
        __spectatorHudBypass = true;
        try { hud.synthClick(hud.reset); }
        finally { setTimeout(() => { __spectatorHudBypass = false; }, 0); }
      }
    }
  };
})();
