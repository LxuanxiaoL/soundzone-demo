/* Local stereo → binaural convolution. Shared volume; solo references use a -1.5 dB listening trim. */
"use strict";
const $ = (id) => document.getElementById(id);
const audio = $("musicAudio");
const state = {
  manifest: null, variant: "fixed", mode: "dual", head: "left",
  poses: {left: {ix: 0, iy: 0}, right: {ix: 0, iy: 0}},
  tracks: [], trackIndex: -1, localTracks: [],
  ctx: null, source: null, splitter: null, master: null, bank: null, pendingBank: null,
  requestId: 0, cache: new Map(), muted: false, volume: .65, ready: false, lastResponseError: null,
  centerAttenuationDb: 1.5, liveBanks: new Set(),
  outputBus: null, headphoneEqNode: null, headphoneEqLoad: null, headphoneEqKey: null,
  headphoneEqState: "idle", headphoneEqLabel: "", outputRouteReady: false, outputRouteId: 0,
};
const modes = {solo_left: "单左座 · 原始声场", solo_right: "单右座 · 原始声场", dual: "双座 · 滤波声场"};
const headNames = {left: "左座", right: "右座"};
const colors = {left: "#16705a", right: "#aa652f"};
const escapeHTML = (text) => String(text).replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const signed = (number, digits = 1) => `${number >= 0 ? "+" : ""}${number.toFixed(digits)}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const step = () => Number(state.manifest?.step_m ?? .025);
const maxIndex = (axis) => Number(state.manifest?.movement_bounds?.[`max_offset_index_${axis}`] ?? state.manifest?.[`max_offset_index_${axis}`] ?? state.manifest?.max_offset_index ?? 4);
const minIndex = (axis) => Number(state.manifest?.movement_bounds?.[`min_offset_index_${axis}`] ?? state.manifest?.[`min_offset_index_${axis}`] ?? -maxIndex(axis));
function positionAllowed(zone, ix, iy) {
  if (ix < minIndex("x") || ix > maxIndex("x") || iy < minIndex("y") || iy > maxIndex("y")) return false;
  const key = `${ix},${iy}`;
  const allowed = state.manifest?.allowed_positions?.[zone];
  if (Array.isArray(allowed)) return allowed.includes(key);
  if (allowed && typeof allowed === "object") return Object.hasOwn(allowed, key) && allowed[key] !== false && allowed[key] != null;
  if (!state.manifest) return true;
  return Boolean(effectiveAcousticVariant()?.responses?.[state.mode]?.[zone]?.[key]);
}
function hasRestrictedRearRow() {
  const zone = state.head, y = minIndex("y");
  let valid = 0;
  for (let x = minIndex("x"); x <= maxIndex("x"); x++) if (positionAllowed(zone, x, y)) valid++;
  return valid > 0 && valid < maxIndex("x") - minIndex("x") + 1;
}
const movementRangeText = () => {
  const cm = (index) => Number((Math.abs(index) * step() * 100).toFixed(2));
  const x = minIndex("x") === -maxIndex("x") ? `横向 ±${cm(maxIndex("x"))} cm` : `左移 ${cm(minIndex("x"))} / 右移 ${cm(maxIndex("x"))} cm`;
  const y = minIndex("y") === -maxIndex("y") ? `前后 ±${cm(maxIndex("y"))} cm` : `前移 ${cm(maxIndex("y"))} cm · 后移 ${cm(minIndex("y"))} cm`;
  return `${x} · ${y}${hasRestrictedRearRow() ? " · 后排横移受限" : ""}`;
};
function selectedSpeakers() {
  const variant = state.manifest?.variants?.[state.variant];
  const raw = variant?.speakers ?? state.manifest?.speakers ?? [];
  return Array.isArray(raw) ? raw : Object.entries(raw).map(([id, data]) => ({id, ...data}));
}
function referenceSpeakerIndices(mode) {
  const variant = state.manifest?.variants?.[state.variant];
  const indices = variant?.reference_speaker_indices?.[mode] ?? state.manifest?.reference_speaker_indices?.[mode] ?? (mode === "solo_left" ? [0,1] : [2,3]);
  const count = selectedSpeakers().length;
  return Array.isArray(indices) ? indices.filter(index => Number.isInteger(index) && index >= 0 && index < count) : [];
}
const timeText = (value) => Number.isFinite(value) ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}` : "0:00";

function banner(text, kind = "ready") {
  $("statusBanner").className = `status-banner ${kind}`;
  $("statusBanner").replaceChildren();
  if (kind === "loading") {
    const spinner = document.createElement("span"); spinner.className = "spinner";
    $("statusBanner").append(spinner);
  }
  $("statusBanner").append(document.createTextNode(text));
}

function readyText() {
  const pose = state.poses[state.head];
  return `${headNames[state.head]}耳机试听 · ${modes[state.mode]} · 偏移 x ${signed(pose.ix * step() * 100)} / y ${signed(pose.iy * step() * 100)} cm`;
}

function drawStage() {
  const heads = state.manifest?.heads ?? {left: {x_m: -.6, y_m: -.5, z_m: 1.2}, right: {x_m: .6, y_m: -.5, z_m: 1.2}};
  const speakers = selectedSpeakers();
  const activeSpeakerIndices = new Set(state.mode === "dual" ? speakers.map((_, index) => index) : referenceSpeakerIndices(state.mode));
  const all = [...Object.values(heads), ...speakers];
  const limitX = Math.max(1.5, ...all.map((p) => Math.abs(Number(p.x_m ?? p.x ?? 0)) + .32));
  const maxY = Math.max(.8, ...all.map((p) => Number(p.y_m ?? p.y ?? 0) + .35));
  const minY = Math.min(-1, ...all.map((p) => Number(p.y_m ?? p.y ?? 0) - .5));
  const scale = Math.min(585 / (limitX * 2), 325 / (maxY - minY));
  const X = (x) => 360 + x * scale;
  const Y = (y) => 222 + ((maxY + minY) / 2 - y) * scale;
  const coordinate = (p, axis) => Number(p[`${axis}_m`] ?? p[axis] ?? 0);
  let svg = `<defs><pattern id="grid" width="${scale*.25}" height="${scale*.25}" patternUnits="userSpaceOnUse" x="${X(0)}" y="${Y(0)}"><path d="M ${scale*.25} 0 L 0 0 0 ${scale*.25}" fill="none" stroke="#dce3df" stroke-opacity=".5" stroke-width=".6"/></pattern><radialGradient id="zoneGlow"><stop offset="0" stop-color="#16705a" stop-opacity=".055"/><stop offset="1" stop-color="#16705a" stop-opacity="0"/></radialGradient></defs>`;
  svg += `<rect x="38" y="34" width="644" height="407" rx="10" fill="url(#grid)"/><rect x="38" y="34" width="644" height="407" rx="10" fill="none" stroke="#dce3df" stroke-width="1"/><line x1="360" y1="34" x2="360" y2="441" stroke="#a7b6af" stroke-width=".8" stroke-dasharray="3 8"/><text x="648" y="424" font-family="Segoe UI,sans-serif" font-size="14" fill="#5f6b67">x →</text><text x="372" y="57" font-family="Segoe UI,sans-serif" font-size="14" fill="#5f6b67">y ↑</text>`;
  for (const zone of ["left", "right"]) {
    const h = heads[zone]; if (!h) continue;
    const bx = coordinate(h,"x"), by = coordinate(h,"y");
    for (const index of activeSpeakerIndices) {
      const speaker = speakers[index];
      svg += `<line x1="${X(coordinate(speaker,"x"))}" y1="${Y(coordinate(speaker,"y"))}" x2="${X(bx)}" y2="${Y(by)}" stroke="${colors[zone]}" stroke-opacity=".13" stroke-width="1" stroke-dasharray="4 6"/>`;
    }
    const rows = [];
    for (let iy = minIndex("y"); iy <= maxIndex("y"); iy++) {
      const xs = [];
      for (let ix = minIndex("x"); ix <= maxIndex("x"); ix++) if (positionAllowed(zone, ix, iy)) xs.push(ix);
      if (xs.length) rows.push({iy, left:xs[0], right:xs[xs.length-1]});
    }
    const boundary = [...rows.map(row => [row.right, row.iy]), ...rows.slice().reverse().map(row => [row.left, row.iy])];
    const regionPath = boundary.map(([ix,iy], index) => `${index ? "L" : "M"} ${X(bx+ix*step())} ${Y(by+iy*step())}`).join(" ") + (boundary.length ? " Z" : "");
    svg += `<circle cx="${X(bx)}" cy="${Y(by)}" r="88" fill="url(#zoneGlow)"/><path d="${regionPath}" fill="${colors[zone]}" fill-opacity=".035" stroke="${colors[zone]}" stroke-opacity=".35" stroke-dasharray="2 4"/><line x1="${X(bx)-5}" x2="${X(bx)+5}" y1="${Y(by)}" y2="${Y(by)}" stroke="${colors[zone]}" stroke-opacity=".3"/><line x1="${X(bx)}" x2="${X(bx)}" y1="${Y(by)-5}" y2="${Y(by)+5}" stroke="${colors[zone]}" stroke-opacity=".3"/>`;
    const pose = state.poses[zone], px = X(bx + pose.ix * step()), py = Y(by + pose.iy * step());
    const active = zone === state.head;
    svg += `<g data-select-head="${zone}" style="cursor:pointer" role="button" aria-label="选择${headNames[zone]}"><circle cx="${px}" cy="${py}" r="32" fill="transparent"/>${active ? `<circle cx="${px}" cy="${py}" r="25" fill="${colors[zone]}" fill-opacity=".035" stroke="${colors[zone]}" stroke-opacity=".5" stroke-width="1"/>` : ""}<path d="M ${px-16} ${py+7} Q ${px-20} ${py-9} ${px-11} ${py-18} Q ${px-7} ${py-22} ${px-4} ${py-18} L ${px} ${py-24} L ${px+4} ${py-18} Q ${px+7} ${py-22} ${px+11} ${py-18} Q ${px+20} ${py-9} ${px+16} ${py+7} Q ${px+9} ${py+20} ${px} ${py+20} Q ${px-9} ${py+20} ${px-16} ${py+7} Z" fill="#ffffff" stroke="${colors[zone]}" stroke-width="1.6"/><path d="M ${px-17} ${py-5} L ${px-21} ${py-4} L ${px-20} ${py+5} L ${px-17} ${py+7} M ${px+17} ${py-5} L ${px+21} ${py-4} L ${px+20} ${py+5} L ${px+17} ${py+7}" fill="none" stroke="${colors[zone]}" stroke-width="1.6"/><text x="${X(bx)}" y="${Y(by)+64}" text-anchor="middle" fill="${colors[zone]}" font-size="16" font-family="Microsoft YaHei,Segoe UI,sans-serif">${zone === "left" ? "L / 左座" : "R / 右座"}</text><text x="${X(bx)}" y="${Y(by)+84}" text-anchor="middle" fill="#5f6b67" font-size="14" font-family="Segoe UI,sans-serif">${active ? "正在试听" : "未选中"}</text></g>`;
  }
  const groups = new Map();
  speakers.forEach((s,i) => {
    const key = `${coordinate(s,"x")},${coordinate(s,"y")}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({...s, index:i});
  });
  for (const group of groups.values()) {
    const point = group[0], px = X(coordinate(point,"x")), py = Y(coordinate(point,"y"));
    group.forEach((speaker, j) => {
      const enabled = activeSpeakerIndices.has(speaker.index);
      const offset = (j - (group.length-1)/2)*25;
      const color = enabled ? "#344a41" : "#87968f";
      const rear = speaker.index >= 4;
      const halfWidth = rear ? 7 : 10, height = rear ? 22 : 34;
      svg += `<g opacity="${enabled ? 1 : .5}"><title>${escapeHTML(`S${speaker.index+1} · ${speaker.id ?? "扬声器"} · x ${coordinate(speaker,"x")} / y ${coordinate(speaker,"y")} / z ${coordinate(speaker,"z")} m`)}</title><rect x="${px-halfWidth+offset}" y="${py-height/2}" width="${2*halfWidth}" height="${height}" rx="4" fill="#f0f4f1" stroke="${color}" stroke-width="1.1"/><circle cx="${px+offset}" cy="${py+height*.16}" r="${rear ? 3.8 : 5.5}" fill="none" stroke="${color}" stroke-width="1"/><circle cx="${px+offset}" cy="${py-height*.27}" r="2" fill="${color}"/></g>`;
    });
    const rearGroup = group.every(speaker => speaker.index >= 4);
    svg += `<text x="${px}" y="${py+(rearGroup ? 25 : -33)}" text-anchor="middle" fill="#344a41" font-size="14" font-family="Segoe UI,sans-serif">${group.map(s => `S${s.index+1}`).join(" / ")}</text>`;
    if (group.length > 1) svg += `<text x="${px}" y="${py+43}" text-anchor="middle" fill="#5f6b67" font-size="13" font-family="Microsoft YaHei,sans-serif">同位置 · 上下叠放</text>`;
  }
  $("stage").innerHTML = svg;
  $("stage").querySelectorAll("[data-select-head]").forEach(node => node.addEventListener("click", () => selectHead(node.dataset.selectHead)));
}

function updateControls() {
  document.querySelectorAll("[data-mode]").forEach(button => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active));
  });
  for (const zone of ["left", "right"]) {
    const title = zone === "left" ? "Left" : "Right", pose = state.poses[zone];
    $("select"+title).classList.toggle("selected", zone === state.head);
    $("select"+title).setAttribute("aria-pressed", String(zone === state.head));
    $("pose"+title).textContent = `x ${signed(pose.ix*step()*100)} / y ${signed(pose.iy*step()*100)} cm`;
  }
  $("activeHeadLabel").textContent = headNames[state.head];
  $("stepLabel").textContent = `每步 ${step()*100} cm`;
  $("rangeLabel").textContent = movementRangeText();
  $("helpMoveHint").textContent = `移动所选头部，每步 ${step()*100} cm；${movementRangeText()}`;
  const pose = state.poses[state.head];
  document.querySelectorAll("[data-move]").forEach(button => {
    const [dx,dy] = button.dataset.move.split(",").map(Number);
    button.disabled = !state.manifest || !positionAllowed(state.head, pose.ix+dx, pose.iy+dy);
  });
  updateCenterTrimControls();
  drawStage();
}

function selectHead(head) {
  if (!state.ready) return;
  if (!Object.hasOwn(state.poses, head)) return;
  state.head = head; updateControls(); requestResponse();
}
function selectMode(mode) {
  if (!state.ready) return;
  if (!Object.hasOwn(modes, mode)) return;
  state.mode = mode; updateControls(); requestResponse();
}
function moveHead(dx, dy) {
  if (!state.ready) return;
  const pose = state.poses[state.head], limitX = maxIndex("x"), limitY = maxIndex("y");
  const ix = clamp(pose.ix+dx,minIndex("x"),limitX), iy = clamp(pose.iy+dy,minIndex("y"),limitY);
  if (ix === pose.ix && iy === pose.iy) return;
  if (!positionAllowed(state.head, ix, iy)) return;
  pose.ix=ix; pose.iy=iy; updateControls(); requestResponse();
}
function resetPose() {
  if (!state.ready) return;
  state.poses[state.head] = {ix:0,iy:0}; updateControls(); requestResponse();
}

function updateVariantInfo() {
  const manifest = state.manifest ?? {};
  const variant = manifest.variants?.[state.variant] ?? {};
  const profile = manifest.audition_profile;
  const artifacts = manifest.player_artifacts ?? {};
  $("filterKind").textContent = variant.label ?? "固定滤波器";
  const speakers = selectedSpeakers();
  $("dualModeHint").textContent = `左右同曲 · ${speakers.length} 扬声器滤波`;
  const centerHeight = speakers.length >= 3 ? Math.abs(Number(speakers[1].z_m)-Number(speakers[2].z_m))*100 : null;
  $("speakerSpacing").textContent = `${speakers.length} 只扬声器${Number.isFinite(centerHeight) ? ` · 中间双箱竖向间距 ${Number(centerHeight.toFixed(1))} cm` : ""}`;
  const links = {
    report: variant.report_url ?? manifest.report_url ?? artifacts.report,
    filters: variant.filter_url ?? manifest.filter_url ?? artifacts.filters,
  };
  for (const [key, id] of [["report", "reportLink"], ["filters", "filtersLink"]]) {
    const link = $(id);
    link.hidden = !links[key];
    if (links[key]) link.href = links[key];
    else link.removeAttribute("href");
  }
  $("artifactLinks").hidden = !links.report && !links.filters;
  $("auditionProfileStatus").hidden = !profile;
  $("auditionProfileStatus").textContent = profile ? `试听声场：${profile.label ?? profile.id ?? "当前试听配置"} · ${profile.design_matches_audition === true ? "报告与 FIR 使用同一声学模型" : "报告与 FIR 下载保留原设计模型"}` : "";
  $("simulationNote").textContent = profile?.note ?? variant.render_note ?? manifest.render_note ?? "";
  updateCenterTrimControls();
}

function effectiveAcousticVariant() {
  const manifest = state.manifest;
  if (manifest?.audition_profile != null) {
    // An overlay must supply this exact variant. Never fall back to native DF
    // responses, which would be incompatible with the profile's output EQ.
    return manifest.audition_profile.variants?.[state.variant] ?? null;
  }
  return manifest?.variants?.[state.variant] ?? null;
}

function acousticResponseRevision(variant) {
  const profile = state.manifest?.audition_profile;
  return profile != null ? variant?.response_revision ?? profile.response_revision ?? profile.id :
    variant?.response_revision ?? state.manifest?.response_revision;
}

function centerTrimConfig() {
  const trim = effectiveAcousticVariant()?.center_trim;
  if (!trim?.responses?.dual) return null;
  const min = Number(trim.min_db ?? 0), max = Number(trim.max_db ?? 5), step = Number(trim.step_db ?? .1);
  if (![min,max,step].every(Number.isFinite) || min !== 0 || max <= 0 || max > 5 || step <= 0) return null;
  if (!Array.isArray(trim.speakers) || trim.speakers.length !== 2 || trim.speakers[0] !== 1 || trim.speakers[1] !== 2) return null;
  return {...trim, min_db:min, max_db:max, step_db:step};
}

function centerTrimText(value) {
  return value > 0 ? `−${value.toFixed(1)} dB` : "0.0 dB";
}

function centerTrimDefault() {
  const trim = centerTrimConfig(), value = Number(trim?.default_db ?? 1.5);
  return clamp(Number.isFinite(value) ? value : 1.5, trim?.min_db ?? 0, trim?.max_db ?? 5);
}

function updateCenterTrimControls() {
  const trim = centerTrimConfig(), enabled = Boolean(trim) && state.mode === "dual";
  const slider = $("centerTrim");
  slider.min = String(trim?.min_db ?? 0); slider.max = String(trim?.max_db ?? 5); slider.step = String(trim?.step_db ?? .1);
  // Keep the user's setting across modes and variants, including legacy assets.
  slider.value = String(state.centerAttenuationDb); slider.disabled = !enabled;
  const text = centerTrimText(state.centerAttenuationDb);
  $("centerTrimValue").textContent = text;
  slider.setAttribute("aria-valuetext", state.centerAttenuationDb > 0 ? `${text}，S2 和 S3 共同衰减` : "0.0 dB，不衰减");
  $("centerTrimMinimum").textContent = centerTrimText(trim?.min_db ?? 0);
  $("centerTrimMaximum").textContent = centerTrimText(trim?.max_db ?? 5);
  $("centerTrimHint").textContent = !trim ? "当前方案暂不支持中心衰减" : state.mode !== "dual" ? "切换双座模式调整" : "S2 / S3 同时降低电平 · FIR 后生效";
  $("resetCenterTrim").disabled = !enabled || state.centerAttenuationDb === centerTrimDefault();
  $("centerTrimControl").classList.toggle("is-disabled", !enabled);
}

function setCenterAttenuation(value) {
  if (!state.ready) return;
  const trim = centerTrimConfig();
  if (!trim || state.mode !== "dual" || !Number.isFinite(value)) return;
  state.centerAttenuationDb = Number(clamp(value, trim.min_db, trim.max_db).toFixed(3));
  applyCenterTrim();
  updateCenterTrimControls();
}

function applyCenterTrim(smooth=true) {
  if (!state.ctx) return;
  const now = state.ctx.currentTime;
  // A single stereo gain acts on both FIR-filtered physical center speakers.
  // Include the audible, warming, and fading banks so fast switches stay in sync.
  for (const bank of state.liveBanks) {
    if (!bank.centerGain) continue;
    const param = bank.centerGain.gain;
    const delta = 10 ** (-state.centerAttenuationDb / 20) - 1;
    if (smooth && param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
    else { const current = param.value; param.cancelScheduledValues(now); param.setValueAtTime(current, now); }
    if (smooth) param.linearRampToValueAtTime(delta, now + .020);
    else param.setValueAtTime(delta, now);
  }
}

function versionedResponseURL(entry, revision) {
  const url = typeof entry === "string" ? entry : entry.file ?? entry.url;
  if (!url) throw new Error("声场响应路径无效");
  const versioned = new URL(url.replace(/^\/+/, ""), new URL("./", document.baseURI));
  if (revision != null) versioned.searchParams.set("v", String(revision));
  return versioned.href;
}

function responseURL() {
  const {ix,iy} = state.poses[state.head];
  const variant = effectiveAcousticVariant();
  if (!variant) throw new Error(`当前试听配置缺少 ${state.variant} 方案的声场响应`);
  const entry = variant?.responses?.[state.mode]?.[state.head]?.[`${ix},${iy}`];
  if (!entry) throw new Error(`缺少 ${state.mode} / ${state.head} / ${ix},${iy} 的声场响应`);
  return versionedResponseURL(entry, acousticResponseRevision(variant));
}

function centerResponseURL() {
  if (state.mode !== "dual") return null;
  const variant = effectiveAcousticVariant();
  if (!variant) throw new Error(`当前试听配置缺少 ${state.variant} 方案的中心扬声器响应`);
  const trim = centerTrimConfig();
  if (!trim) {
    const originalTrim = state.manifest?.variants?.[state.variant]?.center_trim;
    if (state.manifest?.audition_profile != null && originalTrim) throw new Error("当前试听配置缺少有效的中心扬声器响应");
    return null;
  }
  const {ix,iy} = state.poses[state.head];
  const entry = trim.responses.dual?.[state.head]?.[`${ix},${iy}`];
  if (!entry) throw new Error(`缺少 ${state.head} / ${ix},${iy} 的中心扬声器响应`);
  return versionedResponseURL(entry, trim.response_revision ?? acousticResponseRevision(variant));
}

function updateHeadphoneEQStatus() {
  const config = state.manifest?.headphone_eq;
  const configured = config?.enabled === true;
  const active = state.outputRouteReady && Boolean(state.headphoneEqNode);
  const status = $("headphoneEqStatus");
  const label = active ? state.headphoneEqLabel : config?.label ?? "耳机输出均衡";
  status.classList.toggle("is-active", active);
  status.classList.toggle("is-error", configured && state.headphoneEqState === "error");
  if (active) status.textContent = `耳机输出：${label} · 已启用`;
  else if (!configured) status.textContent = "耳机输出：未启用额外均衡";
  else if (state.headphoneEqState === "error") status.textContent = "耳机输出均衡加载失败 · 播放已暂停";
  else status.textContent = `耳机输出：${label} · ${state.headphoneEqState === "loading" ? "加载中" : "待播放时加载"}`;
}

async function ensureHeadphoneEQ() {
  const config = state.manifest?.headphone_eq;
  // Publishing enables this only after the compatible raw-HRIR responses exist.
  // Missing metadata preserves the previous output path; never infer an EQ.
  const enabled = config?.enabled === true;
  const profile = state.manifest?.audition_profile;
  const key = JSON.stringify([enabled, config?.url ?? null, config?.revision ?? null,
    profile?.id ?? null, profile?.response_revision ?? null]);
  if (state.outputRouteReady && state.headphoneEqKey === key) return;
  if (state.headphoneEqLoad?.key === key) return state.headphoneEqLoad.promise;
  const routeId = ++state.outputRouteId;
  // Disconnect first: an enabled but missing/invalid filter must not play dry.
  state.outputBus.disconnect();
  state.headphoneEqNode?.disconnect(); state.headphoneEqNode = null;
  state.outputRouteReady = false; state.headphoneEqKey = null;
  state.headphoneEqState = enabled ? "loading" : "idle";
  updateHeadphoneEQStatus();
  const pending = (async () => {
    let node = null;
    try {
      if (enabled) {
        if (!state.manifest?.audition_profile) throw new Error("耳机输出均衡缺少匹配的原始声场试听配置");
        if (typeof config.url !== "string" || !config.url.trim()) throw new Error("耳机输出均衡缺少滤波器路径");
        const url = versionedResponseURL(config.url, config.revision);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`耳机输出均衡加载失败 (${response.status})`);
        const [buffer] = await decodeImpulse(await response.arrayBuffer(), 1);
        const coefficients = buffer.getChannelData(0);
        if (!coefficients.every(Number.isFinite) || !coefficients.some(value => value !== 0)) throw new Error("耳机输出均衡系数无效");
        if (routeId !== state.outputRouteId) throw new Error("耳机输出配置已变化，请再次播放");
        node = state.ctx.createConvolver();
        node.normalize = false;
        node.channelCount = 2; node.channelCountMode = "clamped-max";
        // One mono IR filters stereo channels independently with identical EQ.
        // Any headroom gain is already encoded in the FIR; do not apply it twice.
        node.buffer = buffer;
        state.outputBus.connect(node); node.connect(state.master);
        state.headphoneEqNode = node;
        state.headphoneEqLabel = config.label ?? "耳机输出均衡";
      } else {
        state.outputBus.connect(state.master);
      }
      state.headphoneEqKey = key; state.outputRouteReady = true;
      state.headphoneEqState = enabled ? "active" : "off";
      updateHeadphoneEQStatus();
    } catch (error) {
      node?.disconnect();
      if (routeId === state.outputRouteId) {
        state.outputBus.disconnect(); state.headphoneEqNode = null;
        state.outputRouteReady = false; state.headphoneEqState = "error";
        audio.pause(); updateHeadphoneEQStatus();
      }
      throw error;
    }
  })();
  state.headphoneEqLoad = {key, promise:pending};
  try { await pending; }
  finally { if (state.headphoneEqLoad?.promise === pending) state.headphoneEqLoad = null; }
}

async function ensureAudio(resume=true) {
  if (!state.ctx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error("此浏览器不支持 Web Audio，请使用较新的 Edge 或 Chrome。");
    state.ctx = new AudioContext({sampleRate:Number(state.manifest.sample_rate ?? 48000), latencyHint:"interactive"});
    state.source = state.ctx.createMediaElementSource(audio);
    const stereo = state.ctx.createGain();
    stereo.channelCount = 2; stereo.channelCountMode = "explicit"; stereo.channelInterpretation = "speakers";
    state.splitter = state.ctx.createChannelSplitter(2);
    state.master = state.ctx.createGain();
    state.master.channelCount=2; state.master.channelCountMode="explicit";
    state.outputBus = state.ctx.createGain();
    state.outputBus.channelCount=2; state.outputBus.channelCountMode="explicit";
    state.source.connect(stereo); stereo.connect(state.splitter);
    state.master.connect(state.ctx.destination);
    applyVolume(false);
    $("engineStatus").textContent = `${(state.ctx.sampleRate/1000).toFixed(0)} kHz · 4 路双耳卷积 · 共用主音量`;
  }
  if (resume) await state.ctx.resume();
  await ensureHeadphoneEQ();
  if (!await requestResponse()) throw new Error(state.lastResponseError ?? "声场正在切换，请稍后再按播放。");
}

function decodeImpulse(bytes, expectedChannels=4) {
  // Read uncompressed BRIR (four-channel) or final EQ (mono) WAV directly.
  // Fallback decoding resamples when the output device requires it.
  const view = new DataView(bytes);
  const tag = (offset) => String.fromCharCode(...new Uint8Array(bytes,offset,4));
  let fmt=null, dataOffset=0, dataSize=0;
  if (view.byteLength < 44 || tag(0)!=="RIFF" || tag(8)!=="WAVE") throw new Error("声场响应不是有效 WAV");
  for (let offset=12; offset+8<=view.byteLength;) {
    const id=tag(offset), size=view.getUint32(offset+4,true), start=offset+8;
    if (start+size > view.byteLength) throw new Error("声场响应 WAV 不完整");
    if (id==="fmt ") {
      if (size<16) throw new Error("WAV 格式段无效");
      let format=view.getUint16(start,true);
      if (format===65534 && size>=40) format=view.getUint16(start+24,true);
      fmt={format,channels:view.getUint16(start+2,true),sampleRate:view.getUint32(start+4,true),block:view.getUint16(start+12,true),bits:view.getUint16(start+14,true)};
    }
    if (id==="data") { dataOffset=start; dataSize=size; }
    offset=start+size+(size%2);
  }
  if (!fmt || !dataOffset || fmt.channels!==expectedChannels) throw new Error(expectedChannels===1 ? "耳机输出均衡必须是单通道 WAV" : "声场响应应包含 4 个通道：L→左耳、L→右耳、R→左耳、R→右耳");
  if (fmt.sampleRate!==state.ctx.sampleRate) return state.ctx.decodeAudioData(bytes).then(decoded => {
    if (decoded.numberOfChannels!==expectedChannels) throw new Error(`浏览器未保留响应的 ${expectedChannels} 通道`);
    return Array.from({length:expectedChannels},(_,channel) => { const buffer=state.ctx.createBuffer(1,decoded.length,decoded.sampleRate);buffer.copyToChannel(decoded.getChannelData(channel),0);return buffer; });
  });
  if (!((fmt.format===3 && fmt.bits===32) || (fmt.format===1 && [16,24,32].includes(fmt.bits)))) throw new Error(`不支持的声场 WAV 格式 ${fmt.format}/${fmt.bits}`);
  const frames=Math.floor(dataSize/fmt.block), buffers=Array.from({length:expectedChannels},()=>state.ctx.createBuffer(1,frames,fmt.sampleRate));
  for(let channel=0;channel<expectedChannels;channel++){
    const output=buffers[channel].getChannelData(0);
    for(let frame=0;frame<frames;frame++){
      const offset=dataOffset+frame*fmt.block+channel*(fmt.bits/8);
      let value;
      if(fmt.format===3) value=view.getFloat32(offset,true);
      else if(fmt.bits===16) value=view.getInt16(offset,true)/32768;
      else if(fmt.bits===32) value=view.getInt32(offset,true)/2147483648;
      else {let n=view.getUint8(offset)|(view.getUint8(offset+1)<<8)|(view.getUint8(offset+2)<<16);if(n&0x800000)n-=0x1000000;value=n/8388608;}
      if(expectedChannels===1&&!Number.isFinite(value))throw new Error("耳机输出均衡包含无效系数");
      output[frame]=Number.isFinite(value)?value:0;
    }
  }
  return Promise.resolve(buffers);
}

async function impulseBuffers(url) {
  if (state.cache.has(url)) {const cached=state.cache.get(url);state.cache.delete(url);state.cache.set(url,cached);return cached;}
  const pending=fetch(url).then(response=>{if(!response.ok)throw new Error(`响应文件加载失败 (${response.status})`);return response.arrayBuffer();}).then(decodeImpulse);
  state.cache.set(url,pending);
  try {const buffers=await pending;while(state.cache.size>28)state.cache.delete(state.cache.keys().next().value);return buffers;}
  catch(error){state.cache.delete(url);throw error;}
}

function makeBank(buffers, centerBuffers, mode) {
  const gain=state.ctx.createGain(), merger=state.ctx.createChannelMerger(2), nodes=[];
  const modeGain=state.ctx.createGain();
  modeGain.channelCount=2;modeGain.channelCountMode="explicit";
  // A bank owns its fixed listening level throughout warming and crossfading.
  // Both ears share this gain; physical FIRs, BRIR data, and binaural balance stay intact.
  modeGain.gain.value=(mode==="solo_left"||mode==="solo_right")?10**(-1.5/20):1;
  const centerMerger=centerBuffers?state.ctx.createChannelMerger(2):null;
  const centerGain=centerBuffers?state.ctx.createGain():null;
  gain.gain.value=0;
  for(const [impulses,destination] of [[buffers,merger],[centerBuffers,centerMerger]]){
    if(!impulses)continue;
    for(let input=0;input<2;input++)for(let ear=0;ear<2;ear++){
      const convolver=state.ctx.createConvolver();
      // Crucial: browser normalization would invalidate level comparisons.
      convolver.normalize=false; convolver.buffer=impulses[input*2+ear];
      state.splitter.connect(convolver,input,0);convolver.connect(destination,0,ear);nodes.push(convolver);
    }
  }
  if(centerGain){
    centerGain.channelCount=2;centerGain.channelCountMode="explicit";
    centerGain.gain.value=10**(-state.centerAttenuationDb/20)-1;
    centerMerger.connect(centerGain);centerGain.connect(gain);
  }
  // full + (g - 1) * center preserves all other speakers and trims only S2/S3.
  merger.connect(gain);gain.connect(modeGain);modeGain.connect(state.outputBus);
  const bank={gain,modeGain,mode,merger,nodes,centerGain,centerMerger,disposed:false,dispose(){
    if(this.disposed)return;
    this.disposed=true;state.liveBanks.delete(this);
    for(const node of nodes){try{state.splitter.disconnect(node);}catch{}node.disconnect();}
    centerMerger?.disconnect();centerGain?.disconnect();merger.disconnect();gain.disconnect();modeGain.disconnect();
  }};
  state.liveBanks.add(bank);
  return bank;
}

async function requestResponse() {
  const requestId=++state.requestId;
  state.lastResponseError=null;
  if(state.pendingBank){state.pendingBank.dispose();state.pendingBank=null;}
  if (!state.manifest) return false;
  if (!state.ctx) { banner(readyText()); return true; }
  try {
    const mode=state.mode, url=responseURL(), centerUrl=centerResponseURL();
    const key=JSON.stringify([mode,url,centerUrl]);
    if(state.bank?.key===key){banner(readyText());return true;}
    banner("正在切换声场响应…", "loading");
    const [buffers,centerBuffers]=await Promise.all([impulseBuffers(url),centerUrl?impulseBuffers(centerUrl):Promise.resolve(null)]);
    if(requestId!==state.requestId)return false;
    const next=makeBank(buffers,centerBuffers,mode);
    state.pendingBank=next;
    // A new convolver has no input history. Let it receive a full impulse's
    // worth of live audio before mixing it in; otherwise delayed impulses
    // create a brief dropout even when the music source never stops.
    if(state.bank&&!audio.paused)await new Promise(resolve=>setTimeout(resolve,(Math.max(...[...buffers,...(centerBuffers??[])].map(buffer=>buffer.duration))+.025)*1000));
    if(requestId!==state.requestId)return false;
    state.pendingBank=null;
    const now=state.ctx.currentTime, fade=.075;
    next.url=url;next.key=key;next.gain.gain.setValueAtTime(0,now);next.gain.gain.linearRampToValueAtTime(1,now+fade);
    const previous=state.bank;state.bank=next;
    if(previous){const gain=previous.gain.gain;if(gain.cancelAndHoldAtTime)gain.cancelAndHoldAtTime(now);else{const current=gain.value;gain.cancelScheduledValues(now);gain.setValueAtTime(current,now);}gain.linearRampToValueAtTime(0,now+fade);setTimeout(()=>previous.dispose(),160);}
    $("engineStatus").textContent=`${(state.ctx.sampleRate/1000).toFixed(0)} kHz · ${centerBuffers?8:4} 路双耳卷积 · 共用主音量`;
    banner(readyText());return true;
  } catch(error) { if(requestId===state.requestId){state.lastResponseError=error.message;audio.pause();banner(error.message,"error");} return false; }
}

function applyVolume(smooth=true) {
  const configured=Number(state.manifest?.master_gain ?? .5);
  const globalGain=Number.isFinite(configured)&&configured>=0?configured:.5;
  const value=state.muted?0:state.volume*globalGain;
  if(state.master){const now=state.ctx.currentTime;state.master.gain.cancelScheduledValues(now);if(smooth)state.master.gain.setTargetAtTime(value,now,.015);else state.master.gain.setValueAtTime(value,now);}
  $("volumeText").textContent=state.muted?"静音":`${Math.round(state.volume*100)}%`;
  $("muteButton").textContent=state.muted?"×":"◖))";
  $("muteButton").setAttribute("aria-label",state.muted?"取消静音":"静音");
}

function updatePlaylist() {
  const select=$("trackSelect");select.replaceChildren();
  if(!state.tracks.length){const option=new Option("音乐库为空","");select.add(option);select.disabled=true;$("trackName").textContent="音乐库为空";$("trackOrigin").textContent="MUSIC FOLDER";$("trackMeta").textContent="添加或导入音乐后即可试听";}
  else {state.tracks.forEach((track,index)=>select.add(new Option(track.name,String(index))));select.disabled=false;select.value=String(state.trackIndex);}
  $("trackCount").textContent=`${state.tracks.length} 首`;
}

async function setTrack(index, autoplay=false) {
  if(!state.tracks.length)return;
  state.trackIndex=(index+state.tracks.length)%state.tracks.length;
  const track=state.tracks[state.trackIndex];
  audio.src=track.url;audio.load();
  $("trackName").textContent=track.name;
  $("trackOrigin").textContent=track.local?"BROWSER / 本地导入":"ONLINE / 页面曲目";
  $("trackMeta").textContent=track.filename??track.name;
  $("seek").value=0;$("elapsed").textContent="0:00";$("duration").textContent="0:00";
  $("trackSelect").value=String(state.trackIndex);
  if(autoplay)await play();
}

async function play() {
  if(!state.ready){banner("声场正在准备，完成后即可试听。","loading");return;}
  if(!state.manifest){banner("声场数据尚未准备好，请先生成仿真响应。","error");return;}
  if(!state.tracks.length){$("filePicker").click();return;}
  if(state.trackIndex<0)setTrack(0,false);
  try {
    const key=JSON.stringify([state.mode,responseURL(),centerResponseURL()]);
    if(state.ctx && state.outputRouteReady && state.bank?.key===key){
      // Both calls happen directly in the user's click/keyboard gesture.
      const resumed=state.ctx.resume(), started=audio.play();
      await Promise.all([resumed,started]);
      return;
    }
    await ensureAudio();
    if(!state.bank)throw new Error("声场响应未能加载，请刷新页面重试。");
    await audio.play();
  }catch(error){
    banner(error.name==="NotAllowedError" ? "声场已准备好，请再次点击播放。" : `无法播放：${error.message}`,"error");
  }
}
function togglePlay(){if(audio.paused)play();else audio.pause();}
function stepTrack(delta){setTrack(state.trackIndex+delta,!audio.paused);}

async function refreshMusic() {
  try {
    const data=await readSiteMusic();
    const current=state.tracks[state.trackIndex], wasPlaying=!audio.paused;
    state.tracks=[...(data.music??[]),...state.localTracks];
    state.trackIndex=current?state.tracks.findIndex(track=>track.url===current.url):-1;
    if(!state.tracks.length){audio.pause();audio.removeAttribute("src");audio.load();$("seek").value=0;$("elapsed").textContent="0:00";$("duration").textContent="0:00";}
    updatePlaylist();$("musicPath").textContent=data.music_dir??"music/";
    if(state.trackIndex<0&&state.tracks.length)await setTrack(0,wasPlaying);
    if(state.manifest)banner(readyText());
  }catch(error){banner(error.message,"error");}
}

function addFiles(files) {
  if(!state.ready)return;
  const supported=/\.(wav|mp3|flac|ogg|opus|m4a|aac|webm|mp4)$/i;
  const accepted=Array.from(files).filter(file=>file.type.startsWith("audio/")||supported.test(file.name));
  if(!accepted.length){banner("没有找到可播放的音频文件。","error");return;}
  const first=state.tracks.length;
  const tracks=accepted.map(file=>({id:`local-${file.name}-${file.size}-${file.lastModified}`,name:file.name.replace(/\.[^.]+$/,""),filename:file.webkitRelativePath||file.name,url:URL.createObjectURL(file),local:true}));
  state.localTracks.push(...tracks);state.tracks.push(...tracks);updatePlaylist();
  if(state.trackIndex<0)setTrack(first,false);
  if(state.manifest)banner(`已添加 ${tracks.length} 首音乐 · 按 Space 播放`);
}

function attachEvents() {
  document.querySelectorAll("[data-mode]").forEach(button=>button.addEventListener("click",()=>selectMode(button.dataset.mode)));
  document.querySelectorAll("[data-head]").forEach(button=>button.addEventListener("click",()=>selectHead(button.dataset.head)));
  document.querySelectorAll("[data-move]").forEach(button=>button.addEventListener("click",()=>moveHead(...button.dataset.move.split(",").map(Number))));
  $("resetPose").addEventListener("click",resetPose);
  $("centerTrim").addEventListener("input",event=>setCenterAttenuation(Number(event.target.value)));
  $("resetCenterTrim").addEventListener("click",()=>setCenterAttenuation(centerTrimDefault()));
  $("playPause").addEventListener("click",togglePlay);
  $("startListening").addEventListener("click",play);
  audio.addEventListener("playing",()=>{$("startListeningPanel").hidden=true;});
  $("previousTrack").addEventListener("click",()=>stepTrack(-1));$("nextTrack").addEventListener("click",()=>stepTrack(1));
  $("volume").addEventListener("input",event=>{state.volume=Number(event.target.value)/100;state.muted=false;applyVolume();});
  $("muteButton").addEventListener("click",()=>{state.muted=!state.muted;applyVolume();});
  $("seek").addEventListener("input",event=>{if(Number.isFinite(audio.duration))audio.currentTime=Number(event.target.value)/1000*audio.duration;});
  $("trackSelect").addEventListener("change",event=>setTrack(Number(event.target.value),!audio.paused));
  $("chooseFiles").addEventListener("click",()=>$("filePicker").click());$("chooseFolder").addEventListener("click",()=>$("folderPicker").click());
  for(const picker of ["filePicker","folderPicker"])$(picker).addEventListener("change",event=>{addFiles(event.target.files);event.target.value="";});
  $("refreshLibrary").addEventListener("click",refreshMusic);
  $("variantSelect").addEventListener("change",event=>{if(!state.ready)return;state.variant=event.target.value;updateVariantInfo();updateControls();requestResponse();});
  $("helpButton").addEventListener("click",()=>$("helpDialog").showModal());$("closeHelp").addEventListener("click",()=>$("helpDialog").close());
  document.addEventListener("dragover",event=>{event.preventDefault();$("dropZone").classList.add("dragging");});
  document.addEventListener("dragleave",event=>{if(!event.relatedTarget)$("dropZone").classList.remove("dragging");});
  document.addEventListener("drop",event=>{event.preventDefault();$("dropZone").classList.remove("dragging");addFiles(event.dataTransfer.files);});
  audio.addEventListener("play",()=>{$("playIcon").textContent="Ⅱ";$("playPause").setAttribute("aria-label","暂停");});
  audio.addEventListener("pause",()=>{$("playIcon").textContent="▶";$("playPause").setAttribute("aria-label","播放");});
  audio.addEventListener("timeupdate",()=>{$("elapsed").textContent=timeText(audio.currentTime);if(Number.isFinite(audio.duration)&&audio.duration>0)$("seek").value=String(audio.currentTime/audio.duration*1000);});
  audio.addEventListener("loadedmetadata",()=>$("duration").textContent=timeText(audio.duration));
  audio.addEventListener("ended",()=>setTrack(state.trackIndex+1,true));
  audio.addEventListener("error",()=>{if(audio.src)banner("音频无法解码或文件读取失败，请尝试 WAV、MP3 或 FLAC 文件。","error");});
  document.addEventListener("keydown",event=>{
    if(!state.ready)return;
    if(event.ctrlKey||event.altKey||event.metaKey||$("helpDialog").open)return;
    const target=event.target;
    if(target.isContentEditable||target.tagName==="TEXTAREA"||(target.tagName==="INPUT"&&!['range','file','button','submit','reset','checkbox','radio'].includes(target.type)))return;
    const key=event.key;
    if(key.toLowerCase()==="t"){event.preventDefault();selectHead(state.head==="left"?"right":"left");return;}
    if(key==="Tab"&&target.closest("button,input,select,a"))return;
    if(["INPUT","SELECT"].includes(target.tagName)||(key===" "&&target.closest("button,a")))return;
    if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Tab"," ","1","2","3","[","]","r","R"].includes(key))event.preventDefault();
    if(key==="ArrowUp")moveHead(0,1);else if(key==="ArrowDown")moveHead(0,-1);else if(key==="ArrowLeft")moveHead(-1,0);else if(key==="ArrowRight")moveHead(1,0);
    else if(key==="Tab")selectHead(state.head==="left"?"right":"left");
    else if(key==="1")selectMode("solo_left");else if(key==="2")selectMode("solo_right");else if(key==="3")selectMode("dual");
    else if(key===" "&&!event.repeat)togglePlay();else if(key==="[")stepTrack(-1);else if(key==="]")stepTrack(1);else if(key.toLowerCase()==="r")resetPose();
  });
  window.addEventListener("beforeunload",()=>{state.requestId++;state.outputRouteId++;for(const bank of state.liveBanks)bank.dispose();state.outputBus?.disconnect();state.headphoneEqNode?.disconnect();state.localTracks.forEach(track=>URL.revokeObjectURL(track.url));});
}

async function init() {
  attachEvents();updateControls();setSitePreparing(true);
  try {
    const response=await fetch(new URL("manifest.json", document.baseURI), {cache:"no-cache"}), manifest=await response.json();
    const library=await readSiteMusic(manifest).catch(error=>({music:[],music_dir:"music/",error:error.message}));
    state.tracks=library.music;updatePlaylist();$("musicPath").textContent=library.music_dir;
    if(state.tracks.length)await setTrack(0,false);
    if(!response.ok)throw new Error(manifest.error??"无法读取声场配置");
    if(!manifest.variants||!Object.keys(manifest.variants).length)throw new Error("声场配置中没有可播放的滤波方案");
    state.manifest=manifest;state.variant=manifest.default_variant??Object.keys(manifest.variants)[0];
    updateHeadphoneEQStatus();
    if(!manifest.variants[state.variant])state.variant=Object.keys(manifest.variants)[0];
    state.centerAttenuationDb=centerTrimDefault();
    const room=manifest.room??{};
    $("roomSize").textContent=`${Number(room.width_m??6).toFixed(2)} × ${Number(room.length_m??8.142857).toFixed(2)} × ${Number(room.height_m??4.285714).toFixed(2)} m`;
    const variants=Object.entries(manifest.variants);
    $("variantSelect").replaceChildren(...variants.map(([id,data])=>new Option(data.label??id,id)));
    $("variantSelect").value=state.variant;$("variantRow").hidden=variants.length<2;
    updateVariantInfo();
    updateControls();setSitePreparing(true);
    banner("正在准备初始声场…","loading");
    await ensureAudio(false);
    state.ready=true;setSitePreparing(false);updatePlaylist();updateControls();responseURL();
    if(library.error)banner(`${library.error} 也可导入本地音乐。`,"error");else banner(readyText());
  }catch(error){banner(error.message,"error");}
}

function siteMusicRepository(manifest) {
  const host=location.hostname.toLowerCase();
  const pages=host.match(/^([a-z0-9-]+)\.github\.io$/);
  if(pages){
    const path=new URL("./",document.baseURI).pathname.split("/").filter(Boolean);
    return `${pages[1]}/${path.length?decodeURIComponent(path[0]):pages[1]+".github.io"}`;
  }
  return manifest?.music_library?.repository??null;
}

async function readRepositoryMusic(repository, manifest) {
  const [owner,name]=repository.split("/");
  const branch=manifest?.music_library?.ref??"main";
  const prefix=(manifest?.music_library?.directory??"music").replace(/^\/+|\/+$/g,"")+"/";
  const endpoint=new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${encodeURIComponent(branch)}`);
  endpoint.searchParams.set("recursive","1");
  const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch(endpoint,{cache:"no-store",credentials:"omit",headers:{Accept:"application/vnd.github+json"},signal:controller.signal});
    if(!response.ok)throw new Error("暂时无法读取仓库音乐目录。");
    const data=await response.json();
    if(!Array.isArray(data.tree)||data.truncated)throw new Error("仓库音乐目录未能完整读取。");
    const base=new URL("./",document.baseURI);
    const music=data.tree.filter(item=>item.type==="blob"&&item.path.startsWith(prefix)&&/\.(wav|mp3|flac|ogg|opus|m4a|aac|webm|mp4)$/i.test(item.path))
      .sort((left,right)=>left.path.toLowerCase().localeCompare(right.path.toLowerCase(),"en"))
      .map(item=>{
        const filename=item.path.slice(prefix.length), url=new URL(item.path.split("/").map(encodeURIComponent).join("/"),base);
        url.searchParams.set("v",item.sha);
        return {id:filename,name:filename.split("/").pop().replace(/\.[^.]+$/,""),filename,url:url.href};
      });
    return {music_dir:prefix,music};
  }finally{clearTimeout(timeout);}
}

async function readSiteMusic(manifest=state.manifest) {
  const repository=siteMusicRepository(manifest);
  if(!repository)throw new Error("尚未配置音乐仓库。");
  return readRepositoryMusic(repository,manifest);
}

// Keep the published page interactive only after the initial silent graph is ready.
function setSitePreparing(preparing) {
  document.querySelectorAll('[data-mode],[data-head],[data-move],#variantSelect,#centerTrim,#resetCenterTrim,#resetPose,#playPause,#startListening,#previousTrack,#nextTrack,#trackSelect,#chooseFiles,#chooseFolder,#refreshLibrary,#filePicker,#folderPicker').forEach(control => { control.disabled = preparing; });
  $("startListening").textContent = preparing ? "正在准备试听…" : "点击开始试听";
}

init();
