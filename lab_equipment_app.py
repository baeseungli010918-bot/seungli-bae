"""XAM 연구실 장비 예약/소모품 관리 시스템 (Flask + SQLite)

실행:  python lab_equipment_app.py
접속:  http://localhost:5000        (일반 페이지)
       http://localhost:5000/admin  (관리자 페이지, PIN 필요 - 기본 1234)

관리자 PIN은 환경변수 LAB_ADMIN_PIN 으로 바꿀 수 있습니다.
  PowerShell 예시:  $env:LAB_ADMIN_PIN = "내PIN"; python lab_equipment_app.py

주의: 이 PIN 게이트는 진짜 로그인/인증이 아니라 관리 화면을 가벼운 방식으로
가려두는 수준입니다. 외부에 공개하는 서버라면 별도의 인증을 앞단에 두세요.
"""

from flask import Flask, request, jsonify, send_from_directory, send_file, Response
from datetime import datetime, timedelta
from functools import wraps
import io
import os
import sqlite3
import uuid

import qrcode
import qrcode.image.svg

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, 'lab_equipment.db')

app = Flask(__name__, static_folder='static', static_url_path='/static')
app.config['ADMIN_PIN'] = os.environ.get('LAB_ADMIN_PIN', '1234')

# 한글 PDF를 위한 내장 CID 폰트 등록 (별도 폰트 파일 불필요)
pdfmetrics.registerFont(UnicodeCIDFont('HYSMyeongJo-Medium'))


# =============================================================== 등급 정책

ROLES = {
    'admin':     {'label': '관리자',   'daily_minutes': None, 'monthly_usage_count': None},
    'phd':       {'label': '박사과정', 'daily_minutes': 240,   'monthly_usage_count': None},
    'master':    {'label': '석사과정', 'daily_minutes': 180,   'monthly_usage_count': 60},
    'undergrad': {'label': '학부생',   'daily_minutes': 120,   'monthly_usage_count': 30},
    'guest':     {'label': '손님',     'daily_minutes': 60,    'monthly_usage_count': 10},
}
DEFAULT_ROLE = 'undergrad'
WEEKDAY_KR = ['월', '화', '수', '목', '금', '토', '일']
EQUIPMENT_CATEGORY_ICON_DEFAULT = '🖨️'
CONSUMABLE_CATEGORIES = ['필라멘트', '레진', '노즐', '기타']


# =============================================================== DB

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def ensure_column(conn, table, col_def):
    """이미 있으면 조용히 무시하는 ALTER TABLE ADD COLUMN (기존 DB 무손실 마이그레이션용)."""
    col_name = col_def.split()[0]
    existing = {row['name'] for row in conn.execute(f'PRAGMA table_info({table})')}
    if col_name not in existing:
        conn.execute(f'ALTER TABLE {table} ADD COLUMN {col_def}')


def init_db():
    conn = get_db()
    c = conn.cursor()

    c.execute('''CREATE TABLE IF NOT EXISTS equipment (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 1,
        icon TEXT
    )''')
    ensure_column(conn, 'equipment', "status TEXT NOT NULL DEFAULT 'available'")
    ensure_column(conn, 'equipment', "hourly_cost REAL NOT NULL DEFAULT 0")
    ensure_column(conn, 'equipment', "total_usage_minutes REAL NOT NULL DEFAULT 0")
    ensure_column(conn, 'equipment', "maintenance_interval_hours REAL NOT NULL DEFAULT 40")
    ensure_column(conn, 'equipment', "last_maintenance_at TEXT")

    c.execute('''CREATE TABLE IF NOT EXISTS consumables (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        current_stock REAL NOT NULL DEFAULT 0,
        min_stock REAL NOT NULL DEFAULT 0,
        unit TEXT,
        icon TEXT
    )''')
    ensure_column(conn, 'consumables', "category TEXT NOT NULL DEFAULT '기타'")
    ensure_column(conn, 'consumables', "color TEXT NOT NULL DEFAULT '#3b82f6'")
    ensure_column(conn, 'consumables', "unit_price REAL NOT NULL DEFAULT 0")

    c.execute('''CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        equipment_id TEXT NOT NULL,
        equipment_name TEXT,
        reservation_date TEXT NOT NULL,
        start_time TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        purpose TEXT,
        status TEXT NOT NULL DEFAULT 'confirmed',
        created_at TEXT
    )''')
    ensure_column(conn, 'reservations', "recurring_group_id TEXT")
    ensure_column(conn, 'reservations', "participants TEXT")
    ensure_column(conn, 'reservations', "checkin_token TEXT")
    ensure_column(conn, 'reservations', "checked_in_at TEXT")
    ensure_column(conn, 'reservations', "checked_out_at TEXT")

    # 기존 행에 체크인 토큰이 없으면 채워준다
    rows_missing_token = conn.execute(
        'SELECT id FROM reservations WHERE checkin_token IS NULL'
    ).fetchall()
    for row in rows_missing_token:
        conn.execute(
            'UPDATE reservations SET checkin_token = ? WHERE id = ?',
            (uuid.uuid4().hex, row['id']),
        )

    c.execute('''CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_id TEXT,
        item_name TEXT,
        quantity_used REAL,
        unit TEXT,
        timestamp TEXT,
        notes TEXT
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT,
        type TEXT NOT NULL DEFAULT 'notice',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        created_by TEXT
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS user_roles (
        name TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'undergrad',
        updated_at TEXT
    )''')

    c.execute('''CREATE TABLE IF NOT EXISTS maintenance_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id TEXT NOT NULL,
        performed_at TEXT,
        note TEXT
    )''')

    # 기본 장비 (없을 때만)
    default_equipment = [
        ('h2d', 'Bambu Lab H2D', 2, '🔴'),
        ('p2s', 'Bambu Lab P2S', 6, '🟠'),
        ('a1', 'Bambu Lab A1', 4, '🟡'),
        ('filament', '필라멘트 압출기', 1, '🟢'),
        ('tensile', '인장시험기', 1, '🔵'),
    ]
    c.executemany(
        'INSERT OR IGNORE INTO equipment (id, name, quantity, icon) VALUES (?, ?, ?, ?)',
        default_equipment,
    )

    # 기본 소모품 (최초 1회만)
    if c.execute('SELECT COUNT(*) FROM consumables').fetchone()[0] == 0:
        c.executemany(
            '''INSERT INTO consumables
               (name, current_stock, min_stock, unit, icon, category, color, unit_price)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
            [
                ('PLA 필라멘트', 10.0, 2.0, 'kg', '🟡', '필라멘트', '#eab308', 25000),
                ('PETG 필라멘트', 5.0, 1.0, 'kg', '🔵', '필라멘트', '#3b82f6', 30000),
                ('ABS 필라멘트', 3.0, 1.0, 'kg', '🔴', '필라멘트', '#ef4444', 28000),
                ('노즐 0.4mm', 12, 3, 'ea', '⚪', '노즐', '#94a3b8', 8000),
                ('빌드 플레이트 접착제', 2, 1, 'ea', '🟢', '기타', '#22c55e', 12000),
            ],
        )

    conn.commit()
    conn.close()


# ============================================================ 시간 유틸

def to_minutes(hhmm):
    h, m = hhmm.split(':')[:2]
    return int(h) * 60 + int(m)


def to_hhmm(minutes):
    minutes = int(minutes)
    return '{:02d}:{:02d}'.format((minutes // 60) % 24, minutes % 60)


def now_str():
    return datetime.now().strftime('%Y-%m-%d %H:%M:%S')


def today_str():
    return datetime.now().strftime('%Y-%m-%d')


def parse_date(s):
    return datetime.strptime(s, '%Y-%m-%d')


# ======================================================= 예약 충돌/등급

def find_conflicts(conn, equipment_id, date, start_min, end_min, exclude_id=None):
    rows = conn.execute(
        '''SELECT * FROM reservations
           WHERE equipment_id = ? AND reservation_date = ? AND status = 'confirmed' ''',
        (equipment_id, date),
    ).fetchall()
    conflicts = []
    for row in rows:
        if exclude_id is not None and row['id'] == exclude_id:
            continue
        r_start = to_minutes(row['start_time'])
        r_end = r_start + int(row['duration_minutes'])
        if start_min < r_end and r_start < end_min:
            conflicts.append(row)
    return conflicts


def find_next_available_slot(conn, equipment_id, capacity, date_str, start_min, duration, search_days=3):
    """요청한 시간이 불가능할 때, 이후 며칠 내에서 가능한 다음 슬롯을 15분 단위로 탐색."""
    step = 15
    base_date = parse_date(date_str)
    for day_offset in range(search_days + 1):
        cur_date = base_date + timedelta(days=day_offset)
        cur_date_str = cur_date.strftime('%Y-%m-%d')
        begin = start_min if day_offset == 0 else 0
        t = begin
        while t + duration <= 24 * 60:
            conflicts = find_conflicts(conn, equipment_id, cur_date_str, t, t + duration)
            if len(conflicts) < capacity:
                return {
                    'date': cur_date_str,
                    'start_time': to_hhmm(t),
                    'end_time': to_hhmm(t + duration),
                }
            t += step
    return None


def get_user_role(conn, user):
    row = conn.execute('SELECT role FROM user_roles WHERE name = ?', (user,)).fetchone()
    role = row['role'] if row and row['role'] in ROLES else DEFAULT_ROLE
    return role


def check_daily_limit(conn, user, role, date, add_minutes):
    limit = ROLES[role]['daily_minutes']
    if limit is None:
        return True, None
    existing = conn.execute(
        '''SELECT COALESCE(SUM(duration_minutes), 0) AS m FROM reservations
           WHERE user = ? AND reservation_date = ? AND status = 'confirmed' ''',
        (user, date),
    ).fetchone()['m']
    if existing + add_minutes > limit:
        return False, '{} 등급은 하루 최대 {}분까지 예약할 수 있습니다 (현재 {}분 예약됨)'.format(
            ROLES[role]['label'], limit, existing)
    return True, None


def check_monthly_quota(conn, user, role):
    limit = ROLES[role]['monthly_usage_count']
    if limit is None:
        return True, None
    ym = datetime.now().strftime('%Y-%m')
    count = conn.execute(
        '''SELECT COUNT(*) FROM usage_log
           WHERE user = ? AND item_type = 'consumable' AND timestamp LIKE ?''',
        (user, ym + '%'),
    ).fetchone()[0]
    if count >= limit:
        return False, '{} 등급의 월간 소모품 사용 기록 한도({}회)를 초과했습니다'.format(
            ROLES[role]['label'], limit)
    return True, None


# ============================================================= 관리자 인증

def require_admin(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        pin = (
            request.headers.get('X-Admin-Pin')
            or request.args.get('admin_pin')
            or (request.get_json(silent=True) or {}).get('admin_pin')
        )
        if pin != app.config['ADMIN_PIN']:
            return jsonify({'success': False, 'error': '관리자 PIN이 올바르지 않습니다'}), 403
        return f(*args, **kwargs)
    return wrapper


@app.route('/api/admin/verify', methods=['POST'])
def verify_admin_pin():
    data = request.get_json(silent=True) or {}
    if data.get('admin_pin') == app.config['ADMIN_PIN']:
        return jsonify({'success': True})
    return jsonify({'success': False, 'error': 'PIN이 올바르지 않습니다'}), 403


# =================================================================== 페이지

@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'lab_equipment.html')


@app.route('/admin')
def admin_page():
    return send_from_directory(BASE_DIR, 'admin.html')


@app.route('/checkin/<token>')
def checkin_page(token):
    conn = get_db()
    r = conn.execute('SELECT * FROM reservations WHERE checkin_token = ?', (token,)).fetchone()
    conn.close()
    if r is None:
        return render_checkin_html('예약을 찾을 수 없습니다.', None, error=True), 404
    if r['status'] != 'confirmed':
        return render_checkin_html('취소된 예약입니다.', dict(r), error=True)
    return render_checkin_html(None, dict(r))


def render_checkin_html(error_msg, reservation, error=False):
    if error:
        body = f'<p class="checkin-error">⚠️ {error_msg}</p>'
    else:
        r = reservation
        end_time = to_hhmm(to_minutes(r['start_time']) + int(r['duration_minutes']))
        if r['checked_out_at']:
            state_label, btn_html = '체크아웃 완료', ''
        elif r['checked_in_at']:
            state_label = '체크인됨 · 사용 중'
            btn_html = '<button class="btn btn-primary" onclick="doAction()">체크아웃</button>'
        else:
            state_label = '체크인 대기'
            btn_html = '<button class="btn btn-primary" onclick="doAction()">체크인</button>'
        body = f'''
        <div class="checkin-card">
          <div class="checkin-badge">{state_label}</div>
          <h2>{r['equipment_name']}</h2>
          <p>👤 {r['user']} · 📅 {r['reservation_date']} {r['start_time']}~{end_time}</p>
          <p class="hint">{r['purpose'] or ''}</p>
          {btn_html}
          <div id="checkinResult"></div>
        </div>
        <script>
        async function doAction() {{
          const res = await fetch('/api/checkin/{r["checkin_token"]}', {{method:'POST'}});
          const data = await res.json();
          document.getElementById('checkinResult').innerHTML =
            data.success ? `<p class="checkin-ok">✅ ${{data.message}}</p>` : `<p class="checkin-error">⚠️ ${{data.error}}</p>`;
          setTimeout(() => location.reload(), 1200);
        }}
        </script>'''
    return f'''<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>체크인 · XAM Lab</title>
<link rel="stylesheet" href="/static/style.css">
<style>
  body {{ display:flex; align-items:center; justify-content:center; min-height:100vh; }}
  .checkin-card {{ background:var(--surface); border:1px solid var(--border); border-radius:16px;
    padding:32px; max-width:380px; width:90%; text-align:center; }}
  .checkin-badge {{ display:inline-block; padding:4px 12px; border-radius:20px; font-size:12px;
    background:var(--accent-soft); color:var(--accent); margin-bottom:12px; font-weight:600; }}
  .checkin-ok {{ color:var(--success); margin-top:14px; }}
  .checkin-error {{ color:var(--danger); margin-top:14px; text-align:center; }}
</style></head>
<body data-theme="">
{body}
</body></html>'''


@app.route('/api/checkin/<token>', methods=['POST'])
def do_checkin(token):
    conn = get_db()
    r = conn.execute('SELECT * FROM reservations WHERE checkin_token = ?', (token,)).fetchone()
    if r is None:
        conn.close()
        return jsonify({'success': False, 'error': '예약을 찾을 수 없습니다'}), 404
    if r['status'] != 'confirmed':
        conn.close()
        return jsonify({'success': False, 'error': '취소된 예약입니다'}), 400

    if not r['checked_in_at']:
        conn.execute(
            'UPDATE reservations SET checked_in_at = ? WHERE id = ?', (now_str(), r['id'])
        )
        conn.execute(
            "UPDATE equipment SET status = 'in_use' WHERE id = ? AND status = 'available'",
            (r['equipment_id'],),
        )
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'action': 'checked_in', 'message': '체크인되었습니다. 즐거운 실험 되세요!'})

    if not r['checked_out_at']:
        checkin_dt = datetime.strptime(r['checked_in_at'], '%Y-%m-%d %H:%M:%S')
        checkout_dt = datetime.now()
        used_minutes = max((checkout_dt - checkin_dt).total_seconds() / 60, 0)

        conn.execute(
            'UPDATE reservations SET checked_out_at = ? WHERE id = ?', (now_str(), r['id'])
        )
        conn.execute(
            'UPDATE equipment SET total_usage_minutes = total_usage_minutes + ? WHERE id = ?',
            (used_minutes, r['equipment_id']),
        )
        # 같은 장비를 체크인 중인 다른 예약이 없으면 상태를 available 로 되돌림
        still_active = conn.execute(
            '''SELECT COUNT(*) FROM reservations
               WHERE equipment_id = ? AND status = 'confirmed'
                 AND checked_in_at IS NOT NULL AND checked_out_at IS NULL AND id != ?''',
            (r['equipment_id'], r['id']),
        ).fetchone()[0]
        if still_active == 0:
            conn.execute(
                "UPDATE equipment SET status = 'available' WHERE id = ? AND status = 'in_use'",
                (r['equipment_id'],),
            )
        conn.commit()
        conn.close()
        return jsonify({
            'success': True, 'action': 'checked_out',
            'message': '체크아웃 완료 (사용 시간 {:.0f}분)'.format(used_minutes),
        })

    conn.close()
    return jsonify({'success': False, 'error': '이미 체크인/체크아웃이 완료된 예약입니다'}), 400


@app.route('/api/reservations/<int:reservation_id>/qr')
def reservation_qr(reservation_id):
    conn = get_db()
    r = conn.execute('SELECT checkin_token FROM reservations WHERE id = ?', (reservation_id,)).fetchone()
    conn.close()
    if r is None:
        return jsonify({'error': '예약을 찾을 수 없습니다'}), 404

    checkin_url = request.host_url.rstrip('/') + '/checkin/' + r['checkin_token']
    img = qrcode.make(checkin_url, image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), mimetype='image/svg+xml')


# =============================================================== 장비 (공개)

@app.route('/api/equipment', methods=['GET'])
def get_equipment():
    """홈페이지용: 수량은 노출하지 않는다."""
    conn = get_db()
    rows = conn.execute(
        'SELECT id, name, icon, status FROM equipment ORDER BY rowid'
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/equipment/<equipment_id>/availability', methods=['GET'])
def equipment_availability(equipment_id):
    date = request.args.get('date', today_str())
    conn = get_db()
    eq = conn.execute('SELECT * FROM equipment WHERE id = ?', (equipment_id,)).fetchone()
    if eq is None:
        conn.close()
        return jsonify({'error': '장비를 찾을 수 없습니다'}), 404

    rows = conn.execute(
        '''SELECT * FROM reservations
           WHERE equipment_id = ? AND reservation_date = ? AND status = 'confirmed'
           ORDER BY start_time''',
        (equipment_id, date),
    ).fetchall()
    conn.close()

    slots = []
    for r in rows:
        start = to_minutes(r['start_time'])
        slots.append({
            'id': r['id'],
            'user': r['user'],
            'start_time': r['start_time'],
            'end_time': to_hhmm(start + int(r['duration_minutes'])),
            'duration_minutes': r['duration_minutes'],
            'purpose': r['purpose'],
        })

    return jsonify({
        'equipment_id': equipment_id,
        'equipment_name': eq['name'],
        'status': eq['status'],
        'date': date,
        'slots': slots,
    })


# =============================================================== 장비 (관리자)

@app.route('/api/admin/equipment', methods=['GET'])
@require_admin
def admin_list_equipment():
    conn = get_db()
    rows = conn.execute('SELECT * FROM equipment ORDER BY rowid').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/admin/equipment', methods=['POST'])
@require_admin
def admin_add_equipment():
    data = request.get_json(silent=True) or {}
    eq_id = (data.get('id') or '').strip().lower()
    name = (data.get('name') or '').strip()
    if not eq_id or not name:
        return jsonify({'success': False, 'error': '장비 ID와 이름은 필수입니다'}), 400

    try:
        quantity = int(data.get('quantity', 1))
        hourly_cost = float(data.get('hourly_cost', 0) or 0)
        maint_hours = float(data.get('maintenance_interval_hours', 40) or 40)
    except (TypeError, ValueError):
        return jsonify({'success': False, 'error': '수량/비용/점검 주기는 숫자로 입력해주세요'}), 400
    if quantity < 1:
        return jsonify({'success': False, 'error': '수량은 1 이상이어야 합니다'}), 400

    conn = get_db()
    try:
        conn.execute(
            '''INSERT INTO equipment
               (id, name, quantity, icon, status, hourly_cost, maintenance_interval_hours)
               VALUES (?, ?, ?, ?, 'available', ?, ?)''',
            (eq_id, name, quantity, data.get('icon') or EQUIPMENT_CATEGORY_ICON_DEFAULT,
             hourly_cost, maint_hours),
        )
        conn.commit()
        return jsonify({'success': True})
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': '이미 존재하는 장비 ID입니다'}), 400
    finally:
        conn.close()


@app.route('/api/admin/equipment/<equipment_id>', methods=['PUT'])
@require_admin
def admin_update_equipment(equipment_id):
    data = request.get_json(silent=True) or {}
    conn = get_db()
    eq = conn.execute('SELECT * FROM equipment WHERE id = ?', (equipment_id,)).fetchone()
    if eq is None:
        conn.close()
        return jsonify({'success': False, 'error': '장비를 찾을 수 없습니다'}), 404

    fields, values = [], []
    if 'name' in data:
        fields.append('name = ?'); values.append((data.get('name') or eq['name']).strip())
    if 'icon' in data:
        fields.append('icon = ?'); values.append(data.get('icon') or eq['icon'])
    if 'quantity' in data:
        try:
            q = int(data['quantity'])
        except (TypeError, ValueError):
            conn.close()
            return jsonify({'success': False, 'error': '수량은 숫자로 입력해주세요'}), 400
        if q < 1:
            conn.close()
            return jsonify({'success': False, 'error': '수량은 1 이상이어야 합니다'}), 400
        fields.append('quantity = ?'); values.append(q)
    if 'status' in data:
        if data['status'] not in ('available', 'in_use', 'maintenance'):
            conn.close()
            return jsonify({'success': False, 'error': '상태 값이 올바르지 않습니다'}), 400
        fields.append('status = ?'); values.append(data['status'])
    if 'hourly_cost' in data:
        try:
            fields.append('hourly_cost = ?'); values.append(float(data['hourly_cost']))
        except (TypeError, ValueError):
            conn.close()
            return jsonify({'success': False, 'error': '시간당 비용은 숫자로 입력해주세요'}), 400
    if 'maintenance_interval_hours' in data:
        try:
            fields.append('maintenance_interval_hours = ?'); values.append(float(data['maintenance_interval_hours']))
        except (TypeError, ValueError):
            conn.close()
            return jsonify({'success': False, 'error': '점검 주기는 숫자로 입력해주세요'}), 400

    if not fields:
        conn.close()
        return jsonify({'success': False, 'error': '수정할 값이 없습니다'}), 400

    values.append(equipment_id)
    conn.execute(f'UPDATE equipment SET {", ".join(fields)} WHERE id = ?', values)
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/admin/equipment/<equipment_id>', methods=['DELETE'])
@require_admin
def admin_delete_equipment(equipment_id):
    conn = get_db()
    future = conn.execute(
        '''SELECT COUNT(*) FROM reservations
           WHERE equipment_id = ? AND status = 'confirmed' AND reservation_date >= ?''',
        (equipment_id, today_str()),
    ).fetchone()[0]
    if future > 0:
        conn.close()
        return jsonify({
            'success': False,
            'error': f'예정된 예약이 {future}건 있어 삭제할 수 없습니다. 먼저 예약을 취소해주세요',
        }), 400

    conn.execute('DELETE FROM equipment WHERE id = ?', (equipment_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/admin/equipment/<equipment_id>/complete-maintenance', methods=['POST'])
@require_admin
def complete_maintenance(equipment_id):
    data = request.get_json(silent=True) or {}
    conn = get_db()
    eq = conn.execute('SELECT * FROM equipment WHERE id = ?', (equipment_id,)).fetchone()
    if eq is None:
        conn.close()
        return jsonify({'success': False, 'error': '장비를 찾을 수 없습니다'}), 404

    conn.execute(
        'INSERT INTO maintenance_log (equipment_id, performed_at, note) VALUES (?, ?, ?)',
        (equipment_id, now_str(), (data.get('note') or '').strip()),
    )
    conn.execute(
        '''UPDATE equipment
           SET total_usage_minutes = 0, last_maintenance_at = ?, status = 'available'
           WHERE id = ?''',
        (now_str(), equipment_id),
    )
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/admin/equipment/<equipment_id>/maintenance-log', methods=['GET'])
@require_admin
def get_maintenance_log(equipment_id):
    conn = get_db()
    rows = conn.execute(
        'SELECT * FROM maintenance_log WHERE equipment_id = ? ORDER BY id DESC', (equipment_id,)
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


# ================================================================ 소모품

@app.route('/api/consumables', methods=['GET'])
def get_consumables():
    conn = get_db()
    rows = conn.execute('SELECT * FROM consumables ORDER BY category, name').fetchall()
    conn.close()

    result = []
    for r in rows:
        d = dict(r)
        d['low_stock'] = r['current_stock'] < r['min_stock']
        d['shortage'] = max(r['min_stock'] - r['current_stock'], 0)
        result.append(d)
    return jsonify(result)


@app.route('/api/consumables/low-stock', methods=['GET'])
def get_low_stock():
    conn = get_db()
    rows = conn.execute(
        'SELECT * FROM consumables WHERE current_stock < min_stock ORDER BY (min_stock - current_stock) DESC'
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        d['shortage'] = round(r['min_stock'] - r['current_stock'], 3)
        result.append(d)
    return jsonify(result)


@app.route('/api/consumables', methods=['POST'])
def add_consumable():
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'success': False, 'error': '소모품명을 입력해주세요'}), 400

    try:
        stock = float(data.get('stock', 0) or 0)
        min_stock = float(data.get('min_stock', 0) or 0)
        unit_price = float(data.get('unit_price', 0) or 0)
    except (TypeError, ValueError):
        return jsonify({'success': False, 'error': '숫자 항목을 올바르게 입력해주세요'}), 400

    category = data.get('category') or '기타'
    if category not in CONSUMABLE_CATEGORIES:
        category = '기타'

    conn = get_db()
    try:
        cur = conn.execute(
            '''INSERT INTO consumables
               (name, current_stock, min_stock, unit, icon, category, color, unit_price)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
            (name, stock, min_stock, data.get('unit') or 'ea', data.get('icon') or '📦',
             category, data.get('color') or '#3b82f6', unit_price),
        )
        conn.commit()
        return jsonify({'success': True, 'id': cur.lastrowid})
    except sqlite3.IntegrityError:
        return jsonify({'success': False, 'error': '이미 등록된 소모품명입니다'}), 400
    finally:
        conn.close()


@app.route('/api/consumables/<int:consumable_id>', methods=['PUT'])
def update_consumable(consumable_id):
    data = request.get_json(silent=True) or {}
    conn = get_db()
    row = conn.execute('SELECT * FROM consumables WHERE id = ?', (consumable_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify({'success': False, 'error': '소모품을 찾을 수 없습니다'}), 404

    try:
        if 'delta' in data:
            new_stock = float(row['current_stock']) + float(data['delta'])
        else:
            new_stock = float(data.get('stock', row['current_stock']))
        min_stock = float(data.get('min_stock', row['min_stock']))
        unit_price = float(data.get('unit_price', row['unit_price']))
    except (TypeError, ValueError):
        conn.close()
        return jsonify({'success': False, 'error': '숫자를 입력해주세요'}), 400

    if new_stock < 0:
        conn.close()
        return jsonify({'success': False, 'error': '재고는 0보다 작을 수 없습니다'}), 400

    category = data.get('category', row['category'])
    if category not in CONSUMABLE_CATEGORIES:
        category = row['category']
    color = data.get('color', row['color'])

    conn.execute(
        '''UPDATE consumables
           SET current_stock = ?, min_stock = ?, unit_price = ?, category = ?, color = ?
           WHERE id = ?''',
        (new_stock, min_stock, unit_price, category, color, consumable_id),
    )
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'current_stock': new_stock})


@app.route('/api/consumables/<int:consumable_id>', methods=['DELETE'])
def delete_consumable(consumable_id):
    conn = get_db()
    conn.execute('DELETE FROM consumables WHERE id = ?', (consumable_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


# =============================================================== 예약

@app.route('/api/roles', methods=['GET'])
def get_roles():
    return jsonify({key: val for key, val in ROLES.items()})


@app.route('/api/reservations', methods=['GET'])
def get_reservations():
    date = request.args.get('date')
    conn = get_db()
    if date:
        rows = conn.execute(
            '''SELECT * FROM reservations
               WHERE status != 'cancelled' AND reservation_date = ?
               ORDER BY reservation_date DESC, start_time''',
            (date,),
        ).fetchall()
    else:
        rows = conn.execute(
            '''SELECT * FROM reservations
               WHERE status != 'cancelled'
               ORDER BY reservation_date DESC, start_time''',
        ).fetchall()
    conn.close()

    result = []
    for r in rows:
        d = dict(r)
        d['end_time'] = to_hhmm(to_minutes(r['start_time']) + int(r['duration_minutes']))
        result.append(d)
    return jsonify(result)


def create_single_reservation(conn, user, role, equipment_id, eq, date, start_time, duration, purpose,
                               participants, group_id):
    start_min = to_minutes(start_time)
    end_min = start_min + duration
    if end_min > 24 * 60:
        return {'success': False, 'date': date, 'error': '예약이 자정을 넘습니다'}

    ok, err = check_daily_limit(conn, user, role, date, duration)
    if not ok:
        return {'success': False, 'date': date, 'error': err}

    conflicts = find_conflicts(conn, equipment_id, date, start_min, end_min)
    if len(conflicts) >= eq['quantity']:
        suggestion = find_next_available_slot(conn, equipment_id, eq['quantity'], date, start_min, duration)
        return {
            'success': False, 'date': date,
            'error': f'{eq["name"]} 예약 가능 대수가 모두 사용 중입니다',
            'suggested_slot': suggestion,
        }

    token = uuid.uuid4().hex
    cur = conn.execute(
        '''INSERT INTO reservations
           (user, equipment_id, equipment_name, reservation_date, start_time, duration_minutes,
            purpose, status, created_at, recurring_group_id, participants, checkin_token)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)''',
        (user, equipment_id, eq['name'], date, start_time, duration, purpose,
         now_str(), group_id, participants, token),
    )
    conn.execute(
        '''INSERT INTO usage_log
           (user, item_type, item_id, item_name, quantity_used, unit, timestamp, notes)
           VALUES (?, 'equipment', ?, ?, ?, 'min', ?, ?)''',
        (user, equipment_id, eq['name'], duration, now_str(),
         f'예약 {date} {start_time}~{to_hhmm(end_min)}'),
    )
    return {
        'success': True, 'date': date, 'id': cur.lastrowid,
        'end_time': to_hhmm(end_min), 'checkin_token': token,
    }


@app.route('/api/reservations', methods=['POST'])
def create_reservation():
    data = request.get_json(silent=True) or {}

    user = (data.get('user') or '').strip()
    equipment_id = data.get('equipment_id')
    date = data.get('date')
    start_time = data.get('start_time')
    purpose = (data.get('purpose') or '').strip()
    participants = (data.get('participants') or '').strip()

    if not user:
        return jsonify({'success': False, 'error': '이름을 입력해주세요'}), 400
    if not equipment_id:
        return jsonify({'success': False, 'error': '장비를 선택해주세요'}), 400
    if not date or not start_time:
        return jsonify({'success': False, 'error': '날짜와 시작 시간을 입력해주세요'}), 400

    try:
        duration = int(data.get('duration_minutes'))
    except (TypeError, ValueError):
        return jsonify({'success': False, 'error': '소요 시간을 숫자로 입력해주세요'}), 400
    if not 5 <= duration <= 1440:
        return jsonify({'success': False, 'error': '소요 시간은 5분 ~ 1440분 사이여야 합니다'}), 400

    try:
        repeat_weeks = int(data.get('repeat_weeks', 0) or 0)
    except (TypeError, ValueError):
        repeat_weeks = 0
    repeat_weeks = max(0, min(repeat_weeks, 12))

    conn = get_db()
    eq = conn.execute('SELECT * FROM equipment WHERE id = ?', (equipment_id,)).fetchone()
    if eq is None:
        conn.close()
        return jsonify({'success': False, 'error': '존재하지 않는 장비입니다'}), 400
    if eq['status'] == 'maintenance':
        conn.close()
        return jsonify({'success': False, 'error': f'{eq["name"]}은(는) 현재 점검 중이라 예약할 수 없습니다'}), 400

    role = get_user_role(conn, user)
    group_id = uuid.uuid4().hex if repeat_weeks > 0 else None
    base_date = parse_date(date)

    results = []
    for i in range(repeat_weeks + 1):
        cur_date = (base_date + timedelta(weeks=i)).strftime('%Y-%m-%d')
        results.append(create_single_reservation(
            conn, user, role, equipment_id, eq, cur_date, start_time, duration,
            purpose, participants, group_id,
        ))

    conn.commit()
    conn.close()

    succeeded = [r for r in results if r['success']]
    failed = [r for r in results if not r['success']]

    if repeat_weeks == 0:
        r = results[0]
        status_code = 200 if r['success'] else 409
        return jsonify(r), status_code

    return jsonify({
        'success': len(succeeded) > 0,
        'created': succeeded,
        'failed': failed,
        'summary': f'{len(succeeded)}건 생성, {len(failed)}건 실패 (총 {len(results)}주)',
    })


@app.route('/api/reservations/<int:reservation_id>', methods=['DELETE'])
def cancel_reservation(reservation_id):
    conn = get_db()
    row = conn.execute('SELECT * FROM reservations WHERE id = ?', (reservation_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify({'success': False, 'error': '예약을 찾을 수 없습니다'}), 404

    conn.execute('UPDATE reservations SET status = ? WHERE id = ?', ('cancelled', reservation_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


# ============================================================= 사용 기록

@app.route('/api/usage-log', methods=['GET'])
def get_usage_log():
    limit = request.args.get('limit', 100, type=int)
    conn = get_db()
    rows = conn.execute('SELECT * FROM usage_log ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/usage-log', methods=['POST'])
def add_usage_log():
    data = request.get_json(silent=True) or {}
    user = (data.get('user') or '').strip()
    item_type = data.get('item_type')
    item_id = data.get('item_id')

    if not user:
        return jsonify({'success': False, 'error': '사용자명을 입력해주세요'}), 400
    if item_type not in ('equipment', 'consumable'):
        return jsonify({'success': False, 'error': '항목 종류가 올바르지 않습니다'}), 400
    if not item_id:
        return jsonify({'success': False, 'error': '항목을 선택해주세요'}), 400

    try:
        quantity = float(data.get('quantity_used', 0) or 0)
    except (TypeError, ValueError):
        return jsonify({'success': False, 'error': '사용량을 숫자로 입력해주세요'}), 400
    if quantity <= 0:
        return jsonify({'success': False, 'error': '사용량은 0보다 커야 합니다'}), 400

    conn = get_db()

    if item_type == 'consumable':
        role = get_user_role(conn, user)
        ok, err = check_monthly_quota(conn, user, role)
        if not ok:
            conn.close()
            return jsonify({'success': False, 'error': err}), 400

        row = conn.execute('SELECT * FROM consumables WHERE id = ?', (item_id,)).fetchone()
        if row is None:
            conn.close()
            return jsonify({'success': False, 'error': '소모품을 찾을 수 없습니다'}), 404
        if row['current_stock'] < quantity:
            conn.close()
            return jsonify({
                'success': False,
                'error': f'재고 부족: 현재 {row["current_stock"]} {row["unit"]} 남음',
            }), 400

        item_name, unit = row['name'], row['unit']
        conn.execute(
            'UPDATE consumables SET current_stock = current_stock - ? WHERE id = ?',
            (quantity, item_id),
        )
    else:
        row = conn.execute('SELECT * FROM equipment WHERE id = ?', (item_id,)).fetchone()
        if row is None:
            conn.close()
            return jsonify({'success': False, 'error': '장비를 찾을 수 없습니다'}), 404
        item_name, unit = row['name'], 'min'

    conn.execute(
        '''INSERT INTO usage_log
           (user, item_type, item_id, item_name, quantity_used, unit, timestamp, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
        (user, item_type, str(item_id), item_name, quantity, unit, now_str(),
         (data.get('notes') or '').strip()),
    )
    conn.commit()
    conn.close()
    return jsonify({'success': True})


# ============================================================= 공지사항

@app.route('/api/announcements', methods=['GET'])
def get_announcements():
    conn = get_db()
    rows = conn.execute(
        'SELECT * FROM announcements ORDER BY pinned DESC, id DESC LIMIT 30'
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/admin/announcements', methods=['POST'])
@require_admin
def add_announcement():
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or '').strip()
    if not title:
        return jsonify({'success': False, 'error': '제목을 입력해주세요'}), 400

    ann_type = data.get('type') if data.get('type') in ('notice', 'maintenance', 'rule') else 'notice'
    conn = get_db()
    cur = conn.execute(
        '''INSERT INTO announcements (title, body, type, pinned, created_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?)''',
        (title, (data.get('body') or '').strip(), ann_type, 1 if data.get('pinned') else 0,
         now_str(), (data.get('created_by') or '관리자').strip()),
    )
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'id': cur.lastrowid})


@app.route('/api/admin/announcements/<int:ann_id>', methods=['PUT'])
@require_admin
def update_announcement(ann_id):
    data = request.get_json(silent=True) or {}
    conn = get_db()
    row = conn.execute('SELECT * FROM announcements WHERE id = ?', (ann_id,)).fetchone()
    if row is None:
        conn.close()
        return jsonify({'success': False, 'error': '공지사항을 찾을 수 없습니다'}), 404

    ann_type = data.get('type', row['type'])
    if ann_type not in ('notice', 'maintenance', 'rule'):
        ann_type = row['type']

    conn.execute(
        '''UPDATE announcements SET title = ?, body = ?, type = ?, pinned = ? WHERE id = ?''',
        (data.get('title', row['title']), data.get('body', row['body']), ann_type,
         1 if data.get('pinned', row['pinned']) else 0, ann_id),
    )
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/admin/announcements/<int:ann_id>', methods=['DELETE'])
@require_admin
def delete_announcement(ann_id):
    conn = get_db()
    conn.execute('DELETE FROM announcements WHERE id = ?', (ann_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


# ============================================================= 사용자 등급

@app.route('/api/admin/users', methods=['GET'])
@require_admin
def admin_list_users():
    conn = get_db()
    names = set()
    for row in conn.execute('SELECT DISTINCT user FROM reservations'):
        names.add(row['user'])
    for row in conn.execute('SELECT DISTINCT user FROM usage_log'):
        names.add(row['user'])
    for row in conn.execute('SELECT name FROM user_roles'):
        names.add(row['name'])

    role_map = {row['name']: row['role'] for row in conn.execute('SELECT * FROM user_roles')}
    result = []
    for name in sorted(names):
        res_count = conn.execute(
            "SELECT COUNT(*) FROM reservations WHERE user = ? AND status = 'confirmed'", (name,)
        ).fetchone()[0]
        result.append({
            'name': name,
            'role': role_map.get(name, DEFAULT_ROLE),
            'reservation_count': res_count,
        })
    conn.close()
    return jsonify(result)


@app.route('/api/admin/users/<path:name>', methods=['PUT'])
@require_admin
def admin_set_role(name):
    data = request.get_json(silent=True) or {}
    role = data.get('role')
    if role not in ROLES:
        return jsonify({'success': False, 'error': '등급 값이 올바르지 않습니다'}), 400

    conn = get_db()
    conn.execute(
        '''INSERT INTO user_roles (name, role, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at''',
        (name, role, now_str()),
    )
    conn.commit()
    conn.close()
    return jsonify({'success': True})


# =================================================================== AI

@app.route('/api/ai/best-time/<equipment_id>', methods=['GET'])
def ai_best_time(equipment_id):
    conn = get_db()
    eq = conn.execute('SELECT * FROM equipment WHERE id = ?', (equipment_id,)).fetchone()
    if eq is None:
        conn.close()
        return jsonify({'error': '장비를 찾을 수 없습니다'}), 404

    cutoff = (datetime.now() - timedelta(days=90)).strftime('%Y-%m-%d')
    rows = conn.execute(
        '''SELECT reservation_date, start_time FROM reservations
           WHERE equipment_id = ? AND status = 'confirmed' AND reservation_date >= ?''',
        (equipment_id, cutoff),
    ).fetchall()
    conn.close()

    if len(rows) < 5:
        return jsonify({
            'available': False,
            'message': f'{eq["name"]}의 예약 데이터가 아직 충분하지 않아요 (최근 90일 {len(rows)}건). '
                       f'예약이 더 쌓이면 추천이 표시됩니다.',
        })

    counts = {}
    for r in rows:
        wd = parse_date(r['reservation_date']).weekday()
        hour = to_minutes(r['start_time']) // 60
        if 9 <= hour < 18:
            counts[(wd, hour)] = counts.get((wd, hour), 0) + 1

    slots = [(wd, hour) for wd in range(5) for hour in range(9, 18)]
    slots.sort(key=lambda s: counts.get(s, 0))
    best_wd, best_hour = slots[0]
    ampm = '오전' if best_hour < 12 else '오후'

    return jsonify({
        'available': True,
        'weekday': WEEKDAY_KR[best_wd],
        'hour': best_hour,
        'message': f'{eq["name"]}은(는) 보통 {WEEKDAY_KR[best_wd]}요일 {ampm}({best_hour}시 전후)에 비어있어요 '
                   f'(최근 90일 예약 {len(rows)}건 분석)',
    })


@app.route('/api/ai/consumable-forecast', methods=['GET'])
def ai_consumable_forecast():
    conn = get_db()
    consumables = conn.execute('SELECT * FROM consumables').fetchall()
    cutoff_dt = datetime.now() - timedelta(days=30)
    cutoff_str = cutoff_dt.strftime('%Y-%m-%d %H:%M:%S')

    forecasts = []
    for c in consumables:
        rows = conn.execute(
            '''SELECT quantity_used, timestamp FROM usage_log
               WHERE item_type = 'consumable' AND item_id = ? AND timestamp >= ?''',
            (str(c['id']), cutoff_str),
        ).fetchall()

        total_used = sum(r['quantity_used'] for r in rows)
        if not rows or total_used <= 0:
            forecasts.append({
                'id': c['id'], 'name': c['name'], 'icon': c['icon'], 'unit': c['unit'],
                'available': False,
                'message': f'{c["name"]}의 최근 30일 사용 기록이 부족해 예측할 수 없어요.',
            })
            continue

        first_ts = min(datetime.strptime(r['timestamp'], '%Y-%m-%d %H:%M:%S') for r in rows)
        days_observed = max((datetime.now() - first_ts).total_seconds() / 86400, 1)
        weekly_avg = total_used / (days_observed / 7)
        weeks_remaining = (c['current_stock'] / weekly_avg) if weekly_avg > 0 else None

        forecasts.append({
            'id': c['id'], 'name': c['name'], 'icon': c['icon'], 'unit': c['unit'],
            'available': True,
            'weekly_avg': round(weekly_avg, 2),
            'weeks_remaining': round(weeks_remaining, 1) if weeks_remaining is not None else None,
            'message': (
                f'지난 30일간 주당 평균 {weekly_avg:.2f}{c["unit"]} 사용 → '
                f'현재 재고로 약 {weeks_remaining:.1f}주 사용 가능'
                if weeks_remaining is not None else
                f'지난 30일간 주당 평균 {weekly_avg:.2f}{c["unit"]} 사용'
            ),
        })

    conn.close()
    return jsonify(forecasts)


@app.route('/api/ai/maintenance-alerts', methods=['GET'])
def ai_maintenance_alerts():
    conn = get_db()
    rows = conn.execute('SELECT * FROM equipment').fetchall()
    conn.close()

    alerts = []
    for eq in rows:
        interval = eq['maintenance_interval_hours'] or 40
        used_hours = (eq['total_usage_minutes'] or 0) / 60
        ratio = used_hours / interval if interval > 0 else 0
        if eq['status'] == 'maintenance':
            level = 'in_progress'
        elif ratio >= 1:
            level = 'overdue'
        elif ratio >= 0.8:
            level = 'soon'
        else:
            continue
        alerts.append({
            'id': eq['id'], 'name': eq['name'], 'icon': eq['icon'], 'level': level,
            'used_hours': round(used_hours, 1), 'interval_hours': interval,
            'message': {
                'in_progress': f'{eq["name"]} 점검 진행 중',
                'overdue': f'{eq["name"]} 점검 주기 초과 ({used_hours:.1f}h / {interval}h) — 점검이 필요해요',
                'soon': f'{eq["name"]} 곧 점검이 필요해요 ({used_hours:.1f}h / {interval}h)',
            }[level],
        })
    alerts.sort(key=lambda a: {'overdue': 0, 'in_progress': 1, 'soon': 2}[a['level']])
    return jsonify(alerts)


# ============================================================== 대시보드

@app.route('/api/dashboard', methods=['GET'])
def dashboard():
    conn = get_db()

    weekly_usage = []
    for i in range(6, -1, -1):
        d = (datetime.now() - timedelta(days=i)).strftime('%Y-%m-%d')
        wd = parse_date(d).weekday()
        minutes = conn.execute(
            '''SELECT COALESCE(SUM(duration_minutes), 0) FROM reservations
               WHERE reservation_date = ? AND status = 'confirmed' ''', (d,)
        ).fetchone()[0]
        weekly_usage.append({'date': d, 'weekday': WEEKDAY_KR[wd], 'minutes': minutes})

    cutoff = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')

    top_equipment = [dict(r) for r in conn.execute(
        '''SELECT e.id, e.name, e.icon, COUNT(r.id) AS count,
                  COALESCE(SUM(r.duration_minutes), 0) AS minutes
           FROM equipment e JOIN reservations r ON r.equipment_id = e.id
           WHERE r.status = 'confirmed' AND r.reservation_date >= ?
           GROUP BY e.id ORDER BY count DESC LIMIT 3''', (cutoff,)
    ).fetchall()]

    top_users = [dict(r) for r in conn.execute(
        '''SELECT user, COUNT(*) AS count, COALESCE(SUM(duration_minutes), 0) AS minutes
           FROM reservations WHERE status = 'confirmed' AND reservation_date >= ?
           GROUP BY user ORDER BY minutes DESC LIMIT 5''', (cutoff,)
    ).fetchall()]

    low_stock = [dict(r) for r in conn.execute(
        'SELECT * FROM consumables WHERE current_stock < min_stock'
    ).fetchall()]
    for r in low_stock:
        r['shortage'] = round(r['min_stock'] - r['current_stock'], 3)

    announcements = [dict(r) for r in conn.execute(
        'SELECT * FROM announcements ORDER BY pinned DESC, id DESC LIMIT 5'
    ).fetchall()]

    conn.close()

    return jsonify({
        'weekly_usage': weekly_usage,
        'top_equipment': top_equipment,
        'top_users': top_users,
        'low_stock': low_stock,
        'announcements': announcements,
    })


@app.route('/api/stats', methods=['GET'])
def get_stats():
    conn = get_db()
    c = conn.cursor()

    total_res = c.execute("SELECT COUNT(*) FROM reservations WHERE status = 'confirmed'").fetchone()[0]
    users = c.execute("SELECT COUNT(DISTINCT user) FROM reservations WHERE status = 'confirmed'").fetchone()[0]
    total_minutes = c.execute(
        "SELECT COALESCE(SUM(duration_minutes), 0) FROM reservations WHERE status = 'confirmed'"
    ).fetchone()[0]
    log_count = c.execute('SELECT COUNT(*) FROM usage_log').fetchone()[0]

    by_equipment = [dict(r) for r in c.execute(
        '''SELECT e.id, e.name, e.icon,
                  COUNT(r.id) AS reservation_count,
                  COALESCE(SUM(r.duration_minutes), 0) AS total_minutes,
                  COUNT(DISTINCT r.user) AS user_count
           FROM equipment e
           LEFT JOIN reservations r ON r.equipment_id = e.id AND r.status = 'confirmed'
           GROUP BY e.id ORDER BY reservation_count DESC''').fetchall()]

    by_consumable = [dict(r) for r in c.execute(
        '''SELECT c.id, c.name, c.icon, c.unit, c.current_stock, c.min_stock,
                  COALESCE(SUM(u.quantity_used), 0) AS total_used
           FROM consumables c
           LEFT JOIN usage_log u ON u.item_type = 'consumable' AND u.item_id = CAST(c.id AS TEXT)
           GROUP BY c.id ORDER BY total_used DESC''').fetchall()]

    low_stock = [x for x in by_consumable if x['current_stock'] < x['min_stock']]

    conn.close()
    return jsonify({
        'total_reservations': total_res,
        'unique_users': users,
        'total_hours': round(total_minutes / 60, 1),
        'usage_logs': log_count,
        'by_equipment': by_equipment,
        'by_consumable': by_consumable,
        'low_stock': low_stock,
    })


# ================================================================ 리포트

def month_range(year, month):
    start = datetime(year, month, 1)
    end = datetime(year + 1, 1, 1) if month == 12 else datetime(year, month + 1, 1)
    return start.strftime('%Y-%m-%d'), end.strftime('%Y-%m-%d')


def build_monthly_report_data(conn, year, month):
    start, end = month_range(year, month)

    reservations = conn.execute(
        '''SELECT r.*, e.hourly_cost FROM reservations r
           JOIN equipment e ON e.id = r.equipment_id
           WHERE r.status = 'confirmed' AND r.reservation_date >= ? AND r.reservation_date < ?''',
        (start, end),
    ).fetchall()

    usage_logs = conn.execute(
        '''SELECT u.*, c.unit_price FROM usage_log u
           LEFT JOIN consumables c ON u.item_type = 'consumable' AND u.item_id = CAST(c.id AS TEXT)
           WHERE u.item_type = 'consumable' AND u.timestamp >= ? AND u.timestamp < ?''',
        (start, end + ' 00:00:00'),
    ).fetchall()

    by_user = {}
    for r in reservations:
        u = by_user.setdefault(r['user'], {'count': 0, 'minutes': 0, 'cost': 0.0})
        u['count'] += 1
        u['minutes'] += r['duration_minutes']
        u['cost'] += (r['duration_minutes'] / 60) * (r['hourly_cost'] or 0)

    by_equipment = {}
    for r in reservations:
        e = by_equipment.setdefault(r['equipment_name'], {'count': 0, 'minutes': 0, 'cost': 0.0})
        e['count'] += 1
        e['minutes'] += r['duration_minutes']
        e['cost'] += (r['duration_minutes'] / 60) * (r['hourly_cost'] or 0)

    by_consumable = {}
    for u in usage_logs:
        item = by_consumable.setdefault(u['item_name'], {'used': 0.0, 'unit': u['unit'], 'cost': 0.0})
        item['used'] += u['quantity_used'] or 0
        item['cost'] += (u['quantity_used'] or 0) * (u['unit_price'] or 0)

    return {
        'period': f'{year}년 {month}월',
        'total_reservations': len(reservations),
        'total_hours': round(sum(r['duration_minutes'] for r in reservations) / 60, 1),
        'total_cost': round(sum(v['cost'] for v in by_user.values()) + sum(v['cost'] for v in by_consumable.values()), 0),
        'by_user': by_user,
        'by_equipment': by_equipment,
        'by_consumable': by_consumable,
    }


@app.route('/api/reports/monthly', methods=['GET'])
def monthly_report_json():
    year = request.args.get('year', datetime.now().year, type=int)
    month = request.args.get('month', datetime.now().month, type=int)
    conn = get_db()
    data = build_monthly_report_data(conn, year, month)
    conn.close()
    return jsonify(data)


@app.route('/api/reports/monthly.pdf', methods=['GET'])
def monthly_report_pdf():
    year = request.args.get('year', datetime.now().year, type=int)
    month = request.args.get('month', datetime.now().month, type=int)
    conn = get_db()
    data = build_monthly_report_data(conn, year, month)
    conn.close()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=20 * mm, bottomMargin=20 * mm)
    styles = getSampleStyleSheet()
    kr_title = ParagraphStyle('kr_title', parent=styles['Title'], fontName='HYSMyeongJo-Medium', fontSize=18)
    kr_h2 = ParagraphStyle('kr_h2', parent=styles['Heading2'], fontName='HYSMyeongJo-Medium', fontSize=13)
    kr_body = ParagraphStyle('kr_body', parent=styles['Normal'], fontName='HYSMyeongJo-Medium', fontSize=10)

    elements = [
        Paragraph(f'XAM 연구실 월간 사용 현황 리포트', kr_title),
        Paragraph(f'{data["period"]}', kr_body),
        Spacer(1, 10 * mm),
        Paragraph(
            f'전체 예약 {data["total_reservations"]}건 · 총 사용 {data["total_hours"]}시간 · '
            f'추정 비용 {data["total_cost"]:,.0f}원', kr_body),
        Spacer(1, 8 * mm),
        Paragraph('개인별 사용 현황', kr_h2),
    ]

    user_table = [['이름', '예약 수', '사용 시간(h)', '비용(원)']]
    for name, v in sorted(data['by_user'].items(), key=lambda x: -x[1]['minutes']):
        user_table.append([name, str(v['count']), f"{v['minutes']/60:.1f}", f"{v['cost']:,.0f}"])
    elements.append(make_pdf_table(user_table))
    elements.append(Spacer(1, 8 * mm))

    elements.append(Paragraph('장비별 사용 현황', kr_h2))
    eq_table = [['장비', '예약 수', '사용 시간(h)', '비용(원)']]
    for name, v in sorted(data['by_equipment'].items(), key=lambda x: -x[1]['minutes']):
        eq_table.append([name, str(v['count']), f"{v['minutes']/60:.1f}", f"{v['cost']:,.0f}"])
    elements.append(make_pdf_table(eq_table))
    elements.append(Spacer(1, 8 * mm))

    elements.append(Paragraph('소모품별 사용 현황', kr_h2))
    cons_table = [['소모품', '사용량', '비용(원)']]
    for name, v in sorted(data['by_consumable'].items(), key=lambda x: -x[1]['used']):
        cons_table.append([name, f"{v['used']:.2f}{v['unit'] or ''}", f"{v['cost']:,.0f}"])
    elements.append(make_pdf_table(cons_table))

    doc.build(elements)
    buf.seek(0)
    filename = f'lab_report_{year}_{month:02d}.pdf'
    return send_file(buf, mimetype='application/pdf', as_attachment=True, download_name=filename)


def make_pdf_table(rows):
    if len(rows) == 1:
        rows.append(['-', '-', '-', '-'][:len(rows[0])])
    t = Table(rows, hAlign='LEFT')
    t.setStyle(TableStyle([
        ('FONTNAME', (0, 0), (-1, -1), 'HYSMyeongJo-Medium'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1e3a8a')),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.HexColor('#cccccc')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#f3f6fb')]),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    return t


if __name__ == '__main__':
    init_db()
    print('=' * 56)
    print(' XAM 연구실 장비 관리 시스템')
    print(' 홈:      http://localhost:5000')
    print(' 관리자:  http://localhost:5000/admin  (PIN: {})'.format(app.config['ADMIN_PIN']))
    print('=' * 56)
    app.run(debug=True, host='0.0.0.0', port=5000)
