(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const firebaseConfig = JSON.parse(document.querySelector('meta[name="firebase-config"]').content);
  let auth;
  let currentUser = null;
  let accessToken = null;
  let profile = null;
  let attendance = [];
  let sessions = [];
  let people = [];
  let scanner = null;
  let cameraStream = null;
  let cameraAction = null;
  let faceModelsLoaded = false;
  let currentQrSession = null;
  let qrRefreshTimer = null;
  let toastTimer = null;

  const faceModelUrl = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights";

  function notify(message, error = false) {
    const toast = $("#toast");
    toast.textContent = message;
    toast.classList.toggle("error", error);
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3800);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("Content-Type", "application/json");
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    return fetch(path, { ...options, headers }).then(async (response) => {
      const contentType = response.headers.get("content-type") || "";
      const data = contentType.includes("application/json") ? await response.json() : null;
      if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
      return data;
    });
  }

  async function currentIdToken(forceRefresh = false) {
    if (!currentUser) throw new Error("Please sign in again.");
    accessToken = await currentUser.getIdToken(forceRefresh);
  }

  async function apiWithFreshToken(path, options = {}) {
    await currentIdToken();
    return api(path, options);
  }

  async function downloadReport() {
    try {
      await currentIdToken();
      const response = await fetch("/api/reports.csv", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `Download failed (${response.status}).`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = "attendance-report.csv";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      notify(error.message, true);
    }
  }

  function initials(name) {
    return (name || "S").trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }

  function formatDate(value, withTime = true) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, withTime
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" }).format(date);
  }

  function showAuth() {
    $("#auth-view").classList.remove("hidden");
    $("#app-view").classList.add("hidden");
  }

  function showApp() {
    $("#auth-view").classList.add("hidden");
    $("#app-view").classList.remove("hidden");
  }

  function setPage(page) {
    $$(".page").forEach((section) => section.classList.toggle("hidden", section.id !== `page-${page}`));
    $$(".nav-link[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
    const active = $(`.nav-link[data-page="${page}"]`);
    $("#page-crumb").textContent = active?.textContent.trim() || "Overview";
    if (page === "people") renderPeople();
    if (page === "sessions") renderSessions();
  }

  function makeEmptyRow(columns, message) {
    return `<tr><td class="empty-cell" colspan="${columns}">${escapeHtml(message)}</td></tr>`;
  }

  function statusCell(status) {
    return `<span class="status-pill ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
  }

  function renderAttendanceTable(records, teacher = false) {
    const head = $("#attendance-head");
    const body = $("#attendance-rows");
    if (teacher) {
      head.innerHTML = "<tr><th>STUDENT</th><th>CLASS / COURSE</th><th>DATE & TIME</th><th>METHOD</th><th>STATUS</th><th>MANAGE</th></tr>";
    } else {
      head.innerHTML = "<tr><th>CLASS / COURSE</th><th>DATE & TIME</th><th>METHOD</th><th>STATUS</th></tr>";
    }
    const query = ($("#attendance-search").value || "").trim().toLowerCase();
    const filtered = records.filter((record) => {
      const text = `${record.course} ${record.student_name} ${record.student_email}`.toLowerCase();
      return text.includes(query);
    });
    if (!filtered.length) {
      body.innerHTML = makeEmptyRow(teacher ? 6 : 4, query ? "No matching attendance records." : "No attendance records yet.");
      return;
    }
    body.innerHTML = filtered.map((record) => teacher
      ? `<tr>
          <td><span class="course-cell">${escapeHtml(record.student_name || "Student")}</span><span class="sub-cell">${escapeHtml(record.student_email || "")}</span></td>
          <td class="course-cell">${escapeHtml(record.course)}</td>
          <td>${escapeHtml(formatDate(record.marked_at))}</td>
          <td><span class="method-pill">${escapeHtml(record.method)}</span></td>
          <td>${statusCell(record.status)}</td>
          <td><div class="row-actions"><button class="action-link" data-edit-attendance="${escapeHtml(record.id)}">Edit</button><button class="action-link danger" data-delete-attendance="${escapeHtml(record.id)}">Delete</button></div></td>
        </tr>`
      : `<tr>
          <td class="course-cell">${escapeHtml(record.course)}</td>
          <td>${escapeHtml(formatDate(record.marked_at))}</td>
          <td><span class="method-pill">${escapeHtml(record.method)}</span></td>
          <td>${statusCell(record.status)}</td>
        </tr>`).join("");
  }

  function renderOverview() {
    const teacher = profile?.role === "teacher";
    const attended = attendance.filter((record) => record.status === "present" || record.status === "late").length;
    const totalSessions = sessions.length;
    const rate = totalSessions ? `${Math.round(attended / totalSessions * 100)}%` : (attended ? "100%" : "—");
    $("#stat-attended").textContent = teacher ? attendance.length : attended;
    $("#stat-attended-label").textContent = teacher ? "Attendance records" : "Classes attended";
    $("#stat-rate").textContent = teacher ? `${people.length} users` : rate;
    $(".stat-card:nth-child(2) .stat-label").textContent = teacher ? "College accounts" : "Attendance rate";
    $("#stat-third-label").textContent = "Open sessions";
    $("#stat-third").textContent = sessions.filter((session) => session.active).length;
    $("#stat-third-caption").textContent = "Open for check-in";
    $("#stat-rate").nextElementSibling.textContent = teacher ? "Registered college accounts" : "Based on recorded classes";

    const recent = $("#recent-rows");
    const records = [...attendance].sort((a, b) => new Date(b.marked_at || 0) - new Date(a.marked_at || 0)).slice(0, 5);
    recent.innerHTML = records.length ? records.map((record) => `
      <tr>
        <td class="course-cell">${escapeHtml(record.course)}${teacher ? `<span class="sub-cell">${escapeHtml(record.student_name || "")}</span>` : ""}</td>
        <td>${escapeHtml(formatDate(record.marked_at))}</td>
        <td><span class="method-pill">${escapeHtml(record.method)}</span></td>
        <td>${statusCell(record.status)}</td>
      </tr>`).join("") : makeEmptyRow(4, "Your recent attendance will appear here.");
  }

  function renderProfile() {
    const name = profile?.display_name || currentUser?.displayName || "Student";
    $("#user-name").textContent = name;
    $("#user-email").textContent = currentUser?.email || "";
    $("#user-avatar").textContent = initials(name);
    $("#role-badge").textContent = profile?.role === "teacher" ? "Teacher" : "Student";
    $("#profile-name").textContent = name;
    $("#profile-email").textContent = currentUser?.email || "—";
    $("#profile-student-id").textContent = profile?.student_id || "Not set";
    $("#profile-face").textContent = profile?.face_enrolled ? "Enrolled" : "Not enrolled";
    $("#remove-face").classList.toggle("hidden", !profile?.face_enrolled);
    $("#enroll-face").classList.toggle("hidden", Boolean(profile?.face_enrolled));
    $("#verify-email-banner").classList.toggle("hidden", Boolean(profile?.email_verified));
    $("#profile-avatar").textContent = initials(name);
    const hour = new Date().getHours();
    $("#greeting").textContent = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}, ${name.split(" ")[0]}`;
    $("#today-label").textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date()).toUpperCase();
    $$(".teacher-only").forEach((element) => element.classList.toggle("hidden", profile?.role !== "teacher"));
    $("#attendance-description").textContent = profile?.role === "teacher" ? "View, correct, or remove attendance records for your college." : "Your personal class attendance history.";
    $("#attendance-table-title").textContent = profile?.role === "teacher" ? "All college records" : "Your records";
  }

  function renderSessions() {
    const body = $("#session-rows");
    if (!body) return;
    if (!sessions.length) {
      body.innerHTML = makeEmptyRow(5, "No class sessions yet. Create one above to begin.");
      return;
    }
    body.innerHTML = sessions.map((session) => `
      <tr>
        <td class="course-cell">${escapeHtml(session.course)}</td>
        <td>${escapeHtml(formatDate(session.created_at))}</td>
        <td>${escapeHtml(formatDate(session.expires_at))}</td>
        <td>${session.active ? '<span class="status-pill">active</span>' : '<span class="status-pill absent">expired</span>'}</td>
        <td><div class="row-actions">${session.active ? `<button class="action-link" data-show-qr="${escapeHtml(session.id)}">Show QR</button>` : ""}<button class="action-link" data-edit-session="${escapeHtml(session.id)}">Edit</button><button class="action-link danger" data-delete-session="${escapeHtml(session.id)}">Delete</button></div></td>
      </tr>`).join("");
  }

  function renderPeople() {
    const body = $("#people-rows");
    if (!body) return;
    const search = ($("#people-search").value || "").trim().toLowerCase();
    const filtered = people.filter((person) => `${person.display_name} ${person.email} ${person.student_id}`.toLowerCase().includes(search));
    body.innerHTML = filtered.length ? filtered.map((person) => `
      <tr>
        <td class="course-cell">${escapeHtml(person.display_name || "—")}</td>
        <td>${escapeHtml(person.email)}</td>
        <td>${escapeHtml(person.student_id || "—")}</td>
        <td><select class="people-role-select" aria-label="Role for ${escapeHtml(person.display_name)}" data-role-user="${escapeHtml(person.uid)}">
          <option value="student" ${person.role === "student" ? "selected" : ""}>Student</option>
          <option value="teacher" ${person.role === "teacher" ? "selected" : ""}>Teacher</option>
        </select></td>
        <td>${person.face_enrolled ? '<span class="status-pill">enrolled</span>' : '<span class="method-pill">Not enrolled</span>'}</td>
        <td><div class="row-actions"><button class="action-link" data-edit-user="${escapeHtml(person.uid)}">Edit</button><button class="action-link" data-reset-face="${escapeHtml(person.uid)}">Reset face</button></div></td>
      </tr>`).join("") : makeEmptyRow(6, search ? "No people match your search." : "No college accounts found.");
  }

  async function refreshDashboard() {
    if (!currentUser) return;
    await currentIdToken();
    const requests = [
      api("/api/me"),
      api("/api/attendance"),
      api("/api/sessions"),
    ];
    if (profile?.role === "teacher") requests.push(api("/api/users"));
    const result = await Promise.all(requests);
    profile = result[0];
    attendance = result[1];
    sessions = result[2];
    people = result[3] || [];
    renderProfile();
    renderOverview();
    renderAttendanceTable(attendance, profile.role === "teacher");
    renderSessions();
    renderPeople();
  }

  async function handleAuthUser(user) {
    currentUser = user;
    if (!user) {
      accessToken = null;
      profile = null;
      attendance = [];
      sessions = [];
      showAuth();
      return;
    }
    try {
      await currentIdToken();
      profile = await api("/api/me");
      showApp();
      await refreshDashboard();
    } catch (error) {
      notify(error.message, true);
      if (error.message.includes("Firebase is not configured")) await auth.signOut();
    }
  }

  function parseQr(text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.type === "campus-presence" && parsed.session_id && parsed.token) return parsed;
    } catch (_) { /* QR is not JSON. */ }
    const parts = text.trim().split("|");
    if (parts.length === 3 && parts[0] === "CAMPUS-PRESENCE") {
      return { session_id: parts[1], token: parts[2] };
    }
    throw new Error("This QR code is not a Campus Presence check-in code.");
  }

  async function stopScanner() {
    if (!scanner) return;
    try {
      if (scanner.isScanning) await scanner.stop();
      await scanner.clear();
    } catch (_) { /* Scanner may already be stopped. */ }
    scanner = null;
  }

  async function openScanner() {
    if (!window.Html5Qrcode) {
      notify("The QR scanner library did not load. Refresh and try again.", true);
      return;
    }
    const dialog = document.createElement("dialog");
    dialog.className = "modal";
    dialog.innerHTML = `<div class="modal-heading"><div><span class="eyebrow">QUICK CHECK-IN</span><h2>Scan class QR</h2></div><button class="icon-button" aria-label="Close">×</button></div>
      <p class="muted">Hold the code inside the camera frame.</p><div id="qr-reader" class="qr-reader"></div><div class="camera-status">Point your camera at the teacher’s QR code.</div>`;
    document.body.append(dialog);
    dialog.querySelector(".icon-button").addEventListener("click", async () => {
      await stopScanner();
      dialog.close();
      dialog.remove();
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    try {
      scanner = new Html5Qrcode("qr-reader");
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 230, height: 230 } },
        async (decodedText) => {
          await stopScanner();
          try {
            const data = parseQr(decodedText);
            await apiWithFreshToken("/api/attendance/qr", { method: "POST", body: JSON.stringify(data) });
            dialog.close();
            notify("Attendance marked. Have a great class!");
            await refreshDashboard();
          } catch (error) {
            dialog.querySelector(".camera-status").textContent = error.message;
            dialog.querySelector(".camera-status").classList.add("error");
          }
        },
        () => {},
      );
    } catch (error) {
      dialog.querySelector(".camera-status").textContent = error.message || "Could not access camera. Check camera permissions.";
      dialog.querySelector(".camera-status").classList.add("error");
    }
  }

  function loadFaceModels() {
    if (faceModelsLoaded) return Promise.resolve();
    if (!window.faceapi) return Promise.reject(new Error("Face recognition did not load. Check your internet connection and try again."));
    return Promise.all([
      faceapi.nets.ssdMobilenetv1.loadFromUri(faceModelUrl),
      faceapi.nets.faceLandmark68Net.loadFromUri(faceModelUrl),
      faceapi.nets.faceRecognitionNet.loadFromUri(faceModelUrl),
    ]).then(() => { faceModelsLoaded = true; });
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = null;
    }
    $("#camera-video").srcObject = null;
  }

  async function startCamera() {
    const button = $("#camera-action");
    button.disabled = true;
    $("#camera-status").textContent = "Requesting camera access…";
    $("#camera-status").classList.remove("error");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Camera access requires HTTPS or localhost in a supported browser.");
      }
      const streamRequest = navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      const modelsRequest = loadFaceModels().then(
        () => null,
        (error) => error,
      );
      cameraStream = await streamRequest;
      $("#camera-video").srcObject = cameraStream;
      await $("#camera-video").play();
      $("#camera-status").textContent = "Loading face matching. Keep your face in the frame…";
      const modelError = await modelsRequest;
      if (modelError) throw modelError;
      $("#camera-status").textContent = "Center your face in the frame and hold still.";
      button.textContent = cameraAction === "enroll" ? "Save face enrollment" : "Check in with face";
      button.disabled = cameraAction === "enroll" && !$("#face-consent-check").checked;
    } catch (error) {
      stopCamera();
      $("#camera-status").textContent = error.name === "NotAllowedError"
        ? "Camera access was denied. Allow camera access or use QR check-in."
        : (error.message || "Camera is not available on this device.");
      $("#camera-status").classList.add("error");
      button.textContent = "Try again";
      button.disabled = false;
    }
  }

  async function openFaceDialog(mode) {
    cameraAction = mode;
    const dialog = $("#camera-dialog");
    $("#camera-title").textContent = mode === "enroll" ? "Enroll your face" : "Face check-in";
    $("#camera-eyebrow").textContent = mode === "enroll" ? "ONE-TIME SETUP" : "QUICK CHECK-IN";
    $("#camera-help").textContent = mode === "enroll"
      ? "We create a numeric face template in your browser. No camera image is uploaded. Consent is required."
      : "Look at the camera and hold still. Your face is matched to your saved template.";
    $("#face-consent").classList.toggle("hidden", mode !== "enroll");
    $("#face-consent-check").checked = false;
    $("#camera-action").textContent = "Start camera";
    $("#camera-action").disabled = false;
    $("#camera-status").textContent = "Camera will start when you continue.";
    $("#camera-status").classList.remove("error");
    $("#camera-session-picker").classList.toggle("hidden", mode !== "checkin");
    if (mode === "checkin") {
      const active = sessions.filter((session) => session.active);
      $("#face-session").innerHTML = active.length
        ? active.map((session) => `<option value="${escapeHtml(session.id)}">${escapeHtml(session.course)}</option>`).join("")
        : '<option value="">No active sessions</option>';
      $("#camera-action").disabled = active.length === 0;
      if (!active.length) $("#camera-status").textContent = "There are no active sessions to check in to.";
    }
    if (!dialog.open) dialog.showModal();
    if (mode === "checkin" && sessions.some((session) => session.active)) {
      startCamera();
    }
  }

  async function captureDescriptor() {
    const video = $("#camera-video");
    const detection = await faceapi.detectSingleFace(video).withFaceLandmarks().withFaceDescriptor();
    if (!detection) throw new Error("No clear face detected. Center your face and try again.");
    if (detection.detection.score < 0.75) throw new Error("Face image is not clear enough. Improve the lighting and try again.");
    return Array.from(detection.descriptor);
  }

  async function runFaceAction() {
    if (!cameraStream) {
      await startCamera();
      return;
    }
    const button = $("#camera-action");
    button.disabled = true;
    $("#camera-status").textContent = "Checking your face…";
    $("#camera-status").classList.remove("error");
    try {
      const descriptor = await captureDescriptor();
      if (cameraAction === "enroll") {
        if (!$("#face-consent-check").checked) throw new Error("Consent is required before face enrollment.");
        await apiWithFreshToken("/api/face/enroll", { method: "POST", body: JSON.stringify({ descriptor, consent: true }) });
        notify("Face enrolled. You can now check in by face.");
      } else {
        await apiWithFreshToken("/api/attendance/face", {
          method: "POST",
          body: JSON.stringify({ session_id: $("#face-session").value, descriptor }),
        });
        notify("Attendance marked. Have a great class!");
      }
      $("#camera-dialog").close();
      stopCamera();
      await refreshDashboard();
    } catch (error) {
      $("#camera-status").textContent = error.message;
      $("#camera-status").classList.add("error");
      button.disabled = false;
    }
  }

  function drawQr(svg) {
    const container = $("#session-qr");
    container.replaceChildren();
    if (typeof svg !== "string" || !svg.startsWith("<svg")) {
      throw new Error("The server did not return a valid QR code.");
    }
    const image = document.createElement("img");
    image.alt = "Scan this QR code to mark attendance";
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    container.append(image);
    $("#qr-code-status").textContent = "QR ready. It refreshes every 30 seconds.";
  }

  let qrRotationInProgress = false;

  async function rotateCurrentQr() {
    if (!currentQrSession || qrRotationInProgress) return;
    if (new Date(currentQrSession.expires_at) <= new Date()) {
      clearInterval(qrRefreshTimer);
      $("#session-qr").replaceChildren();
      $("#qr-code-status").textContent = "This class session has expired.";
      $("#rotate-qr").disabled = true;
      return;
    }
    qrRotationInProgress = true;
    $("#rotate-qr").disabled = true;
    $("#qr-code-status").textContent = "Generating a new QR code…";
    try {
      const data = await apiWithFreshToken(`/api/sessions/${encodeURIComponent(currentQrSession.id)}/rotate-qr`, { method: "POST" });
      drawQr(data.qr_svg);
      $("#active-qr-expires").textContent = `Session expires ${formatDate(currentQrSession.expires_at)}.`;
    } catch (error) {
      $("#session-qr").replaceChildren();
      $("#qr-code-status").textContent = error.message;
      notify(error.message, true);
    } finally {
      qrRotationInProgress = false;
      $("#rotate-qr").disabled = false;
    }
  }

  async function showSessionQr(session, initialQrSvg = null) {
    currentQrSession = session;
    $("#session-qr-area").classList.remove("hidden");
    $("#active-qr-course").textContent = session.course;
    clearInterval(qrRefreshTimer);
    $("#rotate-qr").disabled = false;
    $("#qr-code-status").textContent = "";
    if (initialQrSvg) {
      drawQr(initialQrSvg);
      $("#active-qr-expires").textContent = `Session expires ${formatDate(session.expires_at)}.`;
    } else {
      await rotateCurrentQr();
    }
    qrRefreshTimer = setInterval(rotateCurrentQr, 30000);
    $("#session-qr-area").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function initApp() {
    $("#show-register").addEventListener("click", () => {
      $("#login-form").classList.add("hidden");
      $("#register-form").classList.remove("hidden");
    });
    $("#show-login").addEventListener("click", () => {
      $("#register-form").classList.add("hidden");
      $("#login-form").classList.remove("hidden");
    });

    $("#sign-in").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        await auth.signInWithEmailAndPassword($("#login-email").value.trim(), $("#login-password").value);
      } catch (error) {
        notify(error.message.replace("Firebase: ", ""), true);
      } finally {
        button.disabled = false;
      }
    });

    $("#sign-up").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button[type=submit]");
      button.disabled = true;
      let credential;
      try {
        credential = await auth.createUserWithEmailAndPassword($("#register-email").value.trim(), $("#register-password").value);
        await credential.user.updateProfile({ displayName: $("#register-name").value.trim() });
        await credential.user.sendEmailVerification();
        currentUser = credential.user;
        await currentIdToken(true);
        profile = await api("/api/me");
        await api("/api/me", {
          method: "PATCH",
          body: JSON.stringify({ display_name: $("#register-name").value.trim(), student_id: $("#register-id").value.trim() }),
        });
        await refreshDashboard();
        notify("Account created. Verify your email before checking in.");
      } catch (error) {
        notify(error.message.replace("Firebase: ", ""), true);
        if (credential) await auth.signOut();
      } finally {
        button.disabled = false;
      }
    });

    $("#sign-out").addEventListener("click", () => auth.signOut());
    $("#report-button").addEventListener("click", downloadReport);
    $("#attendance-report-button").addEventListener("click", downloadReport);
    $("#resend-verification").addEventListener("click", async () => {
      try {
        await currentUser.sendEmailVerification();
        notify("Verification email sent.");
      } catch (error) { notify(error.message.replace("Firebase: ", ""), true); }
    });
    $("#confirm-verification").addEventListener("click", async () => {
      try {
        await currentUser.reload();
        currentUser = auth.currentUser;
        await currentIdToken(true);
        profile = await api("/api/me");
        await refreshDashboard();
        if (profile.email_verified) notify("Email verified. Attendance features are ready.");
        else notify("Email is not verified yet. Open the link in the email, then try again.", true);
      } catch (error) { notify(error.message, true); }
    });
    $$(".nav-link[data-page]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.page)));
    $$("[data-goto]").forEach((button) => button.addEventListener("click", () => setPage(button.dataset.goto)));
    $("#scan-qr").addEventListener("click", openScanner);
    $("#face-checkin").addEventListener("click", () => {
      if (!profile?.face_enrolled) {
        notify("Enroll your face first. Camera setup is opening now.", true);
        openFaceDialog("enroll");
        startCamera();
        return;
      }
      openFaceDialog("checkin");
    });
    $("#enroll-face").addEventListener("click", () => openFaceDialog("enroll"));
    $("#face-consent-check").addEventListener("change", (event) => {
      if (cameraAction === "enroll") {
        $("#camera-action").disabled = !event.target.checked || !faceModelsLoaded || !cameraStream;
      }
    });
    $("#remove-face").addEventListener("click", async () => {
      if (!confirm("Remove your saved face template? You can still use QR check-in.")) return;
      try {
        await apiWithFreshToken("/api/face", { method: "DELETE" });
        await refreshDashboard();
        notify("Face enrollment removed.");
      } catch (error) { notify(error.message, true); }
    });
    $("#camera-action").addEventListener("click", runFaceAction);
    $$("[data-close]").forEach((button) => button.addEventListener("click", () => {
      const dialog = $(`#${button.dataset.close}`);
      dialog.close();
      if (dialog.id === "camera-dialog") stopCamera();
    }));
    $("#camera-dialog").addEventListener("close", stopCamera);

    $("#edit-profile").addEventListener("click", () => {
      $("#edit-name").value = profile?.display_name || "";
      $("#edit-student-id").value = profile?.student_id || "";
      $("#profile-dialog").showModal();
    });
    $("#profile-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await apiWithFreshToken("/api/me", {
          method: "PATCH",
          body: JSON.stringify({ display_name: $("#edit-name").value.trim(), student_id: $("#edit-student-id").value.trim() }),
        });
        $("#profile-dialog").close();
        await refreshDashboard();
        notify("Profile updated.");
      } catch (error) { notify(error.message, true); }
    });

    $("#create-session").addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const course = $("#session-course").value.trim();
        const data = await apiWithFreshToken("/api/sessions", {
          method: "POST",
          body: JSON.stringify({ course, duration_minutes: Number($("#session-duration").value) }),
        });
        await showSessionQr({
          id: data.session_id,
          course,
          expires_at: data.expires_at,
          active: true,
        }, data.qr_svg);
        await refreshDashboard();
        $("#session-course").value = "";
        notify("Class session created.");
      } catch (error) {
        notify(error.message, true);
      } finally {
        button.disabled = false;
      }
    });
    $("#rotate-qr").addEventListener("click", rotateCurrentQr);

    $("#attendance-search").addEventListener("input", () => renderAttendanceTable(attendance, profile?.role === "teacher"));
    $("#people-search").addEventListener("input", renderPeople);
    $("#people-rows").addEventListener("change", async (event) => {
      const uid = event.target.dataset.roleUser;
      if (!uid) return;
      try {
        await apiWithFreshToken(`/api/users/${encodeURIComponent(uid)}`, {
          method: "PATCH",
          body: JSON.stringify({ role: event.target.value }),
        });
        await refreshDashboard();
        notify("User role updated.");
      } catch (error) {
        notify(error.message, true);
        await refreshDashboard();
      }
    });
    $("#people-rows").addEventListener("click", async (event) => {
      const uid = event.target.dataset.resetFace;
      const editUid = event.target.dataset.editUser;
      if (editUid) {
        const person = people.find((item) => item.uid === editUid);
        if (!person) return;
        const displayName = prompt("Update person's name:", person.display_name || "");
        if (displayName === null) return;
        const studentId = prompt("Update college ID:", person.student_id || "");
        if (studentId === null) return;
        try {
          await apiWithFreshToken(`/api/users/${encodeURIComponent(editUid)}`, {
            method: "PATCH",
            body: JSON.stringify({ display_name: displayName.trim(), student_id: studentId.trim() }),
          });
          await refreshDashboard();
          notify("College profile updated.");
        } catch (error) { notify(error.message, true); }
        return;
      }
      if (!uid || !confirm("Reset this person's face enrollment? They will need to enroll again.")) return;
      try {
        await apiWithFreshToken(`/api/face/reset/${encodeURIComponent(uid)}`, { method: "POST" });
        await refreshDashboard();
        notify("Face enrollment reset.");
      } catch (error) { notify(error.message, true); }
    });

    $("#attendance-rows").addEventListener("click", async (event) => {
      const recordId = event.target.dataset.editAttendance;
      const deleteId = event.target.dataset.deleteAttendance;
      if (recordId) {
        const record = attendance.find((item) => item.id === recordId);
        if (!record) return;
        $("#edit-attendance-id").value = record.id;
        $("#edit-attendance-course").value = record.course;
        $("#edit-attendance-status").value = record.status;
        $("#edit-attendance-dialog").showModal();
      } else if (deleteId && confirm("Delete this attendance record? This cannot be undone.")) {
        try {
          await apiWithFreshToken(`/api/attendance/${encodeURIComponent(deleteId)}`, { method: "DELETE" });
          await refreshDashboard();
          notify("Attendance record deleted.");
        } catch (error) { notify(error.message, true); }
      }
    });
    $("#edit-attendance-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const id = $("#edit-attendance-id").value;
      try {
        await apiWithFreshToken(`/api/attendance/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ course: $("#edit-attendance-course").value.trim(), status: $("#edit-attendance-status").value }),
        });
        $("#edit-attendance-dialog").close();
        await refreshDashboard();
        notify("Attendance updated.");
      } catch (error) { notify(error.message, true); }
    });

    $("#session-rows").addEventListener("click", async (event) => {
      const qrId = event.target.dataset.showQr;
      const editId = event.target.dataset.editSession;
      const deleteId = event.target.dataset.deleteSession;
      if (qrId) {
        const session = sessions.find((item) => item.id === qrId);
        if (session) await showSessionQr(session);
      } else if (editId) {
        const session = sessions.find((item) => item.id === editId);
        if (!session) return;
        const course = prompt("Update course name:", session.course);
        if (course === null) return;
        const durationText = prompt("Set the new time-to-expiry in minutes (1-240):", "15");
        if (durationText === null) return;
        try {
          await apiWithFreshToken(`/api/sessions/${encodeURIComponent(editId)}`, {
            method: "PATCH",
            body: JSON.stringify({ course: course.trim(), duration_minutes: Number(durationText) }),
          });
          await refreshDashboard();
          notify("Session updated.");
        } catch (error) { notify(error.message, true); }
      } else if (deleteId && confirm("Delete this session and all its attendance records? This cannot be undone.")) {
        try {
          await apiWithFreshToken(`/api/sessions/${encodeURIComponent(deleteId)}`, { method: "DELETE" });
          await refreshDashboard();
          notify("Session deleted.");
        } catch (error) { notify(error.message, true); }
      }
    });

    const isConfigured = Object.values(firebaseConfig).every(Boolean);
    if (!window.firebase || !isConfigured) {
      showAuth();
      const setupNotice = $("#firebase-setup-notice");
      if (setupNotice) setupNotice.classList.remove("hidden");
      $$("#sign-in input, #sign-in button, #sign-up input, #sign-up button").forEach((control) => {
        control.disabled = true;
      });
      $("#show-register").disabled = true;
      return;
    }
    try {
      firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      auth.onAuthStateChanged(handleAuthUser);
    } catch (error) {
      showAuth();
      const setupNotice = $("#firebase-setup-notice");
      if (setupNotice) {
        setupNotice.classList.remove("hidden");
        setupNotice.querySelector("strong").textContent = "Firebase could not be initialized";
        setupNotice.querySelector("p").textContent = error.message;
      }
      $$("#sign-in input, #sign-in button, #sign-up input, #sign-up button").forEach((control) => {
        control.disabled = true;
      });
      $("#show-register").disabled = true;
      notify(`Firebase setup error: ${error.message}`, true);
    }
  }

  document.addEventListener("DOMContentLoaded", initApp);
})();
