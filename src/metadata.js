// metadata.js — 사진/영상에서 촬영 시각과 방향(orientation)을 추출합니다.
// - JPEG: EXIF APP1(IFD0/SubIFD)에서 DateTimeOriginal, Orientation
// - MP4/MOV: moov/mvhd 박스의 creation_time (1904 기준)
// 추출 실패 시 file.lastModified로 폴백합니다.

const EPOCH_1904 = -2082844800000; // 1904-01-01 ~ 1970-01-01 (ms)

// ── JPEG EXIF ────────────────────────────────────────────────────────────
function parseExif(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // SOI

  let offset = 2;
  while (offset + 4 < view.byteLength) {
    const marker = view.getUint16(offset);
    const size = view.getUint16(offset + 2);
    if ((marker & 0xff00) !== 0xff00) break;
    if (marker === 0xffe1) {
      // APP1
      const app1Start = offset + 4;
      if (view.getUint32(app1Start) === 0x45786966) {
        // "Exif"
        return readTiff(view, app1Start + 6);
      }
    }
    offset += 2 + size;
  }
  return null;
}

function readTiff(view, tiffStart) {
  const little = view.getUint16(tiffStart) === 0x4949;
  const get16 = (o) => view.getUint16(o, little);
  const get32 = (o) => view.getUint32(o, little);

  if (get16(tiffStart + 2) !== 0x002a) return null;
  const ifd0 = tiffStart + get32(tiffStart + 4);

  const result = {};
  const readIFD = (dirStart) => {
    const entries = get16(dirStart);
    let exifSub = null;
    for (let i = 0; i < entries; i++) {
      const e = dirStart + 2 + i * 12;
      const tag = get16(e);
      const type = get16(e + 2);
      const valOff = e + 8;
      if (tag === 0x0112) result.orientation = get16(valOff); // Orientation
      if (tag === 0x8769) exifSub = tiffStart + get32(valOff); // ExifIFD pointer
      if (tag === 0x9003 || tag === 0x0132) {
        // DateTimeOriginal / DateTime, ASCII 20 bytes
        if (type === 2) {
          const strOff = tiffStart + get32(valOff);
          let s = "";
          for (let k = 0; k < 19; k++) {
            const c = view.getUint8(strOff + k);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          if (!result.dateString || tag === 0x9003) result.dateString = s;
        }
      }
    }
    return exifSub;
  };

  const sub = readIFD(ifd0);
  if (sub) readIFD(sub);

  let date = null;
  if (result.dateString) {
    // "YYYY:MM:DD HH:MM:SS"
    const m = result.dateString.match(
      /(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
    );
    if (m) {
      date = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    }
  }
  return { date, orientation: result.orientation || 1 };
}

// ── MP4 / MOV mvhd ───────────────────────────────────────────────────────
function parseMp4Date(buffer) {
  const view = new DataView(buffer);
  const len = view.byteLength;

  function walk(start, end) {
    let off = start;
    while (off + 8 <= end) {
      let size = view.getUint32(off);
      const type = String.fromCharCode(
        view.getUint8(off + 4),
        view.getUint8(off + 5),
        view.getUint8(off + 6),
        view.getUint8(off + 7)
      );
      let headerSize = 8;
      if (size === 1) {
        // 64-bit size
        size = view.getUint32(off + 8) * 2 ** 32 + view.getUint32(off + 12);
        headerSize = 16;
      }
      if (size < headerSize || off + size > end) break;

      if (type === "moov" || type === "trak" || type === "mdia") {
        const r = walk(off + headerSize, off + size);
        if (r) return r;
      } else if (type === "mvhd" || type === "mdhd") {
        const vOff = off + headerSize;
        const version = view.getUint8(vOff);
        let creation;
        if (version === 1) {
          creation = view.getUint32(vOff + 4) * 2 ** 32 + view.getUint32(vOff + 8);
        } else {
          creation = view.getUint32(vOff + 4);
        }
        if (creation > 0) {
          return new Date(EPOCH_1904 + creation * 1000);
        }
      }
      off += size;
    }
    return null;
  }
  return walk(0, len);
}

function readChunk(file, start, length) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file.slice(start, start + length));
  });
}

// 공개 API: 파일에서 촬영 시각(date)과 방향(orientation)을 추출합니다.
export async function extractMetadata(file) {
  const fallback = new Date(file.lastModified || Date.now());
  try {
    if (file.type.startsWith("image/")) {
      const buf = await readChunk(file, 0, Math.min(file.size, 256 * 1024));
      const exif = parseExif(buf);
      if (exif) {
        return {
          date: exif.date || fallback,
          orientation: exif.orientation || 1,
          fromMeta: !!exif.date,
        };
      }
    } else if (file.type.startsWith("video/")) {
      // mvhd는 보통 파일 앞쪽 또는 끝쪽에 위치 → 앞 2MB 우선 탐색
      const head = await readChunk(file, 0, Math.min(file.size, 2 * 1024 * 1024));
      let d = parseMp4Date(head);
      if (!d && file.size > 2 * 1024 * 1024) {
        const tail = await readChunk(
          file,
          Math.max(0, file.size - 2 * 1024 * 1024),
          2 * 1024 * 1024
        );
        d = parseMp4Date(tail);
      }
      if (d && !isNaN(d.getTime())) {
        return { date: d, orientation: 1, fromMeta: true };
      }
    }
  } catch (e) {
    /* 폴백 사용 */
  }
  return { date: fallback, orientation: 1, fromMeta: false };
}
