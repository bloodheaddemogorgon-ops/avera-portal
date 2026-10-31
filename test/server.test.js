"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const { SaxesParser } = require("saxes");
const XLSX = require("@e965/xlsx");
const sharp = require("sharp");
const { createAuthRateLimiter } = require("../auth-rate-limiter");
const { createServer, readPortalDatabaseWorkbook, writePortalDatabaseWorkbook, eClassGradingMethod, computeEClassTermGrade } = require("../server");
const {
  calculateAgeMonths,
  calculateBmiForAge,
  calculateLmsZScore,
  classifyBmiForAge,
  classifyHeightForAge,
} = require("../who-growth-reference");

const sourceWorkbook = path.join(__dirname, "..", "grade5-portal-database-template.xlsx");
const sourceSF2Template = path.join(__dirname, "..", "SF2.xlsx");
const testWorkbookHeaders = {
  Users: [
    "User ID", "Role", "Full Name", "Email", "Password hash (PBKDF2)", "Class ID", "Status",
    "Created", "Sign-ins", "Last sign-in", "Email check",
  ],
  Classes: [
    "Class ID", "Classroom number", "Class code (parents enter this)", "Teacher User ID",
    "Teacher name", "Students", "Parents signed up", "Grade", "Section", "School Year",
    "Name of School", "School ID", "School Head",
  ],
  Students: [
    "Student ID", "Student name", "Class ID", "Parent User ID", "Parent name", "Parent email",
    "LRN", "Last name", "First name", "Middle name", "Gender", "Birthdate",
    "Mother's Maiden name", "Guardian relationship", "Father", "Current residence", "Religion",
    "Mother tongue", "Dialects", "Ethnicities", "Teacher User ID",
  ],
  "Term Grades": [
    "Grade ID", "Student ID", "Class ID", "Teacher User ID", "Term", "Subject", "Grade", "Updated", "Source",
  ],
  SignInLog: ["Timestamp", "Email", "Role chosen", "Result", "User ID", "Note"],
};

const sf2StudentRows = [
  ...Array.from({ length: 50 }, (_, index) => 13 + index),
  ...Array.from({ length: 50 }, (_, index) => 64 + index),
];

function attendanceWeekdays(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return Array.from({ length: dayCount }, (_, index) => {
    const day = index + 1;
    const date = `${month}-${String(day).padStart(2, "0")}`;
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6 ? date : null;
  }).filter(Boolean);
}

function applyTestWorkbookHeaders(workbook) {
  for (const [sheetName, headers] of Object.entries(testWorkbookHeaders)) {
    const sheet = workbook.getWorksheet(sheetName);
    assert.ok(sheet, `${sheetName} worksheet exists`);
    headers.forEach((header, index) => {
      sheet.getRow(1).getCell(index + 1).value = header;
    });
  }
}

function assertNoLightGraySf2Fills(sheet) {
  const lightGrayColors = new Set(["FFF2F2F2", "FFE6E6E6"]);
  sheet.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      const color = cell.fill && cell.fill.fgColor
        && String(cell.fill.fgColor.argb || cell.fill.fgColor.rgb || "").toUpperCase();
      assert.equal(lightGrayColors.has(color), false, `${cell.address} has no light-gray fill`);
    });
  });
}

test("WHO BMI-for-age and Height-for-Age categories use LMS z-scores and requested boundaries", () => {
  assert.equal(calculateLmsZScore(15, { l: 0, m: 15, s: 0.1 }), 0);
  assert.ok(Math.abs(calculateAgeMonths("2015-04-21", "2025-04-21") - 120.0164271) < 1e-7);
  assert.deepEqual(
    [-3.01, -3, -2, 1, 1.01, 2, 2.01].map(classifyBmiForAge),
    ["Severely Wasted", "Wasted", "Normal", "Normal", "Overweight", "Overweight", "Obese"],
  );
  assert.deepEqual(
    [-3.01, -3, -2, 3, 3.01].map(classifyHeightForAge),
    ["Severely Stunted", "Stunted", "Normal", "Normal", "Tall"],
  );
  assert.equal(calculateBmiForAge({
    birthdate: "2015-04-21",
    gender: "Female",
    measurementDate: "2025-04-21",
    weightKg: 42,
    heightM: 1.4,
  }).bmiCategory, "Overweight");
  const femaleAssessment = calculateBmiForAge({
    birthdate: "2015-04-21",
    gender: "Female",
    measurementDate: "2025-04-21",
    weightKg: 42,
    heightM: 1.4,
  });

  assert.equal(femaleAssessment.heightForAgeStatus, "Normal");
  assert.ok(Number.isFinite(femaleAssessment.haz));
  assert.equal(calculateBmiForAge({
    birthdate: "2015-04-21",
    gender: "Male",
    measurementDate: "2025-04-21",
    weightKg: 42,
    heightM: 1.4,
  }).bmiCategory, "Obese");
  assert.equal(calculateBmiForAge({
    birthdate: "2020-01-01",
    gender: "Female",
    measurementDate: "2025-01-01",
    weightKg: 20,
    heightM: 1.1,
  }).bmiCategory, "Not available"  );
});

test("login rate limiter enforces account and source-address limits over a rolling window", () => {
  const limiter = createAuthRateLimiter({
    accountFailureLimit: 2,
    ipFailureLimit: 3,
    windowMs: 10000,
  });
  const firstFailure = limiter.reserveAttempt("192.0.2.1", "Teacher@example.com", 1000);
  const secondFailure = limiter.reserveAttempt("192.0.2.1", "teacher@example.com", 1500);
  assert.equal(firstFailure.retryAfterSeconds, 0);
  assert.equal(secondFailure.retryAfterSeconds, 0);

  assert.equal(limiter.getRetryAfterSeconds("192.0.2.1", "TEACHER@example.com", 2000), 9);
  assert.equal(limiter.getRetryAfterSeconds("192.0.2.1", "other@example.com", 2000), 0);
  assert.equal(limiter.getRetryAfterSeconds("192.0.2.2", "teacher@example.com", 2000), 9);
  assert.equal(limiter.getRetryAfterSeconds("192.0.2.1", "teacher@example.com", 11000), 0);

  limiter.clearAccount("TEACHER@example.com");
  assert.equal(limiter.getRetryAfterSeconds("192.0.2.2", "teacher@example.com", 11000), 0);
});

test("login rate limiter bounds and expires tracked buckets", () => {
  assert.throws(() => createAuthRateLimiter({ maxBuckets: 1 }), RangeError);
  const limiter = createAuthRateLimiter({
    accountFailureLimit: 1,
    ipFailureLimit: 1,
    windowMs: 1000,
    maxBuckets: 2,
  });
  limiter.reserveAttempt("192.0.2.1", "one@example.com", 1000);
  assert.equal(limiter.getRetryAfterSeconds("192.0.2.1", "one@example.com", 1001), 1);
  limiter.reserveAttempt("192.0.2.2", "two@example.com", 1001);
  assert.equal(limiter.getRetryAfterSeconds("192.0.2.2", "two@example.com", 1001), 1);
  assert.equal(limiter.getRetryAfterSeconds("192.0.2.1", "one@example.com", 2001), 0);
});

test("successful sign-ins release their source-address reservation", () => {
  const limiter = createAuthRateLimiter({
    accountFailureLimit: 1,
    ipFailureLimit: 1,
    windowMs: 1000,
  });
  const first = limiter.reserveAttempt("192.0.2.1", "teacher@example.com", 1000);
  assert.equal(limiter.getRetryAfterSeconds("192.0.2.1", "teacher@example.com", 1001), 1);
  first.cancel();
  limiter.clearAccount("teacher@example.com");
  assert.equal(limiter.getRetryAfterSeconds("192.0.2.1", "teacher@example.com", 1001), 0);
});

test("E-Class score inputs reconcile with refreshed and cleared student rosters", async () => {
  const portalPage = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");
  const helperSource = portalPage.match(
    /function reconcileEClassScoresWithRoster\(students\)\{[\s\S]*?\n  \}/,
  );
  assert.ok(helperSource, "E-Class score reconciliation helper exists");

  const storedScores = new Map([
    ["gradePortalEClassScores:class-1:Term%201:Filipino:student-1", '["10"]'],
    ["gradePortalEClassScores:class-1:Term%202:MAPEH:Music%20and%20Arts:student%3A2", '["8"]'],
    ["gradePortalEClassScores:class-2:Term%201:Filipino:student-3", '["9"]'],
  ]);
  const localStorage = {
    get length() {
      return storedScores.size;
    },
    key(index) {
      return Array.from(storedScores.keys())[index] || null;
    },
    removeItem(key) {
      storedScores.delete(key);
    },
  };
  const reconcile = vm.runInNewContext(`(${helperSource[0]})`, {
    currentUser: { activeClassId: "class-1" },
    window: { localStorage },
    decodeURIComponent,
  });

  assert.equal(reconcile([{ id: "student-1" }]), 1);
  assert.equal(storedScores.has("gradePortalEClassScores:class-1:Term%201:Filipino:student-1"), true);
  assert.equal(storedScores.has("gradePortalEClassScores:class-1:Term%202:MAPEH:Music%20and%20Arts:student%3A2"), false);
  assert.equal(storedScores.has("gradePortalEClassScores:class-2:Term%201:Filipino:student-3"), true);
  assert.equal(reconcile([]), 1);
  assert.equal(storedScores.size, 1);
});

test("E-Class score validation enforces each highest-possible-score limit", async () => {
  const portalPage = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");
  const helperSource = portalPage.match(
    /function eClassScoreValidationMessage\(value,maximumValue\)\{[\s\S]*?\n  \}/,
  );
  assert.ok(helperSource, "E-Class input validation helper exists");
  const validateScore = vm.runInNewContext(
    `${helperSource[0]}; eClassScoreValidationMessage`,
  );

  assert.equal(validateScore("10", "10"), "", "a score equal to its maximum is allowed");
  assert.equal(validateScore("7.5", "10"), "", "scores below the maximum are allowed");
  assert.match(validateScore("10.01", "10"), /cannot exceed the highest possible score of 10/);
  assert.match(validateScore("-1", "10"), /non-negative/);
  assert.match(validateScore("not a score", "10"), /non-negative/);
  assert.match(validateScore("1", ""), /positive highest possible score/);
  assert.equal(validateScore("", "10"), "", "an empty score remains allowed");
  assert.match(portalPage, /scoreInput\.value=scoreInput\.dataset\.lastValidScore\|\|""/);
  assert.match(portalPage, /input\.value="";\s*input\.dataset\.lastValidScore=""/);
});

test("E-Class term grades follow the DO 015 s. 2026 worked examples and transition rules", () => {
  // Table 5: Science 6, transmuted (SY 2026-2027). WW 74/85, PT 43/50, ST1 15/20, ST2 18/20, TE 35/40.
  const scienceMaxima = ["20", "25", "20", "20", "", "25", "25", "", "20", "20", "40"];
  const scienceScores = ["17", "22", "20", "15", "", "20", "23", "", "15", "18", "35"];
  const science = computeEClassTermGrade(scienceScores, scienceMaxima, "Science", "transmuted");
  assert.equal(science.termGrade, "88");
  assert.ok(Math.abs(science.initialGrade - 85.8) < 0.1);
  // Table 6: Mathematics 7, zero-based. IG 83.6 rounds to 84 with no transmutation.
  const mathMaxima = ["20", "25", "20", "", "", "25", "25", "25", "25", "20", "50"];
  const mathScores = ["15", "22", "20", "", "", "20", "23", "20", "19", "16", "42"];
  const math = computeEClassTermGrade(mathScores, mathMaxima, "Mathematics", "zero-based");
  assert.equal(math.termGrade, "84");
  assert.equal(computeEClassTermGrade(mathScores, mathMaxima, "Mathematics", "transmuted").termGrade, "86");
  // MAPEH and EPP/TLE use 20/60/20.
  const perfect = ["10", "", "", "", "", "10", "", "", "10", "", "10"];
  const half = ["10", "", "", "", "", "5", "", "", "10", "", "10"];
  assert.equal(computeEClassTermGrade(half, perfect, "MAPEH", "zero-based").termGrade, "70");
  assert.equal(computeEClassTermGrade(half, perfect, "Science", "zero-based").termGrade, "75");
  assert.equal(computeEClassTermGrade(["0", "", "", "", "", "0", "", "", "0", "", "0"], perfect, "Science", "zero-based").termGrade, "60");
  assert.equal(computeEClassTermGrade(["10"], perfect, "Science", "zero-based").termGrade, "");
  // Transition table 12.
  assert.equal(eClassGradingMethod("Grade 1", "2026-2027"), "descriptive");
  assert.equal(eClassGradingMethod("Grade 2", "2026-2027"), "transmuted");
  assert.equal(eClassGradingMethod("Grade 3", "2026-2027"), "transmuted");
  assert.equal(eClassGradingMethod("Grade 3", "2027-2028"), "zero-based");
  assert.equal(eClassGradingMethod("Grade 2", "2027-2028"), "descriptive");
  assert.equal(eClassGradingMethod("Grade 3", "2028-2029"), "descriptive");
  assert.equal(eClassGradingMethod("Grade 5", "2026-2027"), "transmuted");
  assert.equal(eClassGradingMethod("Grade 10", "2027-2028"), "zero-based");
  assert.equal(eClassGradingMethod("Grade 6", ""), "transmuted");
});

test("E-Class uses every DO 015 s. 2026 transmutation band before saving all subject grades", async () => {
  const portalPage = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");
  const serverSource = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");
  const rangesMatch = portalPage.match(/var eClassTransmutationRanges=(\[[\s\S]*?\]);/);
  const gradeFunctionMatch = portalPage.match(/function eClassGradeForInitial\(initialGrade,method\)\{[\s\S]*?\n  \}/);
  assert.ok(rangesMatch, "E-Class transmutation ranges are present");
  assert.ok(gradeFunctionMatch, "E-Class transmutation function is present");

  const expectedRanges = [
    [99.50, 100.00, 100], [98.32, 99.49, 99], [97.14, 98.31, 98], [95.96, 97.13, 97],
    [94.78, 95.95, 96], [93.60, 94.77, 95], [92.42, 93.59, 94], [91.24, 92.41, 93],
    [90.06, 91.23, 92], [88.88, 90.05, 91], [87.70, 88.87, 90], [86.52, 87.69, 89],
    [85.34, 86.51, 88], [84.16, 85.33, 87], [82.98, 84.15, 86], [81.80, 82.97, 85],
    [80.62, 81.79, 84], [79.44, 80.61, 83], [78.26, 79.43, 82], [77.08, 78.25, 81],
    [75.90, 77.07, 80], [74.72, 75.89, 79], [73.54, 74.71, 78], [72.36, 73.53, 77],
    [71.18, 72.35, 76], [70.00, 71.17, 75], [65.34, 69.99, 74], [60.67, 65.33, 73],
    [56.01, 60.66, 72], [51.34, 56.00, 71], [46.67, 51.33, 70], [42.01, 46.66, 69],
    [37.34, 42.00, 68], [32.68, 37.33, 67], [28.01, 32.67, 66], [23.35, 28.00, 65],
    [18.68, 23.34, 64], [14.01, 18.67, 63], [9.35, 14.00, 62], [4.68, 9.34, 61],
    [0.00, 4.67, 60],
  ];
  const transmutation = vm.runInNewContext(
    `${rangesMatch[0]};${gradeFunctionMatch[0]};({ranges:eClassTransmutationRanges,grade:eClassGradeForInitial})`,
  );
  assert.deepEqual(Array.from(transmutation.ranges, (range) => Array.from(range)), expectedRanges);
  for (const [minimum, maximum, expectedGrade] of expectedRanges) {
    assert.equal(transmutation.grade(minimum).termGrade, String(expectedGrade));
    assert.equal(transmutation.grade(maximum).termGrade, String(expectedGrade));
  }
  assert.equal(transmutation.grade(71.17).termGrade, "75");
  assert.equal(transmutation.grade(71.18).termGrade, "76");
  assert.equal(transmutation.grade(69.99).termGrade, "74");
  assert.equal(transmutation.grade(70).termGrade, "75");
  assert.equal(transmutation.grade(99.5).termGrade, "100");
  assert.equal(transmutation.grade(71.175).termGrade, "76");
  assert.equal(transmutation.grade(71.1749).termGrade, "75");
  assert.equal(transmutation.grade(65.335).termGrade, "74");
  assert.equal(transmutation.grade(65.3349).termGrade, "73");
  assert.equal(transmutation.grade(0).termGrade, "60");
  assert.equal(transmutation.grade(100).termGrade, "100");
  assert.equal(transmutation.grade(-0.01).termGrade, "");
  assert.equal(transmutation.grade(100.01).termGrade, "");
  assert.match(portalPage, /var grade=eClassGradeForInitial\(initialGrade,gradingMethod\)/);
  assert.match(portalPage, /var initialGrade=written\.weighted\+performance\.weighted\+examWeighted/);
  assert.doesNotMatch(portalPage, /var initialGrade=Math\.round\(written\.weighted\+performance\.weighted\+examWeighted\)/);
  assert.match(portalPage, /selectedSubject==="EPP \/ TLE"\|\|selectedSubject==="MAPEH"/);
  assert.match(portalPage, /var subjects=eClassSubjectOptions\.length/);
  assert.match(portalPage, /function renderMpsSummaryRows\(subjects\)/);
  assert.match(portalPage, /renderMpsSummaryRows\(sectionSubjects\)/);
  assert.match(portalPage, /var sectionSubjects=eClassSubjectOptions\.length\s*\?\s*eClassSubjectOptions\.slice\(\)/);
  assert.match(portalPage, /if\(!subjectName\|\|!validLearners\|\|!validItems\|\|!validAverage\)return;\s*subjectCount\+\+/);
  assert.match(portalPage, /"EPP":"EPP \/ TLE"/);
  assert.match(portalPage, /"TLE":"EPP \/ TLE"/);
  assert.match(portalPage, /api\("\/api\/e-class\/record"/);
  assert.match(portalPage, /id="importEClass"/);
  assert.match(portalPage, /\/api\/e-class\/import\?term=/);
  assert.match(portalPage, /class="menu-toggle" id="menuToggle"/);
  assert.match(portalPage, /\.menu-toggle\{[^}]*display:grid[^}]*visibility:visible/);
  assert.match(portalPage, /id="settingsMenuButton"[^>]*>☰ Open menu/);
  assert.match(portalPage, /\$\("settingsMenuButton"\)\.onclick=function\(\)\{\$\("menuToggle"\)\.click\(\)\}/);
  assert.match(portalPage, /\.topbar\{[^}]*min-width:0/);
  assert.match(portalPage, /\.topbar-title\{[^}]*overflow:hidden/);
  assert.match(portalPage, /\.topbar-account\{[^}]*flex:0 0 auto/);
  assert.match(portalPage, /importButton\.onclick=function\(\)\{[\s\S]*?importFile\.onchange=async function\(\)/);
  assert.match(portalPage, /importFile\.onchange=async function\(\)[\s\S]*?downloadButton\.onclick=async function\(\)/);
  assert.match(serverSource, /function parseEClassWorkbook\(buffer, selection\)/);
  assert.match(serverSource, /selectedSubject === "epptle" && \["epptle", "epp", "tle"\]\.includes\(workbookSubject\)/);
  assert.match(serverSource, /writtenHighestScores = \[5, 6, 7, 8, 9\]/);
  assert.match(serverSource, /performanceHighestScores = \[13, 14, 15\]/);
  assert.match(serverSource, /examHighestScores = \[19, 20, 21\]/);
  assert.match(serverSource, /url\.pathname === "\/api\/e-class\/import"/);
  assert.match(portalPage, /Save &amp; Lock Record/);
  assert.match(portalPage, /Unlock to Edit/);
  assert.doesNotMatch(portalPage, /syncCalculatedTermGrade\(row,grade\.termGrade\)/);
  assert.match(portalPage, /DepEd Order No\. 015, s\. 2026 transmutation table to every completed subject grade, for all grade levels/);
  assert.match(portalPage, /eclass-table th,\.eclass-table td\{[^}]*border:1px solid #e6e6e6/);
  assert.match(portalPage, /\.eclass-table tbody td\{background:#e6e6e6;border-color:#aab2bd\}/);
  assert.match(portalPage, /\.eclass-table thead th\{[^}]*background:#f5f5f5/);
});

test("E-Class card provides a scoped workbook download", async () => {
  const portalPage = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");
  const serverSource = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(portalPage, /id="downloadEClass"[^>]*disabled[\s\S]*?Download E-Class/);
  assert.match(portalPage, /class="data-card-header"[\s\S]*?class="eclass-controls"[\s\S]*?id="downloadEClass"/);
  assert.match(portalPage, /\.eclass-controls\{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;padding:9px/);
  assert.match(portalPage, /\.eclass-controls \.eclass-record-action\{[^}]*width:auto;[^}]*margin:0;[^}]*padding:8px 12px/);
  assert.match(portalPage, /\.eclass-controls \.eclass-download-button\{align-self:flex-end;margin-left:0\}/);
  assert.doesNotMatch(portalPage, /eclass-download-footer/);
  assert.match(portalPage, /fetch\("\/api\/e-class\/export"/);
  assert.match(portalPage, /filenameMatch\[1\]/);
  assert.match(portalPage, /!\/\\\.xlsx\$\/i\.test\(filenameMatch\[1\]\)/);
  assert.match(portalPage, /link\.download=filenameMatch\[1\]/);
  assert.match(portalPage, /Array\.from\(row\.cells\)\.slice\(2\)\.map/);
  assert.match(portalPage, /if\(!students\.length\)throw new Error\("The E-Class table has no learner records to export\."\)/);
  assert.match(portalPage, /student\.values\.length!==25/);
  assert.match(portalPage, /Array\.from\(highestScoreRow\.cells\)\.slice\(1\)\.map/);
  assert.match(serverSource, /ECLASS_TEMPLATE_PATH = path\.join\(__dirname, "E-CLASS\.xlsx"\)/);
  assert.match(serverSource, /workbookXml = workbookXml\.replaceAll\("TERM 1", term\.toUpperCase\(\)\)/);
  assert.match(serverSource, /archive\.generateAsync\(/);
});

test("term grade page makes the lock state prominent", async () => {
  const portalPage = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(portalPage, /id="gradeLockControl" data-locked=""/);
  assert.match(portalPage, /id="gradeLockBadge" aria-hidden="true">CHECKING<\/span>/);
  assert.match(portalPage, /id="gradeLockStatus" role="status" aria-live="polite"/);
  assert.match(portalPage, /\.grade-lock-control\[data-locked="true"\]\{[^}]*var\(--err\)/);
  assert.match(portalPage, /\$\("gradeLockBadge"\)\.textContent=locked\?"LOCKED":"UNLOCKED"/);
});

test("E-Class export fills the project workbook template with current app records", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "eclass-export-"));
  const databasePath = path.join(directory, "database.sqlite");
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  await createEmptyTestWorkbook(migrationWorkbookPath);
  const server = createServer({ databasePath, migrationWorkbookPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "E-Class Export Teacher",
      email: "eclass.export@example.com",
      password: "secure-pass-123",
      role: "teacher",
      extra: "E-Class Export Room",
      grade: "Grade 5",
    }),
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get("set-cookie").split(";")[0];
  const profileResponse = await fetch(`${baseUrl}/api/teacher/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      name: "E-Class Export Teacher",
      email: "eclass.export@example.com",
      classroomNumber: "E-Class Export Room",
      section: "Mabini",
      sectionsHandled: ["Mabini"],
      region: "Region IX",
      division: "Zamboanga City",
      schoolName: "Sample Elementary School",
      schoolId: "123456",
      schoolYear: "2026-2027",
      position: "Teacher I",
      schoolHead: "Alex Principal",
      schoolHeadPosition: "Principal II",
    }),
  });
  assert.equal(profileResponse.status, 200);

  const templateWorkbook = new ExcelJS.Workbook();
  const templatePath = path.join(__dirname, "..", "E-CLASS.xlsx");
  await templateWorkbook.xlsx.readFile(templatePath);
  const templateSheet = templateWorkbook.getWorksheet("TERM 1");
  const templateZip = await JSZip.loadAsync(await fs.readFile(templatePath));
  const templateWorksheetXml = await templateZip.file("xl/worksheets/sheet1.xml").async("string");
  const students = [];
  for (const [index, student] of [
    { firstName: "Jordan", lastName: "Learner", gender: "Male" },
    { firstName: "Riley", lastName: "Learner", gender: "Female" },
    { firstName: "Casey", lastName: "Learner", gender: "Female" },
  ].entries()) {
    const response = await fetch(`${baseUrl}/api/students`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        ...student,
        lrn: `12345678901${index}`,
        birthdate: "2016-01-15",
      }),
    });
    assert.equal(response.status, 201);
    students.push((await response.json()).student);
  }

  const legacyGenderWorkbook = readPortalDatabaseWorkbook(databasePath);
  const studentSheet = legacyGenderWorkbook.getWorksheet("Students");
  const studentHeaders = studentSheet.getRow(1).values;
  const studentIdColumn = studentHeaders.findIndex((value) => value === "Student ID");
  const genderColumn = studentHeaders.findIndex((value) => value === "Gender");
  const legacyGenderRow = Array.from({ length: studentSheet.rowCount - 1 }, (_, index) => index + 2)
    .map((rowNumber) => studentSheet.getRow(rowNumber))
    .find((row) => String(row.getCell(studentIdColumn).value) === students[2].id);
  assert.ok(legacyGenderRow);
  legacyGenderRow.getCell(genderColumn).value = "Other";
  writePortalDatabaseWorkbook(databasePath, legacyGenderWorkbook);

  const makeValues = (firstScore, termGrade = "85", descriptor = "Very Satisfactory") => {
    const values = Array(25).fill("");
    values[0] = String(firstScore);
    values[5] = String(firstScore);
    values[6] = "100";
    values[7] = "20%";
    values[8] = "9";
    values[11] = "9";
    values[22] = "85";
    values[23] = termGrade;
    values[24] = descriptor;
    return values;
  };
  const savedGradeResponse = await fetch(`${baseUrl}/api/grades/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      studentId: students[1].id,
      term: "Term 2",
      subject: "musicAndArts",
      grade: 88,
    }),
  });
  assert.equal(savedGradeResponse.status, 200);
  const highestScores = [
    "10", "15", "15", "10", "15", "65", "100", "20%",
    "100", "100", "100", "300", "100", "50%",
    "20", "20", "40", "30%", "30%", "40%", "100", "30%",
  ];
  const recordQuery = new URLSearchParams({
    term: "Term 2",
    subject: "MAPEH",
    mapehGroup: "Music and Arts",
    section: "Mabini",
  });
  const recordUrl = `${baseUrl}/api/e-class/record?${recordQuery}`;
  const initialEClassRecord = await fetch(recordUrl, { headers: { Cookie: cookie } });
  assert.equal(initialEClassRecord.status, 200);
  assert.equal((await initialEClassRecord.json()).locked, false);
  const saveEClassRecord = (firstScore = "8") => fetch(`${baseUrl}/api/e-class/record`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      term: "Term 2",
      subject: "MAPEH",
      mapehGroup: "Music and Arts",
      section: "Mabini",
      highestScores: ["10", "15", "15", "10", "15", "100", "100", "100", "20", "20", "40"],
      students: students.map((student, index) => ({
        id: student.id,
        scores: index === 0
          ? [firstScore, "15", "15", "10", "15", "100", "100", "100", "20", "20", "40"]
          : ["", "", "", "", "", "", "", "", "", "", ""],
        grade: index === 0 ? "1" : "",
      })),
    }),
  });
  const savedEClassRecordResponse = await saveEClassRecord();
  assert.equal(savedEClassRecordResponse.status, 200, await savedEClassRecordResponse.clone().text());
  assert.deepEqual(await savedEClassRecordResponse.json(), {
    saved: true,
    locked: true,
    term: "Term 2",
    subject: "MAPEH",
  });
  const savedEClassRecord = await (await fetch(recordUrl, { headers: { Cookie: cookie } })).json();
  assert.equal(savedEClassRecord.locked, true);
  assert.deepEqual(savedEClassRecord.highestScores, ["10", "15", "15", "10", "15", "100", "100", "100", "20", "20", "40"]);
  assert.deepEqual(savedEClassRecord.scores[students[0].id], ["8", "15", "15", "10", "15", "100", "100", "100", "20", "20", "40"]);
  const firstSavedGrade = await fetch(
    `${baseUrl}/api/grades?studentId=${encodeURIComponent(students[0].id)}&term=Term%202`,
    { headers: { Cookie: cookie } },
  );
  assert.equal((await firstSavedGrade.json()).grades.musicAndArts, "99");
  const lockedSaveResponse = await saveEClassRecord("9");
  assert.equal(lockedSaveResponse.status, 409);
  const unlockRequest = (password) => fetch(`${baseUrl}/api/e-class/record/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      term: "Term 2",
      subject: "MAPEH",
      mapehGroup: "Music and Arts",
      section: "Mabini",
      password,
    }),
  });
  assert.equal((await unlockRequest("wrong-password")).status, 400);
  assert.equal((await unlockRequest("secure-pass-123")).status, 200);
  assert.equal((await (await fetch(recordUrl, { headers: { Cookie: cookie } })).json()).locked, false);
  const updatedEClassRecordResponse = await saveEClassRecord("9");
  assert.equal(updatedEClassRecordResponse.status, 200);
  assert.equal((await (await fetch(recordUrl, { headers: { Cookie: cookie } })).json()).locked, true);
  const savedEClassGrade = await fetch(
    `${baseUrl}/api/grades?studentId=${encodeURIComponent(students[0].id)}&term=Term%202`,
    { headers: { Cookie: cookie } },
  );
  assert.equal(savedEClassGrade.status, 200);
  assert.equal((await savedEClassGrade.json()).grades.musicAndArts, "100");
  const restoreExportGrade = await fetch(`${baseUrl}/api/grades/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      studentId: students[1].id,
      term: "Term 2",
      subject: "musicAndArts",
      grade: 88,
    }),
  });
  assert.equal(restoreExportGrade.status, 200);

  const exportResponse = await fetch(`${baseUrl}/api/e-class/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      term: "Term 2",
      subject: "MAPEH",
      mapehGroup: "Music and Arts",
      section: "Mabini",
      highestScores,
      students: [
        { id: students[0].id, values: makeValues(8) },
        { id: students[1].id, values: makeValues(9, "", "") },
        { id: students[2].id, values: makeValues(7) },
      ],
    }),
  });
  assert.equal(exportResponse.status, 200, await exportResponse.clone().text());
  assert.match(exportResponse.headers.get("content-type"), /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\b/i);
  assert.match(exportResponse.headers.get("content-disposition"), /E-CLASS_Term_2_MAPEH_Music_and_Arts_Mabini\.xlsx/);

  const outputWorkbook = new ExcelJS.Workbook();
  const outputBuffer = Buffer.from(await exportResponse.arrayBuffer());
  const outputZip = await JSZip.loadAsync(outputBuffer);
  assert.ok(outputZip.file("xl/worksheets/sheet1.xml"), "the original worksheet part is retained");
  assert.equal(outputZip.file("xl/worksheets/sheet2.xml"), null, "the export retains the template worksheet part");
  const outputWorksheetXml = await outputZip.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(outputWorksheetXml, /xmlns:xr="http:\/\/schemas\.microsoft\.com\/office\/spreadsheetml\/2014\/revision"/);
  assert.match(outputWorksheetXml, /xr:uid=/);
  assert.equal(outputWorksheetXml.match(/<dataValidation\b/g)?.length, templateWorksheetXml.match(/<dataValidation\b/g)?.length);
  assert.match((await outputZip.file("xl/_rels/workbook.xml.rels").async("string")), /Target="worksheets\/sheet1\.xml"/);
  await outputWorkbook.xlsx.load(outputBuffer);
  assert.deepEqual(outputWorkbook.worksheets.map((sheet) => sheet.name), ["TERM 2"]);
  const outputSheet = outputWorkbook.getWorksheet("TERM 2");
  assert.equal(outputSheet.rowCount, 142, "signature rows are added when they are absent from the source template");
  assert.equal(outputSheet.columnCount, templateSheet.columnCount);
  const expectedMerges = templateSheet.model.merges.map((merge) =>
    merge === "C80:E80" ? "B80:AD80" : merge);
  assert.deepEqual([...outputSheet.model.merges].sort(), [...expectedMerges].sort());
  assert.equal(outputSheet.pageSetup.orientation, templateSheet.pageSetup.orientation);
  assert.equal(outputSheet.pageSetup.printArea, templateSheet.pageSetup.printArea);
  assert.equal(outputSheet.pageSetup.scale, templateSheet.pageSetup.scale);
  assert.deepEqual(outputSheet.pageSetup.margins, templateSheet.pageSetup.margins);
  for (const address of ["B2", "B17", "C18", "F18", "AB18", "B78", "C79", "AD79"]) {
    assert.deepEqual(outputSheet.getCell(address).style, templateSheet.getCell(address).style, `${address} keeps its template formatting`);
  }
  assert.deepEqual(outputSheet.getCell("B80").style, templateSheet.getCell("B78").style);
  assert.deepEqual(outputSheet.getCell("F80").style, templateSheet.getCell("F78").style);
  assert.equal(outputSheet.getCell("B2").value, "CLASS RECORD - TERM 2");
  assert.equal(outputSheet.getCell("F5").value, "Region IX");
  assert.equal(outputSheet.getCell("R5").value, "Zamboanga City");
  assert.equal(outputSheet.getCell("Z5").value, "123456");
  assert.equal(outputSheet.getCell("F7").value, "Sample Elementary School");
  assert.equal(outputSheet.getCell("Z7").value, "2026-2027");
  assert.equal(outputSheet.getCell("J10").value, "Grade 5");
  assert.equal(outputSheet.getCell("J11").value, "Mabini");
  assert.equal(outputSheet.getCell("Q10").value, "E-Class Export Teacher");
  assert.equal(outputSheet.getCell("AA10").value, "MAPEH - Music and Arts");
  assert.equal(outputSheet.getCell("F15").value, 10);
  assert.equal(outputSheet.getCell("M15").value, 0.2);
  assert.equal(outputSheet.getCell("B17").value, "MALE");
  assert.equal(outputSheet.getCell("C18").value, "Learner, Jordan");
  assert.equal(outputSheet.getCell("F18").value, 8);
  assert.equal(outputSheet.getCell("K18").value, 8);
  assert.equal(outputSheet.getCell("L18").value, 100);
  assert.equal(outputSheet.getCell("M18").value, 0.2);
  assert.equal(outputSheet.getCell("N18").value, 9);
  assert.equal(outputSheet.getCell("Q18").value, 9);
  assert.equal(outputSheet.getCell("AB18").value, 85);
  assert.equal(outputSheet.getCell("AC18").value, 85);
  assert.equal(outputSheet.getCell("AD18").value, "Very Satisfactory");
  assert.equal(outputSheet.getCell("M141").value, "E-Class Export Teacher");
  assert.equal(outputSheet.getCell("M142").value, "Teacher I");
  assert.equal(outputSheet.getCell("Y141").value, "Alex Principal");
  assert.equal(outputSheet.getCell("Y142").value, "Principal II");
  assert.equal(outputSheet.getCell("B78").value, "FEMALE");
  assert.equal(outputSheet.getCell("C79").value, "Learner, Riley");
  assert.equal(outputSheet.getCell("F79").value, 9);
  assert.equal(outputSheet.getCell("AC79").value, 88, "a saved term grade fills an empty browser-side grade cell");
  assert.equal(outputSheet.getCell("AD79").value, "Benchmarking", "the grade descriptor is restored with the saved grade");
  assert.equal(outputSheet.getCell("B80").value, "OTHER");
  assert.equal(outputSheet.getCell("C81").value, "Learner, Casey");
  assert.equal(outputSheet.getCell("F81").value, 7);
  assert.equal(outputSheet.getImages().length, 2, "the source workbook images are preserved");
  assert.ok(outputSheet.model.merges.includes("B2:AD3"), "the source template's merged title is preserved");

  const excelCompatibleWorkbook = XLSX.read(outputBuffer, { type: "buffer" });
  const excelCompatibleSheet = excelCompatibleWorkbook.Sheets["TERM 2"];
  assert.equal(excelCompatibleSheet.C18.v, "Learner, Jordan");
  assert.equal(excelCompatibleSheet.F18.v, 8);
  assert.equal(excelCompatibleSheet.AC79.v, 88);
  assert.equal(excelCompatibleSheet.C81.v, "Learner, Casey");
});

test("section selection is applied across learner lists and summaries", async () => {
  const portalPage = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");
  const serverSource = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");
  const helperSource = portalPage.match(
    /function filterStudentsForActiveSection\(students,sectionFilter\)\{[\s\S]*?\n  \}/,
  );
  const serverHelperStart = serverSource.indexOf("function matchesStudentSection");
  const serverHelperEnd = serverSource.indexOf("function findTeacherClassRow", serverHelperStart);
  const serverHelperSource = serverHelperStart < 0 || serverHelperEnd < 0
    ? ""
    : serverSource.slice(serverHelperStart, serverHelperEnd).trim();
  assert.ok(helperSource, "shared section-filter helper exists");
  assert.ok(serverHelperSource, "shared export section-filter helper exists");
  assert.match(portalPage, /id="selectStudentSection"[^>]*>Apply Section<\/button>/);
  assert.match(portalPage, /class="section-switcher"[\s\S]*?id="studentSectionFilter"[\s\S]*?id="selectStudentSection"/);
  assert.match(portalPage, /class="roster-actions"[\s\S]*?id="addNewSection"[\s\S]*?id="clearStudentRoster"[\s\S]*?id="addStudent"/);
  assert.doesNotMatch(portalPage, /filter\.add\(new Option\("All sections","__all__"\)\)/);
  assert.match(portalPage, /filterStudentsForActiveSection\(students,section\)\.length/);
  assert.match(portalPage, /section:clearRosterSection/);
  assert.match(portalPage, /handledSections=result\.sectionsHandled;[\s\S]*?populateSectionControls\(activeStudentSection\)/);
  assert.match(portalPage, /button\.textContent=studentSectionLocked\?"Change Section":"Apply Section"/);
  assert.match(portalPage, /activeStudentSection=pendingStudentSection;[\s\S]*?studentSectionLocked=true/);
  assert.match(portalPage, /function renderReadingProgress\(result\)\{[\s\S]*?filterStudentsForActiveSection\(result\.students\)/);
  assert.match(portalPage, /function renderRmaReport\(\)\{[\s\S]*?filterStudentsForActiveSection\(rmaData\.students\)/);
  assert.match(portalPage, /function renderPhilIriClassReport\(\)\{[\s\S]*?filterStudentsForActiveSection\(philIriData\.students\)/);
  assert.match(portalPage, /attendanceData\?attendanceData\.students:result\.students/);
  assert.match(serverSource, /exportAttendanceSF2\([\s\S]*?url\.searchParams\.get\("section"\)/);
  assert.match(serverSource, /exportNutritionalStatusSF8\([\s\S]*?url\.searchParams\.get\("section"\)/);
  assert.match(serverSource, /exportMathAssessment\([\s\S]*?url\.searchParams\.get\("section"\)/);
  assert.match(serverSource, /exportGradeSummary\([\s\S]*?url\.searchParams\.get\("section"\)/);
  assert.match(serverSource, /exportPhilIriReport\([\s\S]*?url\.searchParams\.get\("section"\)/);
  assert.match(serverSource, /exportPhilIriForm\([\s\S]*?url\.searchParams\.get\("section"\)/);
  assert.match(portalPage, /id="philIriDownloadReport"[\s\S]*?data-philiri-form="1A"[\s\S]*?data-philiri-form="1B"/);
  assert.match(portalPage, /fetch\("\/api\/phil-iri\/forms\?"/);

  const filter = vm.runInNewContext(`(${helperSource[0]})`, {
    activeStudentSection: "Section A",
    rosterStudents: [
      { id: "learner-a", section: "Section A" },
      { id: "learner-b", section: "Section B" },
      { id: "learner-unassigned", section: "" },
    ],
  });
  assert.deepEqual(Array.from(filter([
    { id: "learner-a" },
    { id: "learner-b" },
    { id: "not-in-roster" },
  ])), [{ id: "learner-a" }]);
  assert.deepEqual(Array.from(filter([
    { id: "learner-a" },
    { id: "learner-b" },
  ], "Section B")), [{ id: "learner-b" }]);

  const unassignedFilter = vm.runInNewContext(`(${helperSource[0]})`, {
    activeStudentSection: "__unassigned__",
    rosterStudents: [{ id: "learner-unassigned", section: "" }],
  });
  assert.deepEqual(Array.from(unassignedFilter([{ id: "learner-unassigned" }])), [
    { id: "learner-unassigned" },
  ]);
  const matchesSection = vm.runInNewContext(`${serverHelperSource}; matchesStudentSection`, {
    cellText: (value) => value === null || value === undefined ? "" : String(value),
  });
  assert.equal(matchesSection({ section: "Section A" }, "Section A"), true);
  assert.equal(matchesSection({ section: "Section B" }, "Section A"), false);
  assert.equal(matchesSection({ section: "" }, "__unassigned__"), true);
});

test("clearing a selected student section preserves students in other sections", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "section-roster-clear-"));
  const databasePath = path.join(directory, "database.sqlite");
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  await createEmptyTestWorkbook(migrationWorkbookPath);
  const server = createServer({ databasePath, migrationWorkbookPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  context.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const password = "section-clear-password";
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Section Clear Teacher",
      email: "section.clear.teacher@example.com",
      password,
      role: "teacher",
      extra: "12",
      grade: "Grade 5",
    }),
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get("set-cookie").split(";")[0];
  const addSection = await fetch(`${baseUrl}/api/teacher/sections`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ sectionName: "Section B", grade: "Grade 5" }),
  });
  assert.equal(addSection.status, 201);
  const addTargetSection = await fetch(`${baseUrl}/api/teacher/sections`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ sectionName: "Section C", grade: "Grade 5" }),
  });
  assert.equal(addTargetSection.status, 201);
  const addFinalSection = await fetch(`${baseUrl}/api/teacher/sections`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ sectionName: "Section D", grade: "Grade 5" }),
  });
  assert.equal(addFinalSection.status, 201);
  const setPrimarySection = await fetch(`${baseUrl}/api/teacher/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      name: "Section Clear Teacher",
      email: "section.clear.teacher@example.com",
      classroomNumber: "12",
      section: "Section B",
      sectionsHandled: ["Section B", "Section C", "Section D"],
    }),
  });
  assert.equal(setPrimarySection.status, 200);
  const rosterResponse = await fetch(`${baseUrl}/api/students`, { headers: { Cookie: cookie } });
  const roster = await rosterResponse.json();
  const primarySection = "Section B";
  assert.ok(primarySection);

  const addStudent = (lrn, section) => fetch(`${baseUrl}/api/students`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      firstName: `Learner${lrn.slice(-1)}`,
      lastName: "Section",
      lrn,
      gender: "Female",
      birthdate: "2016-01-15",
      section,
    }),
  });
  const primaryStudentResponse = await addStudent("123456789021", primarySection);
  assert.equal(primaryStudentResponse.status, 201);
  const primaryStudent = await primaryStudentResponse.json();
  const sectionStudentResponse = await addStudent("123456789022", "Section C");
  assert.equal(sectionStudentResponse.status, 201);
  const secondSectionStudentResponse = await addStudent("123456789023", "Section B");
  assert.equal(secondSectionStudentResponse.status, 201);
  const finalSectionStudentResponse = await addStudent("123456789024", "Section D");
  assert.equal(finalSectionStudentResponse.status, 201);

  const invalidSectionClear = await fetch(`${baseUrl}/api/students/clear`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ password, confirmed: true, section: "Other Section" }),
  });
  assert.equal(invalidSectionClear.status, 400);
  const missingScopeClear = await fetch(`${baseUrl}/api/students/clear`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ password, confirmed: true }),
  });
  assert.equal(missingScopeClear.status, 400);
  const rosterAfterMissingScope = await fetch(`${baseUrl}/api/students`, { headers: { Cookie: cookie } });
  assert.equal((await rosterAfterMissingScope.json()).students.length, 4);

  const clearSection = await fetch(`${baseUrl}/api/students/clear`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ password, confirmed: true, section: "section c" }),
  });
  assert.equal(clearSection.status, 200);
  const clearSectionResult = await clearSection.json();
  assert.equal(clearSectionResult.deleted, 1);
  assert.equal(clearSectionResult.removedSection, true);
  assert.ok(!clearSectionResult.sectionsHandled.some((section) => section.toLowerCase() === "section c"));
  assert.ok(!Object.keys(clearSectionResult.sectionGrades).some((section) => section.toLowerCase() === "section c"));
  assert.ok(!Object.keys(clearSectionResult.sectionSubjects).some((section) => section.toLowerCase() === "section c"));
  const remainingRoster = await fetch(`${baseUrl}/api/students`, { headers: { Cookie: cookie } });
  const remainingRosterResult = await remainingRoster.json();
  const remainingStudents = remainingRosterResult.students;
  assert.deepEqual(new Set(remainingStudents.map(({ id }) => id)), new Set([
    primaryStudent.student.id,
    (await secondSectionStudentResponse.json()).student.id,
    (await finalSectionStudentResponse.json()).student.id,
  ]));
  assert.ok(!remainingRosterResult.sectionsHandled.some((section) => section.toLowerCase() === "section c"));
  const profileAfterSectionDeletion = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: cookie },
  });
  const updatedProfile = await profileAfterSectionDeletion.json();
  assert.ok(!updatedProfile.sectionsHandled.some((section) => section.toLowerCase() === "section c"));
  assert.ok(!Object.keys(updatedProfile.sectionGrades).some((section) => section.toLowerCase() === "section c"));

  const clearPrimarySection = await fetch(`${baseUrl}/api/students/clear`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ password, confirmed: true, section: primarySection }),
  });
  assert.equal(clearPrimarySection.status, 200);
  const clearPrimarySectionResult = await clearPrimarySection.json();
  assert.equal(clearPrimarySectionResult.deleted, 2);
  assert.equal(clearPrimarySectionResult.removedSection, true);
  assert.equal(clearPrimarySectionResult.primarySection, "");
  assert.ok(!clearPrimarySectionResult.sectionsHandled.some((section) =>
    section.toLowerCase() === primarySection.toLowerCase()));

  const clearRemainingRoster = await fetch(`${baseUrl}/api/students/clear`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ password, confirmed: true, section: "__all__" }),
  });
  assert.equal(clearRemainingRoster.status, 200);
  assert.equal((await clearRemainingRoster.json()).deleted, 1);
  const finalRosterResponse = await fetch(`${baseUrl}/api/students`, { headers: { Cookie: cookie } });
  const finalRoster = await finalRosterResponse.json();
  assert.deepEqual(finalRoster.students, []);
  assert.deepEqual(finalRoster.sectionsHandled, []);
  assert.deepEqual(finalRoster.sectionGrades, {});
  const emptyClassProfileResponse = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: cookie },
  });
  const emptyClassProfile = await emptyClassProfileResponse.json();
  assert.deepEqual(emptyClassProfile.sectionsHandled, []);
  assert.deepEqual(emptyClassProfile.sectionGrades, {});
  const emptyClassSubjectsResponse = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    headers: { Cookie: cookie },
  });
  const emptyClassSubjects = await emptyClassSubjectsResponse.json();
  assert.deepEqual(emptyClassSubjects.sectionSubjects, {});

  const recreateSection = await fetch(`${baseUrl}/api/teacher/sections`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ sectionName: "FUENTES", grade: "Grade 5" }),
  });
  assert.equal(recreateSection.status, 201);
  const recreatedSection = await recreateSection.json();
  assert.deepEqual(recreatedSection.sectionsHandled, ["FUENTES"]);
  assert.deepEqual(recreatedSection.sectionGrades, { FUENTES: "Grade 5" });
});

test("teacher profile marks the assigned advisory grade and section as read-only", async () => {
  const portalPage = await fs.readFile(path.join(__dirname, "..", "index.html"), "utf8");
  const serverSource = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");

  assert.match(portalPage, /<label for="teacherProfileGrade">Grade <span class="advisory-field-badge">View only<\/span><\/label><input id="teacherProfileGrade"[^>]*readonly/);
  assert.match(portalPage, /<label for="teacherProfileSection">Advisory section <span class="advisory-field-badge">Locked<\/span><\/label><input id="teacherProfileSection"[^>]*readonly/);
  assert.match(portalPage, /id="teacherProfileSectionHint">This is the advisory section assigned to your classroom\./);
  assert.doesNotMatch(portalPage, /grade:\$\("teacherProfileGrade"\)\.value|section:\$\("teacherProfileSection"\)\.value/);
  assert.match(portalPage, /id="teacherProfileSubjectsHandled" role="group" aria-labelledby="teacherProfileSubjectsHandledLabel"/);
  assert.match(portalPage, /function renderTeacherSubjectChoices\(subjects,selectedSubjects\)/);
  assert.match(portalPage, /function getCheckedTeacherSubjects\(\)/);
  assert.match(portalPage, /id="toggleTeacherSubjects"[^>]*>Add Subjects<\/button>/);
  assert.match(portalPage, /checkbox\.disabled=teacherSubjectsLocked/);
  assert.match(portalPage, /api\("\/api\/teacher\/profile\/subjects"/);
  assert.doesNotMatch(portalPage, /<textarea[^>]*id="teacherProfileSubjectsHandled"/);
  assert.match(portalPage, /section:teacherSubjectSection,subjectsHandled:getCheckedTeacherSubjects\(\)/);
  assert.match(portalPage, /id="teacherSubjectSection" aria-label="Choose section for subject selections"/);
  assert.match(portalPage, /\.form-field \.teacher-subject-option\{[^}]*margin:0/);
  assert.match(portalPage, /\.teacher-subject-options\{grid-template-columns:1fr\}/);
  assert.match(serverSource, /const GRADE_1_SUBJECTS = \[\s*\["language", "Language"\],\s*\["readingAndLiteracy", "Reading and Literacy"\],\s*\["mathematics", "Mathematics"\],\s*\["makabansa", "Makabansa"\],\s*\["gmrc", "GMRC \(Good Manners and Right Conduct\)"\]/);
  assert.match(serverSource, /const GRADE_2_SUBJECTS = \[\s*\["english", "English"\],\s*\["literacy", "Literacy"\]/);
  assert.match(serverSource, /const GRADE_7_10_SUBJECTS = \[[\s\S]*?\["tle", "TLE"\]/);
  assert.match(serverSource, /const SHS_CORE_SUBJECTS = \[/);
  assert.match(serverSource, /const SHS_STRAND_SUBJECTS = \{[\s\S]*?STEM:[\s\S]*?ABM:[\s\S]*?HUMSS:[\s\S]*?GAS:/);
  assert.equal((serverSource.match(/teacherSubjectsForGrade\(grade, strand\)/g) || []).length >= 3, true);
  assert.match(serverSource, /const GRADE_3_SUBJECTS = \[\s*\["english", "English"\],\s*\["filipino", "Filipino"\],\s*\["mathematics", "Mathematics"\],\s*\["science", "Science"\],\s*\["makabansa", "Makabansa"\],\s*\["gmrc", "GMRC"\]/);
  assert.match(portalPage, /function configureGradeSubjects\(subjects\)/);
  assert.match(portalPage, /function configureEClassSubjects\(subjects,gradeSubjectDefinitions\)/);
  assert.match(serverSource, /gradeSubjectDefinitions\.find\(\(\[, label\]\)/);
  assert.match(portalPage, /data-grade-subject="makabansa"/);
  assert.match(portalPage, /"english":"English Language Reading and Literacy"/);
  assert.match(portalPage, /"gmrc\/values education":"Good Manners and Right Conduct \(GMRC\)"/);
  assert.match(portalPage, /"epp \/ tle":"Edukasyong Pantahanan at Pangkabuhayan \(EPP\)"/);
  assert.match(portalPage, /"physical education and health":"Physical Education and Health \(PEH\)"/);
  assert.match(portalPage, /id="teacherStrandWrap" hidden/);
  assert.match(portalPage, /<option value="Arts and Design">Arts and Design<\/option>/);
  assert.match(portalPage, /strand:strand/);
  assert.match(portalPage, /function ensureGradeSubjectInput\(subject\)/);
});

test("registered grade and strand determine all subject lists", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "curriculum-subjects-"));
  const databasePath = path.join(directory, "database.sqlite");
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  await createEmptyTestWorkbook(migrationWorkbookPath);
  const server = createServer({ databasePath, migrationWorkbookPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const missingStrand = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Missing Strand Teacher",
      email: "missing.strand@example.com",
      password: "secure-pass-123",
      role: "teacher",
      extra: "missing-strand",
      grade: "Grade 11",
    }),
  });
  assert.equal(missingStrand.status, 400);
  assert.match((await missingStrand.json()).error, /strand/i);

  const cases = [
    { grade: "Grade 1", subjects: ["Language", "Reading and Literacy", "Mathematics", "Makabansa", "GMRC (Good Manners and Right Conduct)"] },
    { grade: "Grade 2", subjects: ["English", "Literacy", "Mathematics", "Makabansa", "GMRC"] },
    { grade: "Grade 3", subjects: ["English", "Filipino", "Mathematics", "Science", "Makabansa", "GMRC"] },
    { grade: "Grade 4", subjects: ["English", "Filipino", "Mathematics", "Science", "Araling Panlipunan", "EPP", "MAPEH", "GMRC"] },
    { grade: "Grade 5", subjects: ["English", "Filipino", "Mathematics", "Science", "Araling Panlipunan", "EPP", "MAPEH", "GMRC"] },
    { grade: "Grade 6", subjects: ["English", "Filipino", "Mathematics", "Science", "Araling Panlipunan", "TLE", "MAPEH", "GMRC"] },
    { grade: "Grade 7", subjects: ["English", "Filipino", "Mathematics", "Science", "Araling Panlipunan", "MAPEH", "TLE", "Values Education / GMRC"] },
    { grade: "Grade 8", subjects: ["English", "Filipino", "Mathematics", "Science", "Araling Panlipunan", "MAPEH", "TLE", "Values Education / GMRC"] },
    { grade: "Grade 9", subjects: ["English", "Filipino", "Mathematics", "Science", "Araling Panlipunan", "MAPEH", "TLE", "Values Education / GMRC"] },
    { grade: "Grade 10", subjects: ["English", "Filipino", "Mathematics", "Science", "Araling Panlipunan", "MAPEH", "TLE", "Values Education / GMRC"] },
    {
      grade: "Grade 11",
      strand: "STEM",
      includes: ["Oral Communication", "General Mathematics", "Pre-Calculus", "General Biology 1"],
      excludes: ["Business Finance", "Creative Writing"],
    },
    {
      grade: "Grade 12",
      strand: "ABM",
      includes: ["Oral Communication", "Business Finance", "Principles of Marketing"],
      excludes: ["Pre-Calculus", "Creative Writing"],
    },
    {
      grade: "Grade 11",
      strand: "TVL",
      includes: ["Oral Communication", "Empowerment Technologies"],
      excludes: ["Pre-Calculus", "Business Finance"],
    },
  ];
  for (const [index, testCase] of cases.entries()) {
    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `Curriculum Teacher ${index + 1}`,
        email: `curriculum${index + 1}@example.com`,
        password: "secure-pass-123",
        role: "teacher",
        extra: `curriculum-${index + 1}`,
        grade: testCase.grade,
        strand: testCase.strand || "",
      }),
    });
    assert.equal(registration.status, 201, testCase.grade);
    const cookie = registration.headers.get("set-cookie").split(";")[0];
    const profileResponse = await fetch(`${baseUrl}/api/teacher/profile`, { headers: { Cookie: cookie } });
    assert.equal(profileResponse.status, 200);
    const profile = await profileResponse.json();
    assert.equal(profile.grade, testCase.grade);
    assert.equal(profile.strand || "", testCase.strand || "");
    if (testCase.subjects) assert.deepEqual(profile.availableSubjects, testCase.subjects);
    for (const subject of testCase.includes || []) assert.ok(profile.availableSubjects.includes(subject), subject);
    for (const subject of testCase.excludes || []) assert.ok(!profile.availableSubjects.includes(subject), subject);
    assert.deepEqual(profile.eClassSubjects, profile.gradeSubjects.flatMap(({ key, label }) =>
      key === "musicAndArts" ? ["MAPEH"]
        : key === "physicalEducationAndHealth"
          ? profile.gradeSubjects.some((subject) => subject.key === "musicAndArts") ? [] : [label]
          : [label]));
  }
});

test("Grade 3 accounts are limited to the six specified subjects", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grade3-subjects-"));
  const databasePath = path.join(directory, "database.sqlite");
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  await createEmptyTestWorkbook(migrationWorkbookPath);
  const server = createServer({ databasePath, migrationWorkbookPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Grade Three Teacher",
      email: "grade.three@example.com",
      password: "secure-pass-123",
      role: "teacher",
      extra: "3",
      grade: "Grade 3",
    }),
  });
  assert.equal(registration.status, 201);
  const cookie = registration.headers.get("set-cookie").split(";")[0];
  const setupProfile = await fetch(`${baseUrl}/api/teacher/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      name: "Grade Three Teacher",
      email: "grade.three@example.com",
      classroomNumber: "3",
      section: "Grade 3 Section",
      sectionsHandled: ["Grade 3 Section"],
    }),
  });
  assert.equal(setupProfile.status, 200);
  const profileResponse = await fetch(`${baseUrl}/api/teacher/profile`, { headers: { Cookie: cookie } });
  assert.equal(profileResponse.status, 200);
  const profile = await profileResponse.json();
  assert.equal(profile.grade, "Grade 3");
  assert.deepEqual(profile.availableSubjects, [
    "English", "Filipino", "Mathematics", "Science", "Makabansa", "GMRC",
  ]);
  assert.deepEqual(profile.gradeSubjects.map(({ key, label }) => [key, label]), [
    ["english", "English"], ["filipino", "Filipino"], ["mathematics", "Mathematics"],
    ["science", "Science"], ["makabansa", "Makabansa"], ["gmrc", "GMRC"],
  ]);
  assert.deepEqual(profile.eClassSubjects, profile.availableSubjects);

  const subjectProfileResponse = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    headers: { Cookie: cookie },
  });
  const subjectProfile = await subjectProfileResponse.json();
  assert.deepEqual(subjectProfile.availableSubjects, profile.availableSubjects);
  const invalidSave = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ section: subjectProfile.advisorySection, subjectsHandled: ["Araling Panlipunan (AP)"] }),
  });
  assert.equal(invalidSave.status, 400);
  const invalidProfileSubjects = await fetch(`${baseUrl}/api/teacher/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      name: profile.name,
      email: profile.email,
      classroomNumber: profile.classroomNumber,
      subjectsHandled: ["Araling Panlipunan (AP)"],
    }),
  });
  assert.equal(invalidProfileSubjects.status, 400);
  const validSave = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      section: subjectProfile.advisorySection,
      subjectsHandled: profile.availableSubjects,
    }),
  });
  assert.equal(validSave.status, 200);
  assert.deepEqual((await validSave.json()).subjectsHandled, profile.availableSubjects);
  const invalidGradeSave = await fetch(`${baseUrl}/api/grades/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      studentId: "not-in-roster",
      term: "Term 1",
      subject: "aralingPanlipunan",
      grade: 80,
    }),
  });
  assert.equal(invalidGradeSave.status, 400);
  const invalidEClassExport = await fetch(`${baseUrl}/api/e-class/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      term: "Term 1",
      subject: "MAPEH",
      mapehGroup: "Music and Arts",
      section: "__all__",
      students: [{ id: "student-1", values: Array(25).fill("") }],
      highestScores: Array(22).fill(""),
    }),
  });
  assert.equal(invalidEClassExport.status, 400);
  assert.match((await invalidEClassExport.json()).error, /subject available for this grade level/);

  const studentResponse = await fetch(`${baseUrl}/api/students`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      firstName: "Grade",
      lastName: "Three Learner",
      gender: "Male",
      lrn: "123456789012",
      birthdate: "2017-01-15",
    }),
  });
  assert.equal(studentResponse.status, 201);
  const student = (await studentResponse.json()).student;
  const makabansaGradeSave = await fetch(`${baseUrl}/api/grades/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      studentId: student.id,
      term: "Term 1",
      subject: "makabansa",
      grade: 88,
    }),
  });
  assert.equal(makabansaGradeSave.status, 200);

  const gradeSummaryResponse = await fetch(`${baseUrl}/api/grades/summary`, { headers: { Cookie: cookie } });
  assert.equal(gradeSummaryResponse.status, 200);
  const gradeSummary = await gradeSummaryResponse.json();
  assert.deepEqual(gradeSummary.subjects.map(({ label }) => label), profile.availableSubjects);
  assert.deepEqual(gradeSummary.generalAverageSubjects, ["english", "filipino", "mathematics", "science", "makabansa", "gmrc"]);
  assert.equal(gradeSummary.students[0].grades["Term 1"].makabansa, 88);
  const gradeSummaryExport = await fetch(`${baseUrl}/api/grades/summary/export?section=__all__`, {
    headers: { Cookie: cookie },
  });
  assert.equal(gradeSummaryExport.status, 200);
  const exportWorkbook = new ExcelJS.Workbook();
  await exportWorkbook.xlsx.load(Buffer.from(await gradeSummaryExport.arrayBuffer()));
  const exportSheet = exportWorkbook.getWorksheet("SUMMARY - FINAL GRADES");
  assert.equal(exportSheet.getCell("F7").value, "ENGLISH");
  assert.equal(exportSheet.getCell("V7").value, "MAKABANSA");
  assert.equal(exportSheet.getCell("Z7").value, "GMRC");
  assert.equal(exportSheet.getColumn(30).hidden, true);
});

test("teachers can save and lock their handled subjects", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "teacher-subjects-"));
  const databasePath = path.join(directory, "database.sqlite");
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  await createEmptyTestWorkbook(migrationWorkbookPath);
  const server = createServer({ databasePath, migrationWorkbookPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Subject Selection Teacher",
      email: "subject.selection@example.com",
      password: "secure-pass-123",
      role: "teacher",
      extra: "12",
      grade: "Grade 5",
    }),
  });
  assert.equal(registration.status, 201);
  const teacherCookie = registration.headers.get("set-cookie").split(";")[0];
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "subject.selection@example.com",
      password: "secure-pass-123",
      role: "teacher",
    }),
  });
  assert.equal(loginResponse.status, 200);
  assert.equal((await loginResponse.json()).user.role, "teacher");
  const loginCookie = loginResponse.headers.get("set-cookie").split(";")[0];
  const loginSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: loginCookie },
  });
  assert.equal(loginSessionResponse.status, 200);

  const initialProfileResponse = await fetch(`${baseUrl}/api/teacher/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      name: "Subject Selection Teacher",
      email: "subject.selection@example.com",
      classroomNumber: "12",
      section: "Advisory Section",
      sectionsHandled: ["Advisory Section"],
    }),
  });
  assert.equal(initialProfileResponse.status, 200);

  const subjectProfileResponse = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(subjectProfileResponse.status, 200);
  const subjectProfile = await subjectProfileResponse.json();
  const advisorySection = subjectProfile.advisorySection;
  assert.equal(subjectProfile.availableSubjects.length, 8);
  assert.deepEqual(subjectProfile.availableSubjects, [
    "English", "Filipino", "Mathematics", "Science", "Araling Panlipunan",
    "EPP", "MAPEH", "GMRC",
  ]);
  assert.ok(subjectProfile.sectionsHandled.includes(advisorySection));

  const saveResponse = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ section: advisorySection, subjectsHandled: ["English", "Mathematics"] }),
  });
  assert.equal(saveResponse.status, 200);
  const savedSubjects = await saveResponse.json();
  assert.equal(savedSubjects.section, advisorySection);
  assert.deepEqual(savedSubjects.subjectsHandled, ["English", "Mathematics"]);

  const addSectionResponse = await fetch(`${baseUrl}/api/teacher/sections`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ sectionName: "Second Section", grade: "Grade 5" }),
  });
  assert.equal(addSectionResponse.status, 201);
  const saveSecondSectionResponse = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ section: "Second Section", subjectsHandled: ["Science"] }),
  });
  assert.equal(saveSecondSectionResponse.status, 200);
  const subjectsAfterSecondSave = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    headers: { Cookie: teacherCookie },
  });
  assert.deepEqual((await subjectsAfterSecondSave.json()).sectionSubjects, {
    [advisorySection]: ["English", "Mathematics"],
    "Second Section": ["Science"],
  });

  const saveProfileResponse = await fetch(`${baseUrl}/api/teacher/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      name: "Subject Selection Teacher",
      email: "subject.selection@example.com",
      classroomNumber: "12",
      sectionsHandled: [advisorySection, "Second Section"],
      subjectsHandled: ["Filipino"],
    }),
  });
  assert.equal(saveProfileResponse.status, 200);
  const subjectsAfterProfileSave = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    headers: { Cookie: teacherCookie },
  });
  assert.deepEqual((await subjectsAfterProfileSave.json()).sectionSubjects, {
    [advisorySection]: ["Filipino"],
    "Second Section": ["Science"],
  });

  const profileResponse = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: teacherCookie },
  });
  assert.deepEqual((await profileResponse.json()).subjectsHandled, ["Filipino"]);

  const invalidSaveResponse = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ section: advisorySection, subjectsHandled: ["Mathematics", 5] }),
  });
  assert.equal(invalidSaveResponse.status, 400);
});

test("term grades unlock once for the class and can be locked again", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grade-lock-password-"));
  const databasePath = path.join(directory, "database.sqlite");
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  await createEmptyTestWorkbook(migrationWorkbookPath);
  let server = createServer({ databasePath, migrationWorkbookPath });
  const startServer = async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stopServer = async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  let baseUrl = await startServer();
  context.after(async () => {
    if (server.listening) {
      await stopServer();
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const teacherPassword = "secure-pass-123";
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Grade Lock Teacher",
      email: "grade.lock.teacher@example.com",
      password: teacherPassword,
      role: "teacher",
      extra: "12",
      grade: "Grade 5",
    }),
  });
  assert.equal(registration.status, 201);
  let teacherCookie = registration.headers.get("set-cookie").split(";")[0];
  const addedStudentResponse = await fetch(`${baseUrl}/api/students`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      firstName: "Jordan",
      lastName: "Learner",
      lrn: "123456789012",
      gender: "Male",
      birthdate: "2016-01-15",
    }),
  });
  assert.equal(addedStudentResponse.status, 201);
  const studentId = (await addedStudentResponse.json()).student.id;
  const secondStudentResponse = await fetch(`${baseUrl}/api/students`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      firstName: "Riley",
      lastName: "Learner",
      lrn: "123456789013",
      gender: "Female",
      birthdate: "2016-02-15",
    }),
  });
  assert.equal(secondStudentResponse.status, 201);
  const secondStudentId = (await secondStudentResponse.json()).student.id;
  const lockUrl = `${baseUrl}/api/grades/lock?studentId=${encodeURIComponent(studentId)}&term=Term%201`;
  const secondLockUrl = `${baseUrl}/api/grades/lock?studentId=${encodeURIComponent(secondStudentId)}&term=Term%201`;
  const termLockUrl = `${baseUrl}/api/grades/term-lock?term=Term%201`;
  const initialLockResponse = await fetch(lockUrl, { headers: { Cookie: teacherCookie } });
  assert.equal(initialLockResponse.status, 200);
  assert.equal((await initialLockResponse.json()).locked, true);
  assert.deepEqual(await (await fetch(termLockUrl, { headers: { Cookie: teacherCookie } })).json(), {
    term: "Term 1",
    locked: true,
    studentCount: 2,
  });

  const grades = { filipino: "85", english: "78" };
  const expectedTeacherComment = "A thoughtful note for this learner.";
  const saveGrades = (student, teacherComment) => fetch(`${baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: student,
      term: "Term 1",
      grades,
      ...(teacherComment === undefined ? {} : { teacherComment }),
    }),
  });
  assert.equal((await saveGrades(studentId)).status, 409);

  const changeTermLock = (locked, password) => fetch(`${baseUrl}/api/grades/term-lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ term: "Term 1", locked, password }),
  });
  assert.equal((await changeTermLock(false, "")).status, 400);
  assert.equal((await changeTermLock(false, "incorrect-password")).status, 400);
  const unlockResponse = await changeTermLock(false, teacherPassword);
  assert.equal(unlockResponse.status, 200);
  assert.deepEqual(await unlockResponse.json(), { term: "Term 1", locked: false, studentCount: 2 });
  assert.equal((await (await fetch(lockUrl, { headers: { Cookie: teacherCookie } })).json()).locked, false);
  assert.equal((await (await fetch(secondLockUrl, { headers: { Cookie: teacherCookie } })).json()).locked, false);
  assert.equal((await (await fetch(termLockUrl, { headers: { Cookie: teacherCookie } })).json()).locked, false);

  const invalidCommentSave = await saveGrades(studentId, "x".repeat(1001));
  assert.equal(invalidCommentSave.status, 400);
  assert.match((await invalidCommentSave.json()).error, /1,000 characters or fewer/);
  const initialEClassGrade = await fetch(`${baseUrl}/api/grades/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ studentId, term: "Term 1", subject: "filipino", grade: 86 }),
  });
  assert.equal(initialEClassGrade.status, 200);
  const commentSave = await saveGrades(studentId, "A thoughtful note\u0001 for this learner.");
  assert.equal(commentSave.status, 200);
  assert.equal((await commentSave.json()).teacherComment, expectedTeacherComment);
  assert.equal((await saveGrades(secondStudentId)).status, 200);
  const eClassSubjectGrades = await fetch(
    `${baseUrl}/api/grades?studentId=${encodeURIComponent(studentId)}&term=Term%201`,
    { headers: { Cookie: teacherCookie } },
  );
  const eClassSubjectRecord = await eClassSubjectGrades.json();
  assert.equal(eClassSubjectRecord.grades.filipino, "86", "manual saves cannot overwrite E-Class-generated grades");
  assert.deepEqual(eClassSubjectRecord.eClassSubjects, ["filipino"]);
  assert.equal(eClassSubjectRecord.grades.english, "78", "non-E-Class subjects remain editable");
  assert.equal(eClassSubjectRecord.teacherComment, expectedTeacherComment);
  assert.equal((await saveGrades(studentId)).status, 200, "saving grades without a comment preserves the existing comment");
  const preservedCommentRecord = await (await fetch(
    `${baseUrl}/api/grades?studentId=${encodeURIComponent(studentId)}&term=Term%201`,
    { headers: { Cookie: teacherCookie } },
  )).json();
  assert.equal(preservedCommentRecord.teacherComment, expectedTeacherComment);
  assert.equal((await (await fetch(secondLockUrl, { headers: { Cookie: teacherCookie } })).json()).locked, false);
  assert.deepEqual(await (await changeTermLock(true)).json(), {
    term: "Term 1",
    locked: true,
    studentCount: 2,
  });
  assert.equal((await (await fetch(termLockUrl, { headers: { Cookie: teacherCookie } })).json()).locked, true);
  assert.equal((await saveGrades(studentId)).status, 409);
  assert.equal((await saveGrades(secondStudentId)).status, 409);

  const eClassSync = await fetch(`${baseUrl}/api/grades/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ studentId, term: "Term 1", subject: "filipino", grade: 90 }),
  });
  assert.equal(eClassSync.status, 200, "E-Class computed grades continue syncing while direct entry is locked");
  assert.equal((await eClassSync.json()).grade, 90);
  const clearEClassGrade = await fetch(`${baseUrl}/api/grades/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ studentId, term: "Term 1", subject: "filipino", grade: "" }),
  });
  assert.equal(clearEClassGrade.status, 200);
  const clearedEClassSubjectGrades = await fetch(
    `${baseUrl}/api/grades?studentId=${encodeURIComponent(studentId)}&term=Term%201`,
    { headers: { Cookie: teacherCookie } },
  );
  const clearedEClassSubjectRecord = await clearedEClassSubjectGrades.json();
  assert.equal(clearedEClassSubjectRecord.grades.filipino, "");
  assert.deepEqual(clearedEClassSubjectRecord.eClassSubjects, []);

  await stopServer();
  server = createServer({ databasePath, migrationWorkbookPath });
  baseUrl = await startServer();
  const teacherLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "grade.lock.teacher@example.com", password: teacherPassword, role: "teacher" }),
  });
  assert.equal(teacherLogin.status, 200);
  teacherCookie = teacherLogin.headers.get("set-cookie").split(";")[0];
  const restoredGradeRecord = await fetch(
    `${baseUrl}/api/grades?studentId=${encodeURIComponent(studentId)}&term=Term%201`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(restoredGradeRecord.status, 200);
  assert.equal((await restoredGradeRecord.json()).teacherComment, expectedTeacherComment);
  const sf9WorkbookResponse = await fetch(
    `${baseUrl}/api/grades/sf9?studentId=${encodeURIComponent(studentId)}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(sf9WorkbookResponse.status, 200);
  const sf9WorkbookBuffer = Buffer.from(await sf9WorkbookResponse.arrayBuffer());
  const sf9Archive = await JSZip.loadAsync(sf9WorkbookBuffer);
  const sf9WorksheetXml = await sf9Archive.file("xl/worksheets/sheet1.xml").async("string");
  const sf9XmlParser = new SaxesParser();
  let sf9XmlError = null;
  sf9XmlParser.on("error", (error) => {
    sf9XmlError = error;
  });
  sf9XmlParser.write(sf9WorksheetXml).close();
  assert.equal(sf9XmlError, null, "the downloaded SF9 worksheet XML is valid and needs no Excel repair");
  const sf9SheetProperties = sf9WorksheetXml.match(/<sheetPr\b[^>]*>([\s\S]*?)<\/sheetPr>/)?.[1] || "";
  const sf9OutlinePropertiesIndex = sf9SheetProperties.indexOf("<outlinePr");
  const sf9PageSetupPropertiesIndex = sf9SheetProperties.indexOf("<pageSetUpPr");
  assert.ok(
    sf9OutlinePropertiesIndex >= 0 && sf9PageSetupPropertiesIndex > sf9OutlinePropertiesIndex,
    "SF9 worksheet properties follow Excel's required XML element order",
  );
  const sf9PageSetupTag = sf9WorksheetXml.match(/<pageSetup\b[^>]*\/>/)?.[0] || "";
  assert.match(sf9PageSetupTag, /\bhorizontalDpi="300"/, "SF9 uses a valid horizontal print resolution");
  assert.match(sf9PageSetupTag, /\bverticalDpi="300"/, "SF9 uses a valid vertical print resolution");
  assert.doesNotMatch(sf9PageSetupTag, /4294967295/, "the workbook excludes invalid sentinel DPI values that trigger Excel repair");
  const sf9Workbook = new ExcelJS.Workbook();
  await sf9Workbook.xlsx.load(sf9WorkbookBuffer);
  const sf9Sheet = sf9Workbook.getWorksheet("SF9 - GRADE 4-10");
  assert.equal(
    sf9Sheet.getCell("Q15").value,
    `Term 1\n${expectedTeacherComment}`,
    "the SF9 workbook prints the saved comment inside the Term 1 teacher-comments box",
  );
  assert.equal(sf9Sheet.getCell("Q15").alignment.wrapText, true);
  assert.equal(sf9Sheet.getCell("Q19").value, "Term 2", "the Term 2 remarks-box label remains intact");
  assert.equal(sf9Sheet.getCell("Q23").value, "Term 3", "the Term 3 remarks-box label remains intact");
  const sf9PreviewResponse = await fetch(
    `${baseUrl}/api/grades/sf9?studentId=${encodeURIComponent(studentId)}&format=preview`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(sf9PreviewResponse.status, 200);
  const sf9PreviewHtml = await sf9PreviewResponse.text();
  assert.match(
    sf9PreviewHtml,
    /data-row="15" data-column="17" data-teacher-comments="1" colspan="13" rowspan="4"[^>]*>Term 1<br>A thoughtful note for this learner\.<\/td>/,
    "the printable SF9 preview displays the saved comment inside the Term 1 remarks box",
  );
  assert.match(
    sf9PreviewHtml,
    /body\[data-print-selection="Term 1"\] td\[data-teacher-comments="1"\],[\s\S]*?body\[data-print-selection="Term 3"\] td\[data-teacher-comments="3"\]\{visibility:visible!important\}/,
    "each term's teacher comment remains visible in its focused print selection",
  );
});

async function createSF2Upload(month, learners) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourceSF2Template);
  const sheet = workbook.getWorksheet("OCT 2026");
  assert.ok(sheet, "SF2 template worksheet exists");
  const [year, monthNumber] = month.split("-").map(Number);
  const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  sheet.name = `${monthNames[monthNumber - 1]} ${year}`;
  for (let column = 7; column <= 31; column += 1) {
    sheet.getCell(10, column).value = null;
    sheet.getCell(11, column).value = ["M", "T", "W", "TH", "F"][(column - 7) % 5];
  }
  const schoolDays = [];
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  for (let day = 1; day <= dayCount; day += 1) {
    const weekday = new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const column = 7 + schoolDays.length;
    sheet.getCell(10, column).value = day;
    sheet.getCell(11, column).value = ["M", "T", "W", "TH", "F"][(weekday + 6) % 7];
    schoolDays.push({ day, column });
  }
  for (const rowNumber of sf2StudentRows) {
    sheet.getCell(rowNumber, 2).value = null;
    for (let column = 7; column <= 31; column += 1) {
      sheet.getCell(rowNumber, column).value = null;
    }
    sheet.getCell(rowNumber, 34).value = null;
  }
  const nextStudentRow = { Male: 13, Female: 64 };
  learners.forEach((learner) => {
    const gender = learner.gender || "Male";
    const row = sheet.getRow(nextStudentRow[gender]);
    nextStudentRow[gender] += 1;
    row.getCell(2).value = learner.name;
    row.getCell(34).value = learner.remarks || null;
    for (const { day, column } of schoolDays) {
      row.getCell(column).value = learner.marks && learner.marks[day] ? learner.marks[day] : null;
    }
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function createEmptyTestWorkbook(databasePath) {
  await fs.copyFile(sourceWorkbook, databasePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(databasePath);
  applyTestWorkbookHeaders(workbook);
  const clearColumns = (sheetName, columns) => {
    const sheet = workbook.getWorksheet(sheetName);
    assert.ok(sheet, `${sheetName} worksheet exists`);
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      for (const column of columns) {
        const cell = sheet.getRow(rowNumber).getCell(column);
        if (!cell.value || typeof cell.value !== "object" || !("formula" in cell.value || "sharedFormula" in cell.value)) {
          cell.value = null;
        }
      }
    }
  };

  const users = workbook.getWorksheet("Users");
  const passwordHeader = users.getRow(1).values.findIndex((value) =>
    typeof value === "string" && value.toLowerCase().startsWith("password"),
  );
  assert.ok(passwordHeader > 0, "Users worksheet has a password column");
  clearColumns("Users", Array.from({ length: 8 }, (_, index) => index + 1));

  const classes = workbook.getWorksheet("Classes");
  clearColumns("Classes", [1, 2, 3, 4]);
  const students = workbook.getWorksheet("Students");
  clearColumns("Students", [...Array.from({ length: 4 }, (_, index) => index + 1),
    ...Array.from({ length: Math.max(0, students.columnCount - 6) }, (_, index) => index + 7)]);
  const termGrades = workbook.getWorksheet("Term Grades");
  if (termGrades) clearColumns("Term Grades", Array.from({ length: 8 }, (_, index) => index + 1));
  clearColumns("SignInLog", [1, 2, 3, 4, 6]);

  await workbook.xlsx.writeFile(databasePath);
}

async function createMigrationTestWorkbook(databasePath) {
  await fs.copyFile(sourceWorkbook, databasePath);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(databasePath);
  applyTestWorkbookHeaders(workbook);
  const users = workbook.getWorksheet("Users");
  const userColumns = new Map();
  users.getRow(1).eachCell((cell, column) => {
    userColumns.set(String(cell.value).toLowerCase(), column);
  });
  const fakeSalt = Buffer.from("test-only-salt");
  const fakeHash = crypto.pbkdf2Sync(
    "migration-fixture-password",
    fakeSalt,
    210000,
    32,
    "sha256",
  ).toString("hex");
  const account = users.addRow([]);
  account.getCell(userColumns.get("user id")).value = "USER-MIGRATION-FIXTURE";
  account.getCell(userColumns.get("role")).value = "teacher";
  account.getCell(userColumns.get("full name")).value = "Migration Fixture Teacher";
  account.getCell(userColumns.get("email")).value = "migration-fixture@example.invalid";
  account.getCell(userColumns.get("password hash (pbkdf2)")).value =
    `pbkdf2$210000$${fakeSalt.toString("hex")}$${fakeHash}`;
  account.getCell(userColumns.get("class id")).value = "CLASS-MIGRATION-FIXTURE";
  account.getCell(userColumns.get("status")).value = "active";
  account.getCell(userColumns.get("created")).value = "2026-01-01T00:00:00.000Z";
  await workbook.xlsx.writeFile(databasePath);
}

test("registrations persist in the workbook and can sign in after a restart", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grade5-portal-"));
  const databasePath = path.join(directory, "database.sqlite");
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  const generatedReportsDirectory = path.join(directory, "downloads", "generated-reports");
  await createEmptyTestWorkbook(migrationWorkbookPath);
  const emptyWorkbook = new ExcelJS.Workbook();
  await emptyWorkbook.xlsx.readFile(migrationWorkbookPath);
  const emptyUsers = emptyWorkbook.getWorksheet("Users");
  const emptyUserHeaders = new Map();
  emptyUsers.getRow(1).eachCell((cell, column) => {
    emptyUserHeaders.set(String(cell.value).toLowerCase(), column);
  });
  for (let rowNumber = 2; rowNumber <= emptyUsers.rowCount; rowNumber += 1) {
    const row = emptyUsers.getRow(rowNumber);
    for (let column = 1; column <= 8; column += 1) {
      assert.equal(row.getCell(column).value || "", "", `user data is empty in row ${rowNumber}, column ${column}`);
    }
  }

  let server = createServer({ databasePath, migrationWorkbookPath, generatedReportsDirectory });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", storage: "sqlite" });
  const portalPageResponse = await fetch(baseUrl);
  assert.equal(portalPageResponse.status, 200);
  const portalPage = await portalPageResponse.text();
  assert.match(portalPage, /id="sideBrandLogo" src="\/icon\.png" alt=""/);
  assert.match(portalPage, /class="sidebar-footer-icon" src="\/icon\.png" alt="" aria-hidden="true"/);
  assert.match(portalPage, /#workspace:has\(#eClassPage:not\(\[hidden\]\)\)>\.portal-footer\{display:none\}/);
  assert.match(portalPage, /\.page-content:has\(#eClassPage:not\(\[hidden\]\)\)\{max-width:none;margin:0;padding:0\}/);
  assert.match(portalPage, /#eClassPage \.eclass-table-wrap\{margin:0\}/);
  assert.match(portalPage, /\.sidebar-footer-icon\{display:block;width:48px;height:48px;margin:14px auto 0/);
  assert.ok(portalPage.includes(`class="sidebar-footer-version">Version ${require("../package.json").version}</span>`));
  assert.match(portalPage, /\.teacher-profile-card\{display:flex;max-width:920px;align-items:center/);
  assert.match(portalPage, /\.teacher-profile-form\{max-width:920px;padding:0 22px 22px\}/);
  assert.match(portalPage, /\.teacher-profile-form \.form-field\.full\{grid-column:1\/-1\}/);
  assert.match(portalPage, /\.workspace\{display:flex;min-width:0;min-height:0;flex:1;flex-direction:column;overflow-x:hidden;overflow-y:auto;overscroll-behavior-y:contain;scrollbar-gutter:stable\}/);
  assert.match(portalPage, /#teacherProfilePage:not\(\[hidden\]\)\{position:relative;z-index:1;min-height:0;max-height:calc\(100vh - 76px\);overflow-y:auto;overflow-x:hidden/);
  assert.match(portalPage, /#teacherProfilePage:not\(\[hidden\]\)::-webkit-scrollbar\{width:10px\}/);
  assert.match(portalPage, /\.topbar\{display:flex;position:sticky;top:0;z-index:10/);
  assert.match(portalPage, /\.menu-toggle\{display:grid;flex:0 0 44px;width:44px;height:44px;place-items:center;position:relative;z-index:11/);
  assert.ok(portalPage.indexOf('data-logout>Sign out</button>') < portalPage.indexOf('class="sidebar-footer-icon"'));
  const sidebarIconResponse = await fetch(`${baseUrl}/icon.png`);
  assert.equal(sidebarIconResponse.status, 200);
  assert.match(sidebarIconResponse.headers.get("content-type"), /^image\/png/);
  assert.ok((await sidebarIconResponse.arrayBuffer()).byteLength > 0);
  const gradeInterpretationSource = portalPage.match(/function getGradeInterpretation\(grade\)\{[\s\S]*?\n  \}/);
  assert.ok(gradeInterpretationSource, "general-average interpretation helper exists");
  const getGradeInterpretation = vm.runInNewContext(`${gradeInterpretationSource[0]}; getGradeInterpretation`);
  for (const [grade, expected] of [
    [100, "Advancing"], [90, "Advancing"], [89.99, "Benchmarking"], [85, "Benchmarking"],
    [84.99, "Connecting"], [80, "Connecting"], [79.99, "Developing"], [75, "Developing"],
    [74.99, "Emerging"], [0, "Emerging"],
  ]) {
    assert.equal(getGradeInterpretation(grade).label, expected, `grade ${grade} is ${expected}`);
  }
  assert.equal(getGradeInterpretation(-0.01), null);
  assert.equal(getGradeInterpretation(100.01), null);
  assert.match(portalPage, /id="attendanceSavedDays"/);
  assert.match(portalPage, /id="clearAttendanceMonth"[^>]*>Clear Month Attendance/);
  assert.match(portalPage, /api\("\/api\/attendance\/month\?month="\+encodeURIComponent\(month\),\{method:"DELETE"\}\)/);
  assert.match(portalPage, /result\.statuses\.filter\(function\(status\)\{return \["Present","Absent","Tardy","Excused"\]\.includes\(status\)\}\)\.forEach\(function\(status\)[\s\S]*?select\.add\(new Option\(code,status\)\)/);
  assert.match(portalPage, /Blank: Present; CC or X: Absent; T: Tardy; E: Excused/);
  assert.match(portalPage, /status==="Absent"\?"CC":status==="Tardy"\?"T"/);
  assert.doesNotMatch(portalPage, /status==="Half-day"/);
  assert.doesNotMatch(portalPage, /data-role="parent"/);
  assert.doesNotMatch(portalPage, /id="extraWrap"|id="extraLabel"|id="extraHint"/);
  assert.match(portalPage, /body:JSON\.stringify\(\{name:name,email:email,password:pw,role:"teacher",grade:grade,strand:strand\}\)/);
  assert.match(portalPage, /querySelectorAll\("\.attendance-day-select"\)\)[\s\S]*?select\.value!==""/);
  assert.match(portalPage, /id="teacherGradeWrap" hidden/);
  assert.match(portalPage, /id="teacherStrandWrap" hidden/);
  assert.match(portalPage, /<select id="teacherGrade" aria-describedby="teacherGradeHint">[\s\S]*?<option value="Grade 1">Grade 1<\/option>[\s\S]*?<option value="Grade 12">Grade 12<\/option>[\s\S]*?<\/select>/);
  assert.match(portalPage, /id="performanceModeToggle"[^>]*role="switch"[^>]*aria-checked="false"/);
  assert.match(portalPage, /gradePortalPerformanceMode/);
  assert.match(portalPage, /\$\("teacherGradeWrap"\)\.hidden=!up/);
  assert.match(portalPage, /Enter your grade level\./);
  assert.match(portalPage, /id="navPhilIri"[^>]*>\s*<span class="nav-icon" aria-hidden="true">▥<\/span>Phil-Iri/);
  assert.doesNotMatch(portalPage, /navDownloadForms|downloadFormsPage|downloadFormSelect|openDownloadForm/);
  assert.doesNotMatch(portalPage, /id="navReadingProgress"/);
  assert.match(portalPage, /<section id="philIriPage" aria-labelledby="philIriTitle" hidden>/);
  assert.doesNotMatch(portalPage, /id="philIriPupilTab"|id="philIriPupilPanel"|>Pupil List<\/button>/);
  assert.match(portalPage, /id="philIriResultsTab"[^>]*aria-selected="true">Results<\/button>/);
  assert.ok(portalPage.indexOf('id="philIriAutoScoringTab"') < portalPage.indexOf('id="philIriResultsTab"'));
  assert.ok(portalPage.indexOf('id="philIriResultsTab"') < portalPage.indexOf('id="philIriReadingSummaryTab"'));
  assert.match(portalPage, /id="philIriReadingSummaryTab"[^>]*>Summary of Reading Level<\/button>/);
  assert.match(portalPage, /id="philIriAralProgramTab"[^>]*aria-controls="philIriAralProgramPanel"[^>]*>Aral Program<\/button>/);
  assert.match(portalPage, /id="philIriAralProgramPanel"[^>]*role="tabpanel"[^>]*hidden><\/section>/);
  assert.match(portalPage, /philIriAralProgramPanel"\)\.hidden=!showAralProgram/);
  assert.match(portalPage, /philIriAralProgramTab"\)\.onclick=function\(\)\{showPhilIriTab\("aral-program"\)\}/);
  assert.match(portalPage, /\.philiri-tabs\{[^}]*background:var\(--field\)/);
  assert.match(portalPage, /\.philiri-tab\[aria-selected="true"\]\{[^}]*background:var\(--accent\);color:var\(--accent-ink\)/);
  assert.match(portalPage, /\.philiri-tab:hover:not\(\[aria-selected="true"\]\)\{[^}]*background:var\(--soft\)/);
  assert.match(portalPage, /\.tabs,\.attendance-tabs,\.philiri-tabs,\.reading-tab-options,\.rma-period-tabs,\.rma-view-tabs\{[^}]*background:var\(--field\)/);
  assert.match(portalPage, /\.tab\[aria-selected="true"\],\.attendance-tab\[aria-selected="true"\],\.philiri-tab\[aria-selected="true"\],\.reading-subtab\[aria-selected="true"\],\.rma-period-tab\[aria-selected="true"\],\.rma-view-tab\[aria-selected="true"\]\{[^}]*background:var\(--accent\);color:var\(--accent-ink\)/);
  assert.match(portalPage, /\.tab:focus-visible,\.attendance-tab:focus-visible,\.philiri-tab:focus-visible,\.reading-subtab:focus-visible,\.rma-period-tab:focus-visible,\.rma-view-tab:focus-visible/);
  assert.match(portalPage, /id="philIriReadingSummaryPanel"[^>]*hidden/);
  assert.match(portalPage, /id="philIriReadingSummaryTable" hidden/);
  assert.match(portalPage, /async function loadPhilIriReadingSummary\(\)/);
  assert.match(portalPage, /periods=\["BOSY","MOSY","EOSY"\]/);
  assert.match(portalPage, /assessmentTypes=\["Pretest","Posttest"\]/);
  assert.match(portalPage, /current\.assessmentType==="Posttest"/);
  assert.match(portalPage, /renderPhilIriReadingProgress\(cell,item\.levels\[language\],item\.student\.name,language\)/);
  assert.match(portalPage, /id="philIriResultsPanel"[^>]*>/);
  assert.doesNotMatch(portalPage.match(/<section id="philIriResultsPanel"[^>]*>/)[0], /hidden/);
  assert.match(portalPage, /async function loadPhilIriPupils\(\)/);
  assert.match(portalPage, /else if\(showPhilIri\)\{[\s\S]*?loadPhilIriPupils\(\);[\s\S]*?loadPhilIriAutoScoringResults\(\)/);
  assert.match(portalPage, /var result=await api\("\/api\/students"\);[\s\S]*?var students=filterStudentsForActiveSection\(result\.students\)/);
  assert.match(portalPage, /renderPhilIriScoreForm\(students\)/);
  assert.match(portalPage, /\$\("navPhilIri"\)\.onclick=function\(\)\{showDashboardPage\("philIri"\)\}/);
  assert.match(portalPage, /id="navRma"[^>]*disabled[^>]*aria-disabled="true"/);
  assert.match(portalPage, /if\(\(showReading\|\|showRma\)&&\(!currentUser\|\|!currentUser\.isAdmin\)\)return/);
  assert.match(portalPage, /\$\("navRma"\)\.disabled=!user\.isAdmin/);
  assert.match(portalPage, /id="adminClassSwitcher" hidden/);
  assert.match(portalPage, /id="navAdminAccounts"[^>]*hidden[\s\S]*?<\/span>Admin/);
  assert.ok(portalPage.indexOf('id="navAdminAccounts"') > portalPage.indexOf('id="navTeacherProfile"'));
  assert.ok(portalPage.indexOf('id="navSettings"') > portalPage.indexOf('id="navAdminAccounts"'));
  assert.match(portalPage, /id="adminAccountsPage"/);
  assert.match(portalPage, /Review account access, search the user list, and help users recover account access/);
  assert.match(portalPage, /id="adminTotalAccounts"/);
  assert.match(portalPage, /id="adminActiveAccounts"/);
  assert.match(portalPage, /id="adminTeacherAccounts"/);
  assert.match(portalPage, /id="adminParentAccounts"/);
  assert.match(portalPage, /id="adminAccountSearch" type="search"/);
  assert.match(portalPage, /id="adminAccountRoleFilter"[\s\S]*?value="teacher">Teachers[\s\S]*?value="parent">Parents/);
  assert.match(portalPage, /id="adminAccountStatusFilter"[\s\S]*?value="active">Active[\s\S]*?value="inactive">Disabled/);
  assert.match(portalPage, /id="studentSectionFilter" aria-label="Select the student roster section"/);
  assert.match(portalPage, /id="studentSectionFilter"[\s\S]*?id="selectStudentSection"[^>]*>Apply Section<\/button>/);
  const sectionControlsSource = portalPage.match(/function populateSectionControls\(preferredSection\)\{[\s\S]*?\n  \}/);
  assert.ok(sectionControlsSource, "student section dropdown population helper exists");
  assert.doesNotMatch(sectionControlsSource[0], /All sections/);
  assert.match(sectionControlsSource[0], /pendingStudentSection=canKeep\?previous:\(handledSections\[0\]\|\|\(hasUnassignedStudents\?"__unassigned__":""\)\)/);
  assert.match(sectionControlsSource[0], /new Option\("No sections available",""\)/);
  assert.match(sectionControlsSource[0], /if\(rosterStudents\.length\)/);
  assert.match(portalPage, /id="addNewSection"[^>]*>\+ Add New Section/);
  assert.match(portalPage, /id="newSectionName" maxlength="100" autocomplete="off"/);
  assert.match(portalPage, /id="newSectionGrade" maxlength="100" autocomplete="off"/);
  assert.match(portalPage, /id="newSectionDialog"[\s\S]*?id="importSF1"[^>]*>Import SF1[\s\S]*?id="saveNewSection"[^>]*>Add Section/);
  assert.match(portalPage, /id="teacherProfileSectionsHandled"/);
  assert.match(portalPage, /id="teacherProfileSubjectsHandled"/);
  assert.match(portalPage, /id="studentSection" name="section"/);
  assert.match(portalPage, /function populateSectionControls\(preferredSection\)/);
  assert.match(portalPage, /id="adminAccountResultCount"/);
  assert.match(portalPage, /class="student-table admin-account-table"/);
  assert.match(portalPage, /Disable login[\s\S]*?Enable login/);
  assert.match(portalPage, /\$\("navAdminAccounts"\)\.hidden=!user\.isAdmin/);
  assert.match(portalPage, /Reset password[\s\S]*?temporary password will be their email address/);
  assert.match(portalPage, /id="forcedPasswordDialog"[\s\S]*?Change the temporary password before continuing/);
  assert.match(portalPage, /api\("\/api\/auth\/change-password"/);
  assert.match(portalPage, /attendance-metric-label">TOTAL NUMBER OF DAYS</);
  const countClassDaysSource = portalPage.match(/function countClassDays\(result\)\{[\s\S]*?\n  \}/);
  assert.ok(countClassDaysSource, "monthly class-day counter exists");
  const countClassDays = vm.runInNewContext(
    `${countClassDaysSource[0]}; countClassDays`,
  );
  assert.equal(countClassDays({
    dates: ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"],
    noClassDates: ["2026-10-02"],
    students: [{ attendance: [] }],
  }), 4, "counts all weekdays in the month and excludes No Class dates");
  assert.match(portalPage, /id="gradeGeneralAverageDescriptor"/);
  assert.match(portalPage, /gradeSummaryRows[\s\S]*?descriptor\.textContent=interpretation\.label/);
  assert.match(portalPage, /api\("\/api\/e-class\/record"/);
  assert.match(portalPage, /Save &amp; Lock Record/);
  assert.match(portalPage, /api\("\/api\/e-class\/record\/unlock"/);
  assert.match(portalPage, /<span id="eClassSelectionTerm">Term 1<\/span>/);
  assert.match(portalPage, /<span id="eClassSelectionSubject">Filipino<\/span>/);
  assert.doesNotMatch(portalPage, /<strong>(?:TERM|SUBJECT):<\/strong>/);
  assert.match(await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8"), /mapehGroup === "Music and Arts" \? "musicAndArts" : "physicalEducationAndHealth"/);
  assert.match(portalPage, /id="exportGradeSummary"[^>]*>Export Grading Sheet<\/button>/);
  assert.match(portalPage, /\/api\/grades\/summary\/export/);
  assert.match(portalPage, /overallAverageCell\.append\(overallDescriptor\)/);
  assert.match(portalPage, /\.grade-summary-table th,\.grade-summary-table td\{[^}]*border:1px solid #e6e6e6/);
  assert.match(portalPage, /#parentGradeRecords \.parent-grade-table th,#parentGradeRecords \.parent-grade-table td\{border:1px solid #e6e6e6\}/);
  assert.match(portalPage, /\.grade-interpretation a\{text-decoration:none;color:#464feb\}/);
  assert.match(portalPage, /sidebar-collapsed \.sidebar\{flex-basis:0;width:0/);
  assert.match(portalPage, /\.sidebar\{--sidebar-ink:#f8fbff;[^}]*linear-gradient\(155deg,#172554 0%,#173b5c 56%,#14534f 100%\)/);
  assert.match(portalPage, /\.sidebar \.nav-link\[aria-current="page"\]\{[^}]*background:linear-gradient\(110deg,#fff 0%,#edf6ff 100%\)/);
  assert.match(portalPage, /window\.matchMedia\("\(max-width: 760px\)"\)/);
  assert.match(portalPage, /toggle\("sidebar-collapsed"\)/);
  assert.match(portalPage, /<fieldset class="grade-fieldset" id="gradeFields">/);
  assert.match(portalPage, /id="teacherProfileSchoolName"/);
  assert.match(portalPage, /id="teacherProfileSchoolId"/);
  assert.match(portalPage, /id="teacherProfileRegion"/);
  assert.match(portalPage, /id="teacherProfileDivision"/);
  assert.match(portalPage, /id="teacherProfileDistrict"/);
  assert.match(portalPage, /id="teacherProfileName"[\s\S]*?id="teacherProfilePosition"/);
  assert.match(portalPage, /id="teacherProfileSchoolHead"[\s\S]*?id="teacherProfileSchoolHeadPosition"/);
  assert.match(portalPage, /id="philIriAutoScoringTab"[^>]*>Scoring Form<\/button>/);
  assert.match(portalPage, /id="philIriAutoScoringPanel"[^>]*hidden/);
  assert.match(portalPage, /id="philIriResultsTab"[^>]*>Results<\/button>/);
  assert.match(portalPage, /id="philIriResultsPanel"[^>]*>/);
  assert.doesNotMatch(portalPage.match(/<section id="philIriResultsPanel"[^>]*>/)[0], /hidden/);
  assert.match(portalPage, /id="philIriResultsCycle"[\s\S]*?<option value="BOSY">[\s\S]*?<option value="MOSY">[\s\S]*?<option value="EOSY">/);
  assert.match(portalPage, /id="philIriEnglishResultsTable"/);
  assert.match(portalPage, /id="philIriFilipinoResultsTable"/);
  assert.match(portalPage, /<th>Mode<\/th>[\s\S]*?<th>Reading Rate \(WPM\)<\/th>[\s\S]*?<th>Starting Passage<\/th>/);
  assert.match(portalPage, /async function loadPhilIriAutoScoringResults/);
  assert.match(portalPage, /var period=\$\("philIriResultsCycle"\)\.value/);
  assert.match(portalPage, /\$\("philIriResultsCycle"\)\.onchange=loadPhilIriAutoScoringResults/);
  assert.match(portalPage, /showPhilIriTab\("results"\)/);
  assert.match(portalPage, /id="refreshPhilIriResults"/);
  assert.match(portalPage, /id="philIriScoreForm" hidden/);
  assert.match(portalPage, /id="philIriScorePupil"/);
  assert.match(portalPage, /id="philIriScorePeriod"[\s\S]*?<option>BOSY<\/option><option>MOSY<\/option><option>EOSY<\/option>/);
  assert.match(portalPage, /id="philIriScoreLanguage"[\s\S]*?<option>English<\/option><option>Filipino<\/option>/);
  assert.doesNotMatch(portalPage, /id="philIriScoreAssessor"/);
  assert.match(portalPage, /id="savePhilIriAutoScore"[^>]*>Save PHIL-IRI Scores/);
  for (const field of ["gstScore", "totalWords", "miscues", "comprehensionCorrect", "comprehensionTotal"]) {
    assert.match(portalPage, new RegExp(`data-score-field="${field}"`));
  }
  for (const result of ["philIriGstStatus", "philIriOralReading", "philIriReadingRate", "philIriComprehension", "philIriReadingLevel", "philIriStartingPassage", "philIriSuggestedIntervention"]) {
    assert.match(portalPage, new RegExp(`id="${result}"`));
  }
  assert.match(portalPage, /Results remain separate by pupil, cycle, test type, language, and assessment mode/);
  assert.match(portalPage, /async function persistSelectedPhilIriScores/);
  assert.match(portalPage, /\/api\/phil-iri\/auto-scoring/);
  assert.doesNotMatch(portalPage, /This portal server does not support PHIL-IRI score saving yet/);
  const saveAutoScoreFunction = portalPage.match(/async function persistSelectedPhilIriScores\(\)\{[\s\S]*?\n  \}/);
  assert.ok(saveAutoScoreFunction, "PHIL-IRI score save handler exists");
  assert.match(saveAutoScoreFunction[0], /method:"PUT"/);
  assert.match(saveAutoScoreFunction[0], /await loadPhilIriAutoScoringResults\(\)/);
  assert.match(saveAutoScoreFunction[0], /Results tab updated/);
  const loadPhilIriScoreFunction = portalPage.match(/async function loadSelectedPhilIriScores\(\)\{[\s\S]*?\n  \}/);
  assert.ok(loadPhilIriScoreFunction, "PHIL-IRI scores load asynchronously");
  assert.match(loadPhilIriScoreFunction[0], /input\.disabled=false/);
  assert.match(loadPhilIriScoreFunction[0], /if\(editVersion!==philIriScoreEditVersion\)return/);
  assert.doesNotMatch(loadPhilIriScoreFunction[0].slice(loadPhilIriScoreFunction[0].indexOf("}catch(error)")), /input\.disabled=true/);
  assert.doesNotMatch(portalPage, /id="philIriScoreTable"/);
  assert.match(portalPage, /else if\(showPhilIri\)\{[\s\S]*?loadPhilIriPupils\(\);[\s\S]*?loadPhilIriAutoScoringResults\(\)/);
  assert.match(portalPage, /renderPhilIriScoreForm\(students\)/);
  assert.match(portalPage, /input\.oninput=saveSelectedPhilIriScores/);
  assert.match(portalPage, /pupilSelect\.onchange=loadSelectedPhilIriScores/);
  const philIriScoreFunction = portalPage.match(/function calculatePhilIriScore\(data,guide,mode,language\)\{[\s\S]*?\n  \}/);
  assert.ok(philIriScoreFunction, "Phil-Iri scores are calculated using the template rules");
  const philIriStartingPassageFunction = portalPage.match(/function philIriStartingPassage\(score,guide,language\)\{[\s\S]*?\n  \}/);
  assert.ok(philIriStartingPassageFunction, "GST referral scores map to a starting passage grade");
  const calculatePhilIriScore = vm.runInNewContext(
    `${philIriStartingPassageFunction[0]}; ${philIriScoreFunction[0]}; calculatePhilIriScore`,
  );
  const elementaryGuide = {
    supported: true,
    grade: "Grade 5",
    totalItems: 20,
    passingScore: 14,
    minimumPassageGrade: { English: 2, Filipino: 1 },
    referralRanges: [
      { minimum: 0, maximum: 7, levelsBelow: 3 },
      { minimum: 8, maximum: 13, levelsBelow: 2 },
    ],
  };
  const independentPhilIri = calculatePhilIriScore({
    gstScore: "13",
    totalWords: "100",
    miscues: "3",
    comprehensionCorrect: "8",
    comprehensionTotal: "10",
  }, elementaryGuide, "Oral Reading", "English");
  assert.equal(independentPhilIri.gstStatus, "INDIVIDUAL ASSESSMENT");
  assert.equal(independentPhilIri.oralReading, 0.97);
  assert.equal(independentPhilIri.comprehension, 0.8);
  assert.equal(independentPhilIri.readingLevel, "Independent");
  assert.equal(independentPhilIri.intervention, "Enrichment");
  const passedGstPhilIri = calculatePhilIriScore({
    gstScore: "14",
    totalWords: "100",
    miscues: "3",
    timeSeconds: "60",
    comprehensionCorrect: "8",
    comprehensionTotal: "10",
  }, elementaryGuide, "Oral Reading", "English");
  assert.equal(passedGstPhilIri.gstStatus, "PASS GST");
  assert.equal(passedGstPhilIri.oralReading, null);
  assert.equal(passedGstPhilIri.comprehension, null);
  assert.equal(passedGstPhilIri.readingLevel, "");
  const instructionalPhilIri = calculatePhilIriScore({
    gstScore: "13",
    totalWords: "100",
    timeSeconds: "60",
    miscues: "10",
    comprehensionCorrect: "6",
    comprehensionTotal: "10",
  }, elementaryGuide, "Oral Reading", "English");
  assert.equal(instructionalPhilIri.gstStatus, "INDIVIDUAL ASSESSMENT");
  assert.equal(instructionalPhilIri.readingLevel, "Instructional");
  assert.equal(instructionalPhilIri.intervention, "Guided Reading");
  const invalidPhilIri = calculatePhilIriScore({
    gstScore: "",
    totalWords: "0",
    miscues: "0",
    comprehensionCorrect: "11",
    comprehensionTotal: "10",
  }, elementaryGuide, "Oral Reading", "English");
  assert.equal(invalidPhilIri.oralReading, null);
  assert.equal(invalidPhilIri.comprehension, null);
  assert.equal(invalidPhilIri.readingLevel, "");
  assert.equal(calculatePhilIriScore({ gstScore: null }, elementaryGuide, "Oral Reading", "English").gstStatus, "");
  const silentPhilIri = calculatePhilIriScore({
    gstScore: "8",
    totalWords: "100",
    miscues: "100",
    timeSeconds: "120",
    comprehensionCorrect: "8",
    comprehensionTotal: "10",
  }, elementaryGuide, "Silent Reading", "English");
  assert.equal(silentPhilIri.oralReading, null);
  assert.equal(silentPhilIri.wordsPerMinute, 50);
  assert.equal(silentPhilIri.readingLevel, "Independent");
  assert.equal(silentPhilIri.startingPassage, "Grade 3 passage (2 levels below)");
  const listeningPhilIri = calculatePhilIriScore({
    gstScore: "7",
    comprehensionCorrect: "6",
    comprehensionTotal: "10",
  }, elementaryGuide, "Listening Comprehension", "Filipino");
  assert.equal(listeningPhilIri.oralReading, null);
  assert.equal(listeningPhilIri.wordsPerMinute, null);
  assert.equal(listeningPhilIri.startingPassage, "Grade 2 passage (3 levels below)");
  assert.equal(listeningPhilIri.readingLevel, "Instructional");
  const serverSource = await fs.readFile(path.join(__dirname, "..", "server.js"), "utf8");
  const scoringGuideFunction = serverSource.match(/function getPhilIriAutoScoringGuide\(grade\)\s*\{[\s\S]*?\n\}/);
  const serverStartingPassageFunction = serverSource.match(/function getPhilIriStartingPassage\(score, guide, language\)\s*\{[\s\S]*?\n\}/);
  assert.ok(scoringGuideFunction, "server scoring guide applies the manual's grade ranges");
  assert.ok(serverStartingPassageFunction, "server maps GST scores to a passage grade");
  const serverPhilIriHelpers = vm.runInNewContext(
    `${scoringGuideFunction[0]}; ${serverStartingPassageFunction[0]}; ({getPhilIriAutoScoringGuide,getPhilIriStartingPassage})`,
  );
  const juniorHighGuide = serverPhilIriHelpers.getPhilIriAutoScoringGuide("Grade 7");
  assert.equal(juniorHighGuide.totalItems, 40);
  assert.equal(juniorHighGuide.passingScore, 28);
  assert.equal(juniorHighGuide.durationMinutes, 60);
  assert.equal(serverPhilIriHelpers.getPhilIriAutoScoringGuide("Grade 11").supported, false);
  assert.equal(serverPhilIriHelpers.getPhilIriStartingPassage(16, juniorHighGuide, "English"), "Grade 5 passage (2 levels below)");
  assert.equal(serverPhilIriHelpers.getPhilIriStartingPassage(15, juniorHighGuide, "English"), "Grade 4 passage (3 levels below)");
  const nutritionalRosterTable = portalPage.match(/<table class="student-table nutritional-status-table" id="nutritionalRosterTable" hidden>[\s\S]*?<\/table>/)?.[0];
  assert.ok(nutritionalRosterTable);
  assert.doesNotMatch(nutritionalRosterTable, /<th>Actions<\/th>/);
  assert.equal((nutritionalRosterTable.match(/<th>/g) || []).length, 11);
  assert.match(portalPage, /class="table-wrap drag-scroll-wrap">\s*<table class="student-table nutritional-status-table"/);
  assert.match(portalPage, /Drag the table left or right to view all nutritional measurements/);
  assert.match(portalPage, /\.drag-scroll-wrap\{overflow-x:auto;cursor:grab;touch-action:pan-x pan-y\}/);
  assert.match(portalPage, /\.nutritional-status-table th:first-child,\.nutritional-status-table td:first-child\{position:sticky;left:0/);
  assert.match(portalPage, /\.nutritional-status-table th:nth-child\(2\),\.nutritional-status-table td:nth-child\(2\)\{position:sticky;left:48px/);
  assert.match(portalPage, /\.nutritional-status-table thead th:first-child,\.nutritional-status-table thead th:nth-child\(2\)\{z-index:4\}/);
  assert.doesNotMatch(nutritionalRosterTable, /<th>LRN<\/th>/);
  for (const column of ["Age", "Weight (kg)", "Height (m)", "Height² (m²)", "BMI (kg/m²)", "BMI Category", "Height for Age (HFA)"]) {
    assert.ok(nutritionalRosterTable.includes(`<th>${column}</th>`), `Nutritional Status includes the ${column} column`);
  }
  assert.doesNotMatch(nutritionalRosterTable, /<th>Measurement Date<\/th>/);
  assert.match(portalPage, /id="nutritionalMeasurementDate" type="date"/);
  assert.match(portalPage, /id="exportSF8"[^>]*disabled>Generate SF8<\/button>/);
  assert.match(portalPage, /var hasStudents=rows\.querySelectorAll\("tr"\)\.length>0/);
  assert.match(portalPage, /async function exportNutritionalStatusSF8/);
  assert.match(portalPage, /nutritional-status\/sf8"\+assessmentQuery/);
  assert.match(portalPage, /Saved to "\+generatedPath/);
  const desktopEntry = await fs.readFile(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
  assert.match(desktopEntry, /generatedReportsDirectory:\s*path\.join\(app\.getPath\("downloads"\),\s*"generated-reports"\)/);
  assert.match(desktopEntry, /ipcMain\.handle\("download-sf9-pdf"/);
  assert.match(desktopEntry, /webContents\.printToPDF/);
  assert.match(portalPage, /Array\.from\(rows\.querySelectorAll\("tr"\)\)\s*\.some\(hasNutritionalMeasurementsChanged\)/);
  assert.match(portalPage, /\.filter\(hasNutritionalMeasurementsChanged\)/);
  const nutritionalAgeFunction = portalPage.match(/function nutritionalStudentAge\(birthdate,measurementDate\)\{[\s\S]*?\n  \}/);
  assert.ok(nutritionalAgeFunction, "nutritional age is calculated from the birth date and measurement date");
  const nutritionalStudentAge = vm.runInNewContext(
    `${nutritionalAgeFunction[0]}; nutritionalStudentAge`,
  );
  assert.equal(nutritionalStudentAge("2015-04-21", "2025-04-20"), "9");
  assert.equal(nutritionalStudentAge("2015-04-21", "2025-04-21"), "10");
  assert.equal(nutritionalStudentAge("2015-04-21", "2025-04-22"), "10");
  assert.equal(nutritionalStudentAge("2015-04-21", "2015-04-20"), "");
  const lockMeasurementsFunction = portalPage.match(
    /function setNutritionalMeasurementsLocked\(row,locked\)\{[\s\S]*?\n  \}/,
  );
  assert.ok(lockMeasurementsFunction, "measurement lock state is updated consistently");
  const setNutritionalMeasurementsLocked = vm.runInNewContext(
    `${lockMeasurementsFunction[0]}; setNutritionalMeasurementsLocked`,
  );
  const measurementControls = {
    weight: { disabled: false },
    height: { disabled: false },
  };
  const measurementRow = {
    dataset: {},
    querySelector(selector) {
      if (selector === '[data-measurement="weightKg"]') return measurementControls.weight;
      if (selector === '[data-measurement="heightM"]') return measurementControls.height;
      throw new Error(`Unexpected measurement selector ${selector}`);
    },
  };
  setNutritionalMeasurementsLocked(measurementRow, true);
  assert.equal(measurementControls.weight.disabled, true);
  assert.equal(measurementControls.height.disabled, true);
  setNutritionalMeasurementsLocked(measurementRow, false);
  assert.equal(measurementControls.weight.disabled, false);
  assert.equal(measurementControls.height.disabled, false);
  const changedMeasurementsFunction = portalPage.match(
    /function hasNutritionalMeasurementsChanged\(row\)\{[\s\S]*?\n  \}/,
  );
  assert.ok(changedMeasurementsFunction, "measurement changes are detected against saved values");
  const hasNutritionalMeasurementsChanged = vm.runInNewContext(
    `${changedMeasurementsFunction[0]}; hasNutritionalMeasurementsChanged`,
  );
  const changedMeasurementRow = {
    dataset: {
      measurementsLocked: "false",
      savedWeightKg: "42",
      savedHeightM: "1.4",
    },
    controls: {
      weight: { value: "42" },
      height: { value: "1.4" },
    },
    querySelector(selector) {
      if (selector === '[data-measurement="weightKg"]') return this.controls.weight;
      if (selector === '[data-measurement="heightM"]') return this.controls.height;
      throw new Error(`Unexpected measurement selector ${selector}`);
    },
  };
  assert.equal(hasNutritionalMeasurementsChanged(changedMeasurementRow), false);
  changedMeasurementRow.controls.height.value = "1.41";
  assert.equal(hasNutritionalMeasurementsChanged(changedMeasurementRow), true);
  changedMeasurementRow.dataset.measurementsLocked = "true";
  assert.equal(hasNutritionalMeasurementsChanged(changedMeasurementRow), false);
  assert.match(portalPage, /nutritionalStudentAge\(row\.dataset\.birthdate,result\.measurementDate\)/);
  assert.match(portalPage, /data-measurement="weightKg"/);
  assert.match(portalPage, /data-measurement="heightM"/);
  assert.match(portalPage, /weightInput\.disabled=false/);
  assert.match(portalPage, /heightInput\.disabled=false/);
  assert.match(portalPage, /row\.dataset\.measurementsLocked==="true"/);
  assert.match(portalPage, /setNutritionalMeasurementsLocked\(row,true\)/);
  assert.match(portalPage, /id="editNutritionalMeasurements"[^>]*>Edit Measurements<\/button>/);
  assert.match(portalPage, /\$\("editNutritionalMeasurements"\)\.onclick=toggleNutritionalMeasurementsEditing/);
  assert.match(portalPage, /function toggleNutritionalMeasurementsEditing\(\)/);
  assert.doesNotMatch(portalPage, /nutritional-unlock-button|createNutritionalUnlockButton/);
  assert.match(portalPage, /id="saveNutritionalMeasurements"[^>]*>Save and Lock<\/button>/);
  assert.match(portalPage, /\.btn:disabled\{opacity:\.58;cursor:not-allowed;box-shadow:none\}/);
  assert.match(portalPage, /\.btn\[aria-busy="true"\]\{cursor:progress\}/);
  assert.match(portalPage, /saveButton\.setAttribute\("aria-busy","true"\)/);
  assert.match(portalPage, /saveButton\.removeAttribute\("aria-busy"\)/);
  assert.match(portalPage, /async function saveAllNutritionalMeasurements/);
  assert.match(portalPage, /\$\("saveNutritionalMeasurements"\)\.onclick=saveAllNutritionalMeasurements/);
  assert.match(portalPage, /student\.bmiCategory\|\|"Restart server"/);
  assert.match(portalPage, /student\.heightForAgeStatus\|\|"Restart server"/);
  assert.match(portalPage, /result\.bmiCategory/);
  assert.match(portalPage, /result\.heightForAgeStatus/);
  assert.match(portalPage, /hasWhoResults\?result\.bmiCategory:"Restart server"/);
  assert.match(portalPage, /hasWhoResults\?result\.heightForAgeStatus:"Restart server"/);
  assert.match(portalPage, /data-calculation="heightForAge"/);
  assert.match(portalPage, /async function saveNutritionalMeasurements/);
  assert.match(portalPage, /id="chooseSchoolLogo"[^>]*>Upload \/ Change Logo<\/button>/);
  assert.match(portalPage, /id="clearStudentRoster"[^>]*>Clear List<\/button>/);
  assert.doesNotMatch(portalPage, /id="refreshStudentRoster"/);
  assert.match(portalPage, /id="clearRosterPassword" type="password"/);
  assert.match(portalPage, /id="confirmClearRosterForm" hidden/);
  assert.match(portalPage, /id="editGrades"[^>]*>Unlock Term with password<\/button>/);
  assert.match(portalPage, /\/api\/grades\/term-lock/);
  assert.match(portalPage, /id="gradeUnlockDialog"/);
  assert.match(portalPage, /Enter your current password once to unlock direct grade entry for every student/);
  assert.match(portalPage, /Other subjects remain editable until you select Lock Term/);
  assert.match(portalPage, /Subjects with a grade from E-Class are read-only here/);
  assert.match(portalPage, /id="gradeTeacherComment" name="teacherComment" maxlength="1000"/);
  assert.match(portalPage, /id="gradeTeacherCommentTitle">Teacher's Comment<\/h3>/);
  assert.match(portalPage, /id="gradeTeacherCommentCount"/);
  assert.match(portalPage, /id="gradeCommentSuggestion"/);
  assert.match(portalPage, /id="addGradeCommentSuggestion" type="button" disabled>Add suggestion<\/button>/);
  assert.match(portalPage, /<optgroup label="Academic — Outstanding \(90–100\)">/);
  assert.match(portalPage, /<optgroup label="Academic — Did Not Meet Expectations \(Below 75\)">/);
  assert.match(portalPage, /<optgroup label="Character and Behavior — Excellent Conduct">/);
  assert.match(portalPage, /<optgroup label="Attendance — Attendance Concerns">/);
  assert.match(portalPage, /<optgroup label="Filipino — Natatangi \(90–100\)">/);
  assert.match(portalPage, /commentField\.value=current\+separator\+suggestion/);
  assert.match(portalPage, /This suggestion would exceed 1,000 characters/);
  assert.match(portalPage, /\.grade-comment-panel\{margin-top:20px;[^}]*border-radius:16px/);
  assert.match(portalPage, /activeEClassGradeSubjects\.has\(field\[0\]\)/);
  assert.match(portalPage, /\.eclass-table tbody td\{background:#e6e6e6;border-color:#aab2bd\}/);
  assert.match(portalPage, /\.eclass-table \.eclass-editable-score\{cursor:text;background:#fff\}/);
  assert.match(portalPage, /\.eclass-table \.eclass-input-cell\{background:#fff\}/);
  assert.match(portalPage, /eclass-input-cell/);
  assert.doesNotMatch(portalPage, /class="eclass-record-badge eclass-record-term"/);
  assert.doesNotMatch(portalPage, /class="eclass-record-badge eclass-record-subject"/);
  assert.doesNotMatch(portalPage, /id="eClassHeading(?:Term|Subject)"/);
  assert.match(portalPage, /id="eClassHeadingMapehGroup" hidden/);
  assert.match(portalPage, /class="eclass-current-selection"><span id="eClassSelectionTerm">Term 1<\/span><span aria-hidden="true">&nbsp;-&nbsp;<\/span><span id="eClassSelectionSubject">Filipino<\/span><\/p>/);
  assert.match(portalPage, /eClassSelectionTerm"\)\.textContent=selectedTerm/);
  assert.match(portalPage, /eClassSelectionSubject"\)\.textContent=selectedSubject/);
  assert.match(portalPage, /eClassRecordHeading"\)\.setAttribute\("aria-label"/);
  assert.match(portalPage, /id="downloadEClass"[^>]*disabled[\s\S]*?Download E-Class/);
  assert.match(portalPage, /class="data-card-header"[\s\S]*?class="eclass-controls"[\s\S]*?id="downloadEClass"/);
  assert.doesNotMatch(portalPage, /eclass-download-footer/);
  assert.match(portalPage, /link\.download=filenameMatch\[1\]/);
  assert.doesNotMatch(portalPage, /E-Class_"\+filenameParts\+"\.csv"/);
  assert.match(portalPage, /control\?control\.value:cell\.textContent\.trim\(\)/);
  assert.match(portalPage, /id="printSF9"[^>]*aria-label="Print the selected learner's SF9 report"[\s\S]*?class="grade-report-icon"[\s\S]*?<span>Print SF9<\/span>/);
  assert.match(portalPage, /id="downloadSF9"[^>]*aria-label="Download the selected learner's SF9 workbook"[\s\S]*?<span>Download SF9<\/span>/);
  assert.match(portalPage, /class="grade-report-actions"[^>]*aria-label="SF9 report actions"[\s\S]*?id="printSF9"[\s\S]*?id="downloadSF9"/);
  assert.match(portalPage, /\.grade-report-actions \.btn\.primary\{background:var\(--accent\);color:var\(--accent-ink\)/);
  assert.match(portalPage, /id="gradeTerm"[\s\S]*?<\/select>\s*<\/div>\s*<div class="form-field grade-student-field">[\s\S]*?<\/div>\s*<div class="grade-report-actions"/);
  assert.match(portalPage, /\$\("printSF9"\)\.disabled=gradeRecordLoading\|\|!gradeRecordAvailable\|\|!\$\("gradeStudent"\)\.value\|\|gradeSaving\|\|gradesDirty/);
  assert.match(portalPage, /\$\("downloadSF9"\)\.disabled=reportUnavailable\|\|\$\("downloadSF9"\)\.getAttribute\("aria-busy"\)==="true"/);
  assert.match(portalPage, /fetch\("\/api\/grades\/sf9\?studentId="\+encodeURIComponent\(studentId\)\)/);
  assert.match(portalPage, /link\.download=filenameMatch\[1\]/);
  assert.match(portalPage, /Could not download the SF9 workbook: "\+error\.message/);
  assert.match(portalPage, /id="gradeCoreGrid"/);
  assert.match(portalPage, /id="gradeMapehGrid"/);
  assert.match(portalPage, /id="gradeCoreGroup" aria-labelledby="gradeCoreTitle"/);
  assert.match(portalPage, /id="gradeMapehGroup" aria-labelledby="gradeMapehTitle" hidden/);
  assert.match(portalPage, /id="gradeGeneralAverageTitle">General Average<\/h3>/);
  assert.match(portalPage, /gradeCoreGrid/);
  assert.match(portalPage, /\.grade-controls\{display:grid;grid-template-columns:minmax\(150px,\.65fr\) minmax\(280px,1\.35fr\) auto/);
  assert.match(portalPage, /var previewUrl="\/api\/grades\/sf9\?studentId="\+encodeURIComponent\(studentId\)\+"&format=preview";\s*var previewWindow=window\.open\(previewUrl,"_blank"\)/,
    "Print SF9 navigates a new tab directly to the authenticated preview route");
  assert.match(portalPage, /if\(!previewWindow\)\{\s*window\.location\.assign\(previewUrl\);\s*return;\s*\}/,
    "Print SF9 still opens when the browser blocks a new preview tab");
  assert.doesNotMatch(portalPage, /previewWindow\.document\.open\(\)|previewWindow\.document\.write\(/,
    "Print SF9 does not rely on writing the fetched preview into a blank popup");
  assert.match(portalPage, /\$\("gradeFields"\)\.disabled=disabled\|\|gradeSaving/);
  assert.match(portalPage, /new Option\("Holiday\/No Class","no-class"\)/);
  assert.match(portalPage, /new Option\("NLS - No longer in school","NLS"\)/);
  assert.match(portalPage, /new Option\("Transferred Out","Transferred Out"\)/);
  assert.match(portalPage, /new Option\("Transferred In","Transferred In"\)/);
  assert.match(portalPage, /className="attendance-status-date"/);
  assert.match(portalPage, /statusDate:student\.statusDate\|\|""/);
  assert.match(portalPage, /id="attendanceSummaryTab"[^>]*>Summary Of Attendance<\/button>/);
  assert.match(portalPage, /id="attendanceSummaryRows"/);
  assert.match(portalPage, /id="navRma"[^>]*>[\s\S]*?RMA/);
  assert.match(portalPage, /id="rmaPage"[\s\S]*?Rapid Mathematics Assessment/);
  assert.doesNotMatch(portalPage, /rma-template-context|rmaSchoolId|rmaSchoolName|rmaTeacherName|rmaGradeSection|rmaEnrolment/);
  assert.doesNotMatch(portalPage, /rma-report-table|rma-progress-table|rma-band-table|rmaReportRows|rmaProgressRows|rmaBandRows/);
  assert.match(portalPage, /id="rmaGradeSelect"/);
  assert.match(portalPage, /id="rmaAssessmentDialog"/);
  assert.match(portalPage, /id="rmaAssessmentForm"/);
  assert.doesNotMatch(portalPage, /className="rma-learner-button"|class="rma-learner-button"/);
  assert.match(portalPage, /addScore\.className="btn rma-add-score"/);
  assert.match(portalPage, /resultRow\.className="rma-result-row"/);
  assert.match(portalPage, /Score: "\+assessment\.rawScore\+" \/ "\+assessment\.totalItems\+" points/);
  const rmaEntryHeader = portalPage.match(/<table class="student-table rma-entry-table">[\s\S]*?<thead><tr>([\s\S]*?)<\/tr><\/thead>/);
  assert.ok(rmaEntryHeader, "RMA assessment entry has a learner list");
  assert.equal(Array.from(rmaEntryHeader[1].matchAll(/<th>/g)).length, 2);
  assert.match(rmaEntryHeader[1], /<th>Learner Name<\/th><th>Action<\/th>/);
  assert.doesNotMatch(rmaEntryHeader[1], /LRN|Sex|Birthdate|Assessment|Score/);
  assert.match(portalPage, /input=item\.maximum===1\?document\.createElement\("input"\):document\.createElement\("select"\)/);
  assert.match(portalPage, /if\(item\.maximum===1\)\{\s*input\.type="checkbox"/);
  assert.match(portalPage, /for\(var point=0;point<=item\.maximum;point\+\+\)/);
  assert.match(portalPage, /input\.value=assessment\.assessedDate\?String\(originalScore\):""/);
  assert.match(portalPage, /function rmaAssessmentScoresFromForm\(includeIncorrectItems\)[\s\S]*?input\.type==="checkbox"&&input\.checked[\s\S]*?input\.tagName==="SELECT"&&input\.value!==""[\s\S]*?Number\(input\.value\)/);
  assert.match(portalPage, /Select only the items this learner answered correctly/);
  assert.doesNotMatch(portalPage, /data-field="itemScore"|input\.type="number";[\s\S]{0,180}data-field="itemScore"/);
  assert.match(portalPage, /id="rmaDomainRows"/);
  assert.doesNotMatch(portalPage, /Per-Learner Results|Progress Over Time|Mastery and Interpretation Bands|id="rmaBandRows"/);
  assert.match(portalPage, /percentage score = total score ÷ the selected grade-level maximum/i);
  assert.match(portalPage, /if\(rmaDirty&&!window\.confirm\("Discard unsaved RMA assessment changes\?"\)\)return;/);
  assert.match(portalPage, /Print \/ Save PDF/);
  assert.match(portalPage, /\.attendance-summary-table th:nth-child\(2\),\.attendance-summary-table td:nth-child\(2\)\{position:sticky;left:48px/);
  assert.match(portalPage, /api\("\/api\/attendance\/summary"\)/);
  assert.doesNotMatch(portalPage, /attendance-quick-check|attendanceQuickDate|attendanceReasonStudent|attendanceReasonEntry|attendanceMarkAllPresent|attendanceQuickProgress/);
  assert.match(portalPage, /class="attendance-guidance" aria-label="Attendance recording guidance"[\s\S]*?Daily attendance marks[\s\S]*?Blank means Present[\s\S]*?CC\/X for Absent/);
  assert.doesNotMatch(portalPage, /Use Quick check to select a school day/);
  assert.match(portalPage, /select\.add\(new Option\("X","AbsentX"\)\)/);
  assert.match(portalPage, /select\.value==="AbsentX"\?"Absent":select\.value/);
  assert.match(portalPage, /attendance-reason-input/);
  assert.match(portalPage, /noClassMark\.textContent="NC"/);
  assert.match(portalPage, /\.attendance-table td\.attendance-no-class-cell\{background:#e6e6e6/);
  assert.match(portalPage, /control\.disabled=isNoClass/);
  assert.match(portalPage, /fetch\("\/api\/attendance\/month\/export\?"\+exportParams\.toString\(\)\)/);
  assert.match(portalPage, /if\(attendanceDirty\)\{[\s\S]*?await \$\("saveAttendance"\)\.onclick\(\);[\s\S]*?if\(attendanceDirty\)return;[\s\S]*?fetch\("\/api\/attendance\/month\/export/);
  assert.match(portalPage, /link\.download=filename;[\s\S]*?link\.click\(\);/);
  assert.ok(portalPage.indexOf('id="navSettings"') > portalPage.indexOf('id="navTeacherProfile"'));
  assert.match(portalPage, /id="settingsPage"/);
  assert.match(portalPage, /id="appearanceSetting"/);
  assert.match(portalPage, /<nav id="parentSidebarNav" aria-label="Learner information navigation" hidden>[\s\S]*?data-parent-target="parentStudentInfo" aria-current="page"[\s\S]*?data-parent-target="parentAttendanceSection"[\s\S]*?data-parent-target="parentReadingSection"[\s\S]*?data-parent-target="parentGradesSection"[\s\S]*?<\/nav>/);
  assert.match(portalPage, /\$\("parentSidebarNav"\)\.hidden=true/);
  assert.match(portalPage, /\$\("parentSidebarNav"\)\.hidden=parentPortal\.learners\.length===0/);
  assert.match(portalPage, /\$\("parentSidebarNav"\)\.hidden=parentPortalData\.learners\.length===0/);
  assert.match(portalPage, /function showParentSection\(targetId\)\{[\s\S]*?section\.hidden=!selected[\s\S]*?button\.setAttribute\("aria-current","page"\)/);
  assert.match(portalPage, /showParentSection\("parentStudentInfo"\)/);
  assert.match(portalPage, /id="parentAttendanceSection" hidden/);
  assert.match(portalPage, /id="parentReadingSection" hidden/);
  assert.match(portalPage, /id="parentGradesSection" hidden/);
  assert.match(portalPage, /id="menuToggle"[^>]*aria-controls="sidebar"/);
  assert.doesNotMatch(portalPage, /parentSectionMenuToggle|parentSectionNav|parent-section-menu|parent-quick-nav/);
  assert.doesNotMatch(portalPage, /class="parent-record-layout"/);
  assert.match(portalPage, /data-parent-target="parentStudentInfo" aria-current="page">[\s\S]*?Student's Information/);
  assert.match(portalPage, /data-parent-target="parentAttendanceSection">[\s\S]*?Attendance/);
  assert.match(portalPage, /data-parent-target="parentReadingSection">[\s\S]*?Reading Progress/);
  assert.match(portalPage, /data-parent-target="parentGradesSection">[\s\S]*?Term Grades/);
  assert.match(portalPage, /BOSY means beginning of school year, MOSY means middle of school year, and EOSY means end of school year/);
  assert.match(portalPage, /parent-reading-grid\{display:grid;width:100%;grid-template-columns:minmax\(0,1fr\);grid-auto-rows:1fr;align-items:stretch/);
  assert.doesNotMatch(portalPage, /parent-reading-grid\{grid-template-columns:repeat\([23],minmax\(0,1fr\)\)/);
  assert.match(portalPage, /parent-reading-period\{display:flex;min-width:0;height:100%;flex-direction:column/);
  assert.match(portalPage, /parent-reading-period\.period-bosy\{--period-color:/);
  assert.match(portalPage, /parent-reading-period\.period-mosy\{--period-color:/);
  assert.match(portalPage, /parent-reading-period\.period-eosy\{--period-color:/);
  assert.match(portalPage, /card\.className="parent-reading-period period-"\+period\.toLowerCase\(\)/);
  assert.match(portalPage, /parent-reading-period h3\{display:inline-flex;align-self:flex-start/);
  assert.match(portalPage, /parent-reading-period-caption/);
  assert.match(portalPage, /id="parentReadingTrendChart" class="parent-reading-trend-chart"/);
  assert.match(portalPage, /id="parentReadingDateTrendChart" class="parent-reading-date-trend-chart"/);
  assert.match(portalPage, /id="parentReadingDateTrendEmpty"/);
  assert.match(portalPage, /id="parentReadingTrendEmpty"/);
  assert.match(portalPage, /function renderParentReadingTrend\(learner\)\{[\s\S]*?class:"parent-reading-trend-series"[\s\S]*?class:"parent-reading-trend-point"/);
  assert.match(portalPage, /parent-reading-date-trend-series/);
  assert.match(portalPage, /parent-reading-date-trend-point/);
  assert.match(portalPage, /function parseReadingDate\(value\)/);
  assert.match(portalPage, /formatReadingDate\(result\.assessedDate\)/);
  assert.match(portalPage, /if\(!point\|\|index===0\|\|!points\[index-1\]\)return/);
  assert.match(portalPage, /chart\.setAttribute\("aria-label","Reading progress by assessment period\. "\+accessibleSummary\.join\("; "\)\)/);
  assert.match(portalPage, /steps\.style\.setProperty\("--reading-progress",Math\.max\(0,levelIndex\)\/\(levels\.length-1\)\*100\+"%"\)/);
  assert.match(portalPage, /if\(index<=levelIndex\)step\.classList\.add\("is-complete"\)/);
  const appearanceOptions = portalPage.match(/id="appearanceSetting">([\s\S]*?)<\/select>/)[1];
  const appearanceValues = Array.from(appearanceOptions.matchAll(/<option value="([^"]+)"/g), (match) => match[1]);
  assert.deepEqual(appearanceValues.slice(0, 3), ["system", "light", "dark"]);
  assert.equal(appearanceValues.length - 3, 20, "Appearance includes 20 custom themes in addition to the standard choices");
  for (const theme of appearanceValues.slice(3)) {
    assert.ok(portalPage.includes(`:root[data-theme="${theme}"]`), `${theme} has a theme palette`);
  }

  const request = (route, body) => fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const teacherCredentials = {
    name: "Taylor Teacher",
    email: "taylor.teacher@example.com",
    password: "secure-pass-123",
    role: "teacher",
    extra: "12",
    grade: "Grade 5",
  };
  const teacherWithoutGrade = await request("/api/auth/register", {
    ...teacherCredentials,
    email: "missing.grade@example.com",
    grade: "",
  });
  assert.equal(teacherWithoutGrade.status, 400);
  assert.match((await teacherWithoutGrade.json()).error, /grade level/i);
  const teacherRegistration = await request("/api/auth/register", teacherCredentials);
  assert.equal(teacherRegistration.status, 201);
  const teacherCookie = teacherRegistration.headers.get("set-cookie").split(";")[0];
  const teacherResult = await teacherRegistration.json();
  assert.equal(teacherResult.user.name, teacherCredentials.name);
  assert.equal(teacherResult.user.role, "teacher");
  assert.equal(teacherResult.user.isAdmin, false);
  assert.match(teacherResult.user.classCode, /^G5-[A-F0-9]{8}$/);
  const registeredTeacherWorkbook = readPortalDatabaseWorkbook(databasePath);
  const registeredTeacherClasses = registeredTeacherWorkbook.getWorksheet("Classes");
  const registeredClassHeaders = new Map();
  registeredTeacherClasses.getRow(1).eachCell((cell, column) => {
    registeredClassHeaders.set(String(cell.value).toLowerCase(), column);
  });
  const registeredTeacherClass = registeredTeacherClasses.getRows(2, registeredTeacherClasses.rowCount - 1)
    .find((row) => String(row.getCell(registeredClassHeaders.get("class code (parents enter this)")).value)
      === teacherResult.user.classCode);
  assert.ok(registeredTeacherClass, "teacher registration creates a classroom");
  assert.equal(registeredTeacherClass.getCell(registeredClassHeaders.get("grade")).value, teacherCredentials.grade);
  const nonAdminClassList = await fetch(`${baseUrl}/api/admin/classes`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(nonAdminClassList.status, 403);

  const profileResponse = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(profileResponse.status, 200);
  assert.deepEqual(await profileResponse.json(), {
    name: teacherCredentials.name,
    email: teacherCredentials.email,
    classroomNumber: "12",
    grade: "Grade 5",
    strand: "",
    section: "",
    sectionsHandled: [],
    sectionGrades: {},
    subjectsHandled: [],
    availableSubjects: [
      "English",
      "Filipino",
      "Mathematics",
      "Science",
      "Araling Panlipunan",
      "EPP",
      "MAPEH",
      "GMRC",
    ],
    gradeSubjects: [
      { key: "english", label: "English" },
      { key: "filipino", label: "Filipino" },
      { key: "mathematics", label: "Mathematics" },
      { key: "science", label: "Science" },
      { key: "aralingPanlipunan", label: "Araling Panlipunan" },
      { key: "epp", label: "EPP" },
      { key: "musicAndArts", label: "Music and Arts" },
      { key: "physicalEducationAndHealth", label: "Physical Education and Health" },
      { key: "gmrc", label: "GMRC" },
    ],
    generalAverageSubjects: [
      "english", "filipino", "mathematics", "science", "aralingPanlipunan", "epp", "mapeh", "gmrc",
    ],
    eClassSubjects: [
      "English", "Filipino", "Mathematics", "Science", "Araling Panlipunan", "EPP", "MAPEH", "GMRC",
    ],
    schoolYear: "",
    schoolName: "",
    schoolId: "",
    region: "",
    division: "",
    district: "",
    position: "",
    schoolHead: "",
    schoolHeadPosition: "",
    hasPhoto: false,
    hasSchoolLogo: false,
  });

  const updateProfile = (cookie, data) => fetch(`${baseUrl}/api/teacher/profile`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(data),
  });
  const updatedProfileResponse = await updateProfile(teacherCookie, {
    name: "Taylor Updated",
    email: "taylor.updated@example.com",
    classroomNumber: "12-A",
    grade: "Grade 5",
    strand: "",
    section: "Mabini",
    sectionsHandled: ["Mabini", "Rizal"],
    subjectsHandled: ["English", "Mathematics"],
    schoolYear: "2026-2027",
    schoolName: "Sample Elementary School",
    schoolId: "123456",
    region: "Region IX",
    division: "Zamboanga City",
    district: "West District",
    position: "Master Teacher I",
    schoolHead: "Alex Principal",
    schoolHeadPosition: "Principal II",
  });
  assert.equal(updatedProfileResponse.status, 200);
  assert.deepEqual(await updatedProfileResponse.json(), {
    name: "Taylor Updated",
    email: "taylor.updated@example.com",
    classroomNumber: "12-A",
    grade: "Grade 5",
    strand: "",
    section: "Mabini",
    sectionsHandled: ["Mabini", "Rizal"],
    sectionGrades: { Mabini: "Grade 5" },
    sectionSubjects: { Mabini: ["English", "Mathematics"] },
    subjectsHandled: ["English", "Mathematics"],
    availableSubjects: [
      "English",
      "Filipino",
      "Mathematics",
      "Science",
      "Araling Panlipunan",
      "EPP",
      "MAPEH",
      "GMRC",
    ],
    gradeSubjects: [
      { key: "english", label: "English" },
      { key: "filipino", label: "Filipino" },
      { key: "mathematics", label: "Mathematics" },
      { key: "science", label: "Science" },
      { key: "aralingPanlipunan", label: "Araling Panlipunan" },
      { key: "epp", label: "EPP" },
      { key: "musicAndArts", label: "Music and Arts" },
      { key: "physicalEducationAndHealth", label: "Physical Education and Health" },
      { key: "gmrc", label: "GMRC" },
    ],
    generalAverageSubjects: [
      "english", "filipino", "mathematics", "science", "aralingPanlipunan", "epp", "mapeh", "gmrc",
    ],
    eClassSubjects: [
      "English", "Filipino", "Mathematics", "Science", "Araling Panlipunan", "EPP", "MAPEH", "GMRC",
    ],
    schoolYear: "2026-2027",
    schoolName: "Sample Elementary School",
    schoolId: "123456",
    region: "Region IX",
    division: "Zamboanga City",
    district: "West District",
    position: "Master Teacher I",
    schoolHead: "Alex Principal",
    schoolHeadPosition: "Principal II",
  });
  const subjectChoices = [
    "Filipino",
    "English",
    "Mathematics",
    "Science",
    "Araling Panlipunan",
    "EPP",
    "MAPEH",
    "GMRC",
  ];
  const saveSubjectsResponse = await fetch(`${baseUrl}/api/teacher/profile/subjects`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ section: "Mabini", subjectsHandled: ["English", "Mathematics"] }),
  });
  assert.equal(saveSubjectsResponse.status, 200);
  assert.deepEqual(await saveSubjectsResponse.json(), {
    section: "Mabini",
    subjectsHandled: ["English", "Mathematics"],
    sectionSubjects: { Mabini: ["English", "Mathematics"] },
  });
  const profileAfterSubjectSave = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: teacherCookie },
  });
  assert.deepEqual((await profileAfterSubjectSave.json()).subjectsHandled, ["English", "Mathematics"]);
  const updatedTeacherLogin = await request("/api/auth/login", {
    email: "taylor.updated@example.com",
    password: teacherCredentials.password,
    role: "teacher",
  });
  assert.equal(updatedTeacherLogin.status, 200);
  const updatedTeacherCookie = updatedTeacherLogin.headers.get("set-cookie").split(";")[0];
  const restoreProfileResponse = await updateProfile(updatedTeacherCookie, {
    name: teacherCredentials.name,
    email: teacherCredentials.email,
    classroomNumber: "12",
    grade: "Grade 5",
    strand: "",
    section: "Mabini",
    sectionsHandled: ["Mabini", "Rizal"],
    subjectsHandled: ["English", "Mathematics"],
    schoolYear: "2026-2027",
    schoolName: "Sample Elementary School",
    schoolId: "123456",
    region: "Region IX",
    division: "Zamboanga City",
    district: "West District",
    position: "Master Teacher I",
    schoolHead: "Alex Principal",
    schoolHeadPosition: "Principal II",
  });
  assert.equal(restoreProfileResponse.status, 200);

  const unauthorizedPhoto = await fetch(`${baseUrl}/api/teacher/profile/photo`);
  assert.equal(unauthorizedPhoto.status, 401);
  const unauthorizedSchoolLogo = await fetch(`${baseUrl}/api/teacher/profile/school-logo`);
  assert.equal(unauthorizedSchoolLogo.status, 401);
  const missingSchoolLogo = await fetch(`${baseUrl}/api/teacher/profile/school-logo`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(missingSchoolLogo.status, 404);
  const missingPhoto = await fetch(`${baseUrl}/api/teacher/profile/photo`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(missingPhoto.status, 404);
  const profilePng = await sharp({
    create: {
      width: 48,
      height: 32,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  }).composite([{
    input: Buffer.from(
      '<svg width="48" height="32"><circle cx="24" cy="16" r="10" fill="#1a5c9c"/></svg>',
    ),
  }]).png().toBuffer();
  const savePhotoResponse = await fetch(`${baseUrl}/api/teacher/profile/photo`, {
    method: "PUT",
    headers: { "Content-Type": "image/png", Cookie: teacherCookie },
    body: profilePng,
  });
  assert.equal(savePhotoResponse.status, 200);
  const getPhotoResponse = await fetch(`${baseUrl}/api/teacher/profile/photo`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(getPhotoResponse.status, 200);
  assert.equal(getPhotoResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await getPhotoResponse.arrayBuffer()), profilePng);
  const profileWithPhoto = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal((await profileWithPhoto.json()).hasPhoto, true);
  const invalidPhotoResponse = await fetch(`${baseUrl}/api/teacher/profile/photo`, {
    method: "PUT",
    headers: { "Content-Type": "image/png", Cookie: teacherCookie },
    body: Buffer.from("not a png"),
  });
  assert.equal(invalidPhotoResponse.status, 400);
  const removePhotoResponse = await fetch(`${baseUrl}/api/teacher/profile/photo`, {
    method: "DELETE",
    headers: { Cookie: teacherCookie },
  });
  assert.equal(removePhotoResponse.status, 200);
  const removedPhotoResponse = await fetch(`${baseUrl}/api/teacher/profile/photo`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(removedPhotoResponse.status, 404);
  const profileWithoutPhoto = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal((await profileWithoutPhoto.json()).hasPhoto, false);
  const saveSchoolLogoResponse = await fetch(`${baseUrl}/api/teacher/profile/school-logo`, {
    method: "PUT",
    headers: { "Content-Type": "image/png", Cookie: teacherCookie },
    body: profilePng,
  });
  assert.equal(saveSchoolLogoResponse.status, 200);
  const getSchoolLogoResponse = await fetch(`${baseUrl}/api/teacher/profile/school-logo`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(getSchoolLogoResponse.status, 200);
  assert.equal(getSchoolLogoResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await getSchoolLogoResponse.arrayBuffer()), profilePng);
  const profileWithSchoolLogo = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal((await profileWithSchoolLogo.json()).hasSchoolLogo, true);
  const invalidSchoolLogoResponse = await fetch(`${baseUrl}/api/teacher/profile/school-logo`, {
    method: "PUT",
    headers: { "Content-Type": "image/png", Cookie: teacherCookie },
    body: Buffer.from("not a png"),
  });
  assert.equal(invalidSchoolLogoResponse.status, 400);
  const removeSchoolLogoResponse = await fetch(`${baseUrl}/api/teacher/profile/school-logo`, {
    method: "DELETE",
    headers: { Cookie: teacherCookie },
  });
  assert.equal(removeSchoolLogoResponse.status, 200);
  const removedSchoolLogoResponse = await fetch(`${baseUrl}/api/teacher/profile/school-logo`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(removedSchoolLogoResponse.status, 404);
  const profileWithoutSchoolLogo = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal((await profileWithoutSchoolLogo.json()).hasSchoolLogo, false);
  const persistSchoolLogoResponse = await fetch(`${baseUrl}/api/teacher/profile/school-logo`, {
    method: "PUT",
    headers: { "Content-Type": "image/png", Cookie: teacherCookie },
    body: profilePng,
  });
  assert.equal(persistSchoolLogoResponse.status, 200);
  const incorrectCurrentPassword = await fetch(`${baseUrl}/api/teacher/profile/password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      currentPassword: "incorrect-password",
      newPassword: "updated-secure-pass-456",
    }),
  });
  assert.equal(incorrectCurrentPassword.status, 400);
  const updatedPassword = "updated-secure-pass-456";
  const updatePasswordResponse = await fetch(`${baseUrl}/api/teacher/profile/password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      currentPassword: teacherCredentials.password,
      newPassword: updatedPassword,
    }),
  });
  assert.equal(updatePasswordResponse.status, 200);
  const oldPasswordLogin = await request("/api/auth/login", {
    email: teacherCredentials.email,
    password: teacherCredentials.password,
    role: "teacher",
  });
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await request("/api/auth/login", {
    email: teacherCredentials.email,
    password: updatedPassword,
    role: "teacher",
  });
  assert.equal(newPasswordLogin.status, 200);
  teacherCredentials.password = updatedPassword;

  const studentDetails = {
    lrn: "123456789012",
    lastName: "Santos",
    firstName: "Alex",
    middleName: "Reyes",
    gender: "Female",
    birthdate: "2015-04-21",
    mothersMaidenName: "Cruz",
    guardianRelationship: "Aunt",
    father: "Jordan Santos",
    currentResidence: "Barangay Central",
    religion: "Catholic",
    motherTongue: "Cebuano",
    dialects: "Chavacano",
    ethnicities: "Filipino",
  };
  const unauthenticatedStudents = await fetch(`${baseUrl}/api/students`);
  assert.equal(unauthenticatedStudents.status, 401);
  const unauthenticatedSF8Export = await fetch(`${baseUrl}/api/students/nutritional-status/sf8`);
  assert.equal(unauthenticatedSF8Export.status, 401);

  const invalidStudentSection = await fetch(`${baseUrl}/api/students`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ ...studentDetails, section: "Unmanaged Section" }),
  });
  assert.equal(invalidStudentSection.status, 400);
  assert.match((await invalidStudentSection.json()).error, /sections handled/i);
  const addStudent = await fetch(`${baseUrl}/api/students`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify(studentDetails),
  });
  assert.equal(addStudent.status, 201);
  const addedStudent = await addStudent.json();
  assert.equal(addedStudent.student.firstName, studentDetails.firstName);
  assert.equal(addedStudent.student.birthdate, studentDetails.birthdate);
  assert.equal(addedStudent.student.section, "Mabini");
  const sectionRosterResponse = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(sectionRosterResponse.status, 200);
  const sectionRoster = await sectionRosterResponse.json();
  assert.deepEqual(sectionRoster.sectionsHandled, ["Mabini", "Rizal"]);
  assert.equal(sectionRoster.students.find(({ id }) => id === addedStudent.student.id).section, "Mabini");

  const addSectionResponse = await fetch(`${baseUrl}/api/teacher/sections`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ sectionName: "Bonifacio", grade: "Grade 6" }),
  });
  assert.equal(addSectionResponse.status, 201);
  assert.deepEqual(await addSectionResponse.json(), {
    sectionsHandled: ["Mabini", "Rizal", "Bonifacio"],
    sectionGrades: { Mabini: "Grade 5", Bonifacio: "Grade 6" },
  });
  const duplicateSectionResponse = await fetch(`${baseUrl}/api/teacher/sections`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ sectionName: "bonifacio", grade: "Grade 6" }),
  });
  assert.equal(duplicateSectionResponse.status, 409);
  const missingSectionGradeResponse = await fetch(`${baseUrl}/api/teacher/sections`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ sectionName: "New Section", grade: "" }),
  });
  assert.equal(missingSectionGradeResponse.status, 400);

  const invalidNutritionalMeasurement = await fetch(
    `${baseUrl}/api/students/${encodeURIComponent(addedStudent.student.id)}/nutritional-status`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({ measurementDate: "2025-04-21", weightKg: 42, heightM: 0 }),
    },
  );
  assert.equal(invalidNutritionalMeasurement.status, 400);
  const preBirthNutritionalMeasurement = await fetch(
    `${baseUrl}/api/students/${encodeURIComponent(addedStudent.student.id)}/nutritional-status`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({ measurementDate: "2015-04-20", weightKg: 42, heightM: 1.4 }),
    },
  );
  assert.equal(preBirthNutritionalMeasurement.status, 400);
  const unmeasuredSF8Export = await fetch(`${baseUrl}/api/students/nutritional-status/sf8`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(unmeasuredSF8Export.status, 200);
  assert.equal(unmeasuredSF8Export.headers.get("x-incomplete-measurement-count"), "1");
  const unmeasuredSF8Workbook = new ExcelJS.Workbook();
  await unmeasuredSF8Workbook.xlsx.load(Buffer.from(await unmeasuredSF8Export.arrayBuffer()));
  const unmeasuredSF8Sheet = unmeasuredSF8Workbook.getWorksheet("Nutritional Status");
  let unmeasuredFemaleHeaderRow = 0;
  for (let row = 1; row <= unmeasuredSF8Sheet.rowCount; row += 1) {
    if (unmeasuredSF8Sheet.getCell(row, 1).value === "FEMALE") {
      unmeasuredFemaleHeaderRow = row;
      break;
    }
  }
  const unmeasuredFemaleRow = unmeasuredFemaleHeaderRow + 1;
  assert.equal(unmeasuredSF8Sheet.getCell(`C${unmeasuredFemaleRow}`).value, "Santos, Alex Reyes");
  assert.equal(unmeasuredSF8Sheet.getCell(`I${unmeasuredFemaleRow}`).value, null);
  assert.equal(unmeasuredSF8Sheet.getCell(`J${unmeasuredFemaleRow}`).value, null);
  assert.equal(unmeasuredSF8Sheet.getCell(`L${unmeasuredFemaleRow}`).value, null);
  let unmeasuredAssessmentDateRow = 0;
  for (let row = 1; row <= unmeasuredSF8Sheet.rowCount; row += 1) {
    if (unmeasuredSF8Sheet.getCell(row, 1).value === "Date of Assessment:") {
      unmeasuredAssessmentDateRow = row;
      break;
    }
  }
  const today = new Date();
  const expectedAssessmentDate = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  assert.equal(
    unmeasuredSF8Sheet.getCell(unmeasuredAssessmentDateRow, 2).value,
    `${expectedAssessmentDate.slice(5, 7)}/${expectedAssessmentDate.slice(8, 10)}/${expectedAssessmentDate.slice(0, 4)}`,
  );
  const savedNutritionalMeasurement = await fetch(
    `${baseUrl}/api/students/${encodeURIComponent(addedStudent.student.id)}/nutritional-status`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({
        measurementDate: "2025-04-21",
        weightKg: 42,
        heightM: 1.4,
      }),
    },
  );
  assert.equal(savedNutritionalMeasurement.status, 200);
  const savedMeasurement = await savedNutritionalMeasurement.json();
  assert.deepEqual({
    studentId: savedMeasurement.studentId,
    measurementDate: savedMeasurement.measurementDate,
    weightKg: savedMeasurement.weightKg,
    heightM: savedMeasurement.heightM,
    heightSquaredM2: savedMeasurement.heightSquaredM2,
    bmi: savedMeasurement.bmi,
    bmiCategory: savedMeasurement.bmiCategory,
    baz: savedMeasurement.baz,
    heightForAgeStatus: savedMeasurement.heightForAgeStatus,
    haz: savedMeasurement.haz,
  }, {
    studentId: addedStudent.student.id,
    measurementDate: "2025-04-21",
    weightKg: 42,
    heightM: 1.4,
    heightSquaredM2: 1.96,
    bmi: 21.43,
    bmiCategory: "Overweight",
    baz: 1.72,
    heightForAgeStatus: "Normal",
    haz: 0.21,
  });
  const rosterWithNutritionalMeasurement = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(rosterWithNutritionalMeasurement.status, 200);
  const nutritionalRoster = (await rosterWithNutritionalMeasurement.json()).students;
  const savedRosterStudent = nutritionalRoster
    .find(({ id }) => id === addedStudent.student.id);
  assert.equal(savedRosterStudent.weightKg, 42);
  assert.equal(savedRosterStudent.heightM, 1.4);
  assert.equal(savedRosterStudent.measurementDate, "2025-04-21");
  assert.equal(savedRosterStudent.bmiCategory, "Overweight");
  assert.equal(savedRosterStudent.heightForAgeStatus, "Normal");
  assert.equal(savedRosterStudent.haz, 0.21);
  assert.equal(savedRosterStudent.heightM, 1.4);
  assert.equal(savedRosterStudent.heightSquaredM2, 1.96);
  assert.equal(savedRosterStudent.bmi, 21.43);
  const invalidSF8AssessmentDate = await fetch(
    `${baseUrl}/api/students/nutritional-status/sf8?assessmentDate=2025-02-31`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(invalidSF8AssessmentDate.status, 400);
  assert.match((await invalidSF8AssessmentDate.json()).error, /valid date of assessment/i);
  const sf8Export = await fetch(
    `${baseUrl}/api/students/nutritional-status/sf8?assessmentDate=2025-04-21`,
    {
    headers: { Cookie: teacherCookie },
    },
  );
  assert.equal(sf8Export.status, 200);
  assert.match(sf8Export.headers.get("content-type") || "", /spreadsheetml\.sheet/);
  assert.match(sf8Export.headers.get("content-disposition") || "", /filename="SF8_/);
  const sf8ReportPath = sf8Export.headers.get("x-generated-file-path");
  assert.equal(path.dirname(sf8ReportPath), generatedReportsDirectory);
  const sf8ReportBuffer = Buffer.from(await sf8Export.arrayBuffer());
  assert.deepEqual(await fs.readFile(sf8ReportPath), sf8ReportBuffer);
  const sf8Workbook = new ExcelJS.Workbook();
  await sf8Workbook.xlsx.load(sf8ReportBuffer);
  const sf8Sheet = sf8Workbook.getWorksheet("Nutritional Status");
  assert.ok(sf8Sheet);
  const sourceSF8Workbook = new ExcelJS.Workbook();
  await sourceSF8Workbook.xlsx.readFile(path.join(__dirname, "..", "SF8.xlsx"));
  const sourceSF8Sheet = sourceSF8Workbook.getWorksheet("Nutritional Status");
  assert.deepEqual(sf8Sheet.pageSetup, sourceSF8Sheet.pageSetup);
  assert.deepEqual(sf8Sheet.pageSetup.margins, sourceSF8Sheet.pageSetup.margins);
  assert.deepEqual(sf8Sheet.columns.map((column) => column.width), sourceSF8Sheet.columns.map((column) => column.width));
  const sf8MaleCount = nutritionalRoster.filter(({ gender }) => gender === "Male").length;
  const sf8MaleStudents = nutritionalRoster.filter(({ gender }) => gender === "Male");
  const sf8FemaleStudents = nutritionalRoster.filter(({ gender }) => gender === "Female");
  const sf8FemaleCount = sf8FemaleStudents.length;
  const sf8FemaleFirstRow = 20 + sf8MaleCount - 7;
  const sf8SummaryHeaderRow = 24 + sf8MaleCount - 7 + sf8FemaleCount - 3;
  const sf8FooterDelta = sf8SummaryHeaderRow - 24;
  const sf8FemaleStudentRow = sf8FemaleFirstRow
    + sf8FemaleStudents.findIndex(({ id }) => id === addedStudent.student.id);
  assert.equal(
    sf8Sheet.getCell(19 + sf8MaleCount - 7, 1).value,
    "FEMALE",
  );
  assert.equal(sf8Sheet.getCell(sf8SummaryHeaderRow, 1).value, "SUMMARY TABLE");
  assert.equal(sf8Sheet.getCell(32 + sf8FooterDelta, 1).value, "Date of Assessment:");
  assert.equal(
    sf8Sheet.getCell(32 + sf8FooterDelta, 2).value,
    "04/21/2025",
  );
  assert.deepEqual(
    sf8Sheet.getCell(32 + sf8FooterDelta, 2).style,
    sourceSF8Sheet.getCell("B32").style,
  );
  assert.equal(sf8Sheet.getCell(`C${sf8FemaleStudentRow}`).value, "Santos, Alex Reyes");
  assert.equal(sf8Sheet.getCell(`D${sf8FemaleStudentRow}`).master.address, `C${sf8FemaleStudentRow}`);
  assert.deepEqual(
    sf8Sheet.getCell(`C${sf8FemaleStudentRow}`).style,
    sourceSF8Sheet.getCell("C20").style,
  );
  assert.equal(sf8Sheet.getCell(`H${sf8FemaleStudentRow}`).value, 10);
  assert.equal(sf8Sheet.getCell(`I${sf8FemaleStudentRow}`).value, 42);
  assert.equal(sf8Sheet.getCell(`J${sf8FemaleStudentRow}`).value, 1.4);
  assert.equal(sf8Sheet.getCell(`K${sf8FemaleStudentRow}`).value, 1.96);
  assert.equal(sf8Sheet.getCell(`L${sf8FemaleStudentRow}`).value, 21.43);
  assert.equal(sf8Sheet.getCell(`M${sf8FemaleStudentRow}`).value, "Overweight");
  assert.equal(sf8Sheet.getCell(`N${sf8FemaleStudentRow}`).value, "Normal");
  assert.equal(sf8Sheet.getCell(32 + sf8FooterDelta, 5).value, "Conducted/Assessed By:");
  assert.equal(sf8Sheet.getCell(32 + sf8FooterDelta, 13).value, "Checked and Reviewed By:");
  assert.equal(sf8Sheet.getCell(34 + sf8FooterDelta, 5).value, teacherCredentials.name);
  assert.equal(sf8Sheet.getCell(35 + sf8FooterDelta, 5).value, "Master Teacher I");
  assert.equal(sf8Sheet.getCell(34 + sf8FooterDelta, 13).value, "Alex Principal");
  assert.equal(sf8Sheet.getCell(35 + sf8FooterDelta, 13).value, "Principal II");
  const measuredCount = (group) => group.filter((student) =>
    student.measurementDate && student.weightKg && student.heightM).length;
  const overweightCount = (group) => group.filter((student) =>
    student.measurementDate && student.bmiCategory === "Overweight").length;
  const normalHeightCount = (group) => group.filter((student) =>
    student.measurementDate && student.heightForAgeStatus === "Normal").length;
  for (const [row, group] of [
    [sf8SummaryHeaderRow + 4, sf8MaleStudents],
    [sf8SummaryHeaderRow + 5, sf8FemaleStudents],
    [sf8SummaryHeaderRow + 6, nutritionalRoster],
  ]) {
    assert.equal(sf8Sheet.getCell(`G${row}`).value, overweightCount(group));
    assert.equal(sf8Sheet.getCell(`I${row}`).value, measuredCount(group));
    assert.equal(sf8Sheet.getCell(`L${row}`).value, normalHeightCount(group));
    assert.equal(sf8Sheet.getCell(`N${row}`).value, normalHeightCount(group));
  }

  const secondTeacherCredentials = {
    name: "Morgan Teacher",
    email: "morgan.teacher@example.com",
    password: "second-secure-pass-123",
    role: "teacher",
    extra: "13",
    grade: "Grade 6",
  };
  const secondTeacherRegistration = await request("/api/auth/register", secondTeacherCredentials);
  assert.equal(secondTeacherRegistration.status, 201);
  const secondTeacherCookie = secondTeacherRegistration.headers.get("set-cookie").split(";")[0];
  const secondStudentResponse = await fetch(`${baseUrl}/api/students`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: secondTeacherCookie },
    body: JSON.stringify({
      lrn: "987654321098",
      lastName: "Garcia",
      firstName: "Casey",
      gender: "Male",
      birthdate: "2015-09-18",
    }),
  });
  assert.equal(secondStudentResponse.status, 201);
  const secondStudent = await secondStudentResponse.json();
  const crossClassNutritionalMeasurement = await fetch(
    `${baseUrl}/api/students/${encodeURIComponent(secondStudent.student.id)}/nutritional-status`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({
        measurementDate: "2025-04-21",
        weightKg: 40,
        heightM: 1.4,
      }),
    },
  );
  assert.equal(crossClassNutritionalMeasurement.status, 404);
  const resetTestParentCredentials = {
    name: "Password Reset Parent",
    email: "password.reset.parent@example.com",
    password: "parent-original-password-123",
    role: "parent",
    extra: teacherResult.user.classCode,
  };
  const resetTestParentRegistration = await request("/api/auth/register", resetTestParentCredentials);
  assert.equal(resetTestParentRegistration.status, 201);
  const resetTestParentCookie = resetTestParentRegistration.headers.get("set-cookie").split(";")[0];
  const nonAdminAccountList = await fetch(`${baseUrl}/api/admin/accounts`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(nonAdminAccountList.status, 403);
  const nonAdminPasswordReset = await fetch(`${baseUrl}/api/admin/accounts/T999/password`, {
    method: "PUT",
    headers: { Cookie: teacherCookie },
  });
  assert.equal(nonAdminPasswordReset.status, 403);

  const adminSetupWorkbook = readPortalDatabaseWorkbook(databasePath);
  const adminSetupUsers = adminSetupWorkbook.getWorksheet("Users");
  const adminSetupHeaders = new Map(
    adminSetupUsers.getRow(1).values.slice(1).map((value, index) => [String(value).toLowerCase(), index + 1]),
  );
  const adminAccessColumn = adminSetupHeaders.get("admin access") || adminSetupUsers.getRow(1).cellCount + 1;
  adminSetupUsers.getRow(1).getCell(adminAccessColumn).value = "Admin Access";
  let promotedAccountFound = false;
  let promotedSecondAccountFound = false;
  for (let rowNumber = 2; rowNumber <= adminSetupUsers.rowCount; rowNumber += 1) {
    const account = adminSetupUsers.getRow(rowNumber);
    const email = String(account.getCell(adminSetupHeaders.get("email")).value).toLowerCase();
    if (email === teacherCredentials.email) {
      account.getCell(adminAccessColumn).value = "true";
      promotedAccountFound = true;
    } else if (email === secondTeacherCredentials.email) {
      account.getCell(adminAccessColumn).value = "true";
      promotedSecondAccountFound = true;
    }
  }
  assert.equal(promotedAccountFound, true, "the teacher account is promoted for the admin integration test");
  assert.equal(promotedSecondAccountFound, true, "a second admin is available for last-admin protection tests");
  writePortalDatabaseWorkbook(databasePath, adminSetupWorkbook);
  const adminLogin = await request("/api/auth/login", {
    email: teacherCredentials.email,
    password: teacherCredentials.password,
    role: "teacher",
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];
  const adminLoginUser = (await adminLogin.json()).user;
  assert.equal(adminLoginUser.role, "teacher", "admin access does not replace Teacher portal access");
  assert.equal(adminLoginUser.isAdmin, true);
  const secondAdminLogin = await request("/api/auth/login", {
    email: secondTeacherCredentials.email,
    password: secondTeacherCredentials.password,
    role: "teacher",
  });
  assert.equal(secondAdminLogin.status, 200);
  const secondAdminCookie = secondAdminLogin.headers.get("set-cookie").split(";")[0];
  const adminSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: adminCookie },
  });
  const adminSession = await adminSessionResponse.json();
  assert.equal(adminSession.user.role, "teacher");
  assert.equal(adminSession.user.isAdmin, true);
  const adminClassListResponse = await fetch(`${baseUrl}/api/admin/classes`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(adminClassListResponse.status, 200);
  const adminClassList = await adminClassListResponse.json();
  assert.equal(adminClassList.classes.length, 2);
  const otherClass = adminClassList.classes.find((classroom) => classroom.id !== adminSession.user.activeClassId);
  assert.ok(otherClass, "admin can select another teacher's class");
  const activateOtherClass = await fetch(`${baseUrl}/api/admin/active-class`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ classId: otherClass.id }),
  });
  assert.equal(activateOtherClass.status, 200);
  const crossClassStudents = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(crossClassStudents.status, 200);
  assert.deepEqual((await crossClassStudents.json()).students.map((student) => student.id), [secondStudent.student.id]);
  const adminOwnProfile = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal((await adminOwnProfile.json()).email, teacherCredentials.email, "class switching does not change the admin's own profile");
  const adminAccountsResponse = await fetch(`${baseUrl}/api/admin/accounts`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(adminAccountsResponse.status, 200);
  const adminAccounts = await adminAccountsResponse.json();
  assert.equal(adminAccounts.accounts.find((account) => account.email === teacherCredentials.email).isAdmin, true);
  const secondAdminDeactivateFirst = await fetch(
    `${baseUrl}/api/admin/accounts/${encodeURIComponent(adminSession.user.userId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: secondAdminCookie },
      body: JSON.stringify({ status: "Inactive" }),
    },
  );
  assert.equal(secondAdminDeactivateFirst.status, 200);
  const preventLastAdminDeactivation = await fetch(
    `${baseUrl}/api/admin/accounts/${encodeURIComponent(otherClass.teacherId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ status: "Inactive" }),
    },
  );
  assert.equal(preventLastAdminDeactivation.status, 400, "the last active administrator cannot be deactivated");
  const secondAdminReactivateFirst = await fetch(
    `${baseUrl}/api/admin/accounts/${encodeURIComponent(adminSession.user.userId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: secondAdminCookie },
      body: JSON.stringify({ status: "Active" }),
    },
  );
  assert.equal(secondAdminReactivateFirst.status, 200);
  const deactivateSecondAdmin = await fetch(
    `${baseUrl}/api/admin/accounts/${encodeURIComponent(otherClass.teacherId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ status: "Inactive" }),
    },
  );
  assert.equal(deactivateSecondAdmin.status, 200);
  const reactivateSecondAdmin = await fetch(
    `${baseUrl}/api/admin/accounts/${encodeURIComponent(otherClass.teacherId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ status: "Active" }),
    },
  );
  assert.equal(reactivateSecondAdmin.status, 200);
  const resetSecondAdminPassword = await fetch(
    `${baseUrl}/api/admin/accounts/${encodeURIComponent(otherClass.teacherId)}/password`,
    {
      method: "PUT",
      headers: { Cookie: adminCookie },
    },
  );
  assert.equal(resetSecondAdminPassword.status, 200);
  assert.equal((await resetSecondAdminPassword.json()).mustChangePassword, true);
  const invalidatedSecondAdminSession = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: secondAdminCookie },
  });
  assert.equal(invalidatedSecondAdminSession.status, 401, "password reset invalidates existing sessions");
  const forcedPasswordLogin = await request("/api/auth/login", {
    email: secondTeacherCredentials.email,
    password: secondTeacherCredentials.email,
    role: "teacher",
  });
  assert.equal(forcedPasswordLogin.status, 200);
  const forcedPasswordCookie = forcedPasswordLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await forcedPasswordLogin.json()).user.mustChangePassword, true);
  const forcedPasswordSessionResponse = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: forcedPasswordCookie },
  });
  assert.equal((await forcedPasswordSessionResponse.json()).user.mustChangePassword, true);
  const blockedAdminEndpoint = await fetch(`${baseUrl}/api/admin/classes`, {
    headers: { Cookie: forcedPasswordCookie },
  });
  assert.equal(blockedAdminEndpoint.status, 403, "forced password change blocks all portal data");
  const unchangedTemporaryPassword = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: forcedPasswordCookie },
    body: JSON.stringify({
      currentPassword: secondTeacherCredentials.email,
      newPassword: secondTeacherCredentials.email,
    }),
  });
  assert.equal(unchangedTemporaryPassword.status, 400);
  const changedTemporaryPassword = "second-admin-new-password-456";
  const finishForcedPasswordChange = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: forcedPasswordCookie },
    body: JSON.stringify({
      currentPassword: secondTeacherCredentials.email,
      newPassword: changedTemporaryPassword,
    }),
  });
  assert.equal(finishForcedPasswordChange.status, 200);
  const completedForcedPasswordSession = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: forcedPasswordCookie },
  });
  assert.equal((await completedForcedPasswordSession.json()).user.mustChangePassword, false);
  const restoredAdminEndpoint = await fetch(`${baseUrl}/api/admin/classes`, {
    headers: { Cookie: forcedPasswordCookie },
  });
  assert.equal(restoredAdminEndpoint.status, 200, "portal access resumes after changing the temporary password");
  const rejectedTemporaryPassword = await request("/api/auth/login", {
    email: secondTeacherCredentials.email,
    password: secondTeacherCredentials.email,
    role: "teacher",
  });
  assert.equal(rejectedTemporaryPassword.status, 401);
  secondTeacherCredentials.password = changedTemporaryPassword;
  const resetTestParent = adminAccounts.accounts.find((account) => account.email === resetTestParentCredentials.email);
  assert.ok(resetTestParent, "parent login account is visible to the administrator");
  const resetParentPassword = await fetch(
    `${baseUrl}/api/admin/accounts/${encodeURIComponent(resetTestParent.id)}/password`,
    {
      method: "PUT",
      headers: { Cookie: adminCookie },
    },
  );
  assert.equal(resetParentPassword.status, 200);
  const invalidatedParentSession = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { Cookie: resetTestParentCookie },
  });
  assert.equal(invalidatedParentSession.status, 401);
  const forcedParentLogin = await request("/api/auth/login", {
    email: resetTestParentCredentials.email,
    password: resetTestParentCredentials.email,
    role: "parent",
  });
  assert.equal(forcedParentLogin.status, 200);
  const forcedParentCookie = forcedParentLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await forcedParentLogin.json()).user.mustChangePassword, true);
  const blockedParentPortal = await fetch(`${baseUrl}/api/parent/portal`, {
    headers: { Cookie: forcedParentCookie },
  });
  assert.equal(blockedParentPortal.status, 403);
  const completeParentPasswordChange = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: forcedParentCookie },
    body: JSON.stringify({
      currentPassword: resetTestParentCredentials.email,
      newPassword: "parent-new-password-456",
    }),
  });
  assert.equal(completeParentPasswordChange.status, 200);
  const availableParentPortal = await fetch(`${baseUrl}/api/parent/portal`, {
    headers: { Cookie: forcedParentCookie },
  });
  assert.equal(availableParentPortal.status, 200, "parent access resumes after changing the temporary password");
  resetTestParentCredentials.password = "parent-new-password-456";
  const restoreAdminClass = await fetch(`${baseUrl}/api/admin/active-class`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({ classId: adminSession.user.activeClassId }),
  });
  assert.equal(restoreAdminClass.status, 200);
  const adminSelfDeactivate = await fetch(
    `${baseUrl}/api/admin/accounts/${encodeURIComponent(adminSession.user.userId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: adminCookie },
      body: JSON.stringify({ status: "Inactive" }),
    },
  );
  assert.equal(adminSelfDeactivate.status, 400, "admin cannot deactivate their own account");
  const adminSelfPasswordReset = await fetch(
    `${baseUrl}/api/admin/accounts/${encodeURIComponent(adminSession.user.userId)}/password`,
    {
      method: "PUT",
      headers: { Cookie: adminCookie },
    },
  );
  assert.equal(adminSelfPasswordReset.status, 400, "admin cannot reset their own password through account management");

  const adminTestCleanupWorkbook = readPortalDatabaseWorkbook(databasePath);
  const cleanupUsers = adminTestCleanupWorkbook.getWorksheet("Users");
  const cleanupUserHeaders = new Map();
  cleanupUsers.getRow(1).eachCell((cell, column) => cleanupUserHeaders.set(String(cell.value).toLowerCase(), column));
  for (let rowNumber = cleanupUsers.rowCount; rowNumber >= 2; rowNumber -= 1) {
    const account = cleanupUsers.getRow(rowNumber);
    if (String(account.getCell(cleanupUserHeaders.get("user id")).value) === otherClass.teacherId) {
      cleanupUsers.spliceRows(rowNumber, 1);
    } else if (String(account.getCell(cleanupUserHeaders.get("email")).value).toLowerCase() === resetTestParentCredentials.email) {
      cleanupUsers.spliceRows(rowNumber, 1);
    } else if (String(account.getCell(cleanupUserHeaders.get("email")).value).toLowerCase() === teacherCredentials.email) {
      account.getCell(cleanupUserHeaders.get("admin access")).value = "false";
    }
  }
  const cleanupClasses = adminTestCleanupWorkbook.getWorksheet("Classes");
  const cleanupClassHeaders = new Map();
  cleanupClasses.getRow(1).eachCell((cell, column) => cleanupClassHeaders.set(String(cell.value).toLowerCase(), column));
  for (let rowNumber = cleanupClasses.rowCount; rowNumber >= 2; rowNumber -= 1) {
    const cleanupClass = cleanupClasses.getRow(rowNumber);
    const classId = String(cleanupClass.getCell(cleanupClassHeaders.get("class id")).value);
    if (classId === otherClass.id) {
      cleanupClasses.spliceRows(rowNumber, 1);
    } else if (classId === adminSession.user.activeClassId) {
      const parentCountColumn = cleanupClassHeaders.get("parents signed up");
      const parentCount = Number(cleanupClass.getCell(parentCountColumn).value) || 0;
      cleanupClass.getCell(parentCountColumn).value = Math.max(0, parentCount - 1);
    }
  }
  const cleanupStudents = adminTestCleanupWorkbook.getWorksheet("Students");
  const cleanupStudentHeaders = new Map();
  cleanupStudents.getRow(1).eachCell((cell, column) => cleanupStudentHeaders.set(String(cell.value).toLowerCase(), column));
  for (let rowNumber = cleanupStudents.rowCount; rowNumber >= 2; rowNumber -= 1) {
    if (String(cleanupStudents.getRow(rowNumber).getCell(cleanupStudentHeaders.get("student id")).value) === secondStudent.student.id) {
      cleanupStudents.spliceRows(rowNumber, 1);
    }
  }
  writePortalDatabaseWorkbook(databasePath, adminTestCleanupWorkbook);

  const legacyRosterWorkbook = readPortalDatabaseWorkbook(databasePath);
  const legacyStudentsSheet = legacyRosterWorkbook.getWorksheet("Students");
  const usersSheet = legacyRosterWorkbook.getWorksheet("Users");
  const userHeaders = new Map();
  usersSheet.getRow(1).eachCell((cell, column) => {
    userHeaders.set(String(cell.value).toLowerCase(), column);
  });
  let registeredTeacherId = "";
  for (let rowNumber = 2; rowNumber <= usersSheet.rowCount; rowNumber += 1) {
    const row = usersSheet.getRow(rowNumber);
    if (String(row.getCell(userHeaders.get("email")).value).toLowerCase() === teacherCredentials.email) {
      registeredTeacherId = String(row.getCell(userHeaders.get("user id")).value);
      break;
    }
  }
  assert.ok(registeredTeacherId, "registered teacher has a workbook user id");
  const legacyHeaders = new Map();
  legacyStudentsSheet.getRow(1).eachCell((cell, column) => {
    legacyHeaders.set(String(cell.value).toLowerCase(), column);
  });
  const teacherUserIdColumn = legacyHeaders.get("teacher user id") || legacyHeaders.get("teacher id");
  assert.ok(teacherUserIdColumn, "student worksheet has a teacher ownership column");
  for (let rowNumber = 2; rowNumber <= legacyStudentsSheet.rowCount; rowNumber += 1) {
    const row = legacyStudentsSheet.getRow(rowNumber);
    if (String(row.getCell(1).value) === addedStudent.student.id) {
      row.getCell(teacherUserIdColumn).value = null;
      break;
    }
  }
  writePortalDatabaseWorkbook(databasePath, legacyRosterWorkbook);
  const legacyRosterResponse = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(legacyRosterResponse.status, 200);
  assert.deepEqual((await legacyRosterResponse.json()).students.map(({ id }) => id), [addedStudent.student.id]);
  for (let rowNumber = 2; rowNumber <= legacyStudentsSheet.rowCount; rowNumber += 1) {
    const row = legacyStudentsSheet.getRow(rowNumber);
    if (String(row.getCell(1).value) === addedStudent.student.id) {
      row.getCell(teacherUserIdColumn).value = registeredTeacherId;
      break;
    }
  }
  writePortalDatabaseWorkbook(databasePath, legacyRosterWorkbook);

  const philIriHeaders = { "Content-Type": "application/json", Cookie: teacherCookie };
  const philIriSettings = await fetch(`${baseUrl}/api/phil-iri/settings`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(philIriSettings.status, 200);
  const defaultPhilIriSettings = await philIriSettings.json();
  assert.deepEqual(defaultPhilIriSettings.grades, ["Grade 4", "Grade 5", "Grade 6"]);
  assert.deepEqual(defaultPhilIriSettings.languages, ["English", "Filipino"]);
  assert.ok(defaultPhilIriSettings.interventions.includes("Guided Reading"));
  assert.equal(defaultPhilIriSettings.scoringGuide.grade, "Grade 5");
  assert.equal(defaultPhilIriSettings.scoringGuide.totalItems, 20);
  assert.equal(defaultPhilIriSettings.scoringGuide.passingScore, 14);
  const philIriCutoffs = {
    "Grade 4": { English: 12, Filipino: 13 },
    "Grade 5": { English: 15, Filipino: 16 },
    "Grade 6": { English: 18, Filipino: 19 },
  };
  const savePhilIriCutoffs = await fetch(`${baseUrl}/api/phil-iri/settings`, {
    method: "PUT",
    headers: philIriHeaders,
    body: JSON.stringify({ cutoffs: philIriCutoffs }),
  });
  assert.equal(savePhilIriCutoffs.status, 200);
  const savedPhilIriSettings = await (await fetch(`${baseUrl}/api/phil-iri/settings`, {
    headers: { Cookie: teacherCookie },
  })).json();
  assert.deepEqual(savedPhilIriSettings.cutoffs, philIriCutoffs);
  const invalidPhilIriCutoffs = await fetch(`${baseUrl}/api/phil-iri/settings`, {
    method: "PUT",
    headers: philIriHeaders,
    body: JSON.stringify({ cutoffs: { ...philIriCutoffs, "Grade 5": { English: 15, Filipino: 16.5 } } }),
  });
  assert.equal(invalidPhilIriCutoffs.status, 400);

  const philIriAssessment = (values) => fetch(`${baseUrl}/api/phil-iri/assessments`, {
    method: "POST",
    headers: philIriHeaders,
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      assessmentType: "Pretest",
      language: "English",
      assessedDate: "2026-10-14",
      assessor: "Taylor Teacher",
      ...values,
    }),
  });
  const failedPhilIriGst = await philIriAssessment({
    stage: "GST",
    gstScore: 14,
    gstTotalItems: 20,
  });
  assert.equal(failedPhilIriGst.status, 200);
  const failedPhilIriResult = await failedPhilIriGst.json();
  assert.equal(failedPhilIriResult.data.gst.passed, false);
  assert.equal(failedPhilIriResult.data.gst.percentageScore, 70);
  const gstPersistenceCheck = await fetch(
    `${baseUrl}/api/phil-iri/assessments?period=BOSY&assessmentType=Pretest`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(gstPersistenceCheck.status, 200);
  const gstPersistenceSummary = await gstPersistenceCheck.json();
  const persistedGst = gstPersistenceSummary.students
    .find(({ id }) => id === addedStudent.student.id)?.reading?.English?.data?.gst;
  assert.ok(persistedGst, "GST data is present in the saved assessment");
  const philIriOral = await philIriAssessment({
    stage: "Individualized",
    readingMode: "Oral Reading",
    passage: "Grade-level passage",
    totalWords: 100,
    miscues: 10,
    timeSeconds: 60,
    correctAnswers: 6,
    totalQuestions: 10,
    interventionStartDate: "2026-10-15",
    interventionEndDate: "2026-11-15",
    progressNotes: "Weekly guided reading",
  });
  const philIriOralResult = await philIriOral.json();
  assert.equal(philIriOral.status, 200, JSON.stringify(philIriOralResult));
  assert.equal(philIriOralResult.data.individualized["Oral Reading"].wordsPerMinute, 100);
  assert.equal(philIriOralResult.data.individualized["Oral Reading"].accuracyPercentage, 90);
  assert.equal(philIriOralResult.data.individualized["Oral Reading"].comprehensionPercentage, 60);
  assert.equal(philIriOralResult.data.individualized["Oral Reading"].readingLevel, "Instructional");
  assert.equal(philIriOralResult.data.intervention.recommendedIntervention, "Guided Reading");
  const frustrationPhilIriGst = await philIriAssessment({
    period: "MOSY",
    stage: "GST",
    gstScore: 14,
    gstTotalItems: 20,
  });
  assert.equal(frustrationPhilIriGst.status, 200);
  const oralFrustration = await philIriAssessment({
    period: "MOSY",
    stage: "Individualized",
    readingMode: "Oral Reading",
    totalWords: 100,
    miscues: 11,
    timeSeconds: 60,
    correctAnswers: 6,
    totalQuestions: 10,
  });
  assert.equal(oralFrustration.status, 200);
  const oralFrustrationResult = await oralFrustration.json();
  assert.equal(oralFrustrationResult.data.individualized["Oral Reading"].accuracyPercentage, 89);
  assert.equal(oralFrustrationResult.data.individualized["Oral Reading"].readingLevel, "Frustration");
  assert.equal(oralFrustrationResult.data.intervention.recommendedIntervention, "One-on-One Reading");
  const silentFrustration = await philIriAssessment({
    period: "MOSY",
    stage: "Individualized",
    readingMode: "Silent Reading",
    totalWords: 50,
    miscues: 0,
    timeSeconds: 60,
    correctAnswers: 29,
    totalQuestions: 50,
  });
  assert.equal(silentFrustration.status, 200);
  assert.equal((await silentFrustration.json()).data.individualized["Silent Reading"].readingLevel, "Frustration");
  const philIriSilent = await philIriAssessment({
    stage: "Individualized",
    readingMode: "Silent Reading",
    passage: "Silent reading passage",
    totalWords: 100,
    miscues: 20,
    timeSeconds: 120,
    correctAnswers: 8,
    totalQuestions: 10,
    interventionStartDate: "2026-10-15",
    interventionEndDate: "2026-11-15",
    progressNotes: "Weekly guided reading",
  });
  assert.equal(philIriSilent.status, 200);
  assert.equal((await philIriSilent.json()).data.individualized["Silent Reading"].readingLevel, "Independent");
  const philIriSummary = await fetch(
    `${baseUrl}/api/phil-iri/assessments?period=BOSY&assessmentType=Pretest`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(philIriSummary.status, 200);
  const philIriSummaryData = await philIriSummary.json();
  const savedPhilIriLearner = philIriSummaryData.students.find(({ id }) => id === addedStudent.student.id);
  assert.equal(savedPhilIriLearner.reading.English.data.individualized["Oral Reading"].readingLevel, "Instructional");
  assert.equal(savedPhilIriLearner.reading.English.data.individualized["Silent Reading"].readingLevel, "Independent");
  const autoScore = (values) => fetch(`${baseUrl}/api/phil-iri/auto-scoring`, {
    method: "PUT",
    headers: philIriHeaders,
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      assessmentType: "Pretest",
      language: "English",
      assessmentMode: "Oral Reading",
      assessedDate: "2026-10-20",
      gstScore: 13,
      totalWords: 100,
      miscues: 3,
      timeSeconds: 60,
      comprehensionCorrect: 8,
      comprehensionTotal: 10,
      ...values,
    }),
  });
  const passedGstWithIndividualScores = await autoScore({ gstScore: 14 });
  assert.equal(passedGstWithIndividualScores.status, 400);
  const savedAutoScore = await autoScore({});
  assert.equal(savedAutoScore.status, 200);
  const savedAutoScoreData = await savedAutoScore.json();
  assert.equal(savedAutoScoreData.autoScoring.readingLevel, "Independent");
  assert.equal(savedAutoScoreData.autoScoring.oralReading, 0.97);
  assert.equal(savedAutoScoreData.autoScoring.comprehension, 0.8);
  assert.equal(savedAutoScoreData.autoScoring.assessor, "Taylor Updated");
  assert.equal(savedAutoScoreData.autoScoring.startingPassage, "Grade 3 passage (2 levels below)");
  assert.equal(savedAutoScoreData.autoScoring.modeResults["Oral Reading"].readingLevel, "Independent");

  const savedSilentScore = await autoScore({
    assessmentMode: "Silent Reading",
    totalWords: 100,
    miscues: "",
    timeSeconds: 120,
    comprehensionCorrect: 8,
  });
  assert.equal(savedSilentScore.status, 200);
  const savedSilentScoreData = await savedSilentScore.json();
  assert.equal(savedSilentScoreData.autoScoring.readingLevel, "Independent");
  assert.equal(savedSilentScoreData.autoScoring.oralReading, null);
  assert.equal(savedSilentScoreData.autoScoring.wordsPerMinute, 50);
  assert.ok(savedSilentScoreData.autoScoring.modeResults["Oral Reading"]);
  assert.ok(savedSilentScoreData.autoScoring.modeResults["Silent Reading"]);

  const formDownload = await fetch(`${baseUrl}/api/phil-iri/forms?form=1B&period=BOSY&assessmentType=Pretest`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(formDownload.status, 200);
  assert.match(formDownload.headers.get("content-disposition") || "", /attachment; filename="[^"]+\.xlsx"/);
  const formWorkbook = new ExcelJS.Workbook();
  await formWorkbook.xlsx.load(Buffer.from(await formDownload.arrayBuffer()));
  const formSheet = formWorkbook.worksheets[0];
  assert.equal(formSheet.state, "visible");
  assert.ok(!formSheet.sheetProtection);
  let formText = "";
  formSheet.eachRow((row) => row.eachCell((cell) => { formText += `${cell.value} | `; }));
  assert.match(formText, /13/);
  assert.match(formText, /Screening Test Class Reading Record/i);
  const formFilipino = await fetch(`${baseUrl}/api/phil-iri/forms?form=1A&period=BOSY&assessmentType=Pretest`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(formFilipino.status, 200);
  const invalidForm = await fetch(`${baseUrl}/api/phil-iri/forms?form=2C`, { headers: { Cookie: teacherCookie } });
  assert.equal(invalidForm.status, 400);

  const savedListeningScore = await autoScore({
    assessmentMode: "Listening Comprehension",
    totalWords: "",
    miscues: "",
    timeSeconds: "",
    comprehensionCorrect: 6,
  });
  assert.equal(savedListeningScore.status, 200);
  const savedListeningScoreData = await savedListeningScore.json();
  assert.equal(savedListeningScoreData.autoScoring.readingLevel, "Instructional");
  assert.equal(savedListeningScoreData.autoScoring.wordsPerMinute, null);
  assert.ok(savedListeningScoreData.autoScoring.modeResults["Oral Reading"]);
  assert.ok(savedListeningScoreData.autoScoring.modeResults["Silent Reading"]);
  assert.ok(savedListeningScoreData.autoScoring.modeResults["Listening Comprehension"]);

  const savedFilipinoScore = await autoScore({
    language: "Filipino",
    gstScore: 10,
    miscues: 10,
    comprehensionCorrect: 6,
  });
  assert.equal(savedFilipinoScore.status, 200);
  assert.equal((await savedFilipinoScore.json()).autoScoring.readingLevel, "Instructional");

  for (const period of ["MOSY", "EOSY"]) {
    const savedPeriodScore = await autoScore({
      period,
      language: "English",
      gstScore: 16,
      totalWords: "",
      miscues: "",
      timeSeconds: "",
      comprehensionCorrect: "",
      comprehensionTotal: "",
    });
    assert.equal(savedPeriodScore.status, 200);
  }
  const loadedFilipinoScores = await fetch(
    `${baseUrl}/api/phil-iri/auto-scoring?studentId=${encodeURIComponent(addedStudent.student.id)}&period=BOSY&assessmentType=Pretest&language=Filipino`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(loadedFilipinoScores.status, 200);
  assert.equal((await loadedFilipinoScores.json()).autoScoring.gstScore, 10);

  for (const period of ["BOSY", "MOSY", "EOSY"]) {
    const periodSummary = await fetch(
      `${baseUrl}/api/phil-iri/assessments?period=${period}&assessmentType=Pretest`,
      { headers: { Cookie: teacherCookie } },
    );
    assert.equal(periodSummary.status, 200);
    const periodLearner = (await periodSummary.json()).students
      .find(({ id }) => id === addedStudent.student.id);
    assert.ok(periodLearner.reading.English.data.autoScoring, `${period} English score is reflected`);
    if (period === "BOSY") {
      assert.equal(periodLearner.reading.Filipino.data.autoScoring.gstScore, 10);
      assert.equal(periodLearner.reading.English.data.autoScoring.gstScore, 13);
    }
  }
  const invalidAutoScore = await autoScore({ miscues: 101 });
  assert.equal(invalidAutoScore.status, 400);

  const philIriSchoolSummary = await fetch(
    `${baseUrl}/api/phil-iri/assessments?scope=school&period=BOSY&assessmentType=Pretest`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(philIriSchoolSummary.status, 200);
  assert.equal((await philIriSchoolSummary.json()).schoolWide, true);
  for (const scope of ["class", "school"]) {
    const exportResponse = await fetch(
      `${baseUrl}/api/phil-iri/export?scope=${scope}&period=BOSY&assessmentType=Pretest`,
      { headers: { Cookie: teacherCookie } },
    );
    assert.equal(exportResponse.status, 200);
    assert.match(exportResponse.headers.get("content-type"), /spreadsheetml/);
    const reportWorkbook = new ExcelJS.Workbook();
    await reportWorkbook.xlsx.load(Buffer.from(await exportResponse.arrayBuffer()));
    assert.equal(reportWorkbook.worksheets[0].getCell("A1").value, "PHIL-IRI Reading Assessment Report");
    assert.equal(reportWorkbook.worksheets[0].getCell("A11").value, "Grade");
  }
  const learnerPhilIriExport = await fetch(
    `${baseUrl}/api/phil-iri/export?scope=class&period=BOSY&assessmentType=Pretest&studentId=${encodeURIComponent(addedStudent.student.id)}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(learnerPhilIriExport.status, 200);
  const passedPhilIriGst = await fetch(`${baseUrl}/api/phil-iri/assessments`, {
    method: "POST",
    headers: philIriHeaders,
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      assessmentType: "Posttest",
      language: "Filipino",
      stage: "GST",
      assessedDate: "2026-10-14",
      assessor: "Taylor Teacher",
      gstScore: 16,
      gstTotalItems: 20,
    }),
  });
  assert.equal(passedPhilIriGst.status, 200);
  assert.equal((await passedPhilIriGst.json()).data.gst.passed, true);
  const posttestPhilIriGst = await fetch(`${baseUrl}/api/phil-iri/assessments`, {
    method: "POST",
    headers: philIriHeaders,
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      assessmentType: "Posttest",
      language: "English",
      stage: "GST",
      assessedDate: "2026-10-14",
      assessor: "Taylor Teacher",
      gstScore: 14,
      gstTotalItems: 20,
    }),
  });
  assert.equal(posttestPhilIriGst.status, 200);
  const oralBoundaryPhilIri = await fetch(`${baseUrl}/api/phil-iri/assessments`, {
    method: "POST",
    headers: philIriHeaders,
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      assessmentType: "Posttest",
      language: "English",
      stage: "Individualized",
      assessedDate: "2026-10-14",
      assessor: "Taylor Teacher",
      readingMode: "Oral Reading",
      totalWords: 100,
      miscues: 3,
      timeSeconds: 60,
      correctAnswers: 8,
      totalQuestions: 10,
    }),
  });
  assert.equal(oralBoundaryPhilIri.status, 200);
  assert.equal((await oralBoundaryPhilIri.json()).data.individualized["Oral Reading"].readingLevel, "Independent");
  const individualizedAfterPass = await fetch(`${baseUrl}/api/phil-iri/assessments`, {
    method: "POST",
    headers: philIriHeaders,
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      assessmentType: "Posttest",
      language: "Filipino",
      stage: "Individualized",
      assessedDate: "2026-10-14",
      assessor: "Taylor Teacher",
      readingMode: "Silent Reading",
      totalWords: 100,
      miscues: 0,
      timeSeconds: 60,
      correctAnswers: 10,
      totalQuestions: 10,
    }),
  });
  assert.equal(individualizedAfterPass.status, 400);
  const unauthenticatedPhilIri = await fetch(`${baseUrl}/api/phil-iri/settings`);
  assert.equal(unauthenticatedPhilIri.status, 401);

  const unauthenticatedGrades = await fetch(
    `${baseUrl}/api/grades?studentId=${encodeURIComponent(addedStudent.student.id)}&term=Term%201`,
  );
  assert.equal(unauthenticatedGrades.status, 401);
  const unauthenticatedGradeLock = await fetch(`${baseUrl}/api/grades/lock?term=Term%201`);
  assert.equal(unauthenticatedGradeLock.status, 401);
  const unauthenticatedSummary = await fetch(`${baseUrl}/api/grades/summary`);
  assert.equal(unauthenticatedSummary.status, 401);
  const unauthenticatedSF9Export = await fetch(
    `${baseUrl}/api/grades/sf9?studentId=${encodeURIComponent(addedStudent.student.id)}`,
  );
  assert.equal(unauthenticatedSF9Export.status, 401);
  const unauthenticatedSF9Preview = await fetch(
    `${baseUrl}/api/grades/sf9?studentId=${encodeURIComponent(addedStudent.student.id)}&format=preview`,
  );
  assert.equal(unauthenticatedSF9Preview.status, 401);
  const unauthenticatedReading = await fetch(`${baseUrl}/api/reading-assessments`);
  assert.equal(unauthenticatedReading.status, 401);
  const unauthenticatedMathAssessment = await fetch(`${baseUrl}/api/math-assessments`);
  assert.equal(unauthenticatedMathAssessment.status, 401);
  const unauthenticatedMathAssessmentExport = await fetch(
    `${baseUrl}/api/math-assessments/export?period=BOSY&format=xlsx`,
  );
  assert.equal(unauthenticatedMathAssessmentExport.status, 401);
  const unauthenticatedAttendance = await fetch(`${baseUrl}/api/attendance?date=2026-10-14`);
  assert.equal(unauthenticatedAttendance.status, 401);
  const unauthenticatedSF2Export = await fetch(`${baseUrl}/api/attendance/month/export?month=2026-10`);
  assert.equal(unauthenticatedSF2Export.status, 401);
  const unauthenticatedSF2Import = await fetch(`${baseUrl}/api/attendance/month/import?month=2026-10`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from("Not a workbook"),
  });
  assert.equal(unauthenticatedSF2Import.status, 401);
  const unauthenticatedMonthlyAttendance = await fetch(`${baseUrl}/api/attendance/month?month=2026-10`);
  assert.equal(unauthenticatedMonthlyAttendance.status, 401);

  const emptyReadingResponse = await fetch(`${baseUrl}/api/reading-assessments`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(emptyReadingResponse.status, 200);
  const emptyReading = await emptyReadingResponse.json();
  assert.deepEqual(emptyReading.languages, ["English", "Filipino"]);
  assert.deepEqual(emptyReading.levels, ["Non-reader", "Frustration", "Instructional", "Independent"]);
  assert.equal(emptyReading.attemptNo, 1);
  assert.equal(emptyReading.students[0].levels.English, "");
  const emptyMathAssessmentResponse = await fetch(`${baseUrl}/api/math-assessments`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(emptyMathAssessmentResponse.status, 200);
  const emptyMathAssessment = await emptyMathAssessmentResponse.json();
  assert.deepEqual(emptyMathAssessment.periods, ["BOSY", "MOSY", "EOSY"]);
  assert.equal(emptyMathAssessment.students[0].assessments.BOSY.masteryLevel, "Data Not Yet Available");
  assert.equal(emptyMathAssessment.students[0].assessments.BOSY.percentageScore, "");
  const masteryBoundaryCases = [
    [90, "Advanced Mastery"],
    [89, "Proficient Mastery"],
    [75, "Proficient Mastery"],
    [74, "Developing Mastery"],
    [50, "Developing Mastery"],
    [49, "Beginning Mastery"],
  ];
  for (const [rawScore, expectedMastery] of masteryBoundaryCases) {
    const savedBoundaryCase = await fetch(`${baseUrl}/api/math-assessments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({
        studentId: addedStudent.student.id,
        period: "BOSY",
        rawScore,
        totalItems: 100,
      }),
    });
    assert.equal(savedBoundaryCase.status, 200, await savedBoundaryCase.clone().text());
    assert.equal((await savedBoundaryCase.json()).masteryLevel, expectedMastery);
  }
  const savedBaselineMathAssessment = await fetch(`${baseUrl}/api/math-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      rawScore: 9,
      totalItems: 10,
      strengths: "Number sense",
      areasForImprovement: "Fractions",
      recommendedIntervention: "Use visual fraction models",
    }),
  });
  assert.equal(savedBaselineMathAssessment.status, 200);
  assert.equal((await savedBaselineMathAssessment.json()).percentageScore, 90);
  const savedMidlineMathAssessment = await fetch(`${baseUrl}/api/math-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "MOSY",
      rawScore: 7,
      totalItems: 10,
    }),
  });
  assert.equal(savedMidlineMathAssessment.status, 200);
  assert.equal((await savedMidlineMathAssessment.json()).masteryLevel, "Developing Mastery");
  const savedEndlineNotes = await fetch(`${baseUrl}/api/math-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "EOSY",
      strengths: "Improved calculation fluency",
    }),
  });
  assert.equal(savedEndlineNotes.status, 200);
  const mathAssessmentReportResponse = await fetch(`${baseUrl}/api/math-assessments`, {
    headers: { Cookie: teacherCookie },
  });
  const mathAssessmentReport = await mathAssessmentReportResponse.json();
  const savedMathLearner = mathAssessmentReport.students.find(({ id }) => id === addedStudent.student.id);
  assert.equal(savedMathLearner.assessments.BOSY.percentageScore, 90);
  assert.equal(savedMathLearner.assessments.BOSY.masteryLevel, "Advanced Mastery");
  assert.match(savedMathLearner.assessments.BOSY.assessedDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(savedMathLearner.assessments.BOSY.strengths, "Number sense");
  assert.equal(savedMathLearner.assessments.MOSY.percentageScore, 70);
  assert.equal(savedMathLearner.assessments.EOSY.percentageScore, "");
  assert.equal(savedMathLearner.assessments.EOSY.masteryLevel, "Data Not Yet Available");
  const invalidMathAssessmentCases = [
    { rawScore: 11, totalItems: 10 },
    { rawScore: 1, totalItems: "" },
    { rawScore: 1.5, totalItems: 10 },
  ];
  for (const invalidScore of invalidMathAssessmentCases) {
    const invalidMathAssessment = await fetch(`${baseUrl}/api/math-assessments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({ studentId: addedStudent.student.id, period: "EOSY", ...invalidScore }),
    });
    assert.equal(invalidMathAssessment.status, 400);
  }
  const mathCsvExport = await fetch(
    `${baseUrl}/api/math-assessments/export?period=BOSY&format=csv`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(mathCsvExport.status, 200);
  assert.match(mathCsvExport.headers.get("content-type"), /text\/csv/);
  assert.match(await mathCsvExport.text(), /Advanced Mastery/);
  const mathXlsxExport = await fetch(
    `${baseUrl}/api/math-assessments/export?period=BOSY&format=xlsx`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(mathXlsxExport.status, 200);
  assert.match(mathXlsxExport.headers.get("content-disposition"), /RMA TEMP\.xlsx/);
  const mathReportWorkbook = new ExcelJS.Workbook();
  await mathReportWorkbook.xlsx.load(Buffer.from(await mathXlsxExport.arrayBuffer()));
  assert.deepEqual(mathReportWorkbook.worksheets.map(({ name }) => name), [
    "RMAKS2 Scoresheet",
  ]);
  const initialScoresheet = mathReportWorkbook.getWorksheet("RMAKS2 Scoresheet");
  assert.equal(initialScoresheet.getCell("C4").value, "BoSY");
  assert.equal(initialScoresheet.getCell("C6").value, "123456");
  assert.equal(initialScoresheet.getCell("F6").value, "Sample Elementary School");
  assert.equal(initialScoresheet.getCell("M6").value, teacherCredentials.name);
  assert.equal(initialScoresheet.getCell("C7").value, "Grade 5");
  assert.equal(initialScoresheet.getCell("F7").value, "Mabini");
  assert.equal(initialScoresheet.getCell("B10").value, studentDetails.lrn);
  assert.equal(initialScoresheet.getCell("C10").value, addedStudent.student.name);
  assert.equal(initialScoresheet.getCell("D10").value, "Female");
  assert.equal(initialScoresheet.getCell("F10").value, "");

  const template = emptyMathAssessment.template;
  assert.deepEqual(template.grades.map(({ gradeLevel, maximumScore }) => [gradeLevel, maximumScore]), [
    ["Grade 4", 13],
    ["Grade 5", 32],
    ["Grade 6", 50],
  ]);
  assert.deepEqual(template.grades.map(({ masteryBands }) =>
    masteryBands.map(({ minimumRawScore }) => minimumRawScore)), [
    [11, 8, 5, 3, 0],
    [27, 21, 14, 7, 0],
    [45, 39, 29, 15, 0],
  ]);
  const emptyTemplateReplacement = await fetch(`${baseUrl}/api/math-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      gradeLevel: "Grade 5",
      assessedDate: "2026-09-22",
      itemScores: {},
    }),
  });
  assert.equal(emptyTemplateReplacement.status, 400);
  assert.match((await emptyTemplateReplacement.json()).error, /at least one item score/i);
  const preservedLegacyAssessment = await fetch(`${baseUrl}/api/math-assessments`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal((await preservedLegacyAssessment.json()).students[0].assessments.BOSY.percentageScore, 90);
  assert.equal(template.items.length, 42);
  assert.equal(template.items.find(({ key }) => key === "17").maximum, 3);
  const rmaTemplateWorkbook = new ExcelJS.Workbook();
  await rmaTemplateWorkbook.xlsx.readFile(path.join(__dirname, "..", "RMA TEMP.xlsx"));
  const rmaSourceScoresheet = rmaTemplateWorkbook.getWorksheet("RMAKS2 Scoresheet");
  assert.ok(rmaSourceScoresheet, "RMA template scoresheet exists");
  const templateItemValues = [];
  for (let column = 8; column <= 49; column += 1) {
    const itemCell = rmaSourceScoresheet.getRow(8).getCell(column).value;
    templateItemValues.push([
      String(itemCell && typeof itemCell === "object" ? itemCell.result : itemCell),
      rmaSourceScoresheet.getRow(9).getCell(column).value,
    ]);
  }
  assert.deepEqual(template.items.map(({ key, maximum }) => [key, maximum]), templateItemValues);
  const expectedItemLabels = [
    "1", "2", "3", "4", "5", "6", "7", "8", "9", "10",
    "11", "12", "13", "14", "15", "16", "17", "18", "19", "20",
    "21", "22", "23", "24", "25", "26", "27", "28", "29", "30a",
    "30b", "31", "32", "33", "34", "35", "36", "37a", "37b", "38", "39", "40",
  ];
  assert.deepEqual(template.items.map(({ key, label }) => [key, label]),
    expectedItemLabels.map((label) => [label, label]));
  const levellingFormula = String(rmaSourceScoresheet.getCell("BC10").value.formula);
  for (const cutoff of ["45", "39", "29", "15", "27", "21", "14", "7", "11", "8", "5", "3"]) {
    assert.ok(levellingFormula.includes(`>=${cutoff}`), `template levelling formula includes ${cutoff} point cutoff`);
  }
  assert.ok(String(rmaSourceScoresheet.getCell("BN10").value.formula).includes(">=0.75"));
  assert.deepEqual(template.domains.filter(({ category }) => category === "Content Domain")
    .map(({ key, label, itemKeys }) => [key, label, itemKeys["Grade 6"].length, itemKeys["Grade 6"]]), [
    ["numberAndNumberSense", "Number and Number Sense", 19, [
      "1", "3", "7", "8", "10", "11", "12", "14", "15", "19", "21", "25", "29", "31", "32", "33", "34", "35", "38",
    ]],
    ["geometry", "Geometry", 8, ["5", "13", "17", "20", "22", "23", "26", "36"]],
    ["measurement", "Measurement", 5, ["9", "16", "18", "24", "28"]],
    ["statisticsAndProbability", "Statistics & Probability", 7, ["4", "27", "30a", "30b", "37a", "37b", "40"]],
    ["algebra", "Algebra", 3, ["2", "6", "39"]],
  ]);
  const domainItems = template.domains.filter(({ category }) => category === "Content Domain")
    .flatMap(({ itemKeys }) => itemKeys["Grade 6"]);
  assert.equal(domainItems.length, template.items.length, "content domain item lists account for all template items");
  assert.equal(new Set(domainItems).size, template.items.length, "each template item belongs to one content domain");
  const gradeFourItemScores = Object.fromEntries(template.items
    .filter(({ gradeLevel }) => gradeLevel === "Grade 4")
    .map(({ key, maximum }) => [key, maximum]));
  const gradeFourAssessmentResponse = await fetch(`${baseUrl}/api/math-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "EOSY",
      gradeLevel: "Grade 4",
      assessedDate: "2026-09-22",
      itemScores: gradeFourItemScores,
      remarks: "Template formula verification",
    }),
  });
  assert.equal(gradeFourAssessmentResponse.status, 200, await gradeFourAssessmentResponse.clone().text());
  const gradeFourAssessment = await gradeFourAssessmentResponse.json();
  assert.equal(gradeFourAssessment.rawScore, 13);
  assert.equal(gradeFourAssessment.totalItems, 13);
  assert.equal(gradeFourAssessment.percentageScore, 100);
  assert.equal(gradeFourAssessment.masteryLevel, "At Grade Level (Highly Proficient)");
  assert.equal(gradeFourAssessment.gradeLevelScores[0].score, 13);
  assert.deepEqual(gradeFourAssessment.domainScores.map(({ label, score, maximum, meetsBenchmark }) => [
    label, score, maximum, meetsBenchmark,
  ]), [
    ["Number and Number Sense", 7, 7, true],
    ["Geometry", 2, 2, true],
    ["Measurement", 1, 1, true],
    ["Statistics & Probability", 1, 1, true],
    ["Algebra", 2, 2, true],
  ]);
  assert.equal(gradeFourAssessment.domainScores.reduce((sum, domain) => sum + domain.maximum, 0), 13);
  assert.match(gradeFourAssessment.remarks, /13\/13 points \(100\.00%\)/);
  assert.doesNotMatch(gradeFourAssessment.remarks, /Template formula verification/);
  assert.match(gradeFourAssessment.strengths, /Number and Number Sense/);
  assert.match(gradeFourAssessment.strengths, /Algebra/);
  assert.match(gradeFourAssessment.areasForImprovement, /All assessed content domains met or exceeded the 75% benchmark/);
  assert.match(gradeFourAssessment.recommendedIntervention, /mixed review and enrichment/);
  assert.deepEqual(gradeFourAssessment.cognitiveDomainScores.map(({ score, maximum, meetsBenchmark }) => [
    score, maximum, meetsBenchmark,
  ]), [[4, 4, true], [7, 7, true], [2, 2, true]]);
  const saveRmaGrade = async (period, gradeLevel, targetScore) => {
    let remaining = targetScore;
    const itemScores = {};
    const gradeIndex = template.grades.findIndex((grade) => grade.gradeLevel === gradeLevel);
    for (const item of template.items.filter((entry) =>
      template.grades.findIndex((grade) => grade.gradeLevel === entry.gradeLevel) <= gradeIndex)) {
      itemScores[item.key] = Math.min(item.maximum, remaining);
      remaining -= itemScores[item.key];
    }
    assert.equal(remaining, 0, `${targetScore} points are attainable for ${gradeLevel}`);
    return fetch(`${baseUrl}/api/math-assessments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({
        studentId: addedStudent.student.id,
        period,
        gradeLevel,
        assessedDate: "2026-09-23",
        itemScores,
      }),
    });
  };
  const gradeFiveThresholdResponse = await saveRmaGrade("BOSY", "Grade 5", 27);
  assert.equal(gradeFiveThresholdResponse.status, 200);
  const gradeFiveThreshold = await gradeFiveThresholdResponse.json();
  assert.equal(gradeFiveThreshold.rawScore, 27);
  assert.equal(gradeFiveThreshold.totalItems, 32);
  assert.equal(gradeFiveThreshold.masteryLevel, "At Grade Level (Highly Proficient)");
  assert.equal(gradeFiveThreshold.domainScores.reduce((sum, domain) => sum + domain.maximum, 0), 32);
  assert.match(gradeFiveThreshold.remarks, /27\/32 points/);
  assert.match(gradeFiveThreshold.areasForImprovement, /%/);
  assert.match(gradeFiveThreshold.recommendedIntervention, /practice/);
  const gradeSixThresholdResponse = await saveRmaGrade("MOSY", "Grade 6", 45);
  assert.equal(gradeSixThresholdResponse.status, 200);
  const gradeSixThreshold = await gradeSixThresholdResponse.json();
  assert.equal(gradeSixThreshold.rawScore, 45);
  assert.equal(gradeSixThreshold.totalItems, 50);
  assert.equal(gradeSixThreshold.masteryLevel, "At Grade Level (Highly Proficient)");
  assert.equal(gradeSixThreshold.domainScores.reduce((sum, domain) => sum + domain.maximum, 0), 50);
  const generatedNarrativeReportResponse = await fetch(`${baseUrl}/api/math-assessments`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(generatedNarrativeReportResponse.status, 200);
  const generatedNarrativeReport = await generatedNarrativeReportResponse.json();
  const generatedMosYAssessment = generatedNarrativeReport.students
    .find(({ id }) => id === addedStudent.student.id).assessments.MOSY;
  assert.match(generatedMosYAssessment.remarks, /45\/50 points/);
  assert.match(generatedMosYAssessment.strengths, /Number and Number Sense|No content domain met/);
  assert.match(generatedMosYAssessment.recommendedIntervention, /Geometry|Measurement|Number and Number Sense|Statistics & Probability|Algebra|Maintain progress/);
  const gradeFourItemLimit = await fetch(`${baseUrl}/api/math-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "EOSY",
      gradeLevel: "Grade 4",
      assessedDate: "2026-09-22",
      itemScores: { ...gradeFourItemScores, "5": 3 },
    }),
  });
  assert.equal(gradeFourItemLimit.status, 400);
  const undatedItemScores = await fetch(`${baseUrl}/api/math-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "EOSY",
      gradeLevel: "Grade 4",
      assessedDate: "",
      itemScores: { "1": 1 },
    }),
  });
  assert.equal(undatedItemScores.status, 400);
  const templateCsvExport = await fetch(
    `${baseUrl}/api/math-assessments/export?period=EOSY&format=csv`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(templateCsvExport.status, 200);
  const templateCsv = await templateCsvExport.text();
  assert.match(templateCsv, /Item 30a/);
  assert.match(templateCsv, /Grade 4 Score/);
  const mismatchedGradeTemplateExport = await fetch(
    `${baseUrl}/api/math-assessments/export?period=EOSY&format=xlsx`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(mismatchedGradeTemplateExport.status, 400);
  assert.match((await mismatchedGradeTemplateExport.json()).error, /Teacher Profile grade/i);
  const gradeFiveTemplateAssessment = await saveRmaGrade("EOSY", "Grade 5", 27);
  assert.equal(gradeFiveTemplateAssessment.status, 200);
  const templateXlsxExport = await fetch(
    `${baseUrl}/api/math-assessments/export?period=EOSY&format=xlsx`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(templateXlsxExport.status, 200);
  assert.match(templateXlsxExport.headers.get("content-disposition"), /RMA TEMP\.xlsx/);
  const templateWorkbook = new ExcelJS.Workbook();
  await templateWorkbook.xlsx.load(Buffer.from(await templateXlsxExport.arrayBuffer()));
  const sourceRmaTempWorkbook = new ExcelJS.Workbook();
  await sourceRmaTempWorkbook.xlsx.readFile(path.join(__dirname, "..", "RMA TEMP.xlsx"));
  assert.deepEqual(templateWorkbook.worksheets.map(({ name }) => name), [
    "RMAKS2 Scoresheet",
  ]);
  assert.deepEqual(templateWorkbook.worksheets.map(({ name }) => name),
    sourceRmaTempWorkbook.worksheets.map(({ name }) => name));
  for (const sheet of sourceRmaTempWorkbook.worksheets) {
    assert.deepEqual([...templateWorkbook.getWorksheet(sheet.name).model.merges].sort(), [...sheet.model.merges].sort(),
      `${sheet.name} retains the RMA TEMP template merged cells`);
  }
  const templateScoresheet = templateWorkbook.getWorksheet("RMAKS2 Scoresheet");
  assert.equal(templateScoresheet.getCell("C4").value, "EoSY");
  assert.equal(templateScoresheet.getCell("B10").value, studentDetails.lrn);
  assert.equal(templateScoresheet.getCell("C10").value, addedStudent.student.name);
  assert.equal(templateScoresheet.getCell("E10").value.toISOString().slice(0, 10), studentDetails.birthdate);
  assert.equal(templateScoresheet.getCell("F10").value.toISOString().slice(0, 10), "2026-09-23");
  assert.equal(templateScoresheet.getCell("H8").value, 1);
  assert.equal(templateScoresheet.getCell("AK8").value, "30a");
  assert.equal(templateScoresheet.getCell("AL8").value, "30b");
  assert.equal(templateScoresheet.getCell("H10").value, 1);
  assert.equal(templateScoresheet.getCell("L10").value, 2);
  assert.equal(templateScoresheet.getCell("T10").value, 1);
  assert.equal(templateScoresheet.getCell("X6").value, 0);
  assert.equal(templateScoresheet.getCell("AE6").value, 1);
  assert.equal(templateScoresheet.getCell("AJ6").value, 1);
  assert.match(templateScoresheet.getCell("AS6").value.formula, /COUNTA\(F10:F108\)/);
  assert.match(templateScoresheet.getCell("BA10").value.formula, /\$C\$7/);
  assert.equal(templateScoresheet.getCell("A9").value, "Total Points / Scores");
  const initialRosterResponse = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: teacherCookie },
  });
  const initialRoster = (await initialRosterResponse.json()).students;
  assert.deepEqual(
    emptyReading.students.map(({ id, name }) => ({ id, name })),
    initialRoster.map(({ id, name }) => ({ id, name })),
    "reading report learners match the student list",
  );

  const saveReadingResponse = await fetch(`${baseUrl}/api/reading-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      levels: { English: "Independent", Filipino: "Instructional" },
    }),
  });
  assert.equal(saveReadingResponse.status, 200);
  const savedReadingResult = await saveReadingResponse.json();
  assert.equal(savedReadingResult.saved, true);
  assert.equal(savedReadingResult.attemptNo, 1);
  assert.match(savedReadingResult.assessedDates.English, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(savedReadingResult.assessedDates.Filipino, /^\d{4}-\d{2}-\d{2}$/);
  const savedReadingResponse = await fetch(`${baseUrl}/api/reading-assessments`, {
    headers: { Cookie: teacherCookie },
  });
  const savedReading = await savedReadingResponse.json();
  assert.equal(savedReading.students[0].levels.English, "Independent");
  assert.equal(savedReading.students[0].levels.Filipino, "Instructional");
  assert.match(savedReading.students[0].assessedDates.English, /^\d{4}-\d{2}-\d{2}$/);

  const secondReadingAttempt = await fetch(`${baseUrl}/api/reading-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      attemptNo: 2,
      levels: { English: "Instructional", Filipino: "Independent" },
    }),
  });
  assert.equal(secondReadingAttempt.status, 200);
  const secondReadingAttemptResult = await secondReadingAttempt.json();
  assert.equal(secondReadingAttemptResult.attemptNo, 2);
  assert.match(secondReadingAttemptResult.assessedDates.English, /^\d{4}-\d{2}-\d{2}$/);
  const savedSecondAttempt = await fetch(`${baseUrl}/api/reading-assessments?period=BOSY&attemptNo=2`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(savedSecondAttempt.status, 200);
  const secondAttemptReport = await savedSecondAttempt.json();
  assert.equal(secondAttemptReport.students[0].levels.English, "Instructional");
  assert.equal(secondAttemptReport.students[0].levels.Filipino, "Independent");
  const stillSavedFirstAttempt = await fetch(`${baseUrl}/api/reading-assessments?period=BOSY&attemptNo=1`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal((await stillSavedFirstAttempt.json()).students[0].levels.English, "Independent");

  for (const assessment of [
    { period: "MOSY", levels: { English: "Instructional", Filipino: "Frustration" } },
    { period: "EOSY", levels: { English: "Independent", Filipino: "Independent" } },
  ]) {
    const response = await fetch(`${baseUrl}/api/reading-assessments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({
        studentId: addedStudent.student.id,
        ...assessment,
      }),
    });
    assert.equal(response.status, 200);
  }
  for (const assessment of [
    { period: "BOSY", levels: { English: "Independent", Filipino: "Instructional" } },
    { period: "MOSY", levels: { English: "Instructional", Filipino: "Frustration" } },
    { period: "EOSY", levels: { English: "Independent", Filipino: "Independent" } },
  ]) {
    const response = await fetch(`${baseUrl}/api/reading-assessments?period=${assessment.period}`, {
      headers: { Cookie: teacherCookie },
    });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.period, assessment.period);
    assert.equal(report.students[0].levels.English, assessment.levels.English);
    assert.equal(report.students[0].levels.Filipino, assessment.levels.Filipino);
  }
  const invalidReadingPeriod = await fetch(`${baseUrl}/api/reading-assessments?period=MOY`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(invalidReadingPeriod.status, 400);
  const invalidReadingAttempt = await fetch(`${baseUrl}/api/reading-assessments?period=BOSY&attemptNo=0`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(invalidReadingAttempt.status, 400);
  const invalidReadingAttemptSave = await fetch(`${baseUrl}/api/reading-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      attemptNo: 1.5,
      levels: { English: "Independent", Filipino: "Instructional" },
    }),
  });
  assert.equal(invalidReadingAttemptSave.status, 400);
  const missingReadingPeriod = await fetch(`${baseUrl}/api/reading-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      levels: { English: "Independent", Filipino: "Instructional" },
    }),
  });
  assert.equal(missingReadingPeriod.status, 400);

  const invalidReadingResponse = await fetch(`${baseUrl}/api/reading-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      levels: { English: "Unknown level", Filipino: "" },
    }),
  });
  assert.equal(invalidReadingResponse.status, 400);
  assert.match((await invalidReadingResponse.json()).error, /valid English reading level/i);

  const gradesUrl = `${baseUrl}/api/grades?studentId=${encodeURIComponent(addedStudent.student.id)}&term=Term%201`;
  const emptyGradesResponse = await fetch(gradesUrl, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(emptyGradesResponse.status, 200);
  const emptyGrades = await emptyGradesResponse.json();
  assert.equal(emptyGrades.student.id, addedStudent.student.id);
  assert.equal(emptyGrades.term, "Term 1");
  assert.equal(emptyGrades.grades.filipino, "");
  assert.equal(emptyGrades.grades.musicAndArts, "");
  const eClassGradeSyncResponse = await fetch(`${baseUrl}/api/grades/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      subject: "musicAndArts",
      grade: "87.5",
    }),
  });
  assert.equal(eClassGradeSyncResponse.status, 200);
  assert.deepEqual(await eClassGradeSyncResponse.json(), {
    saved: true,
    studentId: addedStudent.student.id,
    term: "Term 1",
    subject: "musicAndArts",
    grade: 87.5,
  });
  const syncedEClassGradeResponse = await fetch(gradesUrl, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(syncedEClassGradeResponse.status, 200);
  const syncedEClassGrades = await syncedEClassGradeResponse.json();
  assert.equal(syncedEClassGrades.grades.musicAndArts, "87.5");
  assert.equal(syncedEClassGrades.grades.filipino, "");
  const clearEClassGradeResponse = await fetch(`${baseUrl}/api/grades/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      subject: "musicAndArts",
      grade: "",
    }),
  });
  assert.equal(clearEClassGradeResponse.status, 200);
  assert.deepEqual(await clearEClassGradeResponse.json(), {
    saved: true,
    studentId: addedStudent.student.id,
    term: "Term 1",
    subject: "musicAndArts",
    grade: null,
  });
  const clearedEClassGradesResponse = await fetch(gradesUrl, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(clearedEClassGradesResponse.status, 200);
  assert.equal((await clearedEClassGradesResponse.json()).grades.musicAndArts, "");
  const initialGradeLockResponse = await fetch(
    `${baseUrl}/api/grades/lock?studentId=${encodeURIComponent(addedStudent.student.id)}&term=Term%201`,
    {
      headers: { Cookie: teacherCookie },
    },
  );
  assert.equal(initialGradeLockResponse.status, 200);
  assert.deepEqual(await initialGradeLockResponse.json(), {
    studentId: addedStudent.student.id,
    term: "Term 1",
    locked: true,
  });

  const termGrades = {
    filipino: "88",
    english: "91",
    mathematics: "86.5",
    science: "90",
    aralingPanlipunan: "89",
    gmrc: "95",
    epp: "87",
    musicAndArts: "92",
    physicalEducationAndHealth: "84",
  };
  const missingPasswordUnlockResponse = await fetch(`${baseUrl}/api/grades/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ studentId: addedStudent.student.id, term: "Term 1", locked: false }),
  });
  assert.equal(missingPasswordUnlockResponse.status, 400);
  const incorrectPasswordUnlockResponse = await fetch(`${baseUrl}/api/grades/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      locked: false,
      password: "incorrect-password",
    }),
  });
  assert.equal(incorrectPasswordUnlockResponse.status, 400);
  const unlockForDirectEntryResponse = await fetch(`${baseUrl}/api/grades/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      locked: false,
      password: teacherCredentials.password,
    }),
  });
  assert.equal(unlockForDirectEntryResponse.status, 200);
  const invalidTeacherCommentResponse = await fetch(`${baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      grades: termGrades,
      teacherComment: "x".repeat(1001),
    }),
  });
  assert.equal(invalidTeacherCommentResponse.status, 400);
  assert.match((await invalidTeacherCommentResponse.json()).error, /1,000 characters or fewer/);
  const saveGradesResponse = await fetch(`${baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      grades: termGrades,
      teacherComment: "Shows steady progress and should continue reading each evening.",
    }),
  });
  assert.equal(saveGradesResponse.status, 200);
  const savedGradesResult = await saveGradesResponse.json();
  assert.equal(savedGradesResult.locked, false, "saving one student's grades leaves the term unlocked for the class");
  assert.equal(savedGradesResult.teacherComment, "Shows steady progress and should continue reading each evening.");
  assert.deepEqual(savedGradesResult.grades, {
    filipino: 88,
    english: 91,
    mathematics: 86.5,
    science: 90,
    aralingPanlipunan: 89,
    gmrc: 95,
    epp: 87,
    musicAndArts: 92,
    physicalEducationAndHealth: 84,
  });
  const savedGradeRecordResponse = await fetch(
    `${baseUrl}/api/grades?studentId=${encodeURIComponent(addedStudent.student.id)}&term=Term%201`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(savedGradeRecordResponse.status, 200);
  assert.equal(
    (await savedGradeRecordResponse.json()).teacherComment,
    "Shows steady progress and should continue reading each evening.",
    "the selected student's term comment loads from saved grade data",
  );
  const lockAfterSaveResponse = await fetch(
    `${baseUrl}/api/grades/lock?studentId=${encodeURIComponent(addedStudent.student.id)}&term=Term%201`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(lockAfterSaveResponse.status, 200);
  assert.equal((await lockAfterSaveResponse.json()).locked, false);

  const lockGradesResponse = await fetch(`${baseUrl}/api/grades/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ studentId: addedStudent.student.id, term: "Term 1", locked: true }),
  });
  assert.equal(lockGradesResponse.status, 200);
  assert.deepEqual(await lockGradesResponse.json(), {
    studentId: addedStudent.student.id,
    term: "Term 1",
    locked: true,
  });
  const lockedGradeSaveResponse = await fetch(`${baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      grades: { ...termGrades, filipino: "89" },
    }),
  });
  assert.equal(lockedGradeSaveResponse.status, 409);
  assert.match((await lockedGradeSaveResponse.json()).error, /Term 1 grades for this student are locked/i);
  const lockedEClassGradeSyncResponse = await fetch(`${baseUrl}/api/grades/subject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      subject: "physicalEducationAndHealth",
      grade: 90,
    }),
  });
  assert.equal(lockedEClassGradeSyncResponse.status, 200);
  assert.equal((await lockedEClassGradeSyncResponse.json()).grade, 90);
  const unlockGradesResponse = await fetch(`${baseUrl}/api/grades/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      locked: false,
      password: teacherCredentials.password,
    }),
  });
  assert.equal(unlockGradesResponse.status, 200);
  assert.deepEqual(await unlockGradesResponse.json(), {
    studentId: addedStudent.student.id,
    term: "Term 1",
    locked: false,
  });
  const resaveAfterEditResponse = await fetch(`${baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      grades: termGrades,
    }),
  });
  assert.equal(resaveAfterEditResponse.status, 200);
  assert.equal((await resaveAfterEditResponse.json()).locked, false, "saving edited grades does not lock the term");

  const termTwoGradesResponse = await fetch(
    `${baseUrl}/api/grades?studentId=${encodeURIComponent(addedStudent.student.id)}&term=Term%202`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(termTwoGradesResponse.status, 200);
  assert.equal((await termTwoGradesResponse.json()).grades.filipino, "");

  const termGradesByTerm = {
    "Term 1": Object.fromEntries(Object.entries(termGrades).map(([subject, grade]) => [subject, Number(grade)])),
    "Term 2": Object.fromEntries(Object.entries(termGrades).map(([subject, grade]) => [subject, Number(grade) - 1])),
    "Term 3": Object.fromEntries(Object.entries(termGrades).map(([subject, grade]) => [subject, Number(grade) - 2])),
  };
  termGradesByTerm["Term 1"].physicalEducationAndHealth = 90;
  for (const term of ["Term 2", "Term 3"]) {
    const termLockResponse = await fetch(
      `${baseUrl}/api/grades/lock?studentId=${encodeURIComponent(addedStudent.student.id)}&term=${encodeURIComponent(term)}`,
      { headers: { Cookie: teacherCookie } },
    );
    assert.equal(termLockResponse.status, 200);
    assert.equal((await termLockResponse.json()).locked, true);
    const unlockTermResponse = await fetch(`${baseUrl}/api/grades/lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({
        studentId: addedStudent.student.id,
        term,
        locked: false,
        password: teacherCredentials.password,
      }),
    });
    assert.equal(unlockTermResponse.status, 200);
    const response = await fetch(`${baseUrl}/api/grades`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({
        studentId: addedStudent.student.id,
        term,
        grades: termGradesByTerm[term],
      }),
    });
    assert.equal(response.status, 200);
  }

  const gradeSummaryResponse = await fetch(`${baseUrl}/api/grades/summary`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(gradeSummaryResponse.status, 200);
  const gradeSummary = await gradeSummaryResponse.json();
  assert.deepEqual(gradeSummary.terms, ["Term 1", "Term 2", "Term 3"]);
  assert.deepEqual(gradeSummary.students.map((student) => student.id), [addedStudent.student.id]);
  assert.deepEqual(gradeSummary.subjects.map((subject) => subject.key), [
    "english",
    "filipino",
    "mathematics",
    "science",
    "aralingPanlipunan",
    "epp",
    "mapeh",
    "gmrc",
  ]);
  for (const term of gradeSummary.terms) {
    const summaryGrades = gradeSummary.students[0].grades[term];
    for (const [subject, grade] of Object.entries(termGradesByTerm[term])) {
      assert.equal(summaryGrades[subject], grade, `${term} ${subject} appears in the summary`);
    }
    assert.equal(
      summaryGrades.mapeh,
      Math.round(((termGradesByTerm[term].musicAndArts + termGradesByTerm[term].physicalEducationAndHealth) / 2) * 100) / 100,
      `${term} MAPEH average appears in the summary`,
    );
  }
  const gradingSheetResponse = await fetch(`${baseUrl}/api/grades/summary/export`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(gradingSheetResponse.status, 200);
  assert.match(
    gradingSheetResponse.headers.get("content-type"),
    /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/,
  );
  assert.match(gradingSheetResponse.headers.get("content-disposition"), /Grading_Sheet_.+\.xlsx/);
  const gradingWorkbook = new ExcelJS.Workbook();
  await gradingWorkbook.xlsx.load(Buffer.from(await gradingSheetResponse.arrayBuffer()));
  const gradingSheet = gradingWorkbook.getWorksheet("SUMMARY - FINAL GRADES");
  assert.ok(gradingSheet, "export preserves the project grading sheet template");
  const sourceGradingWorkbook = new ExcelJS.Workbook();
  await sourceGradingWorkbook.xlsx.readFile(path.join(__dirname, "..", "Grading Sheet.xlsx"));
  const sourceGradingSheet = sourceGradingWorkbook.getWorksheet("SUMMARY - FINAL GRADES")
    || sourceGradingWorkbook.getWorksheet("FINAL GRADES");
  assert.ok(gradingSheet.model.merges.includes("B1:AM1"), "export adds a clearly titled portal summary sheet");
  const preservedTemplateSheet = gradingWorkbook.getWorksheet("FINAL GRADES");
  assert.deepEqual(
    [...preservedTemplateSheet.model.merges].sort(),
    [...sourceGradingSheet.model.merges].sort(),
    "export preserves the original template worksheet",
  );
  assert.equal(
    preservedTemplateSheet.getImages().length,
    sourceGradingSheet.getImages().length,
    "export preserves the original template images",
  );
  assert.equal(gradingSheet.getCell("B62").value, gradeSummary.students[0].name);
  const gradingSubjects = [
    ["english", 6],
    ["filipino", 10],
    ["mathematics", 14],
    ["science", 18],
    ["aralingPanlipunan", 22],
    ["epp", 26],
    ["mapeh", 30],
    ["gmrc", 34],
  ];
  gradingSubjects.forEach(([subject, firstQuarterColumn]) => {
    ["Term 1", "Term 2", "Term 3"].forEach((term, quarterIndex) => {
      assert.equal(
        gradingSheet.getCell(62, firstQuarterColumn + quarterIndex).value,
        gradeSummary.students[0].grades[term][subject],
        `${subject} ${term} grade appears in the corresponding template quarter`,
      );
    });
  });
  assert.equal(
    gradingSheet.getCell("M62").value,
    Math.round(["Term 1", "Term 2", "Term 3"]
      .map((term) => gradeSummary.students[0].grades[term].filipino)
      .reduce((total, grade) => total + grade, 0) / 3),
    "export calculates the Filipino final grade from all three terms",
  );
  const finalSubjectGrades = ["english", "filipino", "mathematics", "science", "aralingPanlipunan", "epp", "mapeh", "gmrc"]
    .map((subject) => Math.round(["Term 1", "Term 2", "Term 3"]
      .map((term) => gradeSummary.students[0].grades[term][subject])
      .reduce((total, grade) => total + grade, 0) / 3));
  assert.equal(
    gradingSheet.getCell("AM62").value,
    Math.round(finalSubjectGrades.reduce((total, grade) => total + grade, 0) / finalSubjectGrades.length),
    "export calculates general average from all eight final grades",
  );
  const sf9AttendanceMonth = "2026-10";
  const sf9AttendanceDates = attendanceWeekdays(sf9AttendanceMonth);
  const sf9NoClassDates = [sf9AttendanceDates[1]];
  const sf9SchoolYearMonths = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11",
    "2026-12", "2027-01", "2027-02", "2027-03", "2027-04"];
  const sf9WebClassDays = new Map();
  const sf9MonthStatuses = new Map([
    ["2026-06", "Present"], ["2026-07", "Absent"], ["2026-08", "Tardy"], ["2026-09", "Absent"],
    ["2026-10", "Present"], ["2026-11", "Excused"], ["2026-12", "Absent"], ["2027-01", "Tardy"],
    ["2027-02", "Present"], ["2027-03", "Absent"], ["2027-04", "Absent"],
  ]);
  const saveSF9Attendance = (month, records, noClassDates = []) => fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ month, noClassDates, records }),
  });
  for (const [month, status] of sf9MonthStatuses) {
    const monthDates = attendanceWeekdays(month);
    const records = gradeSummary.students.map((student) => {
      const attendance = Array(monthDates.length).fill("");
      const reasons = Array(monthDates.length).fill("");
      if (student.id === addedStudent.student.id) {
        attendance[0] = status;
        if (month === sf9AttendanceMonth) {
          attendance[2] = "Absent";
          attendance[3] = "Absent";
          reasons[2] = "Medical appointment";
          reasons[3] = "Medical appointment";
        }
      }
      if (student.id === addedStudent.student.id && status === "Absent") {
        reasons[0] = "Medical appointment";
      }
      return {
        studentId: student.id,
        attendance,
        reasons,
        remarks: "",
      };
    });
    const noClassDates = month === sf9AttendanceMonth ? sf9NoClassDates : [];
    const savedAttendance = await saveSF9Attendance(month, records, noClassDates);
    assert.equal(savedAttendance.status, 200, `attendance for ${month} is saved: ${await savedAttendance.clone().text()}`);
    const attendanceMonthResponse = await fetch(
      `${baseUrl}/api/attendance/month?month=${month}`,
      { headers: { Cookie: teacherCookie } },
    );
    assert.equal(attendanceMonthResponse.status, 200, `attendance for ${month} is available to the page`);
    const attendanceMonthResult = await attendanceMonthResponse.json();
    assert.deepEqual(attendanceMonthResult.statuses, ["Present", "Absent", "Tardy", "Excused"]);
    sf9WebClassDays.set(month, countClassDays(attendanceMonthResult));
  }
  const sf9StoredAttendance = readPortalDatabaseWorkbook(databasePath);
  const sf9AttendanceSheet = sf9StoredAttendance.getWorksheet("Attendance Records");
  const sf9AttendanceHeaders = new Map(
    sf9AttendanceSheet.getRow(1).values.slice(1).map((value, index) => [String(value).toLowerCase(), index + 1]),
  );
  let sf9DashRecordFound = false;
  for (let rowNumber = 2; rowNumber <= sf9AttendanceSheet.rowCount; rowNumber += 1) {
    const attendanceRow = sf9AttendanceSheet.getRow(rowNumber);
    const storedDate = attendanceRow.getCell(sf9AttendanceHeaders.get("attendance date")).value;
    const date = storedDate instanceof Date ? storedDate.toISOString().slice(0, 10) : String(storedDate);
    if (
      attendanceRow.getCell(sf9AttendanceHeaders.get("student id")).value === addedStudent.student.id
      && date === `${sf9AttendanceMonth}-01`
    ) {
      attendanceRow.getCell(sf9AttendanceHeaders.get("status")).value = "-";
      sf9DashRecordFound = true;
      break;
    }
  }
  assert.equal(sf9DashRecordFound, true, "October attendance record exists for dash-as-present regression");
  writePortalDatabaseWorkbook(databasePath, sf9StoredAttendance);
  const sf9DashAttendanceResponse = await fetch(
    `${baseUrl}/api/attendance/month?month=${sf9AttendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(sf9DashAttendanceResponse.status, 200);
  const sf9DashAttendance = await sf9DashAttendanceResponse.json();
  assert.equal(sf9DashAttendance.students[0].attendance[0], "Present", "a saved dash is interpreted as present");
  const sf9Response = await fetch(
    `${baseUrl}/api/grades/sf9?studentId=${encodeURIComponent(addedStudent.student.id)}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(sf9Response.status, 200);
  assert.match(
    sf9Response.headers.get("content-disposition"),
    /^attachment; filename="SF9_.*_2026-2027\.xlsx"$/,
  );
  assert.equal(
    sf9Response.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  const sf9PreviewResponse = await fetch(
    `${baseUrl}/api/grades/sf9?studentId=${encodeURIComponent(addedStudent.student.id)}&format=preview`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(sf9PreviewResponse.status, 200);
  assert.match(sf9PreviewResponse.headers.get("content-type"), /^text\/html; charset=utf-8$/);
  assert.match(sf9PreviewResponse.headers.get("content-security-policy"), /connect-src 'self'/);
  const sf9PreviewHtml = await sf9PreviewResponse.text();
  assert.match(sf9PreviewHtml, /default-src 'none'; connect-src 'self'; img-src data:/);
  assert.match(sf9PreviewHtml, /SF9 Print Preview/);
  assert.match(sf9PreviewHtml, />Close<\/button>/);
  assert.match(sf9PreviewHtml, /getElementById\("closePreview"\).*window\.close\(\).*window\.location\.assign\("\/"\)/);
  assert.match(sf9PreviewHtml, /<select id="printSelection" aria-label="Choose what to print"><option value="All Without Attendance" selected>All Without Attendance<\/option><option value="All with Attendance">All with Attendance<\/option><option value="Term 1">Term 1<\/option><option value="Term 2">Term 2<\/option><option value="Term 3">Term 3<\/option><option value="Attendance">Attendance<\/option><\/select>/);
  assert.match(sf9PreviewHtml, /printSelection\.addEventListener\("change",applyPrintSelection\)/);
  assert.doesNotMatch(sf9PreviewHtml, /<button id="printAllPreview" type="button">Print All<\/button>/, "SF9 preview does not expose class-wide printing");
  assert.match(sf9PreviewHtml, /<button id="downloadAllPdf" type="button">Download All Students as PDF<\/button>/);
  assert.match(sf9PreviewHtml, /window\.gradePortal\.downloadSF9Pdf\(printSelection\.value\)/);
  assert.match(sf9PreviewHtml, /id="printAllLoading" class="loading-overlay" role="status" aria-live="polite"[^>]*hidden/);
  assert.match(sf9PreviewHtml, /class="loading-orbit" aria-hidden="true"><div class="loading-core"><\/div><\/div>/);
  assert.match(sf9PreviewHtml, /class="loading-progress" aria-hidden="true"/);
  assert.match(sf9PreviewHtml, /background:radial-gradient\(ellipse at 50% 42%,rgba\(16,185,176,\.16\),transparent 42%\)/);
  assert.match(sf9PreviewHtml, /prefers-reduced-motion:reduce/);
  assert.match(sf9PreviewHtml, /Preparing SF9 Reports/);
  assert.match(sf9PreviewHtml, /document\.getElementById\("printAllLoading"\)\.hidden=false/);
  assert.match(sf9PreviewHtml, /document\.getElementById\("printAllLoading"\)\.hidden=true/);
  assert.match(sf9PreviewHtml, /allPreviewWindow\.document\.write\('<!doctype html><html lang="en"><head>[\s\S]*?Preparing SF9 Reports[\s\S]*?class="orbit"[\s\S]*?class="core"/, "the newly opened tab immediately displays a futuristic animated loading screen");
  assert.match(sf9PreviewHtml, /allPreviewWindow\.document\.write\([\s\S]*?Please wait\.\.\./);
  assert.match(sf9PreviewHtml, /\.loading-overlay\{position:fixed;inset:0;z-index:10/);
  assert.match(sf9PreviewHtml, /\.loading-overlay\{display:none!important\}/, "the loading overlay is excluded from print output");
  assert.match(sf9PreviewHtml, /api\/grades\/sf9\?all=true&format=preview&selection=/);
  assert.match(sf9PreviewHtml, /body\[data-print-selection="Attendance"\] td\{visibility:hidden!important;border-color:transparent!important;background-color:transparent!important\}/);
  assert.match(sf9PreviewHtml, /body\[data-print-selection="Attendance"\] td\[data-attendance\]\{visibility:visible!important\}/);
  assert.match(sf9PreviewHtml, /body\[data-print-selection="Attendance"\] \.sf9-logo\{visibility:hidden\}/);
  assert.match(sf9PreviewHtml, /<td data-row="5" data-column="18" data-attendance="true" data-attendance-text="22"/, "attendance values retain their original SF9 cells");
  assert.match(sf9PreviewHtml, /<td data-row="7" data-column="18" data-attendance="true"/, "present-day values remain visible in their original cells");
  assert.match(sf9PreviewHtml, /<td data-row="9" data-column="29" data-attendance="true"/, "the attendance total remains in its original SF9 cell");
  assert.doesNotMatch(sf9PreviewHtml, /<td data-row="4" data-column="18" data-attendance="true"/, "month labels are not shown as attendance values");
  assert.doesNotMatch(sf9PreviewHtml, /<td data-row="5" data-column="17" data-attendance="true"/, "attendance row labels are not shown");
  assert.doesNotMatch(sf9PreviewHtml, /column\.hidden=|cell\.hidden=/, "section filtering does not collapse the original SF9 grid");
  assert.match(sf9PreviewHtml, /body\[data-print-selection\^="Term "\] td\{visibility:hidden!important;border-color:transparent!important;background-color:transparent!important\}/);
  assert.match(sf9PreviewHtml, /body\[data-print-selection="Term 1"\] td\[data-term-grade="1"\][\s\S]*?visibility:visible!important/);
  assert.match(sf9PreviewHtml, /body\[data-print-selection="Term 3"\] td\[data-term-three-summary="true"\]\{visibility:visible!important\}/);
  assert.match(sf9PreviewHtml, /<td data-row="32" data-column="9" data-term-three-summary="true"/, "Term 3 also shows each final grade in its original cell");
  assert.match(sf9PreviewHtml, /<td data-row="32" data-column="10" data-term-three-summary="true"/, "Term 3 also shows the remarks in their original cells");
  assert.match(sf9PreviewHtml, /<td data-row="42" data-column="9" data-term-three-summary="true"/, "Term 3 also shows General Average in its original cell");
  assert.match(sf9PreviewHtml, /<td data-row="42" data-column="10" data-term-three-summary="true"/, "Term 3 also shows the General Average remark in its original cell");
  assert.match(sf9PreviewHtml, /body\[data-print-selection\^="Term "\] \.sf9-logo\{visibility:hidden\}/);
  assert.match(sf9PreviewHtml, /cell\.textContent=selection==="All Without Attendance"\|\|selection==="All with Attendance"\|\|\([\s\S]*?Number\(cell\.dataset\.termGrade\)===term[\s\S]*?\)\?cell\.dataset\.gradeText:""/);
  assert.match(sf9PreviewHtml, /cell\.textContent=selection==="All Without Attendance"\?"":cell\.dataset\.attendanceText/);
  assert.match(sf9PreviewHtml, /data-row="33" data-column="6" data-term-grade="1" data-grade-text="91"/);
  assert.doesNotMatch(sf9PreviewHtml, /data-row="31" data-column="6" data-term-grade=/, "term headers remain unfiltered");
  assert.match(sf9PreviewHtml, /aria-label="SF9 learner progress report"/);
  assert.match(sf9PreviewHtml, /data-page-size="A4 landscape" data-print-area="A2:AD54"/);
  assert.match(sf9PreviewHtml, /<td data-row="32" data-column="1"[^>]*><\/td>/,
    "the narrow spacer column does not contain a duplicate subject label");
  assert.match(sf9PreviewHtml, /<td data-row="32" data-column="2" colspan="4"[^>]*>Filipino<\/td>/,
    "subject labels follow the SF9 learning-area order in their merged cells");
  assert.match(sf9PreviewHtml, /<td data-row="39" data-column="2" colspan="4"[^>]*>MAPEH<\/td>/,
    "the SF9 shows the MAPEH average");
  assert.match(sf9PreviewHtml, /<td data-row="40" data-column="2" colspan="4"[^>]*>Music and Arts<\/td>/,
    "the SF9 shows Music and Arts beneath MAPEH");
  assert.match(sf9PreviewHtml, /<td data-row="41" data-column="2" colspan="4"[^>]*>Physical Education and Health<\/td>/,
    "the SF9 shows Physical Education and Health beneath MAPEH");
  assert.match(sf9PreviewHtml, /<td data-row="2" data-column="1"/, "the preview includes the full template's top-left print-area edge");
  assert.match(sf9PreviewHtml, /<td data-row="54" data-column="30"/, "the preview includes the full template's bottom-right print-area edge");
  assert.match(sf9PreviewHtml, /@page\{size:297mm 210mm;margin:0\}/, "single SF9 printing sets the exact A4 landscape dimensions with zero configured page margins");
  assert.match(sf9PreviewHtml, /\.viewport\{display:block;width:297mm;height:210mm;overflow:visible;padding:0\}/, "single SF9 printing uses one complete A4 page as its layout container");
  assert.match(sf9PreviewHtml, /\.paper\{width:297mm;height:210mm;margin:0;box-shadow:none;overflow:hidden;break-inside:avoid;page-break-inside:avoid;break-after:avoid\}/, "the complete SF9 stays together on a single landscape page");
  assert.match(sf9PreviewHtml, /\.sheet-scale\{left:calc\(50% - [\d.]+px\);top:calc\(50% - [\d.]+px\);transform:scale\([\d.]+\);transform-origin:top left\}/, "single SF9 printing scales and centers the whole report inside the safe page area");
  const sf9PreviewDimensions = sf9PreviewHtml.match(
    /data-report-width="([\d.]+)" data-report-height="([\d.]+)" data-fit-scale="([\d.]+)" data-safe-margin-mm="0"/,
  );
  assert.ok(sf9PreviewDimensions, "the print preview reports full-page A4 fit dimensions");
  const expectedPreviewScale = Math.min(
    ((297 / 25.4) * 96) / Number(sf9PreviewDimensions[1]),
    ((210 / 25.4) * 96) / Number(sf9PreviewDimensions[2]),
  ) * 0.97;
  assert.ok(
    Math.abs(Number(sf9PreviewDimensions[3]) - expectedPreviewScale) < 0.000001,
    "the preview allows for browser-rendered table rows that slightly exceed workbook heights",
  );
  const sf9RosterResponse = await fetch(`${baseUrl}/api/students`, { headers: { Cookie: teacherCookie } });
  assert.equal(sf9RosterResponse.status, 200);
  const sf9Roster = await sf9RosterResponse.json();
  const sf9AllPreviewResponse = await fetch(
    `${baseUrl}/api/grades/sf9?all=true&format=preview&selection=${encodeURIComponent("Term 3")}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(sf9AllPreviewResponse.status, 200);
  const sf9AllPreviewHtml = await sf9AllPreviewResponse.text();
  assert.match(sf9AllPreviewHtml, /SF9 Print Preview - All Students/);
  assert.match(sf9AllPreviewHtml, /default-src 'none'; connect-src 'self'; img-src data:/);
  assert.match(sf9AllPreviewHtml, /<option value="Term 3" selected>/, "Print All keeps the selected print section");
  assert.equal(
    (sf9AllPreviewHtml.match(/<section class="paper batch-page"/g) || []).length,
    Math.max(0, sf9Roster.students.length - 1),
    "Print All starts each additional learner report on a new page",
  );
  assert.equal(
    (sf9AllPreviewHtml.match(/<section class="paper(?: batch-page)?"/g) || []).length,
    sf9Roster.students.length,
    "Print All creates a complete SF9 page for every student",
  );
  assert.match(sf9AllPreviewHtml, /@page\{size:297mm 210mm;margin:0\}/, "Print All sets exact A4 landscape dimensions with zero configured page margins");
  assert.match(sf9AllPreviewHtml, /body\.batch-print \.paper\{[^}]*height:210mm!important;min-height:210mm!important;max-height:210mm!important[^}]*break-inside:avoid!important;page-break-inside:avoid!important;break-after:page!important;page-break-after:always!important\}/, "each learner report occupies one complete unsplittable A4 landscape page");
  assert.match(sf9AllPreviewHtml, /body\.batch-print \.paper:last-child\{break-after:auto!important;page-break-after:auto!important\}/, "Print All avoids a blank trailing page");
  assert.doesNotMatch(sf9AllPreviewHtml, /break-before:page!important|page-break-before:always!important/, "Print All advances after each complete report instead of breaking inside the next report");
  assert.match(sf9AllPreviewHtml, /body\.batch-print \.sheet-scale\{left:calc\(50% - [\d.]+px\)!important;top:calc\(50% - [\d.]+px\)!important;transform:scale\([\d.]+\)!important;transform-origin:top left!important\}/, "each SF9 is centered and safely scaled within its physical page");
  assert.match(sf9AllPreviewHtml, /body\.batch-print \.viewport\{display:block!important;position:static!important;width:297mm!important;height:auto!important;min-height:0!important;margin:0!important;padding:0!important;overflow:visible!important\}/, "the print container uses exact A4 page width for stable pagination");
  assert.match(sf9AllPreviewHtml, /window\.addEventListener\("load",function\(\)\{window\.print\(\)\},\{once:true\}\)/, "class printing starts only after every report page and logo has loaded");
  const printableWidth = (297 / 25.4) * 96;
  const printableHeight = (210 / 25.4) * 96;
  assert.ok(
    Number(sf9PreviewDimensions[1]) * Number(sf9PreviewDimensions[3]) <= printableWidth + 0.1,
    "the report fits the full A4 page width",
  );
  assert.ok(
    Number(sf9PreviewDimensions[2]) * Number(sf9PreviewDimensions[3]) <= printableHeight + 0.1,
    "the report fits the full A4 page height",
  );
  const batchPrintScale = sf9AllPreviewHtml.match(
    /body\.batch-print \.sheet-scale\{[^}]*transform:scale\(([\d.]+)\)!important/,
  );
  assert.ok(batchPrintScale, "Print All applies a measured fit scale to each SF9");
  const expectedBatchPrintScale = Math.min(
    ((285 / 25.4) * 96) / Number(sf9PreviewDimensions[1]),
    ((198 / 25.4) * 96) / Number(sf9PreviewDimensions[2]),
  ) * 0.99;
  assert.ok(
    Math.abs(Number(batchPrintScale[1]) - expectedBatchPrintScale) < 0.000001,
    "Print All scales reports inside the exact A4 page with a 6mm safe content buffer", 
  );
  const sf9ProfileResponse = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(sf9ProfileResponse.status, 200);
  const sf9Profile = await sf9ProfileResponse.json();
  const sf9SubjectCases = [
    { grade: "Grade 1", subjects: ["Language", "Reading and Literacy", "Mathematics", "Makabansa", "GMRC (Good Manners and Right Conduct)"] },
    { grade: "Grade 2", subjects: ["English", "Literacy", "Mathematics", "Makabansa", "GMRC"] },
    { grade: "Grade 3", subjects: ["English", "Filipino", "Mathematics", "Science", "Makabansa", "GMRC"] },
    { grade: "Grade 4", subjects: ["Filipino", "English", "Mathematics", "Science", "Araling Panlipunan", "GMRC", "EPP", "MAPEH", "Music and Arts", "Physical Education and Health"] },
    { grade: "Grade 5", subjects: ["Filipino", "English", "Mathematics", "Science", "Araling Panlipunan", "GMRC", "EPP", "MAPEH", "Music and Arts", "Physical Education and Health"] },
    { grade: "Grade 6", subjects: ["Filipino", "English", "Mathematics", "Science", "Araling Panlipunan", "GMRC", "TLE", "MAPEH", "Music and Arts", "Physical Education and Health"] },
    ...["Grade 7", "Grade 8", "Grade 9", "Grade 10"].map((grade) => ({
      grade,
      subjects: ["Filipino", "English", "Mathematics", "Science", "Araling Panlipunan", "Values Education / GMRC", "TLE", "MAPEH", "Music and Arts", "Physical Education and Health"],
    })),
  ];
  for (const testCase of sf9SubjectCases) {
    const gradeUpdate = await updateProfile(teacherCookie, {
      name: sf9Profile.name,
      email: sf9Profile.email,
      classroomNumber: sf9Profile.classroomNumber,
      grade: testCase.grade,
      ...(testCase.grade === "Grade 1" ? { schoolYear: "" } : {}),
    });
    assert.equal(gradeUpdate.status, 200, `${testCase.grade} profile update`);
    const gradePreviewResponse = await fetch(
      `${baseUrl}/api/grades/sf9?studentId=${encodeURIComponent(addedStudent.student.id)}&format=preview`,
      { headers: { Cookie: teacherCookie } },
    );
    assert.equal(gradePreviewResponse.status, 200, `${testCase.grade} SF9 preview`);
    const gradePreviewHtml = await gradePreviewResponse.text();
    const gradeSubjectLabels = Array.from(
      gradePreviewHtml.matchAll(/<td data-row="(?:3[2-9]|4[01])" data-column="2" colspan="4"[^>]*>(.*?)<\/td>/g),
      (match) => match[1],
    ).filter(Boolean);
    assert.deepEqual(gradeSubjectLabels, testCase.subjects, `${testCase.grade} SF9 learning areas`);
    if (testCase.grade === "Grade 1") {
      const gradeWorkbookResponse = await fetch(
        `${baseUrl}/api/grades/sf9?studentId=${encodeURIComponent(addedStudent.student.id)}`,
        { headers: { Cookie: teacherCookie } },
      );
      assert.equal(gradeWorkbookResponse.status, 200, "Grade 1 SF9 workbook export");
      const gradeWorkbook = new ExcelJS.Workbook();
      await gradeWorkbook.xlsx.load(Buffer.from(await gradeWorkbookResponse.arrayBuffer()));
      const gradeSheet = gradeWorkbook.getWorksheet("SF9 - GRADE 4-10");
      assert.deepEqual(
        Array.from({ length: 5 }, (_, index) => gradeSheet.getCell(32 + index, 2).value),
        testCase.subjects,
        "the Grade 1 download prints its own learning areas",
      );
    }
  }
  const restoreGradeProfile = await updateProfile(teacherCookie, {
    name: sf9Profile.name,
    email: sf9Profile.email,
    classroomNumber: sf9Profile.classroomNumber,
    grade: sf9Profile.grade,
    schoolYear: sf9Profile.schoolYear,
  });
  assert.equal(restoreGradeProfile.status, 200, "the SF9 grade-level test restores the teacher profile");
  const mergedTableHeader = sf9PreviewHtml.match(/<td data-row="30" data-column="2"[^>]*>Learning Areas<\/td>/);
  assert.ok(mergedTableHeader, "the merged SF9 table header is rendered");
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(mergedTableHeader[0], new RegExp(`border-${side}:`), `merged SF9 header preserves its ${side} border`);
  }
  assert.match(sf9PreviewHtml, /td\{padding:1px 2px;line-height:1\.05;overflow:visible\}/);
  assert.ok(sf9PreviewHtml.includes(addedStudent.student.name), "the print preview shows the selected learner's name");
  assert.ok(sf9PreviewHtml.includes(addedStudent.student.lrn), "the print preview shows the selected learner's LRN");
  assert.match(sf9PreviewHtml, /<td[^>]*>88<\/td>/, "the print preview contains saved learner grades");
  assert.match(sf9PreviewHtml, /<img class="sf9-logo"/, "the print preview includes the school logos");
  assert.match(sf9PreviewHtml, /window\.print\(\)/, "the preview offers browser printing");
  const sf9Workbook = new ExcelJS.Workbook();
  await sf9Workbook.xlsx.load(Buffer.from(await sf9Response.arrayBuffer()));
  const sf9Sheet = sf9Workbook.getWorksheet("SF9 - GRADE 4-10");
  assert.ok(sf9Sheet, "SF9 export uses the Grade 4–10 template");
  assert.equal(sf9Sheet.pageSetup.paperSize, 9, "SF9 export uses A4 paper");
  assert.equal(sf9Sheet.pageSetup.orientation, "landscape", "SF9 export uses landscape orientation");
  assert.equal(sf9Sheet.pageSetup.fitToPage, true, "SF9 export is scaled to fit its print area");
  assert.equal(sf9Sheet.pageSetup.fitToWidth, 1);
  assert.equal(sf9Sheet.pageSetup.fitToHeight, 1);
  assert.equal(sf9Sheet.pageSetup.printArea, "A2:AD54", "SF9 export preserves the template's original print area");
  assert.equal(sf9Sheet.pageSetup.margins.left, 0);
  assert.equal(sf9Sheet.pageSetup.margins.right, 0);
  assert.equal(sf9Sheet.pageSetup.margins.top, 0);
  assert.equal(sf9Sheet.pageSetup.margins.bottom, 0);
  assert.equal(sf9Sheet.getCell("A32").value, null, "the SF9 spacer column stays empty next to the merged learning-area labels");
  assert.equal(sf9Sheet.getCell("B32").value, "Filipino");
  assert.equal(sf9Sheet.getCell("B37").value, "GMRC");
  assert.equal(sf9Sheet.getCell("B38").value, "EPP");
  assert.equal(sf9Sheet.getCell("B39").value, "MAPEH");
  assert.equal(sf9Sheet.getCell("B40").value, "Music and Arts");
  assert.equal(sf9Sheet.getCell("B41").value, "Physical Education and Health");
  assert.ok(sf9Sheet.getCell("C17").isMerged, "the SF9 template's merged learner-name field is preserved");
  assert.equal(sf9Sheet.getCell("B32").font.name, "Bookman Old Style", "the SF9 template font is preserved");
  assert.equal(sf9Sheet.getCell("B32").border.left.style, "thin", "the SF9 template table borders are preserved");
  assert.equal(sf9Sheet.getCell("B12").value, "Sample Elementary School");
  assert.equal(sf9Sheet.getCell("B15").value, "2026-2027");
  assert.equal(sf9Sheet.getCell("B7").value, "Region IX");
  assert.equal(sf9Sheet.getCell("B8").value, "Zamboanga City");
  assert.equal(sf9Sheet.getCell("B9").value, "West District");
  assert.equal(sf9Sheet.getCell("C17").value, addedStudent.student.name);
  assert.equal(sf9Sheet.getCell("C18").value, addedStudent.student.lrn);
  assert.equal(sf9Sheet.getCell("I18").value, "Grade 5");
  assert.equal(sf9Sheet.getCell("K18").value, "Mabini");
  assert.equal(sf9Sheet.getCell("B27").value, "Alex Principal");
  assert.equal(sf9Sheet.getCell("H27").value, "Taylor Teacher");
  assert.equal(sf9Sheet.getCell("Q41").value, "Alex Principal");
  assert.equal(sf9Sheet.getCell("X40").value, "Taylor Teacher");
  const sf9MonthColumns = ["R", "S", "T", "U", "V", "W", "X", "Y", "Z", "AA", "AB"];
  const sf9MonthLabels = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr"];
  for (let index = 0; index < sf9SchoolYearMonths.length; index += 1) {
    const month = sf9SchoolYearMonths[index];
    const column = sf9MonthColumns[index];
    const status = sf9MonthStatuses.get(month);
    const expectedAbsent = (status === "Absent" ? 1 : 0)
      + (month === sf9AttendanceMonth ? 2 : 0);
    assert.equal(sf9Sheet.getCell(`${column}4`).value, sf9MonthLabels[index], `${month} maps to ${sf9MonthLabels[index]}`);
    assert.equal(
      sf9Sheet.getCell(`${column}5`).value,
      sf9WebClassDays.get(month),
      `${sf9MonthLabels[index]} class-day total matches the attendance page`,
    );
    assert.equal(
      sf9Sheet.getCell(`${column}7`).value,
      sf9WebClassDays.get(month) - expectedAbsent,
      `${sf9MonthLabels[index]} reflects the attendance status`,
    );
    assert.equal(sf9Sheet.getCell(`${column}9`).value, expectedAbsent);
  }
  assert.equal(sf9Sheet.getCell("V5").value, 21, "October shows 21 class days on the generated SF9");
  assert.equal(sf9Sheet.getCell("V7").value, 19, "October shows the 19 present days after two absences");
  assert.equal(
    sf9Sheet.getCell("AC5").value,
    [...sf9WebClassDays.values()].reduce((total, classDays) => total + classDays, 0),
    "SF9 annual class-day total matches the attendance-page monthly totals",
  );
  const sf9TotalAbsent = sf9SchoolYearMonths.reduce((total, month) => {
    const status = sf9MonthStatuses.get(month);
    return total + (status === "Absent" ? 1 : 0)
      + (month === sf9AttendanceMonth ? 2 : 0);
  }, 0);
  assert.equal(sf9Sheet.getCell("AC9").value, sf9TotalAbsent);
  assert.equal(
    sf9Sheet.getCell("AC7").value,
    [...sf9WebClassDays.values()].reduce((total, classDays) => total + classDays, 0) - sf9TotalAbsent,
  );
  const schoolLogoImage = sf9Sheet.getImages().find((image) =>
    image.range.tl.nativeCol === 9 && image.range.tl.nativeRow === 3);
  const leftSchoolLogo = sf9Sheet.getImages().find((image) =>
    image.range.tl.nativeCol <= 1 && image.range.tl.nativeRow === 3);
  assert.ok(schoolLogoImage, "the uploaded school logo replaces the template school logo");
  assert.ok(leftSchoolLogo, "the SF9 template's left-side logo remains in place");
  assert.equal(sf9Sheet.getImages().length, 2, "the default logo is replaced instead of duplicated");
  assert.equal(schoolLogoImage.range.ext.width, 1.44 * 96, "school logo is exactly 1.44 inches wide");
  assert.equal(schoolLogoImage.range.ext.height, 1.44 * 96, "school logo is exactly 1.44 inches tall");
  assert.equal(schoolLogoImage.range.ext.width, leftSchoolLogo.range.ext.width);
  assert.equal(schoolLogoImage.range.ext.height, leftSchoolLogo.range.ext.height);
  const schoolLogoBuffer = sf9Workbook.getImage(schoolLogoImage.imageId).buffer;
  const schoolLogoMetadata = await sharp(schoolLogoBuffer).metadata();
  assert.equal(schoolLogoMetadata.width, 512);
  assert.equal(schoolLogoMetadata.height, 512);
  assert.equal(schoolLogoMetadata.channels, 4, "the circular logo has a transparent alpha channel");
  const { data: schoolLogoPixels, info: schoolLogoPixelInfo } = await sharp(schoolLogoBuffer)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const schoolLogoPixel = (x, y) => {
    const offset = (y * schoolLogoPixelInfo.width + x) * schoolLogoPixelInfo.channels;
    return {
      red: schoolLogoPixels[offset],
      green: schoolLogoPixels[offset + 1],
      blue: schoolLogoPixels[offset + 2],
      alpha: schoolLogoPixels[offset + 3],
    };
  };
  assert.equal(schoolLogoPixel(0, 0).alpha, 0, "the exported logo corners are transparent");
  assert.equal(
    schoolLogoPixel(256, 64).alpha,
    0,
    "the uploaded logo's white background is removed and its proportions are preserved",
  );
  const logoBorderPixel = schoolLogoPixel(256, 1);
  assert.ok(logoBorderPixel.alpha > 0, "the circular picture border is visible");
  assert.deepEqual(
    [logoBorderPixel.red, logoBorderPixel.green, logoBorderPixel.blue],
    [0, 0, 0],
    "the circular picture border is black",
  );
  assert.ok(schoolLogoPixel(256, 256).alpha > 0, "the center of the exported logo remains visible");
  assert.equal(sf9Sheet.getCell("F33").value, termGradesByTerm["Term 1"].english);
  assert.equal(sf9Sheet.getCell("G33").value, termGradesByTerm["Term 2"].english);
  assert.equal(sf9Sheet.getCell("H33").value, termGradesByTerm["Term 3"].english);
  assert.equal(
    sf9Sheet.getCell("F39").value,
    Math.round(((Number(termGradesByTerm["Term 1"].musicAndArts)
      + Number(termGradesByTerm["Term 1"].physicalEducationAndHealth)) / 2) * 100) / 100,
  );
  assert.equal(sf9Sheet.getCell("F40").value, Number(termGradesByTerm["Term 1"].musicAndArts));
  assert.equal(sf9Sheet.getCell("F41").value, Number(termGradesByTerm["Term 1"].physicalEducationAndHealth));
  const sf9FinalGrades = ["english", "filipino", "mathematics", "science", "aralingPanlipunan", "epp", "mapeh", "gmrc"]
    .map((subject) => Math.round(gradeSummary.terms
      .map((term) => gradeSummary.students[0].grades[term][subject])
      .reduce((total, grade) => total + grade, 0) / gradeSummary.terms.length));
  assert.equal(sf9Sheet.getCell("I33").value, sf9FinalGrades[0]);
  assert.equal(sf9Sheet.getCell("J33").value, "Passed");
  assert.equal(
    sf9Sheet.getCell("I42").value,
    Math.round(sf9FinalGrades.reduce((total, grade) => total + grade, 0) / sf9FinalGrades.length),
  );
  assert.equal(sf9Sheet.getCell("J42").value, "Passed");
  let sf9FormulaCount = 0;
  sf9Sheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
    if (
      cell.value
      && typeof cell.value === "object"
      && ("formula" in cell.value || "sharedFormula" in cell.value)
    ) sf9FormulaCount += 1;
  }));
  assert.equal(sf9FormulaCount, 0, "SF9 export does not retain formulas linked to external workbooks");
  for (const month of sf9MonthStatuses.keys()) {
    const monthDates = attendanceWeekdays(month);
    const clearedSF9Attendance = await saveSF9Attendance(month, gradeSummary.students.map((student) => ({
      studentId: student.id,
      attendance: Array(monthDates.length).fill(""),
      reasons: Array(monthDates.length).fill(""),
      remarks: "",
    })), []);
    assert.equal(clearedSF9Attendance.status, 200, `attendance for ${month} is cleared`);
  }

  const invalidGradeResponse = await fetch(`${baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      grades: { ...termGrades, filipino: 101 },
    }),
  });
  assert.equal(invalidGradeResponse.status, 400);
  assert.match((await invalidGradeResponse.json()).error, /0 to 100/i);

  const invalidTermResponse = await fetch(`${baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 5",
      grades: termGrades,
    }),
  });
  assert.equal(invalidTermResponse.status, 400);
  assert.match((await invalidTermResponse.json()).error, /Term 1 through Term 3/i);

  const studentListResponse = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(studentListResponse.status, 200);
  assert.equal((await studentListResponse.json()).students.length, 1);

  const importedSf1Student = Array(41).fill("");
  importedSf1Student[0] = 123456789013;
  importedSf1Student[2] = "Mendoza, Sam, Cruz";
  importedSf1Student[6] = "M";
  importedSf1Student[7] = "2016-02-03";
  importedSf1Student[11] = "Cebuano";
  importedSf1Student[13] = "Filipino";
  importedSf1Student[14] = "Catholic";
  importedSf1Student[15] = "Unit 1";
  importedSf1Student[17] = "Barangay Central";
  importedSf1Student[20] = "Margosatubig";
  importedSf1Student[22] = "Zamboanga del Sur";
  importedSf1Student[27] = "Santos, Jordan, Cruz";
  importedSf1Student[31] = "Reyes, Ana, Maria";
  importedSf1Student[40] = "Uncle";
  const sf1Sheet = XLSX.utils.aoa_to_sheet([
    [],
    [],
    [],
    [],
    ["LRN", "", "NAME (Last Name, First Name, Middle Name)", "", "", "", "Sex (M/F)", "BIRTH DATE (mm/dd/yyyy)", "", "", "", "MOTHER TONGUE", "", "IP (Ethnic Group)", "RELIGION", "ADDRESS"],
    ["123456789012", "", "Duplicate, Student, Name", "", "", "", "F", "2015-04-21"],
    importedSf1Student,
    ["123456789014", "", "Invalid, Date, Student", "", "", "", "F", "not a date"],
    [16, "", "<=== COMBINED"],
    ["List and Code of Indicators under REMARKS column"],
    ["Transfered Out"],
  ]);
  const sf1Workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(sf1Workbook, sf1Sheet, "SF1");
  const sf1File = XLSX.write(sf1Workbook, { bookType: "biff8", type: "buffer" });
  assert.deepEqual([...sf1File.subarray(0, 8)], [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const importedResponse = await fetch(
    `${baseUrl}/api/students/import?filename=Renamed-SF1-file.backup`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
      body: sf1File,
    },
  );
  assert.equal(importedResponse.status, 200);
  const importedResult = await importedResponse.json();
  assert.equal(importedResult.imported, 1);
  assert.deepEqual(importedResult.skipped, [
    { row: 6, reason: "LRN is already in the student roster or this SF1 file." },
    { row: 8, reason: "Enter a valid birthdate." },
  ]);
  const importedStudentList = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: teacherCookie },
  });
  const importedStudents = (await importedStudentList.json()).students;
  assert.equal(importedStudents.length, 2);
  assert.equal(importedStudents[1].lrn, "123456789013");
  assert.equal(importedStudents[1].firstName, "Sam");
  assert.equal(importedStudents[1].gender, "Male");
  assert.equal(importedStudents[1].birthdate, "2016-02-03");
  assert.equal(importedStudents[1].motherTongue, "Cebuano");
  assert.equal(importedStudents[1].ethnicities, "Filipino");
  assert.equal(importedStudents[1].religion, "Catholic");
  assert.equal(importedStudents[1].currentResidence, "Unit 1, Barangay Central, Margosatubig, Zamboanga del Sur");
  const lockFirstStudentResponse = await fetch(`${baseUrl}/api/grades/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ studentId: addedStudent.student.id, term: "Term 1", locked: true }),
  });
  assert.equal(lockFirstStudentResponse.status, 200);
  const importedStudentLockResponse = await fetch(
    `${baseUrl}/api/grades/lock?studentId=${encodeURIComponent(importedStudents[1].id)}&term=Term%201`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(importedStudentLockResponse.status, 200);
  assert.deepEqual(await importedStudentLockResponse.json(), {
    studentId: importedStudents[1].id,
    term: "Term 1",
    locked: true,
  });
  const unlockImportedStudentResponse = await fetch(`${baseUrl}/api/grades/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: importedStudents[1].id,
      term: "Term 1",
      locked: false,
      password: teacherCredentials.password,
    }),
  });
  assert.equal(unlockImportedStudentResponse.status, 200);
  const saveUnlockedStudentGradesResponse = await fetch(`${baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: importedStudents[1].id,
      term: "Term 1",
      grades: termGrades,
    }),
  });
  assert.equal(saveUnlockedStudentGradesResponse.status, 200);
  const preserveUnlockedStudentLockResponse = await fetch(`${baseUrl}/api/grades/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: importedStudents[1].id,
      term: "Term 1",
      locked: false,
      password: teacherCredentials.password,
    }),
  });
  assert.equal(preserveUnlockedStudentLockResponse.status, 200);
  const legacyLockWorkbook = readPortalDatabaseWorkbook(databasePath);
  const legacyLockSheet = legacyLockWorkbook.getWorksheet("Term Grade Locks");
  const lockHeaders = new Map();
  legacyLockSheet.getRow(1).eachCell((cell, column) => lockHeaders.set(String(cell.value), column));
  const existingStudentLock = legacyLockSheet.getRow(2);
  const legacyLock = legacyLockSheet.getRow(legacyLockSheet.rowCount + 1);
  legacyLock.getCell(lockHeaders.get("Class ID")).value = existingStudentLock.getCell(lockHeaders.get("Class ID")).value;
  legacyLock.getCell(lockHeaders.get("Teacher User ID")).value = existingStudentLock.getCell(lockHeaders.get("Teacher User ID")).value;
  legacyLock.getCell(lockHeaders.get("Term")).value = "Term 1";
  legacyLock.getCell(lockHeaders.get("Student ID")).value = "";
  legacyLock.getCell(lockHeaders.get("Locked")).value = true;
  const legacyTermThreeLock = legacyLockSheet.getRow(legacyLockSheet.rowCount + 1);
  legacyTermThreeLock.getCell(lockHeaders.get("Class ID")).value = legacyLock.getCell(lockHeaders.get("Class ID")).value;
  legacyTermThreeLock.getCell(lockHeaders.get("Teacher User ID")).value = legacyLock.getCell(lockHeaders.get("Teacher User ID")).value;
  legacyTermThreeLock.getCell(lockHeaders.get("Term")).value = "Term 3";
  legacyTermThreeLock.getCell(lockHeaders.get("Student ID")).value = "";
  legacyTermThreeLock.getCell(lockHeaders.get("Locked")).value = false;
  legacyTermThreeLock.getCell(lockHeaders.get("Updated")).value = new Date();
  const migratedLockTimestamp = new Date(Date.now() - 60_000);
  for (const studentId of [addedStudent.student.id, importedStudents[1].id]) {
    const migratedLock = legacyLockSheet.getRow(legacyLockSheet.rowCount + 1);
    migratedLock.getCell(lockHeaders.get("Class ID")).value = legacyTermThreeLock.getCell(lockHeaders.get("Class ID")).value;
    migratedLock.getCell(lockHeaders.get("Teacher User ID")).value = legacyTermThreeLock.getCell(lockHeaders.get("Teacher User ID")).value;
    migratedLock.getCell(lockHeaders.get("Term")).value = "Term 3";
    migratedLock.getCell(lockHeaders.get("Student ID")).value = studentId;
    migratedLock.getCell(lockHeaders.get("Locked")).value = true;
    migratedLock.getCell(lockHeaders.get("Updated")).value = migratedLockTimestamp;
  }
  writePortalDatabaseWorkbook(databasePath, legacyLockWorkbook);
  const migratedUnlockedStudentLockResponse = await fetch(
    `${baseUrl}/api/grades/lock?studentId=${encodeURIComponent(importedStudents[1].id)}&term=Term%201`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(migratedUnlockedStudentLockResponse.status, 200);
  assert.equal((await migratedUnlockedStudentLockResponse.json()).locked, false);
  const migratedLegacyLockWorkbook = readPortalDatabaseWorkbook(databasePath);
  const migratedLegacyLockSheet = migratedLegacyLockWorkbook.getWorksheet("Term Grade Locks");
  const migratedLegacyLock = migratedLegacyLockSheet.getRow(legacyLock.number);
  assert.equal(migratedLegacyLock.getCell(lockHeaders.get("Locked")).value, false);
  const migratedTermThreeLockResponse = await fetch(
    `${baseUrl}/api/grades/lock?studentId=${encodeURIComponent(importedStudents[1].id)}&term=Term%203`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(migratedTermThreeLockResponse.status, 200);
  assert.equal((await migratedTermThreeLockResponse.json()).locked, false);
  const originalStudentTermThreeLockResponse = await fetch(
    `${baseUrl}/api/grades/lock?studentId=${encodeURIComponent(addedStudent.student.id)}&term=Term%203`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(originalStudentTermThreeLockResponse.status, 200);
  assert.equal((await originalStudentTermThreeLockResponse.json()).locked, false);
  const persistedMigratedLockWorkbook = readPortalDatabaseWorkbook(databasePath);
  const persistedMigratedLockSheet = persistedMigratedLockWorkbook.getWorksheet("Term Grade Locks");
  for (let rowNumber = 2; rowNumber <= persistedMigratedLockSheet.rowCount; rowNumber += 1) {
    const row = persistedMigratedLockSheet.getRow(rowNumber);
    if (String(row.getCell(lockHeaders.get("Term")).value) === "Term 3"
      && String(row.getCell(lockHeaders.get("Student ID")).value)) {
      assert.equal(row.getCell(lockHeaders.get("Locked")).value, false);
    }
  }
  const lockedStudentGradesResponse = await fetch(`${baseUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      grades: termGrades,
    }),
  });
  assert.equal(lockedStudentGradesResponse.status, 409);

  const updatedReadingResponse = await fetch(`${baseUrl}/api/reading-assessments?period=BOSY`, {
    headers: { Cookie: teacherCookie },
  });
  const updatedReading = await updatedReadingResponse.json();
  assert.deepEqual(
    updatedReading.students.map(({ id, name }) => ({ id, name })),
    importedStudents.map(({ id, name }) => ({ id, name })),
    "reading report reflects newly imported learners from the student list",
  );
  assert.equal(importedStudents[1].father, "Santos, Jordan, Cruz");
  assert.equal(importedStudents[1].mothersMaidenName, "Reyes, Ana, Maria");
  assert.equal(importedStudents[1].guardianRelationship, "Uncle");

  const renamedXlsxStudent = Array(8).fill("");
  renamedXlsxStudent[0] = "123456789015";
  renamedXlsxStudent[2] = "Garcia, Jamie, Lee";
  renamedXlsxStudent[6] = "F";
  renamedXlsxStudent[7] = "2015-09-17";
  const xlsxSheet = XLSX.utils.aoa_to_sheet([
    [],
    [],
    [],
    [],
    ["LRN", "", "NAME (Last Name, First Name, Middle Name)", "", "", "", "Sex (M/F)", "BIRTH DATE (mm/dd/yyyy)"],
    renamedXlsxStudent,
  ]);
  const xlsxWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(xlsxWorkbook, xlsxSheet, "SF1 Register");
  const renamedXlsxFile = XLSX.write(xlsxWorkbook, { bookType: "xlsx", type: "buffer" });
  assert.deepEqual([...renamedXlsxFile.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const renamedXlsxImport = await fetch(`${baseUrl}/api/students/import`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
    body: renamedXlsxFile,
  });
  assert.equal(renamedXlsxImport.status, 200);
  assert.deepEqual(await renamedXlsxImport.json(), { imported: 1, skipped: [] });
  const finalStudentList = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: teacherCookie },
  });
  const finalStudents = (await finalStudentList.json()).students;
  assert.equal(finalStudents.length, 3);
  assert.equal(finalStudents[2].lrn, "123456789015");
  assert.equal(finalStudents[2].firstName, "Jamie");
  const attendanceDate = new Date().toISOString().slice(0, 10);
  const attendanceResponse = await fetch(`${baseUrl}/api/attendance?date=${attendanceDate}`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(attendanceResponse.status, 200);
  const emptyAttendance = await attendanceResponse.json();
  assert.equal(emptyAttendance.students.length, 3);
  assert.ok(emptyAttendance.students.every(({ status }) => status === ""));
  const absentWithoutReasonResponse = await fetch(`${baseUrl}/api/attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      date: attendanceDate,
      records: [
        { studentId: addedStudent.student.id, status: "Present" },
        { studentId: importedStudents[1].id, status: "Absent" },
        { studentId: finalStudents[2].id, status: "Tardy" },
      ],
    }),
  });
  assert.equal(absentWithoutReasonResponse.status, 200, "absence reasons are optional");
  const savedAttendanceResponse = await fetch(`${baseUrl}/api/attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      date: attendanceDate,
      records: [
        { studentId: addedStudent.student.id, status: "Present" },
        { studentId: importedStudents[1].id, status: "Absent", reason: "Medical appointment" },
        { studentId: finalStudents[2].id, status: "Tardy" },
      ],
    }),
  });
  assert.equal(savedAttendanceResponse.status, 200);
  assert.deepEqual(await savedAttendanceResponse.json(), { saved: true, date: attendanceDate });
  const savedAttendance = await fetch(`${baseUrl}/api/attendance?date=${attendanceDate}`, {
    headers: { Cookie: teacherCookie },
  });
  assert.deepEqual((await savedAttendance.json()).students.map(({ id, status, reason }) => ({ id, status, reason })), [
    { id: addedStudent.student.id, status: "Present", reason: "" },
    { id: importedStudents[1].id, status: "Absent", reason: "Medical appointment" },
    { id: finalStudents[2].id, status: "Tardy", reason: "" },
  ]);
  const attendanceMonth = `${Number(attendanceDate.slice(0, 4)) - 1}-01`;
  const emptyMonthResponse = await fetch(`${baseUrl}/api/attendance/month?month=${attendanceMonth}`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(emptyMonthResponse.status, 200);
  const emptyMonth = await emptyMonthResponse.json();
  const attendanceDates = attendanceWeekdays(attendanceMonth);
  assert.deepEqual(emptyMonth.dates, attendanceDates);
  assert.equal(emptyMonth.dates.every((date) => {
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6;
  }), true);
  assert.deepEqual(emptyMonth.students.map(({ id, attendance }) => ({
    id,
    days: attendance.length,
    recorded: attendance.filter(Boolean).length,
  })), [
    { id: addedStudent.student.id, days: attendanceDates.length, recorded: 0 },
    { id: importedStudents[1].id, days: attendanceDates.length, recorded: 0 },
    { id: finalStudents[2].id, days: attendanceDates.length, recorded: 0 },
  ]);
  const monthlyRecords = emptyMonth.students.map(({ id }) => ({
    studentId: id,
    attendance: Array(attendanceDates.length).fill(""),
    reasons: Array(attendanceDates.length).fill(""),
    remarks: "",
  }));
  monthlyRecords[0].attendance[0] = "Present";
  monthlyRecords[0].attendance[attendanceDates.length - 1] = "Absent";
  monthlyRecords[0].reasons[attendanceDates.length - 1] = "Medical appointment";
  monthlyRecords[0].remarks = "Transfer information";
  const savedMonthResponse = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ month: attendanceMonth, records: monthlyRecords }),
  });
  assert.equal(savedMonthResponse.status, 200);
  assert.deepEqual(await savedMonthResponse.json(), { saved: true, month: attendanceMonth });
  monthlyRecords[0].attendance[0] = "Tardy";
  monthlyRecords[0].reasons[attendanceDates.length - 1] = "Flu";
  monthlyRecords[0].remarks = "Follow-up required";
  const updatedMonthResponse = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ month: attendanceMonth, records: monthlyRecords }),
  });
  assert.equal(updatedMonthResponse.status, 200);
  const updatedMonth = await fetch(`${baseUrl}/api/attendance/month?month=${attendanceMonth}`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(updatedMonth.status, 200);
  const updatedMonthResult = await updatedMonth.json();
  assert.equal(updatedMonthResult.students[0].attendance[0], "Tardy");
  assert.equal(updatedMonthResult.students[0].attendance[attendanceDates.length - 1], "Absent");
  assert.equal(updatedMonthResult.students[0].reasons[attendanceDates.length - 1], "Flu");
  assert.equal(updatedMonthResult.students[1].attendance.every((status) => status === ""), true);
  assert.equal(updatedMonthResult.students[0].remarks, "Follow-up required");
  assert.equal(updatedMonthResult.students[0].gender, "Female");
  const sf2WorkbookBuffer = await createSF2Upload(attendanceMonth, [
    {
      name: addedStudent.student.name,
      gender: addedStudent.student.gender,
      marks: { 1: "CC", 2: "h" },
      remarks: "Medical appointment",
    },
    {
      name: importedStudents[1].name,
      gender: importedStudents[1].gender,
      marks: { 1: "L", 2: "e" },
      remarks: "Early dismissal",
    },
  ]);
  const importedSF2Response = await fetch(
    `${baseUrl}/api/attendance/month/import?month=${attendanceMonth}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
      body: sf2WorkbookBuffer,
    },
  );
  assert.equal(importedSF2Response.status, 200);
  const importedSF2 = await importedSF2Response.json();
  const importedSchoolDays = attendanceDates.map((date) => Number(date.slice(-2)));
  assert.deepEqual(importedSF2, {
    imported: 2,
    importedDays: importedSchoolDays.length * 2,
    month: attendanceMonth,
  });
  const importedSF2MonthResponse = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  const importedSF2Month = await importedSF2MonthResponse.json();
  assert.deepEqual(importedSF2Month.students[0].attendance.slice(0, 3), ["Absent", "Absent", "Present"]);
  assert.equal(importedSF2Month.students[0].reasons[0], "Medical appointment");
  assert.equal(importedSF2Month.students[0].remarks, "Medical appointment");
  assert.deepEqual(importedSF2Month.students[1].attendance.slice(0, 2), ["Tardy", "Excused"]);
  assert.equal(importedSF2Month.students[1].reasons[0], "");
  assert.equal(importedSF2Month.students[1].remarks, "Early dismissal");
  assert.equal(importedSF2Month.students[2].attendance.every((status) => status === ""), true);
  const attendanceSummaryResponse = await fetch(`${baseUrl}/api/attendance/summary`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(attendanceSummaryResponse.status, 200);
  const attendanceSummary = await attendanceSummaryResponse.json();
  const summaryDailyStatuses = new Map([
    [addedStudent.student.id, "Present"],
    [importedStudents[1].id, "Absent"],
    [finalStudents[2].id, "Tardy"],
  ]);
  assert.deepEqual(attendanceSummary.months, [...new Set([
    attendanceMonth,
    attendanceDate.slice(0, 7),
  ])].sort());
  assert.deepEqual(attendanceSummary.students.map((student, index) => {
    const monthStudent = importedSF2Month.students[index];
    const monthPresent = monthStudent.attendance.reduce((total, status) =>
      total + (status === "Present" || status === "Tardy" ? 1 : 0), 0);
    const monthAbsent = monthStudent.attendance.filter((status) => status === "Absent").length;
    const dailyStatus = summaryDailyStatuses.get(student.id);
    const dailyPresent = dailyStatus === "Present" || dailyStatus === "Tardy" ? 1 : 0;
    const dailyAbsent = dailyStatus === "Absent" ? 1 : 0;
    return {
      id: student.id,
      present: monthPresent + (dailyStatus === "Present" || dailyStatus === "Tardy" ? 1 : 0),
      absent: monthAbsent + (dailyStatus === "Absent" ? 1 : 0),
      months: {
        [attendanceMonth]: { present: monthPresent, absent: monthAbsent },
        [attendanceDate.slice(0, 7)]: { present: dailyPresent, absent: dailyAbsent },
      },
    };
  }), attendanceSummary.students.map(({ id, present, absent, months }) => ({ id, present, absent, months })));
  assert.match(attendanceSummary.firstDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(attendanceSummary.lastDate, attendanceDate);
  const sf2ExportRecords = importedSF2Month.students.map((student, index) => ({
    studentId: student.id,
    attendance: student.attendance,
    reasons: student.reasons,
    remarks: index === 0 ? "Monthly follow-up" : student.remarks,
  }));
  const sf2ExportNotesResponse = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ month: attendanceMonth, records: sf2ExportRecords }),
  });
  assert.equal(sf2ExportNotesResponse.status, 200);

  const sf2ExportResponse = await fetch(
    `${baseUrl}/api/attendance/month/export?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(sf2ExportResponse.status, 200, await sf2ExportResponse.clone().text());
  assert.equal(
    sf2ExportResponse.headers.get("content-disposition"),
    `attachment; filename="SF2_January_Grade_5_2026-2027.xlsx"`,
  );
  const exportedSF2Workbook = new ExcelJS.Workbook();
  const exportedSF2Buffer = Buffer.from(await sf2ExportResponse.arrayBuffer());
  await exportedSF2Workbook.xlsx.load(exportedSF2Buffer);
  const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const exportedMonthName = `${monthNames[Number(attendanceMonth.slice(5, 7)) - 1]} ${attendanceMonth.slice(0, 4)}`;
  const exportedSF2Sheet = exportedSF2Workbook.getWorksheet(exportedMonthName);
  assert.ok(exportedSF2Sheet, "exported workbook has the selected month worksheet");
  assertNoLightGraySf2Fills(exportedSF2Sheet);
  assert.equal(exportedSF2Sheet.getCell("AA6").value, "JANUARY");
  assert.equal(exportedSF2Sheet.getCell("AG117").value, "JANUARY");
  assert.equal(exportedSF2Sheet.getCell("AG118").value, "JANUARY");
  assert.equal(exportedSF2Sheet.getCell("N6").value, "2026-2027");
  assert.equal(exportedSF2Sheet.getCell("G6").value, "123456");
  assert.equal(exportedSF2Sheet.getCell("G7").value, "Sample Elementary School");
  assert.equal(exportedSF2Sheet.getCell("AA7").value, "Grade 5");
  assert.equal(exportedSF2Sheet.getCell("AF7").value, "Mabini");
  assert.equal(exportedSF2Sheet.getCell("AE140").value, teacherCredentials.name);
  assert.equal(exportedSF2Sheet.getCell("AE145").value, "Alex Principal");
  assert.equal(exportedSF2Sheet.getCell("AE140").alignment.horizontal, "center");
  assert.equal(exportedSF2Sheet.getCell("AE140").alignment.wrapText, true);
  assert.equal(exportedSF2Sheet.getCell("AE145").alignment.horizontal, "center");
  assert.equal(exportedSF2Sheet.getCell("AE145").alignment.wrapText, true);
  const alternateMonth = `${attendanceMonth.slice(0, 4)}-02`;
  const alternateExportResponse = await fetch(
    `${baseUrl}/api/attendance/month/export?month=${alternateMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(alternateExportResponse.status, 200, await alternateExportResponse.clone().text());
  assert.equal(
    alternateExportResponse.headers.get("content-disposition"),
    `attachment; filename="SF2_February_Grade_5_2026-2027.xlsx"`,
  );
  const alternateExportWorkbook = new ExcelJS.Workbook();
  await alternateExportWorkbook.xlsx.load(Buffer.from(await alternateExportResponse.arrayBuffer()));
  const alternateExportSheet = alternateExportWorkbook.getWorksheet(`FEB ${alternateMonth.slice(0, 4)}`);
  assert.ok(alternateExportSheet, "export uses the requested alternate month worksheet");
  assertNoLightGraySf2Fills(alternateExportSheet);
  assert.equal(alternateExportSheet.getCell("AA6").value, "FEBRUARY");
  assert.equal(alternateExportSheet.getCell("AG117").value, "FEBRUARY");
  assert.equal(alternateExportSheet.getCell("AG118").value, "FEBRUARY");
  const alternateSchoolDays = Array.from({ length: new Date(
    Date.UTC(Number(alternateMonth.slice(0, 4)), 2, 0),
  ).getUTCDate() }, (_, index) => index + 1).filter((day) => {
    const weekday = new Date(
      `${alternateMonth}-${String(day).padStart(2, "0")}T00:00:00.000Z`,
    ).getUTCDay();
    return weekday !== 0 && weekday !== 6;
  });
  assert.deepEqual(
    alternateSchoolDays.map((_, index) => alternateExportSheet.getCell(10, 7 + index).value),
    alternateSchoolDays,
    "alternate selected month dates replace the template's example dates",
  );
  assert.equal(alternateExportSheet.getCell("AQ9").value, alternateSchoolDays.length);
  assert.equal(alternateExportSheet.getCell("AJ117").value.result, alternateSchoolDays.length);
  assert.equal(alternateExportSheet.getCell("AJ118").value.result, alternateSchoolDays.length);
  assert.equal(alternateExportSheet.getCell("AK119").value, finalStudents.filter(({ gender }) => gender === "Male").length);
  assert.equal(alternateExportSheet.getCell("AL119").value, finalStudents.filter(({ gender }) => gender === "Female").length);
  assert.equal(alternateExportSheet.getCell("AM119").value.result, finalStudents.length);
  assert.equal(
    alternateExportSheet.getCell("AK123").value.formula,
    'COUNTA($B$13:$B$62)-COUNTIF($AH$13:$AH$62,"NLS*")-COUNTIF($AH$13:$AH$62,"Transferred Out*")+COUNTIF($AH$13:$AH$62,"Transferred In*")',
  );
  assert.equal(alternateExportSheet.getCell("AK123").value.result, finalStudents.filter(({ gender }) => gender === "Male").length);
  assert.equal(alternateExportSheet.getCell("AM123").value.result, finalStudents.length);
  assert.deepEqual(
    importedSchoolDays.map((_, index) => exportedSF2Sheet.getCell(10, 7 + index).value),
    importedSchoolDays,
    "exported date headings follow the selected month's school days in chronological order",
  );
  assert.deepEqual(
    importedSchoolDays.map((day, index) => exportedSF2Sheet.getCell(11, 7 + index).value),
    importedSchoolDays.map((day) => ["M", "T", "W", "TH", "F"][
      (new Date(`${attendanceMonth}-${String(day).padStart(2, "0")}T00:00:00.000Z`).getUTCDay() + 6) % 7
    ]),
    "each exported weekday heading matches its selected-month date",
  );
  assert.equal(typeof exportedSF2Sheet.getCell(63, 2).value, "string", "the male section total row is preserved");
  const exportedRowsByName = new Map(sf2StudentRows
    .map((rowNumber) => [exportedSF2Sheet.getCell(rowNumber, 2).value, rowNumber])
    .filter(([name]) => name));
  assert.deepEqual([...exportedRowsByName.keys()].sort(), finalStudents.map(({ name }) => name).sort());
  for (const rowNumber of exportedRowsByName.values()) {
    assert.equal(exportedSF2Sheet.getCell(rowNumber, 3).master.address, `B${rowNumber}`);
    assert.equal(exportedSF2Sheet.getCell(rowNumber, 6).master.address, `B${rowNumber}`);
    assert.equal(exportedSF2Sheet.getCell(rowNumber, 2).alignment.wrapText, true);
  }
  const maleRosterCount = finalStudents.filter(({ gender }) => gender === "Male").length;
  const femaleRosterCount = finalStudents.filter(({ gender }) => gender === "Female").length;
  assert.equal(exportedSF2Sheet.getCell("AK119").value, maleRosterCount);
  assert.equal(exportedSF2Sheet.getCell("AL119").value, femaleRosterCount);
  assert.equal(exportedSF2Sheet.getCell("AM119").value.formula, "AK119+AL119");
  assert.equal(exportedSF2Sheet.getCell("AM119").value.result, finalStudents.length);
  assert.equal(
    exportedSF2Sheet.getCell("AK123").value.formula,
    'COUNTA($B$13:$B$62)-COUNTIF($AH$13:$AH$62,"NLS*")-COUNTIF($AH$13:$AH$62,"Transferred Out*")+COUNTIF($AH$13:$AH$62,"Transferred In*")',
  );
  assert.equal(exportedSF2Sheet.getCell("AK123").value.result, maleRosterCount);
  assert.equal(exportedSF2Sheet.getCell("AL123").value.result, femaleRosterCount);
  assert.equal(exportedSF2Sheet.getCell("AM123").value.formula, "AK123+AL123");
  assert.equal(exportedSF2Sheet.getCell("AM123").value.result, finalStudents.length);
  assert.equal(exportedSF2Sheet.getCell("AK127").value.formula, "IFERROR(AG63/AJ117,0)");
  assert.equal(exportedSF2Sheet.getCell("AK127").value.result, 1);
  assert.equal(
    exportedSF2Sheet.getCell("AL127").value.result,
    (femaleRosterCount * importedSchoolDays.length - 2) / importedSchoolDays.length,
  );
  assert.equal(
    exportedSF2Sheet.getCell("AM127").value.result,
    (finalStudents.length * importedSchoolDays.length - 2) / importedSchoolDays.length,
  );
  assert.equal(exportedSF2Sheet.getCell("AG63").value.result, maleRosterCount * importedSchoolDays.length);
  assert.equal(exportedSF2Sheet.getCell("AG114").value.result,
    femaleRosterCount * importedSchoolDays.length - 2);
  assert.equal(exportedSF2Sheet.getCell("AG115").value.result,
    finalStudents.length * importedSchoolDays.length - 2);
  for (const rowNumber of sf2StudentRows) {
    assert.equal(
      exportedSF2Sheet.getRow(rowNumber).hidden,
      !exportedRowsByName.has(exportedSF2Sheet.getCell(rowNumber, 2).value),
      `only populated roster rows are visible (row ${rowNumber})`,
    );
  }
  const addedStudentExportRow = exportedRowsByName.get(addedStudent.student.name);
  const importedStudentExportRow = exportedRowsByName.get(importedStudents[1].name);
  assert.ok(addedStudentExportRow >= 64, "female learners are placed in the female section");
  assert.ok(importedStudentExportRow >= 13 && importedStudentExportRow <= 62, "male learners are placed in the male section");
  const exportedFirstDayColumn = Array.from({ length: 25 }, (_, index) => index + 7)
    .find((column) => exportedSF2Sheet.getCell(10, column).value === importedSchoolDays[0]);
  const exportedSecondDayColumn = Array.from({ length: 25 }, (_, index) => index + 7)
    .find((column) => exportedSF2Sheet.getCell(10, column).value === importedSchoolDays[1]);
  assert.equal(exportedSF2Sheet.getCell(addedStudentExportRow, exportedFirstDayColumn).value, "CC");
  assert.equal(exportedSF2Sheet.getCell(addedStudentExportRow, exportedSecondDayColumn).value, "CC");
  assert.equal(exportedSF2Sheet.getCell(importedStudentExportRow, exportedFirstDayColumn).value, "T");
  assert.equal(exportedSF2Sheet.getCell(importedStudentExportRow, exportedSecondDayColumn).value, "E");
  const dateSpecificRemarks = exportedSF2Sheet.getCell(addedStudentExportRow, 34).value;
  assert.match(dateSpecificRemarks, /Grade Portal absence reasons/);
  assert.match(dateSpecificRemarks, new RegExp(`${attendanceMonth}-01: Medical appointment`));
  assert.match(dateSpecificRemarks, new RegExp(`${attendanceMonth}-02: Medical appointment`));
  assert.match(
    exportedSF2Sheet.getCell(importedStudentExportRow, 34).value,
    new RegExp(`${attendanceMonth}-02: Early dismissal`),
    "optional reasons for Excused marks are exported to Remarks",
  );
  const roundTripSF2Import = await fetch(
    `${baseUrl}/api/attendance/month/import?month=${attendanceMonth}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
      body: exportedSF2Buffer,
    },
  );
  assert.equal(roundTripSF2Import.status, 200);
  const roundTripAttendance = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  const roundTripAttendanceResult = await roundTripAttendance.json();
  assert.equal(roundTripAttendanceResult.students[0].reasons[0], "Medical appointment");
  assert.equal(roundTripAttendanceResult.students[0].remarks, "Monthly follow-up");
  const unknownLearnerSF2 = await createSF2Upload(attendanceMonth, [
    { name: addedStudent.student.name, gender: addedStudent.student.gender, marks: { 1: "x" }, remarks: "Medical appointment" },
    { name: importedStudents[1].name, gender: importedStudents[1].gender, marks: { 1: "T" }, remarks: "Early dismissal" },
    { name: "Unknown, Learner", marks: {}, remarks: "" },
  ]);
  const unknownLearnerImport = await fetch(
    `${baseUrl}/api/attendance/month/import?month=${attendanceMonth}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
      body: unknownLearnerSF2,
    },
  );
  assert.equal(unknownLearnerImport.status, 400);
  assert.match((await unknownLearnerImport.json()).error, /No unique learner.*No attendance was changed/);
  const reasonlessAbsenceMarks = {};
  roundTripAttendanceResult.dates.forEach((date, index) => {
    const status = roundTripAttendanceResult.students[0].attendance[index];
    const mark = { Absent: "CC", Tardy: "T", Excused: "e" }[status];
    if (mark) reasonlessAbsenceMarks[Number(date.slice(-2))] = mark;
  });
  const absentWithoutSF2Remark = await createSF2Upload(attendanceMonth, [
    {
      name: addedStudent.student.name,
      gender: addedStudent.student.gender,
      marks: reasonlessAbsenceMarks,
      remarks: "",
    },
  ]);
  const absentWithoutSF2RemarkImport = await fetch(
    `${baseUrl}/api/attendance/month/import?month=${attendanceMonth}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
      body: absentWithoutSF2Remark,
    },
  );
  assert.equal(absentWithoutSF2RemarkImport.status, 200, "SF2 reasons are optional");
  const importedAbsenceWithoutReason = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  const importedAbsenceWithoutReasonResult = await importedAbsenceWithoutReason.json();
  assert.equal(importedAbsenceWithoutReasonResult.students[0].attendance[0], "Absent");
  assert.equal(importedAbsenceWithoutReasonResult.students[0].reasons[0], "");
  const unsupportedSF2Mark = await createSF2Upload(attendanceMonth, [
    { name: addedStudent.student.name, gender: addedStudent.student.gender, marks: { 1: "?" }, remarks: "" },
  ]);
  const unsupportedSF2Import = await fetch(
    `${baseUrl}/api/attendance/month/import?month=${attendanceMonth}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
      body: unsupportedSF2Mark,
    },
  );
  assert.equal(unsupportedSF2Import.status, 400);
  assert.match((await unsupportedSF2Import.json()).error, /Unsupported SF2 mark/);
  const attendanceBeforeNoClass = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  const attendanceBeforeNoClassData = await attendanceBeforeNoClass.json();
  const noClassDateIndex = attendanceBeforeNoClassData.dates.findIndex((date) => {
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6;
  });
  const noClassDate = attendanceBeforeNoClassData.dates[noClassDateIndex];
  const noClassRecords = attendanceBeforeNoClassData.students.map((student) => ({
    studentId: student.id,
    attendance: student.attendance.map((status, index) => index === noClassDateIndex ? "" : status),
    reasons: student.reasons.map((reason, index) => index === noClassDateIndex ? "" : reason),
    remarks: student.remarks,
  }));
  const savedNoClassDate = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      month: attendanceMonth,
      records: noClassRecords,
      noClassDates: [noClassDate],
      noClassReasons: { [noClassDate]: "  Founding   Anniversary " },
    }),
  });
  assert.equal(savedNoClassDate.status, 200, await savedNoClassDate.clone().text());
  const savedNoClassMonth = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  const savedNoClassData = await savedNoClassMonth.json();
  assert.deepEqual(savedNoClassData.noClassDates, [noClassDate]);
  assert.deepEqual(savedNoClassData.noClassReasons, { [noClassDate]: "Founding Anniversary" });
  const tooLongReason = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      month: attendanceMonth,
      records: noClassRecords,
      noClassDates: [noClassDate],
      noClassReasons: { [noClassDate]: "x".repeat(81) },
    }),
  });
  assert.equal(tooLongReason.status, 400);
  assert.equal(savedNoClassData.students.every((student) =>
    student.attendance[noClassDateIndex] === "" && student.reasons[noClassDateIndex] === ""), true);
  const summaryAfterNoClass = await fetch(`${baseUrl}/api/attendance/summary`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(summaryAfterNoClass.status, 200);
  assert.deepEqual((await summaryAfterNoClass.json()).students.map(({ id, present, absent }) =>
    ({ id, present, absent })), savedNoClassData.students.map((student) => {
    const present = student.attendance.reduce((total, status) =>
      total + (status === "Present" || status === "Tardy" ? 1 : 0), 0);
    const absent = student.attendance.filter((status) => status === "Absent").length;
    const dailyStatus = summaryDailyStatuses.get(student.id);
    return {
      id: student.id,
      present: present + (dailyStatus === "Present" || dailyStatus === "Tardy" ? 1 : 0),
      absent: absent + (dailyStatus === "Absent" ? 1 : 0),
    };
  }));
  const noClassExport = await fetch(
    `${baseUrl}/api/attendance/month/export?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(noClassExport.status, 200, await noClassExport.clone().text());
  const noClassExportBuffer = Buffer.from(await noClassExport.arrayBuffer());
  const noClassExportWorkbook = new ExcelJS.Workbook();
  await noClassExportWorkbook.xlsx.load(noClassExportBuffer);
  const noClassExportSheet = noClassExportWorkbook.getWorksheet(exportedMonthName);
  assert.equal(noClassExportSheet.getCell("AA6").value, "JANUARY");
  assert.equal(noClassExportSheet.getCell("AG117").value, "JANUARY");
  assert.equal(noClassExportSheet.getCell("AG118").value, "JANUARY");
  const expectedClassDayCount = importedSchoolDays.length - 1;
  assert.equal(noClassExportSheet.getCell("AQ9").value, expectedClassDayCount);
  assert.equal(noClassExportSheet.getCell("AJ117").value.formula, "AQ9");
  assert.equal(noClassExportSheet.getCell("AJ117").value.result, expectedClassDayCount);
  assert.equal(noClassExportSheet.getCell("AJ118").value.result, expectedClassDayCount);
  assert.equal(noClassExportSheet.getCell("AK119").value, maleRosterCount);
  assert.equal(noClassExportSheet.getCell("AL119").value, femaleRosterCount);
  assert.equal(noClassExportSheet.getCell("AM119").value.result, finalStudents.length);
  assert.equal(noClassExportSheet.getCell("AK123").value.result, maleRosterCount);
  assert.equal(noClassExportSheet.getCell("AL123").value.result, femaleRosterCount);
  assert.equal(noClassExportSheet.getCell("AM123").value.result, finalStudents.length);
  const noClassDateColumn = Array.from({ length: 25 }, (_, index) => index + 7)
    .find((column) => noClassExportSheet.getCell(10, column).value === Number(noClassDate.slice(-2)));
  assert.notEqual(noClassDateColumn, undefined, "the no-class date appears in the exported date headings");
  assert.equal(
    noClassExportSheet.getCell(115, noClassDateColumn).value.formula,
    `${noClassExportSheet.getColumn(noClassDateColumn).letter}63+${noClassExportSheet.getColumn(noClassDateColumn).letter}114`,
  );
  for (const rowNumber of exportedRowsByName.values()) {
    const noClassCell = noClassExportSheet.getCell(rowNumber, noClassDateColumn);
    assert.equal(noClassCell.value, "NC", `learner row ${rowNumber} displays NC`);
    assert.equal(noClassCell.fill.pattern, "none", `learner row ${rowNumber} has no fill`);
  }
  assertNoLightGraySf2Fills(noClassExportSheet);
  const classDayColumn = noClassDateColumn === 7 ? 8 : 7;
  for (const rowNumber of exportedRowsByName.values()) {
    assert.notEqual(
      noClassExportSheet.getCell(rowNumber, classDayColumn).fill.pattern,
      "solid",
      `class-day cell in learner row ${rowNumber} has no fill`,
    );
  }
  assert.equal(noClassExportSheet.getCell("AK127").value.result, maleRosterCount);
  assert.equal(noClassExportSheet.getCell(addedStudentExportRow, exportedSecondDayColumn).value, "CC",
    "the CC mark is exported as an absence");
  assert.equal(noClassExportSheet.getCell("AG114").value.result,
    femaleRosterCount * expectedClassDayCount - 1,
    `female present total counts CC as one absence: ${JSON.stringify({
      total: noClassExportSheet.getCell("AG114").value,
      absentMark: noClassExportSheet.getCell(addedStudentExportRow, exportedSecondDayColumn).value,
      average: noClassExportSheet.getCell("AL127").value,
    })}`);
  assert.equal(noClassExportSheet.getCell("AL127").value.result,
    (femaleRosterCount * expectedClassDayCount - 1) / expectedClassDayCount);
  assert.equal(noClassExportSheet.getCell("AM127").value.result,
    (finalStudents.length * expectedClassDayCount - 1) / expectedClassDayCount);
  const importedNoClassExport = await fetch(
    `${baseUrl}/api/attendance/month/import?month=${attendanceMonth}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
      body: noClassExportBuffer,
    },
  );
  assert.equal(importedNoClassExport.status, 200, await importedNoClassExport.clone().text());
  assert.deepEqual(await importedNoClassExport.json(), {
    imported: finalStudents.length,
    importedDays: expectedClassDayCount * finalStudents.length,
    month: attendanceMonth,
  });
  const noClassAfterExportImport = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  const noClassAfterExportImportData = await noClassAfterExportImport.json();
  assert.deepEqual(noClassAfterExportImportData.noClassDates, [noClassDate]);
  assert.equal(noClassAfterExportImportData.students.every((student) =>
    student.attendance[noClassDateIndex] === ""), true);
  assert.ok(noClassAfterExportImportData.students.length >= 3, "status summary test has three learners");
  const monthlyStatusByStudent = new Map(noClassAfterExportImportData.students.slice(0, 3).map((student, index) => [
    student.id,
    ["NLS", "Transferred Out", "Transferred In"][index],
  ]));
  const monthlyStatusRecords = noClassAfterExportImportData.students.map((student) => {
    const monthlyStatus = monthlyStatusByStudent.get(student.id) || student.remarks;
    const statusDate = monthlyStatusByStudent.has(student.id) ? `${attendanceMonth}-15` : student.statusDate || "";
    const beforeTransferIn = (date) => monthlyStatus === "Transferred In" && date < statusDate;
    return {
      studentId: student.id,
      attendance: student.attendance.map((status, index) => beforeTransferIn(noClassAfterExportImportData.dates[index]) ? "" : status),
      reasons: student.reasons.map((reason, index) => beforeTransferIn(noClassAfterExportImportData.dates[index]) ? "" : reason),
      remarks: monthlyStatus,
      statusDate,
    };
  });
  const saveMonthlyStatuses = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      month: attendanceMonth,
      records: monthlyStatusRecords,
      noClassDates: noClassAfterExportImportData.noClassDates,
    }),
  });
  assert.equal(saveMonthlyStatuses.status, 200, await saveMonthlyStatuses.clone().text());
  const monthWithStatuses = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  const monthWithStatusesData = await monthWithStatuses.json();
  const transferInStudentId = [...monthlyStatusByStudent].find(([, status]) => status === "Transferred In")[0];
  const transferInStudent = monthWithStatusesData.students.find((student) => student.id === transferInStudentId);
  assert.deepEqual(
    transferInStudent.lockedDates,
    monthWithStatusesData.dates.filter((date) => date < `${attendanceMonth}-15`),
    "Transferred In's effective date excludes earlier attendance days",
  );
  const monthlyStatusExport = await fetch(
    `${baseUrl}/api/attendance/month/export?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(monthlyStatusExport.status, 200, await monthlyStatusExport.clone().text());
  const monthlyStatusExportBuffer = Buffer.from(await monthlyStatusExport.arrayBuffer());
  const monthlyStatusWorkbook = new ExcelJS.Workbook();
  await monthlyStatusWorkbook.xlsx.load(monthlyStatusExportBuffer);
  const monthlyStatusSheet = monthlyStatusWorkbook.getWorksheet(exportedMonthName);
  const expectedRegisteredByGender = { Male: 0, Female: 0 };
  for (const student of noClassAfterExportImportData.students) {
    expectedRegisteredByGender[student.gender] += 1;
    const monthlyStatus = monthlyStatusByStudent.get(student.id);
    if (monthlyStatus === "NLS" || monthlyStatus === "Transferred Out") {
      expectedRegisteredByGender[student.gender] -= 1;
    } else if (monthlyStatus === "Transferred In") {
      expectedRegisteredByGender[student.gender] += 1;
    }
  }
  const expectedRegisteredTotal = expectedRegisteredByGender.Male + expectedRegisteredByGender.Female;
  assert.match(monthlyStatusSheet.getCell("AK123").value.formula, /COUNTIF\(\$AH\$13:\$AH\$62,"NLS\*"\)/);
  assert.match(monthlyStatusSheet.getCell("AK123").value.formula, /COUNTIF\(\$AH\$13:\$AH\$62,"Transferred Out\*"\)/);
  assert.match(monthlyStatusSheet.getCell("AK123").value.formula, /COUNTIF\(\$AH\$13:\$AH\$62,"Transferred In\*"\)/);
  for (const [studentId, status] of monthlyStatusByStudent) {
    const student = noClassAfterExportImportData.students.find((entry) => entry.id === studentId);
    const studentRow = sf2StudentRows.find((rowNumber) => monthlyStatusSheet.getCell(rowNumber, 2).value === student.name);
    assert.match(
      String(monthlyStatusSheet.getCell(studentRow, 34).value),
      new RegExp(`\\[Grade Portal status date: ${attendanceMonth}-15\\]`),
    );
    assert.equal(status, monthlyStatusSheet.getCell(studentRow, 34).value.split("\n")[0]);
  }
  for (const [cellAddress, expected] of [
    ["AK123", expectedRegisteredByGender.Male],
    ["AL123", expectedRegisteredByGender.Female],
    ["AM123", expectedRegisteredTotal],
    ["AM124", expectedRegisteredTotal],
  ]) {
    const result = monthlyStatusSheet.getCell(cellAddress).value.result;
    assert.ok(result === expected || (expected === 0 && result === undefined),
      `${cellAddress} should have cached enrollment count ${expected}`);
  }
  assert.equal(monthlyStatusSheet.getCell("AK132").value.result || 0,
    noClassAfterExportImportData.students.slice(0, 3).filter((student) =>
      monthlyStatusByStudent.get(student.id) === "NLS" && student.gender === "Male").length);
  assert.equal(monthlyStatusSheet.getCell("AM134").value.result, 1);
  assert.equal(monthlyStatusSheet.getCell("AM136").value.result, 1);
  for (const row of [132, 133, 134, 135, 136, 137]) {
    for (const column of ["AK", "AL"]) {
      assert.match(monthlyStatusSheet.getCell(`${column}${row}`).value.formula, /,"[A-Za-z ]+\*"\)$/,
        `${column}${row} counts remarks that carry a status-date note`);
    }
  }
  const monthlyStatusClassDays = monthlyStatusSheet.getCell("AJ117").value.result;
  const monthlyStatusMalePresent = monthlyStatusSheet.getCell("AG63").value.result || 0;
  const monthlyStatusFemalePresent = monthlyStatusSheet.getCell("AG114").value.result || 0;
  const monthlyStatusAverage = monthlyStatusSheet.getCell("AM127").value.result || 0;
  assert.equal(
    monthlyStatusAverage,
    (monthlyStatusMalePresent + monthlyStatusFemalePresent) / monthlyStatusClassDays,
    "average daily attendance is calculated from end-of-month registered learner attendance",
  );
  assert.ok((monthlyStatusSheet.getCell("AK127").value.result || 0)
    <= (monthlyStatusSheet.getCell("AK123").value.result || 0));
  assert.ok((monthlyStatusSheet.getCell("AL127").value.result || 0)
    <= (monthlyStatusSheet.getCell("AL123").value.result || 0));
  assert.ok(monthlyStatusAverage <= expectedRegisteredTotal);
  const firstClassDateColumn = noClassAfterExportImportData.dates.findIndex((date) =>
    !noClassAfterExportImportData.noClassDates.includes(date)) + 7;
  const firstClassDateLetter = monthlyStatusSheet.getColumn(firstClassDateColumn).letter;
  const dailySummaryFormula = monthlyStatusSheet.getCell(`${firstClassDateLetter}63`).value.formula;
  assert.ok(dailySummaryFormula.includes(`COUNTIF(${firstClassDateLetter}13:${firstClassDateLetter}62,"N/A")`));
  assert.match(dailySummaryFormula, /COUNTIF\(AH13:AH62,"Transferred Out\*"\)/);
  const followingMonth = new Date(Date.UTC(
    Number(attendanceMonth.slice(0, 4)),
    Number(attendanceMonth.slice(5, 7)),
    1,
  )).toISOString().slice(0, 7);
  const followingMonthResponse = await fetch(
    `${baseUrl}/api/attendance/month?month=${followingMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(followingMonthResponse.status, 200);
  const followingMonthData = await followingMonthResponse.json();
  const inactiveStudents = noClassAfterExportImportData.students.filter((student) =>
    ["NLS", "Transferred Out"].includes(monthlyStatusByStudent.get(student.id)));
  for (const student of inactiveStudents) {
    const followingMonthStudent = followingMonthData.students.find((entry) => entry.id === student.id);
    assert.ok(followingMonthStudent, "inactive learner remains listed in following month");
    assert.equal(followingMonthStudent.remarks, monthlyStatusByStudent.get(student.id));
    assert.equal(followingMonthStudent.attendanceLocked, true);
    assert.equal(followingMonthStudent.attendance.every((status) => status === ""), true);
    assert.equal(followingMonthStudent.lockedDates.length, followingMonthData.dates.length);
  }
  const lockedStudent = followingMonthData.students.find((student) => student.attendanceLocked);
  const editLockedAttendance = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      month: followingMonth,
      records: followingMonthData.students.map((student) => ({
        studentId: student.id,
        attendance: student.id === lockedStudent.id
          ? student.attendance.map((_, index) => index === 0 ? "Present" : "")
          : student.attendance,
        reasons: student.reasons,
        remarks: student.remarks,
        statusDate: student.statusDate,
      })),
      noClassDates: followingMonthData.noClassDates,
    }),
  });
  assert.equal(editLockedAttendance.status, 400);
  assert.match((await editLockedAttendance.json()).error, /attendance is locked/);
  const editLockedDailyAttendance = await fetch(`${baseUrl}/api/attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      date: followingMonthData.dates[0],
      records: followingMonthData.students.map((student) => ({ studentId: student.id, status: "Present" })),
    }),
  });
  assert.equal(editLockedDailyAttendance.status, 400);
  assert.match((await editLockedDailyAttendance.json()).error, /attendance is locked/);
  const followingMonthExport = await fetch(
    `${baseUrl}/api/attendance/month/export?month=${followingMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.equal(followingMonthExport.status, 200, await followingMonthExport.clone().text());
  const followingMonthWorkbook = new ExcelJS.Workbook();
  await followingMonthWorkbook.xlsx.load(Buffer.from(await followingMonthExport.arrayBuffer()));
  const followingMonthName = `${monthNames[Number(followingMonth.slice(5, 7)) - 1]} ${followingMonth.slice(0, 4)}`;
  const followingMonthSheet = followingMonthWorkbook.getWorksheet(followingMonthName);
  for (const student of inactiveStudents) {
    const rowNumber = sf2StudentRows.find((row) =>
      followingMonthSheet.getCell(row, 2).value === student.name);
    assert.notEqual(rowNumber, undefined, "locked learner remains in the SF2 roster");
    assert.equal(followingMonthSheet.getCell(rowNumber, 7).value, "N/A",
      "locked learner dates are not counted as attendance in SF2");
  }
  const importedStatusMonth = await fetch(
    `${baseUrl}/api/attendance/month/import?month=${attendanceMonth}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
      body: monthlyStatusExportBuffer,
    },
  );
  assert.equal(importedStatusMonth.status, 200, await importedStatusMonth.clone().text());
  const statusDateRoundTrip = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  const statusDateRoundTripData = await statusDateRoundTrip.json();
  for (const student of statusDateRoundTripData.students.filter((entry) => monthlyStatusByStudent.has(entry.id))) {
    assert.equal(student.statusDate, `${attendanceMonth}-15`, "SF2 import preserves the exact status date");
  }
  const restoredMonthlyRemarks = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      month: attendanceMonth,
      records: noClassAfterExportImportData.students.map((student) => ({
        studentId: student.id,
        attendance: student.attendance,
        reasons: student.reasons,
        remarks: student.remarks,
      })),
      noClassDates: noClassAfterExportImportData.noClassDates,
    }),
  });
  assert.equal(restoredMonthlyRemarks.status, 200, await restoredMonthlyRemarks.clone().text());
  const saveOtherMonth = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      month: alternateMonth,
      records: (await (await fetch(
        `${baseUrl}/api/attendance/month?month=${alternateMonth}`,
        { headers: { Cookie: teacherCookie } },
      )).json()).students.map((student) => ({
        studentId: student.id,
        attendance: student.attendance,
        reasons: student.reasons,
        remarks: student.remarks,
      })),
      noClassDates: [],
    }),
  });
  assert.equal(saveOtherMonth.status, 200, await saveOtherMonth.clone().text());
  const noClassAfterOtherMonthSave = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  assert.deepEqual((await noClassAfterOtherMonthSave.json()).noClassDates, [noClassDate]);
  const sf2WithHolidayAttendance = await createSF2Upload(attendanceMonth, [
    {
      name: addedStudent.student.name,
      gender: addedStudent.student.gender,
      marks: { [Number(noClassDate.slice(-2))]: "x" },
      remarks: "SF2 test absence",
    },
  ]);
  const importOnNoClassDate = await fetch(
    `${baseUrl}/api/attendance/month/import?month=${attendanceMonth}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
      body: sf2WithHolidayAttendance,
    },
  );
  assert.equal(importOnNoClassDate.status, 200, await importOnNoClassDate.clone().text());
  const afterImportOnNoClassDate = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  const afterImportOnNoClassData = await afterImportOnNoClassDate.json();
  assert.deepEqual(afterImportOnNoClassData.noClassDates, [noClassDate]);
  assert.equal(afterImportOnNoClassData.students[0].attendance[noClassDateIndex], "");
  const attendanceOnNoClassDate = await fetch(`${baseUrl}/api/attendance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      date: noClassDate,
      records: savedNoClassData.students.map((student) => ({ studentId: student.id, status: "Present" })),
    }),
  });
  assert.equal(attendanceOnNoClassDate.status, 400);
  assert.match((await attendanceOnNoClassDate.json()).error, /marked Holiday\/No Class.*locked/);
  const restoredAttendance = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      month: attendanceMonth,
      records: attendanceBeforeNoClassData.students.map((student) => ({
        studentId: student.id,
        attendance: student.attendance,
        reasons: student.reasons,
        remarks: student.remarks,
      })),
      noClassDates: [],
    }),
  });
  assert.equal(restoredAttendance.status, 200, await restoredAttendance.clone().text());
  const restoredMonth = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: teacherCookie } },
  );
  const restoredMonthData = await restoredMonth.json();
  assert.deepEqual(restoredMonthData.noClassDates, []);
  assert.deepEqual(
    restoredMonthData.students.map((student) => student.attendance[noClassDateIndex]),
    attendanceBeforeNoClassData.students.map((student) => student.attendance[noClassDateIndex]),
  );
  const invalidAttendanceRemark = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      month: attendanceMonth,
      records: monthlyRecords.map((record, index) => ({
        ...record,
        remarks: index === 0 ? "x".repeat(501) : record.remarks,
      })),
    }),
  });
  assert.equal(invalidAttendanceRemark.status, 400);
  const absentWithoutReason = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      month: attendanceMonth,
      records: monthlyRecords.map((record, index) => ({
        ...record,
        reasons: index === 0 ? record.reasons.map(() => "") : record.reasons,
      })),
    }),
  });
  assert.equal(absentWithoutReason.status, 200, "absence reasons are optional");
  const restoredAfterNoReasonSave = await fetch(`${baseUrl}/api/attendance/month`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ month: attendanceMonth, records: monthlyRecords }),
  });
  assert.equal(restoredAfterNoReasonSave.status, 200);
  const invalidAttendanceMonth = await fetch(`${baseUrl}/api/attendance/month?month=2026-13`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(invalidAttendanceMonth.status, 400);
  const unauthenticatedAttendanceClear = await fetch(`${baseUrl}/api/attendance/month?month=${attendanceMonth}`, {
    method: "DELETE",
  });
  assert.equal(unauthenticatedAttendanceClear.status, 401);
  const invalidAttendanceClearMonth = await fetch(`${baseUrl}/api/attendance/month?month=2026-13`, {
    method: "DELETE",
    headers: { Cookie: teacherCookie },
  });
  assert.equal(invalidAttendanceClearMonth.status, 400);

  const notExcel = await fetch(`${baseUrl}/api/students/import`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", Cookie: teacherCookie },
    body: Buffer.from("This is not an Excel workbook."),
  });
  assert.equal(notExcel.status, 400);
  assert.match((await notExcel.json()).error, /not a supported Excel workbook/i);

  const unauthenticatedImport = await fetch(`${baseUrl}/api/students/import`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: sf1File,
  });
  assert.equal(unauthenticatedImport.status, 401);

  const duplicateLrn = await fetch(`${baseUrl}/api/students`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify(studentDetails),
  });
  assert.equal(duplicateLrn.status, 409);

  const credentials = {
    name: "Casey Example",
    email: "casey.example@mail.com",
    password: "secure-pass-123",
    role: "parent",
    extra: teacherResult.user.classCode,
  };

  const registration = await request("/api/auth/register", credentials);
  assert.equal(registration.status, 201);
  const parentCookie = registration.headers.get("set-cookie").split(";")[0];
  assert.deepEqual(await registration.json(), {
    user: { name: "Casey Example", role: "parent", isAdmin: false, mustChangePassword: false },
  });

  const rosterAfterParentRegistration = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(rosterAfterParentRegistration.status, 200);
  assert.equal(
    (await rosterAfterParentRegistration.json()).parents.some(({ email }) => email === credentials.email),
    true,
    "refreshing the roster makes a newly registered parent available for linking",
  );

  const secondParentRegistration = await request("/api/auth/register", {
    name: "Jordan Example",
    email: "jordan.example@mail.com",
    password: "secure-pass-123",
    role: "parent",
    extra: teacherResult.user.classCode,
  });
  assert.equal(secondParentRegistration.status, 201);

  const parentPortalBeforeLink = await fetch(`${baseUrl}/api/parent/portal`, {
    headers: { Cookie: parentCookie },
  });
  assert.equal(parentPortalBeforeLink.status, 200);
  assert.deepEqual((await parentPortalBeforeLink.json()).learners, []);

  const rosterWithParentsResponse = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(rosterWithParentsResponse.status, 200);
  const rosterWithParents = await rosterWithParentsResponse.json();
  assert.ok(rosterWithParents.students.some(({ id }) => id === addedStudent.student.id));
  const registeredParents = rosterWithParents.parents;
  assert.deepEqual(registeredParents.map(({ name, email }) => ({ name, email })), [
    { name: credentials.name, email: credentials.email },
    { name: "Jordan Example", email: "jordan.example@mail.com" },
  ]);
  const assignParent = (parentUserId) => fetch(
    `${baseUrl}/api/students/${encodeURIComponent(addedStudent.student.id)}/parent`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: teacherCookie },
      body: JSON.stringify({ parentUserId }),
    },
  );
  const invalidParentAssignment = await assignParent("P999999");
  assert.equal(invalidParentAssignment.status, 400);
  const parentAssignment = await assignParent(registeredParents[0].id);
  assert.equal(parentAssignment.status, 200);
  assert.deepEqual(await parentAssignment.json(), {
    saved: true,
    parentUserId: registeredParents[0].id,
  });
  const unlinkedStudent = await assignParent("");
  assert.equal(unlinkedStudent.status, 200);
  assert.deepEqual(await unlinkedStudent.json(), { saved: true, parentUserId: "" });
  const reassignedStudent = await assignParent(registeredParents[0].id);
  assert.equal(reassignedStudent.status, 200);

  const parentPortal = await fetch(`${baseUrl}/api/parent/portal`, {
    headers: { Cookie: parentCookie },
  });
  assert.equal(parentPortal.status, 200);
  const parentPortalResult = await parentPortal.json();
  assert.equal(parentPortalResult.parentName, credentials.name);
  assert.equal(parentPortalResult.email, credentials.email);
  assert.equal(parentPortalResult.classroomNumber, "12");
  assert.equal(parentPortalResult.teacherName, teacherCredentials.name);
  assert.deepEqual(parentPortalResult.learners.map(({ id }) => id), [addedStudent.student.id]);
  assert.equal(parentPortalResult.learners[0].profile.find(({ label }) => label === "LRN").value, studentDetails.lrn);
  assert.equal(parentPortalResult.learners[0].grades["Term 1"].english, 91);
  assert.equal(parentPortalResult.learners[0].grades["Term 1"].mapeh, 91);
  assert.equal(parentPortalResult.learners[0].reading.BOSY.English.level, "Instructional");
  assert.equal(parentPortalResult.learners[0].reading.MOSY.Filipino.level, "Frustration");
  assert.equal(parentPortalResult.learners[0].reading.EOSY.Filipino.level, "Independent");
  const parentPhilIri = parentPortalResult.learners[0].philIri;
  assert.equal(parentPhilIri.BOSY.Pretest.English.gst.passed, false);
  assert.equal(parentPhilIri.BOSY.Pretest.English.individualized["Oral Reading"].readingLevel, "Instructional");
  assert.equal(parentPhilIri.BOSY.Pretest.English.individualized["Silent Reading"].readingLevel, "Independent");
  assert.equal(parentPhilIri.BOSY.Posttest.English.individualized["Oral Reading"].readingLevel, "Independent");
  assert.equal(parentPhilIri.BOSY.Posttest.Filipino.gst.passed, true);
  assert.equal(parentPhilIri.BOSY.Posttest.Filipino.individualized["Silent Reading"], undefined);
  assert.equal(parentPhilIri.EOSY.Pretest.English.autoScoring.gstScore, 16);
  assert.equal(parentPhilIri.BOSY.Pretest.Filipino.autoScoring.gstScore, 10);
  const unlinkedParentPortal = await fetch(`${baseUrl}/api/parent/portal`, {
    headers: { Cookie: secondParentRegistration.headers.get("set-cookie").split(";")[0] },
  });
  assert.equal(unlinkedParentPortal.status, 200);
  assert.deepEqual((await unlinkedParentPortal.json()).learners, []);
  const parentAttendanceHistory = parentPortalResult.learners[0].attendance;
  assert.deepEqual(parentAttendanceHistory.filter(({ date }) => !date.startsWith(`${attendanceMonth}-`)), [
    { date: attendanceDate, status: "Present", reason: "" },
  ]);
  assert.deepEqual(
    parentAttendanceHistory.filter(({ date }) => date.startsWith(`${attendanceMonth}-`))
      .sort((left, right) => left.date.localeCompare(right.date)),
    [
      { date: `${attendanceMonth}-${String(importedSchoolDays[0]).padStart(2, "0")}`, status: "Tardy", reason: "" },
      { date: `${attendanceMonth}-${String(importedSchoolDays.at(-1)).padStart(2, "0")}`, status: "Absent", reason: "Flu" },
    ],
  );
  assert.equal(parentAttendanceHistory.every((record) => Object.hasOwn(record, "reason")), true);
  assert.deepEqual(parentPortalResult.gradeTerms, ["Term 1", "Term 2", "Term 3"]);
  const parentLearnerGrades = parentPortalResult.learners[0].grades;
  const coreGradeSubjects = [
    "filipino", "english", "mathematics", "science",
    "aralingPanlipunan", "epp", "mapeh", "gmrc",
  ];
  for (const term of parentPortalResult.gradeTerms) {
    const grades = coreGradeSubjects.map((subject) => parentLearnerGrades[term][subject]);
    assert.ok(grades.every((grade) => typeof grade === "number"), `${term} core grades are available for the parent average`);
    const generalAverage = grades.reduce((total, grade) => total + grade, 0) / grades.length;
    assert.equal(Number.isFinite(generalAverage), true, `${term} General Average can be calculated`);
  }
  for (const subject of parentPortalResult.gradeSubjects) {
    const termGrades = parentPortalResult.gradeTerms.map((term) => parentLearnerGrades[term][subject.key]);
    assert.ok(termGrades.every((grade) => typeof grade === "number"), `${subject.label} has all three term grades`);
    const generalGrade = termGrades.reduce((total, grade) => total + grade, 0) / termGrades.length;
    assert.equal(Number.isFinite(generalGrade), true, `${subject.label} General grade can be calculated`);
  }
  assert.match(portalPage, /headerRow\.append\(generalHeader\)/);
  assert.match(portalPage, /generalHeader\.textContent="Average"/);
  assert.match(portalPage, /generalAverageRow\.append\(overallAverageCell\)/);
  assert.match(portalPage, /allCoreGrades\.push\(learner\.grades\[term\]\[subject\]\)/);
  assert.match(portalPage, /overallAverageCell\.className="parent-grade-overall"/);
  assert.match(portalPage, /allCoreGrades\.reduce\(function\(total,value\)\{return total\+value\},0\)\/allCoreGrades\.length/);
  assert.doesNotMatch(portalPage, /termAverages/);
  assert.doesNotMatch(portalPage, /parent-grade-tabs?(?:["'.\s{]|$)/);
  assert.deepEqual(parentPortalResult.readingPeriods, ["BOSY", "MOSY", "EOSY"]);
  assert.deepEqual(parentPortalResult.learners[0].reading.BOSY.English.attempts.map((attempt) => attempt.attemptNo), [1, 2]);
  assert.match(parentPortalResult.learners[0].reading.BOSY.English.attempts[1].assessedDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(parentPortalResult.learners[0].reading.BOSY.English.level, "Instructional");
  assert.equal(parentPortalResult.learners[0].reading.BOSY.English.attemptNo, 2);
  assert.match(portalPage, /id="readingAttemptNumber" type="number" min="1" step="1" value="1" inputmode="numeric" required/);
  assert.match(portalPage, /id="parentPhilIriProgress"/);
  assert.match(portalPage, /parentPortalData\.readingPeriods\.forEach\(function\(period\)\{[\s\S]*?learner\.philIri/);
  assert.match(portalPage, /PHIL-IRI assessment results/);
  assert.match(portalPage, /Date set automatically when saved/);
  assert.match(portalPage, /saved\.assessedDates\[language\]/);
  assert.match(portalPage, /Assessment history/);
  assert.match(portalPage, /button\.dataset\.parentTarget==="parentReadingSection"[\s\S]*?refreshParentPortalData\(\$\("refreshParentReading"\)/);
  assert.match(portalPage, /id="refreshParentReading" type="button">Refresh reading progress/);
  assert.match(portalPage, /async function refreshParentPortalData\(button,successMessage\)/);
  assert.match(portalPage, /var updatedPortal=await api\("\/api\/parent\/portal"\)/);
  assert.match(portalPage, /renderParentLearner\(nextIndex<0\?0:nextIndex\)/);
  const teacherParentPortal = await fetch(`${baseUrl}/api/parent/portal`, {
    headers: { Cookie: teacherCookie },
  });
  assert.equal(teacherParentPortal.status, 403);
  const unauthenticatedParentPortal = await fetch(`${baseUrl}/api/parent/portal`);
  assert.equal(unauthenticatedParentPortal.status, 401);
  const thirdReadingAttempt = await fetch(`${baseUrl}/api/reading-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      attemptNo: 3,
      levels: { English: "Independent", Filipino: "Instructional" },
    }),
  });
  assert.equal(thirdReadingAttempt.status, 200);
  const refreshedParentPortal = await fetch(`${baseUrl}/api/parent/portal`, {
    headers: { Cookie: parentCookie },
  });
  assert.equal(refreshedParentPortal.status, 200);
  const refreshedParentPortalResult = await refreshedParentPortal.json();
  assert.equal(refreshedParentPortalResult.learners[0].reading.BOSY.English.level, "Independent");
  assert.equal(refreshedParentPortalResult.learners[0].reading.BOSY.English.attemptNo, 3);
  assert.deepEqual(refreshedParentPortalResult.learners[0].reading.BOSY.English.attempts.map((attempt) => attempt.attemptNo), [1, 2, 3]);

  const parentStudentList = await fetch(`${baseUrl}/api/students`, {
    headers: { Cookie: parentCookie },
  });
  assert.equal(parentStudentList.status, 403);
  const parentCannotAssignParent = await fetch(
    `${baseUrl}/api/students/${encodeURIComponent(addedStudent.student.id)}/parent`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: parentCookie },
      body: JSON.stringify({ parentUserId: "" }),
    },
  );
  assert.equal(parentCannotAssignParent.status, 403);
  const parentCannotUnlink = await fetch(
    `${baseUrl}/api/students/${encodeURIComponent(addedStudent.student.id)}/parent`,
    {
      method: "DELETE",
      headers: { Cookie: parentCookie },
    },
  );
  assert.equal(parentCannotUnlink.status, 403);
  const parentGrades = await fetch(gradesUrl, { headers: { Cookie: parentCookie } });
  assert.equal(parentGrades.status, 403);
  const parentGradeSummary = await fetch(`${baseUrl}/api/grades/summary`, {
    headers: { Cookie: parentCookie },
  });
  assert.equal(parentGradeSummary.status, 403);
  const parentReading = await fetch(`${baseUrl}/api/reading-assessments`, {
    headers: { Cookie: parentCookie },
  });
  assert.equal(parentReading.status, 403);
  const parentAttendance = await fetch(`${baseUrl}/api/attendance?date=${attendanceDate}`, {
    headers: { Cookie: parentCookie },
  });
  assert.equal(parentAttendance.status, 403);
  const parentMonthlyAttendance = await fetch(
    `${baseUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: parentCookie } },
  );
  assert.equal(parentMonthlyAttendance.status, 403);
  const parentProfile = await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: parentCookie },
  });
  assert.equal(parentProfile.status, 403);
  const parentProfilePhoto = await fetch(`${baseUrl}/api/teacher/profile/photo`, {
    headers: { Cookie: parentCookie },
  });
  assert.equal(parentProfilePhoto.status, 403);
  const parentPassword = await fetch(`${baseUrl}/api/teacher/profile/password`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: parentCookie },
    body: JSON.stringify({ currentPassword: "secure-pass-123", newPassword: "other-secure-pass-123" }),
  });
  assert.equal(parentPassword.status, 403);
  const duplicateEmailProfile = await updateProfile(teacherCookie, {
    name: teacherCredentials.name,
    email: credentials.email,
    classroomNumber: "12",
  });
  assert.equal(duplicateEmailProfile.status, 409);

  const duplicate = await request("/api/auth/register", credentials);
  assert.equal(duplicate.status, 409);

  const failedLogin = await request("/api/auth/login", {
    email: credentials.email,
    password: "incorrect-password",
    role: credentials.role,
  });
  assert.equal(failedLogin.status, 401);

  const persistentGradeLock = await fetch(`${baseUrl}/api/grades/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: teacherCookie },
    body: JSON.stringify({ studentId: addedStudent.student.id, term: "Term 1", locked: true }),
  });
  assert.equal(persistentGradeLock.status, 200);

  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server = createServer({ databasePath, migrationWorkbookPath, generatedReportsDirectory });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const restartedUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${restartedUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
      role: credentials.role,
    }),
  });
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), {
    user: { name: "Casey Example", role: "parent", isAdmin: false, mustChangePassword: false },
  });
  const restartedParentCookie = login.headers.get("set-cookie").split(";")[0];
  const persistedParentPortal = await fetch(`${restartedUrl}/api/parent/portal`, {
    headers: { Cookie: restartedParentCookie },
  });
  assert.equal(persistedParentPortal.status, 200);
  const persistedParentPortalResult = await persistedParentPortal.json();
  assert.deepEqual(persistedParentPortalResult, {
    ...refreshedParentPortalResult,
  });
  assert.deepEqual(persistedParentPortalResult.learners[0].attendance, parentAttendanceHistory);

  const teacherLogin = await fetch(`${restartedUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: teacherCredentials.email,
      password: teacherCredentials.password,
      role: teacherCredentials.role,
    }),
  });
  assert.equal(teacherLogin.status, 200);
  const restartedTeacherCookie = teacherLogin.headers.get("set-cookie").split(";")[0];
  const persistedProfileResponse = await fetch(`${restartedUrl}/api/teacher/profile`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal(persistedProfileResponse.status, 200);
  assert.deepEqual(await persistedProfileResponse.json(), {
    name: teacherCredentials.name,
    email: teacherCredentials.email,
    classroomNumber: "12",
    grade: "Grade 5",
    strand: "",
    section: "Mabini",
    sectionsHandled: ["Mabini", "Rizal", "Bonifacio"],
    sectionGrades: { Mabini: "Grade 5", Bonifacio: "Grade 6" },
    subjectsHandled: ["English", "Mathematics"],
    availableSubjects: [
      "English",
      "Filipino",
      "Mathematics",
      "Science",
      "Araling Panlipunan",
      "EPP",
      "MAPEH",
      "GMRC",
    ],
    gradeSubjects: [
      { key: "english", label: "English" },
      { key: "filipino", label: "Filipino" },
      { key: "mathematics", label: "Mathematics" },
      { key: "science", label: "Science" },
      { key: "aralingPanlipunan", label: "Araling Panlipunan" },
      { key: "epp", label: "EPP" },
      { key: "musicAndArts", label: "Music and Arts" },
      { key: "physicalEducationAndHealth", label: "Physical Education and Health" },
      { key: "gmrc", label: "GMRC" },
    ],
    generalAverageSubjects: [
      "english", "filipino", "mathematics", "science", "aralingPanlipunan", "epp", "mapeh", "gmrc",
    ],
    eClassSubjects: [
      "English", "Filipino", "Mathematics", "Science", "Araling Panlipunan", "EPP", "MAPEH", "GMRC",
    ],
    schoolYear: "2026-2027",
    schoolName: "Sample Elementary School",
    schoolId: "123456",
    region: "Region IX",
    division: "Zamboanga City",
    district: "West District",
    position: "Master Teacher I",
    schoolHead: "Alex Principal",
    schoolHeadPosition: "Principal II",
    hasPhoto: false,
    hasSchoolLogo: true,
  });
  const persistedNutritionalRosterResponse = await fetch(`${restartedUrl}/api/students`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal(persistedNutritionalRosterResponse.status, 200);
  const persistedNutritionalStudent = (await persistedNutritionalRosterResponse.json()).students
    .find(({ id }) => id === addedStudent.student.id);
  assert.equal(persistedNutritionalStudent.weightKg, 42);
  assert.equal(persistedNutritionalStudent.heightM, 1.4);
  assert.equal(persistedNutritionalStudent.measurementDate, "2025-04-21");
  assert.equal(persistedNutritionalStudent.bmiCategory, "Overweight");
  assert.equal(persistedNutritionalStudent.heightSquaredM2, 1.96);
  assert.equal(persistedNutritionalStudent.bmi, 21.43);
  const persistedSchoolLogoResponse = await fetch(`${restartedUrl}/api/teacher/profile/school-logo`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal(persistedSchoolLogoResponse.status, 200);
  assert.equal(persistedSchoolLogoResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await persistedSchoolLogoResponse.arrayBuffer()), profilePng);
  const persistedGradeLockResponse = await fetch(
    `${restartedUrl}/api/grades/lock?studentId=${encodeURIComponent(addedStudent.student.id)}&term=Term%201`,
    {
      headers: { Cookie: restartedTeacherCookie },
    },
  );
  assert.equal(persistedGradeLockResponse.status, 200);
  assert.deepEqual(await persistedGradeLockResponse.json(), {
    studentId: addedStudent.student.id,
    term: "Term 1",
    locked: true,
  });
  const persistedLockedGradeSave = await fetch(`${restartedUrl}/api/grades`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      grades: termGrades,
    }),
  });
  assert.equal(persistedLockedGradeSave.status, 409);
  const persistedGradeUnlock = await fetch(`${restartedUrl}/api/grades/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      term: "Term 1",
      locked: false,
      password: teacherCredentials.password,
    }),
  });
  assert.equal(persistedGradeUnlock.status, 200);
  const persistedGradesUrl = `${restartedUrl}/api/grades?studentId=${encodeURIComponent(addedStudent.student.id)}&term=Term%201`;
  const persistedGradesResponse = await fetch(persistedGradesUrl, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal(persistedGradesResponse.status, 200);
  const persistedGradeRecord = await persistedGradesResponse.json();
  assert.equal(
    persistedGradeRecord.teacherComment,
    "Shows steady progress and should continue reading each evening.",
    "teacher comments persist across server restarts",
  );
  assert.deepEqual(persistedGradeRecord.grades, {
    filipino: "88",
    english: "91",
    mathematics: "86.5",
    science: "90",
    aralingPanlipunan: "89",
    gmrc: "95",
    epp: "87",
    musicAndArts: "92",
    physicalEducationAndHealth: "90",
  });
  const persistedSummaryResponse = await fetch(`${restartedUrl}/api/grades/summary`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal(persistedSummaryResponse.status, 200);
  const persistedSummary = await persistedSummaryResponse.json();
  assert.deepEqual(persistedSummary.terms, ["Term 1", "Term 2", "Term 3"]);
  assert.equal(persistedSummary.students[0].grades["Term 1"].filipino, 88);
  assert.equal(persistedSummary.students[0].grades["Term 2"].filipino, 87);
  assert.equal(persistedSummary.students[0].grades["Term 3"].filipino, 86);
  const persistedReadingResponse = await fetch(`${restartedUrl}/api/reading-assessments?period=BOSY`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal(persistedReadingResponse.status, 200);
  const persistedReading = await persistedReadingResponse.json();
  assert.equal(persistedReading.students[0].levels.English, "Independent");
  assert.equal(persistedReading.students[0].levels.Filipino, "Instructional");
  const persistedSecondAttemptResponse = await fetch(`${restartedUrl}/api/reading-assessments?period=BOSY&attemptNo=2`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal(persistedSecondAttemptResponse.status, 200);
  assert.equal((await persistedSecondAttemptResponse.json()).students[0].levels.English, "Instructional");
  const persistedAttendance = await fetch(`${restartedUrl}/api/attendance?date=${attendanceDate}`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal(persistedAttendance.status, 200);
  assert.equal((await persistedAttendance.json()).students[0].status, "Present");
  const persistedAttendanceMonth = await fetch(
    `${restartedUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: restartedTeacherCookie } },
  );
  assert.equal(persistedAttendanceMonth.status, 200);
  const persistedAttendanceMonthResult = await persistedAttendanceMonth.json();
  assert.equal(persistedAttendanceMonthResult.students[0].attendance[0], "Tardy");
  assert.equal(persistedAttendanceMonthResult.students[0].reasons[0], "");
  assert.equal(
    persistedAttendanceMonthResult.students[0].attendance[attendanceDates.length - 1],
    "Absent",
  );
  assert.equal(persistedAttendanceMonthResult.students[0].reasons[attendanceDates.length - 1], "Flu");
  assert.equal(persistedAttendanceMonthResult.students[0].remarks, "Follow-up required");
  const noClassDateToClear = attendanceDates[0];
  const addNoClassDateBeforeClear = await fetch(
    `${restartedUrl}/api/attendance/month`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
      body: JSON.stringify({
        month: attendanceMonth,
        records: persistedAttendanceMonthResult.students.map((student, index) => {
          const attendance = Array(attendanceDates.length).fill("");
          if (index === 0) attendance[1] = "Present";
          return {
            studentId: student.id,
            attendance,
            reasons: Array(attendanceDates.length).fill(""),
            remarks: student.remarks,
            statusDate: student.statusDate,
          };
        }),
        noClassDates: [noClassDateToClear],
      }),
    },
  );
  assert.equal(addNoClassDateBeforeClear.status, 200, await addNoClassDateBeforeClear.clone().text());
  const monthWithNoClassDate = await fetch(
    `${restartedUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: restartedTeacherCookie } },
  );
  assert.deepEqual((await monthWithNoClassDate.json()).noClassDates, [noClassDateToClear]);
  const clearAttendanceMonthResponse = await fetch(
    `${restartedUrl}/api/attendance/month?month=${attendanceMonth}`,
    { method: "DELETE", headers: { Cookie: restartedTeacherCookie } },
  );
  assert.equal(clearAttendanceMonthResponse.status, 200);
  const clearedAttendanceMonthResult = await clearAttendanceMonthResponse.json();
  assert.equal(clearedAttendanceMonthResult.cleared, true);
  assert.equal(clearedAttendanceMonthResult.month, attendanceMonth);
  assert.ok(clearedAttendanceMonthResult.deleted > 0);
  assert.equal(clearedAttendanceMonthResult.noClassDatesCleared, 1);
  const clearedAttendanceMonthResponse = await fetch(
    `${restartedUrl}/api/attendance/month?month=${attendanceMonth}`,
    { headers: { Cookie: restartedTeacherCookie } },
  );
  const clearedAttendanceMonth = await clearedAttendanceMonthResponse.json();
  assert.ok(clearedAttendanceMonth.students.every((student) =>
    student.attendance.every((status) => status === "")
      && student.reasons.every((reason) => reason === "")));
  assert.deepEqual(clearedAttendanceMonth.noClassDates, []);
  assert.equal(clearedAttendanceMonth.students[0].remarks, "Follow-up required");
  const attendanceInOtherMonth = await fetch(
    `${restartedUrl}/api/attendance?date=${attendanceDate}`,
    { headers: { Cookie: restartedTeacherCookie } },
  );
  assert.equal(attendanceInOtherMonth.status, 200);
  assert.equal((await attendanceInOtherMonth.json()).students[0].status, "Present");
  for (const assessment of [
    { period: "MOSY", english: "Instructional", filipino: "Frustration" },
    { period: "EOSY", english: "Independent", filipino: "Independent" },
  ]) {
    const response = await fetch(`${restartedUrl}/api/reading-assessments?period=${assessment.period}`, {
      headers: { Cookie: restartedTeacherCookie },
    });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.students[0].levels.English, assessment.english);
    assert.equal(report.students[0].levels.Filipino, assessment.filipino);
  }

  const clearReadingResponse = await fetch(`${restartedUrl}/api/reading-assessments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
    body: JSON.stringify({
      studentId: addedStudent.student.id,
      period: "BOSY",
      levels: { English: "", Filipino: "" },
    }),
  });
  assert.equal(clearReadingResponse.status, 200);
  const clearedReadingResponse = await fetch(`${restartedUrl}/api/reading-assessments`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  const clearedReading = await clearedReadingResponse.json();
  assert.equal(clearedReading.students[0].levels.English, "");
  assert.equal(clearedReading.students[0].levels.Filipino, "");
  const preservedSecondAttemptResponse = await fetch(`${restartedUrl}/api/reading-assessments?period=BOSY&attemptNo=2`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal((await preservedSecondAttemptResponse.json()).students[0].levels.English, "Instructional");

  const workbook = readPortalDatabaseWorkbook(databasePath);
  const users = workbook.getWorksheet("Users");
  const headerMap = new Map();
  users.getRow(1).eachCell((cell, column) => headerMap.set(String(cell.value).toLowerCase(), column));
  const emailColumn = headerMap.get("email");
  const row = users.getRows(2, users.rowCount - 1)
    .find((candidate) => String(candidate.getCell(emailColumn).value).toLowerCase() === credentials.email);
  const teacherRow = users.getRows(2, users.rowCount - 1)
    .find((candidate) => String(candidate.getCell(emailColumn).value).toLowerCase() === teacherCredentials.email);

  assert.ok(row, "registered user is present in the Users sheet");
  assert.equal(row.number, 3, "accounts are written into the workbook's existing user rows");
  assert.match(String(row.getCell(headerMap.get("password hash (pbkdf2)")).value), /^pbkdf2\$/);
  assert.equal(row.getCell(headerMap.get("sign-ins")).value, 1);
  assert.ok(row.getCell(headerMap.get("last sign-in")).value instanceof Date);
  assert.ok(teacherRow, "teacher registration is present in the Users sheet");
  assert.equal(teacherRow.number, 2);
  assert.match(String(teacherRow.getCell(headerMap.get("password hash (pbkdf2)")).value), /^pbkdf2\$/);
  const classSheet = workbook.getWorksheet("Classes");
  const classHeaders = new Map();
  classSheet.getRow(1).eachCell((cell, column) => classHeaders.set(String(cell.value).toLowerCase(), column));
  const classRow = classSheet.getRows(2, classSheet.rowCount - 1)
    .find((candidate) => candidate.getCell(classHeaders.get("class code (parents enter this)")).value === teacherResult.user.classCode);
  assert.ok(classRow, "the teacher's class and parent join code are saved");
  assert.equal(classRow.number, 2);
  assert.equal(classRow.getCell(classHeaders.get("students")).value, 3);
  assert.equal(classRow.getCell(classHeaders.get("parents signed up")).value, 2);
  const gradeSheet = workbook.getWorksheet("Term Grades");
  assert.ok(gradeSheet, "term grades are persisted in a dedicated worksheet");
  const gradeHeaders = new Map();
  gradeSheet.getRow(1).eachCell((cell, column) => gradeHeaders.set(String(cell.value).toLowerCase(), column));
  const savedFilipinoGrade = gradeSheet.getRows(2, gradeSheet.rowCount - 1)
    .find((candidate) => candidate.getCell(gradeHeaders.get("subject")).value === "filipino"
      && candidate.getCell(gradeHeaders.get("term")).value === "Term 1");
  assert.ok(savedFilipinoGrade, "the student's Filipino grade is saved");
  assert.equal(savedFilipinoGrade.getCell(gradeHeaders.get("grade")).value, 88);
  const studentSheet = workbook.getWorksheet("Students");
  const studentHeaders = new Map();
  studentSheet.getRow(1).eachCell((cell, column) => {
    studentHeaders.set(String(cell.value).toLowerCase(), column);
  });
  assert.equal(studentSheet.getRow(2).getCell(studentHeaders.get("lrn")).value, studentDetails.lrn);
  assert.equal(studentSheet.getRow(2).getCell(studentHeaders.get("teacher user id")).value, "T001");
  assert.equal(studentSheet.getRow(2).getCell(studentHeaders.get("birthdate")).value.toISOString().slice(0, 10), studentDetails.birthdate);
  const signInLog = workbook.getWorksheet("SignInLog");
  const logHeaders = new Map();
  signInLog.getRow(1).eachCell((cell, column) => logHeaders.set(String(cell.value).toLowerCase(), column));
  const attempts = [];
  for (let rowNumber = 2; rowNumber <= signInLog.rowCount; rowNumber += 1) {
    const logRow = signInLog.getRow(rowNumber);
    if (String(logRow.getCell(logHeaders.get("email")).value).toLowerCase() === credentials.email) {
      attempts.push(logRow.getCell(logHeaders.get("result")).value);
    }
  }
  assert.deepEqual(attempts, ["Failed", "Success"]);

  const rejectedRosterPassword = await fetch(`${restartedUrl}/api/students/clear/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
    body: JSON.stringify({ password: "incorrect-password" }),
  });
  assert.equal(rejectedRosterPassword.status, 400);
  assert.match((await rejectedRosterPassword.json()).error, /password doesn't match/i);
  const verifyRosterClear = await fetch(`${restartedUrl}/api/students/clear/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
    body: JSON.stringify({ password: teacherCredentials.password }),
  });
  assert.equal(verifyRosterClear.status, 200);
  assert.deepEqual(await verifyRosterClear.json(), { verified: true });
  const rosterBeforeClear = await fetch(`${restartedUrl}/api/students`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  const rosterBeforeClearBody = await rosterBeforeClear.json();
  assert.equal(rosterBeforeClearBody.students.length, 3);
  assert.ok(rosterBeforeClearBody.students.every((student) => student.enrollmentStatus === ""));
  const singleDeleteId = encodeURIComponent(rosterBeforeClearBody.students[0].id);
  const wrongPasswordDelete = await fetch(`${restartedUrl}/api/students/${singleDeleteId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
    body: JSON.stringify({ password: "incorrect-password", confirmed: true }),
  });
  assert.equal(wrongPasswordDelete.status, 400);
  const singleDelete = await fetch(`${restartedUrl}/api/students/${singleDeleteId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
    body: JSON.stringify({ password: teacherCredentials.password, confirmed: true }),
  });
  assert.equal(singleDelete.status, 200);
  const rosterAfterSingleDelete = await fetch(`${restartedUrl}/api/students`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal((await rosterAfterSingleDelete.json()).students.length, 2);
  const unconfirmedRosterClear = await fetch(`${restartedUrl}/api/students/clear`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
    body: JSON.stringify({ password: teacherCredentials.password, confirmed: false }),
  });
  assert.equal(unconfirmedRosterClear.status, 400);
  const rejectedRosterClear = await fetch(`${restartedUrl}/api/students/clear`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
    body: JSON.stringify({ password: "incorrect-password", confirmed: true, section: "__all__" }),
  });
  assert.equal(rejectedRosterClear.status, 400);
  const clearRosterResponse = await fetch(`${restartedUrl}/api/students/clear`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
    body: JSON.stringify({ password: teacherCredentials.password, confirmed: true, section: "__all__" }),
  });
  assert.equal(clearRosterResponse.status, 200);
  const clearRosterResult = await clearRosterResponse.json();
  assert.equal(clearRosterResult.deleted, 2);
  assert.equal(clearRosterResult.removedSection, true);
  assert.deepEqual(clearRosterResult.sectionsHandled, []);
  const clearedRosterResponse = await fetch(`${restartedUrl}/api/students`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  const clearedRoster = await clearedRosterResponse.json();
  assert.deepEqual(clearedRoster.students, []);
  assert.equal(clearedRoster.parents.length, 2, "clearing the roster preserves parent accounts");
  const emptyRosterSF8 = await fetch(
    `${restartedUrl}/api/students/nutritional-status/sf8`,
    { headers: { Cookie: restartedTeacherCookie } },
  );
  assert.equal(emptyRosterSF8.status, 400);
  assert.match((await emptyRosterSF8.json()).error, /add learners to the selected section/i);
  const clearedDatabase = readPortalDatabaseWorkbook(databasePath);
  for (const sheetName of ["Students", "Term Grades", "Term Grade Locks", "Reading Assessments", "Math Assessments", "Attendance Records", "Attendance Monthly Notes"]) {
    const sheet = clearedDatabase.getWorksheet(sheetName);
    if (sheet) {
      const studentIdColumn = new Map(
        sheet.getRow(1).values.slice(1).map((value, index) => [String(value).toLowerCase(), index + 1]),
      ).get("student id");
      if (studentIdColumn) {
        for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
          assert.equal(sheet.getRow(rowNumber).getCell(studentIdColumn).value || "", "", `${sheetName} has no remaining learner rows`);
        }
      }
    }
  }
  const clearedClassSheet = clearedDatabase.getWorksheet("Classes");
  const clearedClassHeaders = new Map();
  clearedClassSheet.getRow(1).eachCell((cell, column) => {
    clearedClassHeaders.set(String(cell.value).toLowerCase(), column);
  });
  const clearedClassRow = clearedClassSheet.getRows(2, clearedClassSheet.rowCount - 1)
    .find((candidate) => candidate.getCell(clearedClassHeaders.get("class code (parents enter this)")).value === teacherResult.user.classCode);
  assert.equal(clearedClassRow.getCell(clearedClassHeaders.get("students")).value, 0);

  const expandedSF8Roster = [];
  for (const [gender, count, prefix] of [
    ["Male", 10, "DynamicMale"],
    ["Female", 6, "DynamicFemale"],
  ]) {
    for (let index = 0; index < count; index += 1) {
      const studentResponse = await fetch(`${restartedUrl}/api/students`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
        body: JSON.stringify({
          lrn: `${gender === "Male" ? "900" : "901"}${String(index + 1).padStart(9, "0")}`,
          lastName: `${prefix}${index + 1}`,
          firstName: "Learner",
          gender,
          birthdate: "2015-04-21",
        }),
      });
      assert.equal(studentResponse.status, 201, await studentResponse.clone().text());
      expandedSF8Roster.push((await studentResponse.json()).student);
    }
  }
  const expandedMeasurementResponse = await fetch(
    `${restartedUrl}/api/students/${encodeURIComponent(expandedSF8Roster[10].id)}/nutritional-status`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: restartedTeacherCookie },
      body: JSON.stringify({
        measurementDate: "2025-04-21",
        weightKg: 42,
        heightM: 1.4,
      }),
    },
  );
  assert.equal(expandedMeasurementResponse.status, 200);
  const expandedSF8Response = await fetch(
    `${restartedUrl}/api/students/nutritional-status/sf8?assessmentDate=2025-04-21`,
    { headers: { Cookie: restartedTeacherCookie } },
  );
  assert.equal(expandedSF8Response.status, 200, await expandedSF8Response.clone().text());
  const expandedSF8Workbook = new ExcelJS.Workbook();
  await expandedSF8Workbook.xlsx.load(Buffer.from(await expandedSF8Response.arrayBuffer()));
  const expandedSF8Sheet = expandedSF8Workbook.getWorksheet("Nutritional Status");
  assert.equal(expandedSF8Sheet.getCell("A22").value, "FEMALE");
  assert.equal(expandedSF8Sheet.getCell("B22").master.address, "B22");
  for (let index = 0; index < 10; index += 1) {
    const row = 12 + index;
    assert.equal(expandedSF8Sheet.getCell(`A${row}`).value, index + 1);
    assert.equal(expandedSF8Sheet.getCell(`C${row}`).value,
      `DynamicMale${index + 1}, Learner`);
    const sourceRow = row <= 18 ? row : row === 21 ? 18 : 13;
    const sourceNameMaster = sourceSF8Sheet.getCell(`D${sourceRow}`).master.address;
    assert.equal(
      expandedSF8Sheet.getCell(`D${row}`).master.address,
      sourceNameMaster.startsWith("C") ? `C${row}` : `D${row}`,
    );
    assert.equal(expandedSF8Sheet.getCell(`I${row}`).value, null);
    assert.equal(expandedSF8Sheet.getCell(`J${row}`).value, null);
    assert.equal(expandedSF8Sheet.getCell(`L${row}`).value, null);
  }
  for (let index = 0; index < 6; index += 1) {
    const row = 23 + index;
    assert.equal(expandedSF8Sheet.getCell(`A${row}`).value, index + 1);
    assert.equal(expandedSF8Sheet.getCell(`C${row}`).value,
      `DynamicFemale${index + 1}, Learner`);
    assert.equal(
      expandedSF8Sheet.getCell(`D${row}`).master.address,
      sourceSF8Sheet.getCell(`D${row <= 25 ? row - 3 : row === 28 ? 22 : 21}`).master.address
        .startsWith("C") ? `C${row}` : `D${row}`,
    );
  }
  for (const [targetRow, sourceRow] of [
    [19, 13], [20, 13], [21, 18], [26, 21], [27, 21], [28, 22],
  ]) {
    for (let column = 1; column <= 15; column += 1) {
      const sourceCell = sourceSF8Sheet.getRow(sourceRow).getCell(column);
      if (sourceCell.isMerged && sourceCell.master.address !== sourceCell.address) continue;
      assert.deepEqual(
        expandedSF8Sheet.getRow(targetRow).getCell(column).style,
        sourceCell.style,
        `inserted row ${targetRow} exactly preserves source row ${sourceRow}, column ${column}`,
      );
    }
    assert.equal(
      expandedSF8Sheet.getRow(targetRow).height,
      sourceSF8Sheet.getRow(sourceRow).height,
      `inserted row ${targetRow} preserves source row ${sourceRow} height`,
    );
  }
  assert.equal(expandedSF8Sheet.getRow(18).height, sourceSF8Sheet.getRow(13).height);
  assert.deepEqual(
    expandedSF8Sheet.getCell("C12").style,
    sourceSF8Sheet.getCell("C12").style,
    "the original merged first male learner row retains its source style",
  );
  assert.equal(expandedSF8Sheet.getCell("D19").master.address, "C19");
  assert.equal(expandedSF8Sheet.getCell("D28").master.address, "C28");
  assert.deepEqual(
    expandedSF8Sheet.conditionalFormattings.map((formatting) => formatting.ref),
    sourceSF8Sheet.conditionalFormattings.map((formatting) => formatting.ref),
  );
  for (const merge of sourceSF8Sheet.model.merges) {
    const match = merge.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    const firstRow = Number(match[2]);
    const lastRow = Number(match[4]);
    const rowDelta = firstRow >= 24 ? 6 : firstRow >= 19 ? 3 : 0;
    const expectedMerge =
      `${match[1]}${firstRow + rowDelta}:${match[3]}${lastRow + rowDelta}`;
    assert.ok(
      expandedSF8Sheet.model.merges.includes(expectedMerge),
      `template merge ${merge} remains at ${expectedMerge}`,
    );
  }
  assert.equal(expandedSF8Sheet.getCell("A29").value, null);
  assert.equal(expandedSF8Sheet.getCell("A30").value, "SUMMARY TABLE");
  assert.equal(expandedSF8Sheet.getCell("A38").value, "Date of Assessment:");
  assert.equal(expandedSF8Sheet.getCell("E38").value, "Conducted/Assessed By:");
  assert.equal(expandedSF8Sheet.getCell("M38").value, "Checked and Reviewed By:");
  assert.equal(expandedSF8Sheet.getCell("E40").value, teacherCredentials.name);
  assert.equal(expandedSF8Sheet.getCell("M40").value, "Alex Principal");

  const sf1UsedRange = XLSX.utils.decode_range(sf1Sheet["!ref"]);
  for (let row = 5; row <= sf1UsedRange.e.r; row += 1) {
    for (let column = 0; column <= sf1UsedRange.e.c; column += 1) {
      delete sf1Sheet[XLSX.utils.encode_cell({ r: row, c: column })];
    }
  }
  sf1Sheet["!ref"] = XLSX.utils.encode_range({
    s: sf1UsedRange.s,
    e: { r: 4, c: sf1UsedRange.e.c },
  });
  const sf1MetadataRow = Array(36).fill("");
  sf1MetadataRow[25] = "Grade Level: Grade 6";
  sf1MetadataRow[35] = "Section: SF1 Import";
  XLSX.utils.sheet_add_aoa(sf1Sheet, [sf1MetadataRow], { origin: "A4" });
  const sf1SectionStudent = Array(41).fill("");
  sf1SectionStudent[0] = "123456789016";
  sf1SectionStudent[2] = "Import, Section, Learner";
  sf1SectionStudent[6] = "F";
  sf1SectionStudent[7] = "2016-02-03";
  XLSX.utils.sheet_add_aoa(sf1Sheet, [sf1SectionStudent], { origin: "A12" });
  const sf1SectionFile = XLSX.write(sf1Workbook, { bookType: "biff8", type: "buffer" });
  const sf1SectionImportResponse = await fetch(`${restartedUrl}/api/teacher/sections/import`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", Cookie: restartedTeacherCookie },
    body: sf1SectionFile,
  });
  assert.equal(sf1SectionImportResponse.status, 201);
  const sf1SectionImport = await sf1SectionImportResponse.json();
  assert.equal(sf1SectionImport.sectionName, "SF1 Import");
  assert.equal(sf1SectionImport.grade, "Grade 6");
  assert.equal(sf1SectionImport.imported, 1);
  assert.deepEqual(sf1SectionImport.sectionGrades, {
    "SF1 Import": "Grade 6",
  });
  const importedSectionRosterResponse = await fetch(`${restartedUrl}/api/students`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal(importedSectionRosterResponse.status, 200);
  const importedSectionRoster = await importedSectionRosterResponse.json();
  assert.equal(
    importedSectionRoster.students.find(({ lrn }) => lrn === "123456789016").section,
    "SF1 Import",
  );
  const savedSectionProfileResponse = await fetch(`${restartedUrl}/api/teacher/profile`, {
    headers: { Cookie: restartedTeacherCookie },
  });
  assert.equal(savedSectionProfileResponse.status, 200);
  assert.deepEqual((await savedSectionProfileResponse.json()).sectionGrades, sf1SectionImport.sectionGrades);
});

test("registration rejects a class code that is not in the workbook", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grade5-portal-"));
  const databasePath = path.join(directory, "database.sqlite");
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  await createEmptyTestWorkbook(migrationWorkbookPath);
  const server = createServer({ databasePath, migrationWorkbookPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Casey Example",
      email: "casey.example@mail.com",
      password: "secure-pass-123",
      role: "parent",
      extra: "not-a-real-code",
    }),
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /teacher to sign up first/i);
});

test("repeated failed sign-ins are throttled and return Retry-After", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grade5-login-limit-"));
  const databasePath = path.join(directory, "database.sqlite");
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  await createEmptyTestWorkbook(migrationWorkbookPath);
  const server = createServer({
    databasePath,
    migrationWorkbookPath,
    authRateLimiter: createAuthRateLimiter({
      accountFailureLimit: 2,
      ipFailureLimit: 40,
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = () => fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Casey Example",
      email: "casey.example@mail.com",
      password: "secure-pass-123",
      role: "teacher",
    }),
  });

  assert.equal((await login()).status, 401);
  assert.equal((await login()).status, 401);
  const throttledResponse = await login();
  assert.equal(throttledResponse.status, 429);
  assert.ok(Number(throttledResponse.headers.get("retry-after")) > 0);
  assert.match((await throttledResponse.json()).error, /too many sign-in attempts/i);
});

test("appearance preference persists across portal server restarts", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grade5-appearance-"));
  const appearancePreferencesPath = path.join(directory, "settings", "appearance.json");
  let server = createServer({ appearancePreferencesPath });
  const startServer = async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const stopServer = async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  context.after(async () => {
    if (server.listening) await stopServer();
    await fs.rm(directory, { recursive: true, force: true });
  });

  let baseUrl = await startServer();
  const initialPreference = await fetch(`${baseUrl}/api/preferences/appearance`);
  assert.equal(initialPreference.status, 200);
  assert.deepEqual(await initialPreference.json(), { theme: null });

  const invalidPreference = await fetch(`${baseUrl}/api/preferences/appearance`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme: "unsupported" }),
  });
  assert.equal(invalidPreference.status, 400);

  const savedPreference = await fetch(`${baseUrl}/api/preferences/appearance`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ theme: "mint" }),
  });
  assert.equal(savedPreference.status, 200);
  assert.deepEqual(await savedPreference.json(), { theme: "mint" });
  await stopServer();

  server = createServer({ appearancePreferencesPath });
  baseUrl = await startServer();
  const restoredPreference = await fetch(`${baseUrl}/api/preferences/appearance`);
  assert.equal(restoredPreference.status, 200);
  assert.deepEqual(await restoredPreference.json(), { theme: "mint" });
});

test("teacher registration assigns unique classroom numbers without asking for one", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grade5-portal-"));
  const databasePath = path.join(directory, "database.sqlite");
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  await createEmptyTestWorkbook(migrationWorkbookPath);
  const server = createServer({ databasePath, migrationWorkbookPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const register = (name, email) => fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      email,
      password: "secure-pass-123",
      role: "teacher",
      grade: "Grade 5",
    }),
  });

  const first = await register("Taylor Teacher", "taylor.teacher@example.com");
  assert.equal(first.status, 201);
  const firstCookie = first.headers.get("set-cookie").split(";")[0];
  const second = await register("Another Teacher", "another.teacher@example.com");
  assert.equal(second.status, 201);
  const secondCookie = second.headers.get("set-cookie").split(";")[0];
  const [firstProfile, secondProfile] = await Promise.all([
    fetch(`http://127.0.0.1:${server.address().port}/api/teacher/profile`, { headers: { Cookie: firstCookie } }),
    fetch(`http://127.0.0.1:${server.address().port}/api/teacher/profile`, { headers: { Cookie: secondCookie } }),
  ]);
  assert.equal((await firstProfile.json()).classroomNumber, "T001");
  assert.equal((await secondProfile.json()).classroomNumber, "T002");
});

test("SQLite migration preserves existing portal accounts", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grade5-portal-migration-"));
  const migrationWorkbookPath = path.join(directory, "existing.xlsx");
  const databasePath = path.join(directory, "portal.sqlite");
  await createMigrationTestWorkbook(migrationWorkbookPath);
  const server = createServer({ databasePath, migrationWorkbookPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", storage: "sqlite" });
  const migratedWorkbook = readPortalDatabaseWorkbook(databasePath);
  const users = migratedWorkbook.getWorksheet("Users");
  const headers = new Map();
  users.getRow(1).eachCell((cell, column) => headers.set(String(cell.value).toLowerCase(), column));
  const emailColumn = headers.get("email");
  assert.ok(emailColumn);
  const migratedAccounts = [];
  for (let rowNumber = 2; rowNumber <= users.rowCount; rowNumber += 1) {
    const email = users.getRow(rowNumber).getCell(emailColumn).value;
    if (email) migratedAccounts.push(email);
  }
  assert.ok(migratedAccounts.length > 0, "existing accounts are present after migration");
});

test("SQLite initialization can recover after a transient migration source failure and logs a reference", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grade5-portal-retry-"));
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  const databasePath = path.join(directory, "portal.sqlite");
  const logFilePath = path.join(directory, "logs", "portal-server.log");
  const server = createServer({ databasePath, migrationWorkbookPath, logFilePath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const healthUrl = `http://127.0.0.1:${server.address().port}/api/health`;
  const failedHealth = await fetch(healthUrl);
  assert.equal(failedHealth.status, 503);
  const failure = await failedHealth.json();
  assert.ok(failure.referenceId);
  assert.match(failure.error, new RegExp(failure.referenceId));
  const log = await fs.readFile(logFilePath, "utf8");
  assert.match(log, new RegExp(failure.referenceId));
  assert.match(log, /migration workbook was not found/);

  await createEmptyTestWorkbook(migrationWorkbookPath);
  const recoveredHealth = await fetch(healthUrl);
  assert.equal(recoveredHealth.status, 200, await recoveredHealth.clone().text());
  assert.deepEqual(await recoveredHealth.json(), { status: "ok", storage: "sqlite" });
});

test("Supabase PostgreSQL storage persists the portal state transactionally", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "grade5-portal-supabase-"));
  const migrationWorkbookPath = path.join(directory, "migration.xlsx");
  await createEmptyTestWorkbook(migrationWorkbookPath);

  let savedState = null;
  const savedPhotos = new Map();
  const queries = [];
  const query = async (text, values = []) => {
    const sql = text.trim().replace(/\s+/g, " ").toLowerCase();
    queries.push(sql);
    if (sql.startsWith("select 1 from portal_profile_photos")) {
      return { rows: savedPhotos.has(values[0]) ? [{ "?column?": 1 }] : [], rowCount: savedPhotos.has(values[0]) ? 1 : 0 };
    }
    if (sql.startsWith("select photo_data from portal_profile_photos")) {
      return { rows: savedPhotos.has(values[0]) ? [{ photo_data: savedPhotos.get(values[0]) }] : [], rowCount: 1 };
    }
    if (sql.startsWith("insert into portal_profile_photos")) {
      savedPhotos.set(values[0], values[2]);
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("select id from portal_state")) {
      return { rows: savedState ? [{ id: 1 }] : [], rowCount: savedState ? 1 : 0 };
    }
    if (sql.startsWith("select workbook_state from portal_state")) {
      return { rows: savedState ? [{ workbook_state: savedState }] : [], rowCount: savedState ? 1 : 0 };
    }
    if (sql.startsWith("insert into portal_state")) {
      if (!savedState) savedState = Buffer.from(values[0]);
      return { rows: [], rowCount: savedState ? 1 : 0 };
    }
    if (sql.startsWith("update portal_state")) {
      savedState = Buffer.from(values[0]);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const postgresPool = {
    query,
    async connect() {
      return { query, release() {} };
    },
    async end() {},
  };
  const server = createServer({ postgresPool, migrationWorkbookPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    if (server.listening) {
      await new Promise((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", storage: "supabase" });

  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Supabase Teacher",
      email: "supabase.teacher@example.com",
      password: "secure-pass-123",
      role: "teacher",
      extra: "12",
      grade: "Grade 5",
    }),
  });
  assert.equal(registration.status, 201);
  assert.ok(queries.includes("begin"));
  assert.ok(queries.includes("commit"));
  assert.ok(queries.some((sql) => sql.startsWith("update portal_state")));

  const teacherCookie = registration.headers.get("set-cookie").split(";")[0];
  const readProfile = async () => (await fetch(`${baseUrl}/api/teacher/profile`, {
    headers: { Cookie: teacherCookie },
  })).json();
  assert.equal((await readProfile()).hasPhoto, false);
  const profilePng = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 26, g: 92, b: 156, alpha: 1 } },
  }).png().toBuffer();
  const savePhoto = await fetch(`${baseUrl}/api/teacher/profile/photo`, {
    method: "PUT",
    headers: { "Content-Type": "image/png", Cookie: teacherCookie },
    body: profilePng,
  });
  assert.equal(savePhoto.status, 200);
  assert.equal((await readProfile()).hasPhoto, true);
});
