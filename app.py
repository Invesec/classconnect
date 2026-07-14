import os, secrets, string, random
from datetime import datetime, timezone, timedelta

from flask import (Flask, render_template, redirect, url_for, flash,
                   request, abort, send_from_directory, jsonify)
from flask_sqlalchemy import SQLAlchemy
from flask_login import (LoginManager, UserMixin, login_user, logout_user,
                         login_required, current_user)
from flask_mail import Mail, Message
from flask_socketio import SocketIO, join_room, leave_room, emit
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename

basedir = os.path.abspath(os.path.dirname(__file__))

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'dev-secret-key-change-in-production')

# ── Database ──────────────────────────────────────────────────────────────────
app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get(
    'DATABASE_URL',
    f"sqlite:///{os.path.join(basedir, 'instance', 'classconnect.db')}"
)
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# ── File uploads ──────────────────────────────────────────────────────────────
app.config['UPLOAD_FOLDER'] = os.path.join(basedir, 'uploads')
app.config['MAX_CONTENT_LENGTH'] = 25 * 1024 * 1024   # 25 MB

# ── Email (Flask-Mail) ────────────────────────────────────────────────────────
# Configure via .env or environment variables on your server.
# For Gmail: allow "App Passwords" in your Google account and set:
#   MAIL_USERNAME=you@gmail.com   MAIL_PASSWORD=your-app-password
app.config['MAIL_SERVER']   = os.environ.get('MAIL_SERVER',   'smtp.gmail.com')
app.config['MAIL_PORT']     = int(os.environ.get('MAIL_PORT', 587))
app.config['MAIL_USE_TLS']  = os.environ.get('MAIL_USE_TLS',  'true').lower() == 'true'
app.config['MAIL_USERNAME'] = os.environ.get('MAIL_USERNAME', '')
app.config['MAIL_PASSWORD'] = os.environ.get('MAIL_PASSWORD', '')
# IMPORTANT (deliverability): the "From" address MUST be the same mailbox that
# authenticates via MAIL_USERNAME/MAIL_PASSWORD. Sending through Gmail's SMTP
# while claiming a "From" on a different, unverified domain (e.g.
# noreply@classconnect.fuo) fails SPF/DKIM alignment and is a top reason mail
# lands straight in spam. Only the display NAME is customizable — the address
# always matches the authenticated account.
MAIL_SENDER_NAME = os.environ.get('MAIL_SENDER_NAME', 'ClassConnect')
app.config['MAIL_DEFAULT_SENDER'] = (MAIL_SENDER_NAME, app.config['MAIL_USERNAME']) \
    if app.config['MAIL_USERNAME'] else 'noreply@classconnect.fuo'

ALLOWED_EXTENSIONS = {'pdf', 'doc', 'docx', 'ppt', 'pptx'}
OTP_EXPIRY_MINUTES = 10
RESET_TOKEN_EXPIRY_MINUTES = 30

db       = SQLAlchemy(app)
mail     = Mail(app)
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')
login_manager = LoginManager(app)
login_manager.login_view = 'login'
login_manager.login_message_category = 'info'


# ── Models ────────────────────────────────────────────────────────────────────

class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id              = db.Column(db.Integer, primary_key=True)
    full_name       = db.Column(db.String(120), nullable=False)
    email           = db.Column(db.String(120), unique=True, nullable=False)
    password_hash   = db.Column(db.String(255), nullable=False)
    role            = db.Column(db.String(20), nullable=False)   # lecturer | student | admin
    id_number       = db.Column(db.String(30), unique=True, nullable=True)
    # Unique identity number: Matric Number for students, Staff/Lecturer ID for lecturers.
    email_verified  = db.Column(db.Boolean, default=False)
    otp             = db.Column(db.String(6))
    otp_expires     = db.Column(db.DateTime)
    reset_token     = db.Column(db.String(64))
    reset_token_expires = db.Column(db.DateTime)
    created_at      = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    courses_taught = db.relationship('Course', backref='lecturer', lazy=True,
                                     foreign_keys='Course.lecturer_id')

    def set_password(self, pw):
        self.password_hash = generate_password_hash(pw)

    def check_password(self, pw):
        return check_password_hash(self.password_hash, pw)

    def generate_otp(self):
        self.otp = ''.join([str(random.randint(0, 9)) for _ in range(6)])
        self.otp_expires = datetime.now(timezone.utc) + timedelta(minutes=OTP_EXPIRY_MINUTES)
        return self.otp

    def verify_otp(self, code):
        if not self.otp or not self.otp_expires:
            return False
        expires = self.otp_expires
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return self.otp == code and datetime.now(timezone.utc) < expires

    def generate_reset_token(self):
        self.reset_token = secrets.token_urlsafe(32)
        self.reset_token_expires = datetime.now(timezone.utc) + timedelta(minutes=RESET_TOKEN_EXPIRY_MINUTES)
        return self.reset_token

    def verify_reset_token(self, token):
        if not self.reset_token or not self.reset_token_expires or not token:
            return False
        expires = self.reset_token_expires
        if expires.tzinfo is None:
            expires = expires.replace(tzinfo=timezone.utc)
        return secrets.compare_digest(self.reset_token, token) and datetime.now(timezone.utc) < expires

    def clear_reset_token(self):
        self.reset_token = None
        self.reset_token_expires = None


class Course(db.Model):
    __tablename__ = 'courses'
    id              = db.Column(db.Integer, primary_key=True)
    course_code     = db.Column(db.String(20), nullable=False)
    title           = db.Column(db.String(150), nullable=False)
    description     = db.Column(db.Text)
    enrolment_code  = db.Column(db.String(10), unique=True, nullable=False)
    lecturer_id     = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    created_at      = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    enrolments = db.relationship('Enrolment',      backref='course', lazy=True, cascade='all, delete-orphan')
    sessions   = db.relationship('ClassSession',   backref='course', lazy=True, cascade='all, delete-orphan')
    materials  = db.relationship('CourseMaterial', backref='course', lazy=True, cascade='all, delete-orphan')


class Enrolment(db.Model):
    __tablename__ = 'enrolments'
    id         = db.Column(db.Integer, primary_key=True)
    student_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    course_id  = db.Column(db.Integer, db.ForeignKey('courses.id'), nullable=False)
    enrolled_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    student    = db.relationship('User', foreign_keys=[student_id])
    __table_args__ = (db.UniqueConstraint('student_id', 'course_id', name='uq_student_course'),)


class ClassSession(db.Model):
    __tablename__ = 'class_sessions'
    id         = db.Column(db.Integer, primary_key=True)
    course_id  = db.Column(db.Integer, db.ForeignKey('courses.id'), nullable=False)
    topic      = db.Column(db.String(200))
    status     = db.Column(db.String(20), default='active')   # active | closed
    started_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    closed_at  = db.Column(db.DateTime)

    participants       = db.relationship('SessionParticipant', backref='session', lazy=True, cascade='all, delete-orphan')
    attendance_records = db.relationship('AttendanceRecord',   backref='session', lazy=True, cascade='all, delete-orphan')


class SessionParticipant(db.Model):
    __tablename__ = 'session_participants'
    id              = db.Column(db.Integer, primary_key=True)
    session_id      = db.Column(db.Integer, db.ForeignKey('class_sessions.id'), nullable=False)
    student_id      = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    joined_at       = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    still_connected = db.Column(db.Boolean, default=True)
    student         = db.relationship('User', foreign_keys=[student_id])
    __table_args__  = (db.UniqueConstraint('session_id', 'student_id', name='uq_session_student'),)


class AttendanceRecord(db.Model):
    __tablename__ = 'attendance_records'
    id          = db.Column(db.Integer, primary_key=True)
    session_id  = db.Column(db.Integer, db.ForeignKey('class_sessions.id'), nullable=False)
    student_id  = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    status      = db.Column(db.String(20), default='present')
    recorded_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    student     = db.relationship('User', foreign_keys=[student_id])


class CourseMaterial(db.Model):
    __tablename__ = 'course_materials'
    id               = db.Column(db.Integer, primary_key=True)
    course_id        = db.Column(db.Integer, db.ForeignKey('courses.id'), nullable=False)
    uploader_id      = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    title            = db.Column(db.String(200), nullable=False)
    filename         = db.Column(db.String(255), nullable=False)
    stored_filename  = db.Column(db.String(255), nullable=False)
    upload_date      = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    uploader         = db.relationship('User', foreign_keys=[uploader_id])


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


def ensure_schema_upgrades():
    """Add any newly-introduced columns to an existing SQLite database
    in place, so upgrading the code doesn't wipe or break existing data.
    Safe to call on every startup — it no-ops once columns already exist."""
    from sqlalchemy import text, inspect
    inspector = inspect(db.engine)
    if 'users' not in inspector.get_table_names():
        return  # fresh database — db.create_all() will create it with all columns
    existing_cols = {c['name'] for c in inspector.get_columns('users')}
    needed = {
        'reset_token': 'VARCHAR(64)',
        'reset_token_expires': 'DATETIME',
    }
    for col_name, col_type in needed.items():
        if col_name not in existing_cols:
            try:
                db.session.execute(text(f'ALTER TABLE users ADD COLUMN {col_name} {col_type}'))
                db.session.commit()
                print(f'[MIGRATION] Added missing column users.{col_name}')
            except Exception as e:
                db.session.rollback()
                print(f'[MIGRATION ERROR] Could not add column {col_name}: {e}')


# ── Helpers ───────────────────────────────────────────────────────────────────

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def generate_enrolment_code(length=6):
    chars = string.ascii_uppercase + string.digits
    while True:
        code = ''.join(secrets.choice(chars) for _ in range(length))
        if not Course.query.filter_by(enrolment_code=code).first():
            return code


def _send_mail_async(subject, to_email, html, text):
    """Send an email in a background task so a slow/unreachable SMTP server
    can never hang the request that triggered it. Always includes a
    plain-text part alongside the HTML — mail with only an HTML body is a
    common spam-filter signal.

    Uses socketio.start_background_task() rather than a raw threading.Thread.
    Flask-SocketIO picks the right underlying primitive (real OS thread,
    eventlet greenlet, or gevent greenlet) to match whatever async_mode /
    gunicorn worker class is actually running the app — a raw
    threading.Thread would fight with an eventlet worker and corrupt
    SQLAlchemy's connection-pool locks (RuntimeError: cannot notify on
    un-acquired lock)."""
    def worker():
        with app.app_context():
            try:
                msg = Message(
                    subject=subject,
                    recipients=[to_email],
                    html=html,
                    body=text,
                    reply_to=app.config['MAIL_USERNAME'] or None,
                )
                mail.send(msg)
            except Exception as e:
                print(f"[MAIL ERROR] {e}")
    socketio.start_background_task(worker)


def send_otp_email(user):
    """Send OTP to user's email. Falls back silently if mail is unconfigured,
    and never blocks the request — the actual send happens on a background
    thread so a slow SMTP server can't freeze the page."""
    otp = user.generate_otp()
    db.session.commit()
    if not app.config['MAIL_USERNAME']:
        # Email not configured — print OTP to console for local dev
        print(f"\n[DEV] OTP for {user.email}: {otp}\n")
        return
    html = f"""
    <div style="font-family:sans-serif;max-width:480px;margin:auto;">
      <h2 style="color:#1d4ed8;">ClassConnect</h2>
      <p>Hello {user.full_name},</p>
      <p>Your one-time verification code is:</p>
      <div style="font-size:2rem;font-weight:700;letter-spacing:.4rem;
                  background:#eff6ff;padding:1rem;border-radius:8px;
                  text-align:center;color:#1e3a8a;">{otp}</div>
      <p style="color:#6b7280;font-size:.85rem;">
        This code expires in {OTP_EXPIRY_MINUTES} minutes.<br>
        If you did not register on ClassConnect, please ignore this email.
      </p>
    </div>"""
    text = (
        f"ClassConnect\n\nHello {user.full_name},\n\n"
        f"Your one-time verification code is: {otp}\n\n"
        f"This code expires in {OTP_EXPIRY_MINUTES} minutes.\n"
        f"If you did not register on ClassConnect, please ignore this email."
    )
    _send_mail_async('ClassConnect – Your verification code', user.email, html, text)


def send_reset_email(user):
    """Email a password-reset link. Same non-blocking pattern as OTP email."""
    token = user.generate_reset_token()
    db.session.commit()
    reset_url = url_for('reset_password', token=token, _external=True)
    if not app.config['MAIL_USERNAME']:
        print(f"\n[DEV] Password reset link for {user.email}: {reset_url}\n")
        return
    html = f"""
    <div style="font-family:sans-serif;max-width:480px;margin:auto;">
      <h2 style="color:#1d4ed8;">ClassConnect</h2>
      <p>Hello {user.full_name},</p>
      <p>We received a request to reset your password. Click the button below to choose a new one:</p>
      <p style="text-align:center;margin:1.5rem 0;">
        <a href="{reset_url}" style="display:inline-block;background:#2563eb;color:white;
           padding:.75rem 1.5rem;border-radius:8px;text-decoration:none;font-weight:600;">
           Reset Password</a>
      </p>
      <p style="color:#6b7280;font-size:.85rem;">
        This link expires in {RESET_TOKEN_EXPIRY_MINUTES} minutes.<br>
        If you did not request a password reset, please ignore this email — your password will stay unchanged.
      </p>
    </div>"""
    text = (
        f"ClassConnect\n\nHello {user.full_name},\n\n"
        f"We received a request to reset your password. Open this link to choose a new one:\n"
        f"{reset_url}\n\n"
        f"This link expires in {RESET_TOKEN_EXPIRY_MINUTES} minutes.\n"
        f"If you did not request a password reset, please ignore this email — your password will stay unchanged."
    )
    _send_mail_async('ClassConnect – Reset your password', user.email, html, text)


def role_required(*roles):
    def decorator(f):
        from functools import wraps
        @wraps(f)
        def wrapped(*args, **kwargs):
            if not current_user.is_authenticated or current_user.role not in roles:
                abort(403)
            return f(*args, **kwargs)
        return wrapped
    return decorator


# ── Auth routes ───────────────────────────────────────────────────────────────

@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return render_template('index.html')


@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    if request.method == 'POST':
        full_name = request.form.get('full_name', '').strip()
        email     = request.form.get('email', '').strip().lower()
        password  = request.form.get('password', '')
        role      = request.form.get('role', 'student')
        id_number = request.form.get('id_number', '').strip().upper()

        if role not in ('student', 'lecturer'):
            role = 'student'

        id_label = 'Matric Number' if role == 'student' else 'Staff/Lecturer ID'

        if not full_name or not email or not password or not id_number:
            flash(f'All fields are required, including your {id_label}.', 'danger')
            return redirect(url_for('register'))
        if User.query.filter_by(email=email).first():
            flash('An account with that email already exists.', 'danger')
            return redirect(url_for('register'))
        if User.query.filter_by(id_number=id_number).first():
            flash(f'That {id_label} is already registered to another account.', 'danger')
            return redirect(url_for('register'))

        user = User(full_name=full_name, email=email, role=role, id_number=id_number)
        user.set_password(password)
        db.session.add(user)
        db.session.flush()   # get user.id before commit
        send_otp_email(user)

        flash('Account created! Check your email for a 6-digit verification code.', 'success')
        return redirect(url_for('verify_otp', user_id=user.id))

    return render_template('register.html')


@app.route('/verify/<int:user_id>', methods=['GET', 'POST'])
def verify_otp(user_id):
    user = db.get_or_404(User, user_id)
    if user.email_verified:
        flash('Email already verified. Please log in.', 'info')
        return redirect(url_for('login'))

    if request.method == 'POST':
        code = request.form.get('otp', '').strip()
        if user.verify_otp(code):
            user.email_verified = True
            user.otp = None
            user.otp_expires = None
            db.session.commit()
            flash('Email verified! You can now log in.', 'success')
            return redirect(url_for('login'))
        else:
            flash('Invalid or expired code. Please try again or request a new one.', 'danger')

    return render_template('verify_otp.html', user=user)


@app.route('/verify/<int:user_id>/resend', methods=['POST'])
def resend_otp(user_id):
    user = db.get_or_404(User, user_id)
    if user.email_verified:
        return redirect(url_for('login'))
    send_otp_email(user)
    flash('A new code has been sent to your email.', 'info')
    return redirect(url_for('verify_otp', user_id=user.id))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    if request.method == 'POST':
        identifier = request.form.get('identifier', '').strip()
        password   = request.form.get('password', '')

        # Allow logging in with either the registered email address or the
        # unique Matric Number (student) / Staff ID (lecturer).
        user = User.query.filter_by(email=identifier.lower()).first()
        if not user and identifier:
            user = User.query.filter_by(id_number=identifier.upper()).first()

        if user and user.check_password(password):
            if not user.email_verified:
                flash('Please verify your email first. Check your inbox for the OTP.', 'danger')
                return redirect(url_for('verify_otp', user_id=user.id))
            login_user(user)
            return redirect(url_for('dashboard'))
        flash('Invalid email or password.', 'danger')
    return render_template('login.html')


@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('index'))


@app.route('/forgot-password', methods=['GET', 'POST'])
def forgot_password():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    if request.method == 'POST':
        email = request.form.get('email', '').strip().lower()
        user = User.query.filter_by(email=email).first()
        # Always show the same message whether or not the account exists,
        # so this form can't be used to check which emails are registered.
        if user:
            send_reset_email(user)
        flash('If an account exists for that email, a reset link has been sent.', 'info')
        return redirect(url_for('login'))
    return render_template('forgot_password.html')


@app.route('/reset-password/<token>', methods=['GET', 'POST'])
def reset_password(token):
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    user = User.query.filter_by(reset_token=token).first()
    if not user or not user.verify_reset_token(token):
        flash('That reset link is invalid or has expired. Please request a new one.', 'danger')
        return redirect(url_for('forgot_password'))

    if request.method == 'POST':
        password = request.form.get('password', '')
        confirm  = request.form.get('confirm_password', '')
        if len(password) < 6:
            flash('Password must be at least 6 characters.', 'danger')
            return render_template('reset_password.html', token=token)
        if password != confirm:
            flash('Passwords do not match.', 'danger')
            return render_template('reset_password.html', token=token)
        user.set_password(password)
        user.clear_reset_token()
        db.session.commit()
        flash('Password updated! You can now log in.', 'success')
        return redirect(url_for('login'))

    return render_template('reset_password.html', token=token)


# ── Dashboard ─────────────────────────────────────────────────────────────────

@app.route('/dashboard')
@login_required
def dashboard():
    if current_user.role == 'lecturer':
        courses = Course.query.filter_by(lecturer_id=current_user.id).all()
        return render_template('lecturer_dashboard.html', courses=courses)
    elif current_user.role == 'student':
        enrolments = Enrolment.query.filter_by(student_id=current_user.id).all()
        return render_template('student_dashboard.html', courses=[e.course for e in enrolments])
    else:
        users            = User.query.order_by(User.created_at.desc()).all()
        courses          = Course.query.all()
        total_sessions   = ClassSession.query.count()
        total_attendance = AttendanceRecord.query.count()
        return render_template('admin_dashboard.html', users=users, courses=courses,
                               total_sessions=total_sessions, total_attendance=total_attendance)


# ── Course management ─────────────────────────────────────────────────────────

@app.route('/courses/new', methods=['GET', 'POST'])
@login_required
@role_required('lecturer')
def create_course():
    if request.method == 'POST':
        course_code = request.form.get('course_code', '').strip()
        title       = request.form.get('title', '').strip()
        description = request.form.get('description', '').strip()
        if not course_code or not title:
            flash('Course code and title are required.', 'danger')
            return redirect(url_for('create_course'))
        course = Course(course_code=course_code, title=title, description=description,
                        enrolment_code=generate_enrolment_code(), lecturer_id=current_user.id)
        db.session.add(course)
        db.session.commit()
        flash(f'Course created. Enrolment code: {course.enrolment_code}', 'success')
        return redirect(url_for('view_course', course_id=course.id))
    return render_template('create_course.html')


@app.route('/courses/<int:course_id>')
@login_required
def view_course(course_id):
    course = db.get_or_404(Course, course_id)
    if current_user.role == 'lecturer' and course.lecturer_id != current_user.id:
        abort(403)
    if current_user.role == 'student':
        if not Enrolment.query.filter_by(student_id=current_user.id, course_id=course.id).first():
            abort(403)

    sessions  = ClassSession.query.filter_by(course_id=course.id).order_by(ClassSession.started_at.desc()).all()
    materials = CourseMaterial.query.filter_by(course_id=course.id).order_by(CourseMaterial.upload_date.desc()).all()
    my_attendance = None
    if current_user.role == 'student':
        my_attendance = (AttendanceRecord.query.join(ClassSession)
                         .filter(ClassSession.course_id == course.id,
                                 AttendanceRecord.student_id == current_user.id).count())
    return render_template('course_detail.html', course=course, sessions=sessions,
                           materials=materials, my_attendance=my_attendance)


@app.route('/courses/enrol', methods=['POST'])
@login_required
@role_required('student')
def enrol_course():
    code   = request.form.get('enrolment_code', '').strip().upper()
    course = Course.query.filter_by(enrolment_code=code).first()
    if not course:
        flash('Invalid enrolment code.', 'danger')
        return redirect(url_for('dashboard'))
    if Enrolment.query.filter_by(student_id=current_user.id, course_id=course.id).first():
        flash('You are already enrolled in this course.', 'info')
    else:
        db.session.add(Enrolment(student_id=current_user.id, course_id=course.id))
        db.session.commit()
        flash(f'Enrolled in {course.course_code} – {course.title}.', 'success')
    return redirect(url_for('view_course', course_id=course.id))


# ── Sessions & attendance ─────────────────────────────────────────────────────

@app.route('/courses/<int:course_id>/sessions/start', methods=['POST'])
@login_required
@role_required('lecturer')
def start_session(course_id):
    course = db.get_or_404(Course, course_id)
    if course.lecturer_id != current_user.id:
        abort(403)
    active = ClassSession.query.filter_by(course_id=course.id, status='active').first()
    if active:
        flash('A session is already active for this course.', 'info')
        return redirect(url_for('session_room', session_id=active.id))
    topic = request.form.get('topic', '').strip() or f'{course.course_code} session'
    s = ClassSession(course_id=course.id, topic=topic, status='active')
    db.session.add(s)
    db.session.commit()
    return redirect(url_for('session_room', session_id=s.id))


@app.route('/sessions/<int:session_id>')
@login_required
def session_room(session_id):
    session_obj = db.get_or_404(ClassSession, session_id)
    course      = session_obj.course

    if current_user.role == 'lecturer' and course.lecturer_id != current_user.id:
        abort(403)
    if current_user.role == 'student':
        if not Enrolment.query.filter_by(student_id=current_user.id, course_id=course.id).first():
            abort(403)
        if not SessionParticipant.query.filter_by(session_id=session_obj.id,
                                                   student_id=current_user.id).first():
            if session_obj.status == 'active':
                db.session.add(SessionParticipant(session_id=session_obj.id,
                                                   student_id=current_user.id))
                db.session.commit()

    participants  = SessionParticipant.query.filter_by(session_id=session_obj.id).all()
    attendance    = AttendanceRecord.query.filter_by(session_id=session_obj.id).all()
    attendance_ids = {a.student_id for a in attendance}

    return render_template('session_room.html', session=session_obj, course=course,
                           participants=participants, attendance_ids=attendance_ids)


@app.route('/sessions/<int:session_id>/participants')
@login_required
def session_participants_json(session_id):
    session_obj  = db.get_or_404(ClassSession, session_id)
    participants = SessionParticipant.query.filter_by(session_id=session_obj.id).all()
    attendance_ids = {a.student_id for a in
                      AttendanceRecord.query.filter_by(session_id=session_obj.id).all()}
    data = [{'student_id': p.student_id, 'name': p.student.full_name,
              'id_number': p.student.id_number or '—',
              'joined_at': p.joined_at.strftime('%H:%M:%S'),
              'present': p.student_id in attendance_ids} for p in participants]
    return jsonify({'status': session_obj.status, 'participants': data})


@app.route('/sessions/<int:session_id>/take-attendance', methods=['POST'])
@login_required
@role_required('lecturer')
def take_attendance(session_id):
    session_obj = db.get_or_404(ClassSession, session_id)
    if session_obj.course.lecturer_id != current_user.id:
        abort(403)
    participants = SessionParticipant.query.filter_by(session_id=session_obj.id,
                                                       still_connected=True).all()
    already = {a.student_id for a in
               AttendanceRecord.query.filter_by(session_id=session_obj.id).all()}
    count = 0
    for p in participants:
        if p.student_id not in already:
            db.session.add(AttendanceRecord(session_id=session_obj.id,
                                             student_id=p.student_id, status='present'))
            count += 1
    db.session.commit()
    flash(f'Attendance captured: {count} new student(s) marked present.', 'success')
    return redirect(url_for('session_room', session_id=session_obj.id))


@app.route('/sessions/<int:session_id>/close', methods=['POST'])
@login_required
@role_required('lecturer')
def close_session(session_id):
    session_obj = db.get_or_404(ClassSession, session_id)
    if session_obj.course.lecturer_id != current_user.id:
        abort(403)
    session_obj.status    = 'closed'
    session_obj.closed_at = datetime.now(timezone.utc)
    db.session.commit()
    flash('Session closed.', 'info')
    return redirect(url_for('view_course', course_id=session_obj.course_id))


@app.route('/sessions/<int:session_id>/report')
@login_required
def session_report(session_id):
    session_obj = db.get_or_404(ClassSession, session_id)
    course      = session_obj.course
    if current_user.role == 'lecturer' and course.lecturer_id != current_user.id:
        abort(403)
    if current_user.role == 'student':
        if not Enrolment.query.filter_by(student_id=current_user.id, course_id=course.id).first():
            abort(403)
    records = AttendanceRecord.query.filter_by(session_id=session_obj.id).all()
    return render_template('session_report.html', session=session_obj,
                           course=course, records=records)


# ── Materials ─────────────────────────────────────────────────────────────────

@app.route('/courses/<int:course_id>/materials/upload', methods=['POST'])
@login_required
@role_required('lecturer')
def upload_material(course_id):
    course = db.get_or_404(Course, course_id)
    if course.lecturer_id != current_user.id:
        abort(403)
    title = request.form.get('title', '').strip()
    file  = request.files.get('file')
    if not title or not file or file.filename == '':
        flash('A title and a file are required.', 'danger')
        return redirect(url_for('view_course', course_id=course.id))
    if not allowed_file(file.filename):
        flash('Only PDF, Word, and PowerPoint files are allowed.', 'danger')
        return redirect(url_for('view_course', course_id=course.id))
    original = secure_filename(file.filename)
    stored   = f"{secrets.token_hex(8)}_{original}"
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)
    file.save(os.path.join(app.config['UPLOAD_FOLDER'], stored))
    db.session.add(CourseMaterial(course_id=course.id, uploader_id=current_user.id,
                                  title=title, filename=original, stored_filename=stored))
    db.session.commit()
    flash('Material uploaded.', 'success')
    return redirect(url_for('view_course', course_id=course.id))


@app.route('/materials/<int:material_id>/download')
@login_required
def download_material(material_id):
    material = db.get_or_404(CourseMaterial, material_id)
    course   = material.course
    if current_user.role == 'lecturer' and course.lecturer_id != current_user.id:
        abort(403)
    if current_user.role == 'student':
        if not Enrolment.query.filter_by(student_id=current_user.id, course_id=course.id).first():
            abort(403)
    return send_from_directory(app.config['UPLOAD_FOLDER'], material.stored_filename,
                               as_attachment=True, download_name=material.filename)


# ── Admin ─────────────────────────────────────────────────────────────────────

@app.route('/admin/users/<int:user_id>/delete', methods=['POST'])
@login_required
@role_required('admin')
def delete_user(user_id):
    if user_id == current_user.id:
        flash("You can't delete your own account.", 'danger')
        return redirect(url_for('dashboard'))
    user = db.get_or_404(User, user_id)
    db.session.delete(user)
    db.session.commit()
    flash('User removed.', 'info')
    return redirect(url_for('dashboard'))


# ── WebRTC signalling (SocketIO events) ───────────────────────────────────────
# Each class session gets its own SocketIO room named "session_<id>".
# The server only relays signalling messages (offer/answer/ICE candidates)
# between peers; it never handles media — all video/audio flows peer-to-peer
# via WebRTC using Google's free STUN servers.

@socketio.on('join-video-room')
def on_join_video(data):
    room      = f"session_{data['session_id']}"
    user_id   = data['user_id']
    user_name = data['user_name']
    join_room(room)
    # Tell everyone else in the room that a new peer has arrived
    emit('peer-joined', {'user_id': user_id, 'user_name': user_name}, to=room, skip_sid=request.sid)  # noqa


@socketio.on('leave-video-room')
def on_leave_video(data):
    room = f"session_{data['session_id']}"
    leave_room(room)
    emit('peer-left', {'user_id': data['user_id']}, to=room)


@socketio.on('offer')
def on_offer(data):
    room = f"session_{data['session_id']}"
    emit('offer', data, to=room, skip_sid=request.sid)  # noqa


@socketio.on('answer')
def on_answer(data):
    room = f"session_{data['session_id']}"
    emit('answer', data, to=room, skip_sid=request.sid)  # noqa


@socketio.on('ice-candidate')
def on_ice_candidate(data):
    room = f"session_{data['session_id']}"
    emit('ice-candidate', data, to=room, skip_sid=request.sid)  # noqa


# ── Error handlers ────────────────────────────────────────────────────────────

@app.errorhandler(403)
def forbidden(e):
    return render_template('error.html', code=403,
                           message="You don't have permission to view this page."), 403

@app.errorhandler(404)
def not_found(e):
    return render_template('error.html', code=404, message='Page not found.'), 404


# ── CLI ───────────────────────────────────────────────────────────────────────

@app.cli.command('init-db')
def init_db():
    db.create_all()
    ensure_schema_upgrades()
    if not User.query.filter_by(role='admin').first():
        admin = User(full_name='System Administrator', email='admin@fuo.edu.ng',
                     role='admin', email_verified=True)
        admin.set_password('Admin@123')
        db.session.add(admin)
        db.session.commit()
        print('Created default admin -> email: admin@fuo.edu.ng  password: Admin@123')
    print('Database initialised.')


def bootstrap_db():
    """Create the instance folder + database + default admin, and apply any
    pending column migrations. Runs unconditionally at import time (not just
    under `if __name__ == '__main__'`) so this also works correctly when the
    app is started via gunicorn/eventlet in production, where this module is
    imported rather than executed directly."""
    with app.app_context():
        os.makedirs(os.path.join(basedir, 'instance'), exist_ok=True)
        db.create_all()
        ensure_schema_upgrades()
        if not User.query.filter_by(role='admin').first():
            admin = User(full_name='System Administrator', email='admin@fuo.edu.ng',
                         role='admin', email_verified=True)
            admin.set_password('Admin@123')
            db.session.add(admin)
            db.session.commit()
            print('Created default admin -> admin@fuo.edu.ng / Admin@123')


bootstrap_db()

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True)
