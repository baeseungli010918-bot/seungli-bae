// ===================================================================
// XAM Lab — 관리자 페이지 스크립트
// ===================================================================
const API = window.location.origin;
let adminPin = null;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ------------------------------------------------ 테마 (app.js와 동일 로직)
const THEME_ICON = { system: '🖥️', dark: '🌙', light: '☀️' };
const THEME_LABEL = { system: 'System theme', dark: 'Dark theme', light: 'Light theme' };

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  const icon = THEME_ICON[mode];
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = icon;
  const sideIcon = document.getElementById('themeIcon');
  if (sideIcon) sideIcon.textContent = icon;
  const sideLabel = document.getElementById('themeLabel');
  if (sideLabel) sideLabel.textContent = THEME_LABEL[mode];
}
function cycleTheme() {
  let mode = 'system';
  try { mode = localStorage.getItem('xam-theme') || 'system'; } catch (e) {}
  const order = ['system', 'dark', 'light'];
  mode = order[(order.indexOf(mode) + 1) % order.length];
  try { localStorage.setItem('xam-theme', mode); } catch (e) {}
  applyTheme(mode);
}
(function initTheme() {
  let mode = 'system';
  try { mode = localStorage.getItem('xam-theme') || 'system'; } catch (e) {}
  applyTheme(mode);
})();

// ------------------------------------------------ 인증
async function verifyPin() {
  const pin = document.getElementById('pinInput').value;
  try {
    const res = await fetch(API + '/api/admin/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_pin: pin }),
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'PIN이 올바르지 않습니다');
    adminPin = pin;
    try { sessionStorage.setItem('xam-admin-pin', pin); } catch (e) {}
    enterAdmin();
  } catch (e) {
    document.getElementById('gate-alert').innerHTML = `<div class="alert error">❌ ${esc(e.message)}</div>`;
  }
}

function enterAdmin() {
  document.getElementById('gate').style.display = 'none';
  document.getElementById('adminBody').style.display = 'flex';
  loadEquipmentAdmin();
  loadUsersAdmin();
  loadAnnouncementsAdmin();
}

async function adminApi(path, options) {
  options = options || {};
  options.headers = Object.assign({}, options.headers, { 'X-Admin-Pin': adminPin });
  const res = await fetch(API + path, options);
  const data = await res.json().catch(() => ({}));
  if (res.status === 403) {
    adminPin = null;
    try { sessionStorage.removeItem('xam-admin-pin'); } catch (e) {}
    document.getElementById('gate').style.display = 'flex';
    document.getElementById('adminBody').style.display = 'none';
  }
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

const TAB_META = {
  'tab-equipment': { title: 'Equipment', sub: '장비 추가·삭제, 수량/상태 관리' },
  'tab-users': { title: 'User Roles', sub: '등급별 예약·소모품 한도 관리' },
  'tab-announcements': { title: 'Announcements', sub: '공지사항 작성 및 배포' },
};

function showTab(tabId, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const meta = TAB_META[tabId];
  if (meta) {
    document.getElementById('pageTitle').textContent = meta.title;
    document.getElementById('pageSub').textContent = meta.sub;
  }
}

function showAlert(elId, msg, type) {
  const el = document.getElementById(elId);
  el.innerHTML = `<div class="alert ${type}">${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 6000);
}

// ================================================== 장비 관리
async function loadEquipmentAdmin() {
  try {
    const list = await adminApi('/api/admin/equipment');
    const el = document.getElementById('equipmentAdminList');
    if (!list.length) { el.innerHTML = '<div class="empty">등록된 장비가 없습니다</div>'; return; }

    el.innerHTML = list.map(eq => {
      const usedHours = (eq.total_usage_minutes / 60).toFixed(1);
      const ratio = eq.maintenance_interval_hours > 0 ? (usedHours / eq.maintenance_interval_hours) : 0;
      return `
      <div class="list-item" style="align-items:flex-start;">
        <div class="main">
          <div class="title">${esc(eq.icon)} ${esc(eq.name)} <span class="badge">${esc(eq.id)}</span>
            <span class="status-pill ${eq.status}">${{available:'대기 중', in_use:'사용 중', maintenance:'점검 중'}[eq.status]}</span>
          </div>
          <div class="sub">사용 누적 ${usedHours}h / 점검 주기 ${eq.maintenance_interval_hours}h ${ratio >= 1 ? '<span class="badge danger">점검 필요</span>' : (ratio >= 0.8 ? '<span class="badge warn">곧 점검</span>' : '')}</div>

          <div class="grid-3" style="margin-top:10px;">
            <div class="form-group" style="margin:0;"><label>수량</label>
              <input type="number" min="1" value="${eq.quantity}" onchange="updateEquipment('${eq.id}', {quantity: this.value})"></div>
            <div class="form-group" style="margin:0;"><label>상태</label>
              <select onchange="updateEquipment('${eq.id}', {status: this.value})">
                <option value="available" ${eq.status === 'available' ? 'selected' : ''}>대기 중</option>
                <option value="in_use" ${eq.status === 'in_use' ? 'selected' : ''}>사용 중</option>
                <option value="maintenance" ${eq.status === 'maintenance' ? 'selected' : ''}>점검 중</option>
              </select></div>
            <div class="form-group" style="margin:0;"><label>시간당 비용(원)</label>
              <input type="number" min="0" value="${eq.hourly_cost}" onchange="updateEquipment('${eq.id}', {hourly_cost: this.value})"></div>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-sm btn-ghost" onclick="completeMaintenance('${eq.id}')">✅ 점검 완료</button>
          <button class="btn btn-sm btn-danger" onclick="deleteEquipment('${eq.id}')">삭제</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    showAlert('eq-alert', '❌ ' + esc(e.message), 'error');
  }
}

async function addEquipment() {
  const id = document.getElementById('eqId').value.trim();
  const name = document.getElementById('eqName').value.trim();
  const icon = document.getElementById('eqIcon').value.trim() || '🖨️';
  const quantity = document.getElementById('eqQty').value;
  const hourly_cost = document.getElementById('eqCost').value;
  const maintenance_interval_hours = document.getElementById('eqMaint').value;

  if (!id || !name) return showAlert('eq-alert', '장비 ID와 이름을 입력해주세요', 'error');

  try {
    await adminApi('/api/admin/equipment', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, icon, quantity, hourly_cost, maintenance_interval_hours }),
    });
    showAlert('eq-alert', `✅ ${esc(name)} 추가 완료`, 'success');
    ['eqId', 'eqName'].forEach(x => document.getElementById(x).value = '');
    loadEquipmentAdmin();
  } catch (e) {
    showAlert('eq-alert', '❌ ' + esc(e.message), 'error');
  }
}

async function updateEquipment(id, patch) {
  try {
    await adminApi('/api/admin/equipment/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    loadEquipmentAdmin();
  } catch (e) {
    showAlert('eq-alert', '❌ ' + esc(e.message), 'error');
  }
}

async function deleteEquipment(id) {
  if (!confirm('이 장비를 삭제할까요? 예정된 예약이 있으면 삭제할 수 없습니다.')) return;
  try {
    await adminApi('/api/admin/equipment/' + id, { method: 'DELETE' });
    loadEquipmentAdmin();
  } catch (e) {
    showAlert('eq-alert', '❌ ' + esc(e.message), 'error');
  }
}

async function completeMaintenance(id) {
  const note = prompt('점검 내용을 간단히 남겨주세요 (선택):', '') || '';
  try {
    await adminApi(`/api/admin/equipment/${id}/complete-maintenance`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
    });
    showAlert('eq-alert', '✅ 점검 완료 처리되었습니다 (누적 사용시간 초기화)', 'success');
    loadEquipmentAdmin();
  } catch (e) {
    showAlert('eq-alert', '❌ ' + esc(e.message), 'error');
  }
}

// ================================================== 사용자 등급
const ROLE_LABELS = { admin: '관리자', phd: '박사과정', master: '석사과정', undergrad: '학부생', guest: '손님' };

async function loadUsersAdmin() {
  try {
    const list = await adminApi('/api/admin/users');
    const el = document.getElementById('usersList');
    if (!list.length) { el.innerHTML = '<div class="empty">아직 등록된 사용자가 없습니다</div>'; return; }

    el.innerHTML = list.map(u => `
      <div class="list-item">
        <div class="main">
          <div class="title">👤 ${esc(u.name)}</div>
          <div class="sub">확정 예약 ${u.reservation_count}건</div>
        </div>
        <div class="actions">
          <select onchange="setUserRole('${esc(u.name).replace(/'/g, "\\'")}', this.value)">
            ${Object.entries(ROLE_LABELS).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
      </div>`).join('');
  } catch (e) {
    showAlert('user-alert', '❌ ' + esc(e.message), 'error');
  }
}

async function setUserRole(name, role) {
  try {
    await adminApi('/api/admin/users/' + encodeURIComponent(name), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }),
    });
    showAlert('user-alert', `✅ ${esc(name)}님의 등급을 ${ROLE_LABELS[role]}(으)로 변경했습니다`, 'success');
  } catch (e) {
    showAlert('user-alert', '❌ ' + esc(e.message), 'error');
  }
}

// ================================================== 공지사항
const ANN_TYPE_LABEL = { notice: '일반', maintenance: '점검', rule: '규칙' };

async function loadAnnouncementsAdmin() {
  try {
    const list = await adminApi('/api/announcements');
    const el = document.getElementById('announcementsAdminList');
    if (!list.length) { el.innerHTML = '<div class="empty">공지사항이 없습니다</div>'; return; }

    el.innerHTML = list.map(a => `
      <div class="list-item">
        <div class="main">
          <div class="title">${a.pinned ? '📌 ' : ''}${esc(a.title)} <span class="badge">${ANN_TYPE_LABEL[a.type] || a.type}</span></div>
          <div class="sub">${esc(a.body || '')}</div>
          <div class="hint">${esc(a.created_by || '')} · ${esc(a.created_at || '')}</div>
        </div>
        <div class="actions">
          <button class="btn btn-sm btn-ghost" onclick="togglePin(${a.id}, ${a.pinned ? 0 : 1})">${a.pinned ? '고정 해제' : '상단 고정'}</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAnnouncement(${a.id})">삭제</button>
        </div>
      </div>`).join('');
  } catch (e) {
    showAlert('ann-alert', '❌ ' + esc(e.message), 'error');
  }
}

async function addAnnouncement() {
  const title = document.getElementById('annTitle').value.trim();
  const body = document.getElementById('annBody').value.trim();
  const type = document.getElementById('annType').value;
  const created_by = document.getElementById('annAuthor').value.trim() || '관리자';
  const pinned = document.getElementById('annPinned').value === '1';

  if (!title) return showAlert('ann-alert', '제목을 입력해주세요', 'error');

  try {
    await adminApi('/api/admin/announcements', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body, type, created_by, pinned }),
    });
    showAlert('ann-alert', '✅ 공지사항이 등록되었습니다', 'success');
    document.getElementById('annTitle').value = '';
    document.getElementById('annBody').value = '';
    loadAnnouncementsAdmin();
  } catch (e) {
    showAlert('ann-alert', '❌ ' + esc(e.message), 'error');
  }
}

async function togglePin(id, pinned) {
  try {
    await adminApi('/api/admin/announcements/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }),
    });
    loadAnnouncementsAdmin();
  } catch (e) {
    showAlert('ann-alert', '❌ ' + esc(e.message), 'error');
  }
}

async function deleteAnnouncement(id) {
  if (!confirm('이 공지사항을 삭제할까요?')) return;
  try {
    await adminApi('/api/admin/announcements/' + id, { method: 'DELETE' });
    loadAnnouncementsAdmin();
  } catch (e) {
    showAlert('ann-alert', '❌ ' + esc(e.message), 'error');
  }
}

// ================================================== 초기화 (세션에 저장된 PIN 재사용)
(function initAdmin() {
  let saved = null;
  try { saved = sessionStorage.getItem('xam-admin-pin'); } catch (e) {}
  if (saved) {
    adminPin = saved;
    fetch(API + '/api/admin/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ admin_pin: saved }),
    }).then(r => r.json()).then(d => { if (d.success) enterAdmin(); });
  }
})();
