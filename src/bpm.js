// bpm.js — 업로드한 노래의 BPM(분당 비트 수)과 비트 시각을 추정합니다.
// 방식: OfflineAudioContext로 저역 통과(킥/베이스 강조) → 피크 검출 →
//       피크 간 간격 히스토그램으로 가장 그럴듯한 템포를 선택합니다.

export async function analyzeAudio(arrayBuffer) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const tmp = new AC();
  let audioBuffer;
  try {
    audioBuffer = await tmp.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    tmp.close();
  }

  const duration = audioBuffer.duration;
  const sampleRate = audioBuffer.sampleRate;

  // 저역 통과 필터를 적용한 오프라인 렌더
  const offline = new OfflineAudioContext(
    1,
    audioBuffer.length,
    sampleRate
  );
  const src = offline.createBufferSource();
  src.buffer = audioBuffer;
  const lp = offline.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 150;
  lp.Q.value = 1;
  const hp = offline.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 30;
  src.connect(lp);
  lp.connect(hp);
  hp.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  const data = rendered.getChannelData(0);

  // ── 피크 검출 (적응형 임계값) ──
  const peaks = collectPeaks(data, sampleRate);

  // ── 간격 → 템포 후보 집계 ──
  const bpm = computeBpm(peaks, sampleRate);

  // ── 다운비트 위상: 첫 강한 피크를 기준점으로 ──
  const beatInterval = 60 / bpm;
  let firstBeat = 0;
  if (peaks.length) firstBeat = peaks[0].pos / sampleRate;
  firstBeat = firstBeat % beatInterval;

  return {
    bpm: Math.round(bpm),
    bpmPrecise: bpm,
    beatInterval,
    firstBeat,
    duration,
    audioBuffer,
  };
}

function collectPeaks(data, sampleRate) {
  const len = data.length;
  // 윈도우 단위 RMS로 에너지 포락선 계산
  const win = Math.floor(sampleRate * 0.01); // 10ms
  const env = [];
  for (let i = 0; i < len; i += win) {
    let sum = 0;
    const end = Math.min(i + win, len);
    for (let j = i; j < end; j++) sum += data[j] * data[j];
    env.push(Math.sqrt(sum / (end - i)));
  }

  // 적응형 임계값 (이동 평균 + 표준편차)
  const peaks = [];
  const lookback = 30; // ~300ms
  for (let i = 1; i < env.length - 1; i++) {
    const from = Math.max(0, i - lookback);
    let mean = 0;
    for (let k = from; k < i; k++) mean += env[k];
    mean /= i - from || 1;
    const threshold = mean * 1.5 + 0.005;
    if (env[i] > threshold && env[i] >= env[i - 1] && env[i] > env[i + 1]) {
      peaks.push({ pos: i * win, energy: env[i] });
      i += 5; // 최소 간격(50ms) 확보
    }
  }
  return peaks;
}

function computeBpm(peaks, sampleRate) {
  if (peaks.length < 4) return 120;

  // 후보 간격을 BPM으로 환산해 60~180 범위로 접고 히스토그램 집계
  const counts = {};
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < Math.min(i + 12, peaks.length); j++) {
      const dt = (peaks[j].pos - peaks[i].pos) / sampleRate;
      if (dt <= 0) continue;
      let bpm = 60 / dt;
      while (bpm < 80) bpm *= 2;
      while (bpm > 180) bpm /= 2;
      const key = Math.round(bpm);
      counts[key] = (counts[key] || 0) + 1;
    }
  }

  // 인접 빈 묶음(±2)으로 가장 강한 템포 선택
  let best = 120;
  let bestScore = 0;
  for (const k in counts) {
    const center = +k;
    let score = 0;
    for (let d = -2; d <= 2; d++) score += counts[center + d] || 0;
    if (score > bestScore) {
      bestScore = score;
      best = center;
    }
  }

  // 묶음 내 가중 평균으로 정밀화
  let num = 0;
  let den = 0;
  for (let d = -2; d <= 2; d++) {
    const c = counts[best + d] || 0;
    num += (best + d) * c;
    den += c;
  }
  return den ? num / den : best;
}
