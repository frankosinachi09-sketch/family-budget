import {
  hasReminderSession,
  isSameOrigin,
  reminderSessionCookie,
  reminderConfigurationIssues,
  remindersConfigured,
  validAppPassword,
  REMINDER_COOKIE,
} from "../security";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return Response.json(
    {
      ready: remindersConfigured(),
      authorized: remindersConfigured() && hasReminderSession(request),
      configurationIssues: reminderConfigurationIssues(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Request origin was not accepted." }, { status: 403 });
  if (!remindersConfigured()) {
    return Response.json({ error: "Email reminders are not configured on the server." }, { status: 503 });
  }

  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return Response.json({ error: "Enter the reminder access password." }, { status: 400 });
  }

  if (!validAppPassword(password)) {
    return Response.json({ error: "That reminder password is not correct." }, { status: 401 });
  }

  return Response.json(
    { authorized: true },
    { headers: { "Set-Cookie": reminderSessionCookie(60 * 60 * 24 * 30), "Cache-Control": "no-store" } }
  );
}

export async function DELETE(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Request origin was not accepted." }, { status: 403 });
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return Response.json(
    { authorized: false },
    {
      headers: {
        "Set-Cookie": `${REMINDER_COOKIE}=; Path=/api/reminders; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
        "Cache-Control": "no-store",
      },
    }
  );
}