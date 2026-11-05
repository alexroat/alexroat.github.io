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
    // Game input listeners: silent while the share panel is open (its clicks and keys are its own).
    const on = (type, f) => addEventListener(type, e => { if (!J.panelOpen) f(e); });

    // ---------------------------------------------------------------- keyboard → Android keycodes
    const K = {
        ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Enter: 66, NumpadEnter: 160, Space: 62,
        Escape: 111, ContextMenu: 82, MediaPlayPause: 85, Tab: 61,
    };
    for (let i = 0; i < 26; i++) K['Key' + String.fromCharCode(65 + i)] = 29 + i;
    for (let i = 0; i < 10; i++) K['Digit' + i] = 7 + i;
    // Remotes / TV browsers report some keys only through `key`.
    const KEY = {MediaPlayPause: 85, MediaPlay: 126, MediaPause: 127, Select: 23, ContextMenu: 82};

    on('keydown', e => {
        const k = K[e.code] || KEY[e.key];
        if (!k || e.metaKey || e.ctrlKey || e.altKey) return;
        e.preventDefault();
        J.unlockAudio();
        push(1, k, e.repeat ? 1 : 0, 0);
    });
    on('keyup', e => {
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
    on('touchstart', e => {
        J.unlockAudio();
        for (const t of e.changedTouches) {
            live.push({id: t.identifier, x: t.clientX, y: t.clientY});
            emit(live.length === 1 ? 0 : 5, live.length - 1);
        }
        e.preventDefault();
    }, {passive: false});
    on('touchmove', e => {
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
    on('touchend', e => end(e, false));
    on('touchcancel', e => end(e, true));
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
    on('pointerdown', mouse);
    on('pointerup', mouse);
    on('pointermove', mouse);
    on('contextmenu', e => e.preventDefault());  // the right button is the jetpack

    // Pointer lock (Android pointer capture): movement is summed and sent once per frame.
    let mdx = 0, mdy = 0;
    on('mousemove', e => {
        if (document.pointerLockElement) { mdx += e.movementX * dpr(); mdy += e.movementY * dpr(); }
    });
    document.addEventListener('pointerlockchange', () => push(8, document.pointerLockElement ? 1 : 0));

    // ---------------------------------------------------------------- tilt
    let motionOn = false;
    on('devicemotion', e => {
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

    // ---------------------------------------------------------------- share the world (picture + link)
    // The game hands over the picture (ARGB ints, as Android's Bitmap) and then the text; the panel offers
    // the system share sheet (with the picture, where the browser can), copies, download and chat links.
    J.makeShot = function (px, w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
        for (let i = 0, o = 0; i < w * h; i++, o += 4) {
            const v = px[i];
            d[o] = (v >> 16) & 255; d[o + 1] = (v >> 8) & 255; d[o + 2] = v & 255; d[o + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        J.shot = c;
    };

    J.sharePanel = function (text) {
        const shot = J.shot;
        if (!shot) { if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {}); return; }
        const jpeg = shot.toDataURL('image/jpeg', 0.88);
        const link = (text.match(/https?:\/\/\S+/) || [''])[0];
        const words = text.replace(link, '').replace(/\s*·\s*$/, '').trim();
        const blob = (type, q) => new Promise(r => shot.toBlob(r, type, q));
        J.panelOpen = true;
        const ov = document.createElement('div');
        ov.style.cssText = 'position:fixed;inset:0;z-index:20;background:rgba(5,8,20,.82);display:flex;align-items:center;'
            + 'justify-content:center;font:15px system-ui,sans-serif;color:#fff';
        const card = document.createElement('div');
        card.style.cssText = 'width:min(760px,92vw);max-height:92vh;overflow:auto;background:#161a2c;border-radius:16px;'
            + 'padding:18px;box-shadow:0 10px 40px rgba(0,0,0,.6)';
        card.innerHTML = '<div style="font:bold 20px system-ui;margin-bottom:10px">Condividi il mondo</div>'
            + '<img draggable="true" style="width:100%;border-radius:10px;display:block" alt="">'
            + '<div class="t" style="margin:12px 0;padding:10px;background:#0c0f1c;border-radius:8px;user-select:text;'
            + '-webkit-user-select:text;word-break:break-all"></div>'
            + '<div class="b" style="display:flex;flex-wrap:wrap;gap:8px"></div>'
            + '<div class="s" style="margin-top:10px;min-height:1.2em;color:#9fe0a0"></div>'
            + '<div style="margin-top:6px;color:#aab;font-size:13px">Su WhatsApp Web: copia (o trascina) l\'immagine nella chat,'
            + ' poi incolla il testo come didascalia.</div>';
        card.querySelector('img').src = jpeg;
        card.querySelector('.t').textContent = text;
        const status = card.querySelector('.s'), row = card.querySelector('.b');
        const say = m => { status.textContent = m; };
        const close = () => { ov.remove(); J.panelOpen = false; };
        const button = (label, color, f) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = 'border:0;border-radius:10px;padding:10px 14px;font:bold 14px system-ui;color:#fff;cursor:pointer;background:' + color;
            b.onclick = () => { try { f(); } catch (e) { say('Non riuscito: ' + e.message); } };
            row.appendChild(b);
        };
        const file = blob('image/jpeg', 0.88).then(b => new File([b], 'jetseed.jpg', {type: 'image/jpeg'}));
        file.then(fl => {
            if (navigator.canShare && navigator.canShare({files: [fl]})) {
                button('Condividi…', '#2a6fd0', () => navigator.share({files: [fl], text}).catch(() => {}));
                row.insertBefore(row.lastChild, row.firstChild);
            }
        });
        button('Copia immagine', '#3a7a4a', () => {
            const item = new ClipboardItem({'image/png': blob('image/png')});
            navigator.clipboard.write([item]).then(() => say('Immagine copiata: incollala nella chat'), e => say('Copia non permessa: ' + e.message));
        });
        button('Copia testo', '#3a7a4a', () => navigator.clipboard.writeText(text).then(() => say('Testo copiato'), e => say('Copia non permessa: ' + e.message)));
        button('Scarica immagine', '#55606f', () => {
            const a = document.createElement('a');
            a.href = jpeg; a.download = 'jetseed.jpg'; document.body.appendChild(a); a.click(); a.remove();
            say('Immagine scaricata');
        });
        button('WhatsApp', '#1fa855', () => window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank'));
        if (link) {
            button('Facebook', '#3b5bb5', () => window.open('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(link), '_blank'));
            button('Telegram', '#2a9bd6', () => window.open('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(words), '_blank'));
        }
        button('Apri in una nuova scheda', '#55606f', () => {
            const w = window.open('', '_blank');
            if (!w) { say('Il browser ha bloccato la nuova scheda'); return; }
            w.document.title = 'Jetseed · ' + words;
            const b = w.document.body;
            b.style.cssText = 'margin:0;background:#0b0e1a;color:#fff;font:16px system-ui,sans-serif;padding:20px';
            const im = w.document.createElement('img');
            im.src = jpeg; im.style.cssText = 'max-width:100%;border-radius:12px;display:block';
            const p = w.document.createElement('p');
            p.textContent = text; p.style.cssText = 'word-break:break-all';
            b.appendChild(im); b.appendChild(p);
        });
        button('Chiudi', '#7a3030', close);
        ov.appendChild(card);
        ov.addEventListener('click', e => { if (e.target === ov) close(); });
        ov.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
        document.body.appendChild(ov);
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
