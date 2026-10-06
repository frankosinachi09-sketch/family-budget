import { getResendFromAddress, hasReminderSession, isSameOrigin, remindersConfigured } from "./security";

export const runtime = "nodejs";

type ReminderRequest = {
  action?: "schedule" | "cancel";
  billId?: string | number;
  emailId?: string;
  name?: string;
  amount?: number;
  dueDate?: string;
  dueLabel?: string;
  recipientEmail?: string;
  daysBefore?: number;
  scheduledAt?: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

async function resendRequest(path: string, method: "POST", body?: unknown, idempotencyKey?: string) {
  return fetch(`https://api.resend.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) return Response.json({ error: "Request origin was not accepted." }, { status: 403 });
  if (!remindersConfigured()) {
    return Response.json({ error: "Email reminders are not configured on the server." }, { status: 503 });
  }
  if (!hasReminderSession(request)) {
    return Response.json({ error: "Unlock email reminders first." }, { status: 401 });
  }

  let body: ReminderRequest;
  try {
    body = (await request.json()) as ReminderRequest;
  } catch {
    return Response.json({ error: "The reminder request was not valid." }, { status: 400 });
  }

  if (body.action === "cancel") {
    if (!body.emailId || !/^[a-z0-9-]{20,80}$/i.test(body.emailId)) {
      return Response.json({ error: "The scheduled email ID was not valid." }, { status: 400 });
    }

    const response = await resendRequest(`/emails/${encodeURIComponent(body.emailId)}/cancel`, "POST");
    if (!response.ok) return Response.json({ error: "Resend could not cancel this scheduled email." }, { status: 502 });
    return Response.json({ canceled: true });
  }

  if (
    body.action !== "schedule" ||
    !body.name?.trim() ||
    body.name.length > 140 ||
    typeof body.amount !== "number" ||
    !Number.isFinite(body.amount) ||
    body.amount <= 0 ||
    typeof body.recipientEmail !== "string" ||
    body.recipientEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.recipientEmail) ||
    (body.daysBefore !== 3 && body.daysBefore !== 5) ||
    !body.dueDate ||
    !/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) ||
    !body.scheduledAt
  ) {
    return Response.json({ error: "Bill reminder details were incomplete." }, { status: 400 });
  }

  const scheduledTime = Date.parse(body.scheduledAt);
  const now = Date.now();
  if (!Number.isFinite(scheduledTime) || scheduledTime < now + 60000) {
    return Response.json({ error: "This bill is too close to its due date to schedule an email reminder." }, { status: 422 });
  }
  if (scheduledTime > now + 30 * 86400000) {
    return Response.json({ error: "Resend schedules reminders up to 30 days ahead. Open the app again when this bill is closer." }, { status: 422 });
  }

  const name = body.name.trim().replace(/[\r\n\t]+/g, " ");
  const amount = new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(body.amount);
  const dueLabel = body.dueLabel?.trim() || body.dueDate;
  const safeName = escapeHtml(name);
  const safeDueLabel = escapeHtml(dueLabel);
  const billId = String(body.billId ?? "").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
  const daysBefore = body.daysBefore;
  const reminderLead = `${daysBefore}-day`;

  const response = await resendRequest("/emails", "POST", {
    from: getResendFromAddress(),
    to: [body.recipientEmail],
    subject: `${reminderLead} bill reminder: ${name}`,
    scheduled_at: new Date(scheduledTime).toISOString(),
    html: `<div style="font-family:Arial,sans-serif;color:#202820;line-height:1.6"><p>Your household bill is due in ${daysBefore} days.</p><h1 style="font-size:22px">${safeName}</h1><p>Due ${safeDueLabel}</p><p>Amount: <strong>${amount}</strong></p><p>Open Household Ledger to review your schedule.</p></div>`,
    text: `Your household bill is due in ${daysBefore} days: ${name}. Due ${dueLabel}. Amount: ${amount}.`,
  }, billId ? `ledger-${billId}-${daysBefore}-${body.dueDate}` : undefined);

  const result = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok || !result.id) {
    return Response.json({ error: result.message || "Resend could not schedule the email." }, { status: 502 });
  }

  return Response.json({ emailId: result.id, scheduledAt: new Date(scheduledTime).toISOString() });
}