import { test } from "node:test";
import assert from "node:assert/strict";
import { RenderEngine } from "../src/renderer.js";

// 캔버스 2D 컨텍스트 모의: drawImage/globalAlpha 호출을 기록한다.
function makeCtx() {
  const calls = [];
  return {
    globalAlpha: 1,
    fillStyle: "",
    save() {},
    restore() {},
    fillRect() {},
    drawImage(el, dx, dy, dw, dh) {
      calls.push({ el, dx, dy, dw, dh, alpha: this.globalAlpha });
    },
    _calls: calls,
  };
}

function makeEngine(plan, opts = {}) {
  const ctx = makeCtx();
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const engine = new RenderEngine(canvas, plan, {
    width: 1280,
    height: 720,
    ...opts,
  });
  return { engine, ctx };
}

const approx = (a, b, eps = 0.5) =>
  assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

// ── _indexAt ─────────────────────────────────────────────────────────────
test("_indexAt: 시각에 해당하는 세그먼트 인덱스를 찾는다", () => {
  const plan = {
    segments: [
      { start: 0, duration: 2 },
      { start: 2, duration: 3 },
    ],
    totalDuration: 5,
  };
  const { engine } = makeEngine(plan);
  assert.equal(engine._indexAt(0), 0);
  assert.equal(engine._indexAt(1.9), 0);
  assert.equal(engine._indexAt(2), 1); // 경계는 다음 세그먼트
  assert.equal(engine._indexAt(4.99), 1);
  assert.equal(engine._indexAt(5), -1); // 전체 길이 이상이면 -1
  assert.equal(engine._indexAt(10), -1);
});

// ── _drawMedia: cover-fit 기하 ─────────────────────────────────────────────
test("_drawMedia: 사진 Ken Burns 시작(prog 0) 기하", () => {
  const seg = {
    media: { id: "a" },
    duration: 3,
    effect: { type: "kenburns", z0: 1, z1: 1.2, x0: 0, y0: 0, x1: 0.1, y1: 0.05 },
    beatPunch: false,
  };
  const plan = { segments: [seg], totalDuration: 3, beat: null };
  const { engine, ctx } = makeEngine(plan);
  engine.resources.set("a", { type: "photo", el: {}, w: 1000, h: 500 });

  engine._drawMedia(seg, 0, 1);
  const c = ctx._calls.at(-1);
  // scale = max(1280/1000, 720/500)=1.44, zoom=1
  approx(c.dw, 1440);
  approx(c.dh, 720);
  approx(c.dx, -80);
  approx(c.dy, 0);
  assert.equal(c.alpha, 1);
});

test("_drawMedia: 사진 Ken Burns 끝(prog 1)에서 줌·팬이 적용된다", () => {
  const seg = {
    media: { id: "a" },
    duration: 3,
    effect: { type: "kenburns", z0: 1, z1: 1.2, x0: 0, y0: 0, x1: 0.1, y1: 0.05 },
    beatPunch: false,
  };
  const plan = { segments: [seg], totalDuration: 3, beat: null };
  const { engine, ctx } = makeEngine(plan);
  engine.resources.set("a", { type: "photo", el: {}, w: 1000, h: 500 });

  engine._drawMedia(seg, 3, 0.5);
  const c = ctx._calls.at(-1);
  // scale = 1.44*1.2 = 1.728
  approx(c.dw, 1728);
  approx(c.dh, 864);
  approx(c.dx, -96); // (1280-1728)/2 + 0.1*1280
  approx(c.dy, -36); // (720-864)/2 + 0.05*720
  assert.equal(c.alpha, 0.5);
});

test("_drawMedia: 영상은 effect 없이 1.04배 살짝 확대", () => {
  const seg = { media: { id: "v" }, duration: 4, effect: null, beatPunch: false };
  const plan = { segments: [seg], totalDuration: 4, beat: null };
  const { engine, ctx } = makeEngine(plan);
  engine.resources.set("v", { type: "video", el: {}, w: 1920, h: 1080 });

  engine._drawMedia(seg, 0, 1);
  const c = ctx._calls.at(-1);
  // scale = max(1280/1920,720/1080)=0.6667 * 1.04
  approx(c.dw, 1331.2);
  approx(c.dh, 748.8);
  approx(c.dx, -25.6);
  approx(c.dy, -14.4);
});

test("_drawMedia: 리소스가 없으면 그리지 않는다", () => {
  const seg = { media: { id: "missing" }, duration: 3, effect: null, beatPunch: false };
  const plan = { segments: [seg], totalDuration: 3, beat: null };
  const { engine, ctx } = makeEngine(plan);
  engine._drawMedia(seg, 0, 1);
  assert.equal(ctx._calls.length, 0);
});

test("_drawMedia: 비트 펀치는 비트 직후 잠깐 확대를 더한다", () => {
  const seg = { media: { id: "v" }, duration: 4, effect: null, beatPunch: true };
  const plan = {
    segments: [seg],
    totalDuration: 4,
    beat: { beatInterval: 0.5, firstBeat: 0 },
  };
  const { engine, ctx } = makeEngine(plan);
  engine.resources.set("v", { type: "video", el: {}, w: 1920, h: 1080 });

  engine._clockNow = 0; // 비트 정각 → 펀치 최대
  engine._drawMedia(seg, 0, 1);
  const punched = ctx._calls.at(-1).dw;

  engine._clockNow = 0.3; // 펀치 구간(0.12s) 밖 → 펀치 없음
  engine._drawMedia(seg, 0, 1);
  const normal = ctx._calls.at(-1).dw;

  assert.ok(punched > normal, `punched ${punched} > normal ${normal}`);
});

// ── _updateLive: 영상 재생/일시정지 상태 관리 ───────────────────────────────
function fakeVideo() {
  return {
    _played: false,
    _paused: false,
    currentTime: 0,
    play() {
      this._played = true;
      return Promise.resolve();
    },
    pause() {
      this._paused = true;
    },
  };
}

test("_updateLive: 활성 영상은 play하고 trimStart+오프셋으로 시킹", () => {
  const v = fakeVideo();
  const plan = {
    segments: [
      { media: { id: "v" }, start: 0, duration: 3, trimStart: 1, transition: "cut" },
      { media: { id: "p" }, start: 3, duration: 2, transition: "cut" },
    ],
    totalDuration: 5,
  };
  const { engine } = makeEngine(plan);
  engine.resources.set("v", { type: "video", el: v });
  engine.resources.set("p", { type: "photo", el: {} });

  engine._updateLive(0.5);
  assert.equal(v._played, true);
  approx(v.currentTime, 1.5); // trimStart(1) + into(0.5)
  assert.ok(engine.live.has(0));
});

test("_updateLive: 더 이상 활성 아닌 영상은 pause하고 live에서 제거", () => {
  const v = fakeVideo();
  const plan = {
    segments: [
      { media: { id: "v" }, start: 0, duration: 3, trimStart: 0, transition: "cut" },
      { media: { id: "p" }, start: 3, duration: 2, transition: "cut" },
    ],
    totalDuration: 5,
  };
  const { engine } = makeEngine(plan);
  engine.resources.set("v", { type: "video", el: v });
  engine.resources.set("p", { type: "photo", el: {} });

  engine._updateLive(0.5); // 영상 활성
  engine._updateLive(3.5); // 사진 구간 → 영상 정지
  assert.equal(v._paused, true);
  assert.ok(!engine.live.has(0));
});

test("_updateLive: 크로스페이드 꼬리에서 다음 영상을 미리 재생한다", () => {
  const v0 = fakeVideo();
  const v1 = fakeVideo();
  const plan = {
    segments: [
      {
        media: { id: "v0" },
        start: 0,
        duration: 3,
        trimStart: 0,
        transition: "crossfade",
        transDur: 0.5,
      },
      { media: { id: "v1" }, start: 3, duration: 3, trimStart: 0, transition: "cut" },
    ],
    totalDuration: 6,
  };
  const { engine } = makeEngine(plan);
  engine.resources.set("v0", { type: "video", el: v0 });
  engine.resources.set("v1", { type: "video", el: v1 });

  engine._updateLive(2.7); // tail 0.3 < transDur 0.5 → 다음(v1) 선재생
  assert.ok(engine.live.has(0));
  assert.ok(engine.live.has(1));
  assert.equal(v1._played, true);
});
