// ============================================================================
// D&D Beyond Sync — Leader to Spectator map synchronization
//
// - Leader (DM): broadcasts pointer drag (pan), wheel (zoom), and HUD zoom button clicks.
// - Spectator (viewer): blocks local pan/zoom, hides toolbar, listens to leader and replays events.
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

  // Current zoom in percent, read from the HUD's "Reset Zoom" label (e.g. "58.8%").
  function readZoom() {
    const hud = findZoomHud();
    const zoom = hud ? parseFloat(hud.reset.textContent) : NaN;
    return Number.isFinite(zoom) ? zoom : null;
  }
  

  // ---------- Tool and Cursor guards ----------
  // Toolbar buttons have a stable data-dd-action-name ("Pan Tool", "Draw Tool", ...).
  // The active one has data-active="true" or a CSS-module class ending in "__active";
  // the hash before that suffix changes between D&D Beyond releases.
  function activeToolNames() {
    return Array.from(document.querySelectorAll('button[data-dd-action-name]'))
      .filter(b => b.getAttribute('data-active') === 'true' || /__active\b/.test(b.className))
      .map(b => b.getAttribute('data-dd-action-name').toLowerCase());
  }

  function isAllowedToolActive() {
    return activeToolNames().some(name => name.includes('pan'));
  }

  // Pan and the token/sticker browsers don't interfere with panning; any other active tool does.
  function hasActiveNonAllowedTool() {
    return activeToolNames().some(name => !/pan|token browser|sticker browser/.test(name));
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
    // Listen on window and resolve the map canvas per event, since the
    // canvas can be swapped or resized after the page loads.
    function normPos(canv, clientX, clientY) {
      const r = canv.getBoundingClientRect();
      const x = (clientX - r.left) / (r.width || 1);
      const y = (clientY - r.top) / (r.height || 1);
      return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    }

    // --- Drag (pan), for both mouse and pointer events ---
    function broadcastDrag(prefix, type) {
      let canv = null;
      const send = (phase, ev) => {
        if (!canv) return;
        const n = normPos(canv, ev.clientX, ev.clientY);
        const msg = { type, ev: prefix + phase, room,
          x: n.x, y: n.y,
          button: phase === 'move' ? 0 : ev.button,
          buttons: phase === 'down' ? (ev.buttons ?? (1 << ev.button)) : ev.buttons,
          altKey: ev.altKey, ctrlKey: ev.ctrlKey, shiftKey: ev.shiftKey, metaKey: ev.metaKey
        };
        if (prefix === 'pointer') {
          Object.assign(msg, { pointerId: ev.pointerId, pointerType: ev.pointerType, pressure: ev.pressure });
        }
        try { bc.postMessage(msg); } catch {}
      };
      const sendMove = throttle(send, 8);

      window.addEventListener(prefix + 'down', (ev) => {
        // Tool checks only run here: the cursor switches to "grabbing" mid-drag.
        if (!canBroadcastPan(ev)) return;
        canv = largestCanvas();
        send('down', ev);
      }, true);

      window.addEventListener(prefix + 'move', (ev) => {
        if (!canv) return;
        // Stop if we leave the canvas or a dropdown covers it.
        if (!isPointerDirectlyOverCanvas(ev, canv)) { canv = null; return; }
        sendMove('move', ev);
      }, { passive: true, capture: true });

      window.addEventListener(prefix + 'up', (ev) => {
        send('up', ev);
        canv = null;
      }, true);
    }
    broadcastDrag('mouse', 'im_mouse');
    broadcastDrag('pointer', 'im_ptr');

    // --- Wheel (zoom) ---
    // Send the zoom level the wheel settles on instead of each wheel event. The map
    // only applies some events in a fast burst, so replaying them drifts.
    let wheelPos = null, wheelTimer = null;
    window.addEventListener('wheel', (ev) => {
      const canv = largestCanvas();
      if (!isPointerDirectlyOverCanvas(ev, canv)) return;
      wheelPos = normPos(canv, ev.clientX, ev.clientY);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => {
        const zoom = readZoom();
        if (zoom !== null) bc.postMessage({ type: 'im_zoom_level', room, zoom, x: wheelPos.x, y: wheelPos.y });
      }, 250);
    }, { passive: true, capture: true });

    // --- HUD Buttons (zoom) ---
    // The buttons can render late or be replaced, so bind any new ones periodically.
    const boundHud = new WeakSet();
    function attachHudBroadcast() {
      const hud = findZoomHud();
      if (!hud) return;
      for (const action of ['plus', 'minus', 'reset']) {
        const btn = hud[action];
        if (boundHud.has(btn)) continue;
        boundHud.add(btn);
        btn.addEventListener('click', () => bc.postMessage({ type: 'im_zoom_button', room, action }), true);
      }
    }
    attachHudBroadcast();
    setInterval(attachHudBroadcast, 2000);
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

    const toolbar = document.querySelector('button[data-dd-action-name$=" Tool"]')?.closest('[class*="__toolbar"]');
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

  // ---------- Spectator zoom matching ----------
  // Each wheel event moves the map's zoom by one fixed step, so step toward the
  // leader's level at the leader's cursor position until within half a step.
  let zoomRun = 0;
  async function zoomTo(target, clientX, clientY) {
    const run = ++zoomRun; // a newer target cancels this one
    let step = 0;
    for (let i = 0; i < 100 && run === zoomRun; i++) {
      const cur = readZoom();
      const canv = largestCanvas();
      if (cur === null || !canv) return;
      const diff = target - cur;
      if (Math.abs(diff) <= Math.max(0.5, step / 2)) return;
      dispatchWheel(canv, { clientX, clientY, deltaX: 0, deltaY: diff > 0 ? -100 : 100 });
      const next = await waitForZoomChange(cur);
      if (next === null) return; // zoom limit reached
      step = Math.abs(next - cur);
    }
  }

  function waitForZoomChange(prev, timeoutMs = 500) {
    const start = Date.now();
    return new Promise(resolve => {
      (function check() {
        const z = readZoom();
        if (z !== null && z !== prev) return resolve(z);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(check, 16);
      })();
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

    if (p.type === 'im_zoom_level') {
      zoomTo(p.zoom, clientX, clientY);
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
