"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const {
  CalendarValidationError,
  createTeacherCalendarStore,
} = require("../teacher-calendar-store");

test("calendar tasks persist and are isolated by teacher", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teacher-calendar-"));
  const databasePath = path.join(directory, "calendar.sqlite");
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createTeacherCalendarStore({ databasePath });

  const firstTask = await store.createTask("teacher-a", {
    title: "Prepare science lesson",
    date: "2026-11-09",
    startTime: "09:00",
    endTime: "10:00",
    notes: "Bring the activity sheets.",
  });
  await store.createTask("teacher-b", {
    title: "Prepare science lesson",
    date: "2026-11-09",
  });

  assert.equal(firstTask.title, "Prepare science lesson");
  assert.equal(firstTask.isDone, false);
  const firstTeacherTasks = await store.listTasks("teacher-a", "2026-11-01", "2026-11-30");
  assert.equal(firstTeacherTasks.length, 1);
  assert.equal(firstTeacherTasks[0].id, firstTask.id);
  assert.equal(firstTeacherTasks[0].isDone, false);
  assert.equal(await store.setTaskDone("teacher-b", firstTask.id, true), null);
  assert.equal((await store.setTaskDone("teacher-a", firstTask.id, true)).isDone, true);
  await assert.rejects(store.setTaskDone("teacher-a", firstTask.id, "yes"), CalendarValidationError);
  assert.equal(await store.updateTask("teacher-b", firstTask.id, {
    title: "Changed by another teacher",
    date: "2026-11-09",
  }), null);
  assert.equal(await store.deleteTask("teacher-b", firstTask.id), false);

  const restartedStore = createTeacherCalendarStore({ databasePath });
  const updatedTask = await restartedStore.updateTask("teacher-a", firstTask.id, {
    title: "Prepare revised science lesson",
    date: "2026-11-10",
    startTime: "",
    endTime: "",
    notes: "",
  });
  assert.equal(updatedTask.title, "Prepare revised science lesson");
  assert.equal(updatedTask.isDone, true);
  const updatedTeacherTasks = await restartedStore.listTasks("teacher-a", "2026-11-10", "2026-11-10");
  assert.equal(updatedTeacherTasks.length, 1);
  assert.equal(updatedTeacherTasks[0].title, updatedTask.title);
  assert.equal(updatedTeacherTasks[0].isDone, true);
  assert.equal((await restartedStore.setTaskDone("teacher-a", firstTask.id, false)).isDone, false);
  assert.equal(await restartedStore.deleteTask("teacher-a", firstTask.id), true);

  await assert.rejects(
    restartedStore.createTask("teacher-a", {
      title: "Invalid time range",
      date: "2026-11-10",
      startTime: "14:00",
      endTime: "13:00",
    }),
    CalendarValidationError,
  );
});

test("calendar store adds completion status to an existing task database", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teacher-calendar-migration-"));
  const databasePath = path.join(directory, "calendar.sqlite");
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE calendar_tasks (
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
    INSERT INTO calendar_tasks (
      id, teacher_id, title, task_date, created_at, updated_at
    ) VALUES ('existing-task', 'teacher-a', 'Existing task', '2026-11-09', 'created', 'updated');
  `);
  database.close();

  const store = createTeacherCalendarStore({ databasePath });
  const tasks = await store.listTasks("teacher-a", "2026-11-01", "2026-11-30");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, "existing-task");
  assert.equal(tasks[0].isDone, false);
  assert.equal((await store.setTaskDone("teacher-a", "existing-task", true)).isDone, true);
});

test("holiday sync caches JSON, keeps overlaps, and falls back to bundled dates", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teacher-calendar-holidays-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  let currentTime = Date.UTC(2026, 0, 1);
  let fetchCount = 0;
  const store = createTeacherCalendarStore({
    databasePath: path.join(directory, "calendar.sqlite"),
    now: () => currentTime,
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return {
          ok: true,
          json: async () => [
            { date: "2026-09-17", name: "National observance overlap" },
            { date: "2026-10-10", name: "Remote public holiday" },
            { date: "2026-10-11", name: "Stale remote holiday" },
          ],
        };
      }
      return {
        ok: true,
        json: async () => [
          { date: "2026-09-17", name: "National observance overlap" },
          { date: "2026-10-10", name: "Remote public holiday" },
        ],
      };
    },
  });

  const firstSync = await store.getHolidays(2026);
  const overlap = firstSync.holidays.filter((holiday) => holiday.date === "2026-09-17");
  assert.deepEqual(overlap.map((holiday) => holiday.kind).sort(), ["local", "official"]);
  assert.ok(firstSync.holidays.some((holiday) => holiday.date === "2026-03-20"));
  assert.ok(firstSync.holidays.some((holiday) => holiday.date === "2026-10-10"));

  const cachedSync = await store.getHolidays(2026);
  assert.equal(fetchCount, 1);
  assert.equal(cachedSync.holidays.filter((holiday) => holiday.date === "2026-09-17").length, 2);

  currentTime += 24 * 60 * 60 * 1000 + 1;
  await store.getHolidays(2026);
  assert.equal(fetchCount, 2);
  assert.equal((await store.getHolidays(2026)).holidays
    .some((holiday) => holiday.date === "2026-10-11"), false,
  "removed remote holidays are not retained after refresh");
  assert.equal((await store.getHolidays(2026)).holidays
    .filter((holiday) => holiday.date === "2026-09-17").length, 2);

  const fallbackStore = createTeacherCalendarStore({
    databasePath: path.join(directory, "fallback.sqlite"),
    now: () => currentTime,
    fetchImpl: async () => { throw new Error("offline"); },
  });
  const fallback = await fallbackStore.getHolidays(2026);
  assert.match(fallback.sync.national.warning, /offline/);
  assert.ok(fallback.holidays.some((holiday) => holiday.date === "2026-03-20"));
  assert.ok(fallback.holidays.some((holiday) => holiday.kind === "local"));
});
