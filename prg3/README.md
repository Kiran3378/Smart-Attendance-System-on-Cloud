# Campus Presence

A responsive college attendance website with Firebase Authentication and Firestore, teacher-managed class sessions, QR check-in, face-template check-in, student attendance history, and teacher CSV reports.

## Roles

- **Students** can see their own attendance, update their profile, enroll a face template, and check in to an active class using QR or face matching.
- **Teachers** can see and edit college attendance, manage people and roles, create/update/delete class sessions, reset face enrollment, and download a CSV report.
- New accounts always start as students. Set `ADMIN_EMAILS` before starting to give a trusted, verified college email its initial teacher role. Teachers can promote or demote other accounts in the People page; the bootstrap teacher cannot demote themself or another bootstrap teacher.

## Requirements

- Python 3.10 or newer.
- A Firebase project with **Email/Password Authentication** and **Cloud Firestore** enabled.
- A Firebase service-account credential for the Flask server.
- HTTPS for any deployment beyond local development. Browsers require HTTPS (or localhost) for camera access.

## Firebase setup

1. Create a Firebase project and enable **Authentication → Sign-in method → Email/Password**.
2. Create a Cloud Firestore database.
3. In Firebase **Project settings → Your apps**, register a Web app and copy its configuration.
4. In **Project settings → Service accounts**, generate a private key for the Flask server. Keep the downloaded JSON outside the project folder and never commit or share it. Restrict the Firebase Web API key to the required Firebase APIs and your production domains.
5. Copy `.env.example` to `.env`. Fill in the web configuration, the absolute service-account file path, and the trusted teacher email address(es).
6. Publish `firestore.rules` to Firebase. The rules deny all direct browser access: all data operations go through the authenticated Flask API and Firebase Admin SDK.
7. In Firebase Authentication settings, add the college domain to **Authorized domains** if needed.

## Run locally on Windows

From PowerShell in the project folder:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env with your Firebase values before starting.
python app.py
```

Open <http://127.0.0.1:5000>. Localhost is permitted for camera access. For a production deployment, use a supported Python release, run behind an HTTPS reverse proxy, set `FLASK_ENV=production`, use a managed secret store for credentials, and restrict Firebase service-account access.

## Deploy to Google Cloud Run

The included Dockerfile is suitable for Cloud Run and uses Application Default Credentials, so do not upload a service-account JSON key to the container.

1. Create a Cloud Run runtime service account and grant it **Cloud Datastore User** (`roles/datastore.user`) on the Firebase project.
2. Enable Cloud Run, Cloud Build, Artifact Registry, and Firestore APIs in the Google Cloud project. Configure Firebase Authentication's authorized domains to include the Cloud Run domain.
3. Create an Artifact Registry Docker repository in your target region, then build and deploy from the project directory:

```powershell
gcloud artifacts repositories create campus-presence --repository-format=docker --location=REGION
gcloud builds submit --tag REGION-docker.pkg.dev/PROJECT_ID/campus-presence/web:latest
gcloud run deploy campus-presence `
  --image REGION-docker.pkg.dev/PROJECT_ID/campus-presence/web:latest `
  --region REGION `
  --service-account campus-presence-runtime@PROJECT_ID.iam.gserviceaccount.com `
  --allow-unauthenticated `
  --set-env-vars "FIREBASE_API_KEY=...,FIREBASE_AUTH_DOMAIN=...,FIREBASE_PROJECT_ID=PROJECT_ID,FIREBASE_STORAGE_BUCKET=...,FIREBASE_MESSAGING_SENDER_ID=...,FIREBASE_APP_ID=...,ADMIN_EMAILS=teacher@yourcollege.edu,FLASK_ENV=production"
```

Replace every placeholder with your project values. For production, store configuration in Secret Manager and attach secrets to the Cloud Run service instead of putting values directly in shell history. `ADMIN_EMAILS` is an initial trusted teacher bootstrap list; emails must be verified. Do not set `GOOGLE_APPLICATION_CREDENTIALS` on Cloud Run: its runtime service account provides credentials.

## Attendance workflows

1. A teacher creates a timed class session. The server generates a high-entropy QR token and renders its QR code as SVG; the displayed QR rotates every 30 seconds, and only the current token is accepted. QR rendering does not depend on a browser QR-code CDN.
2. A student scans the teacher's QR with their device camera, or selects an active session and checks in with an enrolled face.
3. The Flask API verifies the Firebase ID token and session, checks for an existing student/session record, and writes attendance server-side. One student cannot mark the same class twice.
4. Teachers can correct or delete attendance from the Attendance page. Student views are scoped to the authenticated student's records.

The QR code is a short-lived bearer credential: teachers should display it only in class and invalidate/delete sessions after use. Students should not share account credentials.

## Face-check-in privacy and security

Camera frames are processed in the browser using face-api.js. Only a 128-number face descriptor is sent to the Flask API and stored for matching; images/video are not uploaded or retained. Students must explicitly consent before enrollment and can remove their own template later; teachers can also reset an enrollment. Firestore direct client access is denied, and students cannot replace an existing template themselves.

This is a **college project/demo implementation**, not a certified biometric authentication or liveness-detection system. The browser calculates the descriptor, so a determined user who can modify client requests may bypass face matching. Do not use face matching as the sole proof of attendance in a high-stakes setting. Prefer QR check-in with teacher supervision, add a vetted server-side face/liveness provider, document consent/retention, and obtain college privacy approval before real biometric use.

## Security notes

- Firebase ID tokens are verified by the server, including revocation checks.
- Users cannot assign their own role. A trusted bootstrap teacher is configured through `ADMIN_EMAILS`; subsequent role changes require a teacher account.
- Attendance features and teacher tools require a verified Firebase email address. New accounts receive a verification email.
- Attendance, QR token, session, and user-management mutations are enforced server-side. Firestore client rules deny all access.
- API input and face descriptor sizes are validated; the request body is capped at 2 MB. Security headers are set on responses.
- The service-account key and `.env` must never be checked into version control. Rotate the key immediately if it is exposed.
- For public deployment, configure HTTPS, secure backups, audit logging, abuse/rate limiting at the hosting gateway, account recovery/MFA, and a documented data-retention policy.

## Data stored in Firestore

- `users/{uid}`: account profile, role, and optional numeric face descriptor.
- `sessions/{sessionId}`: course, teacher, expiry time, and SHA-256 hash of the current QR token.
- `attendance/{sessionId_uid}`: one attendance row per student per session.

The Flask `/health` route reports whether Firebase Admin credentials initialized; it does not expose credentials or user data.
