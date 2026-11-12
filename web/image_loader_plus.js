import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ImageLoaderPlus v0.1.7
// Manager architecture adapted from our PromptLora manager (floating, draggable,
// resizable, searchable panel). Image selection is never stored in the workflow.
// The canvas preview uses the native LoadImage fit-inside calculation, not
// image-dependent node.setSize().
const NODE_TYPE = "ImageLoaderPlus";
const MODE_KEY = "ImageLoaderPlus.displayMode.v1"; // Keep existing privacy setting.
const SIZE_KEY = "ImageLoaderPlus.thumbnailSize.v1";
const PANEL_ID = "ilp-manager-panel";
const instances = new Set();
let pasteListenerInstalled = false;
let dropListenerInstalled = false;
let panelSession = null;

const ICONS = {
  paste: '<rect x="8" y="4" width="12" height="16" rx="2"/><path d="M12 4.5V3a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h3"/><path d="m12 12 3 3-3 3m3-3H9"/>',
  clear: '<path d="M3 6h18M8 6V4h8v2m3 0-1 15H6L5 6m5 4v7m4-7v7"/>',
  folder: '<path d="M3 8V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 10h18"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  eye: '<path d="M2 12s3.7-7 10-7 10 7 10 7-3.7 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.7 5.3A11 11 0 0 1 12 5c6.3 0 10 7 10 7a16 16 0 0 1-3.2 3.7M6.3 6.4C3.5 8.3 2 12 2 12s3.7 7 10 7c2 0 3.8-.7 5.3-1.7M3 3l18 18"/><path d="M10 10a3 3 0 0 0 4 4"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.8 9A7 7 0 0 1 18 7l2 5M4 12l2 5A7 7 0 0 0 18.2 15"/>',
  folderPlus: '<path d="M3 10V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 13v6m-3-3h6"/>',
  manage: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 12 3 3 7-7"/>',
  move: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="m11 13 3 3 3-3m-3 3V9"/>',
};

function svg(name, size = 17) {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

function getMode() {
  try { return localStorage.getItem(MODE_KEY) === "grid" ? "grid" : "list"; }
  catch { return "list"; }
}
function setMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode */ }
}
function getSize() {
  try { return localStorage.getItem(SIZE_KEY) === "L" ? "L" : "S"; }
  catch { return "S"; }
}
function setSize(size) {
  try { localStorage.setItem(SIZE_KEY, size); } catch { /* private mode */ }
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(iconName, hint, onClick, cls = "ilp-tool") {
  const b = el("button", cls);
  b.type = "button";
  b.innerHTML = svg(iconName);
  b.title = hint;
  b.setAttribute("aria-label", hint);
  b.addEventListener("click", event => {
    event.preventDefault(); event.stopPropagation(); onClick();
  });
  return b;
}
function injectCSS() {
  if (document.getElementById("ilp-style")) return;
  const style = el("style");
  style.id = "ilp-style";
  style.textContent = `
    .ilp-controls,.ilp-controls *,.ilp-manager,.ilp-manager * {box-sizing:border-box}
    .ilp-controls {display:flex;align-items:center;justify-content:flex-end;gap:5px;width:100%;height:100%;
      padding:3px 5px;color:var(--input-text,#ddd);pointer-events:auto}
    .ilp-tool {display:inline-flex;align-items:center;justify-content:center;flex:0 0 30px;
      width:30px;height:28px;border:1px solid rgba(140,140,140,.35);border-radius:5px;
      color:inherit;background:rgba(120,120,120,.13);cursor:pointer;padding:0}
    .ilp-tool:hover {background:rgba(130,130,130,.38)}
    .ilp-tool.active {background:rgba(75,133,215,.35);border-color:#669de7}
    .ilp-tool:disabled {opacity:.4;cursor:wait}
    .ilp-manager {position:fixed;z-index:100000;top:80px;left:80px;width:1000px;height:690px;
      min-width:360px;min-height:260px;max-width:95vw;max-height:90vh;resize:both;overflow:hidden;
      display:flex;flex-direction:column;color:#e7e7e7;background:#2b2b2b;
      border:1px solid #4b4b4b;border-radius:8px;box-shadow:0 12px 50px rgba(0,0,0,.8);
      font:13px/1.4 Arial,sans-serif}
    .ilp-manager-head {display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:0 0 auto;
      padding:10px 12px;background:#333;border-bottom:1px solid #484848;cursor:grab;user-select:none}
    .ilp-manager-name {font-size:16px;margin-right:auto;pointer-events:none;white-space:nowrap}
    .ilp-manager-search {width:235px;max-width:35vw;padding:7px 10px;color:#eee;background:#222;
      border:1px solid #5a5a5a;border-radius:4px;font-size:13px;outline:0}
    .ilp-manager-search:focus {border-color:#74a7ec}
    .ilp-manager .ilp-tool {color:#eee;width:31px;height:31px;flex-basis:31px}
    .ilp-manager-body {display:flex;flex:1;min-height:0;overflow:hidden}
    .ilp-manager-side {width:195px;flex:0 0 195px;background:#232323;border-right:1px solid #444;
      padding:9px 7px;overflow:auto;scrollbar-width:thin}
    .ilp-manager-folder {width:100%;padding:7px 10px;border:1px solid transparent;border-radius:5px;
      margin-bottom:2px;background:transparent;color:#d2d2d2;display:flex;gap:6px;
      align-items:center;justify-content:space-between;cursor:pointer;text-align:left;font-size:12px}
    .ilp-manager-folder span {overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ilp-manager-folder:hover {background:#3a3a3a}
    .ilp-manager-folder.active {background:#35465b;border-color:#5b7ea8}
    .ilp-manager-content {min-width:0;display:flex;flex-direction:column;flex:1}
    .ilp-manager-status {padding:7px 12px;border-bottom:1px solid #444;color:#aaa;flex:0 0 auto;
      font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .ilp-manager-status.error {color:#ffa19a}
    .ilp-manager-files {flex:1;min-height:0;overflow:auto;scrollbar-width:thin;padding:12px;align-content:start}
    .ilp-manager-files.grid {display:grid;grid-template-columns:repeat(auto-fill,minmax(var(--ilp-cell,160px),1fr));
      gap:12px;grid-auto-rows:max-content}
    .ilp-manager-files.list {display:flex;flex-direction:column;gap:2px;padding:10px 12px}
    .ilp-image-card {display:flex;flex-direction:column;gap:5px;min-width:0;padding:5px;
      border:1px solid #444;background:#2a2e35;border-radius:6px;cursor:pointer;color:#e7e7e7;text-align:left}
    .ilp-image-card:hover {border-color:#86a5cc;background:#303a48}
    .ilp-image-card.selected {border-color:#669de7;background:#30425a}
    .ilp-image-card img {display:block;width:100%;aspect-ratio:1/1;object-fit:contain;
      background:#181b20;border-radius:4px}
    .ilp-image-card span {overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;padding:0 2px}
    .ilp-image-listitem {width:100%;display:block;padding:7px 9px;min-height:30px;
      background:transparent;border:1px solid transparent;border-radius:4px;cursor:pointer;
      color:#ddd;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
    .ilp-image-listitem:hover {background:#393e46}
    .ilp-image-listitem.selected {border-color:#638abd;background:#334459}
    .ilp-manager-empty {text-align:center;padding:30px;color:#aaa}
    .ilp-manager-folder.drop-target {border:1px dashed #9bc5ff;background:#3a597b}
    .ilp-image-card.manage-selected,.ilp-image-listitem.manage-selected {
      border-color:#ffcc71;background:#574a2e;box-shadow:inset 0 0 0 1px #b8924e}
    .ilp-manager-managebar {display:flex;gap:8px;align-items:center;padding:7px 12px;
      border-bottom:1px solid #4b4b4b;background:#333;color:#eee;flex:0 0 auto}
    .ilp-manager-managebar[hidden] {display:none}
    .ilp-manager-selection {margin-right:auto;color:#ddd}
    .ilp-manager-managebar button,.ilp-dialog button {border:1px solid #666;border-radius:5px;
      background:#393939;color:#eee;padding:5px 11px;cursor:pointer;font-size:12px}
    .ilp-manager-managebar button:hover,.ilp-dialog button:hover {background:#48586c}
    .ilp-manager-managebar button:disabled {opacity:.38;cursor:default}
    .ilp-manager-managebar button.danger {border-color:#986667;color:#ffd4d4}
    .ilp-dialog-overlay {position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,.60);z-index:20;padding:20px}
    .ilp-dialog {background:#303030;border:1px solid #626262;border-radius:8px;
      width:min(440px,100%);padding:16px;box-shadow:0 8px 40px #111;display:flex;flex-direction:column;gap:12px}
    .ilp-dialog-title {font-weight:bold;font-size:15px}
    .ilp-dialog-note {color:#c9c9c9;white-space:pre-wrap;overflow-wrap:anywhere}
    .ilp-dialog-field {color:#eee;background:#222;padding:8px;border-radius:5px;
      border:1px solid #606060;width:100%;font-size:13px}
    .ilp-dialog-actions {display:flex;justify-content:flex-end;gap:8px}
    .ilp-dialog button.primary {background:#345f9d;border-color:#5991df}
    .ilp-dialog button.danger {background:#873f3f;border-color:#b56565}
    @media (max-width:680px) {.ilp-manager-side {width:115px;flex-basis:115px}
      .ilp-manager-head {padding:7px}.ilp-manager-search {width:135px}}
  `;
  document.head.append(style);
}

function previewURL(path) {
  const parts = path.replaceAll("\\", "/").split("/");
  const name = parts.pop();
  const subfolder = parts.join("/");
  return api.apiURL(`/view?${new URLSearchParams({ filename: name, subfolder, type: "input" })}`);
}
function thumbnailURL(item) {
  const query = new URLSearchParams({ path: item.path, w: "240", h: "240", v: String(item.mtime ?? 0) });
  return api.apiURL(`/imageloaderplus/thumb?${query}`);
}
async function postAction(route, data) {
  return readJSON(await api.fetchApi(`/imageloaderplus/${route}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  }));
}
async function readJSON(response) {
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`Ошибка сервера: HTTP ${response.status}`); }
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function extensionOf(name) { return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(name || ""); }
function fileFromTransfer(transfer) {
  if (!transfer) return null;
  for (const file of transfer.files || []) {
    if (file.type.startsWith("image/") || extensionOf(file.name)) return file;
  }
  return null;
}
async function uploadFile(file) {
  const form = new FormData();
  const name = file.name && extensionOf(file.name)
    ? file.name : `Pasted_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
  form.append("image", file, name);
  form.append("type", "input");
  form.append("overwrite", "false");
  const result = await readJSON(await api.fetchApi("/upload/image", { method: "POST", body: form }));
  if (!result.name) throw new Error("ComfyUI не вернул имя картинки");
  return [result.subfolder, result.name].filter(Boolean).join("/").replaceAll("\\", "/");
}
async function getBrowserClipboardImage() {
  if (!navigator.clipboard?.read) return null;
  const items = await navigator.clipboard.read();
  for (const item of items) {
    const type = item.types.find(t => /^image\/(png|jpeg|webp|gif|bmp)$/i.test(t));
    if (!type) continue;
    const blob = await item.getType(type);
    const ext = ({ "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/bmp": "bmp" })[type.toLowerCase()] || "png";
    return new File([blob], `Pasted_${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`, { type });
  }
  return null;
}
async function selectUploaded(state, file) {
  if (!state || state.busy || !state.node?.graph) return;
  state.setBusy(true);
  try { const path = await uploadFile(file); state.choose(path); }
  catch (err) { state.report(err.message || "Не удалось загрузить файл"); }
  finally { state.setBusy(false); }
}
async function pasteImage(state, eventFile = null) {
  if (!state || state.busy || !state.node?.graph) return;
  state.setBusy(true);
  let browserError = null;
  try {
    if (eventFile) { state.choose(await uploadFile(eventFile)); return; }
    try {
      const file = await getBrowserClipboardImage();
      if (file) { state.choose(await uploadFile(file)); return; }
    } catch (err) { browserError = err; }
    // Explorer's Ctrl+C often provides CF_HDROP, not a browser clipboard blob.
    const result = await readJSON(await api.fetchApi("/imageloaderplus/clipboard", { method: "POST" }));
    state.choose(result.path);
  } catch (err) {
    state.report(browserError ? `${err.message} (${browserError.message})` : err.message);
  } finally { state.setBusy(false); }
}
function getSelectedState() {
  const nodes = Object.values(app.canvas?.selected_nodes || {});
  return nodes.length === 1 ? nodes[0]?.__imageLoaderPlusState : null;
}
function installPasteListener() {
  if (pasteListenerInstalled) return;
  pasteListenerInstalled = true;
  window.addEventListener("paste", event => {
    if (event.target?.closest?.("input,textarea,[contenteditable='true'],[role='textbox']")) return;
    const state = getSelectedState();
    if (!state) return;
    event.preventDefault();
    event.stopImmediatePropagation(); // Don't create another Load Image node.
    void pasteImage(state, fileFromTransfer(event.clipboardData));
  }, true);
}
// Dragging onto the image area also works, not only onto the small toolbar.
// The handler targets ImageLoaderPlus rectangles exclusively; the normal canvas
// drop behavior stays intact elsewhere.
function stateAtEvent(event) {
  const canvas = app.canvas;
  if (!canvas || !canvas.canvas) return null;
  if (event.target !== canvas.canvas && !canvas.canvas.contains(event.target)) return null;
  const pos = canvas.convertEventToCanvasOffset?.(event);
  if (!pos) return null;
  for (const state of instances) {
    const node = state.node;
    if (!node.graph) continue;
    if (pos[0] >= node.pos[0] && pos[0] <= node.pos[0] + node.size[0] &&
        pos[1] >= node.pos[1] && pos[1] <= node.pos[1] + node.size[1]) return state;
  }
  return null;
}
function installDropListener() {
  if (dropListenerInstalled) return;
  dropListenerInstalled = true;
  window.addEventListener("dragover", event => {
    if (stateAtEvent(event) && Array.from(event.dataTransfer?.types || []).includes("Files")) {
      event.preventDefault(); event.stopImmediatePropagation();
      event.dataTransfer.dropEffect = "copy";
    }
  }, true);
  window.addEventListener("drop", event => {
    const state = stateAtEvent(event);
    const file = fileFromTransfer(event.dataTransfer);
    if (!state || !file) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void selectUploaded(state, file);
  }, true);
}

function closeManager() { panelSession?.close(); }

// A floating manager adapted directly from PromptLora's openManager design:
// draggable header, resizable window, search, sidebar, card/list modes.
function openManager(state) {
  injectCSS();
  closeManager();
  const panel = el("div", "ilp-manager");
  panel.id = PANEL_ID;
  const header = el("div", "ilp-manager-head");
  const title = el("strong", "ilp-manager-name", "ImageLoaderPlus Manager");
  const search = el("input", "ilp-manager-search");
  search.type = "search";
  search.placeholder = "Поиск по input…";
  search.setAttribute("aria-label", "Поиск изображений");
  const createBtn = button("folderPlus", "Создать подпапку в выбранной папке", () => showNewFolder());
  const manageBtn = button("manage", "Выбрать несколько файлов для перемещения или удаления", () => toggleManage());
  const refreshBtn = button("refresh", "Перечитать папку input", () => void loadFiles());
  const listBtn = button("list", "Приватный список без миниатюр", () => changeMode("list"));
  const closeBtn = button("close", "Закрыть менеджер (Esc)", () => close());
  header.append(title, search, createBtn, manageBtn, refreshBtn, listBtn, closeBtn);

  const body = el("div", "ilp-manager-body");
  const sidebar = el("div", "ilp-manager-side");
  const content = el("div", "ilp-manager-content");
  const status = el("div", "ilp-manager-status", "Загрузка файлов…");
  const manageBar = el("div", "ilp-manager-managebar");
  manageBar.hidden = true;
  const selectionLabel = el("span", "ilp-manager-selection", "Выбрано: 0");
  const moveBtn = el("button", "", "Переместить…");
  moveBtn.title = "Перенести выбранные изображения в папку";
  const deleteBtn = el("button", "danger", "В корзину");
  deleteBtn.title = "Отправить выбранные изображения в корзину Windows (без окончательного удаления)";
  const cancelBtn = el("button", "", "Отмена");
  cancelBtn.title = "Выйти из режима управления файлами";
  manageBar.append(selectionLabel, moveBtn, deleteBtn, cancelBtn);
  const filesBox = el("div", "ilp-manager-files");
  content.append(status, manageBar, filesBox);
  body.append(sidebar, content);
  panel.append(header, body);
  document.body.append(panel);

  // Exactly as in PromptLora, except listeners are removed on close.
  let dragging = false, startX = 0, startY = 0, left = 0, top = 0;
  const onDown = e => {
    if (e.button !== 0 || e.target.closest("button,input,select")) return;
    dragging = true;
    startX = e.clientX; startY = e.clientY;
    const rect = panel.getBoundingClientRect(); left = rect.left; top = rect.top;
    header.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    e.preventDefault();
  };
  const onMove = e => {
    if (!dragging) return;
    panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, left + e.clientX - startX))}px`;
    panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, top + e.clientY - startY))}px`;
  };
  const onUp = () => { dragging = false; header.style.cursor = "grab"; document.body.style.userSelect = ""; };
  const onKey = e => {
    if (e.key === "Escape" && panelSession?.panel === panel) {
      e.preventDefault(); e.stopPropagation();
      const dialog = panel.querySelector(".ilp-dialog-overlay");
      if (dialog) dialog.remove(); else close();
    }
  };
  header.addEventListener("mousedown", onDown);
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
  window.addEventListener("keydown", onKey, true);

  let items = [], folderPaths = [], truncated = false, activeFolder = "", mode = getMode(), size = getSize(), loading = false;
  let manageMode = false, selectedFiles = new Set(), performing = false;
  let loadedCount = 0;
  const cardSizes = { S: 110, L: 220 };
  const sizeButtons = ["S", "L"].map(s => {
    const hint = s === "S" ? "Маленькие миниатюры" : "Крупные миниатюры";
    const b = el("button", "ilp-tool", s);
    b.title = hint;
    b.setAttribute("aria-label", hint);
    b.addEventListener("click", e => {
      e.stopPropagation();
      size = s;
      setSize(size);
      changeMode("grid"); // S/L selects its size AND immediately opens thumbnails.
    });
    header.insertBefore(b, closeBtn);
    return b;
  });

  function toggleManage(force) {
    if (performing) return;
    manageMode = typeof force === "boolean" ? force : !manageMode;
    if (!manageMode) selectedFiles.clear();
    render();
  }
  function selectionPaths() { return [...selectedFiles]; }
  function showDialog({ title, note = "", choices = null, input = null, confirmLabel = "Готово", danger = false, onConfirm }) {
    // In-window dialog; can be cancelled without changing files.
    const overlay = el("div", "ilp-dialog-overlay");
    const dialog = el("div", "ilp-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.append(el("div", "ilp-dialog-title", title));
    if (note) dialog.append(el("div", "ilp-dialog-note", note));
    let field = null;
    if (choices) {
      field = el("select", "ilp-dialog-field");
      for (const folder of choices) {
        const option = el("option", "", folder || "input (корень)");
        option.value = folder;
        field.append(option);
      }
      field.value = choices.includes(activeFolder) ? activeFolder : "";
      dialog.append(field);
    }
    if (input !== null) {
      field = el("input", "ilp-dialog-field");
      field.type = "text";
      field.placeholder = "Название папки";
      field.maxLength = 128;
      field.value = input;
      dialog.append(field);
    }
    const buttons = el("div", "ilp-dialog-actions");
    const no = el("button", "", "Отмена");
    const yes = el("button", danger ? "danger" : "primary", confirmLabel);
    buttons.append(no, yes);
    dialog.append(buttons);
    overlay.append(dialog);
    panel.append(overlay);
    const closeDialog = () => overlay.remove();
    no.addEventListener("click", closeDialog);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeDialog(); });
    yes.addEventListener("click", () => { const value = field?.value; closeDialog(); void onConfirm(value); });
    field?.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); yes.click(); }
    });
    if (field) field.focus(); else no.focus();
    return closeDialog;
  }
  async function performAction(fn) {
    if (performing) return;
    performing = true;
    createBtn.disabled = true; manageBtn.disabled = true;
    moveBtn.disabled = true; deleteBtn.disabled = true;
    status.textContent = "Выполняется операция…";
    try { await fn(); await loadFiles(); }
    catch (err) {
      status.textContent = `Ошибка: ${err.message}`;
      status.classList.add("error");
      console.error("[ImageLoaderPlus] File management:", err);
    } finally {
      performing = false;
      createBtn.disabled = false; manageBtn.disabled = false;
      renderManageBar();
    }
  }
  function showNewFolder() {
    showDialog({
      title: "Новая папка", note: `Внутри: ${activeFolder || "input"}`,
      input: "", confirmLabel: "Создать",
      onConfirm: name => {
        if (!name?.trim()) return;
        void performAction(async () => {
          const data = await postAction("mkdir", { parent: activeFolder, name: name.trim() });
          activeFolder = data.folder;
        });
      },
    });
  }
  async function runMove(paths, destination) {
    if (!paths.length) return;
    await performAction(async () => {
      const result = await postAction("move", { paths, folder: destination });
      for (const change of result.moved || []) {
        if (state.selected === change.from && change.from !== change.to) {
          // Keep an existing hidden preview hidden after an image is moved.
          const wasVisible = state.showPreview;
          state.choose(change.to);
          if (!wasVisible) state.hideOrShow();
        }
      }
      selectedFiles.clear(); manageMode = false;
      // Remain in the source folder so moved files visibly disappear.
      // This is especially helpful when cleaning up the input root.
    });
  }
  function openMoveDialog(paths) {
    if (!paths.length) return;
    showDialog({
      title: "Переместить изображения", note: `Выбрано: ${paths.length}.\nПри совпадении имён новый файл получит суффикс _1, _2…`,
      choices: ["", ...folderPaths], confirmLabel: "Переместить",
      onConfirm: destination => void runMove(paths, destination || ""),
    });
  }
  function openDeleteDialog(paths) {
    if (!paths.length) return;
    showDialog({
      title: "Отправить в корзину?",
      note: `Выбрано файлов: ${paths.length}.\nФайлы будут удалены из input, но их можно восстановить из корзины Windows.`,
      confirmLabel: "В корзину", danger: true,
      onConfirm: () => void performAction(async () => {
        const result = await postAction("delete", { paths });
        if ((result.deleted || []).includes(state.selected)) state.clear();
        selectedFiles.clear(); manageMode = false;
      }),
    });
  }
  moveBtn.addEventListener("click", () => openMoveDialog(selectionPaths()));
  deleteBtn.addEventListener("click", () => openDeleteDialog(selectionPaths()));
  cancelBtn.addEventListener("click", () => toggleManage(false));
  function renderManageBar() {
    manageBtn.classList.toggle("active", manageMode);
    manageBar.hidden = !manageMode;
    selectionLabel.textContent = `Выбрано: ${selectedFiles.size}`;
    moveBtn.disabled = performing || !selectedFiles.size;
    deleteBtn.disabled = performing || !selectedFiles.size;
    cancelBtn.disabled = performing;
  }
  function folderDropHandlers(b, folder) {
    b.addEventListener("dragover", e => {
      if (!e.dataTransfer?.types?.includes("application/x-imageloaderplus-files")) return;
      e.preventDefault(); e.stopPropagation();
      b.classList.add("drop-target");
      e.dataTransfer.dropEffect = "move";
    });
    b.addEventListener("dragleave", () => b.classList.remove("drop-target"));
    b.addEventListener("drop", e => {
      b.classList.remove("drop-target");
      const value = e.dataTransfer?.getData("application/x-imageloaderplus-files");
      if (!value) return;
      e.preventDefault(); e.stopPropagation();
      let paths;
      try { paths = JSON.parse(value); } catch { return; }
      if (!Array.isArray(paths) || !paths.length) return;
      showDialog({
        title: "Переместить в папку?",
        note: `${paths.length} файлов → ${folder || "input"}`,
        confirmLabel: "Переместить", onConfirm: () => void runMove(paths, folder),
      });
    });
  }
  function close() {
    if (panelSession?.panel !== panel) return;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    window.removeEventListener("keydown", onKey, true);
    document.body.style.userSelect = "";
    panel.remove();
    panelSession = null;
  }
  panelSession = { panel, close, state };

  function changeMode(next) {
    mode = next;
    setMode(mode); // Privacy mode remembered across ComfyUI restarts.
    render();
  }
  function folderName(path) {
    const ix = path.lastIndexOf("/");
    return ix === -1 ? "" : path.slice(0, ix);
  }
  function renderSidebar() {
    sidebar.replaceChildren();
    const folders = new Set(["", ...folderPaths]);
    // Older backends may omit empty folders; include inferred parents as well.
    for (const f of items) {
      const parts = folderName(f.path).split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join("/"));
    }
    for (const folder of [...folders].sort((a,b) => a.localeCompare(b, "ru"))) {
      // Each folder displays/counts only its immediate images (never descendants).
      const filesCount = items.filter(f => folderName(f.path) === folder).length;
      const b = el("button", "ilp-manager-folder");
      b.title = folder ? `Папка ${folder}: только её файлы` : "Папка input: только файлы в корне, без подпапок";
      b.classList.toggle("active", activeFolder === folder);
      const name = el("span", "", folder ? `📁 ${folder}` : "📁 input");
      b.append(name, el("small", "", String(filesCount)));
      b.addEventListener("click", () => { activeFolder = folder; render(); });
      folderDropHandlers(b, folder);
      sidebar.append(b);
    }
  }
  function render() {
    if (panelSession?.panel !== panel) return;
    renderManageBar();
    listBtn.classList.toggle("active", mode === "list");
    for (let i = 0; i < sizeButtons.length; i++) {
      sizeButtons[i].classList.toggle("active", mode === "grid" && sizeButtons[i].textContent === size);
    }
    filesBox.className = `ilp-manager-files ${mode}`;
    filesBox.style.setProperty("--ilp-cell", `${cardSizes[size]}px`);
    filesBox.replaceChildren(); // In list mode there are ZERO thumbnail <img> elements.
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = items.filter(f => folderName(f.path) === activeFolder &&
      (!query || f.name.toLocaleLowerCase().includes(query)));
    status.textContent = `${activeFolder || "input"} · ${filtered.length} файлов${truncated ? " (список ограничен 5000)" : ""} · ${mode === "list" ? "Приватный список" : "Миниатюры"}`;
    status.classList.remove("error");
    renderSidebar();
    if (!filtered.length) { filesBox.append(el("div", "ilp-manager-empty", query ? "По запросу ничего не найдено" : "В этой папке нет изображений")); return; }
    loadedCount = 0;
    let limit = Math.min(150, filtered.length);
    const appendMore = () => {
      const fragment = document.createDocumentFragment();
      for (let i = loadedCount; i < limit; i++) {
        const file = filtered[i];
        const item = el("button", mode === "grid" ? "ilp-image-card" : "ilp-image-listitem");
        item.type = "button";
        item.title = file.path;
        item.classList.toggle("selected", !manageMode && state.selected === file.path);
        item.classList.toggle("manage-selected", manageMode && selectedFiles.has(file.path));
        item.draggable = true;
        item.title = manageMode ? `${file.path} · Нажмите для выделения` : `${file.path} · Правой кнопкой — управление`;
        if (mode === "grid") {
          const img = el("img");
          img.loading = "lazy"; img.alt = ""; img.draggable = false;
          img.src = thumbnailURL(file);
          item.append(img, el("span", "", file.name));
        } else {
          item.textContent = file.name;
        }
        item.addEventListener("click", e => {
          if (manageMode) {
            if (selectedFiles.has(file.path)) selectedFiles.delete(file.path);
            else selectedFiles.add(file.path);
            item.classList.toggle("manage-selected", selectedFiles.has(file.path));
            renderManageBar();
          } else { state.choose(file.path); close(); }
        });
        item.addEventListener("contextmenu", e => {
          e.preventDefault(); e.stopPropagation();
          manageMode = true;
          selectedFiles.clear(); selectedFiles.add(file.path);
          render();
        });
        item.addEventListener("dragstart", e => {
          const paths = manageMode && selectedFiles.has(file.path) ? selectionPaths() : [file.path];
          e.dataTransfer.setData("application/x-imageloaderplus-files", JSON.stringify(paths));
          e.dataTransfer.effectAllowed = "move";
        });
        fragment.append(item);
      }
      filesBox.append(fragment);
      loadedCount = limit;
    };
    appendMore();
    filesBox.onscroll = () => {
      if (filesBox.scrollTop + filesBox.clientHeight < filesBox.scrollHeight - 180) return;
      if (limit >= filtered.length) return;
      limit = Math.min(limit + 120, filtered.length);
      appendMore();
    };
  }
  async function loadFiles() {
    if (loading) return;
    loading = true;
    status.textContent = "Загрузка файлов…";
    refreshBtn.disabled = true;
    try {
      const data = await readJSON(await api.fetchApi("/imageloaderplus/list"));
      if (panelSession?.panel !== panel) return;
      items = data.files || [];
      folderPaths = data.folders || [];
      // Don't leave stale selection for an image that moved outside the manager.
      const existing = new Set(items.map(x => x.path));
      for (const path of selectedFiles) if (!existing.has(path)) selectedFiles.delete(path);
      truncated = Boolean(data.truncated);
      render();
    } catch (err) {
      status.textContent = `Ошибка: ${err.message}`; status.classList.add("error");
    } finally { loading = false; refreshBtn.disabled = false; }
  }
  search.addEventListener("input", render);
  void loadFiles(); // Always refresh input when the manager opens.
}

function createState(node, imageWidget) {
  injectCSS();
  const controls = el("div", "ilp-controls");
  const state = {
    node, imageWidget, controls, selected: "", showPreview: false,
    previewImage: null, busy: false, serial: 0,
    report(message) { console.warn("[ImageLoaderPlus]", message); controls.title = message; },
    setBusy(value) { this.busy = value; pasteBtn.disabled = value; folderBtn.disabled = value; },
    choose(path) {
      this.selected = path || "";
      this.imageWidget.value = this.selected;
      this.imageWidget.callback?.(this.selected);
      this.showPreview = Boolean(this.selected);
      this.serial++;
      const serial = this.serial;
      this.previewImage = null;
      if (this.selected) {
        const img = new Image();
        img.onload = () => {
          if (this.serial !== serial || !this.node.graph) return;
          this.previewImage = img;
          this.node.setDirtyCanvas?.(true, true);
        };
        img.onerror = () => { if (this.serial === serial) this.report("Не удалось загрузить предпросмотр"); };
        img.src = previewURL(this.selected);
      }
      this.updateButtons();
      this.node.setDirtyCanvas?.(true, true);
    },
    clear() { this.choose(""); },
    hideOrShow() { if (!this.selected) return; this.showPreview = !this.showPreview; this.updateButtons(); this.node.setDirtyCanvas?.(true,true); },
    updateButtons() {
      eyeBtn.disabled = !this.selected;
      clearBtn.disabled = !this.selected;
      eyeBtn.innerHTML = svg(this.showPreview ? "eye" : "eyeOff");
      eyeBtn.title = this.showPreview ? "Скрыть картинку" : "Показать картинку";
      eyeBtn.setAttribute("aria-label", eyeBtn.title);
      eyeBtn.classList.toggle("active", this.showPreview && !!this.selected);
      controls.title = this.selected ? "Изображение выбрано" : "Изображение не выбрано";
    },
    resetOnRestore() { this.choose(""); if (panelSession?.state === this) closeManager(); },
  };
  const pasteBtn = button("paste", "Вставить изображение из буфера (Ctrl+V)", () => void pasteImage(state));
  const clearBtn = button("clear", "Очистить картинку (файл останется в input)", () => state.clear());
  const eyeBtn = button("eyeOff", "Показать или скрыть картинку", () => state.hideOrShow());
  const folderBtn = button("folder", "Открыть менеджер изображений", () => openManager(state));
  controls.append(pasteBtn, clearBtn, eyeBtn, folderBtn);
  controls.addEventListener("dragover", event => { event.preventDefault(); event.stopPropagation(); });
  controls.addEventListener("drop", event => {
    const file = fileFromTransfer(event.dataTransfer);
    if (!file) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void selectUploaded(state, file);
  });

  // No selected image path is persisted in workflow JSON. The image STRING
  // remains serialized for execution prompts, exactly as in v0.1.3.
  imageWidget.serialize = false;
  imageWidget.options = { ...(imageWidget.options || {}), serialize: true };
  imageWidget.value = "";
  imageWidget.type = "hidden";
  imageWidget.computeSize = () => [0, -4];

  const toolbarWidget = node.addDOMWidget("ilp_controls", "custom", controls, {
    serialize: false, hideOnZoom: false,
    getMinHeight: () => 38,
    getMaxHeight: () => 38,
    getHeight: () => 38,
  });
  if (toolbarWidget) {
    toolbarWidget.serialize = false;
    toolbarWidget.options = { ...(toolbarWidget.options || {}), serialize: false };
  }

  // Same fit algorithm as ComfyUI native Load Image / useImagePreviewWidget:
  // scale = min(availableWidth/imageWidth, availableHeight/imageHeight, 1).
  // The preview uses the node's existing width AND height, never resizes it.
  const previewWidget = {
    name: "ilp_canvas_preview", type: "custom", value: "",
    options: { serialize: false },
    computeSize: width => [width, 220],
    draw(ctx, currentNode, width, y) {
      const previewW = Math.max(1, width - 20);
      const previewH = Math.max(1, currentNode.size[1] - y - 12);
      const x = 10;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,.13)";
      ctx.fillRect(x, y, previewW, previewH);
      const img = state.showPreview ? state.previewImage : null;
      if (img?.naturalWidth && img?.naturalHeight) {
        const scale = Math.min(previewW / img.naturalWidth, previewH / img.naturalHeight, 1);
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        ctx.drawImage(img, x + (previewW - w) / 2, y + (previewH - h) / 2, w, h);
      } else if (!state.selected) {
        ctx.fillStyle = "#85858e";
        ctx.font = "12px Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Изображение не выбрано", x + previewW / 2, y + previewH / 2);
      } else if (!state.showPreview) {
        ctx.fillStyle = "#85858e";
        ctx.font = "12px Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Предпросмотр скрыт", x + previewW / 2, y + previewH / 2);
      }
      ctx.restore();
    },
  };
  node.addCustomWidget(previewWidget);
  node.__imageLoaderPlusState = state;
  instances.add(state);
  state.updateButtons();
  // Initial size only; unlike v0.1.3, never call setSize on image changes.
  if (!node.size || node.size[0] < 320 || node.size[1] < 340) {
    node.setSize?.([Math.max(360, node.size?.[0] || 0), 360]);
  }
  return state;
}

app.registerExtension({
  name: "ImageLoaderPlus.ImageLoaderPlus",
  setup() { installPasteListener(); installDropListener(); },
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const previousCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = previousCreated?.apply(this, arguments);
      const imageWidget = this.widgets?.find(w => w.name === "image");
      if (!imageWidget || !this.addDOMWidget || !this.addCustomWidget) {
        console.error("[ImageLoaderPlus] Missing widgets or frontend API");
        return result;
      }
      createState(this, imageWidget);
      return result;
    };
    const previousConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const result = previousConfigure?.apply(this, arguments);
      this.__imageLoaderPlusState?.resetOnRestore();
      return result;
    };
    const previousRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      const state = this.__imageLoaderPlusState;
      if (state) {
        if (panelSession?.state === state) closeManager();
        instances.delete(state);
        state.serial++;
        delete this.__imageLoaderPlusState;
      }
      return previousRemoved?.apply(this, arguments);
    };
  },
});
