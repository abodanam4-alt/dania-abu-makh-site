// حماية ملفات الامتحانات: كل امتحان مقفل بكلمة سر حتى تاريخ فتح تلقائي،
// وبعده يصير الملف عامًا لأي حد. عدّلي تاريخ "unlock" لأي ملف عشان تفتحيه
// قبل موعده، أو أضيفي سطرًا جديدًا كل ما ترفعي امتحانًا جديدًا
// (افتراضيًا: تاريخ اليوم + 14 يوم).

const PASSWORD = "2210";

const EXAMS = {
  "/quizzes/exams/math4-place-value-10000.webp": { unlock: "2026-10-03" },
  "/quizzes/exams/math6-fraction-quotient-v1.webp": { unlock: "2026-10-03" },
  "/quizzes/exams/math6-fraction-quotient-v2.webp": { unlock: "2026-10-03" },
};

export const config = {
  matcher: ["/quizzes/exams/:path*"],
};

export default function middleware(request) {
  const url = new URL(request.url);
  const entry = EXAMS[url.pathname];

  // مسار غير مسجَّل ضمن قائمة الامتحانات المحمية -> يمرّ بدون أي فحص.
  if (!entry) return;

  // تجاوزنا تاريخ الفتح التلقائي -> الملف عام، بدون كلمة سر.
  if (Date.now() >= new Date(entry.unlock + "T00:00:00Z").getTime()) return;

  // نتحقّق من HTTP Basic Auth.
  const auth = request.headers.get("authorization");
  if (auth && auth.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const password = decoded.slice(decoded.indexOf(":") + 1);
      if (password === PASSWORD) return; // كلمة السر صحيحة -> يمرّ.
    } catch (e) {
      // تجاهل ترميز غير صالح، ينتقل لطلب تسجيل الدخول أدناه.
    }
  }

  return new Response(
    "هذا الامتحان محمي حتى موعد الفتح التلقائي. أدخلي كلمة السر لعرضه الآن (اسم المستخدم: أي شيء).",
    {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Exam"' },
    }
  );
}
