import { test } from "node:test";
import assert from "node:assert/strict";
import { pickMime } from "../src/renderer.js";

function withMediaRecorder(supported, fn) {
  const prevWindow = globalThis.window;
  const prevMR = globalThis.MediaRecorder;
  globalThis.window = globalThis.window || {};
  const MR = function () {};
  MR.isTypeSupported = (c) => supported.includes(c);
  globalThis.window.MediaRecorder = MR;
  globalThis.MediaRecorder = MR;
  try {
    return fn();
  } finally {
    globalThis.window = prevWindow;
    globalThis.MediaRecorder = prevMR;
  }
}

test("pickMime: VP9를 지원하면 VP9를 우선 선택", () => {
  withMediaRecorder(
    ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
    () => {
      assert.equal(pickMime(), "video/webm;codecs=vp9,opus");
    }
  );
});

test("pickMime: VP9 미지원이면 VP8로 폴백", () => {
  withMediaRecorder(["video/webm;codecs=vp8,opus", "video/webm"], () => {
    assert.equal(pickMime(), "video/webm;codecs=vp8,opus");
  });
});

test("pickMime: 코덱 지정 모두 미지원이면 기본 webm", () => {
  withMediaRecorder([], () => {
    assert.equal(pickMime(), "video/webm");
  });
});

test("pickMime: MediaRecorder가 없으면 기본 webm", () => {
  const prevWindow = globalThis.window;
  globalThis.window = {};
  try {
    assert.equal(pickMime(), "video/webm");
  } finally {
    globalThis.window = prevWindow;
  }
});
