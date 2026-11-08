"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const NATIONAL_HOLIDAY_URL = "https://date.nager.at/api/v3/PublicHolidays/{year}/PH";
const HOLIDAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NATIONAL_FALLBACK = require("./data/calendar/philippines-2026.json");
const LOCAL_HOLIDAYS = require("./data/calendar/zamboanga-del-sur-2026.json");

class CalendarValidationError extends Error {}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validateTask(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new CalendarValidationError("Provide a calendar task.");
  }
  const title = typeof data.title === "string" ? data.title.trim() : "";
  const date = data.date;
  const startTime = typeof data.startTime === "string" ? data.startTime : "";
  const endTime = typeof data.endTime === "string" ? data.endTime : "";
  const notes = typeof data.notes === "string" ? data.notes.trim() : "";
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

  if (!title || title.length > 160) throw new CalendarValidationError("Enter a task title up to 160 characters.");
  if (!isValidDate(date)) throw new CalendarValidationError("Choose a valid calendar date.");
  if (startTime && !timePattern.test(startTime)) throw new CalendarValidationError("Enter a valid start time.");
  if (endTime && !timePattern.test(endTime)) throw new CalendarValidationError("Enter a valid end time.");
  if (startTime && endTime && endTime < startTime) {
    throw new CalendarValidationError("The end time must be after the start time.");
  }
  if (notes.length > 2000) throw new CalendarValidationError("Task notes must be 2,000 characters or fewer.");
  return { title, date, startTime, endTime, notes };
}

function holidaySlug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function normalizeNationalHolidays(year, responseHolidays) {
  const fallbackHolidays = NATIONAL_FALLBACK.year === year
    ? NATIONAL_FALLBACK.holidays
    : [];
  const fallbackDates = new Set(fallbackHolidays.map((holiday) => holiday.date));
  const normalized = fallbackHolidays.map((holiday) => ({ ...holiday }));

  for (const holiday of responseHolidays) {
    if (!holiday || !isValidDate(holiday.date) || !holiday.date.startsWith(`${year}-`)) continue;
    const title = typeof holiday.name === "string" ? holiday.name.trim() : "";
    if (!title || fallbackDates.has(holiday.date)) continue;
    normalized.push({
      id: `ph-${holiday.date}-${holidaySlug(title)}`,
      date: holiday.date,
      title,
      kind: "official",
      holidayType: "National public holiday",
      isNonWorking: true,
      municipality: null,
      sourceName: "Nager.Date public-holiday JSON",
      sourceUrl: NATIONAL_HOLIDAY_URL.replace("{year}", String(year)),
    });
  }

  return normalized;
}

function createTeacherCalendarStore(options = {}) {
  const databasePath = options.databasePath;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const inFlightHolidaySyncs = new Map();

  if (typeof databasePath !== "string" || !databasePath) {
    throw new Error("A separate calendar database path is required.");
  }

  async function withDatabase(callback) {
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS calendar_tasks (
          id TEXT PRIMARY KEY,
          teacher_id TEXT NOT NULL,
          title TEXT NOT NULL,
          task_date TEXT NOT NULL,
          start_time TEXT NOT NULL DEFAULT '',
          end_time TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS calendar_tasks_teacher_date
          ON calendar_tasks (teacher_id, task_date);
        CREATE TABLE IF NOT EXISTS calendar_holidays (
          id TEXT NOT NULL,
          year INTEGER NOT NULL,
          date TEXT NOT NULL,
          title TEXT NOT NULL,
          kind TEXT NOT NULL,
          holiday_type TEXT NOT NULL,
          is_non_working INTEGER NOT NULL,
          municipality TEXT,
          source_name TEXT NOT NULL,
          source_url TEXT NOT NULL,
          PRIMARY KEY (id, year)
        );
        CREATE INDEX IF NOT EXISTS calendar_holidays_year_date
          ON calendar_holidays (year, date);
        CREATE TABLE IF NOT EXISTS calendar_holiday_syncs (
          scope TEXT NOT NULL,
          year INTEGER NOT NULL,
          synced_at TEXT NOT NULL,
          source_name TEXT NOT NULL,
          warning TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (scope, year)
        );
      `);
      const taskColumns = database.prepare("PRAGMA table_info(calendar_tasks)").all();
      if (!taskColumns.some((column) => column.name === "is_done")) {
        database.exec("ALTER TABLE calendar_tasks ADD COLUMN is_done INTEGER NOT NULL DEFAULT 0");
      }
      return await callback(database);
    } finally {
      database.close();
    }
  }

  function getSyncStatus(database, scope, year) {
    return database.prepare(
      "SELECT synced_at AS syncedAt, source_name AS sourceName, warning FROM calendar_holiday_syncs WHERE scope = ? AND year = ?",
    ).get(scope, year);
  }

  function saveHolidays(database, year, holidays) {
    const saveHoliday = database.prepare(`
      INSERT INTO calendar_holidays (
        id, year, date, title, kind, holiday_type, is_non_working,
        municipality, source_name, source_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, year) DO UPDATE SET
        date = excluded.date,
        title = excluded.title,
        kind = excluded.kind,
        holiday_type = excluded.holiday_type,
        is_non_working = excluded.is_non_working,
        municipality = excluded.municipality,
        source_name = excluded.source_name,
        source_url = excluded.source_url
    `);
    for (const holiday of holidays) {
      saveHoliday.run(
        holiday.id,
        year,
        holiday.date,
        holiday.title,
        holiday.kind,
        holiday.holidayType,
        holiday.isNonWorking ? 1 : 0,
        holiday.municipality || null,
        holiday.sourceName,
        holiday.sourceUrl || "",
      );
    }
  }

  async function syncNationalHolidays(year) {
    const scope = "official:PH";
    const syncKey = `${scope}:${year}`;
    const existingSync = inFlightHolidaySyncs.get(syncKey);
    if (existingSync) return existingSync;

    const syncPromise = (async () => {
      const currentStatus = await withDatabase((database) => getSyncStatus(database, scope, year));
      if (currentStatus && now() - Date.parse(currentStatus.syncedAt) < HOLIDAY_CACHE_TTL_MS) {
        return currentStatus;
      }
      let downloadedHolidays = [];
      let sourceName = "Bundled 2026 official holiday list";
      let warning = "";
      try {
        if (typeof fetchImpl !== "function") throw new Error("Fetch is not available.");
        const sourceUrl = NATIONAL_HOLIDAY_URL.replace("{year}", String(year));
        const response = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Holiday source returned HTTP ${response.status}.`);
        const payload = await response.json();
        if (!Array.isArray(payload)) throw new Error("Holiday source returned an invalid response.");
        downloadedHolidays = payload;
        sourceName = "Nager.Date JSON plus bundled official declarations";
      } catch (error) {
        warning = `The national holiday feed could not be refreshed; showing the saved or bundled dates. ${error.message}`;
      }

      const mergedHolidays = normalizeNationalHolidays(year, downloadedHolidays);
      const syncedAt = new Date(now()).toISOString();
      await withDatabase((database) => {
        database.prepare(
          "DELETE FROM calendar_holidays WHERE year = ? AND kind = ?",
        ).run(year, "official");
        saveHolidays(database, year, mergedHolidays);
        database.prepare(`
          INSERT INTO calendar_holiday_syncs (scope, year, synced_at, source_name, warning)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(scope, year) DO UPDATE SET
            synced_at = excluded.synced_at,
            source_name = excluded.source_name,
            warning = excluded.warning
        `).run(scope, year, syncedAt, sourceName, warning);
      });
      return { syncedAt, sourceName, warning };
    })();

    inFlightHolidaySyncs.set(syncKey, syncPromise);
    try {
      return await syncPromise;
    } finally {
      inFlightHolidaySyncs.delete(syncKey);
    }
  }

  async function syncLocalHolidays(year) {
    const scope = "local:zamboanga-del-sur";
    const syncKey = `${scope}:${year}`;
    const existingSync = inFlightHolidaySyncs.get(syncKey);
    if (existingSync) return existingSync;
    const holidays = LOCAL_HOLIDAYS.year === year ? LOCAL_HOLIDAYS.holidays : [];
    const syncPromise = (async () => {
      const currentStatus = await withDatabase((database) => getSyncStatus(database, scope, year));
      if (currentStatus && currentStatus.sourceName === LOCAL_HOLIDAYS.sourceName) {
        return currentStatus;
      }
      return withDatabase((database) => {
        database.prepare(
          "DELETE FROM calendar_holidays WHERE year = ? AND kind = ?",
        ).run(year, "local");
        saveHolidays(database, year, holidays);
        const syncedAt = new Date(now()).toISOString();
        database.prepare(`
          INSERT INTO calendar_holiday_syncs (scope, year, synced_at, source_name, warning)
          VALUES (?, ?, ?, ?, '')
          ON CONFLICT(scope, year) DO UPDATE SET
            synced_at = excluded.synced_at,
            source_name = excluded.source_name,
            warning = ''
        `).run(scope, year, syncedAt, LOCAL_HOLIDAYS.sourceName);
        return { syncedAt, sourceName: LOCAL_HOLIDAYS.sourceName, warning: "" };
      });
    })();
    inFlightHolidaySyncs.set(syncKey, syncPromise);
    try {
      return await syncPromise;
    } finally {
      inFlightHolidaySyncs.delete(syncKey);
    }
  }

  async function listTasks(teacherId, from, to) {
    if (!teacherId) throw new Error("A teacher account is required.");
    const rangeDays = (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`))
      / (24 * 60 * 60 * 1000);
    if (!isValidDate(from) || !isValidDate(to) || from > to || rangeDays > 370) {
      throw new CalendarValidationError("Choose a valid calendar date range.");
    }
    const tasks = await withDatabase((database) => database.prepare(`
      SELECT id, title, task_date AS date, start_time AS startTime,
             end_time AS endTime, notes, is_done AS isDone,
             created_at AS createdAt, updated_at AS updatedAt
      FROM calendar_tasks
      WHERE teacher_id = ? AND task_date BETWEEN ? AND ?
      ORDER BY task_date, start_time, title
    `).all(teacherId, from, to));
    return tasks.map((task) => ({ ...task, isDone: Boolean(task.isDone) }));
  }

  async function createTask(teacherId, data) {
    if (!teacherId) throw new Error("A teacher account is required.");
    const task = validateTask(data);
    const id = crypto.randomUUID();
    const nowIso = new Date(now()).toISOString();
    await withDatabase((database) => database.prepare(`
      INSERT INTO calendar_tasks (
        id, teacher_id, title, task_date, start_time, end_time, notes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, teacherId, task.title, task.date, task.startTime, task.endTime,
      task.notes, nowIso, nowIso,
    ));
    return { id, ...task, isDone: false, createdAt: nowIso, updatedAt: nowIso };
  }

  async function updateTask(teacherId, id, data) {
    if (!teacherId) throw new Error("A teacher account is required.");
    const task = validateTask(data);
    const updatedAt = new Date(now()).toISOString();
    return withDatabase((database) => {
      const result = database.prepare(`
        UPDATE calendar_tasks
        SET title = ?, task_date = ?, start_time = ?, end_time = ?, notes = ?, updated_at = ?
        WHERE id = ? AND teacher_id = ?
      `).run(
        task.title, task.date, task.startTime, task.endTime, task.notes,
        updatedAt, id, teacherId,
      );
      if (!result.changes) return null;
      const updatedTask = database.prepare(`
        SELECT id, title, task_date AS date, start_time AS startTime,
               end_time AS endTime, notes, is_done AS isDone,
               created_at AS createdAt, updated_at AS updatedAt
        FROM calendar_tasks
        WHERE id = ? AND teacher_id = ?
      `).get(id, teacherId);
      return { ...updatedTask, isDone: Boolean(updatedTask.isDone) };
    });
  }

  async function setTaskDone(teacherId, id, isDone) {
    if (!teacherId) throw new Error("A teacher account is required.");
    if (typeof isDone !== "boolean") {
      throw new CalendarValidationError("Choose whether the task is done.");
    }
    const updatedAt = new Date(now()).toISOString();
    return withDatabase((database) => {
      const result = database.prepare(`
        UPDATE calendar_tasks
        SET is_done = ?, updated_at = ?
        WHERE id = ? AND teacher_id = ?
      `).run(isDone ? 1 : 0, updatedAt, id, teacherId);
      if (!result.changes) return null;
      const task = database.prepare(`
        SELECT id, title, task_date AS date, start_time AS startTime,
               end_time AS endTime, notes, is_done AS isDone,
               created_at AS createdAt, updated_at AS updatedAt
        FROM calendar_tasks
        WHERE id = ? AND teacher_id = ?
      `).get(id, teacherId);
      return { ...task, isDone: Boolean(task.isDone) };
    });
  }

  async function deleteTask(teacherId, id) {
    if (!teacherId) throw new Error("A teacher account is required.");
    return withDatabase((database) => database.prepare(
      "DELETE FROM calendar_tasks WHERE id = ? AND teacher_id = ?",
    ).run(id, teacherId).changes > 0);
  }

  async function getHolidays(year) {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new CalendarValidationError("Choose a valid calendar year.");
    }
    const nationalSync = await syncNationalHolidays(year);
    const localSync = await syncLocalHolidays(year);
    const holidays = await withDatabase((database) => database.prepare(`
      SELECT id, date, title, kind, holiday_type AS holidayType,
             is_non_working AS isNonWorking, municipality,
             source_name AS sourceName, source_url AS sourceUrl
      FROM calendar_holidays
      WHERE year = ?
      ORDER BY date, kind, title
    `).all(year).map((holiday) => ({
      ...holiday,
      isNonWorking: Boolean(holiday.isNonWorking),
    })));
    return {
      year,
      holidays,
      sync: {
        national: nationalSync,
        local: localSync,
      },
    };
  }

  return {
    listTasks,
    createTask,
    updateTask,
    setTaskDone,
    deleteTask,
    getHolidays,
  };
}

module.exports = {
  createTeacherCalendarStore,
  CalendarValidationError,
  isValidDate,
};
