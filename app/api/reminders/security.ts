import { createHmac, timingSafeEqual } from "node:crypto";

export const REMINDER_COOKIE = "ledger_reminder_session";

export function getResendFromAddress() {
  const configured = process.env.RESEND_FROM_EMAIL?.trim().replace(/^['"]|['"]$/g, "").trim() ?? "";
  const bracketedAddress = configured.match(/^<([^<>]+)>$/);
  return bracketedAddress?.[1]?.trim() ?? configured;
}

function validFromAddress() {
  const sender = getResendFromAddress();
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender) || /^.+\s<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/.test(sender);
}

export function remindersConfigured() {
  return reminderConfigurationIssues().length === 0;
}

export function reminderConfigurationIssues() {
  const issues: string[] = [];
  if (!process.env.RESEND_API_KEY) issues.push("RESEND_API_KEY");
  if (!validFromAddress()) issues.push("RESEND_FROM_EMAIL format");
  if (!process.env.REMINDER_ACCESS_PASSWORD) {
    issues.push("REMINDER_ACCESS_PASSWORD");
  } else if (process.env.REMINDER_ACCESS_PASSWORD.length < 20) {
    issues.push("REMINDER_ACCESS_PASSWORD length (minimum 20 characters)");
  }
  return issues;
}

function safeEqual(first: string, second: string) {
  const firstBuffer = Buffer.from(first);
  const secondBuffer = Buffer.from(second);
  return firstBuffer.length === secondBuffer.length && timingSafeEqual(firstBuffer, secondBuffer);
}

export function validAppPassword(password: string) {
  const expected = process.env.REMINDER_ACCESS_PASSWORD;
  return Boolean(expected && safeEqual(password, expected));
}

function sessionToken() {
  const secret = process.env.REMINDER_ACCESS_PASSWORD;
  return secret ? createHmac("sha256", secret).update("household-ledger-reminders").digest("hex") : "";
}

export function hasReminderSession(request: Request) {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REMINDER_COOKIE}=`));
  const value = cookie?.slice(REMINDER_COOKIE.length + 1) ?? "";
  const expected = sessionToken();
  return Boolean(expected && value && safeEqual(value, expected));
}

export function reminderSessionCookie(maxAge: number) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${REMINDER_COOKIE}=${sessionToken()}; Path=/api/reminders; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}