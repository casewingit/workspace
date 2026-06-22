// renderer-lifecycle.test.js — play()/dispose() 프로미스 수명 검증.
// 미리보기 정지(dispose) 시 play() 프로미스가 매달리지 않고 resolve되는지 확인한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RenderEngine } from "../src/renderer.js";

function makeCtx() {
  return {
    globalAlpha: 1,
    fillStyle: "",
    save() {},
    restore() {},
    fillRect() {},
    drawImage() {},
  };
}

function installDomMocks() {
  const prev = {
    Image: globalThis.Image,
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
  };
  globalThis.Image = class {
    constructor() {
      this.naturalWidth = 100;
      this.naturalHeight = 100;
    }
    set src(v) {
      this._src = v;
      queueMicrotask(() => this.onload && this.onload());
    }
    get src() {
      return this._src;
    }
  };
  const timers = new Map();
  let id = 0;
  globalThis.requestAnimationFrame = (cb) => {
    const myId = ++id;
    const t = setTimeout(() => {
      timers.delete(myId);
      cb(performance.now());
    }, 0);
    timers.set(myId, t);
    return myId;
  };
  globalThis.cancelAnimationFrame = (myId) => {
    const t = timers.get(myId);
    if (t) {
      clearTimeout(t);
      timers.delete(myId);
    }
  };
  return function restore() {
    globalThis.Image = prev.Image;
    globalThis.requestAnimationFrame = prev.raf;
    globalThis.cancelAnimationFrame = prev.caf;
  };
}

function photoPlan(totalDuration) {
  const seg = {
    media: { id: "p", kind: "photo", url: "blob:p" },
    start: 0,
    duration: totalDuration,
    trimStart: 0,
    effect: null,
    transition: "crossfade",
    transDur: 0.3,
    beatPunch: false,
  };
  return { segments: [seg], totalDuration, beat: null };
}

function makeEngine(plan) {
  const ctx = makeCtx();
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  return new RenderEngine(canvas, plan, { width: 320, height: 180, fps: 30 });
}

test("dispose()는 대기 중인 미리보기 play() 프로미스를 resolve한다(누수 방지)", async () => {
  const restore = installDomMocks();
  try {
    const engine = makeEngine(photoPlan(100)); // 길게 재생
    const p = engine.play({ record: false });
    // 몇 프레임 돌게 둔 뒤 정지
    await new Promise((r) => setTimeout(r, 10));
    engine.dispose();
    const result = await p; // 수정 전이라면 여기서 영원히 매달림
    assert.deepEqual(result, { blob: null });
  } finally {
    restore();
  }
});

test("자연 종료 시에도 play() 프로미스가 resolve된다", async () => {
  const restore = installDomMocks();
  try {
    const engine = makeEngine(photoPlan(0.02)); // 매우 짧게
    const result = await engine.play({ record: false });
    assert.equal(result.blob, null);
  } finally {
    restore();
  }
});

test("dispose()를 두 번 호출해도 안전하다(중복 resolve 무시)", async () => {
  const restore = installDomMocks();
  try {
    const engine = makeEngine(photoPlan(100));
    const p = engine.play({ record: false });
    await new Promise((r) => setTimeout(r, 5));
    engine.dispose();
    assert.doesNotThrow(() => engine.dispose());
    await p;
  } finally {
    restore();
  }
});
