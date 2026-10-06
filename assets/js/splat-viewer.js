/* Gaussian splat viewers: square canvases that orbit a reconstructed 3DGS scene. Within each viewer
   a draggable vertical divider separates token colors on the left from RGB on the right,
   both rendered in the same pass.

   Markup: <div class="gs-grid" data-tokens="token_colors.bin" data-pullback="1.3">
             <div class="gs-viewer" data-src="scene.bin" data-target="x,y,z"></div> …
           </div>
   A scene file holds 8 uint32 per Gaussian, read as two RGBA32UI texels:
     [x, y, z as float32 bits, RGBA8 (DC color, opacity)]
     [half2(sx, sy), half2(sz, qw), half2(qx, qy), half(qz) | token id << 16]
   token_colors.bin is the token color table, 4096 x RGBA8.
   Coordinates are the first input camera's (OpenCV: x right, y down, z forward); the viewer opens
   looking from that camera towards data-target, moved back by the grid's data-pullback factor.

   Rendering follows antimatter15/splat (MIT): every Gaussian is an instanced quad shaped by its
   projected 2D covariance, sorted front to back in a worker and blended with the "under" operator.
   Frames are drawn only when the camera, comparison split or sort order changes, or while a visible viewer
   idles: it then follows a small figure eight around the start pose (yaw +-SWAY_YAW, pitch
   +-SWAY_PITCH, on one clock from page load). Dragging, panning or zooming takes over the camera;
   SWAY_RESUME_MS after the last interaction the camera eases back onto that trajectory over
   SWAY_RETURN_MS and keeps following it.
   No sway under prefers-reduced-motion. */
(function () {
  "use strict";

  var FOV_Y = 60 * Math.PI / 180;
  var TEX_W = 2048;           // texels per row; 2 texels per Gaussian -> 1024 Gaussians per row
  var SWAY_YAW = 0.12, SWAY_PITCH = 0.05;   // radians
  var SWAY_PERIOD = 8;                      // seconds per left-right cycle; up-down runs twice as fast
  var SWAY_RESUME_MS = 1000;
  var SWAY_RETURN_MS = 1500;
  var REDUCED_MOTION = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var VERT = [
    "#version 300 es",
    "precision highp float;",
    "precision highp int;",
    "uniform highp usampler2D u_data;",
    "uniform sampler2D u_tokens;",
    "uniform mat4 u_proj, u_view;",
    "uniform vec2 u_focal, u_viewport;",
    "in vec2 a_corner;",
    "in int a_index;",
    "out vec4 v_rgb;",
    "out vec4 v_tok;",
    "out vec2 v_pos;",
    "void main() {",
    "  uint i = uint(a_index);",
    "  ivec2 t = ivec2((i & 1023u) << 1, i >> 10);",
    "  uvec4 A = texelFetch(u_data, t, 0);",
    "  vec4 cam = u_view * vec4(uintBitsToFloat(A.xyz), 1.0);",
    "  vec4 clip = u_proj * cam;",
    "  float w = 1.2 * clip.w;",
    "  if (cam.z <= 0.0 || clip.x < -w || clip.x > w || clip.y < -w || clip.y > w) {",
    "    gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return;",
    "  }",
    "  uvec4 B = texelFetch(u_data, t + ivec2(1, 0), 0);",
    "  vec2 s01 = unpackHalf2x16(B.x), s2w = unpackHalf2x16(B.y), qxy = unpackHalf2x16(B.z);",
    "  float qz = unpackHalf2x16(B.w & 0xffffu).x;",
    "  float qw = s2w.y, qx = qxy.x, qy = qxy.y;",
    "  mat3 R = mat3(1.0 - 2.0 * (qy * qy + qz * qz), 2.0 * (qx * qy + qw * qz), 2.0 * (qx * qz - qw * qy),",
    "                2.0 * (qx * qy - qw * qz), 1.0 - 2.0 * (qx * qx + qz * qz), 2.0 * (qy * qz + qw * qx),",
    "                2.0 * (qx * qz + qw * qy), 2.0 * (qy * qz - qw * qx), 1.0 - 2.0 * (qx * qx + qy * qy));",
    "  mat3 M = R * mat3(s01.x, 0.0, 0.0, 0.0, s01.y, 0.0, 0.0, 0.0, s2w.x);",
    "  mat3 Vrk = M * transpose(M);",
    "  mat3 J = mat3(u_focal.x / cam.z, 0.0, -(u_focal.x * cam.x) / (cam.z * cam.z),",
    "                0.0, -u_focal.y / cam.z, (u_focal.y * cam.y) / (cam.z * cam.z),",  // y flipped: clip y points up
    "                0.0, 0.0, 0.0);",
    "  mat3 T = transpose(mat3(u_view)) * J;",
    "  mat3 cov2d = transpose(T) * Vrk * T;",
    "  float d1 = cov2d[0][0] + 0.3, off = cov2d[0][1], d2 = cov2d[1][1] + 0.3;",
    "  float mid = 0.5 * (d1 + d2), radius = length(vec2(0.5 * (d1 - d2), off));",
    "  float l1 = mid + radius, l2 = mid - radius;",
    "  if (l2 < 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }",
    "  vec2 dir = normalize(vec2(off, l1 - d1));",
    "  vec2 major = min(sqrt(2.0 * l1), 1024.0) * dir;",
    "  vec2 minor = min(sqrt(2.0 * l2), 1024.0) * vec2(dir.y, -dir.x);",
    "  vec4 rgba = vec4((A.w) & 0xffu, (A.w >> 8) & 0xffu, (A.w >> 16) & 0xffu, A.w >> 24) / 255.0;",
    "  v_rgb = rgba;",
    "  v_tok = vec4(texelFetch(u_tokens, ivec2(int(B.w >> 16), 0), 0).rgb, rgba.a);",
    "  v_pos = a_corner;",
    "  vec2 center = clip.xy / clip.w;",
    // pixel offset = corner * sqrt(2 lambda), so exp(-|corner|^2) is the Gaussian; NDC = 2 px / viewport
    "  gl_Position = vec4(center + 2.0 * (a_corner.x * major + a_corner.y * minor) / u_viewport, 0.0, 1.0);",
    "}"
  ].join("\n");

  var FRAG = [
    "#version 300 es",
    "precision highp float;",
    "uniform vec2 u_viewport;",
    "uniform float u_split;",
    "in vec4 v_rgb;",
    "in vec4 v_tok;",
    "in vec2 v_pos;",
    "out vec4 fragColor;",
    "void main() {",
    "  float A = -dot(v_pos, v_pos);",
    "  if (A < -4.0) discard;",
    "  float x = gl_FragCoord.x / u_viewport.x;",
    "  vec4 c = x < u_split ? v_tok : v_rgb;",     // tokens left, RGB right
    "  float B = exp(A) * c.a;",
    "  fragColor = vec4(B * c.rgb, B);",
    "}"
  ].join("\n");

  // Depth sort in a worker: 16-bit counting sort of camera-space z, nearest first.
  var WORKER_SRC = "(" + function () {
    var pos = null;
    self.onmessage = function (e) {
      if (e.data.positions) { pos = e.data.positions; return; }
      if (!pos) return;
      var v = e.data.view, n = pos.length / 3, depth = new Int32Array(n);
      var lo = Infinity, hi = -Infinity, i;
      for (i = 0; i < n; i++) {
        var d = ((v[2] * pos[3 * i] + v[6] * pos[3 * i + 1] + v[10] * pos[3 * i + 2]) * 4096) | 0;
        depth[i] = d; if (d < lo) lo = d; if (d > hi) hi = d;
      }
      var scale = 65535 / Math.max(1, hi - lo), counts = new Uint32Array(65536);
      for (i = 0; i < n; i++) { depth[i] = ((depth[i] - lo) * scale) | 0; counts[depth[i]]++; }
      var starts = new Uint32Array(65536);
      for (i = 1; i < 65536; i++) starts[i] = starts[i - 1] + counts[i - 1];
      var order = new Uint32Array(n);
      for (i = 0; i < n; i++) order[starts[depth[i]]++] = i;
      self.postMessage({ order: order }, [order.buffer]);
    };
  }.toString() + ")()";

  var workerUrl = null;
  function makeWorker() {
    if (!workerUrl) workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));
    return new Worker(workerUrl);
  }

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

  // World -> camera (OpenCV) for a camera at `eye` looking at `target`, with -y as world up.
  function lookAt(eye, target) {
    var f = norm(sub(target, eye)), r = norm(cross([0, 1, 0], f)), d = cross(f, r);
    return [r[0], d[0], f[0], 0, r[1], d[1], f[1], 0, r[2], d[2], f[2], 0,
            -dot(r, eye), -dot(d, eye), -dot(f, eye), 1];
  }

  function Viewer(el, tokens, pullback) {
    this.el = el;
    this.tokens = tokens;
    this.split = 0.5;
    var t = (el.getAttribute("data-target") || "0,0,1").split(",").map(Number);
    // orbit state around the target; the start pose looks from the first input camera (at the
    // origin) towards the target, moved back by `pullback` x its distance to the target
    var dist = Math.hypot(t[0], t[1], t[2]) || 1;
    this.home = { target: t, dist: dist * pullback, yaw: Math.atan2(-t[0], t[2]), pitch: Math.asin(t[1] / dist) };
    this.reset();
    this.order = null;
    this.sorting = false;
    this.sortPending = false;
    this.frame = 0;
    this.visible = false;
    this.resumeTimer = 0;
    this.swayT0 = performance.now();
    this.motion = REDUCED_MOTION ? "user" : "sway";   // "sway" | "return" | "user"
  }

  // Pose on the automatic trajectory at time `now`: a figure eight around the start pose.
  Viewer.prototype.trajectory = function (now) {
    var h = this.home, t = 2 * Math.PI * (now - this.swayT0) / 1000 / SWAY_PERIOD;
    return { yaw: h.yaw + SWAY_YAW * Math.sin(t), pitch: h.pitch + SWAY_PITCH * Math.sin(2 * t),
             dist: h.dist, target: h.target };
  };

  // Hand the camera to the user (drag, pan, zoom).
  Viewer.prototype.stopSway = function () {
    clearTimeout(this.resumeTimer);
    this.motion = "user";
  };

  // After SWAY_RESUME_MS without interaction, ease from the current pose back onto the trajectory.
  Viewer.prototype.resumeSwayLater = function (delay) {
    var self = this;
    if (REDUCED_MOTION) return;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(function () {
      self.from = { yaw: self.yaw, pitch: self.pitch, dist: self.dist, target: self.target.slice() };
      self.returnT0 = performance.now();
      self.motion = "return";
      self.draw();
    }, delay === undefined ? SWAY_RESUME_MS : delay);
  };

  Viewer.prototype.animate = function (now) {
    var p = this.trajectory(now);
    if (this.motion === "return") {
      var u = Math.min(1, (now - this.returnT0) / SWAY_RETURN_MS), e = u * u * (3 - 2 * u), f = this.from;
      var dyaw = Math.atan2(Math.sin(p.yaw - f.yaw), Math.cos(p.yaw - f.yaw));   // shortest way round
      p = { yaw: f.yaw + e * dyaw, pitch: f.pitch + e * (p.pitch - f.pitch), dist: f.dist + e * (p.dist - f.dist),
            target: [0, 1, 2].map(function (i) { return f.target[i] + e * (p.target[i] - f.target[i]); }) };
      if (u >= 1) this.motion = "sway";
    }
    this.yaw = p.yaw; this.pitch = p.pitch; this.dist = p.dist; this.target = p.target.slice();
  };

  Viewer.prototype.reset = function () {
    var h = this.home;
    this.target = h.target.slice(); this.dist = h.dist; this.yaw = h.yaw; this.pitch = h.pitch;
  };

  Viewer.prototype.eye = function () {
    var cp = Math.cos(this.pitch), t = this.target;
    return [t[0] + this.dist * cp * Math.sin(this.yaw), t[1] - this.dist * Math.sin(this.pitch),
            t[2] - this.dist * cp * Math.cos(this.yaw)];
  };

  Viewer.prototype.start = function () {
    var self = this, el = this.el;
    var canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    el.insertBefore(canvas, el.firstChild);
    var gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true, alpha: true });
    if (!gl) { el.classList.add("is-unsupported"); return; }
    this.canvas = canvas; this.gl = gl;

    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    this.u = {};
    ["u_data", "u_tokens", "u_proj", "u_view", "u_focal", "u_viewport", "u_split"].forEach(function (n) {
      self.u[n] = gl.getUniformLocation(prog, n);
    });

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);

    var corner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]), gl.STATIC_DRAW);
    var aCorner = gl.getAttribLocation(prog, "a_corner");
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 0, 0);

    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    var aIndex = gl.getAttribLocation(prog, "a_index");
    gl.enableVertexAttribArray(aIndex);
    gl.vertexAttribIPointer(aIndex, 1, gl.INT, false, 0, 0);
    gl.vertexAttribDivisor(aIndex, 1);

    this.worker = makeWorker();
    this.worker.onmessage = function (e) {
      self.order = e.data.order;
      gl.bindBuffer(gl.ARRAY_BUFFER, self.indexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, self.order, gl.DYNAMIC_DRAW);
      self.sorting = false;
      if (self.sortPending) { self.sortPending = false; self.sort(); }
      self.draw();
    };

    Promise.all([fetch(el.getAttribute("data-src")).then(function (r) {
      if (!r.ok) throw new Error(r.status + " " + r.url);
      return r.arrayBuffer();
    }), this.tokens]).then(function (res) {
      self.upload(new Uint32Array(res[0]), res[1]);
    }).catch(function (err) {
      el.classList.add("is-error");
      if (window.console) console.error("splat viewer:", err);
    });

    this.bindComparison();
    this.bindControls();
    if ("ResizeObserver" in window) new ResizeObserver(function () { self.resize(); }).observe(el);
    // only animate while on screen
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        self.visible = entries[entries.length - 1].isIntersecting;
        if (self.visible) self.draw();
      }).observe(el);
    } else this.visible = true;
    this.resize();
  };

  Viewer.prototype.upload = function (data, lut) {
    var gl = this.gl, n = data.length / 8, rows = Math.ceil(n / 1024);
    var padded = new Uint32Array(TEX_W * rows * 4);
    padded.set(data);
    var tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, TEX_W, rows, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, padded);
    gl.uniform1i(this.u.u_data, 0);

    var ltex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ltex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 4096, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(lut));
    gl.uniform1i(this.u.u_tokens, 1);

    var f = new Float32Array(data.buffer), pos = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) { pos[3 * i] = f[8 * i]; pos[3 * i + 1] = f[8 * i + 1]; pos[3 * i + 2] = f[8 * i + 2]; }
    this.count = n;
    this.worker.postMessage({ positions: pos }, [pos.buffer]);
    this.el.classList.add("is-ready");
    this.changed();
  };

  Viewer.prototype.resize = function () {
    if (!this.canvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(this.el.clientWidth * dpr)), h = Math.max(1, Math.round(this.el.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; this.draw(); }
  };

  Viewer.prototype.view = function () { return lookAt(this.eye(), this.target); };

  Viewer.prototype.sort = function () {
    if (!this.count) return;
    if (this.sorting) { this.sortPending = true; return; }
    this.sorting = true;
    this.worker.postMessage({ view: this.view() });
  };

  Viewer.prototype.changed = function () { this.sort(); this.draw(); };

  Viewer.prototype.draw = function () {
    var self = this;
    if (this.frame) return;
    this.frame = requestAnimationFrame(function (now) {
      self.frame = 0;
      if (self.motion !== "user" && self.visible && self.order) {
        self.animate(now);
        self.sort();
        self.draw();
      }
      self.render();
    });
  };

  Viewer.prototype.render = function () {
    var gl = this.gl;
    if (!gl || !this.order) return;
    var w = this.canvas.width, h = this.canvas.height;
    var fy = 0.5 * h / Math.tan(FOV_Y / 2), fx = fy, zn = 0.01, zf = 100;
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniformMatrix4fv(this.u.u_proj, false, [2 * fx / w, 0, 0, 0, 0, -2 * fy / h, 0, 0,
                                               0, 0, zf / (zf - zn), 1, 0, 0, -(zf * zn) / (zf - zn), 0]);
    gl.uniformMatrix4fv(this.u.u_view, false, this.view());
    gl.uniform2f(this.u.u_focal, fx, fy);
    gl.uniform2f(this.u.u_viewport, w, h);
    gl.uniform1f(this.u.u_split, this.split);
    gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, this.order.length);
  };

  Viewer.prototype.bindComparison = function () {
    var self = this, el = this.el, drag = null, offset = 0;
    var handle = document.createElement("div");
    handle.className = "gs-compare";
    handle.setAttribute("role", "slider");
    handle.setAttribute("tabindex", "0");
    handle.setAttribute("aria-label", (el.getAttribute("aria-label") || "Scene").split(":")[0] + ": token/RGB comparison");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-valuemin", "0");
    handle.setAttribute("aria-valuemax", "100");
    handle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 8-4 4 4 4m6-8 4 4-4 4"/></svg>';
    el.appendChild(handle);

    function update(value) {
      self.split = Math.round(Math.max(0, Math.min(1, value)) * 1000) / 1000;
      var tokens = Math.round(self.split * 1000) / 10, rgb = Math.round((1 - self.split) * 1000) / 10;
      el.style.setProperty("--gs-split", tokens + "%");
      handle.setAttribute("aria-valuenow", tokens);
      handle.setAttribute("aria-valuetext", tokens + "% tokens, " + rgb + "% RGB");
      self.draw();
    }
    function move(e) {
      var rect = self.canvas.getBoundingClientRect();
      update((e.clientX - rect.left - offset) / Math.max(1, rect.width));
    }
    handle.addEventListener("pointerdown", function (e) {
      e.stopPropagation();
      if (e.button !== 0 || drag !== null) return;
      e.preventDefault();
      handle.focus({ preventScroll: true });
      var rect = self.canvas.getBoundingClientRect();
      offset = e.clientX - rect.left - self.split * rect.width;
      drag = e.pointerId;
      self.stopSway();
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", function (e) {
      e.stopPropagation();
      if (e.pointerId === drag) move(e);
    });
    function up(e) {
      e.stopPropagation();
      if (e.pointerId !== drag) return;
      drag = null;
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
      self.resumeSwayLater();
    }
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
    handle.addEventListener("lostpointercapture", up);
    handle.addEventListener("keydown", function (e) {
      var value = self.split;
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") value -= 0.01;
      else if (e.key === "ArrowRight" || e.key === "ArrowUp") value += 0.01;
      else if (e.key === "PageDown") value -= 0.1;
      else if (e.key === "PageUp") value += 0.1;
      else if (e.key === "Home") value = 0;
      else if (e.key === "End") value = 1;
      else return;
      e.preventDefault(); e.stopPropagation();
      self.stopSway();
      update(value);
      self.resumeSwayLater();
    });
    handle.addEventListener("dblclick", function (e) { e.stopPropagation(); });
    handle.addEventListener("wheel", function (e) { e.stopPropagation(); }, { passive: true });
    update(this.split);
  };

  Viewer.prototype.bindControls = function () {
    var self = this, el = this.el, pts = {}, mode = null, last = null, pinch = null;
    el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    el.addEventListener("pointerdown", function (e) {
      self.stopSway();
      el.setPointerCapture(e.pointerId);
      pts[e.pointerId] = [e.clientX, e.clientY];
      self.active = true;
      el.classList.add("is-active");
      var ids = Object.keys(pts);
      if (ids.length === 2) {
        var a = pts[ids[0]], b = pts[ids[1]];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
        mode = "pinch";
      } else {
        mode = (e.button === 2 || e.shiftKey || e.ctrlKey || e.metaKey) ? "pan" : "orbit";
        last = [e.clientX, e.clientY];
      }
    });
    el.addEventListener("pointermove", function (e) {
      if (!(e.pointerId in pts)) return;
      pts[e.pointerId] = [e.clientX, e.clientY];
      if (mode === "pinch") {
        var ids = Object.keys(pts); if (ids.length < 2) return;
        var a = pts[ids[0]], b = pts[ids[1]];
        var d = Math.hypot(a[0] - b[0], a[1] - b[1]), m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        self.zoom(pinch.d / Math.max(d, 1));
        self.pan(m[0] - pinch.m[0], m[1] - pinch.m[1]);
        pinch = { d: d, m: m };
      } else if (last) {
        var dx = e.clientX - last[0], dy = e.clientY - last[1];
        last = [e.clientX, e.clientY];
        if (mode === "pan") self.pan(dx, dy);
        else self.orbit(dx, dy);
      }
    });
    function up(e) {
      delete pts[e.pointerId];
      if (Object.keys(pts).length === 0) { mode = null; last = null; pinch = null; self.resumeSwayLater(); }
    }
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", function () { self.active = false; el.classList.remove("is-active"); });
    // the wheel zooms only after a click inside the viewer, so scrolling the page is never captured
    el.addEventListener("wheel", function (e) {
      if (!self.active) return;
      e.preventDefault();
      self.stopSway();
      self.zoom(Math.exp(e.deltaY * 0.0015));
      self.resumeSwayLater();
    }, { passive: false });
    // double-click: ease straight back onto the trajectory
    el.addEventListener("dblclick", function () {
      self.stopSway();
      if (REDUCED_MOTION) { self.reset(); self.changed(); } else self.resumeSwayLater(0);
    });
  };

  Viewer.prototype.orbit = function (dx, dy) {
    this.yaw -= dx * 0.006;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.006));
    this.changed();
  };

  Viewer.prototype.zoom = function (k) {
    this.dist = Math.max(0.05 * this.home.dist, Math.min(8 * this.home.dist, this.dist * k));
    this.changed();
  };

  Viewer.prototype.pan = function (dx, dy) {
    var v = this.view(), s = 2 * this.dist * Math.tan(FOV_Y / 2) / Math.max(1, this.el.clientHeight);
    var r = [v[0], v[4], v[8]], d = [v[1], v[5], v[9]], t = this.target;
    for (var i = 0; i < 3; i++) t[i] -= (r[i] * dx + d[i] * dy) * s;
    this.changed();
  };

  function boot() {
    document.querySelectorAll(".gs-grid").forEach(function (grid) {
      var lut = null;
      function tokens() {
        if (!lut) lut = fetch(grid.getAttribute("data-tokens")).then(function (r) { return r.arrayBuffer(); });
        return lut;
      }
      var viewers = Array.prototype.slice.call(grid.querySelectorAll(".gs-viewer"));
      function start(el) {
        if (el._gs) return;
        el._gs = new Viewer(el, tokens(), parseFloat(grid.getAttribute("data-pullback")) || 1);
        try { el._gs.start(); } catch (err) { el.classList.add("is-error"); if (window.console) console.error(err); }
      }
      if (!("IntersectionObserver" in window)) { viewers.forEach(start); return; }
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { start(e.target); obs.unobserve(e.target); } });
      }, { rootMargin: "300px 0px" });
      viewers.forEach(function (v) { obs.observe(v); });
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
