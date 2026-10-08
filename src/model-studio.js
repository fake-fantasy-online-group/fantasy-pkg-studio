(() => {
  const api = window.modelStudio;
  if (!api) return;

  const $ = (id) => document.getElementById(id);
  const elements = {
    projectTitle: $("projectTitle"), blenderStatus: $("blenderStatus"), sourceCount: $("sourceCount"),
    sourceList: $("sourceList"), projectPath: $("projectPath"), selectedName: $("selectedName"),
    sourceFormat: $("sourceFormat"), previewButton: $("previewButton"), renderButton: $("renderButton"), previewStage: $("previewStage"),
    artifactState: $("artifactState"), directionSelect: $("directionSelect"), frameRange: $("frameRange"),
    previousFrame: $("previousFrame"), nextFrame: $("nextFrame"), frameLabel: $("frameLabel"),
    previewMessage: $("previewMessage"), targetSelect: $("targetSelect"), roleSelect: $("roleSelect"),
    scaleSelect: $("scaleSelect"), targetSummary: $("targetSummary"), animationSelect: $("animationSelect"),
    startFrame: $("startFrame"), endFrame: $("endFrame"), width: $("width"), height: $("height"),
    directions: $("directions"), framesPerDirection: $("framesPerDirection"), modelScale: $("modelScale"),
    rotationX: $("rotationX"), rotationY: $("rotationY"), rotationZ: $("rotationZ"), azimuth: $("azimuth"),
    elevation: $("elevation"), offsetX: $("offsetX"), offsetY: $("offsetY"), orthoHeight: $("orthoHeight"),
    lightEnergy: $("lightEnergy"), statusLed: $("statusLed"),
    statusText: $("statusText"), progressTrack: $("progressTrack"), cancelButton: $("cancelButton"),
  };

  const fallbackSettings = {
    width: 256, height: 256, scale: 1, directions: 5, framesPerDirection: 8,
    startFrame: 1, endFrame: 24, animation: "", azimuth: 0, elevation: 30,
    rotationX: 0, rotationY: 0, rotationZ: 0, modelScale: 1,
    offsetX: 0, offsetY: 0, orthoHeight: 0, lightEnergy: 1000,
  };
  const settingIds = [
    "startFrame", "endFrame", "width", "height", "directions", "framesPerDirection",
    "modelScale", "rotationX", "rotationY", "rotationZ", "azimuth", "elevation",
    "offsetX", "offsetY", "orthoHeight", "lightEnergy",
  ];
  const numericSettings = new Set(settingIds);
  const state = {
    status: null,
    defaults: { ...fallbackSettings },
    targetEntries: [],
    rows: [],
    selectedId: null,
    busy: false,
    initializing: true,
    queuedCommands: [],
    projectPath: "",
    updatingControls: false,
    descriptorToken: 0,
    displayToken: 0,
  };

  function selectedRow() { return state.rows.find((row) => row.id === state.selectedId) || null; }
  function targetFor(id) { return state.targetEntries.find((entry) => entry.id === id) || null; }
  function setStatus(message, kind = "ready") {
    elements.statusText.textContent = message || "就绪";
    elements.statusText.title = message || "就绪";
    elements.statusLed.className = `status-led${kind === "busy" ? " busy" : kind === "error" ? " error" : ""}`;
  }
  function setPreviewMessage(message, kind = "") {
    elements.previewMessage.textContent = message || "";
    elements.previewMessage.className = `preview-message${kind ? ` ${kind}` : ""}`;
  }
  function artifactCall(method, ...args) {
    try {
      const result = api[method]?.(...args);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) { /* Artifact cleanup is best effort after local state is invalidated. */ }
  }
  function invalidateRow(row) {
    if (!row) return;
    if (row.artifact?.id) artifactCall("discard", row.artifact.id);
    if (row.previewArtifact?.id) artifactCall("discard", row.previewArtifact.id);
    row.artifact = null;
    row.previewArtifact = null;
    row.renderError = "";
    row.exportStatus = "";
    row.applyStatus = "";
    row.status = row.inspection ? "已检查" : "待转换";
    row.previewFrame = null;
    if (row.id === state.selectedId) renderSelected();
  }
  function extension(name) {
    const dot = String(name || "").lastIndexOf(".");
    return dot >= 0 ? String(name).slice(dot + 1).toUpperCase() : "3D";
  }
  function renderQueue() {
    elements.sourceCount.textContent = String(state.rows.length);
    elements.sourceList.replaceChildren();
    if (!state.rows.length) {
      const empty = document.createElement("div");
      empty.className = "empty-list";
      empty.textContent = "通过“3D → 添加模型…”导入";
      elements.sourceList.append(empty);
      renderSelected();
      return;
    }
    for (const row of state.rows) {
      const button = document.createElement("div");
      button.className = `source-row${row.id === state.selectedId ? " active" : ""}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", row.id === state.selectedId ? "true" : "false");
      button.tabIndex = row.id === state.selectedId ? 0 : -1;
      button.title = [row.name, row.renderError, row.exportStatus, row.applyStatus].filter(Boolean).join("\n");
      const icon = document.createElement("span");
      icon.className = "source-icon";
      icon.textContent = extension(row.name).slice(0, 3);
      const label = document.createElement("span");
      label.className = "source-label";
      label.textContent = row.name;
      const stateDot = document.createElement("span");
      const rowHasError = !!row.renderError || (!!row.exportStatus && !row.exportStatus.startsWith("已导出")) || (!!row.applyStatus && !row.applyStatus.startsWith("已应用"));
      stateDot.className = `source-state${rowHasError ? " error" : row.status === "已转换" ? " ready" : state.busy && row.busy ? " busy" : ""}`;
      button.append(icon, label, stateDot);
      button.addEventListener("click", () => selectRow(row.id));
      elements.sourceList.append(button);
    }
    renderSelected();
  }
  function addTargetOptions() {
    const current = elements.targetSelect.value;
    const keep = document.createElement("option");
    keep.value = "";
    keep.textContent = "仅导出到目录";
    elements.targetSelect.replaceChildren(keep);
    for (const entry of state.targetEntries) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.name;
      elements.targetSelect.append(option);
    }
    if (targetFor(current)) elements.targetSelect.value = current;
  }
  function applyStatus(status, initial = false) {
    const previousPath = state.projectPath;
    state.status = status || {};
    state.defaults = { ...fallbackSettings, ...(status?.defaults || {}) };
    state.targetEntries = Array.isArray(status?.entries) ? status.entries.filter((entry) => entry && typeof entry.id === "string") : [];
    state.projectPath = typeof status?.projectPath === "string" ? status.projectPath : "";
    const pathChanged = !initial && previousPath !== state.projectPath;
    let targetRemoved = false;
    if (pathChanged) {
      for (const row of state.rows) {
        invalidateRow(row);
        row.targetId = null;
        row.descriptor = null;
        row.status = "工程已切换";
      }
      setStatus("工程已切换，请重新指定目标条目");
    } else {
      for (const row of state.rows) {
        if (row.targetId && !targetFor(row.targetId)) {
          invalidateRow(row);
          row.targetId = null;
          row.descriptor = null;
          row.status = "目标条目已移除";
          targetRemoved = true;
        }
      }
    }
    elements.projectTitle.textContent = state.projectPath ? state.projectPath.split(/[\\/]/).filter(Boolean).pop() || "3D 模型转换" : "3D 模型转换";
    elements.projectPath.textContent = state.projectPath || "未打开 PKG 工程";
    elements.projectPath.title = state.projectPath;
    const blender = status?.blender;
    if (blender && typeof blender === "object") {
      elements.blenderStatus.textContent = blender.available === false ? "Blender 不可用" : blender.path || blender.version || "Blender 已就绪";
    } else {
      elements.blenderStatus.textContent = blender ? String(blender) : "Blender 未配置";
    }
    addTargetOptions();
    if (initial) {
      for (const [key, value] of Object.entries(state.defaults)) {
        if (key === "scale") continue;
        if (numericSettings.has(key) && $(key)) $(key).value = value;
      }
    }
    renderQueue();
    if ((pathChanged || targetRemoved) && selectedRow()) populateControls(selectedRow());
  }
  async function refreshStatus() {
    const result = await api.status();
    applyStatus(result);
    return result;
  }
  function ensureScaleOption(value) {
    const text = String(value);
    if (![...elements.scaleSelect.options].some((option) => option.value === text)) {
      const option = document.createElement("option");
      option.value = text;
      option.textContent = `${text}×`;
      elements.scaleSelect.append(option);
    }
  }
  function selectRow(id) {
    const next = state.rows.find((row) => row.id === id);
    if (!next || state.selectedId === id) return;
    state.selectedId = id;
    renderQueue();
    populateControls(next);
  }
  function populateControls(row) {
    state.updatingControls = true;
    elements.selectedName.textContent = row?.name || "未选择模型";
    elements.selectedName.title = row?.name || "";
    elements.sourceFormat.textContent = row ? extension(row.name) : "";
    if (row) {
      for (const key of settingIds) {
        const element = $(key);
        if (element) element.value = row.settings[key] ?? state.defaults[key] ?? "";
      }
      ensureScaleOption(row.settings.scale || 1);
      elements.scaleSelect.value = String(row.settings.scale || 1);
      elements.targetSelect.value = row.targetId || "";
      elements.roleSelect.value = row.role || "body";
      rebuildAnimations(row);
    } else {
      elements.targetSelect.value = "";
    }
    state.updatingControls = false;
    updateControlAvailability(row);
    updateFrameControls(row);
    renderSelected();
    if (row) refreshDescriptor(row).catch((error) => setPreviewMessage(error.message, "error"));
  }
  function rebuildAnimations(row) {
    const current = row.settings.animation || "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "默认时间线";
    elements.animationSelect.replaceChildren(defaultOption);
    const animations = row.inspection?.animations || [];
    for (const animation of animations) {
      const option = document.createElement("option");
      option.value = animation.name;
      option.textContent = animation.name;
      elements.animationSelect.append(option);
    }
    elements.animationSelect.value = [...elements.animationSelect.options].some((option) => option.value === current) ? current : "";
  }
  function updateControlAvailability(row) {
    const hasRow = !!row;
    for (const id of ["previewButton", "renderButton"]) $(id).disabled = state.busy || !hasRow;
    elements.targetSelect.disabled = state.busy || !hasRow;
    elements.roleSelect.disabled = state.busy || !hasRow;
    elements.scaleSelect.disabled = state.busy || !hasRow;
    elements.animationSelect.disabled = state.busy || !hasRow;
    const mapped = !!row?.targetId && !!row?.descriptor;
    for (const id of ["width", "height", "directions", "framesPerDirection"]) $(id).disabled = state.busy || !hasRow || mapped;
    for (const id of settingIds) {
      if (!["width", "height", "directions", "framesPerDirection"].includes(id)) $(id).disabled = state.busy || !hasRow;
    }
    elements.cancelButton.classList.toggle("hidden", !state.busy);
    elements.progressTrack.classList.toggle("hidden", !state.busy);
  }
  function formSettings(row) {
    const settings = { ...row.settings };
    for (const id of settingIds) {
      const element = $(id);
      if (!element || element.value === "") continue;
      const value = Number(element.value);
      if (Number.isFinite(value)) settings[id] = id === "modelScale" || id === "azimuth" || id === "elevation" || id.startsWith("rotation") || id.startsWith("offset") || id === "orthoHeight" || id === "lightEnergy" ? value : Math.trunc(value);
    }
    settings.animation = elements.animationSelect.value;
    settings.scale = Number(elements.scaleSelect.value) || 1;
    return settings;
  }
  function saveControls({ invalidate = true } = {}) {
    if (state.updatingControls) return;
    const row = selectedRow();
    if (!row) return;
    const before = JSON.stringify(row.settings);
    const previousScale = Number(row.settings.scale) || 1;
    row.settings = formSettings(row);
    const targetId = elements.targetSelect.value || null;
    const role = elements.roleSelect.value;
    const mappingChanged = row.targetId !== targetId || row.role !== role;
    row.targetId = targetId;
    row.role = role;
    if (mappingChanged) row.descriptor = null;
    if (invalidate && (before !== JSON.stringify(row.settings) || mappingChanged)) invalidateRow(row);
    updateControlAvailability(row);
    if (mappingChanged || previousScale !== (Number(row.settings.scale) || 1)) refreshDescriptor(row).catch((error) => setPreviewMessage(error.message, "error"));
    renderQueue();
  }
  async function refreshDescriptor(row) {
    const token = ++state.descriptorToken;
    if (!row.targetId) {
      row.descriptor = null;
      row.settings.width = Number(row.settings.width) || state.defaults.width;
      row.settings.height = Number(row.settings.height) || state.defaults.height;
      if (row.id === state.selectedId) {
        showTargetSummary(row);
        updateControlAvailability(row);
      }
      return null;
    }
    const targetId = row.targetId;
    const scale = Number(row.settings.scale) || 1;
    const role = row.role || "body";
    const descriptor = await api.describeTarget(targetId, scale, role);
    if (row.targetId !== targetId || (Number(row.settings.scale) || 1) !== scale || (row.role || "body") !== role) return descriptor;
    row.descriptor = descriptor;
    if (Number.isFinite(descriptor.logicalWidth)) row.settings.width = descriptor.logicalWidth;
    if (Number.isFinite(descriptor.logicalHeight)) row.settings.height = descriptor.logicalHeight;
    if (Number.isFinite(descriptor.directions)) row.settings.directions = descriptor.directions;
    if (Number.isFinite(descriptor.framesPerDirection)) row.settings.framesPerDirection = descriptor.framesPerDirection;
    if (Number.isFinite(descriptor.scale)) row.settings.scale = descriptor.scale;
    if (row.id === state.selectedId && token === state.descriptorToken) {
      state.updatingControls = true;
      for (const key of ["width", "height", "directions", "framesPerDirection"]) $(key).value = row.settings[key];
      ensureScaleOption(row.settings.scale);
      elements.scaleSelect.value = String(row.settings.scale);
      state.updatingControls = false;
      showTargetSummary(row);
      updateControlAvailability(row);
      updateFrameControls(row);
    }
    return descriptor;
  }
  function showTargetSummary(row) {
    const target = row?.targetId ? targetFor(row.targetId) : null;
    if (!target) {
      elements.targetSummary.className = "target-summary";
      elements.targetSummary.textContent = row?.targetId ? "目标条目不可用。请重新选择或刷新工程。" : "未选择工程条目。转换结果可另存为目录。";
      return;
    }
    const descriptor = row.descriptor;
    if (!descriptor) {
      elements.targetSummary.className = "target-summary";
      elements.targetSummary.textContent = "正在读取条目尺寸…";
      return;
    }
    const physical = descriptor.frames?.find((frame) => !frame.empty) || descriptor.frames?.[0];
    const logical = `${descriptor.logicalWidth ?? row.settings.width} × ${descriptor.logicalHeight ?? row.settings.height}`;
    const actual = physical ? `${physical.width} × ${physical.height} px` : `${logical} px`;
    const pivot = physical ? ` · 锚点 ${Math.round(physical.pivotX)}, ${Math.round(physical.pivotY)}` : "";
    elements.targetSummary.className = "target-summary attached";
    elements.targetSummary.textContent = `${target.name} · ${logical} · ${actual}${pivot} · ${descriptor.directions} 方向 × ${descriptor.framesPerDirection} 帧`;
  }
  function currentFrameIndex(row) {
    const directions = Math.max(1, Number(row?.settings.directions) || 1);
    const frames = Math.max(1, Number(row?.settings.framesPerDirection) || 1);
    const direction = Math.min(directions - 1, Math.max(0, Number(elements.directionSelect.value) || 0));
    const local = Math.min(frames - 1, Math.max(0, Number(elements.frameRange.value) || 0));
    return direction * frames + local;
  }
  function updateFrameControls(row) {
    const directions = Math.max(1, Number(row?.artifact?.directions || row?.previewArtifact?.directions || row?.settings.directions) || 1);
    const frames = Math.max(1, Number(row?.artifact?.framesPerDirection || row?.previewArtifact?.framesPerDirection || row?.settings.framesPerDirection) || 1);
    const oldDirection = Math.min(directions - 1, Math.max(0, Number(row?.previewDirection ?? elements.directionSelect.value) || 0));
    const oldFrame = Math.min(frames - 1, Math.max(0, Number(row?.previewLocalFrame ?? elements.frameRange.value) || 0));
    elements.directionSelect.replaceChildren();
    for (let i = 0; i < directions; i += 1) {
      const option = document.createElement("option");
      option.value = String(i);
      option.textContent = `${i + 1} / ${directions}`;
      elements.directionSelect.append(option);
    }
    elements.directionSelect.value = String(oldDirection);
    elements.frameRange.max = String(frames - 1);
    elements.frameRange.value = String(oldFrame);
    if (row) {
      row.previewDirection = oldDirection;
      row.previewLocalFrame = oldFrame;
    }
    elements.directionSelect.disabled = state.busy || !row || (directions === 1 && frames === 1);
    elements.frameRange.disabled = state.busy || !row || frames === 1;
    elements.previousFrame.disabled = state.busy || !row || frames === 1;
    elements.nextFrame.disabled = state.busy || !row || frames === 1;
    elements.frameLabel.textContent = row ? `${oldFrame + 1} / ${frames}` : "—";
  }
  async function showFrame(row, index, artifact = row?.artifact || row?.previewArtifact) {
    const token = ++state.displayToken;
    if (!artifact || (artifact.previewOnly ? artifact.previewIndex !== index : index < 0 || index >= Number(artifact.frames))) {
      elements.previewStage.replaceChildren(Object.assign(document.createElement("div"), { className: "preview-empty", textContent: "选择模型并生成预览" }));
      return;
    }
    try {
      const frame = await api.frame(artifact.id, index);
      if (token !== state.displayToken || row?.id !== state.selectedId) return;
      if (frame.empty) {
        const empty = document.createElement("div");
        empty.className = "empty-frame";
        empty.textContent = "空白帧";
        elements.previewStage.replaceChildren(empty);
      } else {
        const image = document.createElement("img");
        image.className = "preview-image";
        const base64 = String(frame.base64 || "").replace(/^data:image\/png;base64,/, "");
        image.src = `data:image/png;base64,${base64}`;
        image.alt = `方向 ${Math.floor(index / Math.max(1, artifact.framesPerDirection)) + 1}，帧 ${index % Math.max(1, artifact.framesPerDirection) + 1}`;
        image.width = frame.width;
        image.height = frame.height;
        elements.previewStage.replaceChildren(image);
      }
      elements.frameLabel.textContent = `${index % Math.max(1, artifact.framesPerDirection) + 1} / ${artifact.framesPerDirection}`;
      elements.artifactState.textContent = artifact.previewOnly ? "临时预览" : `已转换 · ${artifact.frames || 0} 帧`;
    } catch (error) {
      if (token !== state.displayToken) return;
      elements.previewStage.replaceChildren(Object.assign(document.createElement("div"), { className: "preview-empty", textContent: error.message || "无法读取预览帧" }));
    }
  }
  function renderSelected() {
    const row = selectedRow();
    const artifact = row?.artifact || row?.previewArtifact || null;
    elements.artifactState.textContent = row?.renderError ? "转换失败" : artifact ? (artifact.previewOnly ? "临时预览" : `已转换 · ${artifact.frames || 0} 帧`) : row?.inspection ? "已检查" : "尚未转换";
    const artifactWarnings = artifact?.warnings || [];
    const reports = [row?.renderError, row?.exportStatus, row?.applyStatus, ...artifactWarnings].filter(Boolean);
    const hasError = !!row?.renderError || (!!row?.applyStatus && !row.applyStatus.startsWith("已应用")) || (!!row?.exportStatus && !row.exportStatus.startsWith("已导出"));
    setPreviewMessage(reports.join("\n"), hasError ? "error" : artifactWarnings.length ? "warning" : "");
    updateFrameControls(row);
    if (!row || !artifact) {
      state.displayToken += 1;
      elements.previewStage.replaceChildren(Object.assign(document.createElement("div"), { className: "preview-empty", textContent: row ? "调整参数后生成预览" : "选择模型并生成预览" }));
      return;
    }
    const index = currentFrameIndex(row);
    if (artifact.previewOnly && artifact.previewIndex !== index) {
      state.displayToken += 1;
      elements.previewStage.replaceChildren(Object.assign(document.createElement("div"), { className: "preview-empty", textContent: "此帧尚未预览，点击“预览当前帧”生成" }));
      return;
    }
    showFrame(row, index, row.artifact || row.previewArtifact);
  }
  function enterBusy(label) {
    state.busy = true;
    for (const row of state.rows) row.busy = false;
    const row = selectedRow();
    if (row) row.busy = true;
    elements.cancelButton.classList.remove("hidden");
    elements.progressTrack.classList.remove("hidden");
    setStatus(label, "busy");
    updateControlAvailability(row);
    renderQueue();
  }
  function leaveBusy(message = "就绪", kind = "ready") {
    state.busy = false;
    for (const row of state.rows) row.busy = false;
    elements.cancelButton.classList.add("hidden");
    elements.progressTrack.classList.add("hidden");
    setStatus(message, kind);
    updateControlAvailability(selectedRow());
    renderQueue();
  }
  async function withBusy(label, operation) {
    if (state.busy) return;
    enterBusy(label);
    try { return await operation(); }
    catch (error) { setStatus(error?.message || String(error), "error"); throw error; }
    finally { leaveBusy(elements.statusText.textContent, elements.statusLed.classList.contains("error") ? "error" : "ready"); }
  }
  async function inspectRow(row = selectedRow()) {
    if (!row || state.busy) return;
    await withBusy(`正在检查 ${row.name}`, async () => {
      await refreshStatus();
      if (row.artifact || row.previewArtifact) invalidateRow(row);
      const result = await api.inspect(row.id);
      const previousStart = row.settings.startFrame;
      const previousEnd = row.settings.endFrame;
      row.inspection = result;
      row.status = "已检查";
      row.renderError = "";
      if (Number.isFinite(result.frameStart)) row.settings.startFrame = Number(result.frameStart);
      if (Number.isFinite(result.frameEnd)) row.settings.endFrame = Number(result.frameEnd);
      if (previousStart !== row.settings.startFrame || previousEnd !== row.settings.endFrame || row.artifact || row.previewArtifact) invalidateRow(row);
      if (row.id === state.selectedId) {
        populateControls(row);
        const warnings = result.warnings?.join(" · ");
        setPreviewMessage(warnings || `${result.objects?.length || 0} 个对象 · ${(result.animations || []).length} 个动作`, warnings ? "warning" : "");
      }
      setStatus(`${row.name}：${(result.animations || []).length} 个动作`);
    });
  }
  function makeJob(row, previewIndex) {
    const settings = { ...row.settings };
    if (row.descriptor) {
      settings.width = row.descriptor.logicalWidth ?? settings.width;
      settings.height = row.descriptor.logicalHeight ?? settings.height;
      settings.directions = row.descriptor.directions ?? settings.directions;
      settings.framesPerDirection = row.descriptor.framesPerDirection ?? settings.framesPerDirection;
    }
    const job = { sourceId: row.id, targetId: row.targetId || null, role: row.role || "body", settings };
    if (row.targetId) job.projectPath = state.projectPath;
    if (Number.isInteger(previewIndex)) job.previewIndex = previewIndex;
    return job;
  }
  async function ensureCurrentTarget(row) {
    if (row.targetId && !targetFor(row.targetId)) throw new Error("目标条目已不存在，请重新选择");
    if (row.targetId) await refreshDescriptor(row);
  }
  async function renderRows(rows, preview = false) {
    if (!rows.length || state.busy) return;
    saveControls();
    const onlyPreview = preview === true;
    await withBusy(onlyPreview ? "正在生成预览帧…" : `正在转换 ${rows.length} 个模型…`, async () => {
      await refreshStatus();
      for (const row of rows) {
        try { await ensureCurrentTarget(row); }
        catch (_) { /* The worker reports each invalid target without blocking the remaining batch. */ }
      }
      const previewIndex = onlyPreview ? currentFrameIndex(rows[0]) : undefined;
      const jobs = rows.map((row) => makeJob(row, Number.isInteger(previewIndex) ? previewIndex : undefined));
      // A new render is the authoritative result for the current source and settings.
      // Remove prior outputs before dispatch so a failed rerender cannot be applied/exported.
      for (const row of rows) invalidateRow(row);
      const response = await api.render(jobs);
      const results = Array.isArray(response?.results) ? response.results : [];
      for (const row of rows) {
        const result = results.find((item) => item.sourceId === row.id);
        if (!result) {
          if (response?.canceled) {
            row.renderError = "";
            row.status = "已取消";
          } else {
            row.renderError = "转换器没有返回该模型的结果";
            row.status = "转换失败";
          }
          continue;
        }
        if (!result.ok) {
          row.renderError = result.error || "转换失败";
          row.status = "转换失败";
          continue;
        }
        if (result.artifact) {
          if (result.artifact.previewOnly) {
            if (row.previewArtifact?.id) artifactCall("discard", row.previewArtifact.id);
            row.previewArtifact = result.artifact;
          } else {
            if (row.artifact?.id && row.artifact.id !== result.artifact.id) artifactCall("discard", row.artifact.id);
            row.artifact = result.artifact;
            if (row.previewArtifact?.id) artifactCall("discard", row.previewArtifact.id);
            row.previewArtifact = null;
            row.status = "已转换";
          }
          row.renderError = "";
          const firstFrame = result.artifact.previewIndex;
          if (Number.isInteger(firstFrame)) {
            state.updatingControls = true;
            elements.directionSelect.value = String(Math.floor(firstFrame / Math.max(1, row.settings.framesPerDirection)));
            elements.frameRange.value = String(firstFrame % Math.max(1, row.settings.framesPerDirection));
            row.previewDirection = Number(elements.directionSelect.value);
            row.previewLocalFrame = Number(elements.frameRange.value);
            state.updatingControls = false;
            row.previewFrame = firstFrame;
          }
        }
      }
      const failures = rows.filter((row) => row.renderError);
      if (selectedRow()) renderSelected();
      renderQueue();
      if (response?.canceled) setStatus("已取消；已返回的结果仍可使用");
      else if (failures.length) setStatus(`${failures.length} 个模型转换失败`, "error");
      else setStatus(onlyPreview ? "预览已更新" : `${rows.length} 个模型转换完成`);
    });
  }
  async function previewSelected() {
    const row = selectedRow();
    if (!row || state.busy) return;
    saveControls();
    if (row.artifact && !row.artifact.previewOnly) {
      renderSelected();
      return;
    }
    await renderRows([row], true);
  }
  function readyRows(rows, includePreview = false) {
    return rows.filter((row) => row.artifact && (includePreview || !row.artifact.previewOnly));
  }
  async function exportRows(rows) {
    if (state.busy) return;
    await withBusy("正在导出转换结果…", async () => {
      await refreshStatus();
      const ready = readyRows(rows);
      if (!ready.length) {
        setStatus("没有可导出的完整转换结果");
        return;
      }
      const response = await api.export(ready.map((row) => row.artifact.id));
      if (response?.canceled) {
        setStatus("已取消导出");
        return;
      }
      const results = response?.results || [];
      for (const row of ready) {
        const result = results.find((item) => item.id === row.artifact.id);
        row.exportStatus = result?.ok ? `已导出：${result.directory}` : result?.error || "导出失败";
      }
      const failed = results.filter((item) => !item.ok).length;
      setStatus(failed ? `${failed} 项导出失败` : `${results.length} 项已导出`, failed ? "error" : "ready");
      if (selectedRow()) renderSelected();
      renderQueue();
    });
  }
  async function applyRows(rows) {
    if (state.busy) return;
    await withBusy("正在应用到工程…", async () => {
      await refreshStatus();
      const ready = readyRows(rows).filter((row) => row.targetId && row.artifact.targetId === row.targetId && targetFor(row.targetId));
      if (!ready.length) {
        setStatus("没有可应用的完整结果和有效工程目标");
        return;
      }
      const seen = new Set();
      for (const row of ready) {
        if (seen.has(row.targetId)) {
          setStatus(`多个转换结果指定了同一工程条目：${targetFor(row.targetId)?.name || row.targetId}`, "error");
          return;
        }
        seen.add(row.targetId);
      }
      for (const row of ready) await ensureCurrentTarget(row);
      const response = await api.apply(ready.map((row) => row.artifact.id));
      const results = response?.results || [];
      for (const row of ready) {
        const result = results.find((item) => item.id === row.artifact.id);
        row.applyStatus = result?.ok ? `已应用：${result.targetName || targetFor(row.targetId)?.name || "工程条目"}` : result?.error || "应用失败";
      }
      const failed = results.filter((item) => !item.ok).length;
      setStatus(failed ? `${failed} 项应用失败` : `${results.length} 项已应用`, failed ? "error" : "ready");
      if (selectedRow()) renderSelected();
      renderQueue();
    });
  }
  async function copySettings() {
    const row = selectedRow();
    if (!row || state.busy) return;
    row.settings = formSettings(row);
    const settings = { ...row.settings };
    for (const other of state.rows) {
      if (other.id === row.id) continue;
      const locked = !!other.targetId && !!other.descriptor;
      const next = { ...other.settings, ...settings };
      if (locked) {
        next.width = other.descriptor.logicalWidth ?? next.width;
        next.height = other.descriptor.logicalHeight ?? next.height;
        next.directions = other.descriptor.directions ?? next.directions;
        next.framesPerDirection = other.descriptor.framesPerDirection ?? next.framesPerDirection;
      }
      other.settings = next;
      invalidateRow(other);
      if (other.targetId) refreshDescriptor(other).catch(() => {});
    }
    setStatus("参数已复制到队列，目标映射已保留");
  }
  async function removeSelected() {
    if (state.busy) return;
    const row = selectedRow();
    if (!row) return;
    await withBusy(`正在移除 ${row.name}`, async () => {
      await api.remove(row.id);
      row.artifact = null;
      row.previewArtifact = null;
      state.rows = state.rows.filter((item) => item.id !== row.id);
      state.selectedId = state.rows[0]?.id || null;
      renderQueue();
      if (selectedRow()) populateControls(selectedRow());
      setStatus(`${row.name} 已移除`);
    });
  }
  async function addSources() {
    if (state.busy) return;
    await withBusy("选择要转换的 3D 模型…", async () => {
      await refreshStatus();
      const response = await api.addSources();
      if (response?.canceled) {
        setStatus("就绪");
        return;
      }
      const wasEmpty = state.rows.length === 0;
      const existing = new Set(state.rows.map((row) => row.id));
      let addedCount = 0;
      for (const source of response?.sources || []) {
        if (!source || typeof source.id !== "string" || existing.has(source.id)) continue;
        const targetId = wasEmpty && !state.rows.length && state.status?.initialTargetId && targetFor(state.status.initialTargetId)
          ? state.status.initialTargetId : null;
        const row = {
          id: source.id, name: source.name || source.id, targetId, role: "body",
          settings: { ...state.defaults }, descriptor: null, inspection: null,
          artifact: null, previewArtifact: null, status: "待转换", renderError: "",
          previewDirection: 0, previewLocalFrame: 0,
        };
        state.rows.push(row);
        existing.add(source.id);
        addedCount += 1;
        if (targetId) refreshDescriptor(row).catch(() => {});
      }
      if (!state.selectedId && state.rows.length) state.selectedId = state.rows[0].id;
      renderQueue();
      if (selectedRow()) populateControls(selectedRow());
      setStatus(addedCount ? `已添加 ${addedCount} 个模型` : "没有新增模型");
    });
  }
  async function configure() {
    if (state.busy) return;
    await withBusy("配置 Blender…", async () => {
      const result = await api.configure();
      if (result && !result.canceled) {
        await refreshStatus();
        setStatus("Blender 设置已更新");
      } else setStatus("就绪");
    });
  }
  async function editSelected() {
    const row = selectedRow();
    if (!row || state.busy) return;
    await withBusy(`正在为 ${row.name} 准备 Blender 工程…`, async () => {
      const result = await api.edit(row.id);
      if (result?.canceled) return;
      if (result?.source?.id) {
        const transferredTarget = row.targetId;
        const transferredRole = row.role;
        const copiedSettings = { ...row.settings };
        copiedSettings.animation = "";
        if (transferredTarget) {
          row.targetId = null;
          row.descriptor = null;
          invalidateRow(row);
        }
        const editedRow = {
          id: result.source.id,
          name: result.source.name || "Blender 工作副本.blend",
          targetId: transferredTarget || null,
          role: transferredRole || "body",
          settings: copiedSettings,
          descriptor: null,
          inspection: null,
          artifact: null,
          previewArtifact: null,
          status: "待转换",
          renderError: "",
          previewDirection: row.previewDirection || 0,
          previewLocalFrame: row.previewLocalFrame || 0,
        };
        state.rows.push(editedRow);
        state.selectedId = editedRow.id;
        renderQueue();
        populateControls(editedRow);
        if (editedRow.targetId) refreshDescriptor(editedRow).catch(() => {});
      }
      setStatus(result?.source?.name ? `已在 Blender 中打开 ${result.source.name}` : "已在 Blender 中打开模型");
    });
  }
  async function command(name, payload = {}) {
    if (state.busy && name !== "cancel") return;
    if (["export", "exportAll", "apply", "applyAll", "copySettings", "edit"].includes(name)) saveControls();
    if (name === "add") return addSources();
    if (name === "inspect") return inspectRow();
    if (name === "preview") return previewSelected();
    if (name === "render") return renderRows(selectedRow() ? [selectedRow()] : []);
    if (name === "renderAll") return renderRows([...state.rows]);
    if (name === "export") return exportRows(selectedRow() ? [selectedRow()] : []);
    if (name === "exportAll") return exportRows([...state.rows]);
    if (name === "apply") return applyRows(selectedRow() ? [selectedRow()] : []);
    if (name === "applyAll") return applyRows([...state.rows]);
    if (name === "configure") return configure();
    if (name === "edit") return editSelected();
    if (name === "remove") return removeSelected();
    if (name === "copySettings") return copySettings();
    if (name === "cancel") return api.cancel();
    if (name === "target" && payload.id) {
      const projectPath = state.projectPath;
      await refreshStatus();
      if (projectPath !== state.projectPath) {
        if (selectedRow()) populateControls(selectedRow());
        setStatus("工程已切换，请重新指定目标条目", "error");
        return;
      }
      const row = selectedRow();
      if (!row || !targetFor(payload.id)) return;
      elements.targetSelect.value = payload.id;
      saveControls();
    }
  }

  for (const id of settingIds) $(id).addEventListener("change", () => saveControls());
  elements.animationSelect.addEventListener("change", async () => {
    const row = selectedRow();
    if (!row || state.updatingControls) return;
    const selected = row.inspection?.animations?.find((animation) => animation.name === elements.animationSelect.value);
    row.settings.animation = elements.animationSelect.value;
    if (selected) {
      row.settings.startFrame = Math.round(selected.start);
      row.settings.endFrame = Math.round(selected.end);
    } else if (row.inspection) {
      row.settings.startFrame = row.inspection.frameStart;
      row.settings.endFrame = row.inspection.frameEnd;
    }
    state.updatingControls = true;
    elements.startFrame.value = row.settings.startFrame;
    elements.endFrame.value = row.settings.endFrame;
    state.updatingControls = false;
    invalidateRow(row);
    setStatus("动画范围已更新");
  });
  elements.targetSelect.addEventListener("change", async () => {
    const selectedTarget = elements.targetSelect.value;
    const projectPath = state.projectPath;
    try {
      await refreshStatus();
      if (projectPath !== state.projectPath) {
        if (selectedRow()) populateControls(selectedRow());
        setStatus("工程已切换，请重新指定目标条目", "error");
        return;
      }
      if (selectedTarget && !targetFor(selectedTarget)) {
        elements.targetSelect.value = selectedRow()?.targetId || "";
        setStatus("目标条目已变化，请重新选择", "error");
        return;
      }
      saveControls();
    } catch (error) { setStatus(error.message || String(error), "error"); }
  });
  elements.roleSelect.addEventListener("change", () => saveControls());
  elements.scaleSelect.addEventListener("change", () => saveControls());
  elements.directionSelect.addEventListener("change", () => {
    const row = selectedRow();
    if (row) row.previewDirection = Number(elements.directionSelect.value) || 0;
    renderSelected();
  });
  elements.frameRange.addEventListener("input", () => {
    const row = selectedRow();
    if (!row) return;
    row.previewLocalFrame = Number(elements.frameRange.value) || 0;
    elements.frameLabel.textContent = `${Number(elements.frameRange.value) + 1} / ${Number(elements.frameRange.max) + 1}`;
    renderSelected();
  });
  elements.previousFrame.addEventListener("click", () => {
    const row = selectedRow();
    if (!row) return;
    elements.frameRange.value = String((Number(elements.frameRange.value) - 1 + Number(elements.frameRange.max) + 1) % (Number(elements.frameRange.max) + 1));
    row.previewLocalFrame = Number(elements.frameRange.value);
    renderSelected();
  });
  elements.nextFrame.addEventListener("click", () => {
    const row = selectedRow();
    if (!row) return;
    elements.frameRange.value = String((Number(elements.frameRange.value) + 1) % (Number(elements.frameRange.max) + 1));
    row.previewLocalFrame = Number(elements.frameRange.value);
    renderSelected();
  });
  elements.sourceList.addEventListener("keydown", event => {
    if (state.busy || !state.rows.length || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = Math.max(0, state.rows.findIndex(row => row.id === state.selectedId));
    const next = event.key === "Home" ? 0 : event.key === "End" ? state.rows.length - 1
      : Math.max(0, Math.min(state.rows.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
    selectRow(state.rows[next].id);
    const selected = elements.sourceList.querySelector('[aria-selected="true"]');
    selected?.focus(); selected?.scrollIntoView({ block: "nearest" });
  });
  elements.previewButton.addEventListener("click", () => previewSelected().catch((error) => setStatus(error.message, "error")));
  elements.renderButton.addEventListener("click", () => renderRows(selectedRow() ? [selectedRow()] : []).catch((error) => setStatus(error.message, "error")));
  elements.cancelButton.addEventListener("click", () => api.cancel().catch(error => setStatus(error.message, "error")));
  api.onProgress?.((progress) => {
    if (!state.busy) return;
    if (progress?.message) setStatus(progress.message, "busy");
    else if (progress?.sourceId) {
      const row = state.rows.find((item) => item.id === progress.sourceId);
      if (row) setStatus(`${row.name} · ${progress.phase || "处理中"}`, "busy");
    }
  });
  api.onCommand?.((event) => {
    const payload = typeof event === "string" ? {} : event;
    const name = typeof event === "string" ? event : event?.command;
    if (state.initializing) {
      state.queuedCommands.push({ name, payload });
      return;
    }
    command(name, payload).catch((error) => setStatus(error?.message || String(error), "error"));
  });

  window.addEventListener("focus", () => {
    if (!state.busy && !state.initializing) refreshStatus().catch((error) => setStatus(error.message || String(error), "error"));
  });

  (async () => {
    try {
      const result = await api.status();
      applyStatus(result, true);
    } catch (error) {
      elements.blenderStatus.textContent = "无法读取 Blender 状态";
      setStatus(error?.message || String(error), "error");
    } finally {
      state.initializing = false;
      const queued = state.queuedCommands.splice(0);
      for (const item of queued) {
        try { await command(item.name, item.payload); }
        catch (error) { setStatus(error?.message || String(error), "error"); }
      }
    }
  })();
})();
