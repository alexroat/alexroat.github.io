// Browser side of the Android shims: input events are queued here (flat numbers) and drained by WebMain
// on its own (green) thread once per frame, so Java never runs from inside a DOM callback.
//   [1, keycode, repeat, src]  key down   [2, keycode, src]  key up    (src: 0 keyboard, 1 gamepad)
//   [3, action, index, n, id, x, y, ...]  touch (device pixels)
//   [4, x, y, z]  gravity                 [5, x, y, z, rz]  gamepad axes
//   [6, visible]  page shown / hidden
//   [7, action, buttons, x, y]  mouse (Android MotionEvent action, button bits as BUTTON_PRIMARY/SECONDARY)
//   [8, locked]  pointer lock gained / lost      [9, dx, dy]  mouse movement while locked (device pixels)
window.JA = (function () {
    const J = {q: []};
    const push = (...a) => { for (const v of a) J.q.push(v); };

    // ---------------------------------------------------------------- keyboard → Android keycodes
    const K = {
        ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Enter: 66, NumpadEnter: 160, Space: 62,
        Escape: 111, ContextMenu: 82, MediaPlayPause: 85, Tab: 61,
    };
    for (let i = 0; i < 26; i++) K['Key' + String.fromCharCode(65 + i)] = 29 + i;
    for (let i = 0; i < 10; i++) K['Digit' + i] = 7 + i;
    // Remotes / TV browsers report some keys only through `key`.
    const KEY = {MediaPlayPause: 85, MediaPlay: 126, MediaPause: 127, Select: 23, ContextMenu: 82};

    addEventListener('keydown', e => {
        const k = K[e.code] || KEY[e.key];
        if (!k || e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        J.unlockAudio();
        push(1, k, e.repeat ? 1 : 0, 0);
    });
    addEventListener('keyup', e => {
        const k = K[e.code] || KEY[e.key];
        if (k) push(2, k, 0);
    });

    // ---------------------------------------------------------------- touch (on the TouchPad canvas: whole page)
    const live = [];  // active touches in order, like Android's pointer indices
    const dpr = () => devicePixelRatio || 1;
    function emit(action, index) {
        push(3, action, index, live.length);
        for (const t of live) push(t.id, t.x * dpr(), t.y * dpr());
    }
    function upd(t) {
        const p = live.find(p => p.id === t.identifier);
        if (p) { p.x = t.clientX; p.y = t.clientY; }
    }
    addEventListener('touchstart', e => {
        J.unlockAudio();
        for (const t of e.changedTouches) {
            live.push({id: t.identifier, x: t.clientX, y: t.clientY});
            emit(live.length === 1 ? 0 : 5, live.length - 1);
        }
        e.preventDefault();
    }, {passive: false});
    addEventListener('touchmove', e => {
        for (const t of e.changedTouches) upd(t);
        emit(2, 0);
        e.preventDefault();
    }, {passive: false});
    function end(e, cancel) {
        for (const t of e.changedTouches) {
            upd(t);
            const i = live.findIndex(p => p.id === t.identifier);
            if (i < 0) continue;
            emit(live.length === 1 ? (cancel ? 3 : 1) : 6, i);
            live.splice(i, 1);
        }
    }
    addEventListener('touchend', e => end(e, false));
    addEventListener('touchcancel', e => end(e, true));
    // Mouse (pointer events of type mouse only: touches are handled above). Same buttons bits as Android.
    let mouseButtons = 0;
    function mouse(e) {
        if (e.pointerType !== 'mouse') return;
        const b = e.buttons & 7;
        if (b === mouseButtons) return;
        const action = mouseButtons === 0 ? 0 : b === 0 ? 1 : 2;  // DOWN, UP, MOVE (another button changed)
        mouseButtons = b;
        if (b) J.unlockAudio();
        push(7, action, b, e.clientX * dpr(), e.clientY * dpr());
    }
    addEventListener('pointerdown', mouse);
    addEventListener('pointerup', mouse);
    addEventListener('pointermove', mouse);
    addEventListener('contextmenu', e => e.preventDefault());  // the right button is the jetpack

    // Pointer lock (Android pointer capture): movement is summed and sent once per frame.
    let mdx = 0, mdy = 0;
    addEventListener('mousemove', e => {
        if (document.pointerLockElement) { mdx += e.movementX * dpr(); mdy += e.movementY * dpr(); }
    });
    document.addEventListener('pointerlockchange', () => push(8, document.pointerLockElement ? 1 : 0));

    // ---------------------------------------------------------------- tilt
    let motionOn = false;
    addEventListener('devicemotion', e => {
        const g = e.accelerationIncludingGravity;
        if (motionOn && g && g.x !== null) push(4, g.x, g.y, g.z);
    });
    J.motion = on => {
        motionOn = on;
        // iOS asks for permission (needs a user gesture: the TILT tap is one).
        if (on && window.DeviceMotionEvent && DeviceMotionEvent.requestPermission) DeviceMotionEvent.requestPermission().catch(() => {});
    };

    // ---------------------------------------------------------------- gamepads (standard mapping) → keycodes + axes
    const PAD = {0: 96, 1: 97, 2: 99, 3: 100, 4: 102, 5: 103, 6: 104, 7: 105, 8: 109, 9: 108, 10: 106, 11: 107,
                 12: 19, 13: 20, 14: 21, 15: 22};
    const prevButtons = {}, prevAxes = {};
    J.pollGamepads = function () {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const p of pads) {
            if (!p) continue;
            const pb = prevButtons[p.index] || (prevButtons[p.index] = []);
            p.buttons.forEach((b, i) => {
                const down = b.pressed || b.value > 0.5;
                if (down !== !!pb[i] && PAD[i] !== undefined) {
                    if (down) { J.unlockAudio(); push(1, PAD[i], 0, 1); }
                    else push(2, PAD[i], 1);
                }
                pb[i] = down;
            });
            const ax = [p.axes[0] || 0, p.axes[1] || 0, p.axes[2] || 0, p.axes[3] || 0];
            const pa = prevAxes[p.index] || [];
            if (ax.some((v, i) => Math.abs(v - (pa[i] || 0)) > 0.01)) {
                push(5, ...ax);
                prevAxes[p.index] = ax;
            }
        }
    };

    // ---------------------------------------------------------------- page visibility → onPause / onResume
    document.addEventListener('visibilitychange', () => push(6, document.hidden ? 0 : 1));

    J.drain = function () {
        if (mdx || mdy) { push(9, mdx, mdy); mdx = mdy = 0; }
        const q = J.q;
        J.q = [];
        return q;
    };

    // ---------------------------------------------------------------- audio (AudioTrack)
    let ctx = null, next = 0;
    J.unlockAudio = function () {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            ctx = new AC();
        }
        if (ctx.state !== 'running') ctx.resume();
    };
    J.audioAhead = function () {
        if (!ctx || ctx.state !== 'running') return 1;  // no sound until the first key/touch: the writer waits
        return next - ctx.currentTime;
    };
    J.audioWrite = function (a, off, n, rate) {
        if (!ctx || ctx.state !== 'running') return;
        const buf = ctx.createBuffer(1, n, rate), d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = a[off + i] / 32768;
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.connect(ctx.destination);
        if (next < ctx.currentTime + 0.02) next = ctx.currentTime + 0.05;  // underrun: restart with a margin
        s.start(next);
        next += n / rate;
    };
    return J;
})();
