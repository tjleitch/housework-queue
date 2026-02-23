import React, { useEffect, useMemo, useState } from "react";

/**
 * Housework Queue MVP (Locked Daily Plan)
 * - Local storage via localStorage (simple MVP)
 * - Backup/Restore JSON
 * - Import paste rows (tab or comma separated)
 * - Daily plan "locks" once generated; tasks do NOT refill as you complete them
 * - Mark done -> enter actual minutes -> estimate updates (EWMA)
 * - Add/Edit/Delete tasks; edit frequency (days), last done, estimate
 */

const STORAGE_KEY = "housework_queue_v2";

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseUSDateToISO(s) {
  // Accepts: M/D/YYYY, MM/DD/YYYY, or YYYY-MM-DD
  const t = String(s ?? "").trim();
  if (!t) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;

  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;

  const mm = String(m[1]).padStart(2, "0");
  const dd = String(m[2]).padStart(2, "0");
  const yy = m[3];
  return `${yy}-${mm}-${dd}`;
}

function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function daysBetweenISO(aISO, bISO) {
  // b - a in days
  const [ay, am, ad] = aISO.split("-").map(Number);
  const [by, bm, bd] = bISO.split("-").map(Number);
  const a = new Date(ay, am - 1, ad);
  const b = new Date(by, bm - 1, bd);
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.round(x)));
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function defaultTasksFromSample() {
  const t = todayISO();
  return [
    { id: uid(), name: "Swiffer front hallway", freqDays: 4, lastDoneISO: addDaysISO(t, -10), estMin: 15, history: [] },
    { id: uid(), name: "Change AC filters", freqDays: 31, lastDoneISO: addDaysISO(t, -60), estMin: 15, history: [] },
  ];
}

function computeDueISO(task) {
  return addDaysISO(task.lastDoneISO, Math.max(1, task.freqDays));
}

function isOverdue(task, nowISO) {
  const due = computeDueISO(task);
  return daysBetweenISO(due, nowISO) > 0;
}

/**
 * Urgency scoring:
 * latenessRatio = daysSinceDone / freqDays
 * overdue if ratio >= 1
 * score ramps faster the more overdue it is (relative to frequency)
 */
function urgencyScore(task, nowISO) {
  const freq = Math.max(1, task.freqDays);
  const daysSince = Math.max(0, daysBetweenISO(task.lastDoneISO, nowISO));
  const ratio = daysSince / freq;

  if (ratio < 1) return 0.02 * ratio; // small for not-due
  const base = ratio - 1;
  return base * base + 0.05 * ratio; // ramps as overdue grows
}

/**
 * Build today's plan:
 * - Each task at most once/day
 * - Prioritize overdue first (then score)
 * - Fill up to budget minutes (<= budget)
 *
 * Greedy fill is fine initially; can upgrade later.
 */
function buildPlan(tasks, nowISO, budgetMin) {
  const scored = tasks
    .map((t) => ({
      task: t,
      score: urgencyScore(t, nowISO),
      est: Math.max(1, t.estMin || 15),
      overdue: isOverdue(t, nowISO),
      dueISO: computeDueISO(t),
    }))
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1; // overdue first
      if (b.score !== a.score) return b.score - a.score; // higher score first
      return a.dueISO.localeCompare(b.dueISO); // earlier due first
    });

  const picked = [];
  let total = 0;

  for (const item of scored) {
    if (total >= budgetMin) break;
    if (item.est + total > budgetMin) continue; // never exceed
    picked.push(item.task.id);
    total += item.est;
  }

  // If nothing fits (rare), pick the most urgent single task
  if (picked.length === 0 && scored.length > 0) {
    picked.push(scored[0].task.id);
    total = Math.max(1, scored[0].est);
  }

  return { pickedIds: picked, totalEstMin: total };
}

function formatOverdueLabel(task, nowISO) {
  const due = computeDueISO(task);
  const delta = daysBetweenISO(due, nowISO); // positive overdue
  if (delta > 0) return `Overdue by ${delta}d`;
  if (delta === 0) return `Due today`;
  return `Due in ${Math.abs(delta)}d`;
}

function ewmaUpdate(oldEst, actualMin, alpha = 0.3) {
  const oldV = Math.max(1, Number(oldEst) || 15);
  const actV = Math.max(1, Number(actualMin) || oldV);
  return Math.max(1, Math.round(oldV * (1 - alpha) + actV * alpha));
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ""));
    r.onerror = () => reject(new Error("Failed to read file"));
    r.readAsText(file);
  });
}

function normalizeImportedRow(parts) {
  // parts: [name, freqDays, lastDone, estMin]
  const name = (parts[0] || "").trim();
  const freqDays = clampInt(parts[1], 1, 3650);
  const lastDoneISO = parseUSDateToISO(parts[2]);
  const estMin = clampInt(parts[3] ?? 15, 1, 240);

  if (!name || !lastDoneISO) return null;

  return {
    id: uid(),
    name,
    freqDays,
    lastDoneISO,
    estMin,
    history: [],
  };
}

function parsePaste(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const tasks = [];
  for (const line of lines) {
    const parts = line.includes("\t")
      ? line.split("\t")
      : line.split(",").map((p) => p.trim());

    const t = normalizeImportedRow(parts);
    if (t) tasks.push(t);
  }
  return tasks;
}

/* ---------- UI helpers ---------- */

function Card({ children }) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e7e7e7",
        borderRadius: 12,
        padding: 14,
        boxShadow: "0 1px 6px rgba(0,0,0,0.04)",
      }}
    >
      {children}
    </div>
  );
}

function SmallButton({ children, onClick, kind = "default", title, disabled }) {
  const bg = kind === "primary" ? "#111" : kind === "danger" ? "#b00020" : "#f3f3f3";
  const fg = kind === "primary" || kind === "danger" ? "#fff" : "#111";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid #ddd",
        background: disabled ? "#eee" : bg,
        color: disabled ? "#777" : fg,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

function Modal({ open, title, children, onClose }) {
  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(640px, 100%)",
          background: "#fff",
          borderRadius: 14,
          border: "1px solid #ddd",
          padding: 16,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <h3 style={{ margin: 0 }}>{title}</h3>
          <SmallButton onClick={onClose} title="Close">
            ✕
          </SmallButton>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <div style={{ fontSize: 12, color: "#444" }}>{label}</div>
      {children}
    </label>
  );
}

function TextInput(props) {
  return (
    <input
      {...props}
      style={{
        padding: 10,
        borderRadius: 10,
        border: "1px solid #ddd",
        background: "#fff",
      }}
    />
  );
}

function NumberInput(props) {
  return (
    <input
      {...props}
      type="number"
      style={{
        padding: 10,
        borderRadius: 10,
        border: "1px solid #ddd",
        background: "#fff",
      }}
    />
  );
}

function Tabs({ tab, setTab }) {
  const Item = ({ id, label }) => (
    <button
      onClick={() => setTab(id)}
      style={{
        padding: "10px 12px",
        borderRadius: 999,
        border: "1px solid #ddd",
        background: tab === id ? "#111" : "#fff",
        color: tab === id ? "#fff" : "#111",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <Item id="today" label="Today" />
      <Item id="tasks" label="Tasks" />
      <Item id="import" label="Import" />
      <Item id="backup" label="Backup" />
    </div>
  );
}

/* ---------- App ---------- */

export default function App() {
  const [tab, setTab] = useState("today");

  const [state, setState] = useState(() => {
    const loaded = loadState();

    // Upgrade older saved data
    if (loaded?.tasks?.length) {
      if (!("todayPlan" in loaded)) loaded.todayPlan = null;
      return loaded;
    }

    const seed = {
      tasks: defaultTasksFromSample(),
      todayPlan: null, // { dateISO, pickedIds: string[], completedIds: string[] }
    };
    saveState(seed);
    return seed;
  });

  const [budgetMin, setBudgetMin] = useState(60);
  const nowISO = todayISO();

  // Persist app state
  useEffect(() => {
    saveState(state);
  }, [state]);

  // Create today's plan if needed (once/day)
  useEffect(() => {
    if (!state.todayPlan || state.todayPlan.dateISO !== nowISO) {
      ensureTodayPlan(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowISO]);

  // Create/replace today's plan
  function ensureTodayPlan(forceRegenerate = false) {
    setState((prev) => {
      const existing = prev.todayPlan;
      const isForToday = existing?.dateISO === nowISO;

      if (!forceRegenerate && isForToday) return prev;

      const plan = buildPlan(prev.tasks, nowISO, budgetMin);

      return {
        ...prev,
        todayPlan: {
          dateISO: nowISO,
          pickedIds: plan.pickedIds,
          completedIds: [],
        },
      };
    });
  }

  // Today's tasks are from todayPlan, minus completedIds
  const plannedTasks = useMemo(() => {
    const pickedIds = state.todayPlan?.pickedIds ?? [];
    const completed = new Set(state.todayPlan?.completedIds ?? []);
    const map = new Map(state.tasks.map((t) => [t.id, t]));

    return pickedIds
      .filter((id) => !completed.has(id))
      .map((id) => map.get(id))
      .filter(Boolean);
  }, [state.tasks, state.todayPlan]);

  const totalEstRemaining = plannedTasks.reduce((sum, t) => sum + Math.max(1, t.estMin || 15), 0);

  /* ---- Done modal ---- */
  const [doneOpen, setDoneOpen] = useState(false);
  const [doneTaskId, setDoneTaskId] = useState(null);

  // IMPORTANT: string while typing so user can delete freely
  const [actualMin, setActualMin] = useState("15");

  /* ---- Add/Edit modal ---- */
  const [editOpen, setEditOpen] = useState(false);
  const [editTaskId, setEditTaskId] = useState(null);

  /* ---- Import box ---- */
  const [importText, setImportText] = useState("");

  function openDone(task) {
    setDoneTaskId(task.id);
    setActualMin(String(Math.max(1, task.estMin || 15)));
    setDoneOpen(true);
  }

  function confirmDone() {
    const id = doneTaskId;
    if (!id) return;

    const actual = clampInt(actualMin, 1, 240);

    setState((prev) => {
      const tasks = prev.tasks.map((t) => {
        if (t.id !== id) return t;

        const newEst = ewmaUpdate(t.estMin, actual, 0.3);
        const newHist = Array.isArray(t.history) ? [...t.history] : [];
        newHist.unshift({ dateISO: nowISO, actualMin: actual });
        const trimmed = newHist.slice(0, 20);

        return {
          ...t,
          lastDoneISO: nowISO,
          estMin: newEst,
          history: trimmed,
        };
      });

      const tp = prev.todayPlan;
      if (!tp || tp.dateISO !== nowISO) {
        return { ...prev, tasks };
      }

      const completedSet = new Set(tp.completedIds || []);
      completedSet.add(id);

      return {
        ...prev,
        tasks,
        todayPlan: {
          ...tp,
          completedIds: Array.from(completedSet),
        },
      };
    });

    setDoneOpen(false);
    setDoneTaskId(null);
  }

  function openEdit(taskId) {
    setEditTaskId(taskId);
    setEditOpen(true);
  }

  function upsertTask(updated) {
    setState((prev) => {
      const exists = prev.tasks.some((t) => t.id === updated.id);
      const tasks = exists ? prev.tasks.map((t) => (t.id === updated.id ? updated : t)) : [...prev.tasks, updated];

      // If you edit tasks, we keep today's plan as-is (locked).
      // You can regenerate manually if you want the changes reflected immediately.
      return { ...prev, tasks };
    });
  }

  function deleteTask(id) {
    setState((prev) => {
      const tasks = prev.tasks.filter((t) => t.id !== id);

      // Also remove it from today's plan if it exists there
      const tp = prev.todayPlan;
      const todayPlan = tp
        ? {
            ...tp,
            pickedIds: (tp.pickedIds || []).filter((x) => x !== id),
            completedIds: (tp.completedIds || []).filter((x) => x !== id),
          }
        : null;

      return { ...prev, tasks, todayPlan };
    });
  }

  function importTasksReplaceList() {
    const parsed = parsePaste(importText);
    if (parsed.length === 0) {
      alert("No valid rows found. Each row needs 4 columns: name, frequency(days), last done (M/D/YYYY), minutes.");
      return;
    }
    setState((prev) => ({
      ...prev,
      tasks: parsed,
      todayPlan: null, // force new plan
    }));
    setImportText("");
    setTab("today");
  }

  function backupNow() {
    const payload = {
      version: 2,
      exportedAtISO: new Date().toISOString(),
      state,
    };
    downloadText(`housework-backup-${nowISO}.json`, JSON.stringify(payload, null, 2));
  }

  async function restoreFromFile(file) {
    try {
      const txt = await readFileText(file);
      const parsed = JSON.parse(txt);

      // Support v1 backups that had {tasks: [...]}
      if (parsed?.tasks && Array.isArray(parsed.tasks)) {
        setState({ tasks: parsed.tasks, todayPlan: null });
        setTab("today");
        return;
      }

      // v2 backups store { state: {tasks, todayPlan} }
      if (parsed?.state?.tasks && Array.isArray(parsed.state.tasks)) {
        const st = parsed.state;
        if (!("todayPlan" in st)) st.todayPlan = null;
        setState({ tasks: st.tasks, todayPlan: st.todayPlan ?? null });
        setTab("today");
        return;
      }

      throw new Error("Invalid backup format.");
    } catch (e) {
      alert(`Restore failed: ${e.message || String(e)}`);
    }
  }

  const editTask = useMemo(() => {
    if (!editTaskId) return null;
    return state.tasks.find((t) => t.id === editTaskId) || null;
  }, [editTaskId, state.tasks]);

  const todayHasPlan = (state.todayPlan?.dateISO === nowISO) && (state.todayPlan?.pickedIds?.length ?? 0) > 0;

  return (
    <div style={{ padding: 16, maxWidth: 920, margin: "0 auto" }}>
      <h1 style={{ margin: "6px 0 12px" }}>Housework Queue</h1>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <Tabs tab={tab} setTab={setTab} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#444" }}>Daily budget</span>
          <NumberInput
            value={budgetMin}
            min={10}
            max={240}
            onChange={(e) => setBudgetMin(clampInt(e.target.value, 10, 240))}
            style={{ width: 110 }}
          />
          <span style={{ fontSize: 12, color: "#444" }}>minutes</span>
        </div>
      </div>

      <div style={{ height: 14 }} />

      {tab === "today" && (
        <div style={{ display: "grid", gap: 12 }}>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 14, color: "#444" }}>Today ({nowISO})</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>
                  {totalEstRemaining} / {budgetMin} min remaining (estimated)
                </div>
                <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                  Today’s list is locked. Completing tasks won’t pull in replacements.
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                <SmallButton kind="primary" onClick={() => openEdit(null)}>
                  + Add Task
                </SmallButton>
                <SmallButton onClick={() => setTab("import")}>Import</SmallButton>
                <SmallButton onClick={() => ensureTodayPlan(true)} title="Generate a new list for today (optional)">
                  Regenerate
                </SmallButton>
              </div>
            </div>
          </Card>

          {!todayHasPlan ? (
            <Card>
              <div style={{ fontSize: 14 }}>
                No plan for today yet.
              </div>
              <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <SmallButton kind="primary" onClick={() => ensureTodayPlan(true)}>
                  Generate Today’s List
                </SmallButton>
                <SmallButton onClick={() => setTab("import")}>Import tasks</SmallButton>
              </div>
            </Card>
          ) : plannedTasks.length === 0 ? (
            <Card>
              <div style={{ fontSize: 18, fontWeight: 650 }}>All done for today ✅</div>
              <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
                Come back tomorrow for a new set — or press Regenerate if you want more.
              </div>
            </Card>
          ) : (
            plannedTasks.map((t) => (
              <Card key={t.id}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 260 }}>
                    <div style={{ fontSize: 18, fontWeight: 650 }}>{t.name}</div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                      <span style={{ fontSize: 12, color: "#555" }}>{formatOverdueLabel(t, nowISO)}</span>
                      <span style={{ fontSize: 12, color: "#555" }}>Every {t.freqDays}d</span>
                      <span style={{ fontSize: 12, color: "#555" }}>Est {Math.max(1, t.estMin || 15)} min</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <SmallButton kind="primary" onClick={() => openDone(t)}>
                      Done
                    </SmallButton>
                    <SmallButton onClick={() => openEdit(t.id)}>Edit</SmallButton>
                  </div>
                </div>
              </Card>
            ))
          )}
        </div>
      )}

      {tab === "tasks" && (
        <div style={{ display: "grid", gap: 12 }}>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>All Tasks</div>
                <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                  Edit frequency (days), last done date, or time estimate.
                </div>
              </div>
              <SmallButton kind="primary" onClick={() => openEdit(null)}>
                + Add Task
              </SmallButton>
            </div>
          </Card>

          {state.tasks
            .slice()
            .sort((a, b) => {
              const ao = isOverdue(a, nowISO);
              const bo = isOverdue(b, nowISO);
              if (ao !== bo) return ao ? -1 : 1;
              const as = urgencyScore(a, nowISO);
              const bs = urgencyScore(b, nowISO);
              if (bs !== as) return bs - as;
              return a.name.localeCompare(b.name);
            })
            .map((t) => (
              <Card key={t.id}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 260 }}>
                    <div style={{ fontSize: 16, fontWeight: 650 }}>{t.name}</div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6 }}>
                      <span style={{ fontSize: 12, color: "#555" }}>{formatOverdueLabel(t, nowISO)}</span>
                      <span style={{ fontSize: 12, color: "#555" }}>Every {t.freqDays}d</span>
                      <span style={{ fontSize: 12, color: "#555" }}>Last {t.lastDoneISO}</span>
                      <span style={{ fontSize: 12, color: "#555" }}>Est {Math.max(1, t.estMin || 15)} min</span>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <SmallButton kind="primary" onClick={() => openDone(t)}>
                      Done
                    </SmallButton>
                    <SmallButton onClick={() => openEdit(t.id)}>Edit</SmallButton>
                  </div>
                </div>
              </Card>
            ))}
        </div>
      )}

      {tab === "import" && (
        <div style={{ display: "grid", gap: 12 }}>
          <Card>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Import from your spreadsheet</div>
            <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
              Paste rows as tab-separated (best) or comma-separated:
              <div style={{ marginTop: 6, padding: 10, background: "#f6f6f6", borderRadius: 10, border: "1px solid #eee" }}>
                Swiffer front hallway [tab] 4 [tab] 8/26/2025 [tab] 15
              </div>
              Dates can be M/D/YYYY or YYYY-MM-DD.
              <b>Import will replace your current task list.</b>
            </div>

            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={12}
              style={{
                width: "100%",
                marginTop: 12,
                padding: 10,
                borderRadius: 12,
                border: "1px solid #ddd",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              }}
              placeholder="Paste your rows here…"
            />

            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <SmallButton kind="primary" onClick={importTasksReplaceList}>
                Import (Replace list)
              </SmallButton>
              <SmallButton onClick={() => setImportText("")}>Clear</SmallButton>
              <SmallButton onClick={() => setTab("today")}>Back to Today</SmallButton>
            </div>
          </Card>
        </div>
      )}

      {tab === "backup" && (
        <div style={{ display: "grid", gap: 12 }}>
          <Card>
            <div style={{ fontSize: 18, fontWeight: 700 }}>Backup & Restore</div>
            <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
              Data is stored locally on your device. Use backup to prevent loss.
            </div>

            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <SmallButton kind="primary" onClick={backupNow}>
                Backup (Download JSON)
              </SmallButton>

              <label style={{ display: "inline-block" }}>
                <input
                  type="file"
                  accept="application/json"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) restoreFromFile(f);
                    e.target.value = "";
                  }}
                />
                <span
                  role="button"
                  style={{
                    display: "inline-block",
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    background: "#f3f3f3",
                    cursor: "pointer",
                  }}
                >
                  Restore (Choose JSON)
                </span>
              </label>

              <SmallButton
                kind="danger"
                onClick={() => {
                  if (confirm("Reset app data? This cannot be undone (unless you have a backup).")) {
                    setState({ tasks: [], todayPlan: null });
                  }
                }}
              >
                Reset (Clear all)
              </SmallButton>
            </div>
          </Card>
        </div>
      )}

      {/* DONE MODAL */}
      <Modal
        open={doneOpen}
        title="Mark done"
        onClose={() => {
          setDoneOpen(false);
          setDoneTaskId(null);
        }}
      >
        {(() => {
          const t = state.tasks.find((x) => x.id === doneTaskId);
          if (!t) return <div>Task not found.</div>;
          return (
            <div style={{ display: "grid", gap: 12 }}>
              <div style={{ fontWeight: 650 }}>{t.name}</div>
              <div style={{ fontSize: 12, color: "#666" }}>
                Current estimate: {Math.max(1, t.estMin || 15)} min. This will update based on what you enter.
              </div>

              <Field label="How many minutes did it actually take?">
                <NumberInput
                  value={actualMin}
                  min={1}
                  max={240}
                  onChange={(e) => setActualMin(e.target.value)}
                />
              </Field>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <SmallButton kind="primary" onClick={confirmDone}>
                  Confirm Done
                </SmallButton>
                <SmallButton onClick={() => setDoneOpen(false)}>Cancel</SmallButton>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* EDIT/ADD MODAL */}
      <Modal
        open={editOpen}
        title={editTaskId ? "Edit Task" : "Add Task"}
        onClose={() => {
          setEditOpen(false);
          setEditTaskId(null);
        }}
      >
        <TaskEditor
          nowISO={nowISO}
          task={editTaskId ? editTask : null}
          onSave={(t) => {
            upsertTask(t);
            setEditOpen(false);
            setEditTaskId(null);
          }}
          onDelete={(id) => {
            if (confirm("Delete this task?")) {
              deleteTask(id);
              setEditOpen(false);
              setEditTaskId(null);
            }
          }}
        />
      </Modal>

      <div style={{ height: 20 }} />
      <div style={{ fontSize: 12, color: "#777" }}>
        Tip: On iPhone (Safari) → Share → “Add to Home Screen”.
      </div>
    </div>
  );
}

function TaskEditor({ task, onSave, onDelete, nowISO }) {
  const isEdit = !!task;

  const [name, setName] = useState(task?.name || "");
  const [freqDays, setFreqDays] = useState(task?.freqDays ?? 7);
  const [lastDoneISO, setLastDoneISO] = useState(task?.lastDoneISO || nowISO);
  const [estMin, setEstMin] = useState(task?.estMin ?? 15);

  useEffect(() => {
    if (!task) return;
    setName(task.name || "");
    setFreqDays(task.freqDays ?? 7);
    setLastDoneISO(task.lastDoneISO || nowISO);
    setEstMin(task.estMin ?? 15);
  }, [task, nowISO]);

  const dueISO = useMemo(
    () => addDaysISO(parseUSDateToISO(lastDoneISO) || lastDoneISO, Math.max(1, Number(freqDays) || 1)),
    [lastDoneISO, freqDays]
  );

  function save() {
    const n = name.trim();
    if (!n) return alert("Please enter a task name.");

    const f = clampInt(freqDays, 1, 3650);

    const lRaw = String(lastDoneISO ?? "").trim();
    const l = parseUSDateToISO(lRaw) || lRaw;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l)) return alert("Last done date must be YYYY-MM-DD or M/D/YYYY.");

    const e = clampInt(estMin, 1, 240);

    const out = {
      id: task?.id || uid(),
      name: n,
      freqDays: f,
      lastDoneISO: l,
      estMin: e,
      history: task?.history || [],
    };
    onSave(out);
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Field label="Task name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Swiffer kitchen/pantry" />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Frequency (days)">
          <NumberInput value={freqDays} min={1} max={3650} onChange={(e) => setFreqDays(e.target.value)} />
        </Field>
        <Field label="Estimated minutes">
          <NumberInput value={estMin} min={1} max={240} onChange={(e) => setEstMin(e.target.value)} />
        </Field>
      </div>

      <Field label="Last done date (YYYY-MM-DD or M/D/YYYY)">
        <TextInput value={lastDoneISO} onChange={(e) => setLastDoneISO(e.target.value)} />
      </Field>

      <div style={{ fontSize: 12, color: "#666" }}>
        Next due: <b>{dueISO}</b>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <SmallButton kind="primary" onClick={save}>
          Save
        </SmallButton>
        {isEdit && (
          <SmallButton kind="danger" onClick={() => onDelete(task.id)}>
            Delete
          </SmallButton>
        )}
      </div>
    </div>
  );
}