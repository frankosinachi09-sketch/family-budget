"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

type Bill = {
  id: number;
  name: string;
  amount: number;
  dueDate: string;
  category: string;
  reminderEmail?: string;
  reminderDaysBefore?: number[];
  reminderIds?: Record<string, string>;
};

type BillDraft = {
  name: string;
  amount: string;
  dueDate: string;
  category: string;
  reminderEmail: string;
  reminderDaysBefore: number[];
};

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type CategoryKey =
  | "Utilities"
  | "Family"
  | "School"
  | "Insurance"
  | "Lifestyle"
  | "Health"
  | "Transport";

const STORAGE_KEY = "family-budget-bills";
const REMINDER_PREFERENCES_KEY = "family-budget-reminder-preferences";
type ReminderPreferences = { email: string; daysBefore: number[] };
const DEFAULT_REMINDER_PREFERENCES: ReminderPreferences = { email: "", daysBefore: [5, 3] };
const categoryOptions: CategoryKey[] = [
  "Utilities",
  "Family",
  "School",
  "Insurance",
  "Lifestyle",
  "Health",
  "Transport",
];

const categoryStyles: Record<CategoryKey, { accent: string; soft: string; glow: string }> = {
  Utilities: { accent: "#ecb86d", soft: "rgba(236,184,109,0.15)", glow: "rgba(236,184,109,0.45)" },
  Family: { accent: "#8eb4a2", soft: "rgba(142,180,162,0.15)", glow: "rgba(142,180,162,0.45)" },
  School: { accent: "#96b0d9", soft: "rgba(150,176,217,0.15)", glow: "rgba(150,176,217,0.45)" },
  Insurance: { accent: "#c9a0ff", soft: "rgba(201,160,255,0.14)", glow: "rgba(201,160,255,0.42)" },
  Lifestyle: { accent: "#f39aa0", soft: "rgba(243,154,160,0.14)", glow: "rgba(243,154,160,0.45)" },
  Health: { accent: "#6ec9b0", soft: "rgba(110,201,176,0.14)", glow: "rgba(110,201,176,0.45)" },
  Transport: { accent: "#f6c86d", soft: "rgba(246,200,109,0.14)", glow: "rgba(246,200,109,0.45)" },
};

const emptyDraft: BillDraft = {
  name: "",
  amount: "",
  dueDate: "",
  category: "Utilities",
  reminderEmail: "",
  reminderDaysBefore: [5, 3],
};

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysToDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return toDateKey(new Date(year, month - 1, day + days));
}

function daysBetweenDateKeys(fromDate: string, toDate: string) {
  if (!fromDate || !toDate) return 0;
  const [fromYear, fromMonth, fromDay] = fromDate.split("-").map(Number);
  const [toYear, toMonth, toDay] = toDate.split("-").map(Number);
  const from = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const to = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.round((to - from) / 86400000);
}

function formatMonth(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1));
}

function formatDate(dateKey: string, options: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" }) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en", options).format(new Date(year, month - 1, day));
}

function getCalendarCells(monthKey: string) {
  const [year, month] = monthKey.split("-").map(Number);
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

  return Array.from({ length: cellCount }, (_, index) => {
    const date = new Date(year, month - 1, index - firstWeekday + 1);
    return {
      dateKey: toDateKey(date),
      day: date.getDate(),
      isCurrentMonth: date.getMonth() === month - 1,
    };
  });
}

function describeDueDate(daysLeft: number) {
  if (daysLeft === 0) return "Due today";
  if (daysLeft === 1) return "Due tomorrow";
  if (daysLeft < 0) return `${Math.abs(daysLeft)} days overdue`;
  return `Due in ${daysLeft} days`;
}

function getReminderDateTime(dueDate: string, daysBefore: number) {
  const [year, month, day] = dueDate.split("-").map(Number);
  const reminderTime = new Date(year, month - 1, day - daysBefore, 9, 0, 0, 0);
  return reminderTime.getTime() > Date.now() ? reminderTime : null;
}

function subscribeToLocalDate(notify: () => void) {
  const interval = window.setInterval(notify, 60000);
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") notify();
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return () => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  };
}

function getLocalDateSnapshot() {
  return toDateKey(new Date());
}

function getServerDateSnapshot() {
  return "";
}

const EMPTY_BILLS: Bill[] = [];
let cachedBills: Bill[] | null = null;
const billSubscribers = new Set<() => void>();

function readBillsSnapshot() {
  if (typeof window === "undefined") return EMPTY_BILLS;
  if (cachedBills) return cachedBills;

  const today = toDateKey(new Date());
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    cachedBills = EMPTY_BILLS;
    return cachedBills;
  }

  try {
    const parsed = JSON.parse(stored) as Array<Partial<Bill> & { daysLeft?: number; reminderId?: string }>;
    if (!Array.isArray(parsed)) throw new Error("Invalid bill data");

    cachedBills = parsed
      .filter((bill) => bill && typeof bill.name === "string" && typeof bill.amount === "number")
      .map((bill) => ({
        id: typeof bill.id === "number" ? bill.id : Date.now() + Math.random(),
        name: bill.name as string,
        amount: bill.amount as number,
        category: typeof bill.category === "string" ? bill.category : "Utilities",
        reminderEmail: typeof bill.reminderEmail === "string" ? bill.reminderEmail : undefined,
        reminderDaysBefore: Array.isArray(bill.reminderDaysBefore)
          ? bill.reminderDaysBefore.filter((day): day is number => day === 3 || day === 5)
          : undefined,
        reminderIds: {
          ...(typeof bill.reminderId === "string" ? { "1": bill.reminderId } : {}),
          ...(bill.reminderIds && typeof bill.reminderIds === "object"
            ? Object.fromEntries(Object.entries(bill.reminderIds).filter(([day, id]) => ["1", "3", "5"].includes(day) && typeof id === "string"))
            : {}),
        },
        dueDate:
          typeof bill.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bill.dueDate)
            ? bill.dueDate
            : addDaysToDateKey(today, Number(bill.daysLeft) || 0),
      }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedBills));
    return cachedBills;
  } catch {
    window.localStorage.removeItem(STORAGE_KEY);
    cachedBills = EMPTY_BILLS;
    return cachedBills;
  }
}

function getServerBillsSnapshot() {
  return EMPTY_BILLS;
}

let cachedReminderPreferences: ReminderPreferences | null = null;
const reminderPreferenceSubscribers = new Set<() => void>();

function readReminderPreferences() {
  if (typeof window === "undefined") return DEFAULT_REMINDER_PREFERENCES;
  if (cachedReminderPreferences) return cachedReminderPreferences;

  try {
    const parsed = JSON.parse(window.localStorage.getItem(REMINDER_PREFERENCES_KEY) ?? "null") as Partial<ReminderPreferences> | null;
    const daysBefore = Array.isArray(parsed?.daysBefore)
      ? [...new Set(parsed.daysBefore.filter((day): day is number => day === 3 || day === 5))].sort((a, b) => b - a)
      : DEFAULT_REMINDER_PREFERENCES.daysBefore;
    cachedReminderPreferences = {
      email: typeof parsed?.email === "string" ? parsed.email : "",
      daysBefore: daysBefore.length > 0 ? daysBefore : DEFAULT_REMINDER_PREFERENCES.daysBefore,
    };
  } catch {
    cachedReminderPreferences = DEFAULT_REMINDER_PREFERENCES;
  }

  return cachedReminderPreferences;
}

function subscribeToReminderPreferences(notify: () => void) {
  reminderPreferenceSubscribers.add(notify);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === REMINDER_PREFERENCES_KEY) {
      cachedReminderPreferences = null;
      notify();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    reminderPreferenceSubscribers.delete(notify);
    window.removeEventListener("storage", handleStorage);
  };
}

function saveReminderPreferences(preferences: ReminderPreferences) {
  cachedReminderPreferences = { email: preferences.email.trim(), daysBefore: [...preferences.daysBefore] };
  window.localStorage.setItem(REMINDER_PREFERENCES_KEY, JSON.stringify(cachedReminderPreferences));
  reminderPreferenceSubscribers.forEach((notify) => notify());
}

function subscribeToBills(notify: () => void) {
  billSubscribers.add(notify);
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cachedBills = null;
      notify();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    billSubscribers.delete(notify);
    window.removeEventListener("storage", handleStorage);
  };
}

function updateBills(update: (current: Bill[]) => Bill[]) {
  const nextBills = update(readBillsSnapshot());
  cachedBills = nextBills;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextBills));
  billSubscribers.forEach((notify) => notify());
}

function CategoryIcon({ category }: { category: string }) {
  const common = "h-5 w-5";

  switch (category) {
    case "Utilities":
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M13 2 5 13h5l-1 9 8-11h-5l1-9Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Family":
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M16 19v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1" strokeLinecap="round" />
          <circle cx="10" cy="7" r="3" />
          <path d="M20 19v-1a3.5 3.5 0 0 0-2.8-3.4" strokeLinecap="round" />
          <path d="M16 4.5a3 3 0 0 1 0 5.8" strokeLinecap="round" />
        </svg>
      );
    case "School":
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M3 9.5 12 5l9 4.5-9 4.5L3 9.5Z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7 11.5v4.3c1.7 1.5 4 2.2 5 2.2s3.3-.7 5-2.2v-4.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Insurance":
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3.5 5 6.5v5.2c0 4 2.7 7.6 7 9.8 4.3-2.2 7-5.8 7-9.8V6.5l-7-3Z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9.7 12.2 11.3 13.8 14.7 10.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Lifestyle":
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M6 14c0-3.3 2.7-6 6-6s6 2.7 6 6v2H6v-2Z" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M9 18h6" strokeLinecap="round" />
          <path d="M10 8V6.6A2 2 0 0 1 12 5a2 2 0 0 1 2 1.6V8" strokeLinecap="round" />
        </svg>
      );
    case "Health":
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 21s-7-4.5-7-10A4.2 4.2 0 0 1 9.2 7 4.2 4.2 0 0 1 12 9.3 4.2 4.2 0 0 1 14.8 7 4.2 4.2 0 0 1 19 11c0 5.5-7 10-7 10Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Transport":
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 15V9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M7 16.5A1.5 1.5 0 1 1 7 19a1.5 1.5 0 0 1 0-3Zm10 0A1.5 1.5 0 1 1 17 19a1.5 1.5 0 0 1 0-3ZM4 12h16" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" className={common} fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="4" y="5" width="16" height="14" rx="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M8 9h8M8 13h8" strokeLinecap="round" />
        </svg>
      );
  }
}

export default function Home() {
  const bills = useSyncExternalStore(subscribeToBills, readBillsSnapshot, getServerBillsSnapshot);
  const [draft, setDraft] = useState<BillDraft>(emptyDraft);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isPhoneInfoOpen, setIsPhoneInfoOpen] = useState(false);
  const [isReminderOpen, setIsReminderOpen] = useState(false);
  const [remindersReady, setRemindersReady] = useState(false);
  const [remindersAuthorized, setRemindersAuthorized] = useState(false);
  const [reminderPassword, setReminderPassword] = useState("");
  const [reminderMessage, setReminderMessage] = useState("");
  const [isReminderUnlocking, setIsReminderUnlocking] = useState(false);
  const [reminderEmailDraft, setReminderEmailDraft] = useState("");
  const [reminderDaysDraft, setReminderDaysDraft] = useState<number[]>([5, 3]);
  const [selectedMonth, setSelectedMonth] = useState("");
  const [chosenDate, setChosenDate] = useState("");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const reminderRequests = useRef(new Set<string>());
  const reminderPreferences = useSyncExternalStore(
    subscribeToReminderPreferences,
    readReminderPreferences,
    () => DEFAULT_REMINDER_PREFERENCES
  );
  const todayKey = useSyncExternalStore(subscribeToLocalDate, getLocalDateSnapshot, getServerDateSnapshot);
  const calendarMonth = selectedMonth || (todayKey ? todayKey.slice(0, 7) : "");
  const selectedDate = chosenDate || todayKey;

  useEffect(() => {
    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
  }, []);

  useEffect(() => {
    let isCurrent = true;
    fetch("/api/reminders/session")
      .then((response) => response.json())
      .then((result: { ready?: boolean; authorized?: boolean }) => {
        if (isCurrent) {
          setRemindersReady(Boolean(result.ready));
          setRemindersAuthorized(Boolean(result.authorized));
        }
      })
      .catch(() => {
        if (isCurrent) setRemindersReady(false);
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  const datedBills = useMemo(
    () => bills.map((bill) => ({ ...bill, daysLeft: daysBetweenDateKeys(todayKey, bill.dueDate) })),
    [bills, todayKey]
  );
  const dueSoon = datedBills.filter((bill) => bill.daysLeft >= 0 && bill.daysLeft <= 7).length;
  const upcomingTotal = bills.reduce((total, bill) => total + bill.amount, 0);
  const overdue = datedBills.filter((bill) => bill.daysLeft < 0).length;

  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: "NGN",
      maximumFractionDigits: 0,
    }).format(amount);

  const currentMonth = todayKey ? formatMonth(todayKey.slice(0, 7)) : "";
  const currentDate = todayKey ? formatDate(todayKey, { month: "long", day: "numeric", year: "numeric" }) : "";
  const billReminderEmail = draft.reminderEmail.trim() || reminderPreferences.email;
  const calendarCells = calendarMonth ? getCalendarCells(calendarMonth) : [];
  const selectedBills = bills.filter((bill) => bill.dueDate === selectedDate);
  const visibleMonthBillCount = bills.filter((bill) => bill.dueDate.startsWith(calendarMonth)).length;
  const billsByDate = useMemo(() => {
    const grouped = new Map<string, Bill[]>();
    bills.forEach((bill) => grouped.set(bill.dueDate, [...(grouped.get(bill.dueDate) ?? []), bill]));
    return grouped;
  }, [bills]);

  const scheduleEmailReminder = useCallback(async (bill: Bill) => {
    const recipientEmail = bill.reminderEmail || reminderPreferences.email;
    const daysBeforeOptions = bill.reminderDaysBefore ?? reminderPreferences.daysBefore;
    if (!remindersAuthorized || !recipientEmail) return;

    for (const daysBefore of daysBeforeOptions) {
      const reminderKey = `${bill.id}:${daysBefore}`;
      if (bill.reminderIds?.[daysBefore] || reminderRequests.current.has(reminderKey)) continue;

      const scheduledAt = getReminderDateTime(bill.dueDate, daysBefore);
      if (!scheduledAt || scheduledAt.getTime() > Date.now() + 30 * 86400000) continue;

      reminderRequests.current.add(reminderKey);
      try {
        const response = await fetch("/api/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "schedule",
            billId: bill.id,
            name: bill.name,
            amount: bill.amount,
            dueDate: bill.dueDate,
            dueLabel: formatDate(bill.dueDate, { weekday: "long", month: "long", day: "numeric" }),
            recipientEmail,
            daysBefore,
            scheduledAt: scheduledAt.toISOString(),
          }),
        });
        const result = (await response.json()) as { emailId?: string; error?: string };
        if (!response.ok || !result.emailId) {
          setReminderMessage(result.error || `Could not schedule a reminder for ${bill.name}.`);
          return;
        }

        updateBills((current) => current.map((entry) => entry.id === bill.id
          ? { ...entry, reminderIds: { ...entry.reminderIds, [daysBefore]: result.emailId as string } }
          : entry));
        setReminderMessage(`${daysBefore}-day email reminder scheduled for ${bill.name}.`);
      } catch {
        setReminderMessage(`Could not connect to Resend for ${bill.name}.`);
        return;
      } finally {
        reminderRequests.current.delete(reminderKey);
      }
    }
  }, [remindersAuthorized, reminderPreferences]);

  useEffect(() => {
    if (!remindersAuthorized) return;
    datedBills
      .filter((bill) =>
        bill.daysLeft >= 0 &&
        bill.daysLeft <= 35 &&
        Boolean(bill.reminderEmail || reminderPreferences.email) &&
        (bill.reminderDaysBefore ?? reminderPreferences.daysBefore).some((daysBefore) => !bill.reminderIds?.[daysBefore])
      )
      .forEach((bill) => void scheduleEmailReminder(bill));
  }, [datedBills, remindersAuthorized, reminderPreferences, scheduleEmailReminder]);

  const spendingSummary = useMemo(
    () => [
      {
        label: "Due soon",
        value: dueSoon.toString(),
        sub: "Bills in the next week",
        accent: "from-[#1d1715] via-[#2c201b] to-[#18120f]",
      },
      {
        label: "Upcoming",
        value: formatCurrency(upcomingTotal),
        sub: "Estimated payments",
        accent: "from-[#241c1a] via-[#2b211d] to-[#18120f]",
      },
      {
        label: "Overdue",
        value: overdue.toString(),
        sub: "Need attention",
        accent: "from-[#261915] via-[#2f1f1d] to-[#18120f]",
      },
    ],
    [dueSoon, overdue, upcomingTotal]
  );

  const addBill = (event: React.FormEvent) => {
    event.preventDefault();

    const nextName = draft.name.trim();
    const nextAmount = Number(draft.amount);

    if (!nextName || !draft.dueDate || !Number.isFinite(nextAmount) || nextAmount <= 0) {
      return;
    }

    const nextBill: Bill = {
      id: Date.now() + Math.random(),
      name: nextName,
      amount: Math.round(nextAmount),
      dueDate: draft.dueDate,
      category: draft.category || "Utilities",
      reminderEmail: draft.reminderEmail.trim() || undefined,
      reminderDaysBefore: [...draft.reminderDaysBefore],
    };

    updateBills((current) => [...current, nextBill].sort((a, b) => a.dueDate.localeCompare(b.dueDate)));
    setDraft(emptyDraft);
    setIsFormOpen(false);
    void scheduleEmailReminder(nextBill);
  };

  const openBillForm = () => {
    setDraft({
      ...emptyDraft,
      dueDate: selectedDate || todayKey,
      reminderEmail: reminderPreferences.email,
      reminderDaysBefore: [...reminderPreferences.daysBefore],
    });
    setIsFormOpen(true);
  };

  const changeCalendarMonth = (amount: number) => {
    const [year, month] = calendarMonth.split("-").map(Number);
    const nextMonth = new Date(year, month - 1 + amount, 1);
    const nextMonthKey = toDateKey(nextMonth).slice(0, 7);
    setSelectedMonth(nextMonthKey);
    setChosenDate(`${nextMonthKey}-01`);
  };

  const installOnPhone = async () => {
    if (!installPrompt) {
      setIsPhoneInfoOpen(true);
      return;
    }

    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") setInstallPrompt(null);
  };

  const openReminderSettings = () => {
    const savedPreferences = readReminderPreferences();
    setReminderEmailDraft(savedPreferences.email);
    setReminderDaysDraft(savedPreferences.daysBefore);
    setReminderMessage("");
    setIsReminderOpen(true);
  };

  const saveEmailReminderSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    const recipientEmail = reminderEmailDraft.trim();
    const daysBefore = [...new Set(reminderDaysDraft)].sort((a, b) => b - a);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) || daysBefore.length === 0) {
      setReminderMessage("Enter a valid email address and choose at least one reminder day.");
      return;
    }

    if (!remindersReady) {
      saveReminderPreferences({ email: recipientEmail, daysBefore });
      setReminderMessage(`Saved ${recipientEmail} as the reminder destination. Configure Resend on the server to turn delivery on.`);
      return;
    }

    setIsReminderUnlocking(true);
    setReminderMessage("");

    try {
      let hasSession = remindersAuthorized;
      if (!hasSession) {
        const response = await fetch("/api/reminders/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: reminderPassword }),
        });
        const result = (await response.json()) as { authorized?: boolean; error?: string };
        if (!response.ok || !result.authorized) {
          setReminderMessage(result.error || "Could not unlock email reminders.");
          return;
        }
        hasSession = true;
      }

      const previous = readReminderPreferences();
      const settingsChanged = previous.email !== recipientEmail || previous.daysBefore.join(",") !== daysBefore.join(",");
      if (hasSession && settingsChanged) {
        const queuedIds = [...new Set(bills.flatMap((bill) => Object.values(bill.reminderIds ?? {})))];
        for (const emailId of queuedIds) {
          const response = await fetch("/api/reminders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "cancel", emailId }),
          });
          if (!response.ok) {
            setReminderMessage("Could not replace all queued reminders. Keep the current email settings and try again.");
            return;
          }
        }
      }

      saveReminderPreferences({ email: recipientEmail, daysBefore });
      if (hasSession && settingsChanged) {
        updateBills((current) => current.map((bill) => ({ ...bill, reminderIds: undefined })));
      }
      setRemindersAuthorized(true);
      setReminderPassword("");
      setReminderMessage(`Reminders will go to ${recipientEmail}, ${daysBefore.map((day) => `${day} days`).join(" and ")} before each bill.`);
    } catch {
      setReminderMessage("Could not connect to the email reminder service.");
    } finally {
      setIsReminderUnlocking(false);
    }
  };

  const lockEmailReminders = async () => {
    await fetch("/api/reminders/session", { method: "DELETE" }).catch(() => undefined);
    setRemindersAuthorized(false);
    setReminderMessage("Email reminders are locked on this browser.");
  };

  const removeBill = (id: number) => {
    const bill = bills.find((entry) => entry.id === id);
    if (bill?.reminderIds && remindersAuthorized) {
      Object.values(bill.reminderIds).forEach((emailId) => {
        void fetch("/api/reminders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel", emailId }),
        }).then((response) => {
          if (!response.ok) setReminderMessage(`Could not cancel every email reminder for ${bill.name}.`);
        }).catch(() => setReminderMessage(`Could not cancel every email reminder for ${bill.name}.`));
      });
    }
    updateBills((current) => current.filter((bill) => bill.id !== id));
  };

  const priorityBills = useMemo(() => {
    return [...datedBills]
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, 3);
  }, [datedBills]);

  const categoryTotals = useMemo(() => {
    const totals = new Map<string, number>();

    bills.forEach((bill) => {
      totals.set(bill.category, (totals.get(bill.category) ?? 0) + bill.amount);
    });

    return [...totals.entries()]
      .map(([category, total]) => ({
        category,
        total,
        percent: Math.max(18, Math.min(100, (total / Math.max(upcomingTotal, 1)) * 100)),
        accent: categoryStyles[category as CategoryKey]?.accent ?? "#d7b174",
        soft: categoryStyles[category as CategoryKey]?.soft ?? "rgba(215,177,116,0.14)",
      }))
      .sort((a, b) => b.total - a.total);
  }, [bills, upcomingTotal]);

  return (
    <main className="ledger-app">
      <div className="ledger-grain" aria-hidden="true" />
      <div className="ledger-frame">
        <header className="ledger-header">
          <a className="ledger-brand" href="#overview" aria-label="Household Ledger home">
            <span className="ledger-brand-mark">H<span>.</span></span>
            <span className="ledger-brand-name">Household<br />Ledger</span>
          </a>
          <div className="ledger-header-tools">
            <p className="ledger-date">{currentDate}</p>
            <button className="ledger-phone-button" type="button" onClick={installOnPhone} aria-label="Install or add to phone">
              <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="2" width="10" height="16" rx="1" /><path d="M8 5h4M9 15h2" /></svg>
              <span>Phone</span>
            </button>
            <button className="ledger-phone-button ledger-alert-button" type="button" onClick={openReminderSettings} aria-label="Email reminders">
              <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="4" width="16" height="12" /><path d="m3 5 7 6 7-6" /></svg>
              <span>Alerts</span>
            </button>
            <button className="ledger-add ledger-add-header" type="button" onClick={openBillForm} aria-label="New bill">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
              <span>New bill</span>
            </button>
          </div>
        </header>

        <section className="ledger-overview" id="overview">
          <div className="ledger-overview-copy">
            <p className="ledger-kicker"><span /> Monthly overview</p>
            <h1>Money in<br />motion<span>.</span></h1>
            <p className="ledger-caption">A clear view of what your household needs this month.</p>
          </div>
          <div className="ledger-total-wrap">
            <div className="ledger-total-label">Upcoming total</div>
            <div className="ledger-total">{formatCurrency(upcomingTotal)}</div>
            <div className="ledger-total-note">
              <span className="ledger-status-mark" />
              {bills.length === 0 ? "No bills recorded" : `${bills.length} bills on your list`}
            </div>
            <div className="ledger-abstract-mark" aria-hidden="true">
              <span className="ledger-mark-ring" />
              <span className="ledger-mark-line" />
              <span className="ledger-mark-dot" />
            </div>
          </div>
          <div className="ledger-metrics">
            {spendingSummary.map((item, index) => (
              <div className={`ledger-metric ledger-metric-${index + 1}`} key={item.label}>
                <span className="ledger-metric-index">0{index + 1}</span>
                <div>
                  <p>{item.label}</p>
                  <strong>{item.value}</strong>
                  <small>{item.sub}</small>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="ledger-calendar" aria-label="Bills calendar">
          <div className="ledger-section-heading ledger-calendar-heading">
            <div>
              <p className="ledger-kicker">Due dates</p>
              <h2>{calendarMonth ? formatMonth(calendarMonth) : "Calendar"}<span className="ledger-count">{visibleMonthBillCount.toString().padStart(2, "0")} bills</span></h2>
            </div>
            <div className="ledger-calendar-controls">
              <button type="button" className="ledger-today-button" onClick={() => {
                if (todayKey) {
                  setSelectedMonth(todayKey.slice(0, 7));
                  setChosenDate(todayKey);
                }
              }}>Today</button>
              <button type="button" className="ledger-month-button" onClick={() => changeCalendarMonth(-1)} aria-label="Previous month"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12 4-6 6 6 6" /></svg></button>
              <button type="button" className="ledger-month-button" onClick={() => changeCalendarMonth(1)} aria-label="Next month"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m8 4 6 6-6 6" /></svg></button>
            </div>
          </div>

          <div className="ledger-calendar-layout">
            <div className="ledger-calendar-grid">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((weekday) => <span className="ledger-weekday" key={weekday}>{weekday}</span>)}
              {calendarCells.map((cell) => {
                const dayBills = billsByDate.get(cell.dateKey) ?? [];
                const today = cell.dateKey === todayKey;
                const selected = cell.dateKey === selectedDate;
                const billLabel = `${dayBills.length} ${dayBills.length === 1 ? "bill" : "bills"}`;

                return (
                  <button
                    className={`ledger-day ${cell.isCurrentMonth ? "" : "is-outside"} ${today ? "is-today" : ""} ${selected ? "is-selected" : ""} ${dayBills.length ? "has-bills" : ""}`}
                    type="button"
                    key={cell.dateKey}
                    onClick={() => setChosenDate(cell.dateKey)}
                    aria-label={`${formatDate(cell.dateKey)}, ${billLabel}`}
                    aria-pressed={selected}
                  >
                    <span className="ledger-day-number">{cell.day}</span>
                    {dayBills.length > 0 && <span className="ledger-day-count">{dayBills.length}</span>}
                    {today && <span className="ledger-day-today">Today</span>}
                  </button>
                );
              })}
            </div>

            <div className="ledger-selected-day">
              <div className="ledger-selected-heading">
                <div>
                  <p className="ledger-kicker">Selected day</p>
                  <h3>{selectedDate ? formatDate(selectedDate) : "Choose a date"}</h3>
                </div>
                <button className="ledger-day-add" type="button" onClick={openBillForm} aria-label="Add a bill on the selected date"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></button>
              </div>
              {selectedBills.length === 0 ? (
                <p className="ledger-day-empty">Nothing due on this date.</p>
              ) : (
                <ul className="ledger-day-bills">
                  {selectedBills.map((bill) => (
                    <li key={bill.id}>
                      <span
                        className="ledger-day-bill-icon"
                        style={{ "--bill-accent": categoryStyles[bill.category as CategoryKey]?.accent ?? "#244dcc" } as React.CSSProperties}
                      >
                        <CategoryIcon category={bill.category} />
                      </span>
                      <span className="ledger-day-bill-name">{bill.name}<small>{bill.category}</small></span>
                      <strong>{formatCurrency(bill.amount)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>

        <section className="ledger-content">
          <div className="ledger-payments" id="payments">
            <div className="ledger-section-heading">
              <div>
                <p className="ledger-kicker">The schedule</p>
                <h2>Upcoming bills<span className="ledger-count">{bills.length.toString().padStart(2, "0")}</span></h2>
              </div>
              <button className="ledger-add ledger-add-inline" type="button" onClick={openBillForm} aria-label="Add a bill">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
              </button>
            </div>

            {bills.length === 0 ? (
              <div className="ledger-empty">
                <span className="ledger-empty-number">01</span>
                <div>
                  <h3>Your ledger starts here.</h3>
                  <p>Add a household bill to see upcoming payments, category totals, and priorities.</p>
                </div>
                <button className="ledger-text-action" type="button" onClick={() => setIsFormOpen(true)}>Add your first bill <span>↗</span></button>
              </div>
            ) : (
              <div className="ledger-bill-list">
                  {datedBills.map((bill, index) => {
                  const theme = categoryStyles[bill.category as CategoryKey] ?? categoryStyles.Utilities;

                  return (
                    <article className="ledger-bill" key={bill.id} style={{ "--bill-accent": theme.accent, "--entry-index": index } as React.CSSProperties}>
                      <div className="ledger-bill-index">{(index + 1).toString().padStart(2, "0")}</div>
                      <div className="ledger-bill-icon"><CategoryIcon category={bill.category} /></div>
                      <div className="ledger-bill-name">
                        <h3>{bill.name}</h3>
                        <p>{bill.category} · {formatDate(bill.dueDate, { month: "short", day: "numeric", year: "numeric" })}</p>
                      </div>
                      <div className="ledger-bill-amount">
                        <strong>{formatCurrency(bill.amount)}</strong>
                        <small>Estimated</small>
                      </div>
                      <div className={`ledger-due ${bill.daysLeft <= 3 ? "is-soon" : ""}`}>
                        <strong>{Math.abs(bill.daysLeft)}</strong>
                        <span>{bill.daysLeft < 0 ? "late" : bill.daysLeft === 1 ? "day left" : "days left"}</span>
                      </div>
                      <button className="ledger-remove" type="button" onClick={() => removeBill(bill.id)} aria-label={`Remove ${bill.name}`}>
                        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          <aside className="ledger-aside">
            <section className="ledger-rhythm">
              <div className="ledger-section-heading ledger-aside-heading">
                <div>
                  <p className="ledger-kicker">By category</p>
                  <h2>Cash flow</h2>
                </div>
                <span className="ledger-live"><span /> Live</span>
              </div>
              {categoryTotals.length === 0 ? (
                <p className="ledger-aside-empty">Your spending rhythm will appear when bills are added.</p>
              ) : (
                <div className="ledger-category-list">
                  {categoryTotals.map((item) => (
                    <div className="ledger-category" key={item.category}>
                      <div className="ledger-category-meta">
                        <span><i style={{ backgroundColor: item.accent }} />{item.category}</span>
                        <strong>{formatCurrency(item.total)}</strong>
                      </div>
                      <div className="ledger-track"><span style={{ width: `${item.percent}%`, backgroundColor: item.accent }} /></div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="ledger-priority">
              <p className="ledger-kicker">Keep an eye on</p>
              <h2>Next in line</h2>
              {priorityBills.length === 0 ? (
                <p className="ledger-aside-empty">Priority bills will be listed here.</p>
              ) : (
                <ol className="ledger-priority-list">
                  {priorityBills.map((bill, index) => (
                    <li key={bill.id}>
                      <span className="ledger-priority-index">0{index + 1}</span>
                      <span className="ledger-priority-name">{bill.name}<small>{describeDueDate(bill.daysLeft)} · {formatDate(bill.dueDate, { month: "short", day: "numeric" })}</small></span>
                      <span className={`ledger-priority-state ${bill.daysLeft <= 3 ? "is-soon" : ""}`} aria-label={bill.daysLeft <= 3 ? "Due soon" : "Scheduled"} />
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </aside>
        </section>

        <footer className="ledger-footer"><span>HOUSEHOLD FINANCES</span><span>{currentMonth}</span></footer>
      </div>

      {isFormOpen && (
        <div className="ledger-scrim" onClick={() => setIsFormOpen(false)}>
          <section className="ledger-dialog" role="dialog" aria-modal="true" aria-labelledby="bill-dialog-title" onClick={(event) => event.stopPropagation()}>
            <div className="ledger-dialog-heading">
              <div><p className="ledger-kicker">Add to the schedule</p><h2 id="bill-dialog-title">New bill<span>.</span></h2></div>
              <button className="ledger-dialog-close" type="button" onClick={() => setIsFormOpen(false)} aria-label="Close dialog">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg>
              </button>
            </div>
            <form onSubmit={addBill} className="ledger-form">
              <label className="ledger-field ledger-field-wide"><span>Bill name</span><input required value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="School fees" /></label>
              <label className="ledger-field"><span>Amount</span><input required type="number" min="0" step="1" value={draft.amount} onChange={(event) => setDraft((current) => ({ ...current, amount: event.target.value }))} placeholder="250000" /></label>
              <label className="ledger-field"><span>Due date</span><input required type="date" value={draft.dueDate} onChange={(event) => setDraft((current) => ({ ...current, dueDate: event.target.value }))} /></label>
              <label className="ledger-field"><span>Days left</span><input type="number" step="1" value={draft.dueDate && todayKey ? daysBetweenDateKeys(todayKey, draft.dueDate) : ""} onChange={(event) => setDraft((current) => ({ ...current, dueDate: event.target.value === "" ? "" : addDaysToDateKey(todayKey, Number(event.target.value)) }))} placeholder="Choose a date" /></label>
              <label className="ledger-field ledger-field-wide"><span>Category</span><select value={draft.category} onChange={(event) => setDraft((current) => ({ ...current, category: event.target.value }))}>{categoryOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>
              <div className="ledger-bill-reminders">
                <p className="ledger-kicker">Email reminders for this bill</p>
                <label className="ledger-field"><span>Send to any email address</span><input type="email" autoComplete="email" value={draft.reminderEmail} onChange={(event) => setDraft((current) => ({ ...current, reminderEmail: event.target.value }))} placeholder="you@example.com" /></label>
                <fieldset className="ledger-reminder-days">
                  <legend>Remind before due date</legend>
                  {[5, 3].map((daysBefore) => (
                    <label key={daysBefore}>
                      <input type="checkbox" checked={draft.reminderDaysBefore.includes(daysBefore)} onChange={(event) => setDraft((current) => ({ ...current, reminderDaysBefore: event.target.checked ? [...current.reminderDaysBefore, daysBefore].sort((a, b) => b - a) : current.reminderDaysBefore.filter((day) => day !== daysBefore) }))} />
                      <span>{daysBefore} days before</span>
                    </label>
                  ))}
                </fieldset>
                <p className={`ledger-bill-reminder-status ${billReminderEmail && remindersAuthorized ? "is-active" : ""}`} aria-live="polite">
                  <span aria-hidden="true" />
                  {!billReminderEmail
                    ? "No recipient set. Add an email or choose one in Alerts."
                    : remindersAuthorized
                      ? `This bill's reminders will go to ${billReminderEmail}.`
                      : `Recipient for this bill: ${billReminderEmail}. Unlock Alerts to send.`}
                </p>
                <p className="ledger-reminder-hint">Leave the email blank to use your Alerts default. Any valid recipient provider is accepted.</p>
              </div>
              <div className="ledger-form-actions">
                <button className="ledger-cancel" type="button" onClick={() => setIsFormOpen(false)}>Cancel</button>
                <button className="ledger-submit" type="submit">Save bill <span>↗</span></button>
              </div>
            </form>
          </section>
        </div>
      )}

      {isPhoneInfoOpen && (
        <div className="ledger-scrim" onClick={() => setIsPhoneInfoOpen(false)}>
          <section className="ledger-dialog ledger-phone-dialog" role="dialog" aria-modal="true" aria-labelledby="phone-dialog-title" onClick={(event) => event.stopPropagation()}>
            <div className="ledger-dialog-heading">
              <div><p className="ledger-kicker">Take it with you</p><h2 id="phone-dialog-title">Phone access<span>.</span></h2></div>
              <button className="ledger-dialog-close" type="button" onClick={() => setIsPhoneInfoOpen(false)} aria-label="Close phone instructions"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>
            </div>
            <p className="ledger-phone-copy">Add Household Ledger to your Home Screen for an app-like view. On iPhone, open this page in Safari, tap Share, then choose <strong>Add to Home Screen</strong>. On supported browsers, use the install prompt.</p>
            <p className="ledger-phone-note">A live iOS or Android home-screen widget needs a native app extension; this installs the dashboard as an app shortcut.</p>
            <div className="ledger-form-actions">
              <button className="ledger-cancel" type="button" onClick={() => setIsPhoneInfoOpen(false)}>Close</button>
              {installPrompt && <button className="ledger-submit" type="button" onClick={installOnPhone}>Install app <span>↗</span></button>}
            </div>
          </section>
        </div>
      )}

      {isReminderOpen && (
        <div className="ledger-scrim" onClick={() => setIsReminderOpen(false)}>
          <section className="ledger-dialog ledger-reminder-dialog" role="dialog" aria-modal="true" aria-labelledby="reminder-dialog-title" onClick={(event) => event.stopPropagation()}>
            <div className="ledger-dialog-heading">
              <div><p className="ledger-kicker">Scheduled by Resend</p><h2 id="reminder-dialog-title">Email alerts<span>.</span></h2></div>
              <button className="ledger-dialog-close" type="button" onClick={() => setIsReminderOpen(false)} aria-label="Close email reminders"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg></button>
            </div>

            <div className="ledger-reminder-setup">
              {remindersAuthorized && <p className="ledger-reminder-status"><span /> Alerts default recipient · {reminderPreferences.email}</p>}
              {!remindersReady && <p>Email delivery is not active yet. Copy <code>.env.example</code> to <code>.env.local</code>, set <code>RESEND_API_KEY</code>, a verified <code>RESEND_FROM_EMAIL</code>, and a long <code>REMINDER_ACCESS_PASSWORD</code>, then restart the app. Your destination and reminder choices can be saved now.</p>}
              {remindersReady && !remindersAuthorized && <p>Set the destination and reminder days, then enter the server access password to enable scheduled email. Provider credentials stay on the server.</p>}
              <form className="ledger-reminder-form" onSubmit={saveEmailReminderSettings}>
                <label className="ledger-field"><span>Send reminders to</span><input required type="email" autoComplete="email" value={reminderEmailDraft} onChange={(event) => setReminderEmailDraft(event.target.value)} placeholder="you@example.com" /></label>
                <fieldset className="ledger-reminder-days">
                  <legend>Remind me before a bill is due</legend>
                  {[5, 3].map((daysBefore) => (
                    <label key={daysBefore}>
                      <input type="checkbox" checked={reminderDaysDraft.includes(daysBefore)} onChange={(event) => setReminderDaysDraft((current) => event.target.checked ? [...current, daysBefore].sort((a, b) => b - a) : current.filter((day) => day !== daysBefore))} />
                      <span>{daysBefore} days before</span>
                    </label>
                  ))}
                </fieldset>
                {remindersReady && !remindersAuthorized && <label className="ledger-field"><span>Reminder access password</span><input required type="password" autoComplete="current-password" value={reminderPassword} onChange={(event) => setReminderPassword(event.target.value)} /></label>}
                <div className="ledger-form-actions">
                  {remindersAuthorized && <button className="ledger-cancel" type="button" onClick={lockEmailReminders}>Lock alerts</button>}
                  <button className="ledger-submit" type="submit" disabled={isReminderUnlocking}>{isReminderUnlocking ? "Saving…" : remindersAuthorized ? "Save settings" : remindersReady ? "Enable email alerts" : "Save preferences"}<span>↗</span></button>
                </div>
              </form>
              <p className="ledger-phone-note">Each selected reminder is scheduled for 9:00 AM in your local time. Resend can schedule up to 30 days ahead; closer bills are linked automatically as they enter that window.</p>
            </div>
            {reminderMessage && <p className="ledger-reminder-message" role="status" aria-live="polite">{reminderMessage}</p>}
          </section>
        </div>
      )}
    </main>
  );
}

