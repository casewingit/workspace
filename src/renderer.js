// renderer.js — 타임라인을 캔버스에 실시간 합성하고 MediaRecorder로 녹화합니다.
// 미리보기(preview)와 최종 렌더(record)가 같은 재생 루프를 공유합니다.

function pickMime() {
  const cands = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  for (const c of cands) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "video/webm";
}

export class RenderEngine {
  constructor(canvas, plan, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.plan = plan; // { segments, totalDuration, beat }
    this.width = opts.width || 1280;
    this.height = opts.height || 720;
    this.fps = opts.fps || 30;
    this.music = opts.music || null; // { url, gainFade }
    canvas.width = this.width;
    canvas.height = this.height;

    this.resources = new Map(); // item.id -> {type, el, w, h}
    this.live = new Set();
    this._raf = null;
    this._stopFlag = false;
  }

  async _loadResources() {
    const jobs = [];
    for (const seg of this.plan.segments) {
      const item = seg.media;
      if (this.resources.has(item.id)) continue;
      if (item.kind === "photo") {
        jobs.push(
          new Promise((res) => {
            const img = new Image();
            img.onload = () => {
              this.resources.set(item.id, {
                type: "photo",
                el: img,
                w: img.naturalWidth,
                h: img.naturalHeight,
              });
              res();
            };
            img.onerror = () => res();
            img.src = item.url;
          })
        );
      } else {
        jobs.push(
          new Promise((res) => {
            const v = document.createElement("video");
            v.src = item.url;
            v.muted = true;
            v.playsInline = true;
            v.preload = "auto";
            v.crossOrigin = "anonymous";
            const ready = () => {
              this.resources.set(item.id, {
                type: "video",
                el: v,
                w: v.videoWidth || 1280,
                h: v.videoHeight || 720,
              });
              res();
            };
            v.onloadeddata = ready;
            v.onerror = () => res();
            // 일부 환경에서 loadeddata가 늦을 수 있어 안전장치
            setTimeout(() => {
              if (!this.resources.has(item.id)) ready();
            }, 4000);
          })
        );
      }
    }
    await Promise.all(jobs);
  }

  _setupAudio(forRecord) {
    if (!this.music) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AC();
    this.audioEl = new Audio(this.music.url);
    this.audioEl.crossOrigin = "anonymous";
    const node = this.audioCtx.createMediaElementSource(this.audioEl);
    this.gain = this.audioCtx.createGain();
    this.gain.gain.value = 1;
    node.connect(this.gain);
    this.dest = this.audioCtx.createMediaStreamDestination();
    this.gain.connect(this.dest);
    if (!forRecord) this.gain.connect(this.audioCtx.destination);
    return this.dest;
  }

  _drawMedia(seg, localTime, alpha) {
    const ctx = this.ctx;
    const r = this.resources.get(seg.media.id);
    if (!r) return;
    const W = this.width;
    const H = this.height;
    const prog = Math.max(0, Math.min(1, localTime / seg.duration));

    let zoom = 1;
    let panX = 0;
    let panY = 0;
    if (seg.effect && seg.effect.type === "kenburns") {
      const e = seg.effect;
      zoom = e.z0 + (e.z1 - e.z0) * prog;
      panX = e.x0 + (e.x1 - e.x0) * prog;
      panY = e.y0 + (e.y1 - e.y0) * prog;
    } else {
      zoom = 1.04; // 영상도 살짝 확대해 가장자리 안정
    }

    // 비트 펀치: 비트 직후 짧게 살짝 확대
    if (seg.beatPunch && this.plan.beat) {
      const bi = this.plan.beat.beatInterval;
      const phase = ((this._clockNow - this.plan.beat.firstBeat) % bi + bi) % bi;
      const punchT = Math.min(0.12, bi * 0.3);
      if (phase < punchT) {
        const k = 1 - phase / punchT;
        zoom *= 1 + 0.03 * k;
      }
    }

    const scale = Math.max(W / r.w, H / r.h) * zoom;
    const dw = r.w * scale;
    const dh = r.h * scale;
    const dx = (W - dw) / 2 + panX * W;
    const dy = (H - dh) / 2 + panY * H;

    ctx.save();
    ctx.globalAlpha = alpha;
    try {
      ctx.drawImage(r.el, dx, dy, dw, dh);
    } catch (e) {
      /* 디코드 미완료 프레임 무시 */
    }
    ctx.restore();
  }

  _updateLive(t) {
    // 현재 활성 + 크로스페이드 대상 세그먼트의 영상 재생 상태를 관리
    const segs = this.plan.segments;
    const need = new Set();
    const idx = this._indexAt(t);
    if (idx >= 0) need.add(idx);
    const cur = segs[idx];
    if (cur) {
      const tail = cur.start + cur.duration - t;
      if (cur.transition === "crossfade" && tail < cur.transDur && idx + 1 < segs.length) {
        need.add(idx + 1);
      }
    }

    for (const i of need) {
      const seg = segs[i];
      const r = this.resources.get(seg.media.id);
      if (r && r.type === "video" && !this.live.has(i)) {
        const into = Math.max(0, t - seg.start);
        try {
          r.el.currentTime = seg.trimStart + into;
        } catch (e) {}
        r.el.play().catch(() => {});
        this.live.add(i);
      }
    }
    for (const i of Array.from(this.live)) {
      if (!need.has(i)) {
        const seg = segs[i];
        const r = this.resources.get(seg.media.id);
        if (r && r.type === "video") r.el.pause();
        this.live.delete(i);
      }
    }
  }

  _indexAt(t) {
    const segs = this.plan.segments;
    for (let i = 0; i < segs.length; i++) {
      if (t >= segs[i].start && t < segs[i].start + segs[i].duration) return i;
    }
    return t >= this.plan.totalDuration ? -1 : 0;
  }

  _frame(opts) {
    if (this._stopFlag) return this._finish(opts);
    const t = this._clock();
    this._clockNow = t;
    const total = this.plan.totalDuration;
    if (t >= total) return this._finish(opts);

    const ctx = this.ctx;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.width, this.height);

    this._updateLive(t);

    const idx = this._indexAt(t);
    const seg = this.plan.segments[idx];
    if (seg) {
      this._drawMedia(seg, t - seg.start, 1);
      const tail = seg.start + seg.duration - t;
      if (seg.transition === "crossfade" && tail < seg.transDur && idx + 1 < this.plan.segments.length) {
        const next = this.plan.segments[idx + 1];
        const alpha = 1 - tail / seg.transDur;
        this._drawMedia(next, Math.max(0, t - next.start), alpha);
      }
      // 비트 컷 직후 짧은 화이트 플래시
      if (seg.transition === "cut" && this.plan.beat) {
        const since = t - seg.start;
        if (since < 0.08) {
          ctx.save();
          ctx.globalAlpha = 0.25 * (1 - since / 0.08);
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, this.width, this.height);
          ctx.restore();
        }
      }
    }

    // 시작/끝 페이드 인·아웃
    const fade = 0.6;
    if (t < fade || t > total - fade) {
      const a = t < fade ? 1 - t / fade : (t - (total - fade)) / fade;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.restore();
    }

    if (opts.onProgress) opts.onProgress(t / total);
    this._raf = requestAnimationFrame(() => this._frame(opts));
  }

  _clock() {
    return (performance.now() - this._startWall) / 1000;
  }

  async play(opts = {}) {
    const forRecord = !!opts.record;
    await this._loadResources();
    const audioDest = this._setupAudio(forRecord);

    return new Promise(async (resolve, reject) => {
      this._resolve = resolve;
      this._stopFlag = false;

      if (forRecord) {
        const stream = this.canvas.captureStream(this.fps);
        const tracks = stream.getVideoTracks();
        if (audioDest) tracks.push(audioDest.stream.getAudioTracks()[0]);
        const mixed = new MediaStream(tracks);
        const mimeType = pickMime();
        this._chunks = [];
        try {
          this.recorder = new MediaRecorder(mixed, {
            mimeType,
            videoBitsPerSecond: opts.bitrate || 8_000_000,
          });
        } catch (e) {
          return reject(e);
        }
        this.recorder.ondataavailable = (e) => {
          if (e.data && e.data.size) this._chunks.push(e.data);
        };
        this.recorder.onstop = () => {
          const blob = new Blob(this._chunks, { type: mimeType });
          this._cleanup();
          resolve({ blob, mimeType });
        };
        this.recorder.start(100);
      }

      // 끝부분 오디오 페이드아웃 예약
      if (this.audioEl) {
        try {
          this.audioEl.currentTime = 0;
          await this.audioEl.play();
          if (this.gain && this.audioCtx) {
            const end = this.plan.totalDuration;
            const now = this.audioCtx.currentTime;
            this.gain.gain.setValueAtTime(1, now);
            this.gain.gain.setValueAtTime(1, now + Math.max(0, end - 0.8));
            this.gain.gain.linearRampToValueAtTime(0.0001, now + end);
          }
        } catch (e) {}
      }

      this._startWall = performance.now();
      this._frame(opts);
    });
  }

  stop() {
    this._stopFlag = true;
  }

  _finish(opts) {
    if (this._raf) cancelAnimationFrame(this._raf);
    if (opts && opts.onProgress) opts.onProgress(1);
    if (this.recorder && this.recorder.state !== "inactive") {
      // onstop에서 resolve
      this.recorder.stop();
    } else {
      this._cleanup();
      this._settle({ blob: null });
    }
  }

  // play() 프로미스를 정확히 한 번만 resolve한다(중복 호출 무시).
  _settle(value) {
    if (this._resolve) {
      const resolve = this._resolve;
      this._resolve = null;
      resolve(value);
    }
  }

  _cleanup() {
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.src = "";
    }
    if (this.audioCtx) this.audioCtx.close().catch(() => {});
    for (const r of this.resources.values()) {
      if (r.type === "video") {
        r.el.pause();
      }
    }
    this.live.clear();
  }

  dispose() {
    this._stopFlag = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this.recorder && this.recorder.state !== "inactive") {
      // 녹화 중이면 onstop이 정리·resolve를 담당한다.
      this.recorder.stop();
      return;
    }
    this._cleanup();
    // 대기 중인 play() 프로미스가 영원히 매달리지 않도록 반드시 resolve.
    this._settle({ blob: null });
  }
}

export { pickMime };
