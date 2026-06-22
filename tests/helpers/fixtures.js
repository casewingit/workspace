// fixtures.js — 테스트용 바이너리(EXIF JPEG, MP4 mvhd)와 오디오 신호 생성기.
// 실제 파서/분석기가 다루는 정확한 바이트 레이아웃을 손으로 합성해, 모의(mock)가
// 아닌 "진짜" 입력으로 코드 경로를 검증한다.

// ── JPEG + EXIF(APP1) ─────────────────────────────────────────────────────
// little-endian TIFF: IFD0(Orientation, ExifIFD 포인터) → SubIFD(DateTimeOriginal)
export function buildTiff({
  dateString = "2023:07:15 14:30:45",
  orientation = 6,
} = {}) {
  const strLen = dateString.length + 1; // null 포함
  const headerLen = 8;
  const ifd0Count = 2;
  const ifd0Len = 2 + ifd0Count * 12 + 4; // 30
  const subStart = headerLen + ifd0Len; // 38
  const subLen = 2 + 1 * 12 + 4; // 18
  const strStart = subStart + subLen; // 56
  const buf = new ArrayBuffer(strStart + strLen);
  const dv = new DataView(buf);

  // TIFF 헤더
  dv.setUint16(0, 0x4949, false); // "II" (양 끝 동일)
  dv.setUint16(2, 0x002a, true);
  dv.setUint32(4, 8, true); // IFD0 오프셋

  // IFD0
  let o = 8;
  dv.setUint16(o, ifd0Count, true);
  o += 2;
  // Orientation (0x0112, SHORT)
  dv.setUint16(o, 0x0112, true);
  dv.setUint16(o + 2, 3, true);
  dv.setUint32(o + 4, 1, true);
  dv.setUint16(o + 8, orientation, true);
  o += 12;
  // ExifIFD 포인터 (0x8769, LONG)
  dv.setUint16(o, 0x8769, true);
  dv.setUint16(o + 2, 4, true);
  dv.setUint32(o + 4, 1, true);
  dv.setUint32(o + 8, subStart, true);
  o += 12;
  dv.setUint32(o, 0, true); // next IFD = 0

  // SubIFD
  o = subStart;
  dv.setUint16(o, 1, true);
  o += 2;
  // DateTimeOriginal (0x9003, ASCII)
  dv.setUint16(o, 0x9003, true);
  dv.setUint16(o + 2, 2, true);
  dv.setUint32(o + 4, strLen, true);
  dv.setUint32(o + 8, strStart, true);
  o += 12;
  dv.setUint32(o, 0, true); // next IFD = 0

  for (let i = 0; i < dateString.length; i++) {
    dv.setUint8(strStart + i, dateString.charCodeAt(i));
  }
  dv.setUint8(strStart + dateString.length, 0);
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

export function buildMp4({ creationSeconds, version = 0 } = {}) {
  let payload;
  if (version === 1) {
    payload = new Uint8Array(4 + 8 + 8 + 4 + 8);
    const dv = new DataView(payload.buffer);
    dv.setUint8(0, 1);
    dv.setUint32(4, Math.floor(creationSeconds / 2 ** 32), false);
    dv.setUint32(8, creationSeconds >>> 0, false);
  } else {
    payload = new Uint8Array(20);
    const dv = new DataView(payload.buffer);
    dv.setUint8(0, 0);
    dv.setUint32(4, creationSeconds, false);
  }
  const mvhd = box("mvhd", payload);
  const moov = box("moov", mvhd);
  // 새 ArrayBuffer로 복사해 정확히 moov 길이만 반환
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
export function installAudioMock(signal, sampleRate) {
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
  globalThis.window.AudioContext = class {
    decodeAudioData() {
      return Promise.resolve(audioBuffer);
    }
    close() {}
  };
  globalThis.window.webkitAudioContext = undefined;
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
