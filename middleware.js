// حماية ملفات الامتحانات: كل امتحان مقفل بكلمة سر حتى تاريخ فتح تلقائي،
// وبعده يصير الملف عامًا لأي حد. عدّلي تاريخ "unlock" لأي ملف عشان تفتحيه
// قبل موعده، أو أضيفي سطرًا جديدًا كل ما ترفعي امتحانًا جديدًا
// (افتراضيًا: تاريخ اليوم + 14 يوم).
//
// ملاحظة: نستخدم كود بالرابط (?code=...) بدل نافذة تسجيل الدخول التلقائية
// بالمتصفح (HTTP Basic Auth) عن قصد — لأن المتصفح بيحفظ كلمة سر الـBasic
// Auth ويرسلها تلقائيًا بكل مرة بدون ما يسأل مرة ثانية، وهذا بالضبط اللي
// ما بدنا ياه: لازم يُطلب الكود من جديد بكل محاولة دخول منفصلة.

const PASSWORD = "2210";

const EXAMS = {
  "/quizzes/exams/math4-place-value-10000.webp": { unlock: "2026-10-03" },
  "/quizzes/exams/math6-fraction-quotient-v1.webp": { unlock: "2026-10-03" },
  "/quizzes/exams/math6-fraction-quotient-v2.webp": { unlock: "2026-10-03" },
};

export const config = {
  matcher: ["/quizzes/exams/:path*"],
};

function lockPage(wrongCode) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>امتحان محمي</title>
<style>
  body{font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#0d1130;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
  .box{background:#fff;color:#1b1f3b;padding:34px 30px;border-radius:20px;max-width:360px;width:100%;text-align:center;box-shadow:0 20px 50px rgba(0,0,0,.35)}
  .box .ic{font-size:2.4rem;margin-bottom:8px}
  h2{margin:0 0 8px;font-size:1.25rem}
  p{margin:0 0 18px;color:#4d5273;font-size:.92rem}
  input{width:100%;padding:13px;border-radius:10px;border:1.5px solid #e6e8f5;font-size:1.1rem;text-align:center;margin-bottom:14px;box-sizing:border-box;letter-spacing:.15em}
  button{width:100%;padding:13px;border-radius:10px;border:none;background:#ffc93c;color:#0d1130;font-weight:800;font-size:1rem;cursor:pointer}
  .err{color:#ff6b4a;font-weight:700;margin-top:12px;font-size:.9rem}
</style>
</head>
<body>
  <div class="box">
    <div class="ic">🔒</div>
    <h2>هذا الامتحان محمي</h2>
    <p>أدخلي كلمة السر لعرضه الآن، أو انتظري موعد الفتح التلقائي.</p>
    <form method="GET">
      <input type="password" name="code" placeholder="كلمة السر" autofocus autocomplete="off">
      <button type="submit">دخول</button>
    </form>
    ${wrongCode ? '<p class="err">كلمة السر غير صحيحة، حاولي مرة أخرى.</p>' : ""}
  </div>
</body>
</html>`;
}

export default function middleware(request) {
  const url = new URL(request.url);
  const entry = EXAMS[url.pathname];

  // مسار غير مسجَّل ضمن قائمة الامتحانات المحمية -> يمرّ بدون أي فحص.
  if (!entry) return;

  // تجاوزنا تاريخ الفتح التلقائي -> الملف عام، بدون كلمة سر.
  if (Date.now() >= new Date(entry.unlock + "T00:00:00Z").getTime()) return;

  const code = url.searchParams.get("code");

  // الكود صحيح -> يمرّ ويشوف الملف الحقيقي.
  if (code === PASSWORD) return;

  // ما في كود، أو الكود غلط -> نعرض صفحة طلب الكود، بدون أي كاش،
  // وبدون WWW-Authenticate حتى ما يحفظ المتصفح شي تلقائيًا.
  return new Response(lockPage(code !== null && code !== ""), {
    status: 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate",
    },
  });
}
