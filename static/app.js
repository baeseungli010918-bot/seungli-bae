// ===================================================================
// XAM Lab — 메인 페이지 스크립트
// (2025 리디자인: 렌더링/내비게이션만 변경 — API 호출, 검증, 예약 로직은 동일)
// ===================================================================
const API = window.location.origin;

let equipment = [];
let consumables = [];
let reservations = [];
let usageLogs = [];
let roles = {};
let selectedEquipment = null;

const PAGE_META = {
  'dashboard': { title: '대시보드', sub: '실시간 장비 현황과 운영 지표' },
  'reservation': { title: '일정', sub: '장비 예약 및 일정 관리' },
  'equipment': { title: '장비', sub: '보유 장비 현황' },
  'research': { title: '연구 관리', sub: '연구 프로젝트 우선순위와 마감일 관리' },
  'consumables': { title: '소모품', sub: '소모품 재고 관리' },
  'usage': { title: '사용 기록', sub: '장비·소모품 사용 기록' },
  'ai-advisor': { title: 'AI 조언', sub: '재료 기반 설정 추천과 운영 데이터 분석' },
  'quality': { title: '불량 분석', sub: '출력물 이미지 기반 불량 분석 (데모)' },
  'announcements': { title: '공지사항', sub: '공지사항 및 안내' },
  'stats': { title: '통계', sub: '누적 사용 통계' },
  'reports': { title: '리포트', sub: '월간 리포트' },
};

// ------------------------------------------------ 유틸
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
function toMin(hhmm) { const [h, m] = hhmm.split(':'); return parseInt(h, 10) * 60 + parseInt(m, 10); }
function toHHMM(min) { return String(Math.floor(min / 60) % 24).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
function fmtDuration(min) {
  min = parseInt(min, 10);
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h}시간 ${m}분`;
  if (h) return `${h}시간`;
  return `${m}분`;
}
function statusLabel(s) { return { available: '대기 중', in_use: '사용 중', maintenance: '점검 중' }[s] || s; }

function emptyState(icon, title, desc) {
  return `<div class="empty"><div class="e-icon">${icon}</div><div class="e-title">${esc(title)}</div>${desc ? `<div class="e-desc">${esc(desc)}</div>` : ''}</div>`;
}

function kpiCard(label, value, icon, warn, hint) {
  return `<div class="kpi-card"><div class="kpi-top"><span class="kpi-label">${esc(label)}</span><span class="kpi-icon">${icon || ''}</span></div>
    <div class="kpi-value" style="${warn ? 'color:var(--warning);' : ''}">${value}</div>
    ${hint ? `<div class="kpi-delta">${esc(hint)}</div>` : ''}</div>`;
}

function showAlert(elId, msg, type) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.innerHTML = `<div class="alert ${type}">${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 7000);
}

async function api(path, options) {
  const res = await fetch(API + path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `요청 실패 (${res.status})`), { data });
  return data;
}

// ------------------------------------------------ 테마
const THEME_ICON = { system: '🖥️', dark: '🌙', light: '☀️' };
const THEME_LABEL = { system: 'System theme', dark: 'Dark theme', light: 'Light theme' };

function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  const icon = THEME_ICON[mode];
  const headerBtn = document.getElementById('themeToggle');
  if (headerBtn) headerBtn.textContent = icon;
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

// ------------------------------------------------ 내비게이션 (사이드바)
function showPage(pageId, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
  document.querySelectorAll('.side-link[data-page]').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarScrim').classList.remove('open');

  const meta = PAGE_META[pageId];
  if (meta) {
    document.getElementById('pageTitle').textContent = meta.title;
    document.getElementById('pageSub').textContent = meta.sub;
  }

  if (pageId === 'dashboard') loadDashboard();
  if (pageId === 'stats') loadStats();
  if (pageId === 'reports') { /* 사용자가 조회 버튼을 눌러 로드 */ }
  if (pageId === 'announcements') loadAnnouncements();
  if (pageId === 'ai-advisor') loadAiAdvisorPage();
  if (pageId === 'equipment') renderEquipmentPage();
  if (pageId === 'research') renderResearchList();
  if (pageId === 'quality') renderQaHistory();
}
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarScrim').classList.toggle('open');
}

// ------------------------------------------------ 초기 로드
async function loadAll() {
  try {
    [equipment, consumables, reservations, usageLogs, roles] = await Promise.all([
      api('/api/equipment'),
      api('/api/consumables'),
      api('/api/reservations'),
      api('/api/usage-log?limit=50'),
      api('/api/roles'),
    ]);
    renderEquipmentGrid();
    renderEquipmentPage();
    populateAiEquipmentSelect();
    renderConsumables();
    renderReservations();
    renderUsageLogs();
    updateItemList();
    renderRolesInfo();
    loadTimeline();
    loadConsumableForecast();
    loadDashboard();
  } catch (e) {
    showAlert('reservation-alert', '데이터를 불러오지 못했습니다: ' + esc(e.message), 'error');
  }
}

// ================================================== 대시보드
async function loadDashboard() {
  try {
    const [dash, maint, lowStock] = await Promise.all([
      api('/api/dashboard'),
      api('/api/ai/maintenance-alerts'),
      api('/api/consumables/low-stock'),
    ]);
    renderKPICards();
    renderLowStockBanner(lowStock, 'dashboardLowStock');
    renderWeeklyChart(dash.weekly_usage);
    renderRecentActivity();
    renderTopEquipment(dash.top_equipment);
    renderTopUsers(dash.top_users);
    renderMaintenanceAlerts(maint, 'maintenanceAlerts');
    renderDashboardPriorityTasks();
    renderAnnouncementList(dash.announcements, 'dashboardAnnouncements', 5);
  } catch (e) {
    console.error(e);
  }
}

function renderKPICards() {
  const el = document.getElementById('dashboardKpis');
  if (!el) return;

  // 이번주 예약: 최근 7일(오늘 포함) 내 예약
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 6);
  const weeklyCount = reservations.filter(r => {
    const d = new Date(r.reservation_date + 'T00:00:00');
    return d >= weekAgo && d <= today;
  }).length;

  const activeUsers = new Set(reservations.map(r => r.user)).size;

  // 성공률: 체크인된 예약 중 체크아웃까지 완료된 비율 (실제 데이터 기반)
  const checkedIn = reservations.filter(r => r.checked_in_at).length;
  const checkedOut = reservations.filter(r => r.checked_out_at).length;
  const successRate = checkedIn > 0 ? Math.round((checkedOut / checkedIn) * 100) : null;

  // 장비 상태: 점검 중이 아닌 장비 비율
  const uptime = equipment.length ? Math.round(equipment.filter(e => e.status !== 'maintenance').length / equipment.length * 100) : 0;

  el.innerHTML = [
    kpiCard('이번주 예약', weeklyCount, '📅'),
    kpiCard('활성 사용자', activeUsers, '👥'),
    kpiCard('성공률', successRate === null ? '-' : successRate + '%', '✅', false, successRate === null ? '체크인 기록 없음' : '체크인 완료 기준'),
    kpiCard('장비 상태', uptime + '%', '🖨️', uptime < 100, uptime < 100 ? '점검 중 장비 있음' : '전체 가동 중'),
  ].join('');
}

function renderRecentActivity() {
  const el = document.getElementById('recentActivity');
  if (!el) return;
  const items = [];
  reservations.forEach(r => items.push({
    time: r.created_at || `${r.reservation_date} ${r.start_time}`,
    icon: '📅', text: `${r.user}님이 ${r.equipment_name} 예약 (${r.reservation_date} ${r.start_time})`,
  }));
  usageLogs.forEach(l => items.push({
    time: l.timestamp,
    icon: l.item_type === 'consumable' ? '📦' : '🖨️',
    text: `${l.user}님이 ${l.item_name} ${l.quantity_used}${l.unit || ''} 사용`,
  }));
  items.sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
  const top = items.slice(0, 8);

  el.innerHTML = top.length ? top.map(i => `
    <div class="list-item">
      <div class="main"><div class="title">${i.icon} ${esc(i.text)}</div><div class="sub">${esc(i.time || '')}</div></div>
    </div>`).join('') : emptyState('📭', '활동 내역 없음', '예약이나 사용 기록이 쌓이면 여기에 표시됩니다');
}

function renderLowStockBanner(lowStock, targetId) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (!lowStock.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="warn-banner">
      <div class="ic">⚠️</div>
      <div class="body">
        <div class="head">낮은 재고 알림 (${lowStock.length}건)</div>
        ${lowStock.map(c => `
          <div class="shortage-row">
            <span>${esc(c.icon)} ${esc(c.name)}</span>
            <span>${c.shortage}${esc(c.unit)} 부족 (현재: ${c.current_stock}${esc(c.unit)} / 한도: ${c.min_stock}${esc(c.unit)})</span>
          </div>`).join('')}
      </div>
    </div>`;
}

function renderWeeklyChart(data) {
  const el = document.getElementById('weeklyChart');
  if (!el) return;
  if (!data || !data.length) { el.innerHTML = emptyState('📊', '데이터 없음'); return; }
  const max = Math.max(...data.map(d => d.minutes), 1);
  el.innerHTML = `<div class="barchart">${data.map(d => `
    <div class="bar-col">
      <div class="bar-val">${d.minutes ? (d.minutes / 60).toFixed(1) + 'h' : ''}</div>
      <div class="bar" style="height:${Math.max((d.minutes / max) * 100, 2)}%"></div>
      <div class="bar-label">${d.weekday}</div>
    </div>`).join('')}</div>`;
}

function renderTopEquipment(list) {
  const el = document.getElementById('topEquipment');
  if (!el) return;
  if (!list.length) { el.innerHTML = emptyState('🏆', '최근 30일 예약 데이터 없음'); return; }
  const medals = ['gold', 'silver', 'bronze'];
  el.innerHTML = list.map((e, i) => `
    <div class="rank-item">
      <div class="rank-num ${medals[i] || ''}">${i + 1}</div>
      <div class="rank-name">${esc(e.icon)} ${esc(e.name)}</div>
      <div class="rank-val">${e.count}건 · ${(e.minutes / 60).toFixed(1)}h</div>
    </div>`).join('');
}

function renderTopUsers(list) {
  const el = document.getElementById('topUsers');
  if (!el) return;
  if (!list.length) { el.innerHTML = emptyState('👑', '최근 30일 예약 데이터 없음'); return; }
  const medals = ['gold', 'silver', 'bronze'];
  el.innerHTML = list.map((u, i) => `
    <div class="rank-item">
      <div class="rank-num ${medals[i] || ''}">${i + 1}</div>
      <div class="rank-name">👤 ${esc(u.user)}</div>
      <div class="rank-val">${u.count}건 · ${(u.minutes / 60).toFixed(1)}h</div>
    </div>`).join('');
}

function renderMaintenanceAlerts(list, targetId) {
  const el = document.getElementById(targetId || 'maintenanceAlerts');
  if (!el) return;
  if (!list.length) { el.innerHTML = emptyState('✅', '점검이 필요한 장비가 없습니다'); return; }
  el.innerHTML = list.map(a => `
    <div class="ai-card ${a.level === 'overdue' ? 'danger' : a.level === 'soon' ? 'warn' : ''}">
      <span class="spark">${a.level === 'overdue' ? '🔴' : a.level === 'in_progress' ? '🛠️' : '🟡'}</span>
      <span>${esc(a.message)}</span>
    </div>`).join('');
}

// ================================================== Equipment (전용 페이지)
function renderEquipmentPage() {
  const el = document.getElementById('equipmentPageGrid');
  if (!el) return;
  if (!equipment.length) { el.innerHTML = emptyState('🖨️', '등록된 장비가 없습니다', '관리자 콘솔에서 장비를 추가하세요'); return; }
  el.innerHTML = equipment.map(eq => `
    <div class="equipment-card" style="cursor:default;">
      <span class="status-dot ${eq.status}"></span>
      <div class="thumb">${eq.icon || '🖨️'}</div>
      <div class="body">
        <div class="name">${esc(eq.name)}</div>
        <span class="status-pill ${eq.status}">${statusLabel(eq.status)}</span>
      </div>
    </div>`).join('');
}

// ================================================== 예약 (Schedule)
function renderEquipmentGrid() {
  const el = document.getElementById('equipmentGrid');
  if (!el) return;
  el.innerHTML = equipment.map(eq => `
    <button type="button" class="equipment-card compact${selectedEquipment === eq.id ? ' selected' : ''}${eq.status === 'maintenance' ? ' disabled' : ''}"
            onclick="selectEquipment('${eq.id}', ${eq.status === 'maintenance'})">
      <span class="status-dot ${eq.status}"></span>
      <div class="thumb">${eq.icon || '🖨️'}</div>
      <div class="body">
        <div class="name">${esc(eq.name)}</div>
        <span class="status-pill ${eq.status}">${statusLabel(eq.status)}</span>
      </div>
    </button>`).join('');
}

function selectEquipment(id, blocked) {
  if (blocked) { showAlert('reservation-alert', '⚠️ 이 장비는 현재 점검 중이라 예약할 수 없습니다', 'error'); return; }
  selectedEquipment = id;
  renderEquipmentGrid();
  loadTimeline();
  loadBestTime(id);
}

async function loadBestTime(id) {
  const el = document.getElementById('bestTimeHint');
  if (!el) return;
  el.innerHTML = '';
  try {
    const r = await api(`/api/ai/best-time/${id}`);
    el.innerHTML = `<div class="ai-card"><span class="spark">🤖</span><span>${esc(r.message)}</span></div>`;
  } catch (e) { /* 무시 */ }
}

function setDuration(min) {
  document.getElementById('resDuration').value = min;
  updateEndPreview();
}

function updateEndPreview() {
  const start = document.getElementById('resStart').value;
  const dur = parseInt(document.getElementById('resDuration').value, 10);
  const el = document.getElementById('endPreview');
  if (!start || !dur || dur < 5) {
    el.textContent = '5분 ~ 1440분 사이 아무 값이나 입력할 수 있습니다.';
    return;
  }
  const end = toMin(start) + dur;
  el.textContent = `${start} → ${toHHMM(end)} 종료 (${fmtDuration(dur)})` + (end > 1440 ? ' ⚠️ 자정을 넘습니다' : '');
}

function toggleRepeat() {
  const on = document.getElementById('resRepeat').checked;
  document.getElementById('repeatWeeksWrap').style.display = on ? 'block' : 'none';
}

let lastSuggestion = null;

async function createReservation() {
  const user = document.getElementById('resUser').value.trim();
  const date = document.getElementById('resDate').value;
  const start = document.getElementById('resStart').value;
  const duration = parseInt(document.getElementById('resDuration').value, 10);
  const purpose = document.getElementById('resPurpose').value;
  const participants = document.getElementById('resParticipants').value.trim();
  const repeat = document.getElementById('resRepeat').checked;
  const repeatWeeks = repeat ? (parseInt(document.getElementById('resRepeatWeeks').value, 10) || 0) : 0;

  if (!user) return showAlert('reservation-alert', '이름을 입력해주세요', 'error');
  if (!selectedEquipment) return showAlert('reservation-alert', '장비를 선택해주세요', 'error');
  if (!date || !start) return showAlert('reservation-alert', '날짜와 시작 시간을 입력해주세요', 'error');
  if (!duration || duration < 5) return showAlert('reservation-alert', '소요 시간을 5분 이상으로 입력해주세요', 'error');

  const eq = equipment.find(e => e.id === selectedEquipment);
  lastSuggestion = null;

  try {
    const r = await api('/api/reservations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user, equipment_id: selectedEquipment, equipment_name: eq.name,
        date, start_time: start, duration_minutes: duration, purpose, participants,
        repeat_weeks: repeatWeeks,
      }),
    });

    if (repeatWeeks > 0) {
      showAlert('reservation-alert', `✅ 반복 예약 처리: ${r.summary}` +
        (r.failed.length ? `<br>실패: ${r.failed.map(f => `${f.date} (${esc(f.error)})`).join(', ')}` : ''), 'success');
    } else {
      showAlert('reservation-alert', `✅ 예약 완료: ${esc(eq.name)} ${date} ${start}~${r.end_time} (${fmtDuration(duration)})`, 'success');
    }
    document.getElementById('resPurpose').value = '';
    document.getElementById('resParticipants').value = '';
    await loadAll();
  } catch (e) {
    let msg = '❌ ' + esc(e.message);
    if (e.data && e.data.suggested_slot) {
      const s = e.data.suggested_slot;
      lastSuggestion = s;
      msg += `<br>💡 다음 가능 시간: <b>${s.date} ${s.start_time}~${s.end_time}</b>
        <button class="btn btn-sm btn-ghost" style="margin-top:6px;" onclick="applySuggestion()">이 시간으로 채우기</button>`;
    }
    showAlert('reservation-alert', msg, 'error');
  }
}

function applySuggestion() {
  if (!lastSuggestion) return;
  document.getElementById('resDate').value = lastSuggestion.date;
  document.getElementById('resStart').value = lastSuggestion.start_time;
  updateEndPreview();
  loadTimeline();
  showAlert('reservation-alert', '입력값을 채웠습니다. 다시 "예약 신청"을 눌러주세요.', 'success');
}

async function cancelReservation(id) {
  if (!confirm('이 예약을 취소할까요?')) return;
  try {
    await api('/api/reservations/' + id, { method: 'DELETE' });
    await loadAll();
  } catch (e) { showAlert('reservation-alert', esc(e.message), 'error'); }
}

function statusBadge(r) {
  if (r.checked_out_at) return `<span class="badge ok">완료</span>`;
  if (r.checked_in_at) return `<span class="badge warn">사용 중</span>`;
  return `<span class="badge">예약됨</span>`;
}

function reservationRow(r) {
  return `
    <tr>
      <td>${esc(r.equipment_name)}${r.participants ? `<div class="hint" style="margin-top:2px;">👥 ${esc(r.participants)}</div>` : ''}</td>
      <td>${esc(r.user)}</td>
      <td>${esc(r.reservation_date)}</td>
      <td>${esc(r.start_time)}~${esc(r.end_time)}</td>
      <td>${statusBadge(r)}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm btn-ghost" onclick="showQr(${r.id})">QR</button>
        <button class="btn btn-sm btn-danger" onclick="cancelReservation(${r.id})">취소</button>
      </td>
    </tr>`;
}

function myReservationRow(r) {
  return `
    <tr>
      <td>${esc(r.equipment_name)} <span class="badge">${fmtDuration(r.duration_minutes)}</span></td>
      <td>${esc(r.reservation_date)} ${esc(r.start_time)}</td>
      <td>${statusBadge(r)}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-sm btn-ghost" onclick="showQr(${r.id})">QR</button>
        <button class="btn btn-sm btn-danger" onclick="cancelReservation(${r.id})">취소</button>
      </td>
    </tr>`;
}

function renderReservations() {
  const all = document.getElementById('allReservations');
  if (all) all.innerHTML = reservations.length ? reservations.map(reservationRow).join('')
    : `<tr><td colspan="6">${emptyState('📅', '예약이 없습니다')}</td></tr>`;

  const user = document.getElementById('resUser').value.trim();
  const mine = user ? reservations.filter(r => r.user === user) : [];
  const myEl = document.getElementById('myReservations');
  if (myEl) {
    myEl.innerHTML = !user
      ? `<tr><td colspan="4">${emptyState('👤', '이름을 입력하면 내 예약만 모아 봅니다')}</td></tr>`
      : (mine.length ? mine.map(myReservationRow).join('') : `<tr><td colspan="4">${emptyState('📭', '내 예약이 없습니다')}</td></tr>`);
  }
}

function showQr(id) {
  document.getElementById('qrImage').src = `/api/reservations/${id}/qr`;
  document.getElementById('qrModal').classList.add('open');
}
function closeQr() { document.getElementById('qrModal').classList.remove('open'); }

async function loadTimeline() {
  const date = document.getElementById('resDate').value;
  const box = document.getElementById('timeline');
  const title = document.getElementById('timelineTitle');
  if (!box) return;

  if (!selectedEquipment || !date) {
    title.textContent = '선택한 장비의 당일 예약 현황';
    box.innerHTML = emptyState('📅', '장비와 날짜를 선택하세요');
    return;
  }

  try {
    const data = await api(`/api/equipment/${selectedEquipment}/availability?date=${date}`);
    title.textContent = `${data.equipment_name} · ${date} 예약 현황`;

    if (!data.slots.length) {
      box.innerHTML = emptyState('✅', '이 날짜에는 예약이 없습니다');
      return;
    }
    const bars = data.slots.map(s => {
      const start = toMin(s.start_time);
      const left = (start / 1440) * 100;
      const width = Math.max((s.duration_minutes / 1440) * 100, 1.5);
      return `
        <div class="timeline-bar" title="${esc(s.user)} ${esc(s.start_time)}~${esc(s.end_time)}">
          <div class="timeline-slot" style="left:${left}%; width:${width}%;">${esc(s.start_time)}~${esc(s.end_time)}</div>
        </div>
        <div class="sub" style="margin:-2px 0 8px;">👤 ${esc(s.user)} · ${fmtDuration(s.duration_minutes)}${s.purpose ? ' · ' + esc(s.purpose) : ''}</div>`;
    }).join('');
    box.innerHTML = `${bars}<div class="timeline-scale"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>`;
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function renderRolesInfo() {
  const el = document.getElementById('rolesInfo');
  if (!el || !roles) return;
  el.innerHTML = Object.entries(roles).map(([key, r]) => `
    <div class="list-item" style="padding:9px 0;">
      <div class="main"><span class="badge">${esc(r.label)}</span></div>
      <div class="sub" style="text-align:right;">
        ${r.daily_minutes ? `하루 ${r.daily_minutes}분` : '시간 제한 없음'} ·
        ${r.monthly_usage_count ? `월 소모품 ${r.monthly_usage_count}회` : '소모품 제한 없음'}
      </div>
    </div>`).join('');
}

// ================================================== AI Advisor
function populateAiEquipmentSelect() {
  const sel = document.getElementById('aiEquipmentSelect');
  if (!sel) return;
  sel.innerHTML = equipment.map(e => `<option value="${e.id}">${e.icon || ''} ${esc(e.name)}</option>`).join('');
}

async function aiCheckBestTime() {
  const id = document.getElementById('aiEquipmentSelect').value;
  const el = document.getElementById('aiBestTimeResult');
  if (!id) return;
  el.innerHTML = emptyState('⏳', '조회 중...');
  try {
    const r = await api(`/api/ai/best-time/${id}`);
    el.innerHTML = `<div class="ai-card"><span class="spark">🤖</span><span>${esc(r.message)}</span></div>`;
  } catch (e) {
    el.innerHTML = `<div class="ai-card danger"><span class="spark">⚠️</span><span>${esc(e.message)}</span></div>`;
  }
}

async function loadAiForecastList() {
  const el = document.getElementById('aiForecastList');
  if (!el) return;
  try {
    const list = await api('/api/ai/consumable-forecast');
    if (!list.length) { el.innerHTML = emptyState('📦', '등록된 소모품이 없습니다'); return; }
    el.innerHTML = list.map(f => {
      const pct = (f.available && f.weeks_remaining != null) ? Math.max(Math.min((f.weeks_remaining / 8) * 100, 100), 3) : 0;
      return `
        <div class="list-item">
          <div class="main">
            <div class="title">${esc(f.icon || '')} ${esc(f.name)}</div>
            <div class="sub">${esc(f.message)}</div>
            ${f.available ? `<div class="progress-track" style="margin-top:8px;"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
          </div>
        </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function loadAiAdvisorPage() {
  populateAiEquipmentSelect();
  try {
    const maint = await api('/api/ai/maintenance-alerts');
    renderMaintenanceAlerts(maint, 'aiMaintenanceList');
  } catch (e) { /* 무시 */ }
  loadAiForecastList();
}

// ================================================== 소모품
let consumableCategoryFilter = 'all';

async function addConsumable() {
  const name = document.getElementById('consName').value.trim();
  const stock = parseFloat(document.getElementById('consStock').value);
  const minStock = parseFloat(document.getElementById('consMinStock').value) || 0;
  const unitPrice = parseFloat(document.getElementById('consUnitPrice').value) || 0;

  if (!name) return showAlert('consumable-alert', '소모품명을 입력해주세요', 'error');
  if (isNaN(stock)) return showAlert('consumable-alert', '재고를 입력해주세요', 'error');

  try {
    await api('/api/consumables', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, stock, min_stock: minStock, unit_price: unitPrice,
        unit: document.getElementById('consUnit').value,
        icon: document.getElementById('consIcon').value,
        category: document.getElementById('consCategory').value,
        color: document.getElementById('consColor').value,
      }),
    });
    showAlert('consumable-alert', `✅ ${esc(name)} 추가 완료`, 'success');
    ['consName', 'consStock', 'consMinStock', 'consUnitPrice'].forEach(id => document.getElementById(id).value = '');
    await loadAll();
  } catch (e) {
    showAlert('consumable-alert', '❌ ' + esc(e.message), 'error');
  }
}

function filterConsumables(cat, btn) {
  consumableCategoryFilter = cat;
  document.querySelectorAll('.cat-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderConsumables();
}

function renderConsumables() {
  const list = document.getElementById('consumablesList');
  if (!list) return;
  renderLowStockBanner(consumables.filter(c => c.low_stock), 'consumableLowStock');

  const filtered = consumableCategoryFilter === 'all'
    ? consumables : consumables.filter(c => c.category === consumableCategoryFilter);

  if (!filtered.length) { list.innerHTML = emptyState('📦', '등록된 소모품이 없습니다'); return; }

  list.innerHTML = filtered.map(c => {
    const ratio = c.min_stock > 0 ? Math.min((c.current_stock / (c.min_stock * 3)) * 100, 100) : Math.min(c.current_stock * 10, 100);
    return `
      <div class="list-item">
        <div class="main">
          <div class="title">
            <span class="tag-dot" style="background:${esc(c.color || '#185fa5')}"></span>
            ${esc(c.icon || '📦')} ${esc(c.name)}
            <span class="badge neutral">${esc(c.category)}</span>
            ${c.low_stock ? '<span class="badge danger">부족</span>' : '<span class="badge ok">충분</span>'}
          </div>
          <div class="sub">${c.current_stock} ${esc(c.unit)} (한도 ${c.min_stock} ${esc(c.unit)})${c.unit_price ? ` · 단가 ${Number(c.unit_price).toLocaleString()}원` : ''}</div>
          <div class="stock-bar"><div class="stock-fill${c.low_stock ? ' low' : ''}" style="width:${ratio}%"></div></div>
          <div id="forecast-${c.id}" class="hint"></div>
        </div>
        <div class="actions">
          <button class="btn btn-sm btn-ghost" onclick="restock(${c.id})">입고</button>
          <button class="btn btn-sm btn-ghost" onclick="editStock(${c.id})">수정</button>
          <button class="btn btn-sm btn-danger" onclick="deleteConsumable(${c.id})">삭제</button>
        </div>
      </div>`;
  }).join('');
}

async function loadConsumableForecast() {
  try {
    const forecasts = await api('/api/ai/consumable-forecast');
    forecasts.forEach(f => {
      const el = document.getElementById(`forecast-${f.id}`);
      if (el) el.textContent = '🔮 ' + f.message;
    });
  } catch (e) { /* 무시 */ }
}

async function restock(id) {
  const c = consumables.find(x => x.id === id);
  const v = prompt(`${c.name} 입고량을 입력하세요 (${c.unit}):`);
  if (v === null || v === '') return;
  const delta = parseFloat(v);
  if (isNaN(delta)) return alert('숫자를 입력해주세요');
  try {
    await api('/api/consumables/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta }) });
    await loadAll();
  } catch (e) { alert(e.message); }
}

async function editStock(id) {
  const c = consumables.find(x => x.id === id);
  const v = prompt(`${c.name}의 현재 재고 (${c.unit}):`, c.current_stock);
  if (v === null) return;
  const stock = parseFloat(v);
  if (isNaN(stock)) return alert('숫자를 입력해주세요');
  try {
    await api('/api/consumables/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stock }) });
    await loadAll();
  } catch (e) { alert(e.message); }
}

async function deleteConsumable(id) {
  const c = consumables.find(x => x.id === id);
  if (!confirm(`${c.name}을(를) 삭제할까요?`)) return;
  try {
    await api('/api/consumables/' + id, { method: 'DELETE' });
    await loadAll();
  } catch (e) { alert(e.message); }
}

// ================================================== 사용 기록
function updateItemList() {
  const type = document.getElementById('usageType').value;
  const select = document.getElementById('usageItem');
  const hint = document.getElementById('usageUnitHint');
  if (!select) return;

  if (type === 'equipment') {
    select.innerHTML = equipment.map(e => `<option value="${e.id}">${e.icon || ''} ${esc(e.name)}</option>`).join('');
    hint.textContent = '(분 단위)';
  } else {
    select.innerHTML = consumables.length
      ? consumables.map(c => `<option value="${c.id}">${c.icon || ''} ${esc(c.name)} (${c.current_stock}${esc(c.unit)} 보유)</option>`).join('')
      : '<option value="">등록된 소모품 없음</option>';
    hint.textContent = '(소모품 단위)';
  }
}

async function addUsageLog() {
  const user = document.getElementById('usageUser').value.trim();
  const itemType = document.getElementById('usageType').value;
  const itemId = document.getElementById('usageItem').value;
  const qty = parseFloat(document.getElementById('usageQty').value);
  const notes = document.getElementById('usageNotes').value;

  if (!user) return showAlert('usage-alert', '사용자명을 입력해주세요', 'error');
  if (!itemId) return showAlert('usage-alert', '항목을 선택해주세요', 'error');
  if (isNaN(qty) || qty <= 0) return showAlert('usage-alert', '사용량을 입력해주세요', 'error');

  try {
    await api('/api/usage-log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, item_type: itemType, item_id: itemId, quantity_used: qty, notes }),
    });
    showAlert('usage-alert', '✅ 기록이 저장되었습니다', 'success');
    document.getElementById('usageQty').value = '';
    document.getElementById('usageNotes').value = '';
    await loadAll();
  } catch (e) {
    showAlert('usage-alert', '❌ ' + esc(e.message), 'error');
  }
}

function renderUsageLogs() {
  const list = document.getElementById('usageLogList');
  if (!list) return;
  list.innerHTML = usageLogs.length ? usageLogs.map(l => `
    <div class="list-item">
      <div class="main">
        <div class="title">${esc(l.item_name)} <span class="badge">${l.quantity_used}${esc(l.unit || '')}</span></div>
        <div class="sub">👤 ${esc(l.user)} · ${esc(l.timestamp)}${l.notes ? ' · ' + esc(l.notes) : ''}</div>
      </div>
    </div>`).join('') : emptyState('🧾', '기록이 없습니다');
}

// ================================================== 공지사항
async function loadAnnouncements() {
  try {
    const list = await api('/api/announcements');
    renderAnnouncementList(list, 'announcementsFull', 999);
  } catch (e) {
    document.getElementById('announcementsFull').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

const ANN_TYPE_ICON = { notice: '📢', maintenance: '🛠️', rule: '📏' };

function renderAnnouncementList(list, targetId, limit) {
  const el = document.getElementById(targetId);
  if (!el) return;
  if (!list.length) { el.innerHTML = emptyState('📢', '공지사항이 없습니다'); return; }
  el.innerHTML = list.slice(0, limit).map(a => `
    <div class="notice-banner ${a.pinned ? 'pinned' : ''}">
      <div class="n-icon">${ANN_TYPE_ICON[a.type] || '📢'}</div>
      <div>
        <div class="n-title">${a.pinned ? '📌 ' : ''}${esc(a.title)}</div>
        ${a.body ? `<div class="n-body">${esc(a.body)}</div>` : ''}
        <div class="n-meta">${esc(a.created_by || '')} · ${esc(a.created_at || '')}</div>
      </div>
    </div>`).join('');
}

// ================================================== 통계
async function loadStats() {
  try {
    const s = await api('/api/stats');
    document.getElementById('statsDetail').innerHTML = [
      kpiCard('전체 예약', s.total_reservations, '📅'),
      kpiCard('사용자', s.unique_users, '👥'),
      kpiCard('총 사용 시간(h)', s.total_hours, '⏱️'),
      kpiCard('사용 기록', s.usage_logs, '🧾'),
      kpiCard('재고 부족', s.low_stock.length, '📦', s.low_stock.length > 0),
    ].join('');

    document.getElementById('equipmentStatsTable').innerHTML = s.by_equipment.map(e => `
      <tr><td>${esc(e.icon || '')} ${esc(e.name)}</td><td>${e.reservation_count}건</td><td>${(e.total_minutes / 60).toFixed(1)}h</td><td>${e.user_count}명</td></tr>`
    ).join('') || `<tr><td colspan="4">${emptyState('📊', '데이터 없음')}</td></tr>`;

    document.getElementById('consumableStatsTable').innerHTML = s.by_consumable.map(c => `
      <tr><td>${esc(c.icon || '')} ${esc(c.name)}</td><td>${c.total_used} ${esc(c.unit)}</td>
      <td>${c.current_stock} ${esc(c.unit)} ${c.current_stock < c.min_stock ? '<span class="badge danger">부족</span>' : ''}</td></tr>`
    ).join('') || `<tr><td colspan="3">${emptyState('📊', '데이터 없음')}</td></tr>`;
  } catch (e) {
    document.getElementById('statsDetail').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ================================================== 리포트
async function loadReport() {
  const year = parseInt(document.getElementById('reportYear').value, 10);
  const month = parseInt(document.getElementById('reportMonth').value, 10);
  const box = document.getElementById('reportResult');
  box.innerHTML = emptyState('⏳', '불러오는 중...');
  try {
    const d = await api(`/api/reports/monthly?year=${year}&month=${month}`);
    const userRows = Object.entries(d.by_user).sort((a, b) => b[1].minutes - a[1].minutes)
      .map(([name, v]) => `<tr><td>${esc(name)}</td><td>${v.count}</td><td>${(v.minutes / 60).toFixed(1)}h</td><td>${v.cost.toLocaleString()}원</td></tr>`).join('');
    const eqRows = Object.entries(d.by_equipment).sort((a, b) => b[1].minutes - a[1].minutes)
      .map(([name, v]) => `<tr><td>${esc(name)}</td><td>${v.count}</td><td>${(v.minutes / 60).toFixed(1)}h</td><td>${v.cost.toLocaleString()}원</td></tr>`).join('');
    const consRows = Object.entries(d.by_consumable).sort((a, b) => b[1].used - a[1].used)
      .map(([name, v]) => `<tr><td>${esc(name)}</td><td>${v.used.toFixed(2)}${esc(v.unit || '')}</td><td>${v.cost.toLocaleString()}원</td></tr>`).join('');

    box.innerHTML = `
      <div class="kpi-grid" style="margin-bottom:18px;">
        ${kpiCard('예약 수', d.total_reservations, '📅')}
        ${kpiCard('총 시간(h)', d.total_hours, '⏱️')}
        ${kpiCard('추정 비용(원)', d.total_cost.toLocaleString(), '💰')}
      </div>
      <div class="table-wrap"><table class="table"><thead><tr><th>이름</th><th>예약</th><th>시간</th><th>비용</th></tr></thead>
        <tbody>${userRows || `<tr><td colspan="4">${emptyState('📊', '데이터 없음')}</td></tr>`}</tbody></table></div>
      <div style="height:16px;"></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>장비</th><th>예약</th><th>시간</th><th>비용</th></tr></thead>
        <tbody>${eqRows || `<tr><td colspan="4">${emptyState('📊', '데이터 없음')}</td></tr>`}</tbody></table></div>
      <div style="height:16px;"></div>
      <div class="table-wrap"><table class="table"><thead><tr><th>소모품</th><th>사용량</th><th>비용</th></tr></thead>
        <tbody>${consRows || `<tr><td colspan="3">${emptyState('📊', '데이터 없음')}</td></tr>`}</tbody></table></div>`;

    document.getElementById('reportPdfLink').href = `/api/reports/monthly.pdf?year=${year}&month=${month}`;
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ================================================== 초기화
// ================================================== AI 조언 (재료 추천 - 규칙 기반 모의 계산)
const AI_MATERIAL_BASE = {
  PLA: { temp: 200, speed: 50, cooling: 100, infill: 20 },
  PETG: { temp: 235, speed: 40, cooling: 50, infill: 25 },
  ABS: { temp: 240, speed: 45, cooling: 20, infill: 25 },
  TPU: { temp: 220, speed: 25, cooling: 30, infill: 15 },
};
const AI_STRENGTH_ADJUST = {
  low: { infillDelta: -5, speedDelta: 10, successBase: 97 },
  medium: { infillDelta: 0, speedDelta: 0, successBase: 94 },
  high: { infillDelta: 20, speedDelta: -10, successBase: 90 },
  veryhigh: { infillDelta: 40, speedDelta: -20, successBase: 85 },
};

function runAiAdvisor() {
  const material = document.getElementById('aiMaterial').value;
  const strengthKey = document.getElementById('aiTargetStrength').value;
  const issue = document.getElementById('aiIssue').value.trim();

  const base = AI_MATERIAL_BASE[material];
  const adj = AI_STRENGTH_ADJUST[strengthKey];

  let temp = base.temp;
  let speed = Math.max(base.speed + adj.speedDelta, 15);
  let cooling = base.cooling;
  let infill = Math.min(Math.max(base.infill + adj.infillDelta, 10), 100);
  let successRate = adj.successBase;
  const tips = [];

  if (issue) {
    if (/휨|휘어|워핑|warp/i.test(issue)) {
      cooling = Math.max(cooling - 30, 0);
      successRate -= 3;
      tips.push('베드 온도를 높이고 외풍을 차단하세요 (워핑 방지)');
    }
    if (/층\s*분리|박리|delamination/i.test(issue)) {
      temp += 8; speed = Math.max(speed - 5, 15); successRate -= 4;
      tips.push('층간 접착력 강화를 위해 노즐 온도를 높이고 출력 속도를 낮추세요');
    }
    if (/기공|보이드|공극|void/i.test(issue)) {
      temp += 5; successRate -= 3;
      tips.push('필라멘트를 건조시키고 리트랙션 거리를 점검하세요');
    }
    if (/실\s*늘어|스트링|stringing/i.test(issue)) {
      temp -= 5; successRate -= 2;
      tips.push('리트랙션 거리를 늘리고 이동 속도를 높이세요');
    }
    if (!tips.length) tips.push('입력하신 증상에 대한 구체적 규칙을 찾지 못해 기본 추천을 표시합니다');
  }
  successRate = Math.max(Math.min(successRate, 99), 70);

  const el = document.getElementById('aiAdvisorResult');
  el.innerHTML = `
    <div class="grid-3" style="grid-template-columns:repeat(2,1fr); gap:10px;">
      <div class="qa-box"><div class="qb-label">노즐 온도</div><div class="qb-body" style="font-size:20px; font-weight:600; color:var(--text);">${temp}°C</div></div>
      <div class="qa-box"><div class="qb-label">출력 속도</div><div class="qb-body" style="font-size:20px; font-weight:600; color:var(--text);">${speed} mm/s</div></div>
      <div class="qa-box"><div class="qb-label">냉각 팬</div><div class="qb-body" style="font-size:20px; font-weight:600; color:var(--text);">${cooling}%</div></div>
      <div class="qa-box"><div class="qb-label">채우기 (인필)</div><div class="qb-body" style="font-size:20px; font-weight:600; color:var(--text);">${infill}%</div></div>
    </div>
    <div class="qa-box" style="margin-top:10px;">
      <div class="qb-label">예상 성공률</div>
      <div class="qb-body" style="font-size:22px; font-weight:600; color:var(--blue); margin-bottom:8px;">${successRate}%</div>
      <div class="progress-track"><div class="progress-fill" style="width:${successRate}%"></div></div>
    </div>
    ${tips.length ? `<div class="ai-card" style="margin-top:10px;"><span class="spark">💡</span><span>${tips.map(esc).join('<br>')}</span></div>` : ''}
    <p class="hint" style="margin-top:8px;">* ${esc(material)} · 목표 강도 ${esc(document.getElementById('aiTargetStrength').selectedOptions[0].text)} 기준 참고용 추천</p>`;
}

// ================================================== 불량 분석 (데모 — 실제 이미지 분석 모델 미연동)
const QA_DEFECTS = [
  { type: '정상', badge: 'ok', cause: '특이사항이 발견되지 않았습니다.', solution: '현재 출력 설정을 유지하세요.' },
  { type: '레이어 분리', badge: 'danger', cause: '출력 온도 부족 또는 냉각 과다로 층간 접착력이 저하되었습니다.', solution: '노즐 온도를 5~10°C 높이고 냉각 팬 속도를 낮추세요.' },
  { type: '워핑 (휨)', badge: 'warn', cause: '베드 온도 부족 또는 외기 냉각으로 인한 초기 레이어 수축입니다.', solution: '베드 온도를 높이고 엔클로저로 외풍을 차단하세요.' },
  { type: '기공/보이드', badge: 'warn', cause: '리트랙션 설정 불량 또는 필라멘트의 수분 흡수가 의심됩니다.', solution: '필라멘트를 건조시키고 리트랙션 거리를 재조정하세요.' },
  { type: '스트링잉 (실 늘어짐)', badge: 'warn', cause: '리트랙션 거리 부족 또는 노즐 온도 과다입니다.', solution: '리트랙션 거리를 늘리고 노즐 온도를 5°C 낮춰보세요.' },
];
const QA_HISTORY_KEY = 'xam-qa-history';
let qaLastResult = null;

function handleQaFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('qaDropzoneContent').style.display = 'none';
    const img = document.getElementById('qaPreview');
    img.src = e.target.result;
    img.style.display = 'block';
    document.getElementById('qaAnalyzeBtn').disabled = false;
  };
  reader.readAsDataURL(file);
}
function handleQaDrop(e) {
  e.preventDefault();
  document.getElementById('qaDropzone').classList.remove('drag');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleQaFile(file);
}

async function runQualityAnalysis() {
  const el = document.getElementById('qaResult');
  el.innerHTML = emptyState('⏳', '분석 중입니다...', 'AI 모델이 이미지를 분석하고 있습니다');
  await new Promise(r => setTimeout(r, 900));

  const pick = QA_DEFECTS[Math.floor(Math.random() * QA_DEFECTS.length)];
  const confidence = (pick.type === '정상' ? (90 + Math.random() * 9) : (72 + Math.random() * 22)).toFixed(1);
  qaLastResult = { type: pick.type, confidence, cause: pick.cause, solution: pick.solution, time: new Date().toISOString() };

  el.innerHTML = `
    <span class="badge ${pick.badge} qa-badge">${esc(pick.type)}</span>
    <div class="hint" style="margin-bottom:10px;">신뢰도 ${confidence}%</div>
    <div class="progress-track" style="margin-bottom:14px;"><div class="progress-fill" style="width:${confidence}%"></div></div>
    <div class="qa-box"><div class="qb-label">원인 분석</div><div class="qb-body">${esc(pick.cause)}</div></div>
    <div class="qa-box"><div class="qb-label">해결 방법</div><div class="qb-body">${esc(pick.solution)}</div></div>
    <button class="btn btn-primary" style="margin-top:14px;" onclick="saveQaRecord()">기록 저장</button>
    <p class="hint" style="margin-top:8px;">* 데모용 모의 분석입니다. 실제 이미지 인식 모델과 연동되어 있지 않습니다.</p>`;
}

function loadQaHistory() { try { return JSON.parse(localStorage.getItem(QA_HISTORY_KEY)) || []; } catch (e) { return []; } }
function saveQaHistoryList(list) { try { localStorage.setItem(QA_HISTORY_KEY, JSON.stringify(list)); } catch (e) {} }

function saveQaRecord() {
  if (!qaLastResult) return;
  const list = loadQaHistory();
  list.unshift(qaLastResult);
  saveQaHistoryList(list.slice(0, 20));
  renderQaHistory();
}

function renderQaHistory() {
  const el = document.getElementById('qaHistory');
  if (!el) return;
  const list = loadQaHistory();
  if (!list.length) { el.innerHTML = emptyState('🗂️', '저장된 분석 기록이 없습니다'); return; }
  el.innerHTML = list.map(r => `
    <div class="list-item">
      <div class="main">
        <div class="title">${esc(r.type)} <span class="badge">${r.confidence}%</span></div>
        <div class="sub">${esc(r.solution)}</div>
      </div>
      <div class="hint">${esc(new Date(r.time).toLocaleString('ko-KR'))}</div>
    </div>`).join('');
}

// ================================================== 연구 관리 (localStorage 기반)
const RESEARCH_KEY = 'xam-research-items';
let researchItems = [];
let researchFilter = 'all';
let editingResearchId = null;

const PRIORITY_META = {
  urgent: { emoji: '🔴', label: '긴급', cls: 'priority-urgent' },
  high: { emoji: '🟠', label: '높음', cls: 'priority-high' },
  medium: { emoji: '🟡', label: '보통', cls: 'priority-medium' },
  low: { emoji: '🟢', label: '낮음', cls: 'priority-low' },
};
const URGENCY_LABEL = { low: '낮음', medium: '보통', high: '높음' };

function researchUid() { return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function loadResearchItems() { try { return JSON.parse(localStorage.getItem(RESEARCH_KEY)) || []; } catch (e) { return []; } }
function saveResearchItemsToStorage() { try { localStorage.setItem(RESEARCH_KEY, JSON.stringify(researchItems)); } catch (e) {} }

function seedResearchIfEmpty() {
  const existing = loadResearchItems();
  if (existing.length) { researchItems = existing; return; }
  const plus = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  researchItems = [
    { id: researchUid(), title: 'A1 급냉각 테스트', owner: '김지원', deadline: plus(2), urgency: 'high', status: '진행중', description: 'A1 프린터 급냉각 조건에서의 출력 품질 테스트', equipment: ['a1'], createdAt: new Date().toISOString() },
    { id: researchUid(), title: 'P2S 품질 검증', owner: '이수현', deadline: plus(5), urgency: 'high', status: '진행중', description: 'P2S 출력물 인장강도 품질 검증', equipment: ['p2s', 'tensile'], createdAt: new Date().toISOString() },
    { id: researchUid(), title: 'H2D 정기점검', owner: '박민재', deadline: plus(15), urgency: 'low', status: '진행중', description: 'H2D 정기 점검 및 캘리브레이션', equipment: ['h2d'], createdAt: new Date().toISOString() },
  ];
  saveResearchItemsToStorage();
}

function daysUntil(deadlineStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dl = new Date(deadlineStr + 'T00:00:00');
  return Math.round((dl - today) / 86400000);
}
function formatDaysRemaining(days) {
  if (days < 0) return `${Math.abs(days)}일 지연`;
  if (days === 0) return '오늘 마감';
  return `${days}일 남음`;
}

// 9. 우선순위 자동 계산 로직
function calcPriority(deadline, urgency) {
  const days = daysUntil(deadline);
  if (urgency === 'high' && days <= 3) return 'urgent';
  if ((days <= 7 && (urgency === 'high' || urgency === 'medium')) || (days <= 3 && urgency === 'medium')) return 'high';
  if ((days <= 14 && urgency === 'medium') || (days <= 7 && urgency === 'low')) return 'medium';
  return 'low';
}

function sortedResearch() {
  const rank = { urgent: 0, high: 1, medium: 2, low: 3 };
  return [...researchItems].sort((a, b) => {
    const pa = calcPriority(a.deadline, a.urgency), pb = calcPriority(b.deadline, b.urgency);
    if (rank[pa] !== rank[pb]) return rank[pa] - rank[pb];
    return daysUntil(a.deadline) - daysUntil(b.deadline);
  });
}

function populateResearchEquipmentChecks(selected) {
  const el = document.getElementById('rsEquipmentChecks');
  if (!el) return;
  selected = selected || [];
  el.innerHTML = equipment.map(e => `
    <label><input type="checkbox" name="rsEquip" value="${e.id}" ${selected.includes(e.id) ? 'checked' : ''}>${esc(e.icon || '')} ${esc(e.name)}</label>`).join('')
    || '<div class="hint">등록된 장비가 없습니다</div>';
}

function openResearchModal(id) {
  editingResearchId = id || null;
  const item = id ? researchItems.find(r => r.id === id) : null;
  document.getElementById('researchModalTitle').textContent = item ? '연구 수정' : '새 연구 추가';
  document.getElementById('rsTitle').value = item ? item.title : '';
  document.getElementById('rsOwner').value = item ? item.owner : '';
  document.getElementById('rsDeadline').value = item ? item.deadline : '';
  document.getElementById('rsDesc').value = item ? (item.description || '') : '';
  document.getElementById('rsStatus').value = item ? item.status : '진행중';
  document.querySelectorAll('input[name="rsUrgency"]').forEach(r => { r.checked = r.value === (item ? item.urgency : 'medium'); });
  populateResearchEquipmentChecks(item ? item.equipment : []);
  document.getElementById('research-form-alert').innerHTML = '';
  document.getElementById('researchModal').classList.add('open');
}
function closeResearchModal() { document.getElementById('researchModal').classList.remove('open'); }

function saveResearchItem() {
  const title = document.getElementById('rsTitle').value.trim();
  const owner = document.getElementById('rsOwner').value.trim();
  const deadline = document.getElementById('rsDeadline').value;
  const urgencyEl = document.querySelector('input[name="rsUrgency"]:checked');
  const status = document.getElementById('rsStatus').value;
  const description = document.getElementById('rsDesc').value.trim();
  const equipSelected = Array.from(document.querySelectorAll('input[name="rsEquip"]:checked')).map(c => c.value);

  if (!title) return showAlert('research-form-alert', '연구명을 입력해주세요', 'error');
  if (!owner) return showAlert('research-form-alert', '담당자를 입력해주세요', 'error');
  if (!deadline) return showAlert('research-form-alert', '마감일을 선택해주세요', 'error');
  if (!urgencyEl) return showAlert('research-form-alert', '긴급도를 선택해주세요', 'error');

  if (editingResearchId) {
    const idx = researchItems.findIndex(r => r.id === editingResearchId);
    if (idx >= 0) {
      researchItems[idx] = { ...researchItems[idx], title, owner, deadline, urgency: urgencyEl.value, status, description, equipment: equipSelected };
    }
  } else {
    researchItems.push({ id: researchUid(), title, owner, deadline, urgency: urgencyEl.value, status, description, equipment: equipSelected, createdAt: new Date().toISOString() });
  }
  saveResearchItemsToStorage();
  closeResearchModal();
  renderResearchList();
  renderDashboardPriorityTasks();
}

function deleteResearchItem(id) {
  const item = researchItems.find(r => r.id === id);
  if (!item) return;
  if (!confirm(`"${item.title}" 연구를 삭제할까요?`)) return;
  researchItems = researchItems.filter(r => r.id !== id);
  saveResearchItemsToStorage();
  renderResearchList();
  renderDashboardPriorityTasks();
}

function openResearchDetail(id) {
  const item = researchItems.find(r => r.id === id);
  if (!item) return;
  const pr = PRIORITY_META[calcPriority(item.deadline, item.urgency)];
  const eqNames = (item.equipment || []).map(eid => {
    const e = equipment.find(x => x.id === eid);
    return e ? `${e.icon || ''} ${e.name}` : eid;
  }).join(', ') || '-';
  document.getElementById('researchDetailBody').innerHTML = `
    <div class="rc-row"><span>우선순위</span><b><span class="priority-chip ${pr.cls}">${pr.emoji} ${pr.label}</span></b></div>
    <div class="rc-row"><span>담당자</span><b>${esc(item.owner)}</b></div>
    <div class="rc-row"><span>마감일</span><b>${esc(item.deadline)} (${formatDaysRemaining(daysUntil(item.deadline))})</b></div>
    <div class="rc-row"><span>긴급도</span><b>${URGENCY_LABEL[item.urgency]}</b></div>
    <div class="rc-row"><span>상태</span><b>${esc(item.status)}</b></div>
    <div class="rc-row"><span>필요 장비</span><b>${esc(eqNames)}</b></div>
    ${item.description ? `<div class="qa-box" style="margin-top:10px;"><div class="qb-label">설명</div><div class="qb-body">${esc(item.description)}</div></div>` : ''}`;
  document.getElementById('researchDetailModal').classList.add('open');
}
function closeResearchDetail() { document.getElementById('researchDetailModal').classList.remove('open'); }

function goToScheduleFromResearch(id) {
  const item = researchItems.find(r => r.id === id);
  showPage('reservation', document.querySelector('[data-page="reservation"]'));
  const purposeEl = document.getElementById('resPurpose');
  if (purposeEl && item) purposeEl.value = item.title;
}

function filterResearch(tier, btn) {
  researchFilter = tier;
  document.querySelectorAll('.priority-filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderResearchList();
}

function researchCard(item) {
  const tier = calcPriority(item.deadline, item.urgency);
  const pr = PRIORITY_META[tier];
  const days = daysUntil(item.deadline);
  return `
    <div class="research-card">
      <div class="rc-title"><span class="priority-chip ${pr.cls}">${pr.emoji} ${pr.label}</span>${esc(item.title)}</div>
      <div class="rc-row"><span>담당</span><b>${esc(item.owner)}</b></div>
      <div class="rc-row"><span>마감</span><b>${esc(item.deadline)} (${formatDaysRemaining(days)})</b></div>
      <div class="rc-row"><span>긴급도</span><b>${URGENCY_LABEL[item.urgency]}</b></div>
      <div class="rc-row"><span>상태</span><b>${esc(item.status)}</b></div>
      <div class="rc-actions">
        <button class="btn btn-sm btn-ghost" onclick="goToScheduleFromResearch('${item.id}')">예약</button>
        <button class="btn btn-sm btn-ghost" onclick="openResearchDetail('${item.id}')">상세</button>
        <button class="btn btn-sm btn-ghost" onclick="openResearchModal('${item.id}')">수정</button>
        <button class="btn btn-sm btn-danger" onclick="deleteResearchItem('${item.id}')">삭제</button>
      </div>
    </div>`;
}

function renderResearchList() {
  const el = document.getElementById('researchList');
  if (!el) return;
  let list = sortedResearch();
  if (researchFilter !== 'all') list = list.filter(r => calcPriority(r.deadline, r.urgency) === researchFilter);
  el.innerHTML = list.length ? list.map(researchCard).join('') : emptyState('📋', '표시할 연구가 없습니다', '새 연구를 추가하거나 필터를 변경해보세요');
}

function renderDashboardPriorityTasks() {
  const el = document.getElementById('dashboardPriorityTasks');
  if (!el) return;
  const top = sortedResearch().filter(r => r.status !== '완료').slice(0, 3);
  if (!top.length) { el.innerHTML = emptyState('🎉', '우선 처리할 작업이 없습니다'); return; }
  el.innerHTML = top.map(item => {
    const pr = PRIORITY_META[calcPriority(item.deadline, item.urgency)];
    return `<div class="list-item">
      <div class="main">
        <div class="title">${pr.emoji} ${esc(item.title)}</div>
        <div class="sub">마감: ${esc(item.deadline)} · ${formatDaysRemaining(daysUntil(item.deadline))} · 담당 ${esc(item.owner)}</div>
      </div>
    </div>`;
  }).join('');
}

// ================================================== 초기화
document.addEventListener('DOMContentLoaded', () => {
  const now = new Date();
  document.getElementById('resDate').value = now.toISOString().slice(0, 10);
  document.getElementById('resStart').value = String(now.getHours()).padStart(2, '0') + ':00';
  document.getElementById('resDuration').value = 60;
  document.getElementById('resDate').addEventListener('change', loadTimeline);
  document.getElementById('resStart').addEventListener('change', updateEndPreview);
  document.getElementById('reportYear').value = now.getFullYear();
  document.getElementById('reportMonth').value = now.getMonth() + 1;
  updateEndPreview();

  seedResearchIfEmpty();
  renderResearchList();
  renderQaHistory();

  loadAll();
});
