import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeAudio, collectPeaks, computeBpm } from "../src/bpm.js";
import { clickTrack, installAudioMock } from "./helpers/fixtures.js";

// ── computeBpm (순수) ────────────────────────────────────────────────────────
test("computeBpm: 피크가 4개 미만이면 기본 120", () => {
  assert.equal(computeBpm([{ pos: 0 }, { pos: 10 }], 44100), 120);
});

test("computeBpm: 일정 간격 피크에서 정확한 BPM 추정", () => {
  const sr = 44100;
  const interval = 0.5 * sr; // 120 BPM
  const peaks = Array.from({ length: 16 }, (_, i) => ({ pos: i * interval }));
  const bpm = computeBpm(peaks, sr);
  assert.ok(Math.abs(bpm - 120) < 1, `bpm=${bpm}`);
});

test("computeBpm: 옥타브 폴딩 — 240 BPM 간격은 120으로 접힌다", () => {
  const sr = 44100;
  const interval = 0.25 * sr; // 240 BPM → 폴딩 → 120
  const peaks = Array.from({ length: 16 }, (_, i) => ({ pos: i * interval }));
  const bpm = computeBpm(peaks, sr);
  assert.ok(Math.abs(bpm - 120) < 1, `bpm=${bpm}`);
});

test("computeBpm: 90 BPM 간격 추정", () => {
  const sr = 44100;
  const interval = (60 / 90) * sr;
  const peaks = Array.from({ length: 16 }, (_, i) => ({ pos: i * interval }));
  const bpm = computeBpm(peaks, sr);
  assert.ok(Math.abs(bpm - 90) < 1.5, `bpm=${bpm}`);
});

// ── collectPeaks (순수) ──────────────────────────────────────────────────────
test("collectPeaks: 주기적 에너지 버스트에서 비트 수만큼 피크 검출", () => {
  const sr = 8000;
  const seconds = 8;
  const bpm = 120;
  const sig = clickTrack(bpm, seconds, sr);
  const peaks = collectPeaks(sig, sr);
  const expected = Math.floor(seconds / (60 / bpm)); // 16개
  // 적응형 임계값/스킵으로 약간의 오차 허용
  assert.ok(
    Math.abs(peaks.length - expected) <= 2,
    `peaks=${peaks.length}, expected≈${expected}`
  );
  // 피크 위치는 단조 증가하고 pos/energy를 갖는다
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i].pos > peaks[i - 1].pos);
    assert.ok(peaks[i].energy > 0);
  }
});

test("collectPeaks: 무음 신호는 피크 없음", () => {
  const peaks = collectPeaks(new Float32Array(8000), 8000);
  assert.equal(peaks.length, 0);
});

// ── analyzeAudio (Web Audio 모의 통한 end-to-end) ────────────────────────────
test("analyzeAudio: 120 BPM 클릭 트랙을 끝까지 분석해 BPM을 맞춘다", async () => {
  const sr = 8000;
  const sig = clickTrack(120, 8, sr);
  const restore = installAudioMock(sig, sr);
  try {
    const result = await analyzeAudio(new ArrayBuffer(8));
    assert.ok(Math.abs(result.bpm - 120) <= 3, `bpm=${result.bpm}`);
    assert.equal(result.bpm, Math.round(result.bpmPrecise));
    assert.ok(Math.abs(result.beatInterval - 60 / result.bpmPrecise) < 1e-9);
    assert.ok(result.firstBeat >= 0 && result.firstBeat < result.beatInterval);
    assert.ok(Math.abs(result.duration - 8) < 1e-6);
    assert.equal(result.audioBuffer.sampleRate, sr);
  } finally {
    restore();
  }
});

test("analyzeAudio: 90 BPM 트랙도 근사 추정", async () => {
  const sr = 8000;
  const sig = clickTrack(90, 10, sr);
  const restore = installAudioMock(sig, sr);
  try {
    const result = await analyzeAudio(new ArrayBuffer(8));
    assert.ok(Math.abs(result.bpm - 90) <= 4, `bpm=${result.bpm}`);
  } finally {
    restore();
  }
});
