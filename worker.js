/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---------- Serve dashboard ----------
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(DASHBOARD_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
        },
      });
    }

    // ---------- Seed mock feedback ----------
    if (request.method === "POST" && url.pathname === "/api/seed") {
      const now = new Date().toISOString();
      const items = [
        { source: "support", text: "Workers deployment fails with a cryptic error. I can’t launch my app." },
        { source: "twitter", text: "Billing is confusing — I got charged twice and there’s no clear invoice view." },
        { source: "github", text: "Docs for D1 migrations don’t explain local vs remote clearly." },
        { source: "discord", text: "DNS changes are taking forever to propagate for my domain." },
      ];

      for (const it of items) {
        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO feedback (id, source, text, created_at) VALUES (?, ?, ?, ?)"
        ).bind(id, it.source, it.text, now).run();
      }

      return json({ ok: true });
    }

    // ---------- Clear all feedback (demo helper) ----------
    if (request.method === "POST" && url.pathname === "/api/clear") {
      await env.DB.prepare("DELETE FROM triage").run();
      await env.DB.prepare("DELETE FROM feedback").run();
      return json({ ok: true });
    }

    // ---------- List feedback ----------
    if (request.method === "GET" && url.pathname === "/api/feedback") {
      const rows = await env.DB.prepare(
        "SELECT * FROM feedback ORDER BY created_at DESC"
      ).all();
      return json(rows.results || []);
    }

    // ---------- Get detail ----------
    if (request.method === "GET" && url.pathname === "/api/detail") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);

      const feedback = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?").bind(id).first();
      if (!feedback) return json({ error: "not_found" }, 404);

      const triage = await env.DB.prepare("SELECT * FROM triage WHERE feedback_id = ?").bind(id).first();
      return json({ feedback, triage: triage || null });
    }

    // ---------- Run AI triage ----------
    if (request.method === "POST" && url.pathname === "/api/triage") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);

      const feedback = await env.DB.prepare("SELECT * FROM feedback WHERE id = ?").bind(id).first();
      if (!feedback) return json({ error: "not_found" }, 404);

      const triage = await runTriage(env, feedback.text);

      await env.DB.prepare(
        "UPDATE feedback SET product_area = ?, severity = ?, sentiment = ?, status = 'triaged' WHERE id = ?"
      ).bind(triage.product_area, triage.severity, triage.sentiment, id).run();

      await env.DB.prepare(
        "INSERT INTO triage (feedback_id, ai_reason, draft_reply, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(feedback_id) DO UPDATE SET ai_reason=excluded.ai_reason, draft_reply=excluded.draft_reply, updated_at=excluded.updated_at"
      ).bind(id, triage.ai_reason, triage.draft_reply, new Date().toISOString()).run();

      return json({ ok: true, triage });
    }

    // ---------- Update engagement/status ----------
    if (request.method === "POST" && url.pathname === "/api/status") {
      const id = url.searchParams.get("id");
      const status = url.searchParams.get("status");
      if (!id || !status) return json({ error: "missing_params" }, 400);

      // minimal allowlist
      const allowed = new Set(["new", "triaged", "acknowledged", "watching", "assigned", "escalated", "resolved"]);
      if (!allowed.has(status)) return json({ error: "invalid_status" }, 400);

      await env.DB.prepare(
        "UPDATE feedback SET status = ?, engaged_at = ? WHERE id = ?"
      ).bind(status, new Date().toISOString(), id).run();

      return json({ ok: true });
    }

        // ---------- Escalate ----------
    if (request.method === "POST" && url.pathname === "/api/escalate") {
      const id = url.searchParams.get("id");
      const to = url.searchParams.get("to") || "Unknown";
      if (!id) return json({ error: "missing_id" }, 400);

      await env.DB.prepare(
        "UPDATE feedback SET status = 'escalated', escalated_to = ?, escalated_at = ? WHERE id = ?"
      ).bind(to, new Date().toISOString(), id).run();

      return json({ ok: true });
    }

// ---------- Confirm resolved ----------
    if (request.method === "POST" && url.pathname === "/api/resolve") {
      const id = url.searchParams.get("id");
      if (!id) return json({ error: "missing_id" }, 400);

      await env.DB.prepare(
        "UPDATE feedback SET status = 'resolved', resolved_at = ? WHERE id = ?"
      ).bind(new Date().toISOString(), id).run();

      return json({ ok: true });
    }




    return json({ error: "not_found" }, 404);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const PRODUCT_AREAS = ["Auth", "Billing", "DNS", "Workers", "R2", "WAF", "Performance", "Docs", "Other"];

const SEVERITY_RUBRIC = `Use:
P0: outage/data loss/security, many users blocked
P1: core feature broken, limited workaround
P2: degraded experience, workaround exists
P3: minor bug or suggestion`;

async function runTriage(env, text) {
  const prompt = `
${SEVERITY_RUBRIC}

Classify this feedback into:
- product_area: one of ${PRODUCT_AREAS.join(", ")}
- severity: P0/P1/P2/P3
- sentiment: positive/neutral/negative
- ai_reason: <= 20 words explaining why
- draft_reply: concise helpful support reply (2-4 sentences)

Return ONLY valid JSON with keys:
product_area, severity, sentiment, ai_reason, draft_reply.

Feedback:
"""${text}"""`;

  // If this model name errors, swap to another available in Workers AI catalog.
  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    prompt,
    max_tokens: 450,
  });

  const out = typeof result === "string" ? result : (result.response ?? JSON.stringify(result));
  return JSON.parse(out);
}

const DASHBOARD_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Feedback Triage Dashboard</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; }
    .row { display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #eee; padding: 10px; vertical-align: top; }
    th { text-align: left; font-weight: 600; }
    .pill { display: inline-block; padding: 4px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; border: 1px solid #ddd; }
    button { padding: 8px 12px; cursor: pointer; }
    textarea { width: 100%; min-height: 140px; }
    .muted { color: #666; font-size: 12px; }
    .sev-P0 { background: #fee2e2; color: #991b1b; border-color: #fecaca; }
    .sev-P1 { background: #ffedd5; color: #9a3412; border-color: #fed7aa; }
    .sev-P2 { background: #fef9c3; color: #854d0e; border-color: #fde68a; }
    .sev-P3 { background: #ecfeff; color: #155e75; border-color: #cffafe; }
    select { padding: 8px; }
  </style>
</head>
<body>
  <h1>Feedback Triage Dashboard</h1>
  <p class="muted">Seed mock feedback → click row → run AI triage → draft reply.</p>

  <div style="margin: 12px 0; display:flex; gap: 10px; align-items:center;">
    <button id="seedBtn" type="button">Seed mock feedback</button>
    <button id="refreshBtn" type="button">Refresh</button>
    <button id="clearBtn" type="button">Clear</button>

    <select id="severityFilter">
      <option value="">All Severities</option>
      <option value="P0">P0</option>
      <option value="P1">P1</option>
      <option value="P2">P2</option>
      <option value="P3">P3</option>
    </select>

    <select id="areaFilter">
      <option value="">All Product Areas</option>
      <option value="Auth">Auth</option>
      <option value="Billing">Billing</option>
      <option value="DNS">DNS</option>
      <option value="Workers">Workers</option>
      <option value="Docs">Docs</option>
      <option value="Other">Other</option>
    </select>
  </div>

  <div id="debug" class="muted" style="margin: 10px 0;"></div>

  <div class="row">
    <div>
      <table id="tbl">
        <thead>
          <tr>
            <th>Incident</th>
            <th>Area</th>
            <th>Severity</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>

    <div>
      <h3>Selected item</h3>
      <div id="brief" class="muted" style="margin-bottom:10px;"></div>
      <div id="detail" class="muted">Click a row to view details.</div>
    </div>
  </div>

<script>
(function () {
  let ALL_ITEMS = [];

  function setDebug(msg) {
    const el = document.getElementById('debug');
    if (el) el.textContent = msg;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function seed() {
    setDebug('Seeding…');
    const r = await fetch('/api/seed', { method: 'POST', cache: 'no-store' });
    const t = await r.text();
    setDebug('Seed response: ' + t);
    await load();
  }

  async function load() {
    setDebug('Loading /api/feedback…');
    const res = await fetch('/api/feedback', { cache: 'no-store' });
    ALL_ITEMS = await res.json();
    setDebug('Loaded ' + ALL_ITEMS.length + ' items.');

    // apply current filters after reload
    applyFilters();
  }

  function renderTable(items) {
    const tbody = document.getElementById('tbody');
    if (!tbody) { setDebug('ERROR: tbody not found'); return; }

    tbody.innerHTML = '';
    for (const it of items) {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => show(it.id));

      tr.innerHTML =
        '<td>' + escapeHtml(it.text).slice(0, 120) + (it.text.length > 120 ? '…' : '') + '</td>' +
        '<td><span class="pill">' + (it.product_area || '-') + '</span></td>' +
        '<td><span class="pill ' + (it.severity ? ('sev-' + it.severity) : '') + '">' + (it.severity || '-') + '</span></td>' +
        '<td>' + (it.status || '-') + '</td>';

      tbody.appendChild(tr);
    }
  }

  function applyFilters() {
    const sevEl = document.getElementById('severityFilter');
    const areaEl = document.getElementById('areaFilter');
    const sev = sevEl ? sevEl.value : '';
    const area = areaEl ? areaEl.value : '';

    const filtered = ALL_ITEMS.filter(it => {
      if (sev && it.severity !== sev) return false;
      if (area && it.product_area !== area) return false;
      return true;
    });

    renderTable(filtered);
  }
 
  function fmtTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }
  
  function severityRank(sev) {
    return ({ P0: 0, P1: 1, P2: 2, P3: 3 }[sev] ?? 99);
  }
  
  // Finds similar incidents from ALL_ITEMS (same product_area if known; otherwise same source as fallback)
  function getSimilarIncidents(current, limit = 3) {
    const sameArea = current.product_area
      ? ALL_ITEMS.filter(x => x.id !== current.id && x.product_area === current.product_area)
      : [];
  
    const pool = sameArea.length > 0
      ? sameArea
      : ALL_ITEMS.filter(x => x.id !== current.id && x.source === current.source);
  
    return pool
      .slice()
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, limit);
  }
  
  function buildIncidentBrief(fb) {
    const sev = fb.severity || 'Untriaged';
    const area = fb.product_area || 'Unknown area';
    const firstSeen = fmtTime(fb.created_at);
    const sentiment = fb.sentiment || '-';
  
    // deterministic “why surfaced”
    const reasons = [];
    if (fb.severity && severityRank(fb.severity) <= 1) reasons.push('High severity (' + fb.severity + ')');
    if (fb.sentiment === 'negative') reasons.push('Negative sentiment');
    if (fb.status === 'new') reasons.push('Not yet triaged');
    if (reasons.length === 0) reasons.push('Operational review');
  
    // suggested owner (simple rule-based demo)
    const owner =
      fb.product_area === 'Workers' ? 'Workers SRE' :
      fb.product_area === 'DNS' ? 'DNS / Networking On-call' :
      fb.product_area === 'Billing' ? 'Billing Support / FinOps' :
      fb.product_area === 'Docs' ? 'Docs / DX' :
      'Triage Queue';
  
    const similar = getSimilarIncidents(fb, 3);
  
    return {
      sev,
      area,
      firstSeen,
      sentiment,
      reasons,
      owner,
      similar
    };
  }
  
  function renderIncidentBrief(fb) {
    const briefEl = document.getElementById('brief');
    if (!briefEl) return;
  
    const brief = buildIncidentBrief(fb);
  
    const similarHtml = brief.similar.length
      ? ('<ul style="margin:6px 0 0 18px;">' + brief.similar.map(s =>
          '<li>' +
            escapeHtml(fmtTime(s.created_at)) +
            ' — ' + escapeHtml((s.text || '').slice(0, 70)) + ((s.text || '').length > 70 ? '…' : '') +
            ' <span class="pill" style="margin-left:6px;">' + escapeHtml(s.status || '-') + '</span>' +
          '</li>'
        ).join('') + '</ul>')
      : '<div class="muted">No similar incidents found yet.</div>';
  
    briefEl.innerHTML =
      '<div style="border:1px solid #eee; border-radius:12px; padding:12px;">' +
        '<div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">' +
          '<span class="pill ' + (fb.severity ? ('sev-' + fb.severity) : '') + '"><b>Severity:</b> ' + escapeHtml(brief.sev) + '</span>' +
          '<span class="pill"><b>Area:</b> ' + escapeHtml(brief.area) + '</span>' +
          '<span class="pill"><b>Status:</b> ' + escapeHtml(fb.status || '-') + '</span>' +
          '<span class="pill"><b>First seen:</b> ' + escapeHtml(brief.firstSeen) + '</span>' +
        '</div>' +
        '<div style="margin-top:10px;"><b>Why this surfaced:</b> ' + escapeHtml(brief.reasons.join(' • ')) + '</div>' +
        '<div style="margin-top:6px;"><b>Suggested owner:</b> ' + escapeHtml(brief.owner) + '</div>' +
        '<div style="margin-top:10px;"><b>Similar past incidents:</b>' + similarHtml + '</div>' +
      '</div>';
  }
  
  function suggestOwner(area) {
    return area === 'Workers' ? 'Workers SRE'
      : area === 'DNS' ? 'DNS / Networking On-call'
      : area === 'Billing' ? 'Billing Support / FinOps'
      : area === 'Docs' ? 'Docs / DX'
      : 'Triage Queue';
  }
  
  async function setStatus(id, status) {
    setDebug('Setting status: ' + status + '…');
    await fetch('/api/status?id=' + encodeURIComponent(id) + '&status=' + encodeURIComponent(status), {
      method: 'POST',
      cache: 'no-store'
    });
    await show(id);
    await load();
    setDebug('Status updated.');
  }
  
  async function escalate(id, to) {
    setDebug('Escalating to ' + to + '…');
    await fetch('/api/escalate?id=' + encodeURIComponent(id) + '&to=' + encodeURIComponent(to), {
      method: 'POST',
      cache: 'no-store'
    });
    await show(id);
    await load();
    setDebug('Escalated.');
  }
  
  async function resolve(id) {
    setDebug('Confirming resolved…');
    await fetch('/api/resolve?id=' + encodeURIComponent(id), {
      method: 'POST',
      cache: 'no-store'
    });
    await show(id);
    await load();
    setDebug('Marked resolved.');
  }
  
  // Historical logs button: filter table to similar incidents
  function viewHistoryFor(fb) {
    const areaEl = document.getElementById('areaFilter');
    const sevEl = document.getElementById('severityFilter');
  
    if (areaEl) areaEl.value = fb.product_area || '';
    if (sevEl) sevEl.value = fb.severity || '';
  
    applyFilters();
  
    // scroll table into view
    const tbl = document.getElementById('tbl');
    if (tbl) tbl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  
    setDebug('Showing history for area=' + (fb.product_area || '-') + ' severity=' + (fb.severity || '-') );
  }
  

  async function show(id) {
    setDebug('Loading detail…');
    const res = await fetch('/api/detail?id=' + encodeURIComponent(id), { cache: 'no-store' });
    const data = await res.json();
    const fb = data.feedback;
    const tr = data.triage;

    renderIncidentBrief(fb);


    const detail = document.getElementById('detail');
    if (!detail) return;

    const owner = suggestOwner(fb.product_area || '');

    detail.innerHTML =
  '<div><b>Source:</b> ' + escapeHtml(fb.source) + '</div>' +
  '<div style="margin:8px 0;"><b>Text:</b><br/>' + escapeHtml(fb.text) + '</div>' +

  '<div style="margin:10px 0; display:flex; gap:8px; flex-wrap:wrap;">' +
    '<button id="ackBtn" type="button">Acknowledge</button>' +
    '<button id="watchBtn" type="button">Watch</button>' +
    '<button id="assignBtn" type="button">Assign</button>' +
    '<button id="escalateBtn" type="button">Escalate</button>' +
    '<button id="resolveBtn" type="button">Confirm resolved</button>' +
    '<button id="historyBtn" type="button">History</button>' +
  '</div>' +

  '<div style="margin: 10px 0;">' +
    '<button id="triageBtn" type="button">Analyze impact</button>' +
  '</div>' +
  '<hr/>' +
  '<div><b>Product area:</b> ' + escapeHtml(fb.product_area || '-') + '</div>' +
  '<div><b>Severity:</b> ' + escapeHtml(fb.severity || '-') + '</div>' +
  '<div><b>Sentiment:</b> ' + escapeHtml(fb.sentiment || '-') + '</div>' +
  '<div><b>Status:</b> ' + escapeHtml(fb.status || '-') + '</div>' +
  '<div><b>Escalated to:</b> ' + escapeHtml(fb.escalated_to || '-') + '</div>' +
  '<div><b>Resolved at:</b> ' + escapeHtml(fb.resolved_at || '-') + '</div>' +
  '<div style="margin-top:8px;"><b>Reason:</b> ' + (tr ? escapeHtml(tr.ai_reason || '-') : '-') + '</div>' +
  '<div style="margin-top:8px;"><b>Draft reply:</b></div>' +
  '<textarea readonly>' + (tr ? (tr.draft_reply || '') : '') + '</textarea>';

  const idVal = fb.id;

document.getElementById('triageBtn')?.addEventListener('click', () => triage(idVal));
document.getElementById('ackBtn')?.addEventListener('click', () => setStatus(idVal, 'acknowledged'));
document.getElementById('watchBtn')?.addEventListener('click', () => setStatus(idVal, 'watching'));
document.getElementById('assignBtn')?.addEventListener('click', () => setStatus(idVal, 'assigned'));
document.getElementById('escalateBtn')?.addEventListener('click', () => escalate(idVal, owner));
document.getElementById('resolveBtn')?.addEventListener('click', () => resolve(idVal));
document.getElementById('historyBtn')?.addEventListener('click', () => viewHistoryFor(fb));

    const btn = document.getElementById('triageBtn');
    if (btn) btn.addEventListener('click', () => triage(id));
    setDebug('Detail loaded.');
  }

  async function triage(id) {
    setDebug('Triaging…');
    const res = await fetch('/api/triage?id=' + encodeURIComponent(id), { method: 'POST', cache: 'no-store' });
    const t = await res.text();
    setDebug('Triage response: ' + t);
    await show(id);
    await load();
  }

  // Wire up UI AFTER DOM is ready
  async function clearAll() {
    setDebug('Clearing all feedback…');
    await fetch('/api/clear', { method: 'POST', cache: 'no-store' });
    await load();
    setDebug('All feedback cleared.');
  }
  
  document.addEventListener('DOMContentLoaded', () => {
    const seedBtn = document.getElementById('seedBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const clearBtn = document.getElementById('clearBtn');
    const sevEl = document.getElementById('severityFilter');
    const areaEl = document.getElementById('areaFilter');

    if (seedBtn) seedBtn.addEventListener('click', seed);
    if (refreshBtn) refreshBtn.addEventListener('click', load);
    if (clearBtn) clearBtn.addEventListener('click', clearAll);
    if (sevEl) sevEl.addEventListener('change', applyFilters);
    if (areaEl) areaEl.addEventListener('change', applyFilters);

    load();
  });
})();
</script>
</body>
</html>`;

