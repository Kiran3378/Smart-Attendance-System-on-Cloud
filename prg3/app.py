import csv
import hashlib
import io
import json
import math
import os
import secrets
from datetime import datetime, timedelta, timezone
from functools import wraps

import firebase_admin
from dotenv import load_dotenv
from firebase_admin import auth, credentials, firestore
from flask import Flask, Response, jsonify, render_template, request
from google.api_core.exceptions import AlreadyExists
import qrcode
from qrcode.image.svg import SvgPathImage

load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024
app.config["JSON_SORT_KEYS"] = False

FIREBASE_WEB_CONFIG = {
    key: os.getenv(env_name, "")
    for key, env_name in {
        "apiKey": "FIREBASE_API_KEY",
        "authDomain": "FIREBASE_AUTH_DOMAIN",
        "projectId": "FIREBASE_PROJECT_ID",
        "storageBucket": "FIREBASE_STORAGE_BUCKET",
        "messagingSenderId": "FIREBASE_MESSAGING_SENDER_ID",
        "appId": "FIREBASE_APP_ID",
    }.items()
}
ADMIN_EMAILS = {
    email.strip().lower()
    for email in os.getenv("ADMIN_EMAILS", "").split(",")
    if email.strip()
}

_db = None
_firebase_ready = False


def _initialize_firebase():
    global _db, _firebase_ready
    if _firebase_ready:
        return
    try:
        try:
            firebase_admin.get_app()
        except ValueError:
            credential_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
            firebase_options = {}
            project_id = os.getenv("FIREBASE_PROJECT_ID")
            if project_id:
                firebase_options["projectId"] = project_id
            if credential_path:
                firebase_admin.initialize_app(
                    credentials.Certificate(credential_path),
                    options=firebase_options,
                )
            elif os.getenv("K_SERVICE"):
                firebase_admin.initialize_app(
                    credentials.ApplicationDefault(),
                    options=firebase_options,
                )
            else:
                _db = None
                app.logger.warning(
                    "Firebase is not configured. Set GOOGLE_APPLICATION_CREDENTIALS "
                    "for local development."
                )
                return
        _db = firestore.client()
        _firebase_ready = True
    except Exception:
        app.logger.exception("Firebase Admin initialization failed")


def _database():
    _initialize_firebase()
    if not _firebase_ready:
        raise RuntimeError(
            "Firebase is not configured. Set GOOGLE_APPLICATION_CREDENTIALS "
            "to a service-account JSON file."
        )
    return _db


def _now():
    return datetime.now(timezone.utc)


def _json_datetime(value):
    if not value:
        return None
    if isinstance(value, str):
        return value
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def _profile_for(user):
    db = _database()
    profile_ref = db.collection("users").document(user["uid"])
    profile = profile_ref.get()
    if profile.exists:
        data = profile.to_dict()
        if (
            user.get("email", "").lower() in ADMIN_EMAILS
            and user.get("email_verified")
            and data.get("role") != "teacher"
        ):
            data["role"] = "teacher"
            profile_ref.set({"role": "teacher"}, merge=True)
        return data

    role = (
        "teacher"
        if user.get("email", "").lower() in ADMIN_EMAILS and user.get("email_verified")
        else "student"
    )
    data = {
        "email": user.get("email", ""),
        "display_name": user.get("name", ""),
        "student_id": "",
        "role": role,
        "face_embedding": None,
        "created_at": firestore.SERVER_TIMESTAMP,
    }
    profile_ref.set(data)
    return data


def _authenticated(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return jsonify(error="Sign in to continue."), 401
        try:
            decoded = auth.verify_id_token(header[7:], check_revoked=True)
        except (ValueError, auth.InvalidIdTokenError, auth.UserDisabledError):
            return jsonify(error="Your sign-in has expired. Please sign in again."), 401
        except auth.CertificateFetchError:
            app.logger.exception("Could not fetch Firebase token-verification certificates")
            return jsonify(error="Sign-in verification is temporarily unavailable."), 503
        except Exception:
            app.logger.exception("Firebase ID-token verification failed")
            return jsonify(error="Sign-in verification is temporarily unavailable."), 503
        user = {
            "uid": decoded["uid"],
            "email": decoded.get("email", ""),
            "name": decoded.get("name", ""),
            "email_verified": bool(decoded.get("email_verified")),
        }
        try:
            profile = _profile_for(user)
        except RuntimeError as exc:
            return jsonify(error=str(exc)), 503
        except Exception:
            app.logger.exception("Could not load authenticated user profile")
            return jsonify(error="Your account profile could not be loaded."), 503
        request.current_user = user
        request.current_profile = profile
        return handler(*args, **kwargs)

    return wrapped


def _teacher_required(handler):
    @wraps(handler)
    @_authenticated
    def wrapped(*args, **kwargs):
        if (
            request.current_profile.get("role") != "teacher"
            or not request.current_user.get("email_verified")
        ):
            return jsonify(error="Teacher access is required."), 403
        return handler(*args, **kwargs)

    return wrapped


def _payload():
    value = request.get_json(silent=True)
    return value if isinstance(value, dict) else {}


def _valid_text(value, field, limit=120):
    if not isinstance(value, str):
        raise ValueError(f"{field} is required.")
    value = value.strip()
    if not value or len(value) > limit:
        raise ValueError(f"{field} must contain 1 to {limit} characters.")
    return value


def _clean_session(doc_id, data):
    return {
        "id": doc_id,
        "course": data.get("course", ""),
        "teacher_id": data.get("teacher_id", ""),
        "teacher_name": data.get("teacher_name", ""),
        "created_at": _json_datetime(data.get("created_at")),
        "expires_at": _json_datetime(data.get("expires_at")),
        "active": bool(data.get("expires_at") and data["expires_at"] > _now()),
    }


def _clean_attendance(doc_id, data):
    return {
        "id": doc_id,
        "session_id": data.get("session_id", ""),
        "user_id": data.get("user_id", ""),
        "student_name": data.get("student_name", ""),
        "student_email": data.get("student_email", ""),
        "student_id": data.get("student_id", ""),
        "course": data.get("course", ""),
        "method": data.get("method", ""),
        "status": data.get("status", "present"),
        "marked_at": _json_datetime(data.get("marked_at")),
    }


def _qr_hash(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _qr_svg(session_id, token):
    payload = json.dumps(
        {"type": "campus-presence", "session_id": session_id, "token": token},
        separators=(",", ":"),
    )
    code = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=4,
    )
    code.add_data(payload)
    code.make(fit=True)
    image = code.make_image(image_factory=SvgPathImage)
    output = io.BytesIO()
    image.save(output)
    rendered_svg = output.getvalue().decode("utf-8")
    return rendered_svg[rendered_svg.index("<svg") :]


def _require_verified_email():
    if not request.current_user.get("email_verified"):
        return jsonify(error="Verify your college email before using attendance features."), 403
    return None


def _safe_csv(value):
    text = str(value or "")
    if text.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + text
    return text


def _validated_descriptor(value):
    if not isinstance(value, list) or len(value) != 128:
        raise ValueError("The face scan was invalid. Please try again.")
    try:
        descriptor = [float(item) for item in value]
    except (TypeError, ValueError) as exc:
        raise ValueError("The face scan was invalid. Please try again.") from exc
    if not all(math.isfinite(item) and abs(item) <= 10 for item in descriptor):
        raise ValueError("The face scan was invalid. Please try again.")
    return descriptor


def _record_attendance(db, session_id, student, method):
    session_ref = db.collection("sessions").document(session_id)
    session_snapshot = session_ref.get()
    if not session_snapshot.exists:
        return None, (jsonify(error="Attendance session not found."), 404)
    session = session_snapshot.to_dict()
    if not session.get("expires_at") or session["expires_at"] <= _now():
        return None, (jsonify(error="This attendance session has expired."), 410)

    attendance_ref = db.collection("attendance").document(f"{session_id}_{student['uid']}")
    profile = request.current_profile
    record = {
        "session_id": session_id,
        "user_id": student["uid"],
        "student_name": profile.get("display_name", student.get("name", "")),
        "student_email": student.get("email", ""),
        "student_id": profile.get("student_id", ""),
        "course": session.get("course", ""),
        "method": method,
        "status": "present",
        "marked_at": firestore.SERVER_TIMESTAMP,
    }
    try:
        attendance_ref.create(record)
    except AlreadyExists:
        return None, (jsonify(error="Attendance has already been recorded for this session."), 409)
    return _clean_attendance(attendance_ref.id, {**record, "marked_at": _now()}), None


@app.after_request
def _security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=()"
    response.headers["Cache-Control"] = "no-store"
    if os.getenv("FLASK_ENV") == "production":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


@app.errorhandler(413)
def _file_too_large(_error):
    return jsonify(error="Request is too large."), 413


@app.get("/")
def index():
    return render_template("index.html", firebase_config=FIREBASE_WEB_CONFIG)


@app.get("/health")
def health():
    _initialize_firebase()
    return jsonify(status="ok", firebase_configured=_firebase_ready)


@app.get("/api/me")
@_authenticated
def get_me():
    profile = dict(request.current_profile)
    profile.pop("face_embedding", None)
    profile["uid"] = request.current_user["uid"]
    profile["email"] = request.current_user.get("email", "")
    profile["email_verified"] = request.current_user.get("email_verified", False)
    return jsonify(profile)


@app.patch("/api/me")
@_authenticated
def update_me():
    payload = _payload()
    try:
        name = _valid_text(payload.get("display_name"), "Name", 100)
        student_id = payload.get("student_id", "")
        if not isinstance(student_id, str) or len(student_id.strip()) > 40:
            raise ValueError("Student ID must be 40 characters or fewer.")
        _database().collection("users").document(request.current_user["uid"]).set(
            {"display_name": name, "student_id": student_id.strip()},
            merge=True,
        )
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    return get_me()


@app.get("/api/users")
@_teacher_required
def list_users():
    users = []
    for snapshot in _database().collection("users").stream():
        user = snapshot.to_dict()
        users.append(
            {
                "uid": snapshot.id,
                "display_name": user.get("display_name", ""),
                "email": user.get("email", ""),
                "student_id": user.get("student_id", ""),
                "role": user.get("role", "student"),
                "face_enrolled": bool(user.get("face_embedding")),
            }
        )
    users.sort(key=lambda item: (item["role"] != "teacher", item["display_name"].lower()))
    return jsonify(users)


@app.patch("/api/users/<uid>")
@_teacher_required
def update_user(uid):
    payload = _payload()
    ref = _database().collection("users").document(uid)
    snapshot = ref.get()
    if not snapshot.exists:
        return jsonify(error="User not found."), 404
    updates = {}
    if "role" in payload:
        if payload["role"] not in ("student", "teacher"):
            return jsonify(error="Role must be student or teacher."), 400
        if uid == request.current_user["uid"] and payload["role"] != "teacher":
            return jsonify(error="You cannot remove your own teacher access."), 400
        if payload["role"] == "student" and snapshot.to_dict().get("email", "").lower() in ADMIN_EMAILS:
            return jsonify(error="Bootstrap teacher access cannot be removed here."), 400
        updates["role"] = payload["role"]
    if "display_name" in payload:
        try:
            updates["display_name"] = _valid_text(payload["display_name"], "Name", 100)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
    if "student_id" in payload:
        value = payload["student_id"]
        if not isinstance(value, str) or len(value.strip()) > 40:
            return jsonify(error="Student ID must be 40 characters or fewer."), 400
        updates["student_id"] = value.strip()
    if not updates:
        return jsonify(error="No valid changes provided."), 400
    ref.set(updates, merge=True)
    return jsonify(message="User updated.")


@app.get("/api/sessions")
@_authenticated
def list_sessions():
    query = _database().collection("sessions")
    sessions = [_clean_session(item.id, item.to_dict()) for item in query.stream()]
    sessions.sort(key=lambda item: item.get("expires_at") or "", reverse=True)
    return jsonify(sessions)


@app.post("/api/sessions")
@_teacher_required
def create_session():
    payload = _payload()
    try:
        course = _valid_text(payload.get("course"), "Course name", 100)
        minutes = int(payload.get("duration_minutes", 15))
    except (TypeError, ValueError):
        return jsonify(error="Session duration must be a whole number of minutes."), 400
    if minutes < 1 or minutes > 240:
        return jsonify(error="Session duration must be between 1 and 240 minutes."), 400
    db = _database()
    ref = db.collection("sessions").document()
    token = secrets.token_urlsafe(32)
    ref.set(
        {
            "course": course,
            "teacher_id": request.current_user["uid"],
            "teacher_name": request.current_profile.get("display_name", ""),
            "created_at": firestore.SERVER_TIMESTAMP,
            "expires_at": _now() + timedelta(minutes=minutes),
            "qr_token_hash": _qr_hash(token),
        }
    )
    expires_at = _json_datetime(_now() + timedelta(minutes=minutes))
    return jsonify(
        session_id=ref.id,
        qr_token=token,
        qr_svg=_qr_svg(ref.id, token),
        expires_at=expires_at,
    ), 201


@app.post("/api/sessions/<session_id>/rotate-qr")
@_teacher_required
def rotate_qr(session_id):
    ref = _database().collection("sessions").document(session_id)
    snapshot = ref.get()
    if not snapshot.exists:
        return jsonify(error="Attendance session not found."), 404
    session = snapshot.to_dict()
    if session.get("expires_at") <= _now():
        return jsonify(error="This attendance session has expired."), 410
    token = secrets.token_urlsafe(32)
    ref.update({"qr_token_hash": _qr_hash(token)})
    return jsonify(session_id=session_id, qr_token=token, qr_svg=_qr_svg(session_id, token))


@app.patch("/api/sessions/<session_id>")
@_teacher_required
def update_session(session_id):
    payload = _payload()
    updates = {}
    if "course" in payload:
        try:
            updates["course"] = _valid_text(payload["course"], "Course name", 100)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
    if "duration_minutes" in payload:
        try:
            minutes = int(payload["duration_minutes"])
            if not 1 <= minutes <= 240:
                raise ValueError
        except (ValueError, TypeError):
            return jsonify(error="Duration must be between 1 and 240 minutes."), 400
        updates["expires_at"] = _now() + timedelta(minutes=minutes)
    if not updates:
        return jsonify(error="No valid changes provided."), 400
    ref = _database().collection("sessions").document(session_id)
    if not ref.get().exists:
        return jsonify(error="Attendance session not found."), 404
    ref.update(updates)
    return jsonify(message="Session updated.")


@app.delete("/api/sessions/<session_id>")
@_teacher_required
def delete_session(session_id):
    db = _database()
    ref = db.collection("sessions").document(session_id)
    if not ref.get().exists:
        return jsonify(error="Attendance session not found."), 404
    ref.delete()
    for record in db.collection("attendance").where("session_id", "==", session_id).stream():
        record.reference.delete()
    return jsonify(message="Session and its attendance records were deleted.")


@app.post("/api/attendance/qr")
@_authenticated
def check_in_qr():
    unverified = _require_verified_email()
    if unverified:
        return unverified
    payload = _payload()
    session_id, token = payload.get("session_id"), payload.get("token")
    if not isinstance(session_id, str) or not isinstance(token, str) or len(token) > 200:
        return jsonify(error="Invalid QR code."), 400
    db = _database()
    session_snapshot = db.collection("sessions").document(session_id).get()
    if not session_snapshot.exists:
        return jsonify(error="Attendance session not found."), 404
    session = session_snapshot.to_dict()
    if not secrets.compare_digest(session.get("qr_token_hash", ""), _qr_hash(token)):
        return jsonify(error="This QR code has expired or is invalid. Scan the current code."), 403
    record, error = _record_attendance(db, session_id, request.current_user, "qr")
    return error or (jsonify(record), 201)


@app.post("/api/face/enroll")
@_authenticated
def enroll_face():
    unverified = _require_verified_email()
    if unverified:
        return unverified
    payload = _payload()
    try:
        descriptor = _validated_descriptor(payload.get("descriptor"))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    if payload.get("consent") is not True:
        return jsonify(error="Consent is required before enrolling a face template."), 400
    ref = _database().collection("users").document(request.current_user["uid"])

    @firestore.transactional
    def save_if_not_enrolled(transaction):
        snapshot = ref.get(transaction=transaction)
        if (snapshot.to_dict() or {}).get("face_embedding"):
            return False
        transaction.update(
            ref,
            {
                "face_embedding": descriptor,
                "face_enrolled_at": firestore.SERVER_TIMESTAMP,
                "face_consent_at": firestore.SERVER_TIMESTAMP,
            },
        )
        return True

    if not save_if_not_enrolled(_database().transaction()):
        return jsonify(error="Face is already enrolled. Ask a teacher to reset it before enrolling again."), 409
    return jsonify(message="Face enrollment complete.")


@app.post("/api/face/reset/<uid>")
@_teacher_required
def reset_face(uid):
    ref = _database().collection("users").document(uid)
    if not ref.get().exists:
        return jsonify(error="User not found."), 404
    ref.update(
        {
            "face_embedding": firestore.DELETE_FIELD,
            "face_enrolled_at": firestore.DELETE_FIELD,
            "face_consent_at": firestore.DELETE_FIELD,
        }
    )
    return jsonify(message="Face enrollment was reset.")


@app.delete("/api/face")
@_authenticated
def remove_own_face():
    _database().collection("users").document(request.current_user["uid"]).update(
        {
            "face_embedding": firestore.DELETE_FIELD,
            "face_enrolled_at": firestore.DELETE_FIELD,
            "face_consent_at": firestore.DELETE_FIELD,
        }
    )
    return jsonify(message="Your face enrollment was removed.")


@app.post("/api/attendance/face")
@_authenticated
def check_in_face():
    unverified = _require_verified_email()
    if unverified:
        return unverified
    payload = _payload()
    session_id = payload.get("session_id")
    if not isinstance(session_id, str):
        return jsonify(error="Choose an active attendance session."), 400
    try:
        descriptor = _validated_descriptor(payload.get("descriptor"))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    registered = request.current_profile.get("face_embedding")
    if not isinstance(registered, list) or len(registered) != 128:
        return jsonify(error="Enroll your face before using face attendance."), 409
    distance = math.sqrt(sum((float(a) - float(b)) ** 2 for a, b in zip(registered, descriptor)))
    if distance > 0.48:
        return jsonify(error="Face did not match. Try again or use QR check-in."), 403
    record, error = _record_attendance(_database(), session_id, request.current_user, "face")
    return error or (jsonify(record), 201)


@app.get("/api/attendance")
@_authenticated
def list_attendance():
    query = _database().collection("attendance")
    if request.current_profile.get("role") != "teacher":
        query = query.where("user_id", "==", request.current_user["uid"])
    records = [_clean_attendance(item.id, item.to_dict()) for item in query.stream()]
    records.sort(key=lambda item: item.get("marked_at") or "", reverse=True)
    return jsonify(records)


@app.patch("/api/attendance/<record_id>")
@_teacher_required
def update_attendance(record_id):
    payload = _payload()
    updates = {}
    if "status" in payload:
        if payload["status"] not in ("present", "late", "absent", "excused"):
            return jsonify(error="Choose a valid attendance status."), 400
        updates["status"] = payload["status"]
    if "course" in payload:
        try:
            updates["course"] = _valid_text(payload["course"], "Course name", 100)
        except ValueError as exc:
            return jsonify(error=str(exc)), 400
    if not updates:
        return jsonify(error="No valid changes provided."), 400
    ref = _database().collection("attendance").document(record_id)
    if not ref.get().exists:
        return jsonify(error="Attendance record not found."), 404
    ref.update(updates)
    return jsonify(message="Attendance updated.")


@app.delete("/api/attendance/<record_id>")
@_teacher_required
def delete_attendance(record_id):
    ref = _database().collection("attendance").document(record_id)
    if not ref.get().exists:
        return jsonify(error="Attendance record not found."), 404
    ref.delete()
    return jsonify(message="Attendance record deleted.")


@app.get("/api/reports.csv")
@_teacher_required
def attendance_report():
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Student name", "Email", "Student ID", "Course", "Status", "Method", "Marked at"])
    for snapshot in _database().collection("attendance").stream():
        record = snapshot.to_dict()
        writer.writerow(
            [
                _safe_csv(record.get("student_name", "")),
                _safe_csv(record.get("student_email", "")),
                _safe_csv(record.get("student_id", "")),
                _safe_csv(record.get("course", "")),
                _safe_csv(record.get("status", "")),
                _safe_csv(record.get("method", "")),
                _safe_csv(_json_datetime(record.get("marked_at")) or ""),
            ]
        )
    return Response(
        output.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=attendance-report.csv"},
    )


@app.errorhandler(500)
def _internal_error(_error):
    app.logger.exception("Unhandled application error")
    return jsonify(error="An unexpected server error occurred."), 500


if __name__ == "__main__":
    app.run(
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "5000")),
        debug=os.getenv("FLASK_DEBUG", "false").lower() == "true",
    )
