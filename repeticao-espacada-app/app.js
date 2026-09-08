const STORAGE_KEY = "revisa.tree.v2";
const DAY_MS = 24 * 60 * 60 * 1000;

const COLORS = ["#8b7dff", "#34c77b", "#e0b23c", "#e08a3c", "#f0546a", "#3ca7e0", "#c04cf0", "#4ccfb0"];
const ICONS = ["📁", "📚", "🧮", "🔬", "🌎", "💡", "⭐", "🎯", "📐", "🧪", "🎨", "🗂️", "⚗️", "🧬", "🏛️", "✍️", "📖", "🧠"];

// ---------- estado / "banco" em JSON flexível ----------
// db.nodes = { [id]: node }
// node (fichário/pasta): { id, type:'folder', name, color, icon, parentId, createdAt }
// node (tópico):        { id, type:'topic', name, parentId, interval, dueDate, repetitions,
//                          reviewCount, forgotCount, lastReviewed, createdAt }
const API_BASE = "/api";
const WORKSPACE_KEY = "revisa.workspace";

// código do "espaço" (workspace) — deixa dar sync/compartilhar a mesma árvore entre dispositivos/pessoas
// sem precisar de login: cada código vira uma linha própria no Postgres.
function getWorkspaceCode() {
  let code = localStorage.getItem(WORKSPACE_KEY);
  if (!code) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I pra evitar confusão
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    localStorage.setItem(WORKSPACE_KEY, code);
  }
  return code;
}

function treeUrl() {
  return `${API_BASE}/tree/${encodeURIComponent(getWorkspaceCode())}`;
}

let db = loadLocalDb(); // cache instantâneo, pra primeira pintura sem esperar rede
ensureDbShape();

// garante que a árvore sempre tenha o formato esperado, mesmo vinda de backups antigos
// ou de uma troca de espaço/sincronização que traga um objeto incompleto.
function ensureDbShape() {
  if (!db.nodes) db.nodes = {};
  if (!db.reviewLog) db.reviewLog = {};
}
let activeTab = "hoje";
let currentFolderId = null; // null = raiz
let sheetContextFolderId = null;
let editingFolderId = null;
let editingTopicId = null;
let editingTopicParentId = null;
let statsTopicId = null;
let draggedNodeId = null;

function loadLocalDb() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { nodes: {} };
}

// grava local (instantâneo) e, se houver backend (Postgres via API), sincroniza em produção.
// se não houver rede/backend (ex: app aberto como site estático puro), falha em silêncio e
// segue funcionando só com o cache local — sem quebrar o modo "sem servidor".
function saveDb() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  fetch(treeUrl(), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(db),
  }).catch(() => {});
}

// busca a versão do servidor (fonte da verdade quando há backend) e reconcilia com o cache local.
async function syncFromServer() {
  syncBarStart();
  try {
    const res = await fetch(treeUrl(), { cache: "no-store" });
    if (!res.ok) return;
    const remote = await res.json();
    if (remote && remote.nodes && Object.keys(remote.nodes).length > 0) {
      db = remote;
      ensureDbShape();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      renderAll();
    }
  } catch {
    // sem backend disponível (ex: aberto como arquivo estático) — segue no modo local normalmente
  } finally {
    syncBarEnd();
  }
}

// troca de espaço explícita (usuário digitou outro código pra entrar numa árvore compartilhada) —
// aqui sim substitui db mesmo se vier vazio, porque a intenção é entrar naquele espaço de verdade.
async function switchWorkspace(newCode) {
  localStorage.setItem(WORKSPACE_KEY, newCode);
  syncBarStart();
  try {
    const res = await fetch(treeUrl(), { cache: "no-store" });
    const remote = res.ok ? await res.json() : null;
    db = remote && remote.nodes ? remote : { nodes: {} };
  } catch {
    db = { nodes: {} };
  } finally {
    syncBarEnd();
  }
  ensureDbShape();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  renderAll();
  showToast(`Espaço trocado para ${newCode}`);
}

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function allNodes() {
  return Object.values(db.nodes);
}

// filhos "de verdade" (ignora deletedAt) — usado só pela lógica de excluir/restaurar em lote
function rawChildren(parentId) {
  return allNodes().filter((n) => n.parentId === parentId);
}

function children(parentId) {
  return rawChildren(parentId)
    .filter((n) => !n.deletedAt)
    .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
}

function folderChildren(parentId) {
  return children(parentId).filter((n) => n.type === "folder");
}

function topicChildren(parentId) {
  return children(parentId).filter((n) => n.type === "topic");
}

function getNode(id) {
  return db.nodes[id];
}

function pathOf(id) {
  const path = [];
  let cur = id ? getNode(id) : null;
  while (cur) {
    path.unshift(cur);
    cur = cur.parentId ? getNode(cur.parentId) : null;
  }
  return path;
}

function allTopics() {
  return allNodes().filter((n) => n.type === "topic" && !n.deletedAt);
}

function deletedNodes() {
  return allNodes()
    .filter((n) => n.deletedAt)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

function isDue(topic) {
  return topic.dueDate <= Date.now();
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString("pt-BR", { day: "numeric", month: "short", year: "numeric" });
}

// ---------- curva de esquecimento (simplificada: dobra o intervalo) ----------
function markReviewed(topicId) {
  const topic = getNode(topicId);
  if (!topic) return;
  topic.interval = topic.interval ? topic.interval * 2 : 1;
  topic.repetitions = (topic.repetitions || 0) + 1;
  topic.reviewCount = (topic.reviewCount || 0) + 1;
  topic.lastReviewed = Date.now();
  topic.dueDate = Date.now() + topic.interval * DAY_MS;
  logActivity();
  saveDb();
  renderAll();
}

function markForgot(topicId) {
  const topic = getNode(topicId);
  if (!topic) return;
  topic.interval = 1;
  topic.forgotCount = (topic.forgotCount || 0) + 1;
  topic.lastReviewed = Date.now();
  topic.dueDate = Date.now(); // volta pra fila de hoje
  logActivity();
  saveDb();
  renderAll();
}

// ---------- streak / heatmap de atividade ----------
function dateKeyOf(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function logActivity() {
  const key = dateKeyOf(Date.now());
  db.reviewLog[key] = (db.reviewLog[key] || 0) + 1;
}

function computeStreak() {
  let streak = 0;
  let cursor = Date.now();
  // se hoje ainda não teve nenhuma revisão, a sequência não quebrou — só ainda não somou hoje
  if (!db.reviewLog[dateKeyOf(cursor)]) cursor -= DAY_MS;
  while (db.reviewLog[dateKeyOf(cursor)] > 0) {
    streak += 1;
    cursor -= DAY_MS;
  }
  return streak;
}

function dueLabel(topic) {
  const diffMs = topic.dueDate - Date.now();
  if (diffMs <= 0) return { text: "hoje", cls: "due-today" };
  const days = Math.round(diffMs / DAY_MS);
  if (days <= 1) return { text: "amanhã", cls: "due-soon" };
  if (days < 7) return { text: `em ${days} dias`, cls: "due-soon" };
  if (days < 30) return { text: `em ${Math.round(days / 7)} sem.`, cls: "" };
  return { text: `em ${Math.round(days / 30)} mês(es)`, cls: "" };
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- toasts (substitui alert() pra feedback não-bloqueante) ----------
// showToast(message, { actionLabel, onAction, duration }) — actionLabel/onAction opcionais
// pra mostrar um botão de ação (ex: desfazer); duration em ms (padrão 4000).
function showToast(message, opts) {
  const options = opts || {};
  const duration = options.duration || 4000;
  const dock = document.getElementById("toast-dock");
  if (!dock) return;

  // mantém no máx. 2 toasts visíveis pra não empilhar demais
  while (dock.children.length >= 2) dock.removeChild(dock.firstChild);

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
    <span class="toast-message">${escapeHtml(message)}</span>
    ${options.actionLabel ? `<button class="toast-action">${escapeHtml(options.actionLabel)}</button>` : ""}
  `;

  let dismissed = false;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    toast.classList.add("toast-leaving");
    setTimeout(() => toast.remove(), 160);
  }

  if (options.actionLabel && options.onAction) {
    toast.querySelector(".toast-action").addEventListener("click", () => {
      options.onAction();
      dismiss();
    });
  }

  dock.appendChild(toast);
  setTimeout(dismiss, duration);
}

// ---------- barra de sincronização (indicador sutil de "algo rodando em segundo plano") ----------
let syncBarActiveCount = 0;
function syncBarStart() {
  syncBarActiveCount += 1;
  document.getElementById("sync-bar").hidden = false;
  document.getElementById("sync-bar").classList.add("active");
}
function syncBarEnd() {
  syncBarActiveCount = Math.max(0, syncBarActiveCount - 1);
  if (syncBarActiveCount === 0) {
    const bar = document.getElementById("sync-bar");
    bar.classList.remove("active");
    bar.hidden = true;
  }
}

// ---------- tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.getElementById("panel-hoje").classList.toggle("active", tab === "hoje");
  document.getElementById("panel-agenda").classList.toggle("active", tab === "agenda");
  document.getElementById("panel-ficharios").classList.toggle("active", tab === "ficharios");
  document.getElementById("fab").hidden = tab !== "ficharios";
  renderAll();
}

// ---------- navegação entre views (fullscreen forms) ----------
function showView(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function closeView() {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
}

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", closeView);
});

// ---------- linha de tópico reutilizável (Hoje / Fichários / Agenda) ----------
// showDoneButtons=true (aba Hoje) ganha gesto de swipe; fora da Hoje (Fichários) ganha alça de arraste (⠿).
function makeTopicRow(topic, { showPath, showDue, showDoneButtons, dotColor, allowDrag } = {}) {
  const row = document.createElement("div");
  row.className = "topic-row";
  row.dataset.id = topic.id;
  row.dataset.type = "topic";

  const path = showPath ? pathOf(topic.parentId).map((n) => n.name).join(" / ") : "";
  const label = showDue ? dueLabel(topic) : null;

  row.innerHTML = `
    ${allowDrag ? `<span class="drag-handle" title="Arrastar">⠿</span>` : ""}
    ${dotColor ? `<span class="row-dot" style="background:${dotColor}"></span>` : ""}
    <div class="topic-main">
      <div class="topic-name">${escapeHtml(topic.name)}</div>
      ${path ? `<div class="topic-path">${escapeHtml(path)}</div>` : ""}
    </div>
    ${label ? `<span class="due-badge ${label.cls}">${label.text}</span>` : ""}
    ${
      showDoneButtons
        ? `<button class="btn-forgot" title="Não lembrei">Não lembrei</button>
           <button class="btn-done" title="Marcar como revisado">✓</button>`
        : `<button class="icon-menu" title="Editar">⋯</button>`
    }
  `;

  row.querySelector(".topic-main").addEventListener("click", () => openTopicStats(topic.id));

  if (showDoneButtons) {
    row.querySelector(".btn-done").addEventListener("click", () => markReviewed(topic.id));
    row.querySelector(".btn-forgot").addEventListener("click", () => markForgot(topic.id));
    attachSwipeGesture(row, topic.id);
  } else {
    row.querySelector(".icon-menu").addEventListener("click", (e) => {
      e.stopPropagation();
      openTopicForm(topic.parentId, topic.id);
    });
  }

  if (allowDrag) {
    attachDragHandle(row.querySelector(".drag-handle"), topic.id, "topic");
  }

  return row;
}

// ---------- render: Hoje ----------
function renderHoje() {
  const due = allTopics().filter(isDue).sort((a, b) => a.dueDate - b.dueDate);
  const list = document.getElementById("hoje-list");
  const empty = document.getElementById("hoje-empty");
  const count = document.getElementById("hoje-count");
  count.textContent = due.length ? String(due.length) : "";

  list.innerHTML = "";
  if (due.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  due.forEach((topic) => {
    list.appendChild(makeTopicRow(topic, { showPath: true, showDoneButtons: true }));
  });
}

// ---------- render: Agenda (estilo Google Calendar) ----------
function renderAgenda() {
  const container = document.getElementById("agenda-list");
  const empty = document.getElementById("agenda-empty");
  container.innerHTML = "";

  const topics = allTopics().slice().sort((a, b) => a.dueDate - b.dueDate);
  if (topics.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const todayStart = startOfDay(Date.now());
  const groups = new Map();
  topics.forEach((t) => {
    const key = Math.max(startOfDay(t.dueDate), todayStart);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });

  Array.from(groups.keys())
    .sort((a, b) => a - b)
    .forEach((key) => {
      const dayDiff = Math.round((key - todayStart) / DAY_MS);
      const label = agendaDayLabel(key, dayDiff);

      const section = document.createElement("div");
      section.className = "agenda-group";
      section.innerHTML = `
        <div class="agenda-date">
          <span class="agenda-date-main">${label.main}</span>
          <span class="agenda-date-sub">${label.sub}</span>
        </div>
      `;
      const rowsWrap = document.createElement("div");
      rowsWrap.className = "agenda-rows";
      groups.get(key).forEach((topic) => {
        const path = pathOf(topic.parentId);
        const nearestFolder = path.length ? path[path.length - 1] : null;
        rowsWrap.appendChild(
          makeTopicRow(topic, {
            showPath: true,
            dotColor: nearestFolder ? nearestFolder.color : "var(--accent)",
          })
        );
      });
      section.appendChild(rowsWrap);
      container.appendChild(section);
    });
}

function agendaDayLabel(dayStart, dayDiff) {
  if (dayDiff <= 0) {
    return { main: "Hoje", sub: new Date(dayStart).toLocaleDateString("pt-BR", { day: "numeric", month: "long" }) };
  }
  if (dayDiff === 1) {
    return { main: "Amanhã", sub: new Date(dayStart).toLocaleDateString("pt-BR", { day: "numeric", month: "long" }) };
  }
  const d = new Date(dayStart);
  const weekday = d.toLocaleDateString("pt-BR", { weekday: "long" });
  const date = d.toLocaleDateString("pt-BR", { day: "numeric", month: "long" });
  return { main: weekday.charAt(0).toUpperCase() + weekday.slice(1), sub: date };
}

// ---------- render: Fichários ----------
function renderBreadcrumb() {
  const el = document.getElementById("breadcrumb");
  el.innerHTML = "";

  const rootCrumb = document.createElement("span");
  rootCrumb.className = "crumb" + (currentFolderId === null ? " current" : "");
  rootCrumb.textContent = "🏠 Início";
  rootCrumb.addEventListener("click", () => {
    currentFolderId = null;
    renderAll();
  });
  el.appendChild(rootCrumb);

  pathOf(currentFolderId).forEach((node) => {
    const sep = document.createElement("span");
    sep.className = "sep";
    sep.textContent = "›";
    el.appendChild(sep);

    const crumb = document.createElement("span");
    crumb.className = "crumb" + (node.id === currentFolderId ? " current" : "");
    crumb.textContent = `${node.icon} ${node.name}`;
    crumb.addEventListener("click", () => {
      currentFolderId = node.id;
      renderAll();
    });
    el.appendChild(crumb);
  });
}

function countTopicsRecursive(folderId) {
  let count = topicChildren(folderId).length;
  folderChildren(folderId).forEach((f) => {
    count += countTopicsRecursive(f.id);
  });
  return count;
}

function dueCountRecursive(folderId) {
  let count = topicChildren(folderId).filter(isDue).length;
  folderChildren(folderId).forEach((f) => {
    count += dueCountRecursive(f.id);
  });
  return count;
}

function renderFicharios() {
  renderBreadcrumb();

  const folderGrid = document.getElementById("folder-grid");
  const topicGrid = document.getElementById("topic-grid");
  const empty = document.getElementById("ficharios-empty");
  folderGrid.innerHTML = "";
  topicGrid.innerHTML = "";

  const folders = folderChildren(currentFolderId);
  const topics = topicChildren(currentFolderId);

  folders.forEach((folder) => {
    const card = document.createElement("div");
    card.className = "folder-card";
    card.dataset.id = folder.id;
    card.dataset.type = "folder";
    card.style.setProperty("--folder-color", folder.color);
    const subCount = countTopicsRecursive(folder.id);
    const dueCount = dueCountRecursive(folder.id);
    card.innerHTML = `
      <span class="drag-handle" title="Arrastar">⠿</span>
      <button class="folder-card-menu" title="Editar">⋯</button>
      ${dueCount > 0 ? `<span class="folder-card-due-badge">${dueCount} hoje</span>` : ""}
      <div class="folder-card-icon">${folder.icon}</div>
      <span class="folder-card-name">${escapeHtml(folder.name)}</span>
      <span class="folder-card-sub">${subCount} tópico(s)</span>
    `;
    card.addEventListener("click", (e) => {
      if (e.target.closest(".folder-card-menu") || e.target.closest(".drag-handle")) return;
      currentFolderId = folder.id;
      renderAll();
    });
    card.querySelector(".folder-card-menu").addEventListener("click", (e) => {
      e.stopPropagation();
      openFolderForm(folder.id);
    });

    attachDragHandle(card.querySelector(".drag-handle"), folder.id, "folder");

    folderGrid.appendChild(card);
  });

  topics.forEach((topic) => {
    topicGrid.appendChild(makeTopicRow(topic, { showDue: true, allowDrag: true }));
  });

  empty.hidden = folders.length > 0 || topics.length > 0;
}

function renderAll() {
  renderHoje();
  if (activeTab === "agenda") renderAgenda();
  if (activeTab === "ficharios") renderFicharios();
  renderSidebarTree();
}

// ---------- FAB + bottom sheet ----------
document.getElementById("fab").addEventListener("click", () => {
  sheetContextFolderId = currentFolderId;
  document.getElementById("sheet-add").hidden = false;
});

document.querySelectorAll("[data-close-sheet]").forEach((el) =>
  el.addEventListener("click", () => (document.getElementById("sheet-add").hidden = true))
);
document.getElementById("sheet-add").addEventListener("click", (e) => {
  if (e.target.id === "sheet-add") document.getElementById("sheet-add").hidden = true;
});

document.getElementById("sheet-new-folder").addEventListener("click", () => {
  document.getElementById("sheet-add").hidden = true;
  openFolderForm(null, sheetContextFolderId);
});
document.getElementById("sheet-new-topic").addEventListener("click", () => {
  document.getElementById("sheet-add").hidden = true;
  openTopicForm(sheetContextFolderId, null);
});

// ---------- form: fichário ----------
let form_folder_parentId = null;
let selectedColor = COLORS[0];
let selectedIcon = ICONS[0];

function openFolderForm(folderId, parentIdForNew) {
  editingFolderId = folderId;
  const folder = folderId ? getNode(folderId) : null;

  document.getElementById("folder-form-title").textContent = folder ? "Editar fichário" : "Novo fichário";
  document.getElementById("folder-name").value = folder ? folder.name : "";
  document.getElementById("folder-delete").hidden = !folder;

  renderColorPicker(folder ? folder.color : COLORS[0]);
  renderIconPicker(folder ? folder.icon : ICONS[0]);

  form_folder_parentId = folder ? folder.parentId : parentIdForNew;
  showView("view-folder-form");
}

function renderColorPicker(selected) {
  selectedColor = selected;
  const el = document.getElementById("color-picker");
  el.innerHTML = "";
  COLORS.forEach((c) => {
    const sw = document.createElement("div");
    sw.className = "color-swatch" + (c === selected ? " selected" : "");
    sw.style.background = c;
    sw.addEventListener("click", () => {
      selectedColor = c;
      el.querySelectorAll(".color-swatch").forEach((s) => s.classList.remove("selected"));
      sw.classList.add("selected");
    });
    el.appendChild(sw);
  });
}

function renderIconPicker(selected) {
  selectedIcon = selected;
  const el = document.getElementById("icon-picker");
  el.innerHTML = "";
  ICONS.forEach((icon) => {
    const btn = document.createElement("div");
    btn.className = "icon-option" + (icon === selected ? " selected" : "");
    btn.textContent = icon;
    btn.addEventListener("click", () => {
      selectedIcon = icon;
      el.querySelectorAll(".icon-option").forEach((s) => s.classList.remove("selected"));
      btn.classList.add("selected");
    });
    el.appendChild(btn);
  });
}

document.getElementById("form-folder").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("folder-name").value.trim();
  if (!name) return;

  if (editingFolderId) {
    const folder = getNode(editingFolderId);
    folder.name = name;
    folder.color = selectedColor;
    folder.icon = selectedIcon;
  } else {
    const id = uid();
    const now = Date.now();
    db.nodes[id] = {
      id,
      type: "folder",
      name,
      color: selectedColor,
      icon: selectedIcon,
      parentId: form_folder_parentId,
      createdAt: now,
      order: now,
      deletedAt: null,
    };
  }
  saveDb();
  closeView();
  renderAll();
});

document.getElementById("folder-delete").addEventListener("click", () => {
  if (!editingFolderId) return;
  softDeleteRecursive(editingFolderId, Date.now());
  saveDb();
  closeView();
  renderAll();
});

// exclusão definitiva (usada só pela Lixeira) — remove de fato, ignora deletedAt
function deleteNodeRecursive(id) {
  rawChildren(id).forEach((c) => deleteNodeRecursive(c.id));
  delete db.nodes[id];
}

// exclusão "suave": marca o nó e todos os descendentes com o mesmo deletedAt (um "lote"),
// escondendo-os da árvore normal sem apagar de verdade — eles ficam recuperáveis na Lixeira.
function softDeleteRecursive(id, ts) {
  const node = getNode(id);
  if (!node) return;
  node.deletedAt = ts;
  rawChildren(id).forEach((c) => softDeleteRecursive(c.id, ts));
}

// restaura um nó da Lixeira e sobe a cadeia de pais restaurando qualquer ancestral
// que também esteja deletado — senão o item volta escondido dentro de uma pasta na lixeira.
function restoreNode(id) {
  const node = getNode(id);
  if (!node) return;
  node.deletedAt = null;
  let cur = node.parentId ? getNode(node.parentId) : null;
  while (cur) {
    if (cur.deletedAt) cur.deletedAt = null;
    cur = cur.parentId ? getNode(cur.parentId) : null;
  }
  saveDb();
  renderAll();
  renderTrash();
}

// ---------- form: tópico ----------
function openTopicForm(parentId, topicId) {
  editingTopicId = topicId;
  editingTopicParentId = parentId;
  const topic = topicId ? getNode(topicId) : null;

  document.getElementById("topic-form-title").textContent = topic ? "Editar tópico" : "Novo tópico";
  document.getElementById("topic-name").value = topic ? topic.name : "";
  document.getElementById("topic-delete").hidden = !topic;

  const path = pathOf(parentId).map((n) => `${n.icon} ${n.name}`).join(" / ");
  document.getElementById("topic-form-location").textContent = path ? `Em: ${path}` : "Em: 🏠 Início";

  showView("view-topic-form");
}

document.getElementById("form-topic").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = document.getElementById("topic-name").value.trim();
  if (!name) return;

  if (editingTopicId) {
    getNode(editingTopicId).name = name;
  } else {
    const id = uid();
    const now = Date.now();
    db.nodes[id] = {
      id,
      type: "topic",
      name,
      parentId: editingTopicParentId,
      interval: 0,
      dueDate: now,
      repetitions: 0,
      reviewCount: 0,
      forgotCount: 0,
      lastReviewed: null,
      createdAt: now,
      order: now,
      deletedAt: null,
    };
  }
  saveDb();
  closeView();
  renderAll();
});

document.getElementById("topic-delete").addEventListener("click", () => {
  if (!editingTopicId) return;
  softDeleteRecursive(editingTopicId, Date.now());
  saveDb();
  closeView();
  renderAll();
});

// ---------- modal: estatísticas do tópico ----------
function openTopicStats(topicId) {
  const topic = getNode(topicId);
  if (!topic) return;
  statsTopicId = topicId;

  document.getElementById("stats-topic-name").textContent = topic.name;
  const path = pathOf(topic.parentId).map((n) => `${n.icon} ${n.name}`).join(" / ");
  document.getElementById("stats-topic-path").textContent = path || "🏠 Início";

  const reviewCount = topic.reviewCount || 0;
  const forgotCount = topic.forgotCount || 0;
  const totalAttempts = reviewCount + forgotCount;
  const accuracy = totalAttempts > 0 ? `${Math.round((reviewCount / totalAttempts) * 100)}%` : "—";

  const rows = [
    ["Começou em", formatDate(topic.createdAt)],
    ["Última revisão", topic.lastReviewed ? formatDate(topic.lastReviewed) : "ainda não revisado"],
    ["Próxima revisão", formatDate(topic.dueDate)],
    ["Intervalo atual", topic.interval ? `${topic.interval} dia(s)` : "novo"],
    ["Revisões concluídas", String(reviewCount)],
    ["Vezes que esqueceu", String(forgotCount)],
    ["Taxa de acerto", accuracy],
  ];

  document.getElementById("stats-grid").innerHTML = rows
    .map(([label, value]) => `<div class="stats-row"><span class="stats-label">${label}</span><span class="stats-value">${escapeHtml(value)}</span></div>`)
    .join("");

  document.getElementById("topic-stats-modal").hidden = false;
}

document.querySelectorAll("[data-close-modal]").forEach((el) =>
  el.addEventListener("click", () => (document.getElementById("topic-stats-modal").hidden = true))
);
document.getElementById("topic-stats-modal").addEventListener("click", (e) => {
  if (e.target.id === "topic-stats-modal") document.getElementById("topic-stats-modal").hidden = true;
});
document.getElementById("stats-edit-btn").addEventListener("click", () => {
  const topic = getNode(statsTopicId);
  if (!topic) return;
  document.getElementById("topic-stats-modal").hidden = true;
  openTopicForm(topic.parentId, topic.id);
});

// ---------- sidebar: árvore de fichários + drag-and-drop ----------
function openSidebar() {
  document.getElementById("sidebar-overlay").hidden = false;
}
function closeSidebar() {
  document.getElementById("sidebar-overlay").hidden = true;
}

document.getElementById("sidebar-toggle").addEventListener("click", openSidebar);
document.querySelectorAll("[data-close-sidebar]").forEach((el) => el.addEventListener("click", closeSidebar));
document.getElementById("sidebar-overlay").addEventListener("click", (e) => {
  if (e.target.id === "sidebar-overlay") closeSidebar();
});

function wouldCreateCycle(draggedId, targetParentId) {
  if (targetParentId === draggedId) return true;
  let cur = targetParentId ? getNode(targetParentId) : null;
  while (cur) {
    if (cur.id === draggedId) return true;
    cur = cur.parentId ? getNode(cur.parentId) : null;
  }
  return false;
}

function moveNode(nodeId, targetParentId) {
  if (!nodeId) return;
  const node = getNode(nodeId);
  if (!node) return;
  if (node.parentId === targetParentId || node.id === targetParentId) return;
  if (node.type === "folder" && wouldCreateCycle(node.id, targetParentId)) {
    showToast("Não é possível mover um fichário para dentro dele mesmo.");
    return;
  }
  node.parentId = targetParentId;
  saveDb();
  draggedNodeId = null;
  renderAll();
}

// reordena nodeId pra ficar imediatamente antes de beforeSiblingId entre seus irmãos atuais
// (beforeSiblingId null = mover pro final). Usa "order" fracionário — não precisa reindexar os outros.
function reorderNode(nodeId, beforeSiblingId) {
  const node = getNode(nodeId);
  if (!node) return;
  const siblings = children(node.parentId).filter((n) => n.id !== nodeId);

  if (beforeSiblingId === null || beforeSiblingId === undefined) {
    const maxOrder = siblings.length ? Math.max(...siblings.map((n) => n.order ?? n.createdAt)) : Date.now();
    node.order = maxOrder + 1000;
  } else {
    const index = siblings.findIndex((n) => n.id === beforeSiblingId);
    if (index === -1) return;
    const beforeOrder = siblings[index].order ?? siblings[index].createdAt;
    const prevSibling = siblings[index - 1];
    node.order = prevSibling ? ((prevSibling.order ?? prevSibling.createdAt) + beforeOrder) / 2 : beforeOrder - 1000;
  }

  saveDb();
  renderAll();
}

// ---------- drag-and-drop unificado (mouse + touch) via Pointer Events ----------
// substitui a antiga DnD HTML5 (draggable/dragstart/dragover/drop), que não funciona em touch.
// só é iniciado a partir de uma "alça" (.drag-handle) dentro de topic-row/folder-card na aba Fichários.
let draggedNodeType = null;
let dragGhostEl = null;
let dragOverEl = null;

function attachDragHandle(handleEl, nodeId, nodeType) {
  if (!handleEl) return;
  handleEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startDrag(e, nodeId, nodeType);
  });
}

function startDrag(e, nodeId, nodeType) {
  draggedNodeId = nodeId;
  draggedNodeType = nodeType;

  const node = getNode(nodeId);
  dragGhostEl = document.createElement("div");
  dragGhostEl.className = "drag-ghost";
  dragGhostEl.textContent = `${node.icon || "🎯"} ${node.name}`;
  positionGhost(e.clientX, e.clientY);
  document.body.appendChild(dragGhostEl);

  openSidebar();

  document.addEventListener("pointermove", onDragMove);
  document.addEventListener("pointerup", onDragEnd);
  document.addEventListener("pointercancel", onDragCancel);
}

function positionGhost(x, y) {
  if (!dragGhostEl) return;
  dragGhostEl.style.left = x + "px";
  dragGhostEl.style.top = y + "px";
}

function onDragMove(e) {
  if (!draggedNodeId) return;
  positionGhost(e.clientX, e.clientY);

  const target = findDropTarget(e.clientX, e.clientY);
  if (dragOverEl && (!target || target.el !== dragOverEl)) {
    dragOverEl.classList.remove("drag-over");
    dragOverEl = null;
  }
  if (target) {
    target.el.classList.add("drag-over");
    dragOverEl = target.el;
  }
}

function onDragEnd(e) {
  finishDrag(findDropTarget(e.clientX, e.clientY));
}

function onDragCancel() {
  finishDrag(null);
}

function finishDrag(target) {
  document.removeEventListener("pointermove", onDragMove);
  document.removeEventListener("pointerup", onDragEnd);
  document.removeEventListener("pointercancel", onDragCancel);
  if (dragOverEl) {
    dragOverEl.classList.remove("drag-over");
    dragOverEl = null;
  }
  if (dragGhostEl) {
    dragGhostEl.remove();
    dragGhostEl = null;
  }

  const nodeId = draggedNodeId;
  if (target && nodeId) {
    if (target.action === "move") moveNode(nodeId, target.folderId);
    else if (target.action === "reorder") reorderNode(nodeId, target.beforeSiblingId);
  }

  draggedNodeId = null;
  draggedNodeType = null;
  closeSidebar();
}

// decide o que está embaixo do ponteiro: mover pra dentro de um fichário (sidebar ou folder-card,
// no meio do card) ou reordenar entre irmãos (bordas do folder-card, ou qualquer topic-row).
function findDropTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;

  const sidebarRow = el.closest(".sidebar-row");
  if (sidebarRow) {
    const folderId = sidebarRow.dataset.dropFolderId || null; // "" (raiz) -> null
    return { el: sidebarRow, action: "move", folderId };
  }

  const folderCard = el.closest(".folder-card");
  if (folderCard && folderCard.dataset.id !== draggedNodeId) {
    const rect = folderCard.getBoundingClientRect();
    const relY = (y - rect.top) / rect.height;
    if (relY < 0.2 || relY > 0.8) {
      const beforeSiblingId =
        relY < 0.2
          ? folderCard.dataset.id
          : folderCard.nextElementSibling && folderCard.nextElementSibling.classList.contains("folder-card")
          ? folderCard.nextElementSibling.dataset.id
          : null;
      return { el: folderCard, action: "reorder", beforeSiblingId };
    }
    return { el: folderCard, action: "move", folderId: folderCard.dataset.id };
  }

  const topicRow = el.closest(".topic-row");
  if (topicRow && topicRow.closest("#topic-grid") && topicRow.dataset.id !== draggedNodeId) {
    const rect = topicRow.getBoundingClientRect();
    const relY = (y - rect.top) / rect.height;
    const beforeSiblingId =
      relY < 0.5
        ? topicRow.dataset.id
        : topicRow.nextElementSibling && topicRow.nextElementSibling.classList.contains("topic-row")
        ? topicRow.nextElementSibling.dataset.id
        : null;
    return { el: topicRow, action: "reorder", beforeSiblingId };
  }

  return null;
}

// ---------- swipe (aba Hoje): deslizar a linha marca revisado (direita) ou não lembrei (esquerda) ----------
function attachSwipeGesture(row, topicId) {
  const THRESHOLD = 90;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let swiping = false;
  let tracking = false;

  row.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".btn-done") || e.target.closest(".btn-forgot")) return;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    swiping = false;
    tracking = true;
    row.addEventListener("pointermove", onMove);
    row.addEventListener("pointerup", onUp);
    row.addEventListener("pointercancel", onCancel);
  });

  function onMove(e) {
    if (!tracking) return;
    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    if (!swiping) {
      if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
      if (Math.abs(deltaY) > Math.abs(deltaX)) {
        // gesto mais vertical que horizontal: provavelmente é scroll da lista, não swipe
        cleanup();
        return;
      }
      swiping = true;
    }
    dx = deltaX;
    row.style.transform = `translateX(${dx}px)`;
    row.classList.toggle("swipe-right", dx > 20);
    row.classList.toggle("swipe-left", dx < -20);
  }

  function onUp() {
    if (swiping && Math.abs(dx) > THRESHOLD) {
      const goingRight = dx > 0;
      row.style.transition = "transform 0.18s ease-in, opacity 0.18s ease-in";
      row.style.transform = `translateX(${goingRight ? "120%" : "-120%"})`;
      row.style.opacity = "0";
      setTimeout(() => {
        if (goingRight) markReviewed(topicId);
        else markForgot(topicId);
      }, 160);
    } else if (swiping) {
      row.style.transition = "transform 0.2s ease-out";
      row.style.transform = "translateX(0)";
      row.classList.remove("swipe-right", "swipe-left");
    }
    cleanup();
  }

  function onCancel() {
    row.style.transition = "transform 0.2s ease-out";
    row.style.transform = "translateX(0)";
    row.classList.remove("swipe-right", "swipe-left");
    cleanup();
  }

  function cleanup() {
    swiping = false;
    tracking = false;
    row.removeEventListener("pointermove", onMove);
    row.removeEventListener("pointerup", onUp);
    row.removeEventListener("pointercancel", onCancel);
  }
}

function renderSidebarTree() {
  const container = document.getElementById("sidebar-tree");
  if (!container) return;
  container.innerHTML = "";

  const trashBadge = document.getElementById("trash-count-badge");
  const trashCount = deletedNodes().length;
  trashBadge.textContent = String(trashCount);
  trashBadge.hidden = trashCount === 0;

  const rootRow = document.createElement("div");
  rootRow.className = "sidebar-row sidebar-row-root";
  rootRow.dataset.dropFolderId = "";
  rootRow.innerHTML = `<span class="sidebar-icon" style="background:var(--accent-2)">🏠</span><span class="sidebar-name">Início</span>`;
  rootRow.addEventListener("click", () => {
    currentFolderId = null;
    setTab("ficharios");
    closeSidebar();
  });
  container.appendChild(rootRow);

  renderSidebarChildren(null, container, 1);
}

function renderSidebarChildren(parentId, container, depth) {
  folderChildren(parentId).forEach((folder) => {
    const row = document.createElement("div");
    row.className = "sidebar-row";
    row.style.paddingLeft = 12 + depth * 18 + "px";
    row.dataset.dropFolderId = folder.id;
    row.innerHTML = `
      <span class="sidebar-icon" style="background:${folder.color}">${folder.icon}</span>
      <span class="sidebar-name">${escapeHtml(folder.name)}</span>
      <span class="sidebar-count">${countTopicsRecursive(folder.id)}</span>
    `;

    row.addEventListener("click", () => {
      currentFolderId = folder.id;
      setTab("ficharios");
      closeSidebar();
    });

    container.appendChild(row);
    // sempre renderiza todos os níveis (capítulos, seções, sub-seções...) de uma vez
    renderSidebarChildren(folder.id, container, depth + 1);
  });
}

// ---------- lixeira ----------
function openTrash() {
  renderTrash();
  document.getElementById("trash-modal").hidden = false;
}
function closeTrash() {
  document.getElementById("trash-modal").hidden = true;
}

function renderTrash() {
  const list = document.getElementById("trash-list");
  const empty = document.getElementById("trash-empty");
  const items = deletedNodes();
  list.innerHTML = "";

  if (items.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  items.forEach((node) => {
    const row = document.createElement("div");
    row.className = "trash-row";
    const typeLabel = node.type === "folder" ? "Fichário" : "Tópico";
    row.innerHTML = `
      <div class="trash-row-main">
        <div class="trash-row-name">${escapeHtml(node.name)}</div>
        <div class="trash-row-meta">${typeLabel} · excluído em ${formatDate(node.deletedAt)}</div>
      </div>
      <div class="trash-row-actions">
        <button class="trash-restore-btn">Restaurar</button>
        <button class="trash-purge-btn">Excluir</button>
      </div>
    `;
    row.querySelector(".trash-restore-btn").addEventListener("click", () => restoreNode(node.id));
    row.querySelector(".trash-purge-btn").addEventListener("click", () => {
      if (!confirm(`Excluir definitivamente "${node.name}"? Essa ação não pode ser desfeita.`)) return;
      deleteNodeRecursive(node.id);
      saveDb();
      renderAll();
      renderTrash();
    });
    list.appendChild(row);
  });
}

document.getElementById("trash-open-btn").addEventListener("click", openTrash);
document.querySelectorAll("[data-close-trash]").forEach((el) => el.addEventListener("click", closeTrash));
document.getElementById("trash-modal").addEventListener("click", (e) => {
  if (e.target.id === "trash-modal") closeTrash();
});

// ---------- código do espaço (workspace) ----------
function renderWorkspaceCode() {
  document.getElementById("workspace-code-display").textContent = getWorkspaceCode();
}

document.getElementById("workspace-copy-btn").addEventListener("click", () => {
  const code = getWorkspaceCode();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(code)
      .then(() => showToast("Código copiado."))
      .catch(() => showToast("Não foi possível copiar o código."));
  } else {
    showToast("Cópia automática não suportada neste navegador.");
  }
});

document.getElementById("workspace-switch-btn").addEventListener("click", async () => {
  const current = getWorkspaceCode();
  const input = prompt("Digite o código do espaço que você quer usar (deixe igual pra cancelar):", current);
  if (!input) return;
  const newCode = input.trim().toUpperCase();
  if (!newCode || newCode === current) return;
  await switchWorkspace(newCode);
  renderWorkspaceCode();
});

// ---------- exportar / importar backup em JSON ----------
function exportBackup() {
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = url;
  a.download = `revisa-backup-${today}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Backup exportado.");
}

document.getElementById("export-btn").addEventListener("click", exportBackup);

document.getElementById("import-btn").addEventListener("click", () => {
  document.getElementById("import-file-input").click();
});

document.getElementById("import-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed.nodes !== "object") throw new Error("formato inválido");
    db.nodes = parsed.nodes;
    db.reviewLog = parsed.reviewLog && typeof parsed.reviewLog === "object" ? parsed.reviewLog : {};
    saveDb();
    renderAll();
    showToast("Backup importado com sucesso.");
  } catch {
    showToast("Arquivo inválido, tente outro backup.");
  }
});

// ---------- busca global (tópicos + fichários) ----------
function openSearch() {
  const input = document.getElementById("search-input");
  input.value = "";
  renderSearchResults("");
  document.getElementById("search-modal").hidden = false;
  setTimeout(() => input.focus(), 30);
}
function closeSearch() {
  document.getElementById("search-modal").hidden = true;
}

document.getElementById("search-toggle").addEventListener("click", openSearch);
document.querySelectorAll("[data-close-search]").forEach((el) => el.addEventListener("click", closeSearch));
document.getElementById("search-modal").addEventListener("click", (e) => {
  if (e.target.id === "search-modal") closeSearch();
});
document.getElementById("search-input").addEventListener("input", (e) => renderSearchResults(e.target.value));

function renderSearchResults(query) {
  const results = document.getElementById("search-results");
  const empty = document.getElementById("search-empty");
  const q = query.trim().toLowerCase();
  results.innerHTML = "";

  if (!q) {
    results.hidden = true;
    empty.hidden = true;
    return;
  }

  const matches = allNodes()
    .filter((n) => !n.deletedAt && n.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.length - b.name.length);

  if (matches.length === 0) {
    results.hidden = true;
    empty.hidden = false;
    return;
  }

  results.hidden = false;
  empty.hidden = true;

  matches.forEach((node) => {
    const path = pathOf(node.parentId).map((n) => n.name).join(" / ");
    const row = document.createElement("div");
    row.className = "search-result-row";
    row.innerHTML = `
      <span class="search-result-icon">${node.type === "folder" ? node.icon : "🎯"}</span>
      <div class="search-result-main">
        <div class="search-result-name">${escapeHtml(node.name)}</div>
        ${path ? `<div class="search-result-path">${escapeHtml(path)}</div>` : ""}
      </div>
    `;
    row.addEventListener("click", () => {
      closeSearch();
      if (node.type === "topic") {
        openTopicStats(node.id);
      } else {
        currentFolderId = node.id;
        setTab("ficharios");
      }
    });
    results.appendChild(row);
  });
}

// ---------- estatísticas globais: sequência + heatmap de atividade ----------
function openGlobalStats() {
  renderStreak();
  renderHeatmap();
  renderNotifToggle();
  document.getElementById("global-stats-modal").hidden = false;
}
function closeGlobalStats() {
  document.getElementById("global-stats-modal").hidden = true;
}

document.getElementById("stats-open-btn").addEventListener("click", openGlobalStats);
document.querySelectorAll("[data-close-global-stats]").forEach((el) => el.addEventListener("click", closeGlobalStats));
document.getElementById("global-stats-modal").addEventListener("click", (e) => {
  if (e.target.id === "global-stats-modal") closeGlobalStats();
});

function renderStreak() {
  const streak = computeStreak();
  const el = document.getElementById("streak-display");
  if (streak > 0) {
    const label = streak === 1 ? "dia" : "dias";
    el.innerHTML = `<span class="streak-flame">🔥</span><span class="streak-number">${streak}</span><span class="streak-label">${label} de sequência</span>`;
  } else {
    el.innerHTML = `<span class="streak-empty-label">Nenhuma sequência ativa ainda — revise algo hoje pra começar! 🔥</span>`;
  }
}

function renderHeatmap() {
  const grid = document.getElementById("heatmap-grid");
  grid.innerHTML = "";

  const today = startOfDay(Date.now());
  const spanDays = 91; // ~13 semanas
  const rawStart = today - (spanDays - 1) * DAY_MS;
  const startWeekday = new Date(rawStart).getDay(); // alinha a primeira coluna no domingo
  const gridStart = rawStart - startWeekday * DAY_MS;
  const weeks = Math.ceil((today - gridStart) / DAY_MS / 7) + 1;

  for (let w = 0; w < weeks; w++) {
    const col = document.createElement("div");
    col.className = "heatmap-col";
    for (let d = 0; d < 7; d++) {
      const ts = gridStart + (w * 7 + d) * DAY_MS;
      const cell = document.createElement("div");
      if (ts > today) {
        cell.className = "heatmap-cell heatmap-cell-empty";
      } else {
        const count = db.reviewLog[dateKeyOf(ts)] || 0;
        const level = count === 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : count <= 6 ? 3 : 4;
        cell.className = `heatmap-cell heatmap-level-${level}`;
        cell.title = `${formatDate(ts)} — ${count} revisão(ões)`;
      }
      col.appendChild(cell);
    }
    grid.appendChild(col);
  }
}

// ---------- lembretes (Notification API, melhor-esforço — só funciona com o app aberto) ----------
const NOTIF_KEY = "revisa.notifications";
const NOTIF_LAST_KEY = "revisa.lastNotified";

function notifStatus() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted" && localStorage.getItem(NOTIF_KEY) === "on") return "on";
  return "off";
}

function renderNotifToggle() {
  const btn = document.getElementById("notif-toggle-btn");
  const status = notifStatus();
  btn.disabled = status === "unsupported" || status === "denied";
  if (status === "unsupported") btn.textContent = "🔔 Notificações não suportadas neste navegador";
  else if (status === "denied") btn.textContent = "🔕 Notificações bloqueadas (ajuste no navegador)";
  else if (status === "on") btn.textContent = "🔕 Desativar lembretes";
  else btn.textContent = "🔔 Ativar lembretes";
}

document.getElementById("notif-toggle-btn").addEventListener("click", async () => {
  const status = notifStatus();
  if (status === "on") {
    localStorage.setItem(NOTIF_KEY, "off");
    renderNotifToggle();
    showToast("Lembretes desativados.");
    return;
  }
  if (status !== "off") return;
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    localStorage.setItem(NOTIF_KEY, "on");
    showToast("Lembretes ativados. Só chegam enquanto o app estiver aberto.");
  } else {
    showToast("Permissão de notificação não concedida.");
  }
  renderNotifToggle();
});

// dispara no máximo 1x por dia, só se o app for aberto naquele dia — não é push real em segundo plano
function maybeNotifyDueToday() {
  if (notifStatus() !== "on") return;
  const today = dateKeyOf(Date.now());
  if (localStorage.getItem(NOTIF_LAST_KEY) === today) return;
  const dueCount = allTopics().filter(isDue).length;
  if (dueCount === 0) return;
  localStorage.setItem(NOTIF_LAST_KEY, today);
  try {
    new Notification("Revisa", {
      body: `Você tem ${dueCount} ${dueCount === 1 ? "item" : "itens"} pra revisar hoje.`,
      icon: "icon.svg",
    });
  } catch {}
}

// ---------- dados mockados (ENEM) na primeira vez que o app abre ----------
function seedIfEmpty() {
  if (localStorage.getItem("revisa.seeded.v2")) return;
  localStorage.setItem("revisa.seeded.v2", "1");
  if (Object.keys(db.nodes).length > 0) return;

  const now = Date.now();
  let t = now;
  const nextCreatedAt = () => (t += 1000);

  function addFolder(name, color, icon, parentId) {
    const id = uid();
    const createdAt = nextCreatedAt();
    db.nodes[id] = { id, type: "folder", name, color, icon, parentId, createdAt, order: createdAt, deletedAt: null };
    return id;
  }

  function addTopic(name, parentId, dueInDays, interval, repetitions) {
    const id = uid();
    const createdAt = nextCreatedAt();
    db.nodes[id] = {
      id,
      type: "topic",
      name,
      parentId,
      interval,
      dueDate: now + dueInDays * DAY_MS,
      repetitions,
      reviewCount: repetitions,
      forgotCount: 0,
      lastReviewed: repetitions > 0 ? now - 1 * DAY_MS : null,
      createdAt,
      order: createdAt,
      deletedAt: null,
    };
    return id;
  }

  const enem = addFolder("ENEM 2026", COLORS[0], "📚", null);

  const mat = addFolder("Matemática", COLORS[5], "🧮", enem);
  addTopic("Funções e gráficos", mat, 0, 4, 2);
  addTopic("Geometria plana e espacial", mat, 0, 1, 1);
  addTopic("Estatística e probabilidade", mat, 3, 2, 1);
  addTopic("Progressões (PA e PG)", mat, 8, 8, 3);

  const port = addFolder("Português & Redação", COLORS[3], "✍️", enem);
  addTopic("Interpretação de texto", port, 0, 1, 1);
  addTopic("Figuras de linguagem", port, 2, 2, 1);
  addTopic("Estrutura da redação dissertativa", port, 5, 4, 2);

  const fis = addFolder("Física", COLORS[1], "🔬", enem);
  addTopic("Cinemática (MU e MUV)", fis, 0, 1, 1);
  addTopic("Leis de Newton", fis, 1, 1, 0);
  addTopic("Eletrodinâmica", fis, 6, 4, 2);

  const qui = addFolder("Química", COLORS[4], "⚗️", enem);
  addTopic("Tabela periódica e ligações", qui, 0, 2, 1);
  addTopic("Estequiometria", qui, 4, 2, 1);

  const bio = addFolder("Biologia", COLORS[2], "🧬", enem);
  addTopic("Genética mendeliana", bio, 0, 1, 1);
  addTopic("Ecologia e biomas brasileiros", bio, 2, 2, 1);
  addTopic("Citologia", bio, 10, 8, 3);

  const hisGeo = addFolder("História & Geografia", COLORS[6], "🏛️", enem);
  const historia = addFolder("História", COLORS[6], "🏛️", hisGeo);
  addTopic("Era Vargas", historia, 0, 1, 1);
  addTopic("Guerra Fria", historia, 4, 2, 1);
  const geografia = addFolder("Geografia", COLORS[7], "🌎", hisGeo);
  addTopic("Geopolítica mundial", geografia, 0, 1, 0);
  addTopic("Climas e vegetação do Brasil", geografia, 3, 2, 1);

  saveDb();
}

// ---------- tema claro/escuro ----------
const THEME_KEY = "revisa.theme";

function systemPrefersLight() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
}

function applyTheme(theme) {
  const btn = document.getElementById("theme-toggle");
  if (theme) {
    document.documentElement.setAttribute("data-theme", theme);
    btn.textContent = theme === "light" ? "☀️" : "🌙";
  } else {
    document.documentElement.removeAttribute("data-theme");
    btn.textContent = systemPrefersLight() ? "☀️" : "🌙";
  }
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  applyTheme(saved);
}

document.getElementById("theme-toggle").addEventListener("click", () => {
  const current = localStorage.getItem(THEME_KEY) || (systemPrefersLight() ? "light" : "dark");
  const next = current === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// ---------- init ----------
initTheme();
seedIfEmpty();
renderAll();
renderWorkspaceCode();
maybeNotifyDueToday();
syncFromServer();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
