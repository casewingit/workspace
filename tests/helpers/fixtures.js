// fixtures.js — 테스트용 바이너리(EXIF JPEG, MP4 mvhd)와 오디오 신호 생성기.
// 실제 파서/분석기가 다루는 정확한 바이트 레이아웃을 손으로 합성해, 모의(mock)가
// 아닌 "진짜" 입력으로 코드 경로를 검증한다.

// ── JPEG + EXIF(APP1) ─────────────────────────────────────────────────────
// 유연한 TIFF 빌더. 엔디안, Orientation 유무, 날짜 위치(SubIFD의 0x9003 또는
// IFD0의 0x0132), 날짜 생략을 모두 지원해 다양한 파싱 경로를 검증한다.
export function buildTiff({
  dateString = "2023:07:15 14:30:45",
  orientation = 6,
  little = true,
  dateLocation = "sub", // "sub" | "ifd0"
} = {}) {
  const hasOrientation = orientation != null;
  const hasDate = dateString != null;
  const dateInSub = hasDate && dateLocation === "sub";
  const dateInIfd0 = hasDate && dateLocation === "ifd0";

  let ifd0Count = 0;
  if (hasOrientation) ifd0Count++;
  if (dateInIfd0) ifd0Count++;
  if (dateInSub) ifd0Count++; // ExifIFD 포인터

  const headerLen = 8;
  const ifd0Len = 2 + ifd0Count * 12 + 4;
  const subStart = headerLen + ifd0Len;
  const subLen = dateInSub ? 2 + 1 * 12 + 4 : 0;
  const strStart = subStart + subLen;
  const strLen = hasDate ? dateString.length + 1 : 0;

  const buf = new ArrayBuffer(strStart + strLen);
  const dv = new DataView(buf);
  const s16 = (o, v) => dv.setUint16(o, v, little);
  const s32 = (o, v) => dv.setUint32(o, v, little);

  dv.setUint16(0, little ? 0x4949 : 0x4d4d, false); // "II" / "MM"
  s16(2, 0x002a);
  s32(4, 8); // IFD0 오프셋

  let o = 8;
  s16(o, ifd0Count);
  o += 2;
  const writeShort = (tag, val) => {
    s16(o, tag); s16(o + 2, 3); s32(o + 4, 1); s16(o + 8, val); o += 12;
  };
  const writeLong = (tag, val) => {
    s16(o, tag); s16(o + 2, 4); s32(o + 4, 1); s32(o + 8, val); o += 12;
  };
  const writeAscii = (tag) => {
    s16(o, tag); s16(o + 2, 2); s32(o + 4, strLen); s32(o + 8, strStart); o += 12;
  };

  if (hasOrientation) writeShort(0x0112, orientation);
  if (dateInIfd0) writeAscii(0x0132); // DateTime
  if (dateInSub) writeLong(0x8769, subStart); // ExifIFD 포인터
  s32(o, 0); o += 4; // next IFD

  if (dateInSub) {
    o = subStart;
    s16(o, 1); o += 2;
    writeAscii(0x9003); // DateTimeOriginal
    s32(o, 0); o += 4;
  }

  if (hasDate) {
    for (let i = 0; i < dateString.length; i++) {
      dv.setUint8(strStart + i, dateString.charCodeAt(i));
    }
    dv.setUint8(strStart + dateString.length, 0);
  }
  return new Uint8Array(buf);
}

export function buildJpegExif(opts) {
  const tiff = buildTiff(opts);
  const exifHeader = Uint8Array.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]); // "Exif\0\0"
  const app1Len = exifHeader.length + tiff.length;
  const total = 2 /*SOI*/ + 2 /*marker*/ + 2 /*size*/ + app1Len;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  dv.setUint16(0, 0xffd8, false); // SOI
  dv.setUint16(2, 0xffe1, false); // APP1
  dv.setUint16(4, 2 + app1Len, false); // segment size (자신의 2바이트 포함)
  u8.set(exifHeader, 6);
  u8.set(tiff, 6 + exifHeader.length);
  return buf;
}

// ── MP4 / MOV (moov > mvhd) ────────────────────────────────────────────────
function box(type, payload) {
  const size = 8 + payload.length;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, size, false);
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  buf.set(payload, 8);
  return buf;
}

// size=1 → 64-bit largesize 박스
function box64(type, payload) {
  const size = 16 + payload.length;
  const buf = new Uint8Array(size);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 1, false); // size==1 → largesize 사용 신호
  for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
  dv.setUint32(8, 0, false); // largesize 상위 32
  dv.setUint32(12, size, false); // largesize 하위 32
  buf.set(payload, 16);
  return buf;
}

function mvhdPayload(creationSeconds, version) {
  if (version === 1) {
    const payload = new Uint8Array(4 + 8 + 8 + 4 + 8);
    const dv = new DataView(payload.buffer);
    dv.setUint8(0, 1);
    dv.setUint32(4, Math.floor(creationSeconds / 2 ** 32), false);
    dv.setUint32(8, creationSeconds >>> 0, false);
    return payload;
  }
  const payload = new Uint8Array(20);
  const dv = new DataView(payload.buffer);
  dv.setUint8(0, 0);
  dv.setUint32(4, creationSeconds, false);
  return payload;
}

export function buildMp4({ creationSeconds, version = 0 } = {}) {
  const mvhd = box("mvhd", mvhdPayload(creationSeconds, version));
  const moov = box("moov", mvhd);
  // 새 ArrayBuffer로 복사해 정확히 moov 길이만 반환
  return moov.slice().buffer;
}

// moov > trak > mdia > mdhd 중첩(박스 워킹 재귀 검증용)
export function buildMp4Nested({ creationSeconds, version = 0 } = {}) {
  const mdhd = box("mdhd", mvhdPayload(creationSeconds, version));
  const mdia = box("mdia", mdhd);
  const trak = box("trak", mdia);
  const moov = box("moov", trak);
  return moov.slice().buffer;
}

// 64-bit largesize 헤더를 가진 moov(64-bit 박스 파싱 검증용)
export function buildMp4Large({ creationSeconds, version = 0 } = {}) {
  const mvhd = box("mvhd", mvhdPayload(creationSeconds, version));
  const moov = box64("moov", mvhd);
  return moov.slice().buffer;
}

// ── 합성 오디오: 일정 BPM의 킥 클릭 트랙 ─────────────────────────────────────
export function clickTrack(bpm, seconds, sampleRate) {
  const n = Math.floor(seconds * sampleRate);
  const sig = new Float32Array(n);
  const period = (60 / bpm) * sampleRate;
  const clickDur = Math.floor(0.03 * sampleRate); // 30ms
  for (let b = 0; b * period < n; b++) {
    const start = Math.floor(b * period);
    for (let i = 0; i < clickDur && start + i < n; i++) {
      const env = 1 - i / clickDur;
      sig[start + i] = Math.sin(2 * Math.PI * 60 * (i / sampleRate)) * env;
    }
  }
  return sig;
}

// ── Web Audio 모의: analyzeAudio가 쓰는 그래프 API만 채워, 합성 신호를
//    저역통과 출력처럼 그대로 통과시킨다. ─────────────────────────────────────
export function installAudioMock(signal, sampleRate, { webkit = false } = {}) {
  const audioBuffer = {
    duration: signal.length / sampleRate,
    sampleRate,
    length: signal.length,
    getChannelData: () => signal,
  };
  const prev = {
    window: globalThis.window,
    Offline: globalThis.OfflineAudioContext,
  };
  globalThis.window = globalThis.window || {};
  const AC = class {
    decodeAudioData() {
      return Promise.resolve(audioBuffer);
    }
    close() {}
  };
  // webkit 경로 검증: 표준 AudioContext가 없고 webkitAudioContext만 있는 환경
  if (webkit) {
    globalThis.window.AudioContext = undefined;
    globalThis.window.webkitAudioContext = AC;
  } else {
    globalThis.window.AudioContext = AC;
    globalThis.window.webkitAudioContext = undefined;
  }
  globalThis.OfflineAudioContext = class {
    constructor() {
      this.destination = {};
    }
    createBufferSource() {
      return { buffer: null, connect() {}, start() {} };
    }
    createBiquadFilter() {
      return { type: "", frequency: { value: 0 }, Q: { value: 0 }, connect() {} };
    }
    startRendering() {
      return Promise.resolve({ getChannelData: () => signal });
    }
  };
  return function restore() {
    globalThis.window = prev.window;
    globalThis.OfflineAudioContext = prev.Offline;
  };
}

// ── File / FileReader 모의 (metadata.extractMetadata 통합 테스트용) ──────────
export function fakeFile({ buffer, type, lastModified = Date.now() }) {
  return {
    type,
    size: buffer.byteLength,
    lastModified,
    slice(start, end) {
      return { _bytes: buffer.slice(start, end) };
    },
  };
}

export function installFileReaderMock() {
  const prev = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      queueMicrotask(() => {
        this.result = blob._bytes;
        if (this.onload) this.onload();
      });
    }
  };
  return function restore() {
    globalThis.FileReader = prev;
  };
}
