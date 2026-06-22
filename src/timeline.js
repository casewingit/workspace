// timeline.js — 정렬된 미디어 + 설정 + (선택) 비트 정보로 재생 타임라인을 만듭니다.

const KB_MOVES = [
  { z0: 1.0, z1: 1.12, x0: 0, y0: 0, x1: 0.04, y1: 0.0 },
  { z0: 1.12, z1: 1.0, x0: 0.04, y0: 0.03, x1: 0, y1: 0 },
  { z0: 1.0, z1: 1.1, x0: -0.03, y0: 0, x1: 0.03, y1: 0.02 },
  { z0: 1.08, z1: 1.0, x0: 0, y0: -0.03, x1: 0, y1: 0.0 },
  { z0: 1.0, z1: 1.14, x0: 0, y0: 0.03, x1: 0, y1: -0.03 },
];

export function buildTimeline(items, settings, beat) {
  const {
    photoDuration = 3,
    maxVideoDuration = 5,
    beatSync = false,
    transition = "crossfade",
    transitionDuration = 0.5,
  } = settings;

  const useBeat = beatSync && beat && beat.beatInterval > 0;
  const interval = useBeat ? beat.beatInterval : 0;

  const snap = (sec, minBeats) => {
    if (!useBeat) return sec;
    let beats = Math.round(sec / interval);
    if (beats < minBeats) beats = minBeats;
    return beats * interval;
  };

  const segments = [];
  let t = 0;
  let kbIndex = 0;

  for (const item of items) {
    let duration;
    let trimStart = 0;
    let effect = null;

    if (item.kind === "video") {
      const real = item.duration || maxVideoDuration;
      let dur = Math.min(real, maxVideoDuration);
      // 영상이 길면 가장 의미 있는 가운데 구간을 사용
      if (real > dur) trimStart = Math.min(real - dur, (real - dur) / 2);
      duration = snap(dur, 4);
      // 트림 길이가 스냅으로 늘어나면 영상 실제 길이를 넘지 않게 보정
      if (trimStart + duration > real) trimStart = Math.max(0, real - duration);
    } else {
      duration = snap(photoDuration, 4);
      const m = KB_MOVES[kbIndex % KB_MOVES.length];
      kbIndex++;
      effect = { type: "kenburns", ...m };
    }

    let transDur;
    let transKind;
    if (useBeat || transition === "cut") {
      transKind = "cut";
      transDur = useBeat ? Math.min(0.18, interval * 0.4) : 0.001;
    } else {
      transKind = "crossfade";
      transDur = Math.min(transitionDuration, duration * 0.4);
    }

    segments.push({
      media: item,
      start: t,
      duration,
      trimStart,
      effect,
      transition: transKind,
      transDur,
      beatPunch: useBeat,
    });
    t += duration;
  }

  return {
    segments,
    totalDuration: t,
    beat: useBeat ? beat : null,
  };
}
