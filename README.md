# ClassConnect

A web-based virtual class management system for Federal University Otuoke (FUO) —
covering course management, virtual class sessions, tamper-resistant attendance
recording, and course material distribution, as specified in Chapters One–Four of
the dissertation.

Built with Flask, SQLAlchemy, and Flask-Login. Uses SQLite by default for instant
local setup (no database server to install) but is MySQL-ready for the deployment
model described in Chapter 3/4.

## 1. Requirements

- Python 3.9 or newer
- pip

## 2. Setup (step by step)

```bash
# 1. Unzip/place the project folder, then move into it
cd classconnect

# 2. Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

# 3. Install dependencies
pip install -r requirements.txt

# 4. Run the app (this auto-creates the database and a default admin)
python app.py
```

Open **http://localhost:5000** in your browser.

A default administrator account is created automatically on first run:
- Email: `admin@fuo.edu.ng`
- Password: `Admin@123`

**Change this password immediately** if you deploy this beyond local testing.

## 3. Using the platform

1. Register as a **Lecturer** or **Student** at `/register`.
2. As a Lecturer: create a course (you'll get a 6-character enrolment code),
   start a virtual class session, upload materials, and click **Take Attendance
   Now** at any point during the session — everyone currently connected and
   verified gets marked present.
3. As a Student: enrol using the code your lecturer shares, join the active
   session from the course page, and stay on the session page while class runs.
4. As Admin: log in and view all users, courses, and platform-wide stats; remove
   accounts if needed.

## 4. Switching to MySQL (optional, matches the dissertation's deployment spec)

```bash
pip install pymysql
```

Then set an environment variable before running:

```bash
export DATABASE_URL="mysql+pymysql://USER:PASSWORD@localhost/classconnect"
python app.py
```

Create the database first in MySQL:

```sql
CREATE DATABASE classconnect CHARACTER SET utf8mb4;
```

## 5. Production deployment (VPS, Gunicorn + Nginx)

```bash
pip install gunicorn
gunicorn -w 4 -b 127.0.0.1:8000 app:app
```

Then point Nginx as a reverse proxy to `127.0.0.1:8000`, and configure HTTPS
(e.g. via Let's Encrypt/Certbot) in front of it, consistent with the
three-tier, HTTPS-secured architecture described in Chapter 3.3.2.

## 6. Project structure

```
classconnect/
├── app.py                  # all routes, models, app logic
├── requirements.txt
├── templates/               # Jinja2 HTML templates
├── static/css/style.css     # responsive, low-bandwidth styling
├── uploads/                 # uploaded course materials (created at runtime)
└── instance/                # SQLite database file (created at runtime)
```

## 7. Notes for your dissertation write-up

- This implements the seven-table schema from Section 3.4: Users, Courses,
  Enrolments, Class_Sessions, Session_Participants, Attendance_Records,
  Course_Materials.
- Attendance logic matches Section 3.3.2/3.3.4: a lecturer's "take attendance"
  action queries currently-connected, authenticated session participants and
  records them — eliminating proxy attendance and reducing recording time to a
  single action regardless of class size.
- For your Chapter 4 screenshots, run the app locally, walk through each
  interface listed in Section 4.3.1, and capture them as Plates 4.1–4.8.
- For timing data in Section 4.3.3, time the "Take Attendance Now" action for a
  test class of known size and compare it against the manual baseline.
