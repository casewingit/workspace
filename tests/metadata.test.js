import { test } from "node:test";
import assert from "node:assert/strict";
import { parseExif, parseMp4Date, extractMetadata } from "../src/metadata.js";
import {
  buildJpegExif,
  buildMp4,
  buildMp4Nested,
  buildMp4Large,
  fakeFile,
  installFileReaderMock,
} from "./helpers/fixtures.js";

// ── parseExif ──────────────────────────────────────────────────────────────
test("parseExif: DateTimeOriginal과 Orientation을 읽는다", () => {
  const buf = buildJpegExif({
    dateString: "2023:07:15 14:30:45",
    orientation: 6,
  });
  const r = parseExif(buf);
  assert.ok(r, "결과가 있어야 함");
  assert.equal(r.orientation, 6);
  // new Date(2023, 6, 15, 14, 30, 45) — 로컬 시간 기준
  assert.equal(r.date.getFullYear(), 2023);
  assert.equal(r.date.getMonth(), 6); // 0-based → 7월
  assert.equal(r.date.getDate(), 15);
  assert.equal(r.date.getHours(), 14);
  assert.equal(r.date.getMinutes(), 30);
  assert.equal(r.date.getSeconds(), 45);
});

test("parseExif: SOI가 아니면 null", () => {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setUint16(0, 0x1234, false);
  assert.equal(parseExif(buf), null);
});

test("parseExif: 너무 짧은 버퍼는 null", () => {
  assert.equal(parseExif(new ArrayBuffer(2)), null);
});

test("parseExif: orientation 기본값은 1", () => {
  const buf = buildJpegExif({ dateString: "2020:01:02 03:04:05", orientation: 1 });
  assert.equal(parseExif(buf).orientation, 1);
});

test("parseExif: big-endian(MM) TIFF도 읽는다", () => {
  const buf = buildJpegExif({
    dateString: "2019:03:08 09:10:11",
    orientation: 8,
    little: false,
  });
  const r = parseExif(buf);
  assert.equal(r.orientation, 8);
  assert.equal(r.date.getFullYear(), 2019);
  assert.equal(r.date.getMonth(), 2);
  assert.equal(r.date.getHours(), 9);
});

test("parseExif: SubIFD가 없고 IFD0의 DateTime(0x0132)만 있어도 읽는다", () => {
  const buf = buildJpegExif({
    dateString: "2018:11:22 06:07:08",
    orientation: null, // orientation 생략
    dateLocation: "ifd0",
  });
  const r = parseExif(buf);
  assert.equal(r.date.getFullYear(), 2018);
  assert.equal(r.date.getMonth(), 10);
  assert.equal(r.orientation, 1); // 없으면 기본 1
});

test("parseExif: orientation만 있고 날짜가 없으면 date=null", () => {
  const buf = buildJpegExif({ dateString: null, orientation: 7 });
  const r = parseExif(buf);
  assert.ok(r);
  assert.equal(r.orientation, 7);
  assert.equal(r.date, null);
});

test("parseExif: 잘못된 형식의 날짜 문자열은 date=null", () => {
  const buf = buildJpegExif({ dateString: "not-a-real-date!!", orientation: 1 });
  const r = parseExif(buf);
  assert.equal(r.date, null);
});

// ── parseMp4Date ─────────────────────────────────────────────────────────────
test("parseMp4Date: mvhd version 0 creation_time", () => {
  // 1904 기준 초. 2,000,000,000초 → 알려진 시각으로 역산해 비교
  const creationSeconds = 3_000_000_000;
  const buf = buildMp4({ creationSeconds, version: 0 });
  const d = parseMp4Date(buf);
  assert.ok(d instanceof Date);
  const EPOCH_1904 = -2082844800000;
  assert.equal(d.getTime(), EPOCH_1904 + creationSeconds * 1000);
});

test("parseMp4Date: mvhd version 1(64-bit) creation_time", () => {
  const creationSeconds = 3_000_000_000;
  const buf = buildMp4({ creationSeconds, version: 1 });
  const d = parseMp4Date(buf);
  const EPOCH_1904 = -2082844800000;
  assert.equal(d.getTime(), EPOCH_1904 + creationSeconds * 1000);
});

test("parseMp4Date: moov>trak>mdia>mdhd 중첩 박스도 재귀로 찾는다", () => {
  const creationSeconds = 2_500_000_000;
  const buf = buildMp4Nested({ creationSeconds, version: 0 });
  const d = parseMp4Date(buf);
  const EPOCH_1904 = -2082844800000;
  assert.equal(d.getTime(), EPOCH_1904 + creationSeconds * 1000);
});

test("parseMp4Date: 64-bit largesize 박스 헤더를 처리한다", () => {
  const creationSeconds = 2_700_000_000;
  const buf = buildMp4Large({ creationSeconds, version: 0 });
  const d = parseMp4Date(buf);
  const EPOCH_1904 = -2082844800000;
  assert.equal(d.getTime(), EPOCH_1904 + creationSeconds * 1000);
});

test("parseMp4Date: mvhd가 없으면 null", () => {
  // moov 없이 ftyp만 — 박스 워킹이 mvhd를 못 찾음
  const buf = new ArrayBuffer(16);
  const dv = new DataView(buf);
  dv.setUint32(0, 16, false);
  "ftyp".split("").forEach((c, i) => dv.setUint8(4 + i, c.charCodeAt(0)));
  assert.equal(parseMp4Date(buf), null);
});

test("parseMp4Date: creation_time 0이면 null(미설정 취급)", () => {
  const buf = buildMp4({ creationSeconds: 0, version: 0 });
  assert.equal(parseMp4Date(buf), null);
});

// ── extractMetadata (File/FileReader 통합) ───────────────────────────────────
test("extractMetadata: EXIF 있는 이미지 → fromMeta true", async () => {
  const restore = installFileReaderMock();
  try {
    const buffer = buildJpegExif({
      dateString: "2022:12:31 23:59:59",
      orientation: 3,
    });
    const file = fakeFile({ buffer, type: "image/jpeg" });
    const meta = await extractMetadata(file);
    assert.equal(meta.fromMeta, true);
    assert.equal(meta.orientation, 3);
    assert.equal(meta.date.getFullYear(), 2022);
  } finally {
    restore();
  }
});

test("extractMetadata: EXIF 없는 이미지 → lastModified 폴백, fromMeta false", async () => {
  const restore = installFileReaderMock();
  try {
    // SOI 아님 → parseExif null → 폴백
    const buffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer;
    const lastModified = Date.UTC(2021, 5, 1, 12, 0, 0);
    const file = fakeFile({ buffer, type: "image/png", lastModified });
    const meta = await extractMetadata(file);
    assert.equal(meta.fromMeta, false);
    assert.equal(meta.orientation, 1);
    assert.equal(meta.date.getTime(), lastModified);
  } finally {
    restore();
  }
});

test("extractMetadata: EXIF에 날짜는 없고 방향만 → orientation 유지, fromMeta false", async () => {
  const restore = installFileReaderMock();
  try {
    const buffer = buildJpegExif({ dateString: null, orientation: 6 });
    const lastModified = Date.UTC(2020, 2, 3, 4, 5, 6);
    const file = fakeFile({ buffer, type: "image/jpeg", lastModified });
    const meta = await extractMetadata(file);
    assert.equal(meta.fromMeta, false); // 날짜 메타데이터 없음
    assert.equal(meta.orientation, 6); // 방향은 살아 있음
    assert.equal(meta.date.getTime(), lastModified); // 날짜는 폴백
  } finally {
    restore();
  }
});

test("extractMetadata: mvhd 있는 영상 → fromMeta true", async () => {
  const restore = installFileReaderMock();
  try {
    const creationSeconds = 3_500_000_000;
    const buffer = buildMp4({ creationSeconds, version: 0 });
    const file = fakeFile({ buffer, type: "video/mp4" });
    const meta = await extractMetadata(file);
    assert.equal(meta.fromMeta, true);
    const EPOCH_1904 = -2082844800000;
    assert.equal(meta.date.getTime(), EPOCH_1904 + creationSeconds * 1000);
  } finally {
    restore();
  }
});

test("extractMetadata: 알 수 없는 타입 → 폴백", async () => {
  const restore = installFileReaderMock();
  try {
    const lastModified = Date.UTC(2024, 0, 1);
    const file = fakeFile({
      buffer: new ArrayBuffer(4),
      type: "application/octet-stream",
      lastModified,
    });
    const meta = await extractMetadata(file);
    assert.equal(meta.fromMeta, false);
    assert.equal(meta.date.getTime(), lastModified);
  } finally {
    restore();
  }
});
