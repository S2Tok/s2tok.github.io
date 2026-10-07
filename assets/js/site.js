/* Scene viewer: one player + a scrollable thumbnail strip.
   Markup: <figure data-scene-viewer> with a <video>, a .scene-strip of <a class="scene-thumb"
   href="clip.mp4" data-poster="…" data-title="…"> links and an optional [data-scene-title].
   Without JavaScript the first clip loops and every thumbnail links to its clip.
   While on screen, the strip drifts slowly from end to end and back (DRIFT_PX_S). The mouse over the
   strip holds the drift and leaving it lets it continue; touching or scrolling the strip pauses it for
   DRIFT_RESUME_MS. With a mouse, thumbnails near the cursor magnify like a dock (MAG_*). No drift or
   magnification under prefers-reduced-motion. */
(function () {
  "use strict";

  var DRIFT_PX_S = 24;          // strip drift speed, CSS px per second
  var DRIFT_END_PAUSE_MS = 1200; // rest at either end before turning back
  var DRIFT_RESUME_MS = 2500;
  var MAG_MAX = 0.28;           // extra scale of the thumbnail under the cursor
  var MAG_RADIUS = 2.2;         // falloff radius, in thumbnail widths

  function initSceneViewer(root) {
    var video = root.querySelector("video");
    var strip = root.querySelector(".scene-strip");
    var title = root.querySelector("[data-scene-title]");
    var thumbs = Array.prototype.slice.call(root.querySelectorAll(".scene-thumb"));
    if (!video || !strip || !thumbs.length) return;
    var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var current = 0;
    var drift = initDrift(strip, reduced);
    if (!reduced) initMagnify(strip, thumbs);

    function show(i, play, center) {
      current = (i + thumbs.length) % thumbs.length;
      var t = thumbs[current];
      thumbs.forEach(function (b, k) {
        b.classList.toggle("is-active", k === current);
        if (k === current) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current");
      });
      video.poster = t.getAttribute("data-poster") || "";
      video.src = t.getAttribute("href");
      video.setAttribute("aria-label", t.getAttribute("data-title") || "");
      if (title) title.textContent = t.getAttribute("data-title") || "";
      // centre the chosen thumbnail in the strip (without scrolling the page), unless the strip is drifting
      if (center || !drift.running()) {
        strip.scrollTo({ left: t.offsetLeft - (strip.clientWidth - t.offsetWidth) / 2, behavior: reduced ? "auto" : "smooth" });
      }
      if (play) { var p = video.play(); if (p && p.catch) p.catch(function () {}); }
    }

    // advance to the next scene when a clip ends (the static HTML loops the first clip instead)
    video.loop = false;
    video.addEventListener("ended", function () { show(current + 1, true); });
    thumbs.forEach(function (t, k) {
      t.addEventListener("click", function (e) { e.preventDefault(); show(k, true, true); });
    });
    strip.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        drift.pause();
        show(current + (e.key === "ArrowRight" ? 1 : -1), true, true);
        drift.resumeLater();
        thumbs[current].focus({ preventScroll: true });
      }
    });
  }

  // Slow ping-pong drift of a horizontally scrolling strip.
  function initDrift(strip, reduced) {
    var api = { running: function () { return false; }, pause: function () {}, resumeLater: function () {} };
    if (reduced) return api;
    var paused = false, hovering = false, visible = true, dir = 1, pos = strip.scrollLeft;
    var last = 0, restUntil = 0, timer = 0, frame = 0;

    function tick(now) {
      frame = 0;
      if (paused || hovering || !visible) { last = 0; return; }
      var max = strip.scrollWidth - strip.clientWidth;
      if (max > 0 && now >= restUntil) {
        if (last) pos += dir * DRIFT_PX_S * (now - last) / 1000;
        if (dir > 0 && pos >= max) { pos = max; dir = -1; restUntil = now + DRIFT_END_PAUSE_MS; }
        else if (dir < 0 && pos <= 0) { pos = 0; dir = 1; restUntil = now + DRIFT_END_PAUSE_MS; }
        strip.scrollLeft = Math.round(pos);
      }
      last = now >= restUntil ? now : 0;
      frame = requestAnimationFrame(tick);
    }
    function start() { if (!frame) { pos = strip.scrollLeft; last = 0; frame = requestAnimationFrame(tick); } }
    api.running = function () { return !paused && !hovering && visible; };
    api.pause = function () { paused = true; clearTimeout(timer); };
    api.resumeLater = function () {
      clearTimeout(timer);
      timer = setTimeout(function () { paused = false; start(); }, DRIFT_RESUME_MS);
    };

    // mouse over the strip holds the drift; leaving it continues right away
    strip.addEventListener("pointerenter", function (e) { if (e.pointerType === "mouse") hovering = true; });
    strip.addEventListener("pointerleave", function (e) {
      if (e.pointerType !== "mouse") return;
      hovering = false; paused = false; clearTimeout(timer); start();
    });
    // touch or wheel scrolling moves the strip by hand: pause, then continue from there
    strip.addEventListener("touchstart", function () { api.pause(); api.resumeLater(); }, { passive: true });
    strip.addEventListener("wheel", function () { if (!hovering) { api.pause(); api.resumeLater(); } }, { passive: true });
    if ("IntersectionObserver" in window) {
      new IntersectionObserver(function (entries) {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) start();
      }).observe(strip);
    }
    start();
    return api;
  }

  // Dock-style magnification: each thumbnail scales by a cosine falloff of its distance to the cursor,
  // and the thumbnails are spread so they do not overlap while the point under the cursor stays put.
  // Transforms only, so the strip's layout and scroll width never change.
  function initMagnify(strip, thumbs) {
    if (!(window.matchMedia && window.matchMedia("(hover: hover)").matches) || thumbs.length < 2) return;
    function magnify(clientX) {
      var w = thumbs[0].offsetWidth, gap = thumbs[1].offsetLeft - thumbs[0].offsetLeft - w;
      var x = clientX - strip.getBoundingClientRect().left + strip.scrollLeft;   // in content coordinates
      var base = thumbs.map(function (t) { return t.offsetLeft; });
      var scale = base.map(function (l) {
        var d = Math.abs(l + w / 2 - x) / w;
        return 1 + (d < MAG_RADIUS ? MAG_MAX * 0.5 * (1 + Math.cos(Math.PI * d / MAG_RADIUS)) : 0);
      });
      var k = 0;
      for (var i = 0; i < base.length; i++) if (Math.abs(base[i] + w / 2 - x) < Math.abs(base[k] + w / 2 - x)) k = i;
      var frac = Math.max(0, Math.min(1, (x - base[k]) / w));
      var pos = [], acc = base[0];
      for (i = 0; i < base.length; i++) { pos.push(acc); acc += w * scale[i] + gap; }
      var shift = (base[k] + frac * w) - (pos[k] + frac * w * scale[k]);
      thumbs.forEach(function (t, j) {
        t.style.transform = "translateX(" + (pos[j] + shift - base[j]).toFixed(2) + "px) scale(" + scale[j].toFixed(3) + ")";
        t.style.zIndex = scale[j] > 1.001 ? "1" : "";
      });
    }
    strip.addEventListener("pointermove", function (e) { if (e.pointerType === "mouse") magnify(e.clientX); });
    strip.addEventListener("pointerleave", function () {
      thumbs.forEach(function (t) { t.style.transform = ""; t.style.zIndex = ""; });
    });
  }

  // Video with sound: start with sound where the autoplay policy allows it; otherwise play muted and
  // turn the sound on at the first click or key press anywhere.
  // Plays only while on screen.
  function initSoundVideo(frame) {
    var video = frame.querySelector("video");
    if (!video) return;
    var visible = false;
    function unmute() { video.muted = false; if (visible) video.play().catch(function () {}); }
    function play() {
      video.muted = false;
      var p = video.play();
      if (!p || !p.catch) return;
      p.catch(function () {
        video.muted = true;
        video.play().catch(function () {});
        // the first click or key press anywhere turns the sound on; clicks on the video itself are
        // left to its own controls (their mute button would otherwise toggle straight back)
        var types = ["pointerdown", "keydown"];
        function once(e) {
          if (e.target === video) return;
          types.forEach(function (t) { document.removeEventListener(t, once, true); });
          if (video.muted) unmute();
        }
        types.forEach(function (t) { document.addEventListener(t, once, true); });
      });
    }
    var started = false;
    if (!("IntersectionObserver" in window)) { play(); return; }
    new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) {
        if (!started) { started = true; play(); } else video.play().catch(function () {});
      } else video.pause();
    }, { threshold: 0.25 }).observe(frame);
  }

  function boot() {
    document.querySelectorAll("[data-scene-viewer]").forEach(initSceneViewer);
    document.querySelectorAll("[data-sound-video]").forEach(initSoundVideo);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
