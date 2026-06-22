import { extractMetadata } from "./src/metadata.js";
import { analyzeAudio } from "./src/bpm.js";
import { buildTimeline } from "./src/timeline.js";
import { RenderEngine } from "./src/renderer.js";

// ── 상태 ──────────────────────────────────────────────────────────────────
const state = {
  items: [], // {id, file, kind, url, name, date, orientation, duration, thumb, fromMeta}
  music: null, // {file, url, name, analysis}
  settings: {
    aspect: "16:9",
    quality: 1080,
    photoDuration: 3,
    maxVideoDuration: 5,
    transition: "crossfade",
    beatSync: false,
  },
  engine: null,
  resultUrl: null,
};
let uid = 0;

// ── DOM ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const fileInput = $("fileInput");
const mediaArea = $("mediaArea");
const grid = $("grid");
const previewCanvas = $("preview");

// ── 유틸 ──────────────────────────────────────────────────────────────────
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}
function fmtTime(d) {
  if (!(d instanceof Date) || isNaN(d)) return "—";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}
function fmtDur(s) {
  s = Math.round(s);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return m ? `${m}분 ${ss}초` : `${ss}초`;
}

function dims() {
  const q = state.settings.quality;
  const long = q >= 1080 ? 1920 : 1280;
  switch (state.settings.aspect) {
    case "9:16":
      return { width: Math.round((long * 9) / 16), height: long };
    case "1:1":
      return { width: q, height: q };
    default:
      return { width: long, height: Math.round((long * 9) / 16) };
  }
}

// ── 미디어 인제스트 ─────────────────────────────────────────────────────────
function videoMeta(url) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.src = url;
    const done = (duration) => {
      const seekTo = Math.min(1, (duration || 2) / 2);
      const grab = () => {
        const c = document.createElement("canvas");
        const size = 360;
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d");
        const vw = v.videoWidth || size;
        const vh = v.videoHeight || size;
        const scale = Math.max(size / vw, size / vh);
        const dw = vw * scale;
        const dh = vh * scale;
        try {
          ctx.drawImage(v, (size - dw) / 2, (size - dh) / 2, dw, dh);
        } catch (e) {}
        resolve({ duration: duration || 0, thumb: c.toDataURL("image/jpeg", 0.7) });
      };
      v.onseeked = grab;
      try {
        v.currentTime = seekTo;
      } catch (e) {
        grab();
      }
    };
    v.onloadedmetadata = () => done(v.duration);
    v.onerror = () => resolve({ duration: 0, thumb: null });
    setTimeout(() => resolve({ duration: v.duration || 0, thumb: null }), 5000);
  });
}

async function ingest(files) {
  const list = Array.from(files).filter(
    (f) => f.type.startsWith("image/") || f.type.startsWith("video/")
  );
  if (!list.length) {
    toast("지원하는 사진·영상 파일이 없어요.");
    return;
  }
  showMediaArea();
  for (const file of list) {
    const url = URL.createObjectURL(file);
    const kind = file.type.startsWith("video/") ? "video" : "photo";
    const item = {
      id: ++uid,
      file,
      url,
      kind,
      name: file.name,
      orientation: 1,
      duration: 0,
      thumb: kind === "photo" ? url : null,
      date: new Date(file.lastModified || Date.now()),
      fromMeta: false,
    };
    state.items.push(item);
    renderGrid();

    // 메타데이터 + (영상)썸네일 비동기 채우기
    extractMetadata(file).then((meta) => {
      item.date = meta.date;
      item.orientation = meta.orientation;
      item.fromMeta = meta.fromMeta;
      autoSort(false);
    });
    if (kind === "video") {
      videoMeta(url).then((m) => {
        item.duration = m.duration;
        if (m.thumb) item.thumb = m.thumb;
        renderGrid();
        updateStats();
      });
    }
  }
  autoSort(false);
  updateStats();
  updateButtons();
}

function autoSort(notify = true) {
  state.items.sort((a, b) => a.date - b.date);
  renderGrid();
  if (notify) toast("촬영 시간순으로 정렬했어요. 🕒");
}

// ── 그리드 렌더 ────────────────────────────────────────────────────────────
// 타일은 innerHTML 보간 없이 DOM API로 구성한다(텍스트는 textContent, URL은
// 속성 설정). 파일명 등 사용자 제어 문자열이 들어와도 XSS가 성립하지 않는다.
function renderGrid() {
  grid.replaceChildren();
  state.items.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "tile";
    li.draggable = true;
    li.dataset.id = item.id;

    if (item.thumb) {
      const img = document.createElement("img");
      img.src = item.thumb; // 속성 설정 — 마크업 파싱이 아니므로 안전
      img.alt = "";
      li.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.style.cssText =
        "width:100%;height:100%;display:grid;place-items:center;color:#666;";
      ph.textContent = "불러오는 중…";
      li.appendChild(ph);
    }

    const order = document.createElement("span");
    order.className = "tile__order";
    order.textContent = String(i + 1);
    li.appendChild(order);

    const del = document.createElement("button");
    del.className = "tile__del";
    del.title = "삭제";
    del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      removeItem(item.id);
    });
    li.appendChild(del);

    if (!item.fromMeta) {
      const nometa = document.createElement("span");
      nometa.className = "tile__nometa";
      nometa.title = "메타데이터 없음 — 파일 시간 사용";
      nometa.textContent = "추정";
      li.appendChild(nometa);
    }

    const badge = document.createElement("div");
    badge.className = "tile__badge";

    const time = document.createElement("span");
    time.className = "tile__time";
    time.textContent = fmtTime(item.date);
    badge.appendChild(time);

    const type = document.createElement("span");
    if (item.kind === "video") {
      type.className = "tile__type vid";
      const secs = item.duration
        ? Math.min(item.duration, state.settings.maxVideoDuration).toFixed(1) + "s"
        : "";
      type.textContent = `🎬 ${secs}`;
    } else {
      type.className = "tile__type";
      type.textContent = "📷";
    }
    badge.appendChild(type);
    li.appendChild(badge);

    grid.appendChild(li);
  });
  bindDrag();
}

function removeItem(id) {
  const idx = state.items.findIndex((x) => x.id === id);
  if (idx < 0) return;
  URL.revokeObjectURL(state.items[idx].url);
  state.items.splice(idx, 1);
  renderGrid();
  updateStats();
  updateButtons();
  if (!state.items.length) hideMediaArea();
}

// ── 드래그 재정렬 ───────────────────────────────────────────────────────────
let dragId = null;
function bindDrag() {
  grid.querySelectorAll(".tile").forEach((tile) => {
    tile.addEventListener("dragstart", () => {
      dragId = +tile.dataset.id;
      tile.classList.add("dragging");
    });
    tile.addEventListener("dragend", () => {
      tile.classList.remove("dragging");
      grid.querySelectorAll(".over").forEach((t) => t.classList.remove("over"));
    });
    tile.addEventListener("dragover", (e) => {
      e.preventDefault();
      tile.classList.add("over");
    });
    tile.addEventListener("dragleave", () => tile.classList.remove("over"));
    tile.addEventListener("drop", (e) => {
      e.preventDefault();
      const targetId = +tile.dataset.id;
      if (dragId === null || dragId === targetId) return;
      const from = state.items.findIndex((x) => x.id === dragId);
      const to = state.items.findIndex((x) => x.id === targetId);
      const [moved] = state.items.splice(from, 1);
      state.items.splice(to, 0, moved);
      renderGrid();
    });
  });
}

// ── 통계/버튼 ──────────────────────────────────────────────────────────────
function updateStats() {
  $("statTotal").textContent = `미디어 ${state.items.length}개`;
  const plan = currentPlan();
  $("statLen").textContent = `예상 길이 ${plan ? fmtDur(plan.totalDuration) : "0초"}`;
}
function updateButtons() {
  const ok = state.items.length > 0;
  $("generate").disabled = !ok;
  $("previewBtn").disabled = !ok;
  $("previewEmpty").classList.toggle("hidden", ok);
}

// ── 플랜 ───────────────────────────────────────────────────────────────────
function currentPlan() {
  if (!state.items.length) return null;
  const items = state.items.map((it) => ({
    id: it.id,
    kind: it.kind,
    url: it.url,
    duration: it.duration,
    orientation: it.orientation,
  }));
  const beat =
    state.settings.beatSync && state.music && state.music.analysis
      ? state.music.analysis
      : null;
  return buildTimeline(items, state.settings, beat);
}

// ── 미리보기 ───────────────────────────────────────────────────────────────
async function startPreview() {
  if (state.engine) stopPreview();
  const plan = currentPlan();
  if (!plan) return;
  const d = dims();
  // 미리보기는 가볍게: 가로 최대 960
  const scale = Math.min(1, 960 / d.width);
  const pw = Math.round(d.width * scale);
  const ph = Math.round(d.height * scale);
  previewCanvas.style.aspectRatio = `${d.width} / ${d.height}`;

  state.engine = new RenderEngine(previewCanvas, plan, {
    width: pw,
    height: ph,
    fps: 30,
    music: state.music ? { url: state.music.url } : null,
  });
  $("previewBtn").classList.add("hidden");
  $("stopBtn").classList.remove("hidden");
  $("previewEmpty").classList.add("hidden");
  try {
    await state.engine.play({ record: false });
  } catch (e) {
    console.error(e);
  }
  stopPreview();
}
function stopPreview() {
  if (state.engine) {
    state.engine.dispose();
    state.engine = null;
  }
  $("previewBtn").classList.remove("hidden");
  $("stopBtn").classList.add("hidden");
}

// ── 영상 생성 ──────────────────────────────────────────────────────────────
async function generate() {
  if (!state.items.length) return;
  if (state.engine) stopPreview();
  const plan = currentPlan();
  const d = dims();

  $("generate").disabled = true;
  $("result").classList.add("hidden");
  $("progress").classList.remove("hidden");
  setProgress(0, "미디어 로딩 중…");

  // 오프스크린 캔버스에 풀 해상도로 렌더
  const off = document.createElement("canvas");
  const engine = new RenderEngine(off, plan, {
    width: d.width,
    height: d.height,
    fps: 30,
    music: state.music ? { url: state.music.url } : null,
    bitrate: state.settings.quality >= 1080 ? 12_000_000 : 7_000_000,
  });

  try {
    const { blob } = await engine.play({
      record: true,
      onProgress: (p) =>
        setProgress(p, `영상 렌더링 중… ${Math.round(p * 100)}%`),
    });
    engine.dispose();
    if (!blob || !blob.size) throw new Error("빈 결과");
    showResult(blob);
  } catch (e) {
    console.error(e);
    toast("영상 생성에 실패했어요. 브라우저를 새로고침 후 다시 시도해 주세요.");
    $("progress").classList.add("hidden");
  } finally {
    $("generate").disabled = false;
  }
}

function setProgress(p, text) {
  $("progressFill").style.width = `${Math.round(p * 100)}%`;
  if (text) $("progressText").textContent = text;
}

function showResult(blob) {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(blob);
  $("progress").classList.add("hidden");
  $("result").classList.remove("hidden");
  const video = $("resultVideo");
  video.src = state.resultUrl;
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
    now.getDate()
  ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
  const dl = $("downloadBtn");
  dl.href = state.resultUrl;
  dl.download = `wandercut_${stamp}.webm`;
  toast("✨ 여행 영상이 완성됐어요!");
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── 음악 ───────────────────────────────────────────────────────────────────
async function loadMusic(file) {
  if (!file || !file.type.startsWith("audio/")) {
    toast("오디오 파일을 넣어 주세요.");
    return;
  }
  if (state.music) URL.revokeObjectURL(state.music.url);
  const url = URL.createObjectURL(file);
  state.music = { file, url, name: file.name, analysis: null };
  $("musicDrop").classList.add("hidden");
  $("musicInfo").classList.remove("hidden");
  $("musicName").textContent = file.name;
  $("bpmBadge").textContent = "BPM 분석 중…";
  $("musicLen").textContent = "";

  try {
    const buf = await file.arrayBuffer();
    const analysis = await analyzeAudio(buf);
    state.music.analysis = analysis;
    $("bpmBadge").textContent = `${analysis.bpm} BPM`;
    $("musicLen").textContent = fmtDur(analysis.duration);
    updateStats();
  } catch (e) {
    console.error(e);
    $("bpmBadge").textContent = "BPM 분석 실패";
    toast("이 파일의 BPM을 분석하지 못했어요. 비트 싱크 없이도 사용할 수 있어요.");
  }
}
function removeMusic() {
  if (state.music) URL.revokeObjectURL(state.music.url);
  state.music = null;
  $("beatSync").checked = false;
  state.settings.beatSync = false;
  $("musicInfo").classList.add("hidden");
  $("musicDrop").classList.remove("hidden");
  updateStats();
}

// ── 화면 전환 ──────────────────────────────────────────────────────────────
function showMediaArea() {
  dropzone.classList.add("hidden");
  mediaArea.classList.remove("hidden");
}
function hideMediaArea() {
  dropzone.classList.remove("hidden");
  mediaArea.classList.add("hidden");
}

// ── 이벤트 바인딩 ───────────────────────────────────────────────────────────
function bindUI() {
  $("pickBtn").addEventListener("click", () => fileInput.click());
  $("addMore").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    ingest(e.target.files);
    fileInput.value = "";
  });

  // 드롭존
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
    })
  );
  dropzone.addEventListener("drop", (e) => ingest(e.dataTransfer.files));

  // 전체 페이지 드롭(미디어 영역에서도)
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    if (e.target.closest("#musicDrop") || e.target.closest(".music-card")) return;
    if (mediaArea.classList.contains("hidden")) return;
    e.preventDefault();
    if (e.dataTransfer.files.length) ingest(e.dataTransfer.files);
  });

  $("sortByTime").addEventListener("click", () => autoSort(true));
  $("clearAll").addEventListener("click", () => {
    state.items.forEach((it) => URL.revokeObjectURL(it.url));
    state.items = [];
    renderGrid();
    updateStats();
    updateButtons();
    hideMediaArea();
  });

  // 음악
  $("musicBtn").addEventListener("click", () => $("musicInput").click());
  $("musicInput").addEventListener("change", (e) => {
    if (e.target.files[0]) loadMusic(e.target.files[0]);
    e.target.value = "";
  });
  $("musicRemove").addEventListener("click", removeMusic);
  const md = $("musicDrop");
  ["dragenter", "dragover"].forEach((ev) =>
    md.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      md.classList.add("drag");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    md.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      md.classList.remove("drag");
    })
  );
  md.addEventListener("drop", (e) => {
    if (e.dataTransfer.files[0]) loadMusic(e.dataTransfer.files[0]);
  });

  $("beatSync").addEventListener("change", (e) => {
    if (e.target.checked && !state.music) {
      toast("먼저 배경 음악을 넣어 주세요. 🎵");
      e.target.checked = false;
      return;
    }
    state.settings.beatSync = e.target.checked;
    updateStats();
  });

  // 세그먼트 버튼들
  const segHandler = (id, key, cast = (v) => v) => {
    $(id).addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      $(id)
        .querySelectorAll("button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.settings[key] = cast(btn.dataset.v);
      updateStats();
    });
  };
  segHandler("aspect", "aspect");
  segHandler("quality", "quality", Number);
  segHandler("trans", "transition");

  $("photoDur").addEventListener("input", (e) => {
    state.settings.photoDuration = +e.target.value;
    $("photoDurVal").textContent = (+e.target.value).toFixed(1) + "초";
    updateStats();
  });
  $("vidDur").addEventListener("input", (e) => {
    state.settings.maxVideoDuration = +e.target.value;
    $("vidDurVal").textContent = (+e.target.value).toFixed(1) + "초";
    renderGrid();
    updateStats();
  });

  $("previewBtn").addEventListener("click", startPreview);
  $("stopBtn").addEventListener("click", stopPreview);
  $("generate").addEventListener("click", generate);
  $("remakeBtn").addEventListener("click", () => {
    $("result").classList.add("hidden");
  });
}

bindUI();
updateButtons();
updateStats();
