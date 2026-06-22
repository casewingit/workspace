// pipeline.test.js — 모듈 결합 검증: 메타데이터 추출 → 시간순 정렬 → 타임라인.
// editor.js의 핵심 흐름(ingest→autoSort→buildTimeline)을 헤드리스로 재현한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMetadata } from "../src/metadata.js";
import { buildTimeline } from "../src/timeline.js";
import {
  buildJpegExif,
  buildMp4,
  fakeFile,
  installFileReaderMock,
} from "./helpers/fixtures.js";

// editor.js currentPlan()이 만드는 타임라인 입력 형태로 변환
function toTimelineItems(items) {
  return items.map((it) => ({
    id: it.id,
    kind: it.kind,
    url: it.url,
    duration: it.duration,
    orientation: it.orientation,
  }));
}

// 타임라인의 구조적 불변식: 세그먼트가 빈틈없이 이어지고 총길이가 일치
function assertContiguous(tl) {
  let acc = 0;
  for (const seg of tl.segments) {
    assert.equal(seg.start, acc, "세그먼트 start는 누적 시간과 같아야 함");
    assert.ok(seg.duration > 0, "duration은 양수여야 함");
    acc += seg.duration;
  }
  assert.equal(tl.totalDuration, acc, "totalDuration은 합과 같아야 함");
}

test("파이프라인: EXIF/mvhd 시각으로 시간순 정렬 후 빈틈없는 타임라인", async () => {
  const restore = installFileReaderMock();
  try {
    // 일부러 시간 역순으로 투입
    const raw = [
      { id: 1, kind: "photo", buffer: buildJpegExif({ dateString: "2023:07:15 12:00:00", orientation: 1 }), type: "image/jpeg", duration: 0 },
      { id: 2, kind: "photo", buffer: buildJpegExif({ dateString: "2023:07:15 08:30:00", orientation: 1 }), type: "image/jpeg", duration: 0 },
      { id: 3, kind: "video", buffer: buildMp4({ creationSeconds: 3_600_000_000, version: 0 }), type: "video/mp4", duration: 10 },
      { id: 4, kind: "photo", buffer: buildJpegExif({ dateString: "2023:07:15 09:45:00", orientation: 1 }), type: "image/jpeg", duration: 0 },
    ];

    // ingest: 메타데이터 채우기
    const items = [];
    for (const r of raw) {
      const file = fakeFile({ buffer: r.buffer, type: r.type });
      const meta = await extractMetadata(file);
      items.push({
        id: r.id,
        kind: r.kind,
        url: `blob:${r.id}`,
        duration: r.duration,
        orientation: meta.orientation,
        date: meta.date,
        fromMeta: meta.fromMeta,
      });
    }

    // 모두 메타데이터에서 시각을 얻었는지
    for (const it of items) assert.equal(it.fromMeta, true);

    // autoSort: 촬영 시각 오름차순
    items.sort((a, b) => a.date - b.date);
    for (let i = 1; i < items.length; i++) {
      assert.ok(items[i].date >= items[i - 1].date, "날짜가 비내림차순이어야 함");
    }

    // buildTimeline: 구조 불변식 확인
    const tl = buildTimeline(toTimelineItems(items), {
      photoDuration: 3,
      maxVideoDuration: 5,
      transition: "crossfade",
    });
    assert.equal(tl.segments.length, 4);
    assertContiguous(tl);

    // 입력 순서(id)와 세그먼트 순서가 정렬 결과와 일치
    assert.deepEqual(
      tl.segments.map((s) => s.media.id),
      items.map((it) => it.id)
    );
  } finally {
    restore();
  }
});

test("파이프라인: 비트 싱크 켜면 모든 세그먼트가 컷 전환 + 빈틈없음", async () => {
  const restore = installFileReaderMock();
  try {
    const files = [
      { kind: "photo", buffer: buildJpegExif({ dateString: "2024:01:01 10:00:00" }), type: "image/jpeg", duration: 0 },
      { kind: "video", buffer: buildMp4({ creationSeconds: 3_700_000_000 }), type: "video/mp4", duration: 8 },
      { kind: "photo", buffer: buildJpegExif({ dateString: "2024:01:01 10:05:00" }), type: "image/jpeg", duration: 0 },
    ];
    const items = [];
    let id = 0;
    for (const f of files) {
      const meta = await extractMetadata(fakeFile({ buffer: f.buffer, type: f.type }));
      items.push({ id: ++id, kind: f.kind, url: `blob:${id}`, duration: f.duration, orientation: meta.orientation, date: meta.date });
    }
    items.sort((a, b) => a.date - b.date);

    const beat = { beatInterval: 0.5, firstBeat: 0.1 };
    const tl = buildTimeline(toTimelineItems(items), {
      photoDuration: 3,
      maxVideoDuration: 5,
      beatSync: true,
    }, beat);

    assertContiguous(tl);
    for (const seg of tl.segments) {
      assert.equal(seg.transition, "cut");
      assert.equal(seg.beatPunch, true);
      // 모든 길이는 비트 간격의 정수배
      const beats = seg.duration / beat.beatInterval;
      assert.ok(Math.abs(beats - Math.round(beats)) < 1e-9, `duration=${seg.duration}`);
      assert.ok(Math.round(beats) >= 4, "최소 4비트");
    }
    assert.deepEqual(tl.beat, beat);
  } finally {
    restore();
  }
});

test("파이프라인: 메타데이터 없는 파일은 lastModified로 폴백해도 타임라인은 정상", async () => {
  const restore = installFileReaderMock();
  try {
    const items = [];
    // EXIF 없는 PNG 2장(추정), mvhd 영상 1개
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer;
    const inputs = [
      { kind: "photo", buffer: png, type: "image/png", lastModified: Date.UTC(2025, 0, 2), duration: 0 },
      { kind: "photo", buffer: png, type: "image/png", lastModified: Date.UTC(2025, 0, 1), duration: 0 },
    ];
    let id = 0;
    for (const f of inputs) {
      const meta = await extractMetadata(fakeFile({ buffer: f.buffer, type: f.type, lastModified: f.lastModified }));
      assert.equal(meta.fromMeta, false);
      items.push({ id: ++id, kind: f.kind, url: `blob:${id}`, duration: f.duration, orientation: meta.orientation, date: meta.date });
    }
    items.sort((a, b) => a.date - b.date);
    assert.equal(items[0].date.getTime(), Date.UTC(2025, 0, 1));

    const tl = buildTimeline(toTimelineItems(items), {});
    assertContiguous(tl);
  } finally {
    restore();
  }
});
