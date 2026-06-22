import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTimeline } from "../src/timeline.js";

const photo = (id) => ({ id, kind: "photo" });
const video = (id, duration) => ({ id, kind: "video", duration });

test("사진 전용: 길이/시작시간 누적과 totalDuration", () => {
  const items = [photo("a"), photo("b"), photo("c")];
  const tl = buildTimeline(items, { photoDuration: 3 });
  assert.equal(tl.segments.length, 3);
  assert.deepEqual(
    tl.segments.map((s) => s.duration),
    [3, 3, 3]
  );
  assert.deepEqual(
    tl.segments.map((s) => s.start),
    [0, 3, 6]
  );
  assert.equal(tl.totalDuration, 9);
  assert.equal(tl.beat, null);
});

test("사진: Ken Burns 효과가 5개 주기로 순환 배정된다", () => {
  const items = Array.from({ length: 6 }, (_, i) => photo("p" + i));
  const tl = buildTimeline(items, {});
  for (const seg of tl.segments) {
    assert.equal(seg.effect.type, "kenburns");
    assert.equal(typeof seg.effect.z0, "number");
  }
  // 6번째(인덱스5)는 KB_MOVES[5 % 5] = [0]과 동일해야 한다
  assert.deepEqual(
    { z0: tl.segments[5].effect.z0, z1: tl.segments[5].effect.z1 },
    { z0: tl.segments[0].effect.z0, z1: tl.segments[0].effect.z1 }
  );
});

test("기본 설정값: photoDuration 3, crossfade transition", () => {
  const tl = buildTimeline([photo("a")], {});
  assert.equal(tl.segments[0].duration, 3);
  assert.equal(tl.segments[0].transition, "crossfade");
  // transDur = min(0.5, duration*0.4=1.2) = 0.5
  assert.equal(tl.segments[0].transDur, 0.5);
  assert.equal(tl.segments[0].beatPunch, false);
});

test("영상: maxVideoDuration으로 클램프하고 가운데를 트림한다", () => {
  const tl = buildTimeline([video("v", 10)], { maxVideoDuration: 4 });
  const seg = tl.segments[0];
  assert.equal(seg.duration, 4);
  // 가운데 구간: (10-4)/2 = 3
  assert.equal(seg.trimStart, 3);
});

test("영상: 실제 길이가 max보다 짧으면 그대로 쓰고 트림 없음", () => {
  const tl = buildTimeline([video("v", 2)], { maxVideoDuration: 5 });
  assert.equal(tl.segments[0].duration, 2);
  assert.equal(tl.segments[0].trimStart, 0);
});

test("영상: duration 미상이면 maxVideoDuration을 사용", () => {
  const tl = buildTimeline([video("v", undefined)], { maxVideoDuration: 5 });
  assert.equal(tl.segments[0].duration, 5);
  assert.equal(tl.segments[0].trimStart, 0);
});

test("transition='cut': 컷 종류와 거의 0인 transDur", () => {
  const tl = buildTimeline([photo("a"), photo("b")], { transition: "cut" });
  for (const seg of tl.segments) {
    assert.equal(seg.transition, "cut");
    assert.equal(seg.transDur, 0.001);
    assert.equal(seg.beatPunch, false);
  }
});

test("crossfade transDur는 transitionDuration과 duration*0.4 중 작은 값", () => {
  // duration 1초, transitionDuration 0.5 → min(0.5, 0.4) = 0.4
  const tl = buildTimeline([photo("a")], {
    photoDuration: 1,
    transitionDuration: 0.5,
  });
  assert.equal(tl.segments[0].transDur, 0.4);
});

test("beatSync: 길이를 비트에 스냅하고 최소 4비트를 보장한다", () => {
  const beat = { beatInterval: 0.5, firstBeat: 0 };
  const tl = buildTimeline([photo("a")], { photoDuration: 3, beatSync: true }, beat);
  const seg = tl.segments[0];
  // round(3/0.5)=6 비트 → 6*0.5 = 3.0
  assert.equal(seg.duration, 3);
  // 비트 모드는 컷 전환 + 펀치
  assert.equal(seg.transition, "cut");
  assert.equal(seg.beatPunch, true);
  // transDur = min(0.18, interval*0.4=0.2) = 0.18
  assert.equal(seg.transDur, 0.18);
  assert.deepEqual(tl.beat, beat);
});

test("beatSync: 매우 짧은 길이도 최소 4비트로 끌어올린다", () => {
  const beat = { beatInterval: 0.5, firstBeat: 0 };
  // photoDuration 0.4 → round(0.8)=1 비트지만 최소 4비트 → 2.0초
  const tl = buildTimeline([photo("a")], { photoDuration: 0.4, beatSync: true }, beat);
  assert.equal(tl.segments[0].duration, 2.0);
});

test("beatSync: 스냅으로 영상 길이를 넘으면 trimStart를 0으로 보정", () => {
  const beat = { beatInterval: 2.0, firstBeat: 0 };
  // real=4.4, max=4 → dur=4, trimStart=(4.4-4)/2=0.2
  // snap(4,4): round(4/2)=2 → 최소 4비트 → 8.0초
  // trimStart(0.2)+8 > 4.4 → trimStart = max(0, 4.4-8) = 0
  const tl = buildTimeline(
    [video("v", 4.4)],
    { maxVideoDuration: 4, beatSync: true },
    beat
  );
  const seg = tl.segments[0];
  assert.equal(seg.duration, 8);
  assert.equal(seg.trimStart, 0);
});

test("beatSync 플래그가 켜져도 beat 정보가 없으면 비트 모드 비활성", () => {
  const tl = buildTimeline([photo("a")], { beatSync: true }, null);
  assert.equal(tl.segments[0].transition, "crossfade");
  assert.ok(!tl.segments[0].beatPunch); // useBeat가 falsy → 비트 펀치 비활성
  assert.equal(tl.beat, null);
});

test("beatInterval<=0인 비정상 beat는 무시한다", () => {
  const tl = buildTimeline([photo("a")], { beatSync: true }, { beatInterval: 0 });
  assert.equal(tl.segments[0].beatPunch, false);
});

test("빈 입력은 빈 타임라인을 만든다", () => {
  const tl = buildTimeline([], {});
  assert.deepEqual(tl.segments, []);
  assert.equal(tl.totalDuration, 0);
});

test("사진+영상 혼합: start가 누적되고 효과가 종류별로 갈린다", () => {
  const items = [photo("a"), video("v", 10), photo("b")];
  const tl = buildTimeline(items, { photoDuration: 3, maxVideoDuration: 4 });
  assert.deepEqual(
    tl.segments.map((s) => s.start),
    [0, 3, 7]
  );
  assert.equal(tl.segments[0].effect.type, "kenburns");
  assert.equal(tl.segments[1].effect, null); // 영상엔 kenburns 미배정
  assert.equal(tl.segments[2].effect.type, "kenburns");
  assert.equal(tl.totalDuration, 10);
});
