import unittest
from unittest.mock import MagicMock, patch

from app import _qr_hash, _qr_svg, _safe_csv, _validated_descriptor, app


class FaceDescriptorTests(unittest.TestCase):
    def test_accepts_a_valid_descriptor(self):
        descriptor = [0.1] * 128
        self.assertEqual(_validated_descriptor(descriptor), descriptor)

    def test_rejects_wrong_descriptor_length(self):
        with self.assertRaises(ValueError):
            _validated_descriptor([0.1] * 127)

    def test_rejects_non_finite_descriptor_values(self):
        with self.assertRaises(ValueError):
            _validated_descriptor([float("nan")] + [0.1] * 127)


class QrTokenTests(unittest.TestCase):
    def test_hash_is_deterministic_and_one_way_sized(self):
        digest = _qr_hash("example-token")
        self.assertEqual(digest, _qr_hash("example-token"))
        self.assertEqual(len(digest), 64)
        self.assertNotEqual(digest, "example-token")

    def test_generates_svg_qr_for_scan_payload(self):
        image = _qr_svg("session-123", "secret-token")
        self.assertTrue(image.startswith("<svg"))
        self.assertIn("<path", image)
        self.assertNotIn("secret-token", image)


class CsvSafetyTests(unittest.TestCase):
    def test_prefixes_formula_values(self):
        self.assertEqual(_safe_csv("=SUM(1,1)"), "'=SUM(1,1)")
        self.assertEqual(_safe_csv("  @value"), "'  @value")
        self.assertEqual(_safe_csv("Biology 101"), "Biology 101")


class WebAppTests(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        self.client = app.test_client()

    def test_home_page_is_available_without_cloud_credentials(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Campus Presence", response.data)
        self.assertIn(b'id="firebase-setup-notice"', response.data)
        self.assertIn(b'<meta name="firebase-config" content="{', response.data)
        self.assertNotIn(b"{{ firebase_config", response.data)

    def test_api_rejects_missing_authentication(self):
        response = self.client.get("/api/me")
        self.assertEqual(response.status_code, 401)

    def test_security_headers_are_set(self):
        response = self.client.get("/")
        self.assertEqual(response.headers["X-Frame-Options"], "DENY")
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")

    @patch("app._profile_for", return_value={"role": "student"})
    @patch("app.auth.verify_id_token", return_value={"uid": "student-1", "email_verified": True})
    def test_student_cannot_access_teacher_directory(self, _verify_token, _profile):
        response = self.client.get("/api/users", headers={"Authorization": "Bearer test-token"})
        self.assertEqual(response.status_code, 403)

    @patch("app._profile_for", return_value={"role": "teacher"})
    @patch("app.auth.verify_id_token", return_value={"uid": "teacher-1", "email_verified": False})
    def test_unverified_teacher_cannot_access_teacher_directory(self, _verify_token, _profile):
        response = self.client.get("/api/users", headers={"Authorization": "Bearer test-token"})
        self.assertEqual(response.status_code, 403)

    @patch(
        "app._profile_for",
        return_value={"role": "student", "face_embedding": [0.1] * 128, "display_name": "Student"},
    )
    @patch(
        "app.auth.verify_id_token",
        return_value={"uid": "student-1", "email": "student@example.edu", "email_verified": True},
    )
    def test_profile_does_not_return_face_template(self, _verify_token, _profile):
        response = self.client.get("/api/me", headers={"Authorization": "Bearer test-token"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(b"face_embedding", response.data)
        self.assertNotIn(b"0.1", response.data)

    @patch("app._profile_for", return_value={"role": "student"})
    @patch("app.auth.verify_id_token", return_value={"uid": "student-1", "email_verified": True})
    @patch("app._database")
    def test_student_attendance_query_is_scoped_to_their_user_id(self, database, _verify_token, _profile):
        collection = MagicMock()
        database.return_value.collection.return_value = collection
        collection.where.return_value.stream.return_value = []

        response = self.client.get("/api/attendance", headers={"Authorization": "Bearer test-token"})

        self.assertEqual(response.status_code, 200)
        collection.where.assert_called_once_with("user_id", "==", "student-1")


if __name__ == "__main__":
    unittest.main()
