// WebGL side of the GLES20 shim (web/shim/android/opengl/GLES20.java).
// GL ES names objects with integers, WebGL with JS objects: JGL.o maps one to the other (0 = none),
// JGL.u does the same for uniform locations (-1 = not found, as in GL).
window.JGL = (function () {
    const J = {gl: null, o: [null], u: [], scratch: [], on: [], real: [], prog: null};

    J.init = function (canvas) {
        const gl = canvas.getContext('webgl2', {antialias: true, alpha: false, depth: true});
        if (!gl) throw new Error('WebGL2 non disponibile');
        J.gl = gl;
        return gl;
    };
    J.add = function (obj) { J.o.push(obj); return J.o.length - 1; };
    J.get = function (id) { return id ? J.o[id] : null; };
    J.uniform = function (prog, name) {
        const l = J.gl.getUniformLocation(prog, name);
        if (l === null) return -1;
        J.u.push(l);
        return J.u.length - 1;
    };

    // GL ES ignores an enabled attribute array the current program does not read, even if its buffer was
    // deleted; WebGL rejects the whole draw (INVALID_OPERATION). So glEnable/DisableVertexAttribArray only
    // record the wish, and before each draw just the arrays the program actually uses are really enabled.
    J.sync = function () {
        const gl = J.gl, p = J.prog;
        if (!p) return;
        let used = p.__used;
        if (!used) {
            used = p.__used = [];
            const n = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
            for (let i = 0; i < n; i++) used[gl.getAttribLocation(p, gl.getActiveAttrib(p, i).name)] = true;
        }
        for (let i = 0; i < 16; i++) {
            const want = !!(J.on[i] && used[i]);
            if (want !== !!J.real[i]) {
                J.real[i] = want;
                if (want) gl.enableVertexAttribArray(i); else gl.disableVertexAttribArray(i);
            }
        }
    };

    // GL ES 2 + OES_depth_texture take an unsized DEPTH_COMPONENT; WebGL2 wants the sized format.
    J.texImageEmpty = function (t, level, internal, w, h, border, format, type) {
        const gl = J.gl;
        if (internal === gl.DEPTH_COMPONENT) internal = type === gl.UNSIGNED_SHORT ? gl.DEPTH_COMPONENT16 : gl.DEPTH_COMPONENT24;
        gl.texImage2D(t, level, internal, w, h, border, format, type, null);
    };

    // Android pixels are ARGB ints; WebGL wants RGBA bytes.
    J.texImageArgb = function (t, level, px, w, h) {
        const out = new Uint8Array(w * h * 4);
        for (let i = 0, o = 0; i < px.length; i++, o += 4) {
            const c = px[i];
            out[o] = (c >> 16) & 255; out[o + 1] = (c >> 8) & 255; out[o + 2] = c & 255; out[o + 3] = (c >>> 24) & 255;
        }
        J.gl.pixelStorei(J.gl.UNPACK_ALIGNMENT, 1);
        J.gl.texImage2D(t, level, J.gl.RGBA, w, h, 0, J.gl.RGBA, J.gl.UNSIGNED_BYTE, out);
    };

    // glVertexAttribPointer with a client-side array: upload into a per-attribute scratch buffer.
    J.clientAttrib = function (i, n, type, norm, stride, data) {
        const gl = J.gl;
        const prev = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
        const b = J.scratch[i] || (J.scratch[i] = gl.createBuffer());
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
        gl.vertexAttribPointer(i, n, type, norm, stride, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, prev);
    };
    return J;
})();
