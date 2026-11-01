"use strict";

const dotenv = require("dotenv");
dotenv.config();
if (process.env.PORTAL_ADMIN_SECRET_FILE) {
  const secretEnv = dotenv.config({ path: process.env.PORTAL_ADMIN_SECRET_FILE });
  if (secretEnv.error) throw new Error("Could not load the configured administrator secret file.");
}

const { AsyncLocalStorage } = require("node:async_hooks");
const crypto = require("node:crypto");
const fileSystem = require("node:fs");
const fs = require("node:fs/promises");
const { DatabaseSync } = require("node:sqlite");
const { gunzipSync, gzipSync } = require("node:zlib");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const JSZip = require("jszip");
const XLSX = require("@e965/xlsx");
const sharp = require("sharp");
const { Pool } = require("pg");
const { createAuthRateLimiter } = require("./auth-rate-limiter");
const { calculateBmiForAge } = require("./who-growth-reference");

const DOWNLOADS_DIRECTORY = path.join(os.homedir(), "Downloads");
const DEFAULT_DATABASE_PATH = path.join(__dirname, "grade5-portal-database.sqlite");
// Supabase defines the anon/authenticated roles; plain PostgreSQL (e.g. Neon) does not.
const POSTGRES_REVOKE_PUBLIC_ACCESS_SQL = `
  DO $$
  DECLARE role_name text;
  BEGIN
    REVOKE ALL ON TABLE portal_state, portal_profile_photos, portal_school_logos FROM PUBLIC;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format(
          'REVOKE ALL ON TABLE portal_state, portal_profile_photos, portal_school_logos FROM %I',
          role_name
        );
      END IF;
    END LOOP;
  END
  $$`;
const APPLICATION_WORKBOOK_PATH = path.join(__dirname, "grade5-portal-database.xlsx");
const DOWNLOADS_DATABASE_PATH = path.join(DOWNLOADS_DIRECTORY, "grade5-portal-database.xlsx");
const LEGACY_DATABASE_PATH = path.join(DOWNLOADS_DIRECTORY, "grade5-portal-database-template.xlsx");
const configuredDatabasePath = process.env.PORTAL_DATABASE_PATH
  ? path.resolve(process.env.PORTAL_DATABASE_PATH)
  : DEFAULT_DATABASE_PATH;
const DATABASE_PATH = /\.(?:xlsx|xlsm?)$/i.test(configuredDatabasePath)
  ? `${configuredDatabasePath}.sqlite`
  : configuredDatabasePath;
const MIGRATION_WORKBOOK_PATH = process.env.PORTAL_MIGRATION_WORKBOOK
  ? path.resolve(process.env.PORTAL_MIGRATION_WORKBOOK)
  : /\.(?:xlsx|xlsm?)$/i.test(configuredDatabasePath)
    ? configuredDatabasePath
    : fileSystem.existsSync(APPLICATION_WORKBOOK_PATH)
      ? APPLICATION_WORKBOOK_PATH
      : fileSystem.existsSync(DOWNLOADS_DATABASE_PATH)
        ? DOWNLOADS_DATABASE_PATH
        : fileSystem.existsSync(LEGACY_DATABASE_PATH)
          ? LEGACY_DATABASE_PATH
          : path.join(__dirname, "grade5-portal-database-template.xlsx");
const INDEX_PATH = path.join(__dirname, "index.html");
const PORTAL_ENTRY_PATHS = new Map([
  ["/", "main"],
  ["/index.html", "main"],
  ["/parents", "parents"],
  ["/parents.html", "parents"],
  ["/admin", "admin"],
  ["/admin.html", "admin"],
]);
const APP_VERSION = require("./package.json").version;
const MAX_SF1_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SF2_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SF1_STUDENTS = 1000;
const MAX_PROFILE_PHOTO_BYTES = 2 * 1024 * 1024;
const APPEARANCE_THEMES = new Set([
  "system", "light", "dark", "ocean", "sage", "lavender", "rose", "sunset", "amber",
  "forest", "mint", "sky", "indigo", "berry", "coral", "teal", "sand", "midnight",
  "amethyst", "emerald", "slate", "nord", "cherry",
]);
const SF2_TEMPLATE_PATH = path.join(__dirname, "SF2.xlsx");
const SF8_TEMPLATE_PATH = path.join(__dirname, "SF8.xlsx");
const GENERATED_REPORTS_DIRECTORY = path.join(__dirname, "downloads", "generated-reports");
const SF9_TEMPLATE_PATH = path.join(__dirname, "SF9.xlsx");
const GRADE_SHEET_TEMPLATE_PATH = path.join(__dirname, "Grading Sheet.xlsx");
const ECLASS_TEMPLATE_PATH = path.join(__dirname, "E-CLASS.xlsx");
const MPS_TEMPLATE_PATH = path.join(__dirname, "MPS TEMPLATE.docx");
const SF9_LOGO_INCHES = 1.44;
const SF9_LOGO_PIXELS = SF9_LOGO_INCHES * 96;
const SF9_LOGO_BORDER_POINTS = 0.25;
const MPS_DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function escapeWordXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function replaceWordCellText(cellXml, value) {
  const escapedValue = escapeWordXml(value);
  let replaced = false;
  const updated = cellXml.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, (match) => {
    const openingTag = match.match(/^<w:t(?:\s[^>]*)?>/)?.[0] || "<w:t>";
    if (replaced) return `${openingTag}</w:t>`;
    replaced = true;
    return `${openingTag}${escapedValue}</w:t>`;
  });
  if (replaced) return updated;
  const textRun = `<w:r><w:t xml:space="preserve">${escapedValue}</w:t></w:r>`;
  return updated.replace(/<\/w:p>/, `${textRun}</w:p>`);
}

async function createMpsTemplateWordDocument(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.learners)
    || data.learners.length === 0 || data.learners.length > 16) {
    throw new HttpError(400, "The MPS template supports 1 to 16 learner records.");
  }
  const value = (name, maxLength = 200) => {
    const field = typeof data[name] === "string" ? data[name].trim() : "";
    if (field.length > maxLength) throw new HttpError(400, `The MPS ${name} is too long.`);
    return field;
  };
  const fields = {
    subject: value("subject"),
    gradeLevel: value("gradeLevel"),
    section: value("section"),
    schoolYear: value("schoolYear"),
    term: value("term"),
    testType: value("testType"),
    totalItems: value("totalItems", 20),
    examinationDate: value("examinationDate", 30),
    learnerCount: value("learnerCount", 20),
    average: value("average", 30),
    averageDescriptor: value("averageDescriptor", 100),
  };
  const learners = data.learners.map((learner) => {
    if (!learner || typeof learner !== "object") {
      throw new HttpError(400, "The MPS learner records are invalid.");
    }
    const learnerNumber = typeof learner.number === "number" && Number.isInteger(learner.number)
      ? String(learner.number)
      : typeof learner.number === "string" ? learner.number.trim() : "";
    return [
      learnerNumber,
      typeof learner.name === "string" ? learner.name.trim() : "",
      typeof learner.rawScore === "string" ? learner.rawScore.trim() : "",
      typeof learner.totalItems === "string" ? learner.totalItems.trim() : "",
      typeof learner.percentage === "string" ? learner.percentage.trim() : "",
      typeof learner.remark === "string" ? learner.remark.trim() : "",
    ];
  });
  const buffer = await fs.readFile(MPS_TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(buffer);
  let documentXml = await zip.file("word/document.xml").async("string");
  const title = typeof data.title === "string" && data.title.trim()
    ? data.title.trim()
    : "MEAN PERCENTAGE SCORE (MPS) REPORT – TERM EXAMINATION";
  documentXml = documentXml.replace(
    escapeWordXml("MEAN PERCENTAGE SCORE (MPS) REPORT – TERM EXAMINATION"),
    () => escapeWordXml(title),
  );
  const tables = documentXml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>/g) || [];
  if (tables.length < 2) throw new Error("The MPS template does not contain its required tables.");
  const detailValues = [
    `Subject: ${fields.subject}`,
    `Grade Level: ${fields.gradeLevel}`,
    `Section: ${fields.section}`,
    `School Year: ${fields.schoolYear}`,
    `Term: ${fields.term}`,
    `Type of Test: ${fields.testType}`,
    `Total Number of Items: ${fields.totalItems}`,
    `Date of Examination: ${fields.examinationDate}`,
  ];
  let detailsIndex = 0;
  const updatedDetailsTable = tables[0].replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) =>
    replaceWordCellText(cell, detailValues[detailsIndex++] || ""),
  );
  const learnerRows = tables[1].match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
  if (learnerRows.length !== 17) throw new Error("The MPS template learner table must contain 16 rows.");
  let learnerRowIndex = 0;
  const updatedLearnerTable = tables[1].replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (row) => {
    if (learnerRowIndex === 0) {
      learnerRowIndex += 1;
      return row;
    }
    const learner = learners[learnerRowIndex - 1] || ["", "", "", "", "", ""];
    learnerRowIndex += 1;
    let cellIndex = 0;
    return row.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, (cell) =>
      replaceWordCellText(cell, learner[cellIndex++] || ""),
    );
  });
  documentXml = documentXml.replace(tables[0], () => updatedDetailsTable)
    .replace(tables[1], () => updatedLearnerTable);
  const summaryValues = [
    ["Number of Learners: ", fields.learnerCount],
    ["Total Items: ", fields.totalItems],
    ["Mean Percentage Score (MPS): ", fields.average ? `${fields.average}%` : ""],
    ["Descriptive Equivalent: ", fields.averageDescriptor],
  ];
  summaryValues.forEach(([label, replacement]) => {
    documentXml = documentXml.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g, (match) => {
      const text = match.replace(/^<w:t(?:\s[^>]*)?>|<\/w:t>$/g, "");
      if (text !== label) return match;
      const openingTag = match.match(/^<w:t(?:\s[^>]*)?>/)?.[0] || "<w:t>";
      return `${openingTag}${escapeWordXml(`${label}${replacement}`)}</w:t>`;
    });
  });
  zip.file("word/document.xml", documentXml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
async function createCircularTransparentLogo(sourceBuffer, size) {
  const { data, info } = await sharp(sourceBuffer)
    .rotate()
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const edgeColors = new Map();
  const addEdgeColor = (x, y) => {
    const pixel = (y * info.width + x) * info.channels;
    if (data[pixel + 3] === 0) return;
    const key = `${data[pixel] >> 3},${data[pixel + 1] >> 3},${data[pixel + 2] >> 3}`;
    const color = edgeColors.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
    color.count += 1;
    color.red += data[pixel];
    color.green += data[pixel + 1];
    color.blue += data[pixel + 2];
    edgeColors.set(key, color);
  };
  for (let x = 0; x < info.width; x += 1) {
    addEdgeColor(x, 0);
    addEdgeColor(x, info.height - 1);
  }
  for (let y = 1; y < info.height - 1; y += 1) {
    addEdgeColor(0, y);
    addEdgeColor(info.width - 1, y);
  }
  const background = [...edgeColors.values()].sort((left, right) => right.count - left.count)[0];
  if (background) {
    const backgroundColor = [
      background.red / background.count,
      background.green / background.count,
      background.blue / background.count,
    ];
    const pixelCount = info.width * info.height;
    const visited = new Uint8Array(pixelCount);
    const queue = new Int32Array(pixelCount);
    const thresholdSquared = 72 * 72;
    const backgroundDistanceSquared = (pixel) => {
      const red = data[pixel * info.channels] - backgroundColor[0];
      const green = data[pixel * info.channels + 1] - backgroundColor[1];
      const blue = data[pixel * info.channels + 2] - backgroundColor[2];
      return red * red + green * green + blue * blue;
    };
    let queueEnd = 0;
    const addBackgroundPixel = (x, y) => {
      const pixel = y * info.width + x;
      if (
        !visited[pixel]
        && data[pixel * info.channels + 3] > 0
        && backgroundDistanceSquared(pixel) <= thresholdSquared
      ) {
        visited[pixel] = 1;
        queue[queueEnd] = pixel;
        queueEnd += 1;
      }
    };
    for (let x = 0; x < info.width; x += 1) {
      addBackgroundPixel(x, 0);
      addBackgroundPixel(x, info.height - 1);
    }
    for (let y = 1; y < info.height - 1; y += 1) {
      addBackgroundPixel(0, y);
      addBackgroundPixel(info.width - 1, y);
    }
    for (let queueStart = 0; queueStart < queueEnd; queueStart += 1) {
      const pixel = queue[queueStart];
      const x = pixel % info.width;
      const y = Math.floor(pixel / info.width);
      if (x > 0) addBackgroundPixel(x - 1, y);
      if (x < info.width - 1) addBackgroundPixel(x + 1, y);
      if (y > 0) addBackgroundPixel(x, y - 1);
      if (y < info.height - 1) addBackgroundPixel(x, y + 1);
    }
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      if (!visited[pixel]) continue;
      const distance = Math.sqrt(backgroundDistanceSquared(pixel));
      const opacity = Math.max(0, Math.min(1, (distance - 24) / 48));
      const alphaIndex = pixel * info.channels + 3;
      data[alphaIndex] = Math.round(data[alphaIndex] * opacity);
    }
  }
  const transparentLogo = await sharp(data, { raw: info }).png().toBuffer();
  const borderWidth = size * SF9_LOGO_BORDER_POINTS / (SF9_LOGO_INCHES * 72);
  const radius = size / 2 - borderWidth / 2;
  return sharp(transparentLogo)
    .composite([{
      input: Buffer.from(
        `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`,
      ),
      blend: "dest-in",
    }, {
      input: Buffer.from(
        `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="black" stroke-width="${borderWidth}"/></svg>`,
      ),
    }])
    .png()
    .toBuffer();
}
const SF2_FIRST_MALE_STUDENT_ROW = 13;
const SF2_LAST_MALE_STUDENT_ROW = 62;
const SF2_FIRST_FEMALE_STUDENT_ROW = 64;
const SF2_LAST_FEMALE_STUDENT_ROW = 113;
const SF2_STUDENT_ROWS = [
  ...Array.from(
    { length: SF2_LAST_MALE_STUDENT_ROW - SF2_FIRST_MALE_STUDENT_ROW + 1 },
    (_, index) => SF2_FIRST_MALE_STUDENT_ROW + index,
  ),
  ...Array.from(
    { length: SF2_LAST_FEMALE_STUDENT_ROW - SF2_FIRST_FEMALE_STUDENT_ROW + 1 },
    (_, index) => SF2_FIRST_FEMALE_STUDENT_ROW + index,
  ),
];
const SF2_MAX_STUDENTS_PER_GENDER = 50;
const SF2_FIRST_DAY_COLUMN = 7;
const SF2_LAST_DAY_COLUMN = 31;
const SF2_WEEKDAY_NAMES = ["M", "T", "W", "TH", "F"];
const SF2_REMARKS_COLUMN = 34;
const SF2_STATUS_DATE_MARKER = "\n[Grade Portal status date: ";
const SF2_ABSENCE_REASONS_MARKER = "[Grade Portal absence reasons]\n";
const SF2_STATUS_BY_MARK = new Map([
  ["", "Present"],
  ["-", "Present"],
  ["x", "Absent"],
  ["cc", "Absent"],
  ["h", "Absent"],
  ["l", "Tardy"],
  ["t", "Tardy"],
  ["e", "Excused"],
  ["nc", "No Class"],
  ["n/a", "Locked"],
]);
const SF2_MARK_BY_STATUS = new Map([
  ["Present", ""],
  ["Absent", "CC"],
  ["Tardy", "T"],
  ["Excused", "E"],
]);
const PASSWORD_ITERATIONS = 210000;
const PASSWORD_BYTES = 32;
const SESSION_COOKIE = "grade5_session";
const PORTAL_SESSION_ENTRIES = new Set(["teacher", "parents", "admin"]);
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const GRADE_TERMS = ["Term 1", "Term 2", "Term 3"];
const READING_PERIODS = ["BOSY", "MOSY", "EOSY"];
const MATH_ASSESSMENT_PERIODS = ["BOSY", "MOSY", "EOSY"];
const MATH_ASSESSMENT_ITEMS = [
  ["1", 1], ["2", 1], ["3", 1], ["4", 1], ["5", 2], ["6", 1], ["7", 1], ["8", 1],
  ["9", 1], ["10", 1], ["11", 1], ["12", 1], ["13", 1], ["14", 1], ["15", 1],
  ["16", 1], ["17", 3], ["18", 1], ["19", 1], ["20", 1], ["21", 2], ["22", 1],
  ["23", 2], ["24", 1], ["25", 1], ["26", 1], ["27", 1], ["28", 1], ["29", 1],
  ["30a", 1], ["30b", 1], ["31", 1], ["32", 2], ["33", 2], ["34", 1], ["35", 1],
  ["36", 1], ["37a", 1], ["37b", 1], ["38", 1], ["39", 2], ["40", 1],
].map(([key, maximum], index) => ({
  key,
  label: key,
  maximum,
  gradeLevel: index < 12 ? "Grade 4" : index < 27 ? "Grade 5" : "Grade 6",
}));
const MATH_ASSESSMENT_GRADES = [
  { gradeLevel: "Grade 4", maximumScore: 13, levelCutoffs: [11, 8, 5, 3] },
  { gradeLevel: "Grade 5", maximumScore: 32, levelCutoffs: [27, 21, 14, 7] },
  { gradeLevel: "Grade 6", maximumScore: 50, levelCutoffs: [45, 39, 29, 15] },
];
const MATH_ASSESSMENT_DOMAINS = [
  {
    key: "numberAndNumberSense",
    label: "Number and Number Sense",
    category: "Content Domain",
    itemKeys: ["1", "3", "7", "8", "10", "11", "12", "14", "15", "19", "21", "25", "29", "31", "32", "33", "34", "35", "38"],
  },
  {
    key: "geometry",
    label: "Geometry",
    category: "Content Domain",
    itemKeys: ["5", "13", "17", "20", "22", "23", "26", "36"],
  },
  {
    key: "measurement",
    label: "Measurement",
    category: "Content Domain",
    itemKeys: ["9", "16", "18", "24", "28"],
  },
  {
    key: "statisticsAndProbability",
    label: "Statistics & Probability",
    category: "Content Domain",
    itemKeys: ["4", "27", "30a", "30b", "37a", "37b", "40"],
  },
  {
    key: "algebra",
    label: "Algebra",
    category: "Content Domain",
    itemKeys: ["2", "6", "39"],
  },
  {
    key: "knowing",
    label: "Knowing",
    category: "Cognitive Domain",
    itemKeysByGrade: {
      "Grade 4": ["1", "4", "6", "12"],
      "Grade 5": ["1", "4", "6", "12", "13", "15", "16", "19", "21", "22", "27"],
      "Grade 6": ["1", "4", "6", "12", "13", "15", "16", "19", "21", "22", "27", "28", "29", "32", "34", "35", "37a", "37b"],
    },
  },
  {
    key: "applying",
    label: "Applying",
    category: "Cognitive Domain",
    itemKeysByGrade: {
      "Grade 4": ["2", "3", "5", "7", "8", "11"],
      "Grade 5": ["2", "3", "5", "7", "8", "11", "14", "18", "24", "25", "26"],
      "Grade 6": ["2", "3", "5", "7", "8", "11", "14", "18", "24", "25", "26", "30a", "31", "33", "38", "39", "40"],
    },
  },
  {
    key: "reasoning",
    label: "Reasoning",
    category: "Cognitive Domain",
    itemKeysByGrade: {
      "Grade 4": ["9", "10"],
      "Grade 5": ["9", "10", "17", "20", "23"],
      "Grade 6": ["9", "10", "17", "20", "23", "30b", "36"],
    },
  },
];
const MATH_ASSESSMENT_DOMAIN_INTERVENTIONS = {
  "Number and Number Sense": "Use number lines, place-value models, and guided computation practice.",
  Geometry: "Review shape properties and spatial reasoning with diagrams and hands-on models.",
  Measurement: "Practice selecting units and solving measurement problems with visual and real-world examples.",
  "Statistics & Probability": "Use tables, graphs, and simple experiments to practice interpreting data and probability.",
  Algebra: "Model unknown values with patterns, expressions, and step-by-step equation practice.",
};

function mathAssessmentDomainItems(domain, gradeLevel) {
  if (domain.itemKeysByGrade) return domain.itemKeysByGrade[gradeLevel];
  const gradeIndex = MATH_ASSESSMENT_GRADES.findIndex((grade) => grade.gradeLevel === gradeLevel);
  return domain.itemKeys.filter((key) => {
    const item = MATH_ASSESSMENT_ITEMS.find((entry) => entry.key === key);
    return item && MATH_ASSESSMENT_GRADES.findIndex((grade) => grade.gradeLevel === item.gradeLevel) <= gradeIndex;
  });
}

function mathTemplateAssessmentNarrative(score) {
  if (typeof score.percentageScore !== "number") {
    return { remarks: "", strengths: "", areasForImprovement: "", recommendedIntervention: "" };
  }
  const domains = score.domainScores || [];
  const meetingBenchmark = domains.filter((domain) => domain.meetsBenchmark);
  const belowBenchmark = domains.filter((domain) => !domain.meetsBenchmark)
    .sort((left, right) => left.percentageScore - right.percentageScore);
  const domainSummary = domains.map((domain) =>
    `${domain.label}: ${domain.score}/${domain.maximum} (${domain.percentageScore.toFixed(2)}%)`,
  ).join("; ");
  const strengths = meetingBenchmark.length
    ? meetingBenchmark.map((domain) =>
      `${domain.label} (${domain.percentageScore.toFixed(2)}%)`,
    ).join("; ")
    : domains.length
      ? `No content domain met the 75% benchmark. Relative strength: ${domains
        .slice().sort((left, right) => right.percentageScore - left.percentageScore)[0].label}.`
      : "Data Not Yet Available";
  const areasForImprovement = belowBenchmark.length
    ? belowBenchmark.map((domain) =>
      `${domain.label} (${domain.percentageScore.toFixed(2)}%; ${domain.score}/${domain.maximum})`,
    ).join("; ")
    : "All assessed content domains met or exceeded the 75% benchmark.";
  const recommendedIntervention = belowBenchmark.length
    ? belowBenchmark.map((domain) =>
      `${domain.label}: ${MATH_ASSESSMENT_DOMAIN_INTERVENTIONS[domain.label]}`,
    ).join(" ")
    : "Maintain progress with mixed review and enrichment tasks across all five content domains.";
  return {
    remarks: `${score.rawScore}/${score.totalItems} points (${score.percentageScore.toFixed(2)}%). `
      +`${score.masteryLevel}. ${domainSummary}`,
    strengths,
    areasForImprovement,
    recommendedIntervention,
  };
}
const MATH_ASSESSMENT_LEVELS = [
  { level: "At Grade Level (Highly Proficient)", interpretation: "At grade level; highly proficient." },
  { level: "Transitioning (Proficient)", interpretation: "Transitioning; proficient." },
  { level: "Developing (Nearly Proficient)", interpretation: "Developing; nearly proficient." },
  { level: "Emerging (Low Proficient)", interpretation: "Emerging; low proficiency." },
  { level: "Emerging (Not Proficient)", interpretation: "Emerging; not yet proficient." },
];
const MATH_MASTERY_BANDS = [
  {
    level: "Advanced Mastery",
    minimum: 90,
    interpretation: "Exceeds expectations; demonstrates strong understanding and application of mathematical skills.",
  },
  {
    level: "Proficient Mastery",
    minimum: 75,
    interpretation: "Meets expectations; demonstrates adequate understanding of mathematical skills.",
  },
  {
    level: "Developing Mastery",
    minimum: 50,
    interpretation: "Shows partial understanding; requires additional practice and support.",
  },
  {
    level: "Beginning Mastery",
    minimum: 0,
    interpretation: "Requires intensive intervention, remediation, and reteaching.",
  },
];
const READING_LANGUAGES = ["English", "Filipino"];
const READING_LEVELS = ["Non-reader", "Frustration", "Instructional", "Independent"];
const PHILIRI_LEVELS = ["Independent", "Instructional", "Frustration"];
const PHILIRI_ASSESSMENT_TYPES = ["Pretest", "Posttest"];
const PHILIRI_MODES = ["Oral Reading", "Silent Reading"];
const PHILIRI_AUTO_SCORING_MODES = ["Oral Reading", "Silent Reading", "Listening Comprehension"];
const PHILIRI_GRADES = ["Grade 4", "Grade 5", "Grade 6"];
const PHILIRI_INTERVENTIONS = [
  "Guided Reading",
  "Peer Reading",
  "One-on-One Reading",
  "Remedial Reading",
  "Home Reading Program",
  "Customized Intervention",
];

function getPhilIriAutoScoringGuide(grade) {
  const gradeMatch = ["string", "number"].includes(typeof grade)
    ? String(grade).trim().match(/^(?:Grade\s*)?(\d+)$/i)
    : null;
  const gradeNumber = gradeMatch ? Number(gradeMatch[1]) : 0;
  if (gradeNumber >= 3 && gradeNumber <= 6) {
    return {
      supported: true,
      grade,
      totalItems: 20,
      passingScore: 14,
      source: "Phil-IRI Manual 2018",
      minimumPassageGrade: { English: 2, Filipino: 1 },
      referralRanges: [
        { minimum: 0, maximum: 7, levelsBelow: 3 },
        { minimum: 8, maximum: 13, levelsBelow: 2 },
      ],
    };
  }
  if (gradeNumber >= 7 && gradeNumber <= 10) {
    return {
      supported: true,
      grade,
      totalItems: 40,
      passingScore: 28,
      durationMinutes: 60,
      source: "Phil-IRI for Junior High School Manual 2024",
      minimumPassageGrade: { English: 4, Filipino: 4 },
      referralRanges: [
        { minimum: 0, maximum: 15, levelsBelow: 3 },
        { minimum: 16, maximum: 27, levelsBelow: 2 },
      ],
    };
  }
  return {
    supported: false,
    grade,
    source: "The available Phil-IRI manuals cover Grades 3–10.",
  };
}

function getPhilIriStartingPassage(score, guide, language) {
  if (!guide?.supported || !Number.isInteger(score) || score >= guide.passingScore) return "";
  const referralRange = guide.referralRanges.find(({ minimum, maximum }) => score >= minimum && score <= maximum);
  const gradeNumber = Number(String(guide.grade).match(/\d+/)?.[0]);
  const minimumGrade = guide.minimumPassageGrade[language] || 1;
  if (!referralRange || !Number.isInteger(gradeNumber)) return "";
  const passageGrade = Math.max(minimumGrade, gradeNumber - referralRange.levelsBelow);
  const gradeDescription = `Grade ${passageGrade} passage`;
  return passageGrade === gradeNumber - referralRange.levelsBelow
    ? `${gradeDescription} (${referralRange.levelsBelow} levels below)`
    : `${gradeDescription} (lowest available ${language} passage)`;
}

const ATTENDANCE_STATUSES = ["Present", "Absent", "Tardy", "Excused"];
const GRADE_1_SUBJECTS = [
  ["language", "Language"],
  ["readingAndLiteracy", "Reading and Literacy"],
  ["mathematics", "Mathematics"],
  ["makabansa", "Makabansa"],
  ["gmrc", "GMRC (Good Manners and Right Conduct)"],
];
const GRADE_2_SUBJECTS = [
  ["english", "English"],
  ["literacy", "Literacy"],
  ["mathematics", "Mathematics"],
  ["makabansa", "Makabansa"],
  ["gmrc", "GMRC"],
];
const GRADE_3_SUBJECTS = [
  ["english", "English"],
  ["filipino", "Filipino"],
  ["mathematics", "Mathematics"],
  ["science", "Science"],
  ["makabansa", "Makabansa"],
  ["gmrc", "GMRC"],
];
const GRADE_4_5_SUBJECTS = [
  ["english", "English"],
  ["filipino", "Filipino"],
  ["mathematics", "Mathematics"],
  ["science", "Science"],
  ["aralingPanlipunan", "Araling Panlipunan"],
  ["epp", "EPP"],
  ["musicAndArts", "Music and Arts"],
  ["physicalEducationAndHealth", "Physical Education and Health"],
  ["gmrc", "GMRC"],
];
const GRADE_6_SUBJECTS = [
  ["english", "English"],
  ["filipino", "Filipino"],
  ["mathematics", "Mathematics"],
  ["science", "Science"],
  ["aralingPanlipunan", "Araling Panlipunan"],
  ["tle", "TLE"],
  ["musicAndArts", "Music and Arts"],
  ["physicalEducationAndHealth", "Physical Education and Health"],
  ["gmrc", "GMRC"],
];
const GRADE_7_10_SUBJECTS = [
  ["english", "English"],
  ["filipino", "Filipino"],
  ["mathematics", "Mathematics"],
  ["science", "Science"],
  ["aralingPanlipunan", "Araling Panlipunan"],
  ["musicAndArts", "Music and Arts"],
  ["physicalEducationAndHealth", "Physical Education and Health"],
  ["tle", "TLE"],
  ["gmrc", "Values Education / GMRC"],
];
const SHS_CORE_SUBJECTS = [
  ["oralCommunication", "Oral Communication"],
  ["readingAndWriting", "Reading and Writing"],
  ["komunikasyonAtPananaliksik", "Komunikasyon at Pananaliksik sa Wika at Kulturang Pilipino"],
  ["pagbasaAtPagsusuri", "Pagbasa at Pagsusuri ng Iba't Ibang Teksto Tungo sa Pananaliksik"],
  ["21stCenturyLiterature", "21st Century Literature from the Philippines and the World"],
  ["contemporaryPhilippineArts", "Contemporary Philippine Arts from the Regions"],
  ["mediaAndInformationLiteracy", "Media and Information Literacy"],
  ["generalMathematics", "General Mathematics"],
  ["statisticsAndProbability", "Statistics and Probability"],
  ["earthAndLifeScience", "Earth and Life Science"],
  ["physicalScience", "Physical Science"],
  ["understandingCultureSocietyAndPolitics", "Understanding Culture, Society and Politics"],
  ["physicalEducationAndHealth", "Physical Education and Health"],
  ["personalDevelopment", "Personal Development"],
  ["empowermentTechnologies", "Empowerment Technologies"],
];
const SHS_STRAND_SUBJECTS = {
  STEM: [
    ["preCalculus", "Pre-Calculus"],
    ["basicCalculus", "Basic Calculus"],
    ["generalBiology1", "General Biology 1"],
    ["generalBiology2", "General Biology 2"],
    ["generalPhysics1", "General Physics 1"],
    ["generalPhysics2", "General Physics 2"],
    ["generalChemistry1", "General Chemistry 1"],
    ["generalChemistry2", "General Chemistry 2"],
  ],
  ABM: [
    ["appliedEconomics", "Applied Economics"],
    ["businessEthicsAndSocialResponsibility", "Business Ethics and Social Responsibility"],
    ["fundamentalsOfAccountancyBusinessAndManagement1", "Fundamentals of Accountancy, Business and Management 1"],
    ["fundamentalsOfAccountancyBusinessAndManagement2", "Fundamentals of Accountancy, Business and Management 2"],
    ["businessMathematics", "Business Mathematics"],
    ["businessFinance", "Business Finance"],
    ["organizationAndManagement", "Organization and Management"],
    ["principlesOfMarketing", "Principles of Marketing"],
  ],
  HUMSS: [
    ["creativeWriting", "Creative Writing"],
    ["creativeNonfiction", "Creative Nonfiction"],
    ["introductionToWorldReligions", "Introduction to World Religions and Belief Systems"],
    ["disciplinesAndIdeasInSocialSciences", "Disciplines and Ideas in the Social Sciences"],
    ["disciplinesAndIdeasInAppliedSocialSciences", "Disciplines and Ideas in the Applied Social Sciences"],
    ["philippinePoliticsAndGovernance", "Philippine Politics and Governance"],
    ["communityEngagement", "Community Engagement, Solidarity, and Citizenship"],
  ],
  GAS: [
    ["humanities1", "Humanities 1"],
    ["humanities2", "Humanities 2"],
    ["socialScience1", "Social Science 1"],
    ["socialScience2", "Social Science 2"],
    ["appliedEconomics", "Applied Economics"],
    ["organizationAndManagement", "Organization and Management"],
  ],
  TVL: [],
  "Arts and Design": [],
  Sports: [],
};
const VALID_GRADES = Array.from({ length: 12 }, (_, index) => `Grade ${index + 1}`);
const VALID_SHS_STRANDS = Object.keys(SHS_STRAND_SUBJECTS);
const ALL_SUBJECT_DEFINITIONS = [
  ...GRADE_1_SUBJECTS,
  ...GRADE_2_SUBJECTS,
  ...GRADE_3_SUBJECTS,
  ...GRADE_4_5_SUBJECTS,
  ...GRADE_6_SUBJECTS,
  ...GRADE_7_10_SUBJECTS,
  ...SHS_CORE_SUBJECTS,
  ...Object.values(SHS_STRAND_SUBJECTS).flat(),
].filter((subject, index, subjects) => subjects.findIndex(([key]) => key === subject[0]) === index);

function gradeSubjectsForGrade(grade, strand = "") {
  const gradeNumber = Number(String(grade || "").match(/\d+/)?.[0]);
  if (gradeNumber === 1) return GRADE_1_SUBJECTS;
  if (gradeNumber === 2) return GRADE_2_SUBJECTS;
  if (gradeNumber === 3) return GRADE_3_SUBJECTS;
  if (gradeNumber >= 4 && gradeNumber <= 5) return GRADE_4_5_SUBJECTS;
  if (gradeNumber === 6) return GRADE_6_SUBJECTS;
  if (gradeNumber >= 7 && gradeNumber <= 10) return GRADE_7_10_SUBJECTS;
  if (gradeNumber >= 11 && gradeNumber <= 12) {
    const normalizedStrand = VALID_SHS_STRANDS.find((item) =>
      item.toLocaleLowerCase() === String(strand || "").trim().toLocaleLowerCase());
    return [...SHS_CORE_SUBJECTS, ...(SHS_STRAND_SUBJECTS[normalizedStrand] || [])];
  }
  return GRADE_7_10_SUBJECTS;
}

function teacherSubjectsForGrade(grade, strand = "") {
  return gradeSummarySubjectsForGrade(grade, strand).map(([, label]) =>
    label === "MAPEH (average)" ? "MAPEH" : label);
}

function gradeSummarySubjectsForGrade(grade, strand = "") {
  const subjects = gradeSubjectsForGrade(grade, strand);
  if (!subjects.some(([key]) => key === "musicAndArts")
    || !subjects.some(([key]) => key === "physicalEducationAndHealth")) return subjects;
  return subjects.flatMap(([key, label]) => {
    if (key === "musicAndArts") return [["mapeh", "MAPEH (average)"]];
    return key === "physicalEducationAndHealth" ? [] : [[key, label]];
  });
}

function sf9ReportSubjectsForGrade(grade, strand = "") {
  const subjects = gradeSummarySubjectsForGrade(grade, strand).flatMap(([key, label]) =>
    key === "mapeh"
      ? [
        [key, label],
        ["musicAndArts", "Music and Arts"],
        ["physicalEducationAndHealth", "Physical Education and Health"],
      ]
      : [[key, label]]);
  const gradeNumber = Number(String(grade || "").match(/\d+/)?.[0]);
  if (!(gradeNumber >= 4 && gradeNumber <= 10)) return subjects;
  const subjectOrder = new Map([
    ["filipino", 0],
    ["english", 1],
    ["mathematics", 2],
    ["science", 3],
    ["aralingPanlipunan", 4],
    ["gmrc", 5],
    ["epp", 6],
    ["tle", 6],
    ["mapeh", 7],
    ["musicAndArts", 8],
    ["physicalEducationAndHealth", 9],
  ]);
  return subjects.sort(([leftKey], [rightKey]) =>
    (subjectOrder.get(leftKey) ?? Number.MAX_SAFE_INTEGER)
    - (subjectOrder.get(rightKey) ?? Number.MAX_SAFE_INTEGER));
}

function generalAverageSubjectsForGrade(grade, strand = "") {
  return gradeSummarySubjectsForGrade(grade, strand).map(([key]) => key);
}

function eClassSubjectsForGrade(grade, strand = "") {
  return gradeSummarySubjectsForGrade(grade, strand)
    .map(([key, label]) => key === "mapeh" ? "MAPEH" : label);
}
// DepEd Order No. 015, s. 2026, Annex D, Table 4 (Adjusted Transmutation Table).
const ECLASS_TRANSMUTATION_TABLE = [
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

function eClassDescriptor(value) {
  return value >= 90 ? "Advancing" : value >= 80 ? "Benchmarking"
    : value >= 75 ? "Connecting" : value >= 65 ? "Developing" : "Emerging";
}

// Table 12 transition rules: "transmuted" (SY 2026-27 numeric), "zero-based" (SY 2027-28
// onward for Grades 4-10, and Grade 3 in 2027-28), or "descriptive" (KS1).
function eClassGradingMethod(grade, schoolYear) {
  const gradeNumber = Number(String(grade || "").match(/\d+/)?.[0]);
  const startYear = Number(/^\s*(\d{4})/.exec(String(schoolYear || ""))?.[1]);
  const year = Number.isFinite(startYear) ? Math.max(startYear, 2026) : 2026;
  if (gradeNumber >= 1 && gradeNumber <= 3) {
    if (year === 2026) return gradeNumber === 1 ? "descriptive" : "transmuted";
    if (year === 2027) return gradeNumber === 3 ? "zero-based" : "descriptive";
    return "descriptive";
  }
  return year >= 2027 ? "zero-based" : "transmuted";
}

function eClassSubjectWeights(subject) {
  return subject === "MAPEH" || subject === "EPP / TLE" || subject === "EPP" || subject === "TLE"
    ? { written: 20, performance: 60, examinations: 20 }
    : { written: 20, performance: 50, examinations: 30 };
}

function computeEClassTermGrade(scores, maxima, subject, method) {
  const earned = Array.from({ length: 11 }, (_, index) => {
    const value = scores[index];
    return value === undefined || String(value).trim() === "" ? null : Number(value);
  });
  const highest = maxima.map((value) => String(value).trim() === "" ? null : Number(value));
  const weights = eClassSubjectWeights(subject);
  const component = (start, count) => {
    const active = [];
    for (let index = start; index < start + count; index += 1) {
      if (highest[index] !== null && highest[index] > 0) active.push(index);
    }
    if (!active.length || active.some((index) => earned[index] === null)) return null;
    return active.reduce((total, index) => total + earned[index], 0)
      / active.reduce((total, index) => total + highest[index], 0) * 100;
  };
  const writtenPercentage = component(0, 5);
  const performancePercentage = component(5, 3);
  const examWeights = [30, 30, 40];
  const activeExams = [8, 9, 10].filter((index) => highest[index] !== null && highest[index] > 0);
  if (writtenPercentage === null || performancePercentage === null || !activeExams.length
    || activeExams.some((index) => earned[index] === null)) {
    return { initialGrade: null, termGrade: "", descriptor: "" };
  }
  const examPercentage = activeExams.reduce((total, index) =>
    total + earned[index] / highest[index] * 100 * examWeights[index - 8], 0)
    / activeExams.reduce((total, index) => total + examWeights[index - 8], 0);
  const initialGrade = (writtenPercentage * weights.written
    + performancePercentage * weights.performance
    + examPercentage * weights.examinations) / 100;
  if (method === "descriptive") {
    return { initialGrade, termGrade: "", descriptor: eClassDescriptor(Math.round(initialGrade + 1e-9)) };
  }
  let termGrade;
  if (method === "zero-based") {
    termGrade = Math.max(60, Math.round(initialGrade + 1e-9));
  } else {
    const hundredths = Math.round((initialGrade + 1e-9) * 100);
    termGrade = ECLASS_TRANSMUTATION_TABLE.find(([low, high]) =>
      hundredths >= Math.round(low * 100) && hundredths <= Math.round(high * 100))?.[2];
  }
  return { initialGrade, termGrade: String(termGrade), descriptor: eClassDescriptor(termGrade) };
}

const STUDENT_FIELDS = [
  ["lrn", "LRN"],
  ["lastName", "Last name"],
  ["firstName", "First name"],
  ["middleName", "Middle name"],
  ["gender", "Gender"],
  ["birthdate", "Birthdate"],
  ["mothersMaidenName", "Mother's Maiden name"],
  ["guardianRelationship", "Guardian relationship"],
  ["father", "Father"],
  ["currentResidence", "Current residence"],
  ["religion", "Religion"],
  ["motherTongue", "Mother tongue"],
  ["dialects", "Dialects"],
  ["ethnicities", "Ethnicities"],
  ["teacherUserId", "Teacher User ID"],
];
const pbkdf2 = promisify(crypto.pbkdf2);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function headerColumns(worksheet) {
  const headers = new Map();
  worksheet.getRow(1).eachCell((cell, columnNumber) => {
    if (typeof cell.value === "string") {
      headers.set(normalizeHeader(cell.value), columnNumber);
    }
  });
  return headers;
}

function normalizeHeader(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function ensureColumn(worksheet, headers, name, aliases = []) {
  for (const candidate of [name, ...aliases]) {
    const column = headers.get(normalizeHeader(candidate));
    if (column) return column;
  }
  const column = worksheet.columnCount + 1;
  const headerCell = worksheet.getRow(1).getCell(column);
  headerCell.value = name;
  const previousHeader = worksheet.getRow(1).getCell(column - 1);
  if (previousHeader.style) headerCell.style = structuredClone(previousHeader.style);
  headers.set(normalizeHeader(name), column);
  return column;
}

function getColumn(headers, name, aliases = []) {
  const column = [name, ...aliases]
    .map(normalizeHeader)
    .map((candidate) => headers.get(candidate))
    .find(Boolean);
  if (!column) {
    throw new Error(`The workbook is missing the "${name}" column.`);
  }
  return column;
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in value) return String(value.text).trim();
  return String(value).trim();
}

function excelSafeText(value) {
  return Array.from(String(value))
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === 0x09
        || codePoint === 0x0a
        || codePoint === 0x0d
        || (codePoint >= 0x20 && codePoint <= 0xd7ff)
        || (codePoint >= 0xe000 && codePoint <= 0xfffd)
        || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    })
    .join("");
}

function readStoredStringList(value, label) {
  const stored = cellText(value);
  if (!stored) return [];
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    throw new Error(`The saved ${label} list is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`The saved ${label} list must contain text entries.`);
  }
  return parsed;
}

function uniqueTextList(values) {
  const seen = new Set();
  return values.map((value) => value.trim())
    .filter((value) => {
      if (!value) return false;
      const key = value.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function readStoredSectionGrades(value) {
  const stored = cellText(value);
  if (!stored) return new Map();
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    throw new Error(`The saved section grades are invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.values(parsed).some((grade) => typeof grade !== "string")) {
    throw new Error("The saved section grades must map section names to text grades.");
  }
  return new Map(Object.entries(parsed).map(([section, grade]) => [section.toLocaleLowerCase(), {
    section,
    grade,
  }]));
}

function readStoredSectionSubjects(value, advisorySection) {
  const stored = cellText(value);
  if (!stored) return {};
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    throw new Error(`The saved section subjects are invalid JSON: ${error.message}`);
  }
  if (Array.isArray(parsed)) {
    return advisorySection ? { [advisorySection]: uniqueTextList(parsed) } : {};
  }
  if (!parsed || typeof parsed !== "object"
    || Object.values(parsed).some((subjects) => !Array.isArray(subjects)
      || subjects.some((subject) => typeof subject !== "string"))) {
    throw new Error("The saved section subjects must map section names to subject lists.");
  }
  return Object.fromEntries(Object.entries(parsed).map(([section, subjects]) => [
    section,
    uniqueTextList(subjects),
  ]));
}

function getSubjectsForSection(sectionSubjects, section) {
  const key = Object.keys(sectionSubjects).find((storedSection) =>
    storedSection.toLocaleLowerCase() === section.toLocaleLowerCase());
  return key ? sectionSubjects[key] : [];
}

function serializeSectionGrades(sectionGrades) {
  return Object.fromEntries(Array.from(sectionGrades.values(), ({ section, grade }) => [section, grade]));
}

function getUserSheet(workbook) {
  const sheet = workbook.getWorksheet("Users");
  if (!sheet) throw new Error('The workbook is missing the "Users" sheet.');
  const headers = headerColumns(sheet);
  const passwordColumn = [...headers].find(([name]) => name.startsWith("password"))?.[1];
  if (!passwordColumn) throw new Error('The workbook is missing the "Password" column.');
  return {
    sheet,
    columns: {
      id: getColumn(headers, "User ID"),
      role: getColumn(headers, "Role"),
      name: getColumn(headers, "Full Name", ["Name"]),
      email: getColumn(headers, "Email"),
      password: passwordColumn,
      classId: getColumn(headers, "Class ID"),
      status: getColumn(headers, "Status"),
      adminAccess: ensureColumn(sheet, headers, "Admin Access"),
      mustChangePassword: ensureColumn(sheet, headers, "Must Change Password"),
      created: getColumn(headers, "Created", ["Created At", "CreatedAt"]),
      signIns: ensureColumn(sheet, headers, "Sign-ins"),
      lastSignIn: ensureColumn(sheet, headers, "Last sign-in"),
      emailCheck: ensureColumn(sheet, headers, "Email check"),
    },
  };
}

function setPasswordDocumentation(workbook, passwordColumn) {
  const usersSheet = workbook.getWorksheet("Users");
  usersSheet.getRow(1).getCell(passwordColumn).value = "Password hash";
  const readme = workbook.getWorksheet("README");
  if (readme && readme.getCell("A24").value) {
    readme.getCell("A24").value =
      "Administrator passwords are stored as bcrypt hashes with cost 12. Existing teacher and parent passwords use PBKDF2-SHA-256.";
  }
}

function findUser(sheet, columns, email) {
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (cellText(row.getCell(columns.email).value).toLowerCase() === email) {
      return row;
    }
  }
  return null;
}

function getClassSheet(workbook) {
  const sheet = workbook.getWorksheet("Classes");
  if (!sheet) throw new Error('The workbook is missing the "Classes" sheet.');
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      id: getColumn(headers, "Class ID"),
      classroom: ensureColumn(sheet, headers, "Classroom number"),
      code: getColumn(headers, "Class code (parents enter this)", ["Parent Join Code"]),
      teacherId: getColumn(headers, "Teacher User ID", ["Teacher ID"]),
      teacherName: getColumn(headers, "Teacher name"),
      students: ensureColumn(sheet, headers, "Students"),
      parents: ensureColumn(sheet, headers, "Parents signed up"),
      grade: ensureColumn(sheet, headers, "Grade"),
      strand: ensureColumn(sheet, headers, "Strand"),
      section: ensureColumn(sheet, headers, "Section"),
      schoolYear: ensureColumn(sheet, headers, "School Year"),
      schoolName: ensureColumn(sheet, headers, "Name of School"),
      schoolId: ensureColumn(sheet, headers, "School ID"),
      region: ensureColumn(sheet, headers, "Region"),
      division: ensureColumn(sheet, headers, "Division"),
      district: ensureColumn(sheet, headers, "District"),
      position: ensureColumn(sheet, headers, "Teacher Position"),
      schoolHead: ensureColumn(sheet, headers, "School Head"),
      schoolHeadPosition: ensureColumn(sheet, headers, "School Head Position"),
      sectionsHandled: ensureColumn(sheet, headers, "Sections Handled"),
      sectionGrades: ensureColumn(sheet, headers, "Section Grades"),
      subjectsHandled: ensureColumn(sheet, headers, "Subjects Handled"),
    },
  };
}

function getProfilePhotoFormat(buffer, imageLabel = "profile picture") {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png", contentType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", contentType: "image/jpeg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF"
    && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { extension: "webp", contentType: "image/webp" };
  }
  throw new HttpError(400, `Upload a valid JPEG, PNG, or WebP ${imageLabel}.`);
}

function getStudentSheet(workbook) {
  const sheet = workbook.getWorksheet("Students");
  if (!sheet) throw new Error('The workbook is missing the "Students" sheet.');
  const headers = headerColumns(sheet);
  const required = {
    id: getColumn(headers, "Student ID"),
    name: ensureColumn(sheet, headers, "Student name"),
    classId: getColumn(headers, "Class ID"),
    parentUserId: ensureColumn(sheet, headers, "Parent User ID"),
  };
  const columns = { ...required };

  for (const [key, label] of STUDENT_FIELDS) {
    const normalizedLabel = label.toLowerCase();
    let column = headers.get(normalizeHeader(label));
    if (!column && key === "teacherUserId") {
      column = headers.get(normalizeHeader("Teacher ID"));
    }
    if (!column) {
      column = ensureColumn(sheet, headers, label);
    }
    columns[key] = column;
  }
  columns.nutritionWeightKg = ensureColumn(sheet, headers, "Nutritional Status Weight (kg)");
  columns.nutritionHeightM = ensureColumn(sheet, headers, "Nutritional Status Height (m)");
  columns.nutritionMeasurementDate = ensureColumn(sheet, headers, "Nutritional Status Measurement Date");
  columns.section = ensureColumn(sheet, headers, "Section");

  return { sheet, columns };
}

function getHandledSections(classRow, classColumns) {
  return uniqueTextList([
    ...readStoredStringList(classRow.getCell(classColumns.sectionsHandled).value, "sections handled"),
    cellText(classRow.getCell(classColumns.section).value),
  ]);
}

function getSectionGrades(classRow, classColumns) {
  const sectionGrades = readStoredSectionGrades(classRow.getCell(classColumns.sectionGrades).value);
  const primarySection = cellText(classRow.getCell(classColumns.section).value);
  const classGrade = cellText(classRow.getCell(classColumns.grade).value);
  if (primarySection && classGrade && !sectionGrades.has(primarySection.toLocaleLowerCase())) {
    sectionGrades.set(primarySection.toLocaleLowerCase(), { section: primarySection, grade: classGrade });
  }
  return serializeSectionGrades(sectionGrades);
}

function matchesStudentSection(student, sectionFilter) {
  if (!sectionFilter || sectionFilter === "__all__") return true;
  const section = cellText(student.section);
  if (sectionFilter === "__unassigned__") return !section;
  return section.toLocaleLowerCase() === sectionFilter.toLocaleLowerCase();
}

function findTeacherClassRow(classSheet, classColumns, session) {
  for (let rowNumber = 2; rowNumber <= classSheet.rowCount; rowNumber += 1) {
    const row = classSheet.getRow(rowNumber);
    if (cellText(row.getCell(classColumns.id).value) === session.classId
      && cellText(row.getCell(classColumns.teacherId).value) === session.userId) return row;
  }
  return null;
}

function getTeacherClassGrade(workbook, session) {
  const { sheet, columns } = getClassSheet(workbook);
  const classRow = findTeacherClassRow(sheet, columns, session);
  if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
  return cellText(classRow.getCell(columns.grade).value);
}

function getTeacherClassStrand(workbook, session) {
  const { sheet, columns } = getClassSheet(workbook);
  const classRow = findTeacherClassRow(sheet, columns, session);
  if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
  return cellText(classRow.getCell(columns.strand).value);
}

function getOwnedStudents(sheet, columns, session) {
  const students = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const ownerId = cellText(row.getCell(columns.teacherUserId).value);
    if (cellText(row.getCell(columns.classId).value) !== session.classId
      || (ownerId && ownerId !== session.userId)) continue;

    const student = {
      id: cellText(row.getCell(columns.id).value),
      name: cellText(row.getCell(columns.name).value),
      parentUserId: cellText(row.getCell(columns.parentUserId).value),
    };
    if (!student.id || !student.name) continue;
    for (const [key] of STUDENT_FIELDS) {
      if (key === "teacherUserId") continue;
      const value = row.getCell(columns[key]).value;
      student[key] = key === "birthdate" && value instanceof Date
        ? value.toISOString().slice(0, 10)
        : cellText(value);
    }
    student.section = cellText(row.getCell(columns.section).value);
    const weightKg = Number(row.getCell(columns.nutritionWeightKg).value);
    const heightM = Number(row.getCell(columns.nutritionHeightM).value);
    const measurementDate = row.getCell(columns.nutritionMeasurementDate).value;
    student.weightKg = Number.isFinite(weightKg) && weightKg > 0 ? weightKg : "";
    student.heightM = Number.isFinite(heightM) && heightM > 0 ? heightM : "";
    student.measurementDate = measurementDate instanceof Date
      ? measurementDate.toISOString().slice(0, 10)
      : cellText(measurementDate);
    const heightSquaredM2 = student.heightM ? student.heightM ** 2 : null;
    student.heightSquaredM2 = heightSquaredM2 === null
      ? null
      : Math.round(heightSquaredM2 * 10000) / 10000;
    student.bmi = student.weightKg && heightSquaredM2
      ? Math.round((student.weightKg / heightSquaredM2) * 100) / 100
      : null;
    Object.assign(student, calculateBmiForAge({
      birthdate: student.birthdate,
      gender: student.gender,
      measurementDate: student.measurementDate,
      weightKg: student.weightKg,
      heightM: student.heightM,
    }));
    students.push(student);
  }
  return students;
}

function getGradeSheet(workbook) {
  let sheet = workbook.getWorksheet("Term Grades");
  if (!sheet) {
    sheet = workbook.addWorksheet("Term Grades");
    sheet.addRow([
      "Grade ID",
      "Student ID",
      "Class ID",
      "Teacher User ID",
      "Term",
      "Subject",
      "Grade",
      "Updated",
    ]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      id: getColumn(headers, "Grade ID"),
      studentId: getColumn(headers, "Student ID"),
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID", ["Teacher ID"]),
      term: getColumn(headers, "Term"),
      subject: getColumn(headers, "Subject", ["Subject Key"]),
      grade: getColumn(headers, "Grade"),
      source: ensureColumn(sheet, headers, "Source"),
      teacherComment: ensureColumn(sheet, headers, "Teacher's Comment"),
      updated: getColumn(headers, "Updated", ["Updated At"]),
    },
  };
}

function getGradeLockSheet(workbook) {
  let sheet = workbook.getWorksheet("Term Grade Locks");
  if (!sheet) {
    sheet = workbook.addWorksheet("Term Grade Locks");
    sheet.addRow(["Class ID", "Teacher User ID", "Term", "Student ID", "Locked", "Updated"]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID"),
      term: getColumn(headers, "Term"),
      studentId: ensureColumn(sheet, headers, "Student ID"),
      locked: getColumn(headers, "Locked"),
      updated: getColumn(headers, "Updated"),
    },
  };
}

function getEClassRecordSheet(workbook) {
  let sheet = workbook.getWorksheet("E-Class Records");
  if (!sheet) {
    sheet = workbook.addWorksheet("E-Class Records");
    sheet.addRow([
      "Class ID",
      "Teacher User ID",
      "Term",
      "Subject",
      "MAPEH Group",
      "Section",
      "Scores",
      "Highest Scores",
      "Grades",
      "Locked",
      "Updated",
    ]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID"),
      term: getColumn(headers, "Term"),
      subject: getColumn(headers, "Subject"),
      mapehGroup: getColumn(headers, "MAPEH Group"),
      section: getColumn(headers, "Section"),
      scores: getColumn(headers, "Scores"),
      highestScores: getColumn(headers, "Highest Scores"),
      grades: getColumn(headers, "Grades"),
      locked: getColumn(headers, "Locked"),
      updated: getColumn(headers, "Updated"),
    },
  };
}

function getReadingAssessmentSheet(workbook) {
  let sheet = workbook.getWorksheet("Reading Assessments");
  if (!sheet) {
    sheet = workbook.addWorksheet("Reading Assessments");
    sheet.addRow([
      "Assessment ID",
      "Student ID",
      "Class ID",
      "Teacher User ID",
      "Assessment Period",
      "Language",
      "Reading Level",
      "Assessed Date",
      "Updated",
    ]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      id: getColumn(headers, "Assessment ID"),
      studentId: getColumn(headers, "Student ID"),
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID"),
      period: getColumn(headers, "Assessment Period"),
      language: getColumn(headers, "Language"),
      level: getColumn(headers, "Reading Level"),
      assessed: getColumn(headers, "Assessed Date"),
      attempt: ensureColumn(sheet, headers, "Attempt Number"),
      updated: getColumn(headers, "Updated"),
    },
  };
}

function getPhilIriAssessmentSheet(workbook) {
  let sheet = workbook.getWorksheet("PHIL-IRI Assessments");
  if (!sheet) {
    sheet = workbook.addWorksheet("PHIL-IRI Assessments");
    sheet.addRow([
      "Assessment ID", "Student ID", "Class ID", "Teacher User ID", "Assessment Period",
      "Assessment Type", "Language", "Reading Level", "Assessed Date", "Assessment Data JSON", "Updated",
    ]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      id: getColumn(headers, "Assessment ID"),
      studentId: getColumn(headers, "Student ID"),
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID"),
      period: getColumn(headers, "Assessment Period"),
      assessmentType: getColumn(headers, "Assessment Type"),
      language: getColumn(headers, "Language"),
      level: getColumn(headers, "Reading Level"),
      assessed: getColumn(headers, "Assessed Date"),
      data: getColumn(headers, "Assessment Data JSON"),
      updated: getColumn(headers, "Updated"),
    },
  };
}

function getPhilIriCutoffSheet(workbook) {
  let sheet = workbook.getWorksheet("PHIL-IRI GST Cutoffs");
  if (!sheet) {
    sheet = workbook.addWorksheet("PHIL-IRI GST Cutoffs");
    sheet.addRow(["Class ID", "Teacher User ID", "Grade", "Language", "Passing Score", "Updated"]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID"),
      grade: getColumn(headers, "Grade"),
      language: getColumn(headers, "Language"),
      passingScore: getColumn(headers, "Passing Score"),
      updated: getColumn(headers, "Updated"),
    },
  };
}

function getMathAssessmentSheet(workbook) {
  let sheet = workbook.getWorksheet("Math Assessments");
  if (!sheet) {
    sheet = workbook.addWorksheet("Math Assessments");
    sheet.addRow([
      "Assessment ID",
      "Student ID",
      "Class ID",
      "Teacher User ID",
      "Assessment Period",
      "Raw Score",
      "Total Items",
      "Assessed Date",
      "Identified Strengths",
      "Areas for Improvement",
      "Recommended Intervention",
      "Updated",
    ]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  const gradeLevel = ensureColumn(sheet, headers, "Grade Level");
  const itemResponses = ensureColumn(sheet, headers, "Item Responses");
  const remarks = ensureColumn(sheet, headers, "Remarks");
  return {
    sheet,
    columns: {
      id: getColumn(headers, "Assessment ID"),
      studentId: getColumn(headers, "Student ID"),
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID"),
      period: getColumn(headers, "Assessment Period"),
      rawScore: getColumn(headers, "Raw Score"),
      totalItems: getColumn(headers, "Total Items"),
      assessed: getColumn(headers, "Assessed Date"),
      strengths: getColumn(headers, "Identified Strengths"),
      areas: getColumn(headers, "Areas for Improvement"),
      intervention: getColumn(headers, "Recommended Intervention"),
      updated: getColumn(headers, "Updated"),
      gradeLevel,
      itemResponses,
      remarks,
    },
  };
}

function getAttendanceSheet(workbook) {
  let sheet = workbook.getWorksheet("Attendance Records");
  if (!sheet) {
    const legacySheet = workbook.getWorksheet("Attendance");
    const legacyHeaders = legacySheet ? headerColumns(legacySheet) : new Map();
    if (legacySheet && legacyHeaders.has(normalizeHeader("Attendance ID"))) {
      legacySheet.name = "Attendance Records";
      sheet = legacySheet;
    }
  }
  if (!sheet) {
    sheet = workbook.addWorksheet("Attendance Records");
    sheet.addRow([
      "Attendance ID",
      "Student ID",
      "Class ID",
      "Teacher User ID",
      "Attendance Date",
      "Status",
      "Reason",
      "Updated",
      "Attendance Key",
    ]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      id: getColumn(headers, "Attendance ID"),
      studentId: getColumn(headers, "Student ID"),
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID"),
      date: getColumn(headers, "Attendance Date"),
      status: getColumn(headers, "Status"),
      reason: ensureColumn(sheet, headers, "Reason"),
      updated: getColumn(headers, "Updated"),
      key: ensureColumn(sheet, headers, "Attendance Key"),
    },
  };
}

function getAttendanceNotesSheet(workbook) {
  let sheet = workbook.getWorksheet("Attendance Monthly Notes");
  if (!sheet) {
    sheet = workbook.addWorksheet("Attendance Monthly Notes");
    sheet.addRow([
      "Note ID",
      "Student ID",
      "Class ID",
      "Teacher User ID",
      "Month",
      "Remarks",
      "Updated",
      "Attendance Key",
    ]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      id: getColumn(headers, "Note ID"),
      studentId: getColumn(headers, "Student ID"),
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID"),
      month: getColumn(headers, "Month"),
      remarks: getColumn(headers, "Remarks"),
      statusDate: ensureColumn(sheet, headers, "Status Date"),
      updated: getColumn(headers, "Updated"),
      key: ensureColumn(sheet, headers, "Attendance Key"),
    },
  };
}

function getAttendanceCalendarSheet(workbook) {
  let sheet = workbook.getWorksheet("Attendance Calendar");
  if (!sheet) {
    sheet = workbook.addWorksheet("Attendance Calendar");
    sheet.addRow([
      "Calendar ID",
      "Class ID",
      "Teacher User ID",
      "Attendance Date",
      "Day Type",
      "Updated",
      "Calendar Key",
      "Reason",
    ]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      id: getColumn(headers, "Calendar ID"),
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID"),
      date: getColumn(headers, "Attendance Date"),
      dayType: getColumn(headers, "Day Type"),
      updated: getColumn(headers, "Updated"),
      key: getColumn(headers, "Calendar Key"),
      reason: ensureColumn(sheet, headers, "Reason"),
    },
  };
}

const MAX_NO_CLASS_REASON_LENGTH = 80;

function findClass(workbook, role, value) {
  const { sheet, columns } = getClassSheet(workbook);
  const lookupColumn = role === "teacher" ? columns.classroom : columns.code;

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (cellText(row.getCell(lookupColumn).value).toLowerCase() === value.toLowerCase()) {
      return {
        row,
        id: cellText(row.getCell(columns.id).value),
        code: cellText(row.getCell(columns.code).value),
        columns,
      };
    }
  }

  if (role === "teacher") return null;
  throw new HttpError(400, "That class code is not registered yet. Ask your teacher to sign up first and share the class code.");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await pbkdf2(password, salt, PASSWORD_ITERATIONS, PASSWORD_BYTES, "sha256");
  return `pbkdf2$${PASSWORD_ITERATIONS}$${salt.toString("base64")}$${derivedKey.toString("base64")}`;
}

async function hashAdminPassword(password) {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password, storedPassword) {
  const bcryptHash = storedPassword.match(/^\$2[aby]\$(\d{2})\$/);
  if (bcryptHash) {
    const cost = Number(bcryptHash[1]);
    return cost >= 12 && cost <= 15 ? bcrypt.compare(password, storedPassword) : false;
  }
  const [, iterationsText, saltText, keyText] = storedPassword.split("$");
  if (!storedPassword.startsWith("pbkdf2$")) return false;
  const iterations = Number(iterationsText);
  if (!Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000) return false;

  const salt = Buffer.from(saltText || "", "base64");
  const expected = Buffer.from(keyText || "", "base64");
  if (salt.length !== 16 || expected.length !== PASSWORD_BYTES) return false;

  const actual = await pbkdf2(password, salt, iterations, expected.length, "sha256");
  return crypto.timingSafeEqual(actual, expected);
}

function nextUserId(sheet, idColumn, role) {
  const prefix = role === "teacher" ? "T" : "P";
  let highest = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const id = cellText(sheet.getRow(rowNumber).getCell(idColumn).value);
    const match = id.match(new RegExp(`^${prefix}(\\d+)$`, "i"));
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}${String(highest + 1).padStart(3, "0")}`;
}

function nextClassId(sheet, idColumn) {
  let highest = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const id = cellText(sheet.getRow(rowNumber).getCell(idColumn).value);
    const match = id.match(/^C(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `C${String(highest + 1).padStart(3, "0")}`;
}

function nextStudentId(sheet, idColumn) {
  let highest = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const id = cellText(sheet.getRow(rowNumber).getCell(idColumn).value);
    const match = id.match(/^S(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `S${String(highest + 1).padStart(3, "0")}`;
}

function nextGradeId(sheet, idColumn) {
  let highest = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const id = cellText(sheet.getRow(rowNumber).getCell(idColumn).value);
    const match = id.match(/^G(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `G${String(highest + 1).padStart(5, "0")}`;
}

function nextReadingAssessmentId(sheet, idColumn) {
  let highest = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const id = cellText(sheet.getRow(rowNumber).getCell(idColumn).value);
    const match = id.match(/^R(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `R${String(highest + 1).padStart(5, "0")}`;
}

function nextMathAssessmentId(sheet, idColumn) {
  let highest = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const id = cellText(sheet.getRow(rowNumber).getCell(idColumn).value);
    const match = id.match(/^M(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `M${String(highest + 1).padStart(5, "0")}`;
}

function createTeacherClass(workbook, classroomNumber, teacherId, teacherName, gradeLevel, strand) {
  const { sheet, columns } = getClassSheet(workbook);
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const existing = sheet.getRow(rowNumber);
    if (cellText(existing.getCell(columns.classroom).value).toLowerCase() === classroomNumber.toLowerCase()) {
      throw new HttpError(409, "That classroom number is already registered. Ask your teacher for the class code.");
    }
  }

  let code;
  do {
    code = `G5-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  } while (Array.from({ length: Math.max(0, sheet.rowCount - 1) }, (_, index) =>
    cellText(sheet.getRow(index + 2).getCell(columns.code).value).toLowerCase(),
  ).includes(code.toLowerCase()));

  const classId = nextClassId(sheet, columns.id);
  const values = [];
  values[columns.id] = classId;
  values[columns.classroom] = classroomNumber;
  values[columns.code] = code;
  values[columns.teacherId] = teacherId;
  values[columns.teacherName] = teacherName;
  values[columns.grade] = gradeLevel;
  values[columns.strand] = strand || null;
  values[columns.students] = 0;
  values[columns.parents] = 0;
  writeRow(sheet, [columns.id, columns.classroom, columns.code], values);
  return { id: classId, code };
}

function incrementCell(cell) {
  if (
    cell.value
    && typeof cell.value === "object"
    && ("formula" in cell.value || "sharedFormula" in cell.value)
  ) return;
  const value = cell.value;
  const current = typeof value === "object" && value !== null && "result" in value
    ? Number(value.result)
    : Number(value);
  cell.value = (Number.isFinite(current) ? current : 0) + 1;
}

function firstAvailableRow(sheet, keyColumns) {
  for (let rowNumber = 2; rowNumber <= sheet.rowCount + 1; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (keyColumns.every((column) => !cellText(row.getCell(column).value))) return row;
  }
  throw new Error(`The "${sheet.name}" sheet has no empty rows available.`);
}

function writeRow(sheet, keyColumns, values) {
  const row = firstAvailableRow(sheet, keyColumns);
  for (const [column, value] of Object.entries(values)) {
    row.getCell(Number(column)).value = value;
  }
  return row;
}

function logSignIn(workbook, entry) {
  const sheet = workbook.getWorksheet("SignInLog");
  if (!sheet) throw new Error('The workbook is missing the "SignInLog" sheet.');
  const headers = headerColumns(sheet);
  const values = [];
  values[getColumn(headers, "Timestamp")] = new Date();
  values[getColumn(headers, "Email")] = entry.email;
  values[getColumn(headers, "Role chosen", ["Role"])] = entry.role === "teacher" ? "Teacher" : "Parent";
  values[getColumn(headers, "Result", ["Success"])] = entry.result;
  values[getColumn(headers, "User ID")] = entry.userId || "";
  values[getColumn(headers, "Note", ["User Agent"])] = entry.note;
  writeRow(
    sheet,
    [getColumn(headers, "Timestamp"), getColumn(headers, "Email")],
    values,
  );
}

function getClassCode(workbook, classId) {
  const { sheet, columns } = getClassSheet(workbook);
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (cellText(row.getCell(columns.id).value) === classId) {
      return cellText(row.getCell(columns.code).value);
    }
  }
  return "";
}

function encodeWorkbookState(workbook) {
  return gzipSync(Buffer.from(JSON.stringify(workbook.model)));
}

function decodeWorkbookState(compressedState) {
  const model = JSON.parse(gunzipSync(compressedState).toString("utf8"));
  for (const sheet of model.worksheets || []) {
    for (const row of sheet.rows || []) {
      for (const cell of row.cells || []) {
        if (cell.type === ExcelJS.ValueType.Date && typeof cell.value === "string") {
          cell.value = new Date(cell.value);
        }
      }
    }
  }
  const workbook = new ExcelJS.Workbook();
  workbook.model = model;
  return workbook;
}

function openPortalDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 30000;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS portal_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        workbook_state BLOB NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portal_sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        remote_revision INTEGER NOT NULL DEFAULT 0,
        pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
        conflict INTEGER NOT NULL DEFAULT 0 CHECK (conflict IN (0, 1)),
        conflict_local_state BLOB,
        conflict_remote_state BLOB,
        conflict_remote_revision INTEGER,
        last_sync_at TEXT,
        last_sync_error TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function readPortalDatabaseWorkbook(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const result = database.prepare(
      "SELECT workbook_state FROM portal_state WHERE id = 1",
    ).get();
    if (!result) throw new Error(`The SQLite database ${path.basename(databasePath)} has not been initialized.`);
    return decodeWorkbookState(result.workbook_state);
  } finally {
    database.close();
  }
}

function writePortalDatabaseWorkbook(databasePath, workbook) {
  const database = new DatabaseSync(databasePath);
  try {
    const result = database.prepare(
      "UPDATE portal_state SET workbook_state = ?, updated_at = ? WHERE id = 1",
    ).run(encodeWorkbookState(workbook), new Date().toISOString());
    if (result.changes !== 1) throw new Error("The SQLite portal database has not been initialized.");
  } finally {
    database.close();
  }
}

async function readJson(request, maxBytes = 16384) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new HttpError(413, "The request is too large.");
    }
  }

  try {
    const data = JSON.parse(body);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid body.");
    return data;
  } catch {
    throw new HttpError(400, "Enter valid account information.");
  }
}

function normalizeTosCompetency(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[\s•\-–—]+|[\s•\-–—]+$/g, "")
    .trim();
}

function extractTosCompetenciesFromRows(rows) {
  const normalizedRows = rows.map((row) => row.map(normalizeTosCompetency));
  const headerIndex = normalizedRows.findIndex((row) =>
    row.some((cell) => /learning\s+competenc|competenc(y|ies)/i.test(cell)),
  );
  if (headerIndex < 0) return [];
  const header = normalizedRows[headerIndex];
  const competencyColumn = header.findIndex((cell) => /learning\s+competenc|competenc(y|ies)/i.test(cell));
  const values = [];
  for (const row of normalizedRows.slice(headerIndex + 1)) {
    const value = normalizeTosCompetency(row[competencyColumn]);
    if (value && !/^(learning\s+)?competenc(y|ies)$/i.test(value)) values.push(value);
  }
  return values;
}

async function extractTosCompetencies(buffer, fileName) {
  const extension = path.extname(fileName || "").toLowerCase();
  if (extension === ".xls" || extension === ".xlsx") {
    const workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
    const competencies = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      competencies.push(...extractTosCompetenciesFromRows(XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: "",
      })));
    }
    return [...new Set(competencies)];
  }
  if (extension === ".doc" || extension === ".docx") {
    if (extension === ".doc") {
      throw new HttpError(400, "Legacy .doc files are not supported for competency extraction. Save the TOS as .docx and import it again.");
    }
    const archive = await JSZip.loadAsync(buffer);
    const documentFile = archive.file("word/document.xml");
    if (!documentFile) throw new HttpError(400, "The Word TOS does not contain a readable document.");
    const xml = await documentFile.async("string");
    const rows = [...xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi)].map((match) =>
      [...match[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)].map((text) =>
        normalizeTosCompetency(text[1].replace(/<[^>]+>/g, "")),
      ),
    );
    const competencies = extractTosCompetenciesFromRows(rows);
    if (competencies.length) return [...new Set(competencies)];
    const paragraphs = [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi)].map((match) =>
      normalizeTosCompetency([...match[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi)]
        .map((text) => text[1].replace(/<[^>]+>/g, "")).join(" ")),
    );
    const headerIndex = paragraphs.findIndex((value) => /learning\s+competenc|competenc(y|ies)/i.test(value));
    return [...new Set(headerIndex >= 0
      ? paragraphs.slice(headerIndex + 1).filter((value) => value && !/^(learning\s+)?competenc(y|ies)$/i.test(value))
      : [])];
  }
  throw new HttpError(400, "Import a TOS in .docx, .xlsx, or .xls format.");
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

async function readProfilePhoto(request, imageLabel = "profile picture") {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_PROFILE_PHOTO_BYTES) {
      throw new HttpError(413, `${imageLabel} must be 2 MB or smaller.`);
    }
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, `Choose a ${imageLabel} to upload.`);
  const buffer = Buffer.concat(chunks);
  const format = getProfilePhotoFormat(buffer, imageLabel);
  const declaredType = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (declaredType !== format.contentType) {
    throw new HttpError(400, `The selected ${imageLabel} does not match its file type.`);
  }
  return { buffer, ...format };
}

function validateAccount(data, registration) {
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  const password = typeof data.password === "string" ? data.password : "";
  const role = data.role;
  const extra = typeof data.extra === "string" ? data.extra.trim() : "";
  const grade = typeof data.grade === "string" ? data.grade.trim() : "";
  const strand = typeof data.strand === "string" ? data.strand.trim() : "";

  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    throw new HttpError(400, "Enter a valid email address.");
  }
  if (password.length < 6 || password.length > 256) {
    throw new HttpError(400, "Use a password between 6 and 256 characters.");
  }
  if (role !== "teacher" && role !== "parent") {
    throw new HttpError(400, "Choose Teacher or Parent.");
  }
  if (registration && (!name || name.length > 120)) {
    throw new HttpError(400, "Enter your name.");
  }
  if (registration && extra.length > 100) {
    throw new HttpError(400, "Class information must be 100 characters or fewer.");
  }
  if (registration && role === "parent" && !extra) {
    throw new HttpError(400, "Enter your name and parent class code.");
  }
  if (registration && role === "teacher" && !VALID_GRADES.includes(grade)) {
    throw new HttpError(400, "Choose a valid grade level from Grade 1 through Grade 12.");
  }
  if (registration && role === "teacher" && /^Grade (11|12)$/.test(grade)
    && !VALID_SHS_STRANDS.includes(strand)) {
    throw new HttpError(400, "Choose a valid strand for Grade 11 or Grade 12.");
  }
  if (strand && !VALID_SHS_STRANDS.includes(strand)) {
    throw new HttpError(400, "Choose a valid Senior High School strand.");
  }

  return { name, email, password, role, extra, grade, strand };
}

function validateStudent(data) {
  const student = {};
  for (const [key, label] of STUDENT_FIELDS) {
    if (key === "teacherUserId") continue;
    const value = data[key];
    student[key] = typeof value === "string" ? value.trim() : "";
    if (student[key].length > 200) throw new HttpError(400, `${label} must be 200 characters or fewer.`);
  }

  if (!/^\d{12}$/.test(student.lrn)) {
    throw new HttpError(400, "Enter the learner's 12-digit LRN.");
  }
  if (!student.lastName || !student.firstName) {
    throw new HttpError(400, "Enter the learner's first and last name.");
  }
  if (!["Male", "Female"].includes(student.gender)) {
    throw new HttpError(400, "Choose Male or Female for gender.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(student.birthdate)) {
    throw new HttpError(400, "Enter a valid birthdate.");
  }
  const birthdate = new Date(`${student.birthdate}T00:00:00.000Z`);
  if (Number.isNaN(birthdate.getTime()) || birthdate.toISOString().slice(0, 10) !== student.birthdate) {
    throw new HttpError(400, "Enter a valid birthdate.");
  }
  if (birthdate > new Date(new Date().toISOString().slice(0, 10))) {
    throw new HttpError(400, "Birthdate cannot be in the future.");
  }

  return { ...student, birthdate };
}

function validateGradeTerm(value) {
  if (!GRADE_TERMS.includes(value)) {
    throw new HttpError(400, "Choose a valid term (Term 1 through Term 3).");
  }
  return value;
}

function validateStudentGrades(data, subjectDefinitions = ALL_SUBJECT_DEFINITIONS) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new HttpError(400, "Enter grades for the selected student.");
  }
  const allowedSubjects = new Set(subjectDefinitions.map(([key]) => key));
  if (Object.keys(data).some((key) =>
    ALL_SUBJECT_DEFINITIONS.some(([knownKey]) => knownKey === key) && !allowedSubjects.has(key))) {
    throw new HttpError(400, "This grade level does not include one or more selected subjects.");
  }
  const grades = {};
  for (const [key, label] of subjectDefinitions) {
    const value = data[key];
    if (value === "" || value === null || value === undefined) {
      grades[key] = null;
      continue;
    }
    const grade = typeof value === "number" ? value
      : typeof value === "string" && value.trim() ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(grade) || grade < 0 || grade > 100) {
      throw new HttpError(400, `${label} grade must be a number from 0 to 100.`);
    }
    grades[key] = Math.round(grade * 100) / 100;
  }
  return grades;
}

function findOwnedStudent(sheet, columns, session, studentId) {
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (
      cellText(row.getCell(columns.id).value) === studentId
      && cellText(row.getCell(columns.classId).value) === session.classId
      && (!cellText(row.getCell(columns.teacherUserId).value)
        || cellText(row.getCell(columns.teacherUserId).value) === session.userId)
    ) {
      return row;
    }
  }
  throw new HttpError(404, "That student is not in your class roster.");
}

function sf1CellText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function parseSF1Birthdate(value) {
  let year;
  let month;
  let day;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    year = value.getUTCFullYear();
    month = value.getUTCMonth() + 1;
    day = value.getUTCDate();
  } else if (typeof value === "number") {
    const excelDate = XLSX.SSF.parse_date_code(value);
    if (!excelDate) return "";
    ({ y: year, m: month, d: day } = excelDate);
  } else {
    const dateText = sf1CellText(value);
    let parts = dateText.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (parts) {
      [, year, month, day] = parts;
    } else {
      parts = dateText.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
      if (!parts) return "";
      [, month, day, year] = parts;
    }
    year = Number(year);
    month = Number(month);
    day = Number(day);
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    ? ""
    : date.toISOString().slice(0, 10);
}

function parseSF1Workbook(buffer) {
  const isLegacyExcel = buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const isOpenXmlExcel = buffer.length >= 4
    && buffer[0] === 0x50
    && buffer[1] === 0x4b
    && ((buffer[2] === 0x03 && buffer[3] === 0x04)
      || (buffer[2] === 0x05 && buffer[3] === 0x06)
      || (buffer[2] === 0x07 && buffer[3] === 0x08));
  if (!isLegacyExcel && !isOpenXmlExcel) {
    throw new HttpError(400, "The selected file is not a supported Excel workbook. Choose an Excel SF1 file.");
  }
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, dense: true });
  } catch {
    throw new HttpError(400, "The selected file could not be read. Choose a valid SF1 .xls or .xlsx file.");
  }

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: "",
    });
    if (rows.length > 5000) {
      throw new HttpError(400, "The SF1 sheet has too many rows to import.");
    }

    const headerIndex = rows.slice(0, 30).findIndex((row) =>
      sf1CellText(row[0]).toLowerCase() === "lrn"
      && sf1CellText(row[2]).toLowerCase().startsWith("name")
      && sf1CellText(row[6]).toLowerCase().includes("sex")
      && sf1CellText(row[7]).toLowerCase().includes("birth"),
    );
    if (headerIndex < 0) continue;

    const readHeaderValue = (pattern, scanDistance) => {
      for (let rowIndex = 0; rowIndex < headerIndex; rowIndex += 1) {
        const row = rows[rowIndex];
        for (let column = 0; column < row.length; column += 1) {
          const text = sf1CellText(row[column]);
          const match = text.match(pattern);
          if (!match) continue;
          const inlineValue = match[1] && match[1].trim();
          if (inlineValue) return inlineValue;
          for (let nextColumn = column + 1; nextColumn < Math.min(row.length, column + scanDistance + 1); nextColumn += 1) {
            const candidate = sf1CellText(row[nextColumn]);
            if (!candidate) continue;
            if (/^(?:school id|school name|school year|grade level|section|division|district)\b/i.test(candidate)) break;
            return candidate;
          }
        }
      }
      return "";
    };
    const sectionName = readHeaderValue(/section(?:\s*[:=-]\s*|\s+)?(.*)$/i, 10);
    const grade = readHeaderValue(/grade\s*level(?:\s*[:=-]\s*|\s+)?(.*)$/i, 10);
    const students = [];
    const skipped = [];
    const addIssue = (rowNumber, reason) => skipped.push({ row: rowNumber, reason });

    for (let index = headerIndex + 1; index < rows.length; index += 1) {
      const row = rows[index];
      const lrnValue = sf1CellText(row[0]).replace(/^'/, "");
      const rawName = sf1CellText(row[2]);
      if (/^<={2,}/.test(rawName) || /^TOTAL\b/i.test(rawName)) continue;
      if (!rawName && !/^\d{1,12}$/.test(lrnValue)) continue;
      if (!lrnValue && !rawName) continue;
      if (students.length + skipped.length >= MAX_SF1_STUDENTS) {
        throw new HttpError(400, `The SF1 file contains more than ${MAX_SF1_STUDENTS} student rows.`);
      }

      const nameParts = rawName.split(",").map((part) => part.trim());
      const genderValue = sf1CellText(row[6]).toLowerCase();
      const address = row.slice(15, 26).map(sf1CellText).filter(Boolean).join(", ");
      const student = {
        lrn: /^\d+$/.test(lrnValue) ? lrnValue.padStart(12, "0") : lrnValue,
        lastName: nameParts.length > 1 ? nameParts[0] : "",
        firstName: nameParts.length > 1 ? nameParts[1] : "",
        middleName: nameParts.slice(2).filter((part) => part !== "-" && part !== "—").join(" "),
        gender: genderValue === "m" ? "Male" : genderValue === "f" ? "Female" : row[6],
        birthdate: parseSF1Birthdate(row[7]),
        motherTongue: sf1CellText(row[11]),
        ethnicities: sf1CellText(row[13]),
        religion: sf1CellText(row[14]),
        currentResidence: address,
        father: sf1CellText(row[27]),
        mothersMaidenName: sf1CellText(row[31]),
        guardianRelationship: sf1CellText(row[40]),
      };

      try {
        students.push({ row: index + 1, student: validateStudent(student) });
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        addIssue(index + 1, error.message);
      }
    }

    return { students, skipped, sectionName, grade };
  }

  throw new HttpError(400, "No SF1 student register was found. Use the SF1 template with LRN, NAME, Sex, and BIRTH DATE columns.");
}

async function readSF1Upload(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_SF1_FILE_BYTES) {
      throw new HttpError(413, "SF1 files must be 10 MB or smaller.");
    }
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, "Choose an SF1 file to import.");
  return Buffer.concat(chunks, size);
}

async function readSF2Upload(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_SF2_FILE_BYTES) {
      throw new HttpError(413, "SF2 files must be 10 MB or smaller.");
    }
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, "Choose an SF2 file to import.");
  const buffer = Buffer.concat(chunks, size);
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new HttpError(400, "Upload the SF2 Excel workbook in .xlsx format.");
  }
  return buffer;
}

function parseEClassWorkbook(buffer, selection) {
  const isExcel = buffer.length >= 4
    && ((buffer[0] === 0x50 && buffer[1] === 0x4b)
      || (buffer.length >= 8 && buffer.subarray(0, 8).equals(
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
      ))));
  if (!isExcel) throw new HttpError(400, "Upload an E-Class Excel workbook in .xlsx or .xls format.");
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: false, dense: true });
  } catch {
    throw new HttpError(400, "The selected E-Class workbook could not be read.");
  }
  const normalize = (value) => String(value || "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  const selectedSubject = normalize(selection.subject);
  const selectedGroup = normalize(selection.mapehGroup);
  let otherTerm = "";
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    const cell = (row, column) => row[column] === null || row[column] === undefined ? "" : row[column];
    const termText = String(cell(rows[1] || [], 1) || "");
    const subjectText = String(cell(rows[9] || [], 26) || "");
    if (!/class\s*record/i.test(termText) && !rows.some((row) =>
      String(cell(row, 1)).toLocaleLowerCase() === "learners' names")) continue;
    const workbookTerm = sheetName.match(/term\s*[123]/i)?.[0] || termText.match(/term\s*[123]/i)?.[0] || "";
    if (workbookTerm && normalize(workbookTerm) !== normalize(selection.term)) {
      otherTerm = otherTerm || workbookTerm;
      continue;
    }
    const workbookSubject = normalize(subjectText);
    const subjectMatches = !workbookSubject || (
      selectedSubject === "mapeh"
        ? workbookSubject.includes(selectedGroup)
        : workbookSubject === selectedSubject
          || (selectedSubject === "epptle" && ["epptle", "epp", "tle"].includes(workbookSubject))
          || (selectedSubject.includes("aralingpanlipunan") && workbookSubject.includes("aralingpanlipunan"))
          || (selectedSubject.includes("gmr") && workbookSubject.includes("goodmanners"))
    );
    if (!subjectMatches) {
      throw new HttpError(400, `The workbook subject "${subjectText || "unknown"}" does not match ${selection.subject}.`);
    }
    const highestRow = rows.findIndex((row) =>
      /highest\s+possible\s+score/i.test(String(cell(row, 1))));
    if (highestRow < 0) throw new HttpError(400, "The workbook has no highest-possible-score row.");
    const writtenHighestScores = [5, 6, 7, 8, 9].map((column) =>
      String(cell(rows[highestRow], column) ?? "").trim());
    const performanceHighestScores = [13, 14, 15].map((column) =>
      String(cell(rows[highestRow], column) ?? "").trim());
    const examHighestScores = [19, 20, 21].map((column) =>
      String(cell(rows[highestRow], column) ?? "").trim());
    const scores = writtenHighestScores.concat(performanceHighestScores, examHighestScores);
    const students = [];
    for (let rowIndex = highestRow + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      const number = Number(cell(row, 1));
      const name = String(cell(row, 2) || "").trim();
      if (!name || !Number.isInteger(number) || number < 1) continue;
      const learnerScores = [5, 6, 7, 8, 9].map((column) => String(cell(row, column) ?? "").trim())
        .concat([13, 14, 15].map((column) => String(cell(row, column) ?? "").trim()))
        .concat([19, 20, 21].map((column) => String(cell(row, column) ?? "").trim()));
      students.push({ row: rowIndex + 1, name, scores: learnerScores });
    }
    if (!students.length) throw new HttpError(400, "No learner records were found in the E-Class workbook.");
    const labelValue = (label) => {
      for (const row of rows.slice(0, highestRow)) {
        for (let column = 0; column < row.length; column += 1) {
          if (normalize(row[column]) !== label) continue;
          for (let next = column + 1; next < row.length; next += 1) {
            if (String(row[next] ?? "").trim()) return String(row[next]).trim();
          }
        }
      }
      return "";
    };
    return {
      term: selection.term,
      subject: selection.subject,
      mapehGroup: selection.mapehGroup,
      grade: labelValue("gradelevel"),
      section: labelValue("section"),
      highestScores: scores,
      students,
    };
  }
  if (otherTerm) throw new HttpError(400, `The workbook has no ${selection.term} sheet (found ${otherTerm}).`);
  throw new HttpError(400, "No E-Class record sheet was found in the workbook.");
}

function createServer(options = {}) {
  const databasePath = options.databasePath || DATABASE_PATH;
  const localDatabaseExistedAtStartup = fileSystem.existsSync(databasePath);
  const migrationWorkbookPath = options.migrationWorkbookPath || MIGRATION_WORKBOOK_PATH;
  const generatedReportsDirectory = options.generatedReportsDirectory || GENERATED_REPORTS_DIRECTORY;
  const appearancePreferencesPath = options.appearancePreferencesPath || null;
  const logFilePath = options.logFilePath || null;
  const tlsKeyPath = options.tlsKeyPath || process.env.PORTAL_TLS_KEY || null;
  const tlsCertPath = options.tlsCertPath || process.env.PORTAL_TLS_CERT || null;
  if ((tlsKeyPath && !tlsCertPath) || (!tlsKeyPath && tlsCertPath)) {
    throw new Error("PORTAL_TLS_KEY and PORTAL_TLS_CERT must be provided together.");
  }
  // Enable only behind a trusted TLS-terminating reverse proxy that sets X-Forwarded-* headers.
  const trustProxy = options.trustProxy ?? process.env.PORTAL_TRUST_PROXY === "true";
  const migrationWorkbookWasSpecified = Boolean(
    options.migrationWorkbookPath || process.env.PORTAL_MIGRATION_WORKBOOK,
  );
  const supabaseDatabaseUrl = options.supabaseDatabaseUrl || process.env.SUPABASE_DB_URL;
  const dualStorage = (options.storageMode || process.env.PORTAL_STORAGE_MODE) === "dual";
  const bootstrapAdminEmail = typeof options.bootstrapAdminEmail === "string"
    ? options.bootstrapAdminEmail.trim().toLowerCase()
    : "";
  const bootstrapAdminPassword = typeof options.bootstrapAdminPassword === "string"
    ? options.bootstrapAdminPassword
    : "";
  if (Boolean(bootstrapAdminEmail) !== Boolean(bootstrapAdminPassword)) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must both be configured to bootstrap an administrator.");
  }
  if (bootstrapAdminEmail
    && (!/^\S+@\S+\.\S+$/.test(bootstrapAdminEmail)
      || bootstrapAdminEmail.length > 254
      || bootstrapAdminPassword.length < 6
      || bootstrapAdminPassword.length > 256)) {
    throw new Error("The configured bootstrap administrator credentials are invalid.");
  }
  const postgresConnectionUrl = supabaseDatabaseUrl ? new URL(supabaseDatabaseUrl) : null;
  if (postgresConnectionUrl) {
    for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
      postgresConnectionUrl.searchParams.delete(parameter);
    }
  }
  const postgresPool = options.postgresPool || (supabaseDatabaseUrl
    ? new Pool({
      connectionString: postgresConnectionUrl.toString(),
      ssl: { rejectUnauthorized: true },
      max: 10,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
    })
    : null);
  if (dualStorage && !postgresPool) {
    throw new Error("PORTAL_STORAGE_MODE=dual requires SUPABASE_DB_URL.");
  }
  const storage = dualStorage ? "dual" : postgresPool ? "supabase" : "sqlite";
  const transactionContext = new AsyncLocalStorage();
  const profilePhotoDirectories = databasePath === DEFAULT_DATABASE_PATH
    ? [
      `${databasePath}.profiles`,
      `${APPLICATION_WORKBOOK_PATH}.profiles`,
      `${DOWNLOADS_DATABASE_PATH}.profiles`,
      `${LEGACY_DATABASE_PATH}.profiles`,
    ]
    : [`${databasePath}.profiles`];
  const profilePhotoDirectory = profilePhotoDirectories.find((directory) =>
    fileSystem.existsSync(directory)) || profilePhotoDirectories[0];
  const schoolLogoDirectory = `${profilePhotoDirectory}.school-logos`;
  let workbookQueue = Promise.resolve();
  const sessions = new Map();
  const authRateLimiter = options.authRateLimiter || createAuthRateLimiter();
  let database = null;
  let databaseInitialization = null;
  let bootstrapAdminInitialization = null;
  let remoteInitialization = null;
  let appearanceTheme = null;
  let syncTimer = null;
  let syncTask = null;
  let syncInProgress = false;
  let serverClosing = false;
  let remoteAvailable = false;

  async function getAppearanceTheme() {
    if (!appearancePreferencesPath) return appearanceTheme;
    try {
      const preferences = JSON.parse(await fs.readFile(appearancePreferencesPath, "utf8"));
      return typeof preferences.theme === "string" ? preferences.theme : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async function saveAppearanceTheme(theme) {
    if (appearancePreferencesPath) {
      await fs.mkdir(path.dirname(appearancePreferencesPath), { recursive: true });
      const temporaryPath = `${appearancePreferencesPath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporaryPath, JSON.stringify({ theme }), "utf8");
        await fs.rename(temporaryPath, appearancePreferencesPath);
      } catch (error) {
        await fs.rm(temporaryPath, { force: true });
        throw error;
      }
    }
    appearanceTheme = theme;
  }

  function getLocalSyncState() {
    return database.prepare(
      "SELECT remote_revision, pending, conflict, conflict_remote_revision, last_sync_at, last_sync_error FROM portal_sync_state WHERE id = 1",
    ).get();
  }

  function setLocalSyncError(error) {
    if (!database) return;
    const errorCode = typeof error?.code === "string" ? error.code.slice(0, 40) : "ONLINE_DATABASE_UNAVAILABLE";
    database.prepare(
      "UPDATE portal_sync_state SET last_sync_error = ?, updated_at = ? WHERE id = 1",
    ).run(errorCode, new Date().toISOString());
  }

  async function initializeRemoteDatabase() {
    if (remoteInitialization) return remoteInitialization;
    const initialization = (async () => {
      await postgresPool.query(`
        CREATE TABLE IF NOT EXISTS portal_state (
          id smallint PRIMARY KEY CHECK (id = 1),
          schema_version integer NOT NULL,
          workbook_state bytea NOT NULL,
          revision bigint NOT NULL DEFAULT 1,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await postgresPool.query(
        "ALTER TABLE portal_state ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1",
      );
      await postgresPool.query(`
        CREATE TABLE IF NOT EXISTS portal_profile_photos (
          user_id text PRIMARY KEY,
          extension text NOT NULL CHECK (extension IN ('jpg', 'png', 'webp')),
          photo_data bytea NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await postgresPool.query(`
        CREATE TABLE IF NOT EXISTS portal_school_logos (
          user_id text PRIMARY KEY,
          extension text NOT NULL CHECK (extension IN ('jpg', 'png', 'webp')),
          logo_data bytea NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await postgresPool.query(
        POSTGRES_REVOKE_PUBLIC_ACCESS_SQL,
      );
      let remoteResult = await postgresPool.query(
        "SELECT workbook_state, revision FROM portal_state WHERE id = 1",
      );
      const localResult = database.prepare(
        "SELECT workbook_state FROM portal_state WHERE id = 1",
      ).get();
      const syncState = getLocalSyncState();
      if (!remoteResult.rows.length) {
        await postgresPool.query(
          `INSERT INTO portal_state (id, schema_version, workbook_state, revision, updated_at)
           VALUES (1, 1, $1, 1, now())
           ON CONFLICT (id) DO NOTHING`,
          [localResult.workbook_state],
        );
        remoteResult = await postgresPool.query(
          "SELECT workbook_state, revision FROM portal_state WHERE id = 1",
        );
        if (!remoteResult.rows.length) {
          throw new Error("The online portal database has no saved state after initialization.");
        }
      }

      const remoteState = remoteResult.rows[0].workbook_state;
      const remoteRevision = Number(remoteResult.rows[0].revision);
      if (!Number.isSafeInteger(remoteRevision) || remoteRevision < 1) {
        throw new Error("The online portal database has an invalid revision.");
      }
      if (syncState.conflict) {
        remoteAvailable = true;
        return;
      }
      if (syncState.pending && syncState.remote_revision !== remoteRevision) {
        const now = new Date().toISOString();
        database.prepare(
          `UPDATE portal_sync_state
           SET conflict = 1, pending = 0, conflict_local_state = ?,
               conflict_remote_state = ?, conflict_remote_revision = ?,
               last_sync_error = 'SYNC_CONFLICT', updated_at = ?
           WHERE id = 1`,
        ).run(localResult.workbook_state, remoteState, remoteRevision, now);
        remoteAvailable = true;
        return;
      }
      if (syncState.pending) {
        remoteAvailable = true;
        return;
      }
      if (!localDatabaseExistedAtStartup) {
        database.prepare(
          "UPDATE portal_state SET workbook_state = ?, updated_at = ? WHERE id = 1",
        ).run(remoteState, new Date().toISOString());
        database.prepare(
          `UPDATE portal_sync_state
           SET remote_revision = ?, pending = 0, conflict = 0,
               conflict_local_state = NULL, conflict_remote_state = NULL,
               conflict_remote_revision = NULL, last_sync_at = ?, last_sync_error = NULL,
               updated_at = ?
           WHERE id = 1`,
        ).run(remoteRevision, new Date().toISOString(), new Date().toISOString());
        remoteAvailable = true;
        return;
      }

      if (syncState.remote_revision > 0) {
        if (syncState.remote_revision !== remoteRevision) {
          database.prepare(
            `UPDATE portal_state SET workbook_state = ?, updated_at = ? WHERE id = 1`,
          ).run(remoteState, new Date().toISOString());
          database.prepare(
            `UPDATE portal_sync_state
             SET remote_revision = ?, last_sync_at = ?, last_sync_error = NULL, updated_at = ?
             WHERE id = 1`,
          ).run(remoteRevision, new Date().toISOString(), new Date().toISOString());
        }
        remoteAvailable = true;
        return;
      }

      const statesMatch = JSON.stringify(decodeWorkbookState(localResult.workbook_state).model)
        === JSON.stringify(decodeWorkbookState(remoteState).model);
      if (statesMatch) {
        database.prepare(
          `UPDATE portal_sync_state
           SET remote_revision = ?, pending = 0, last_sync_at = ?,
               last_sync_error = NULL, updated_at = ?
           WHERE id = 1`,
        ).run(remoteRevision, new Date().toISOString(), new Date().toISOString());
      } else {
        database.prepare(
          `UPDATE portal_sync_state
           SET conflict = 1, conflict_local_state = ?, conflict_remote_state = ?,
               conflict_remote_revision = ?, pending = 0,
               last_sync_error = 'SYNC_CONFLICT', updated_at = ?
           WHERE id = 1`,
        ).run(localResult.workbook_state, remoteState, remoteRevision, new Date().toISOString());
      }
      remoteAvailable = true;
    })();
    remoteInitialization = initialization.catch((error) => {
      remoteInitialization = null;
      remoteAvailable = false;
      setLocalSyncError(error);
      throw error;
    });
    return remoteInitialization;
  }

  async function initializeDualDatabase() {
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    database = openPortalDatabase(databasePath);
    const existingState = database.prepare(
      "SELECT workbook_state FROM portal_state WHERE id = 1",
    ).get();
    if (!existingState) {
      if (!fileSystem.existsSync(migrationWorkbookPath)) {
        throw new Error(
          `The SQLite database is empty and the migration workbook was not found: ${migrationWorkbookPath}`,
        );
      }
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(migrationWorkbookPath);
      getUserSheet(workbook);
      if (!workbook.getWorksheet("Classes") || !workbook.getWorksheet("SignInLog")) {
        throw new Error("The migration workbook is missing required portal worksheets.");
      }
      database.prepare(
        "INSERT INTO portal_state (id, schema_version, workbook_state, updated_at) VALUES (1, 1, ?, ?)",
      ).run(encodeWorkbookState(workbook), new Date().toISOString());
      console.log(`Migrated portal data from ${path.resolve(migrationWorkbookPath)} into SQLite.`);
    }
    database.prepare(
      "INSERT OR IGNORE INTO portal_sync_state (id) VALUES (1)",
    ).run();
    try {
      await initializeRemoteDatabase();
    } catch (error) {
      console.warn("Online database unavailable; local changes will be queued for synchronization.", error.code || "connection error");
    }
    if (getLocalSyncState().pending && !getLocalSyncState().conflict) {
      scheduleDualSync();
    }
  }

  async function logPortalError(referenceId, error) {
    const logEntry = `[${new Date().toISOString()}] [${referenceId}] Portal request failed\n${error?.stack || error}\n`;
    console.error(logEntry);
    if (!logFilePath) return;
    try {
      await fs.mkdir(path.dirname(logFilePath), { recursive: true });
      await fs.appendFile(logFilePath, logEntry, "utf8");
    } catch (logError) {
      console.error("Could not write the portal server log:", logError);
    }
  }

  async function initializeDatabase() {
    if (databaseInitialization) return databaseInitialization;
    const initialization = (async () => {
      if (dualStorage) {
        await initializeDualDatabase();
        return;
      }
      if (postgresPool) {
        await postgresPool.query(`
          CREATE TABLE IF NOT EXISTS portal_state (
            id smallint PRIMARY KEY CHECK (id = 1),
            schema_version integer NOT NULL,
            workbook_state bytea NOT NULL,
            revision bigint NOT NULL DEFAULT 1,
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `);
        await postgresPool.query(
          "ALTER TABLE portal_state ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1",
        );
        await postgresPool.query(`
          CREATE TABLE IF NOT EXISTS portal_profile_photos (
            user_id text PRIMARY KEY,
            extension text NOT NULL CHECK (extension IN ('jpg', 'png', 'webp')),
            photo_data bytea NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `);
        await postgresPool.query(`
          CREATE TABLE IF NOT EXISTS portal_school_logos (
            user_id text PRIMARY KEY,
            extension text NOT NULL CHECK (extension IN ('jpg', 'png', 'webp')),
            logo_data bytea NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `);
        await postgresPool.query(
          POSTGRES_REVOKE_PUBLIC_ACCESS_SQL,
        );
        const existingState = await postgresPool.query(
          "SELECT workbook_state FROM portal_state WHERE id = 1",
        );
        if (existingState.rows.length) {
          return;
        }

        let workbook;
        const hasLocalDatabase = fileSystem.existsSync(databasePath);
        if (!migrationWorkbookWasSpecified && hasLocalDatabase) {
          workbook = readPortalDatabaseWorkbook(databasePath);
          console.log(`Migrating portal data from ${path.resolve(databasePath)} into Supabase.`);
        } else {
          if (!fileSystem.existsSync(migrationWorkbookPath)) {
            throw new Error(
              `The Supabase database is empty and the migration workbook was not found: ${migrationWorkbookPath}`,
            );
          }
          workbook = new ExcelJS.Workbook();
          await workbook.xlsx.readFile(migrationWorkbookPath);
          console.log(`Migrating portal data from ${path.resolve(migrationWorkbookPath)} into Supabase.`);
        }
        getUserSheet(workbook);
        if (!workbook.getWorksheet("Classes") || !workbook.getWorksheet("SignInLog")) {
          throw new Error("The migration source is missing required portal worksheets.");
        }
        await postgresPool.query(
          `INSERT INTO portal_state (id, schema_version, workbook_state, updated_at)
           VALUES (1, 1, $1, $2)
           ON CONFLICT (id) DO NOTHING`,
          [encodeWorkbookState(workbook), new Date().toISOString()],
        );
        return;
      }

      await fs.mkdir(path.dirname(databasePath), { recursive: true });
      database = openPortalDatabase(databasePath);
      const existingState = database.prepare(
        "SELECT workbook_state FROM portal_state WHERE id = 1",
      ).get();
      if (existingState) {
        return;
      }
      if (!fileSystem.existsSync(migrationWorkbookPath)) {
        throw new Error(
          `The SQLite database is empty and the migration workbook was not found: ${migrationWorkbookPath}`,
        );
      }
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(migrationWorkbookPath);
      getUserSheet(workbook);
      if (!workbook.getWorksheet("Classes") || !workbook.getWorksheet("SignInLog")) {
        throw new Error("The migration workbook is missing required portal worksheets.");
      }
      database.prepare(
        "INSERT INTO portal_state (id, schema_version, workbook_state, updated_at) VALUES (1, 1, ?, ?)",
      ).run(encodeWorkbookState(workbook), new Date().toISOString());
      console.log(`Migrated portal data from ${path.resolve(migrationWorkbookPath)} into SQLite.`);
    })();
    databaseInitialization = initialization.catch((error) => {
      if (database) {
        database.close();
        database = null;
      }
      databaseInitialization = null;
      throw error;
    });
    return databaseInitialization;
  }

  async function readDatabaseWorkbook() {
    await initializeDatabase();
    if (postgresPool && !dualStorage) {
      const client = transactionContext.getStore() || postgresPool;
      const result = await client.query(
        "SELECT workbook_state FROM portal_state WHERE id = 1",
      );
      if (!result.rows.length) throw new Error("The Supabase portal database has no saved state.");
      return decodeWorkbookState(result.rows[0].workbook_state);
    }
    const result = database.prepare(
      "SELECT workbook_state FROM portal_state WHERE id = 1",
    ).get();
    if (!result) throw new Error("The SQLite portal database has no saved state.");
    return decodeWorkbookState(result.workbook_state);
  }

  async function saveDatabaseWorkbook(workbook) {
    await initializeDatabase();
    if (postgresPool && !dualStorage) {
      const client = transactionContext.getStore() || postgresPool;
      const result = await client.query(
        "UPDATE portal_state SET workbook_state = $1, revision = revision + 1, updated_at = $2 WHERE id = 1",
        [encodeWorkbookState(workbook), new Date().toISOString()],
      );
      if (result.rowCount !== 1) throw new Error("The Supabase portal database has no saved state.");
      return;
    }
    if (dualStorage) {
      const state = encodeWorkbookState(workbook);
      const now = new Date().toISOString();
      const result = database.prepare(
        "UPDATE portal_state SET workbook_state = ?, updated_at = ? WHERE id = 1",
      ).run(state, now);
      if (result.changes !== 1) throw new Error("The SQLite portal database has no saved state.");
      database.prepare(
        `UPDATE portal_sync_state
         SET pending = 1,
             conflict_local_state = CASE WHEN conflict = 1 THEN ? ELSE conflict_local_state END,
             updated_at = ?
         WHERE id = 1`,
      ).run(state, now);
      return;
    }
    const result = database.prepare(
      "UPDATE portal_state SET workbook_state = ?, updated_at = ? WHERE id = 1",
    ).run(encodeWorkbookState(workbook), new Date().toISOString());
    if (result.changes !== 1) throw new Error("The SQLite portal database has no saved state.");
  }

  function readSyncStatus() {
    if (!dualStorage || !database) {
      return { mode: storage, state: "disabled" };
    }
    const syncState = getLocalSyncState();
    return {
      mode: "dual",
      state: syncState.conflict
        ? "conflict"
        : syncState.pending
          ? remoteAvailable ? "pending" : "offline"
          : remoteAvailable ? "synced" : "offline",
      localRevision: syncState.remote_revision,
      lastSyncedAt: syncState.last_sync_at,
    };
  }

  function scheduleDualSync() {
    if (!dualStorage || syncTimer || serverClosing) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncTask = synchronizeLocalDatabase();
      syncTask.catch((error) => {
        const referenceId = crypto.randomUUID();
        logPortalError(referenceId, error).catch((logError) => {
          console.error("Could not write the online synchronization error log:", logError);
        });
      }).finally(() => {
        syncTask = null;
      });
    }, 100);
    syncTimer.unref?.();
  }

  async function synchronizeLocalDatabase() {
    if (!dualStorage || syncInProgress || serverClosing) return;
    syncInProgress = true;
    try {
      await initializeDatabase();
      if (!remoteInitialization) {
        try {
          await initializeRemoteDatabase();
        } catch (error) {
          remoteAvailable = false;
          setLocalSyncError(error);
          return;
        }
      }

      const synchronization = workbookQueue.then(async () => {
        const syncState = getLocalSyncState();
        if (syncState.conflict || !syncState.pending) return;
        const localState = database.prepare(
          "SELECT workbook_state FROM portal_state WHERE id = 1",
        ).get();
        if (!localState) throw new Error("The local portal database has no saved state.");

        const client = await postgresPool.connect();
        let transactionStarted = false;
        try {
          await client.query("BEGIN");
          transactionStarted = true;
          const remoteResult = await client.query(
            "SELECT workbook_state, revision FROM portal_state WHERE id = 1 FOR UPDATE",
          );
          if (!remoteResult.rows.length) {
            throw new Error("The online portal database has no saved state.");
          }
          const remoteRevision = Number(remoteResult.rows[0].revision);
          if (remoteRevision !== syncState.remote_revision) {
            await client.query("COMMIT");
            transactionStarted = false;
            const now = new Date().toISOString();
            database.prepare(
              `UPDATE portal_sync_state
               SET conflict = 1, pending = 0, conflict_local_state = ?,
                   conflict_remote_state = ?, conflict_remote_revision = ?,
                   last_sync_error = 'SYNC_CONFLICT', updated_at = ?
               WHERE id = 1`,
            ).run(
              localState.workbook_state,
              remoteResult.rows[0].workbook_state,
              remoteRevision,
              now,
            );
            remoteAvailable = true;
            return;
          }
          await client.query(
            `UPDATE portal_state
             SET workbook_state = $1, revision = revision + 1, updated_at = now()
             WHERE id = 1`,
            [localState.workbook_state],
          );
          await client.query("COMMIT");
          transactionStarted = false;
          const now = new Date().toISOString();
          database.prepare(
            `UPDATE portal_sync_state
             SET remote_revision = remote_revision + 1, pending = 0, conflict = 0,
                 conflict_local_state = NULL, conflict_remote_state = NULL,
                 conflict_remote_revision = NULL, last_sync_at = ?,
                 last_sync_error = NULL, updated_at = ?
             WHERE id = 1`,
          ).run(now, now);
          remoteAvailable = true;
        } catch (error) {
          if (transactionStarted) await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      });
      workbookQueue = synchronization.then(() => undefined, () => undefined);
      try {
        await synchronization;
      } catch (error) {
        remoteAvailable = false;
        setLocalSyncError(error);
        throw error;
      }
    } finally {
      syncInProgress = false;
    }
  }

  async function synchronizeNow() {
    if (!dualStorage) throw new HttpError(409, "Online synchronization is not enabled on this server.");
    await initializeDatabase();
    if (syncTask) await syncTask.catch(() => undefined);
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    // Re-read the online copy (pulling newer online changes) inside the workbook queue,
    // then push any pending local changes.
    const refresh = workbookQueue.then(() => {
      remoteInitialization = null;
      return initializeRemoteDatabase();
    });
    workbookQueue = refresh.then(() => undefined, () => undefined);
    try {
      await refresh;
    } catch (error) {
      throw new HttpError(503, "The online database is unavailable. Local changes are kept and will retry automatically.");
    }
    try {
      await synchronizeLocalDatabase();
    } catch (error) {
      throw new HttpError(503, "The online database could not be updated. Local changes are kept and will retry automatically.");
    }
    return readSyncStatus();
  }

  async function resolveDualSyncConflict(resolution) {
    if (!dualStorage) throw new HttpError(409, "Online conflict resolution is not enabled.");
    return serializeWorkbook(async () => {
      const syncState = getLocalSyncState();
      if (!syncState.conflict) throw new HttpError(409, "There is no online synchronization conflict to resolve.");
      const client = await postgresPool.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        const remoteResult = await client.query(
          "SELECT workbook_state, revision FROM portal_state WHERE id = 1 FOR UPDATE",
        );
        if (!remoteResult.rows.length) throw new Error("The online portal database has no saved state.");
        const remoteRevision = Number(remoteResult.rows[0].revision);
        if (remoteRevision !== syncState.conflict_remote_revision) {
          const localState = database.prepare(
            "SELECT workbook_state FROM portal_state WHERE id = 1",
          ).get();
          await client.query("COMMIT");
          transactionStarted = false;
          database.prepare(
            `UPDATE portal_sync_state
             SET conflict_local_state = ?, conflict_remote_state = ?,
                 conflict_remote_revision = ?, last_sync_error = 'SYNC_CONFLICT',
                 updated_at = ?
             WHERE id = 1`,
          ).run(
            localState.workbook_state,
            remoteResult.rows[0].workbook_state,
            remoteRevision,
            new Date().toISOString(),
          );
          return { state: "conflict" };
        }

        if (resolution === "local") {
          const localState = database.prepare(
            "SELECT workbook_state FROM portal_state WHERE id = 1",
          ).get();
          await client.query(
            `UPDATE portal_state
             SET workbook_state = $1, revision = revision + 1, updated_at = now()
             WHERE id = 1`,
            [localState.workbook_state],
          );
        } else {
          database.prepare(
            "UPDATE portal_state SET workbook_state = ?, updated_at = ? WHERE id = 1",
          ).run(remoteResult.rows[0].workbook_state, new Date().toISOString());
        }
        await client.query("COMMIT");
        transactionStarted = false;
        const nextRevision = remoteRevision + (resolution === "local" ? 1 : 0);
        const now = new Date().toISOString();
        database.prepare(
          `UPDATE portal_sync_state
           SET remote_revision = ?, pending = 0, conflict = 0,
               conflict_local_state = NULL, conflict_remote_state = NULL,
               conflict_remote_revision = NULL, last_sync_at = ?,
               last_sync_error = NULL, updated_at = ?
           WHERE id = 1`,
        ).run(nextRevision, now, now);
        remoteAvailable = true;
        return { state: "synced", resolution };
      } catch (error) {
        if (transactionStarted) await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

function getInventorySheet(workbook) {
  let sheet = workbook.getWorksheet("Inventory");
  if (!sheet) {
    sheet = workbook.addWorksheet("Inventory");
    sheet.addRow([
      "Inventory ID",
      "Class ID",
      "Teacher User ID",
      "Item",
      "Category",
      "Quantity",
      "Unit",
      "Reorder Level",
      "Status",
      "Notes",
      "Updated",
    ]);
    sheet.getRow(1).font = { bold: true };
  }
  const headers = headerColumns(sheet);
  return {
    sheet,
    columns: {
      id: getColumn(headers, "Inventory ID"),
      classId: getColumn(headers, "Class ID"),
      teacherUserId: getColumn(headers, "Teacher User ID"),
      item: getColumn(headers, "Item"),
      category: ensureColumn(sheet, headers, "Category"),
      quantity: getColumn(headers, "Quantity"),
      unit: ensureColumn(sheet, headers, "Unit"),
      reorderLevel: ensureColumn(sheet, headers, "Reorder Level"),
      status: ensureColumn(sheet, headers, "Status"),
      notes: ensureColumn(sheet, headers, "Notes"),
      updated: getColumn(headers, "Updated", ["Updated At"]),
    },
  };
}

function getOwnedInventory(sheet, columns, session) {
  const items = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (cellText(row.getCell(columns.classId).value) !== session.classId
      || cellText(row.getCell(columns.teacherUserId).value) !== session.userId) continue;
    const id = cellText(row.getCell(columns.id).value);
    const item = cellText(row.getCell(columns.item).value);
    if (!id || !item) continue;
    const quantity = Number(row.getCell(columns.quantity).value);
    const reorderLevel = Number(row.getCell(columns.reorderLevel).value);
    items.push({
      id,
      item,
      category: cellText(row.getCell(columns.category).value),
      quantity: Number.isFinite(quantity) ? quantity : 0,
      unit: cellText(row.getCell(columns.unit).value),
      reorderLevel: Number.isFinite(reorderLevel) ? reorderLevel : 0,
      status: cellText(row.getCell(columns.status).value),
      notes: cellText(row.getCell(columns.notes).value),
      updated: cellText(row.getCell(columns.updated).value),
    });
  }
  return items;
}

function nextInventoryId(sheet, idColumn) {
  let highest = 0;
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const match = cellText(sheet.getRow(rowNumber).getCell(idColumn).value).match(/^I(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `I${String(highest + 1).padStart(5, "0")}`;
}

function validateInventoryItem(data) {
  const item = typeof data.item === "string" ? data.item.trim() : "";
  const category = typeof data.category === "string" ? data.category.trim() : "";
  const unit = typeof data.unit === "string" ? data.unit.trim() : "";
  const notes = typeof data.notes === "string" ? data.notes.trim() : "";
  const quantity = Number(data.quantity);
  const reorderLevel = Number(data.reorderLevel);
  if (!item || item.length > 120) throw new HttpError(400, "Enter an item name up to 120 characters.");
  if (category.length > 80 || unit.length > 40 || notes.length > 500) {
    throw new HttpError(400, "Inventory fields exceed their allowed length.");
  }
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 1000000) {
    throw new HttpError(400, "Enter a quantity from 0 to 1,000,000.");
  }
  if (!Number.isFinite(reorderLevel) || reorderLevel < 0 || reorderLevel > 1000000) {
    throw new HttpError(400, "Enter a reorder level from 0 to 1,000,000.");
  }
  return { item, category, quantity, unit, reorderLevel, notes };
}

async function listInventory(session) {
  return serializeWorkbook(async () => {
    const workbook = await readDatabaseWorkbook();
    const { sheet, columns } = getInventorySheet(workbook);
    return { items: getOwnedInventory(sheet, columns, session) };
  });
}

async function saveInventoryItem(session, data) {
  const values = validateInventoryItem(data);
  return serializeWorkbook(async () => {
    const workbook = await readDatabaseWorkbook();
    const { sheet, columns } = getInventorySheet(workbook);
    const id = typeof data.id === "string" ? data.id.trim() : "";
    let row = null;
    if (id) {
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const candidate = sheet.getRow(rowNumber);
        if (cellText(candidate.getCell(columns.id).value) === id
          && cellText(candidate.getCell(columns.classId).value) === session.classId
          && cellText(candidate.getCell(columns.teacherUserId).value) === session.userId) {
          row = candidate;
          break;
        }
      }
      if (!row) throw new HttpError(404, "The inventory item was not found.");
    }
    if (!row) {
      row = firstAvailableRow(sheet, [columns.id, columns.classId, columns.item]);
      row.getCell(columns.id).value = nextInventoryId(sheet, columns.id);
    }
    row.getCell(columns.id).value = row.getCell(columns.id).value || nextInventoryId(sheet, columns.id);
    row.getCell(columns.classId).value = session.classId;
    row.getCell(columns.teacherUserId).value = session.userId;
    row.getCell(columns.item).value = values.item;
    row.getCell(columns.category).value = values.category;
    row.getCell(columns.quantity).value = values.quantity;
    row.getCell(columns.unit).value = values.unit;
    row.getCell(columns.reorderLevel).value = values.reorderLevel;
    row.getCell(columns.status).value = values.quantity <= values.reorderLevel ? "Low stock" : "In stock";
    row.getCell(columns.notes).value = values.notes;
    row.getCell(columns.updated).value = new Date();
    await saveDatabaseWorkbook(workbook);
    return { item: getOwnedInventory(sheet, columns, session).find((entry) => entry.id === cellText(row.getCell(columns.id).value)) };
  });
}

async function deleteInventoryItem(session, id) {
  if (!/^I\d+$/i.test(id)) throw new HttpError(404, "The inventory item was not found.");
  return serializeWorkbook(async () => {
    const workbook = await readDatabaseWorkbook();
    const { sheet, columns } = getInventorySheet(workbook);
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      if (cellText(row.getCell(columns.id).value) !== id
        || cellText(row.getCell(columns.classId).value) !== session.classId
        || cellText(row.getCell(columns.teacherUserId).value) !== session.userId) continue;
      row.getCell(columns.id).value = null;
      row.getCell(columns.classId).value = null;
      row.getCell(columns.teacherUserId).value = null;
      row.getCell(columns.item).value = null;
      row.getCell(columns.category).value = null;
      row.getCell(columns.quantity).value = null;
      row.getCell(columns.unit).value = null;
      row.getCell(columns.reorderLevel).value = null;
      row.getCell(columns.status).value = null;
      row.getCell(columns.notes).value = null;
      row.getCell(columns.updated).value = null;
      await saveDatabaseWorkbook(workbook);
      return { removed: true };
    }
    throw new HttpError(404, "The inventory item was not found.");
  });
}


  function serializeWorkbook(operation) {
    const result = workbookQueue.then(async () => {
      if (dualStorage) {
        await initializeDatabase();
        database.exec("BEGIN IMMEDIATE");
        try {
          const value = await operation();
          database.exec("COMMIT");
          if (getLocalSyncState().pending && !getLocalSyncState().conflict) {
            scheduleDualSync();
          }
          return value;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      if (!postgresPool) return operation();
      await initializeDatabase();
      const client = await postgresPool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM portal_state WHERE id = 1 FOR UPDATE");
        const result = await transactionContext.run(client, operation);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
    workbookQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function ensureBootstrapAdmin() {
    if (!bootstrapAdminEmail) return Promise.resolve();
    if (bootstrapAdminInitialization) return bootstrapAdminInitialization;
    const initialization = serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getUserSheet(workbook);
      let row = findUser(sheet, columns, bootstrapAdminEmail);
      if (row && cellText(row.getCell(columns.role).value).toLowerCase() !== "teacher") {
        throw new Error("The configured bootstrap administrator must use a teacher account.");
      }
      if (row && cellText(row.getCell(columns.adminAccess).value).toLowerCase() === "true") {
        return;
      }
      if (row && cellText(row.getCell(columns.status).value).toLowerCase() !== "active") {
        throw new Error("The configured bootstrap administrator account is inactive.");
      }

      const passwordHash = await hashAdminPassword(bootstrapAdminPassword);
      if (!row) {
        const values = [];
        values[columns.id] = nextUserId(sheet, columns.id, "teacher");
        values[columns.role] = "Teacher";
        values[columns.name] = "Administrator";
        values[columns.email] = bootstrapAdminEmail;
        values[columns.password] = passwordHash;
        values[columns.classId] = "";
        values[columns.status] = "Active";
        values[columns.created] = new Date();
        values[columns.signIns] = 0;
        values[columns.emailCheck] = "OK";
        values[columns.adminAccess] = "true";
        values[columns.mustChangePassword] = "true";
        row = writeRow(sheet, [columns.id, columns.email], values);
      } else {
        row.getCell(columns.password).value = passwordHash;
        row.getCell(columns.adminAccess).value = "true";
        row.getCell(columns.mustChangePassword).value = "true";
      }
      setPasswordDocumentation(workbook, columns.password);
      await saveDatabaseWorkbook(workbook);
      console.info("The configured administrator account is ready and must change its temporary password.");
    });
    bootstrapAdminInitialization = initialization.catch((error) => {
      bootstrapAdminInitialization = null;
      throw error;
    });
    return bootstrapAdminInitialization;
  }

  async function checkWorkbook() {
    const workbook = await readDatabaseWorkbook();
    getUserSheet(workbook);
    if (!workbook.getWorksheet("Classes")) {
      throw new Error('The workbook is missing the "Classes" sheet.');
    }
    if (!workbook.getWorksheet("SignInLog")) {
      throw new Error('The workbook is missing the "SignInLog" sheet.');
    }
  }

  // Only the last forwarded value is trusted: it is appended by the platform's own proxy.
  function getLastForwardedValue(request, headerName) {
    const header = request.headers[headerName];
    const value = Array.isArray(header) ? header.join(",") : header;
    if (typeof value !== "string") return "";
    return value.split(",").pop().trim();
  }

  function isForwardedHttps(request) {
    return trustProxy && getLastForwardedValue(request, "x-forwarded-proto").toLowerCase() === "https";
  }

  function getClientAddress(request) {
    const forwarded = trustProxy ? getLastForwardedValue(request, "x-forwarded-for") : "";
    return forwarded || request.socket.remoteAddress || "unknown";
  }

  function createSessionCookie(response, sessionId, request) {
    const secure = request.socket.encrypted || isForwardedHttps(request) ? "; Secure" : "";
    const cookieName = getSessionCookieName(request);
    response.setHeader(
      "Set-Cookie",
      `${cookieName}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DURATION_MS / 1000}${secure}`,
    );
  }

  function getSessionCookieName(request) {
    const portalEntry = request.headers["x-portal-entry"];
    return PORTAL_SESSION_ENTRIES.has(portalEntry)
      ? `${SESSION_COOKIE}_${portalEntry}`
      : SESSION_COOKIE;
  }

  function getSession(request) {
    const cookieName = getSessionCookieName(request);
    const cookieHeader = request.headers.cookie || "";
    const cookie = cookieHeader.split(";").map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`));
    if (!cookie) return null;
    const sessionId = cookie.slice(cookieName.length + 1);
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(sessionId);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_DURATION_MS;
    return { sessionId, ...session };
  }

  function revokeUserSessions(userId) {
    for (const [sessionId, activeSession] of sessions) {
      if (activeSession.adminUserId === userId) sessions.delete(sessionId);
    }
  }

  function requireTeacherSession(request) {
    const session = getSession(request);
    if (!session) throw new HttpError(401, "Your session has expired. Sign in again.");
    if (session.role !== "teacher" && !session.isAdmin) {
      throw new HttpError(403, "Only teacher accounts can manage student records.");
    }
    if (session.isAdmin && request.url.startsWith("/api/teacher/profile")) {
      return {
        ...session,
        userId: session.adminUserId,
        classId: session.adminClassId,
        classCode: session.adminClassCode,
        name: session.adminName,
      };
    }
    return session;
  }

  function requireAdminSession(request) {
    const session = getSession(request);
    if (!session) throw new HttpError(401, "Your session has expired. Sign in again.");
    if (!session.isAdmin) throw new HttpError(403, "Only administrators can manage all classes.");
    return session;
  }

  async function listAdminClasses() {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
      const usersById = new Map();
      for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
        const row = userSheet.getRow(rowNumber);
        usersById.set(cellText(row.getCell(userColumns.id).value), {
          name: cellText(row.getCell(userColumns.name).value),
          active: cellText(row.getCell(userColumns.status).value).toLowerCase() === "active",
        });
      }
      const classes = [];
      for (let rowNumber = 2; rowNumber <= classSheet.rowCount; rowNumber += 1) {
        const row = classSheet.getRow(rowNumber);
        const teacherId = cellText(row.getCell(classColumns.teacherId).value);
        const teacher = usersById.get(teacherId);
        if (!teacherId || !teacher || !teacher.active) continue;
        classes.push({
          id: cellText(row.getCell(classColumns.id).value),
          classroom: cellText(row.getCell(classColumns.classroom).value),
          grade: cellText(row.getCell(classColumns.grade).value),
          strand: cellText(row.getCell(classColumns.strand).value),
          section: cellText(row.getCell(classColumns.section).value),
          schoolName: cellText(row.getCell(classColumns.schoolName).value),
          teacherId,
          teacherName: teacher.name,
        });
      }
      return { classes };
    });
  }

  async function setAdminActiveClass(session, classIdValue) {
    const classId = typeof classIdValue === "string" ? classIdValue.trim() : "";
    if (!classId || classId.length > 100) {
      throw new HttpError(400, "Choose a valid class.");
    }
    const activeClass = await serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
      const usersById = new Map();
      for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
        const userRow = userSheet.getRow(rowNumber);
        usersById.set(cellText(userRow.getCell(userColumns.id).value), userRow);
      }
      for (let rowNumber = 2; rowNumber <= classSheet.rowCount; rowNumber += 1) {
        const row = classSheet.getRow(rowNumber);
        if (cellText(row.getCell(classColumns.id).value) !== classId) continue;
        const teacherId = cellText(row.getCell(classColumns.teacherId).value);
        const teacherRow = usersById.get(teacherId);
        if (!teacherRow || cellText(teacherRow.getCell(userColumns.status).value).toLowerCase() !== "active"
          || cellText(teacherRow.getCell(userColumns.role).value).toLowerCase() !== "teacher"
          || cellText(teacherRow.getCell(userColumns.classId).value) !== classId) {
          throw new HttpError(404, "The selected class has no active teacher account.");
        }
        return {
          classId,
          teacherId,
          teacherName: cellText(teacherRow.getCell(userColumns.name).value),
          classCode: getClassCode(workbook, classId),
        };
      }
      throw new HttpError(404, "The selected class could not be found.");
    });
    const storedSession = sessions.get(session.sessionId);
    if (!storedSession?.isAdmin) throw new HttpError(401, "Your session has expired. Sign in again.");
    storedSession.userId = activeClass.teacherId;
    storedSession.name = activeClass.teacherName;
    storedSession.classId = activeClass.classId;
    storedSession.classCode = activeClass.classCode || "";
    return { classId: activeClass.classId, teacherName: activeClass.teacherName };
  }

  async function listAdminAccounts() {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getUserSheet(workbook);
      const accounts = [];
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        const id = cellText(row.getCell(columns.id).value);
        if (!id) continue;
        accounts.push({
          id,
          name: cellText(row.getCell(columns.name).value),
          email: cellText(row.getCell(columns.email).value),
          role: cellText(row.getCell(columns.role).value),
          status: cellText(row.getCell(columns.status).value),
          classId: cellText(row.getCell(columns.classId).value),
          isAdmin: cellText(row.getCell(columns.adminAccess).value).toLowerCase() === "true",
          mustChangePassword: cellText(row.getCell(columns.mustChangePassword).value).toLowerCase() === "true",
        });
      }
      return { accounts };
    });
  }

  async function setAdminAccountStatus(session, userIdValue, statusValue) {
    const userId = typeof userIdValue === "string" ? userIdValue.trim() : "";
    const status = statusValue === "Active" || statusValue === "Inactive" ? statusValue : "";
    if (!userId || userId.length > 100 || !status) {
      throw new HttpError(400, "Choose a valid account and status.");
    }
    if (userId === session.adminUserId) {
      throw new HttpError(400, "You cannot change your own account status.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getUserSheet(workbook);
      let row = null;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const candidate = sheet.getRow(rowNumber);
        if (cellText(candidate.getCell(columns.id).value) === userId) {
          row = candidate;
          break;
        }
      }
      if (!row) throw new HttpError(404, "The account could not be found.");
      const wasActiveAdmin = cellText(row.getCell(columns.adminAccess).value).toLowerCase() === "true"
        && cellText(row.getCell(columns.status).value).toLowerCase() === "active";
      if (wasActiveAdmin && status === "Inactive") {
        let activeAdminCount = 0;
        for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
          const account = sheet.getRow(rowNumber);
          if (cellText(account.getCell(columns.adminAccess).value).toLowerCase() === "true"
            && cellText(account.getCell(columns.status).value).toLowerCase() === "active") {
            activeAdminCount += 1;
          }
        }
        if (activeAdminCount <= 1) {
          throw new HttpError(400, "The last active administrator cannot be deactivated.");
        }
      }
      row.getCell(columns.status).value = status;
      await saveDatabaseWorkbook(workbook);
      if (status.toLowerCase() === "inactive") revokeUserSessions(userId);
      return { userId, status };
    });
  }

  async function resetAdminAccountPassword(session, userIdValue) {
    const userId = typeof userIdValue === "string" ? userIdValue.trim() : "";
    if (!userId || userId.length > 100) {
      throw new HttpError(400, "Choose a valid account.");
    }
    if (userId === session.adminUserId) {
      throw new HttpError(400, "You cannot reset your own password from account management.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getUserSheet(workbook);
      let userRow = null;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const candidate = sheet.getRow(rowNumber);
        if (cellText(candidate.getCell(columns.id).value) === userId) {
          userRow = candidate;
          break;
        }
      }
      if (!userRow) throw new HttpError(404, "The account could not be found.");
      const email = cellText(userRow.getCell(columns.email).value).toLowerCase();
      const hashPasswordForAccount = cellText(userRow.getCell(columns.adminAccess).value).toLowerCase() === "true"
        ? hashAdminPassword
        : hashPassword;
      userRow.getCell(columns.password).value = await hashPasswordForAccount(email);
      userRow.getCell(columns.mustChangePassword).value = "true";
      await saveDatabaseWorkbook(workbook);
      revokeUserSessions(userId);
      return { userId, mustChangePassword: true };
    });
  }

  async function changeOwnPassword(session, data) {
    const currentPassword = typeof data.currentPassword === "string" ? data.currentPassword : "";
    const newPassword = typeof data.newPassword === "string" ? data.newPassword : "";
    if (currentPassword.length < 6 || currentPassword.length > 256) {
      throw new HttpError(400, "Enter your temporary password.");
    }
    if (newPassword.length < 6 || newPassword.length > 256) {
      throw new HttpError(400, "Use a new password between 6 and 256 characters.");
    }
    if (session.mustChangePassword && newPassword.length < 12) {
      throw new HttpError(400, "Your new password must be at least 12 characters.");
    }
    if (newPassword === currentPassword) {
      throw new HttpError(400, "Choose a new password different from your temporary password.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getUserSheet(workbook);
      let userRow = null;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const candidate = sheet.getRow(rowNumber);
        if (cellText(candidate.getCell(columns.id).value) === session.adminUserId) {
          userRow = candidate;
          break;
        }
      }
      if (!userRow || cellText(userRow.getCell(columns.status).value).toLowerCase() !== "active") {
        throw new HttpError(401, "Your account is unavailable. Sign in again.");
      }
      const matches = await verifyPassword(currentPassword, cellText(userRow.getCell(columns.password).value));
      if (!matches) throw new HttpError(400, "Your temporary password doesn't match.");
      userRow.getCell(columns.password).value = await (session.isAdmin
        ? hashAdminPassword(newPassword)
        : hashPassword(newPassword));
      userRow.getCell(columns.mustChangePassword).value = "false";
      await saveDatabaseWorkbook(workbook);
      const activeSession = sessions.get(session.sessionId);
      if (activeSession) activeSession.mustChangePassword = false;
      return { saved: true };
    });
  }

  function requireParentSession(request) {
    const session = getSession(request);
    if (!session) throw new HttpError(401, "Your session has expired. Sign in again.");
    if (session.role !== "parent") throw new HttpError(403, "Only parent accounts can access the Parent Portal.");
    return session;
  }

  function openSession(response, request, user) {
    const sessionId = crypto.randomBytes(32).toString("hex");
    sessions.set(sessionId, {
      userId: user.id,
      name: user.name,
      role: user.role,
      isAdmin: user.isAdmin === true,
      mustChangePassword: user.mustChangePassword === true,
      classId: user.classId,
      classCode: user.classCode || "",
      adminUserId: user.id,
      adminClassId: user.classId,
      adminClassCode: user.classCode || "",
      adminName: user.name,
      expiresAt: Date.now() + SESSION_DURATION_MS,
    });
    createSessionCookie(response, sessionId, request);
  }

  async function register(data) {
    const account = validateAccount(data, true);
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getUserSheet(workbook);
      if (findUser(sheet, columns, account.email)) {
        throw new HttpError(409, "That email already has an account. Try signing in.");
      }

      const userId = nextUserId(sheet, columns.id, account.role);
      let classInfo;
      if (account.role === "teacher") {
        classInfo = createTeacherClass(
          workbook,
          account.extra || userId,
          userId,
          account.name,
          account.grade,
          account.strand,
        );
      } else {
        classInfo = findClass(workbook, "parent", account.extra);
        incrementCell(classInfo.row.getCell(classInfo.columns.parents));
      }
      const passwordHash = await hashPassword(account.password);
      const rowValues = [];
      rowValues[columns.id] = userId;
      rowValues[columns.role] = account.role === "teacher" ? "Teacher" : "Parent";
      rowValues[columns.name] = account.name;
      rowValues[columns.email] = account.email;
      rowValues[columns.password] = passwordHash;
      rowValues[columns.classId] = classInfo.id;
      rowValues[columns.status] = "Active";
      rowValues[columns.created] = new Date();
      rowValues[columns.signIns] = 0;
      rowValues[columns.emailCheck] = "OK";
      writeRow(sheet, [columns.id, columns.email], rowValues);
      setPasswordDocumentation(workbook, columns.password);

      await saveDatabaseWorkbook(workbook);
      return {
        user: {
          id: userId,
          name: account.name,
          role: account.role,
          classId: classInfo.id,
          ...(account.role === "teacher" ? { classCode: classInfo.code } : {}),
          isAdmin: false,
          mustChangePassword: false,
        },
      };
    });
  }

  async function login(data) {
    const account = validateAccount(data, false);
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getUserSheet(workbook);
      const row = findUser(sheet, columns, account.email);
      const userId = row ? cellText(row.getCell(columns.id).value) : "";
      if (!row || cellText(row.getCell(columns.status).value).toLowerCase() !== "active") {
        logSignIn(workbook, {
          email: account.email,
          role: account.role,
          result: "Failed",
          userId,
          note: row ? "Inactive account" : "Account not found",
        });
        await saveDatabaseWorkbook(workbook);
        throw new HttpError(401, "Email or password doesn't match. Check both and try again.");
      }

      const storedPassword = cellText(row.getCell(columns.password).value);
      if (!(await verifyPassword(account.password, storedPassword))) {
        logSignIn(workbook, {
          email: account.email,
          role: account.role,
          result: "Failed",
          userId,
          note: "Password mismatch",
        });
        await saveDatabaseWorkbook(workbook);
        throw new HttpError(401, "Email or password doesn't match. Check both and try again.");
      }

      const storedRole = cellText(row.getCell(columns.role).value).toLowerCase();
      if (storedRole !== account.role) {
        logSignIn(workbook, {
          email: account.email,
          role: account.role,
          result: "Failed",
          userId,
          note: "Role mismatch",
        });
        await saveDatabaseWorkbook(workbook);
        throw new HttpError(
          403,
          `This email is a ${storedRole} account. Choose ${storedRole === "parent" ? "Parent" : "Teacher"} above.`,
        );
      }

      const isAdmin = cellText(row.getCell(columns.adminAccess).value).toLowerCase() === "true";
      if (isAdmin && storedPassword.startsWith("pbkdf2$")) {
        row.getCell(columns.password).value = await hashAdminPassword(account.password);
      }
      incrementCell(row.getCell(columns.signIns));
      row.getCell(columns.lastSignIn).value = new Date();
      logSignIn(workbook, {
        email: account.email,
        role: account.role,
        result: "Success",
        userId,
        note: "",
      });
      setPasswordDocumentation(workbook, columns.password);
      await saveDatabaseWorkbook(workbook);

      return {
        user: {
          id: userId,
          name: cellText(row.getCell(columns.name).value),
          role: account.role,
          classId: cellText(row.getCell(columns.classId).value),
          ...(account.role === "teacher"
            ? { classCode: getClassCode(workbook, cellText(row.getCell(columns.classId).value)) }
            : {}),
          isAdmin,
          mustChangePassword: cellText(row.getCell(columns.mustChangePassword).value).toLowerCase() === "true",
        },
      };
    });
  }

  async function listStudents(session) {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      const classRow = findTeacherClassRow(classSheet, classColumns, session);
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      const sectionsHandled = getHandledSections(classRow, classColumns);
      const defaultSection = cellText(classRow.getCell(classColumns.section).value);
      let migratedStudents = false;
      if (defaultSection) {
        for (let rowNumber = 2; rowNumber <= studentSheet.rowCount; rowNumber += 1) {
          const row = studentSheet.getRow(rowNumber);
          if (cellText(row.getCell(studentColumns.classId).value) === session.classId
            && (!cellText(row.getCell(studentColumns.teacherUserId).value)
              || cellText(row.getCell(studentColumns.teacherUserId).value) === session.userId)
            && !cellText(row.getCell(studentColumns.section).value)) {
            row.getCell(studentColumns.section).value = defaultSection;
            migratedStudents = true;
          }
        }
      }
      const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
      const parents = [];
      for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
        const row = userSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(userColumns.role).value).toLowerCase() !== "parent"
          || cellText(row.getCell(userColumns.classId).value) !== session.classId
          || cellText(row.getCell(userColumns.status).value).toLowerCase() !== "active"
        ) continue;
        parents.push({
          id: cellText(row.getCell(userColumns.id).value),
          name: cellText(row.getCell(userColumns.name).value),
          email: cellText(row.getCell(userColumns.email).value),
        });
      }
      if (migratedStudents) await saveDatabaseWorkbook(workbook);
      const rosterStudents = getOwnedStudents(studentSheet, studentColumns, session);
      const statusEvents = monthlyAttendanceStatusEvents(workbook, session, new Set(rosterStudents.map((student) => student.id)));
      rosterStudents.forEach((student) => {
        const latest = (statusEvents.get(student.id) || []).slice(-1)[0];
        student.enrollmentStatus = latest && latest.status !== "Transferred In" ? latest.status : "";
        student.enrollmentStatusDate = student.enrollmentStatus ? latest.date : "";
      });
      return {
        students: rosterStudents,
        parents,
        sectionsHandled,
        sectionGrades: getSectionGrades(classRow, classColumns),
      };
    });
  }

  async function saveNutritionalStatusMeasurements(session, studentId, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new HttpError(400, "Enter the measurement date, weight, and height.");
    }
    const weightKg = typeof data.weightKg === "number" && Number.isFinite(data.weightKg)
      ? data.weightKg
      : Number.NaN;
    const heightM = typeof data.heightM === "number" && Number.isFinite(data.heightM)
      ? data.heightM
      : Number.NaN;
    const measurementDate = typeof data.measurementDate === "string" ? data.measurementDate : "";
    if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 500) {
      throw new HttpError(400, "Weight must be greater than 0 and no more than 500 kg.");
    }
    if (!Number.isFinite(heightM) || heightM <= 0 || heightM > 2.5) {
      throw new HttpError(400, "Height must be greater than 0 and no more than 2.5 m.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(measurementDate)
      || !Number.isFinite(Date.parse(`${measurementDate}T00:00:00.000Z`))
      || new Date(`${measurementDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== measurementDate) {
      throw new HttpError(400, "Enter a valid measurement date.");
    }
    if (measurementDate > new Date().toISOString().slice(0, 10)) {
      throw new HttpError(400, "Measurement date cannot be in the future.");
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getStudentSheet(workbook);
      const row = findOwnedStudent(sheet, columns, session, studentId);
      const savedWeightKg = Math.round(weightKg * 100) / 100;
      const savedHeightM = Math.round(heightM * 1000) / 1000;
      const birthdate = row.getCell(columns.birthdate).value;
      const birthdateText = birthdate instanceof Date
        ? birthdate.toISOString().slice(0, 10)
        : cellText(birthdate);
      if (!birthdateText || measurementDate < birthdateText) {
        throw new HttpError(400, "Measurement date cannot be before the learner's date of birth.");
      }
      const bmiAssessment = calculateBmiForAge({
        birthdate: birthdateText,
        gender: cellText(row.getCell(columns.gender).value),
        measurementDate,
        weightKg: savedWeightKg,
        heightM: savedHeightM,
      });
      row.getCell(columns.nutritionWeightKg).value = savedWeightKg;
      row.getCell(columns.nutritionHeightM).value = savedHeightM;
      row.getCell(columns.nutritionMeasurementDate).value = measurementDate;
      await saveDatabaseWorkbook(workbook);
      const heightSquaredM2 = savedHeightM ** 2;
      return {
        studentId,
        measurementDate,
        weightKg: savedWeightKg,
        heightM: savedHeightM,
        heightSquaredM2: Math.round(heightSquaredM2 * 10000) / 10000,
        bmi: Math.round((savedWeightKg / heightSquaredM2) * 100) / 100,
        ...bmiAssessment,
      };
    });
  }

  async function exportNutritionalStatusSF8(session, requestedAssessmentDate, sectionFilter) {
    const roster = await listStudents(session);
    const students = roster.students.filter((student) => matchesStudentSection(student, sectionFilter));
    if (!students.length) {
      throw new HttpError(400, "Add learners to the selected section before generating the SF8.");
    }
    const today = new Date();
    const assessmentDate = requestedAssessmentDate || [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, "0"),
      String(today.getDate()).padStart(2, "0"),
    ].join("-");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(assessmentDate)
      || !Number.isFinite(Date.parse(`${assessmentDate}T00:00:00.000Z`))
      || new Date(`${assessmentDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== assessmentDate) {
      throw new HttpError(400, "Choose a valid date of assessment.");
    }

    const maleStudents = students.filter((student) => student.gender === "Male");
    const femaleStudents = students.filter((student) => student.gender === "Female");
    if (maleStudents.length + femaleStudents.length !== students.length) {
      throw new HttpError(400, "The SF8 template supports Male and Female roster sections only.");
    }

    const teacherProfile = await getTeacherProfile(session);
    if (sectionFilter && sectionFilter !== "__all__") {
      teacherProfile.section = sectionFilter === "__unassigned__" ? "" : sectionFilter;
      const sectionGrade = Object.entries(roster.sectionGrades).find(([section]) =>
        section.toLocaleLowerCase() === teacherProfile.section.toLocaleLowerCase());
      if (sectionGrade) teacherProfile.grade = sectionGrade[1];
    }
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(SF8_TEMPLATE_PATH);
    } catch (error) {
      throw new Error(`The SF8 template could not be read: ${error.message}`);
    }
    const sheet = workbook.getWorksheet("Nutritional Status") || workbook.worksheets[0];
    const learnerNameHeader = sheet && sheet.getCell("C10").value;
    const learnerNameHeaderText = learnerNameHeader && Array.isArray(learnerNameHeader.richText)
      ? learnerNameHeader.richText.map((part) => part.text || "").join("")
      : cellText(learnerNameHeader);
    const findRow = (column, label, startRow = 1) => {
      for (let rowNumber = startRow; rowNumber <= (sheet?.rowCount || 0); rowNumber += 1) {
        if (cellText(sheet.getCell(rowNumber, column).value).trim().toUpperCase() === label) {
          return rowNumber;
        }
      }
      return null;
    };
    const maleHeaderRow = findRow(1, "MALE");
    const femaleHeaderRow = findRow(1, "FEMALE", (maleHeaderRow || 0) + 1);
    const summaryHeaderRow = findRow(1, "SUMMARY TABLE");
    const summaryMaleRow = findRow(1, "MALE", (summaryHeaderRow || 0) + 1);
    const summaryFemaleRow = findRow(1, "FEMALE", (summaryHeaderRow || 0) + 1);
    const summaryTotalRow = findRow(1, "TOTAL", (summaryHeaderRow || 0) + 1);
    const maleFirstRow = (maleHeaderRow || 0) + 1;
    const maleLastRow = (femaleHeaderRow || 0) - 1;
    const femaleFirstRow = (femaleHeaderRow || 0) + 1;
    const femaleLastRow = (summaryHeaderRow || 0) - 2;
    if (
      !sheet
      || !normalizeHeader(cellText(sheet.getCell("A1").value)).includes("sf8")
      || !normalizeHeader(learnerNameHeaderText).includes("learnersname")
      || !normalizeHeader(cellText(sheet.getCell("M10").value)).includes("bmicategory")
      || !normalizeHeader(cellText(sheet.getCell("N10").value)).includes("heightforage")
      || !maleHeaderRow
      || !femaleHeaderRow
      || !summaryHeaderRow
      || !summaryMaleRow
      || !summaryFemaleRow
      || !summaryTotalRow
      || cellText(sheet.getCell("E32").value) !== "Conducted/Assessed By:"
      || cellText(sheet.getCell("M32").value) !== "Checked and Reviewed By:"
      || maleLastRow < maleFirstRow
      || femaleLastRow < femaleFirstRow
    ) {
      throw new Error("The project SF8 template does not match the expected worksheet layout.");
    }
    const maleCapacity = maleLastRow - maleFirstRow + 1;
    const femaleCapacity = femaleLastRow - femaleFirstRow + 1;
    const maleRowDelta = maleStudents.length - maleCapacity;
    const femaleRowDelta = femaleStudents.length - femaleCapacity;
    const captureRowTemplate = (rowNumber) => {
      const row = sheet.getRow(rowNumber);
      return {
        height: row.height,
        hidden: row.hidden,
        outlineLevel: row.outlineLevel,
        cells: Array.from({ length: 15 }, (_, index) => row.getCell(index + 1).style),
        merges: sheet.model.merges
          .map((range) => range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/))
          .filter((match) => match && Number(match[2]) === rowNumber && Number(match[4]) === rowNumber)
          .map((match) => [match[1], match[3]]),
      };
    };
    const maleRowTemplate = captureRowTemplate(maleFirstRow + 1);
    const maleLastRowTemplate = captureRowTemplate(maleLastRow);
    const femaleRowTemplate = captureRowTemplate(femaleFirstRow + 1);
    const femaleLastRowTemplate = captureRowTemplate(femaleLastRow);
    const applyRowTemplate = (rowNumber, template, copyMerges = true) => {
      const row = sheet.getRow(rowNumber);
      row.height = template.height;
      row.hidden = template.hidden;
      row.outlineLevel = template.outlineLevel;
      template.cells.forEach((style, index) => {
        row.getCell(index + 1).style = style;
      });
      if (copyMerges) {
        for (const [firstColumn, lastColumn] of template.merges) {
          sheet.mergeCells(`${firstColumn}${rowNumber}:${lastColumn}${rowNumber}`);
        }
      }
    };
    const movableMerges = sheet.model.merges
      .filter((range) => Number(range.match(/\d+/)?.[0]) >= maleFirstRow);
    for (const range of movableMerges) sheet.unMergeCells(range);

    if (maleRowDelta > 0) {
      sheet.insertRows(femaleHeaderRow, Array.from({ length: maleRowDelta }, () => []));
      applyRowTemplate(maleLastRow, maleRowTemplate, false);
      for (let index = 0; index < maleRowDelta; index += 1) {
        applyRowTemplate(
          femaleHeaderRow + index,
          index === maleRowDelta - 1 ? maleLastRowTemplate : maleRowTemplate,
        );
      }
    } else if (maleRowDelta < 0) {
      sheet.spliceRows(femaleHeaderRow + maleRowDelta, -maleRowDelta);
    }
    const adjustedFemaleHeaderRow = femaleHeaderRow + maleRowDelta;
    if (femaleRowDelta > 0) {
      const firstInsertedFemaleRow = summaryHeaderRow + maleRowDelta - 1;
      sheet.insertRows(firstInsertedFemaleRow, Array.from({ length: femaleRowDelta }, () => []));
      applyRowTemplate(femaleLastRow + maleRowDelta, femaleRowTemplate, false);
      for (let index = 0; index < femaleRowDelta; index += 1) {
        applyRowTemplate(
          firstInsertedFemaleRow + index,
          index === femaleRowDelta - 1 ? femaleLastRowTemplate : femaleRowTemplate,
        );
      }
    } else if (femaleRowDelta < 0) {
      sheet.spliceRows(
        adjustedFemaleHeaderRow + 1 + femaleStudents.length,
        -femaleRowDelta,
      );
    }
    if (maleRowDelta) {
      const conditionalFormattings = sheet.conditionalFormattings;
      for (let index = conditionalFormattings.length - 1; index >= 0; index -= 1) {
        const formatting = conditionalFormattings[index];
        const match = formatting.ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
        if (!match || Number(match[2]) <= maleFirstRow || Number(match[4]) !== maleLastRow) continue;
        const lastRow = Number(match[4]) + maleRowDelta;
        if (lastRow < Number(match[2])) {
          conditionalFormattings.splice(index, 1);
        } else {
          formatting.ref = `${match[1]}${match[2]}:${match[3]}${lastRow}`;
        }
      }
    }
    const summaryRowDelta = maleRowDelta + femaleRowDelta;
    for (const range of movableMerges) {
      const match = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (!match) continue;
      const startRow = Number(match[2]);
      const endRow = Number(match[4]);
      let rowDelta;
      if (startRow >= maleFirstRow && startRow <= maleLastRow) {
        if (startRow >= maleFirstRow + maleStudents.length) continue;
        rowDelta = 0;
      } else if (startRow >= femaleHeaderRow && startRow <= femaleLastRow) {
        if (
          startRow > femaleHeaderRow
          && startRow >= femaleFirstRow + femaleStudents.length
        ) continue;
        rowDelta = maleRowDelta;
      } else {
        rowDelta = startRow > femaleLastRow ? summaryRowDelta : 0;
      }
      sheet.mergeCells(
        `${match[1]}${startRow + rowDelta}:${match[3]}${endRow + rowDelta}`,
      );
    }
    const adjustedMaleFirstRow = maleHeaderRow + 1;
    const adjustedFemaleFirstRow = adjustedFemaleHeaderRow + 1;
    const adjustedSummaryMaleRow = summaryMaleRow + summaryRowDelta;
    const adjustedSummaryFemaleRow = summaryFemaleRow + summaryRowDelta;
    const adjustedSummaryTotalRow = summaryTotalRow + summaryRowDelta;

    for (const otherSheet of workbook.worksheets.slice()) {
      if (otherSheet.id !== sheet.id) workbook.removeWorksheet(otherSheet.id);
    }
    sheet.getCell("E5").value = teacherProfile.schoolName || null;
    sheet.getCell("I5").value = teacherProfile.district || null;
    sheet.getCell("L5").value = teacherProfile.division || null;
    sheet.getCell("O5").value = teacherProfile.region || null;
    sheet.getCell("C7").value = teacherProfile.schoolId || null;
    sheet.getCell("F7").value = teacherProfile.grade || null;
    sheet.getCell("H7").value = teacherProfile.section || null;
    sheet.getCell("O7").value = teacherProfile.schoolYear || null;

    const ageAtMeasurement = (birthdate, measurementDate) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(birthdate || "")
        || !/^\d{4}-\d{2}-\d{2}$/.test(measurementDate || "")) return null;
      const birth = new Date(`${birthdate}T00:00:00.000Z`);
      const measured = new Date(`${measurementDate}T00:00:00.000Z`);
      if (!Number.isFinite(birth.getTime()) || !Number.isFinite(measured.getTime())
        || measured < birth) return null;
      let age = measured.getUTCFullYear() - birth.getUTCFullYear();
      if (measured.getUTCMonth() < birth.getUTCMonth()
        || (measured.getUTCMonth() === birth.getUTCMonth()
          && measured.getUTCDate() < birth.getUTCDate())) age -= 1;
      return age;
    };
    const countStatuses = (group, categories, key) => categories.map((category) =>
      group.filter((student) => student.measurementDate
        && student[key] === category).length);
    const writeStudents = (group, firstRow) => {
      for (let index = 0; index < group.length; index += 1) {
        const row = sheet.getRow(firstRow + index);
        for (let column = 1; column <= 15; column += 1) {
          row.getCell(column).value = null;
        }
        const student = group[index];
        if (!student) continue;
        const name = [
          student.lastName,
          student.firstName,
          student.middleName,
        ].filter(Boolean);
        const nameText = name.length > 1
          ? `${name.shift()}, ${name.join(" ")}`
          : name[0] || "";
        const nameCell = row.getCell(3);
        nameCell.value = nameText || null;
        row.getCell(1).value = index + 1;
        row.getCell(2).value = student.lrn || null;
        row.getCell(7).value = student.birthdate
          ? new Date(`${student.birthdate}T00:00:00.000Z`)
          : null;
        row.getCell(8).value = ageAtMeasurement(student.birthdate, assessmentDate);
        row.getCell(15).value = student.remarks || null;
        if (!student.measurementDate) continue;
        row.getCell(9).value = student.weightKg || null;
        row.getCell(10).value = student.heightM || null;
        row.getCell(11).value = student.heightSquaredM2 || null;
        row.getCell(12).value = student.bmi || null;
        row.getCell(13).value = student.bmiCategory || null;
        row.getCell(14).value = student.heightForAgeStatus || null;
        if (nameText.length > 30) {
          const estimatedLines = Math.ceil(nameText.length / 30);
          row.height = Math.max(row.height || 15, Math.min(60, estimatedLines * 15));
        }
      }
    };
    writeStudents(maleStudents, adjustedMaleFirstRow);
    writeStudents(femaleStudents, adjustedFemaleFirstRow);

    const bmiCategories = ["Severely Wasted", "Wasted", "Normal", "Overweight", "Obese"];
    const heightCategories = ["Severely Stunted", "Stunted", "Normal", "Tall"];
    const maleBmi = countStatuses(maleStudents, bmiCategories, "bmiCategory");
    const femaleBmi = countStatuses(femaleStudents, bmiCategories, "bmiCategory");
    const maleHeight = countStatuses(maleStudents, heightCategories, "heightForAgeStatus");
    const femaleHeight = countStatuses(femaleStudents, heightCategories, "heightForAgeStatus");
    for (const [rowNumber, bmiCounts, heightCounts] of [
      [adjustedSummaryMaleRow, maleBmi, maleHeight],
      [adjustedSummaryFemaleRow, femaleBmi, femaleHeight],
    ]) {
      sheet.getCell(rowNumber, 3).value = bmiCounts[0];
      sheet.getCell(rowNumber, 5).value = bmiCounts[1];
      sheet.getCell(rowNumber, 6).value = bmiCounts[2];
      sheet.getCell(rowNumber, 7).value = bmiCounts[3];
      sheet.getCell(rowNumber, 8).value = bmiCounts[4];
      sheet.getCell(rowNumber, 9).value = bmiCounts.reduce((sum, count) => sum + count, 0);
      heightCounts.forEach((count, index) => sheet.getCell(rowNumber, 10 + index).value = count);
      sheet.getCell(rowNumber, 14).value = heightCounts.reduce((sum, count) => sum + count, 0);
    }
    for (const column of [3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      sheet.getCell(adjustedSummaryTotalRow, column).value =
        Number(sheet.getCell(adjustedSummaryMaleRow, column).value || 0)
        + Number(sheet.getCell(adjustedSummaryFemaleRow, column).value || 0);
    }

    const assessmentDateCell = sheet.getCell(32 + summaryRowDelta, 2);
    const [assessmentYear, assessmentMonth, assessmentDay] = assessmentDate.split("-");
    assessmentDateCell.value = `${assessmentMonth}/${assessmentDay}/${assessmentYear}`;
    sheet.getCell(34 + summaryRowDelta, 5).value = teacherProfile.name || null;
    sheet.getCell(35 + summaryRowDelta, 5).value = teacherProfile.position || null;
    sheet.getCell(34 + summaryRowDelta, 13).value = teacherProfile.schoolHead || null;
    sheet.getCell(35 + summaryRowDelta, 13).value = teacherProfile.schoolHeadPosition || null;
    sheet.pageSetup.firstPageNumber = undefined;
    workbook.calcProperties = { fullCalcOnLoad: true };
    const filenamePart = (value) => value.trim()
      .replace(/[^A-Za-z0-9-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "Class";
    const generatedAt = new Date().toISOString().replace(/[-:.]/g, "");
    const filename = `SF8_${filenamePart(teacherProfile.grade)}_${filenamePart(teacherProfile.section)}_${filenamePart(teacherProfile.schoolYear)}_${assessmentDate}_${generatedAt}.xlsx`;
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await fs.mkdir(generatedReportsDirectory, { recursive: true });
    const outputPath = path.join(generatedReportsDirectory, filename);
    const temporaryPath = `${outputPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, buffer, { flag: "wx" });
      await fs.rename(temporaryPath, outputPath);
    } catch (error) {
      try {
        await fs.rm(temporaryPath, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "The SF8 report could not be saved and its temporary file could not be removed.",
        );
      }
      throw error;
    }
    return {
      buffer,
      filename,
      filePath: outputPath,
      incompleteMeasurementCount: students.filter((student) =>
        !student.measurementDate || !student.weightKg || !student.heightM || !student.bmi).length,
    };
  }

  async function deleteStudent(session, studentId, data) {
    const password = typeof data.password === "string" ? data.password : "";
    if (password.length < 6 || password.length > 256) {
      throw new HttpError(400, "Enter your current password.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
      let userRow = null;
      for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
        const row = userSheet.getRow(rowNumber);
        if (cellText(row.getCell(userColumns.id).value) === session.userId) {
          userRow = row;
          break;
        }
      }
      if (!userRow || cellText(userRow.getCell(userColumns.role).value).toLowerCase() !== "teacher") {
        throw new HttpError(404, "The teacher account could not be found.");
      }
      const matches = await verifyPassword(password, cellText(userRow.getCell(userColumns.password).value));
      if (!matches) throw new HttpError(400, "Your password doesn't match.");

      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const studentRow = findOwnedStudent(studentSheet, studentColumns, session, studentId);
      const relatedSheets = [
        ["Term Grades", getGradeSheet],
        ["Term Grade Locks", getGradeLockSheet],
        ["Reading Assessments", getReadingAssessmentSheet],
        ["PHIL-IRI Assessments", getPhilIriAssessmentSheet],
        ["Math Assessments", getMathAssessmentSheet],
        ["Attendance Records", getAttendanceSheet],
        ["Attendance Monthly Notes", getAttendanceNotesSheet],
      ];
      for (const [sheetName, getSheet] of relatedSheets) {
        if (!workbook.getWorksheet(sheetName)) continue;
        const { sheet: relatedSheet, columns } = getSheet(workbook);
        for (let rowNumber = relatedSheet.rowCount; rowNumber >= 2; rowNumber -= 1) {
          const row = relatedSheet.getRow(rowNumber);
          if (cellText(row.getCell(columns.classId).value) === session.classId
            && cellText(row.getCell(columns.studentId).value) === studentId) {
            relatedSheet.spliceRows(rowNumber, 1);
          }
        }
      }
      studentSheet.spliceRows(studentRow.number, 1);
      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      const classRow = findTeacherClassRow(classSheet, classColumns, session);
      if (classRow) {
        classRow.getCell(classColumns.students).value = Math.max(
          0,
          (Number(classRow.getCell(classColumns.students).value) || 0) - 1,
        );
      }
      await saveDatabaseWorkbook(workbook);
      return { deleted: 1 };
    });
  }

  async function verifyRosterClearPassword(session, data) {
    const password = typeof data.password === "string" ? data.password : "";
    if (password.length < 6 || password.length > 256) {
      throw new HttpError(400, "Enter your current password.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getUserSheet(workbook);
      let userRow = null;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (cellText(row.getCell(columns.id).value) === session.userId) {
          userRow = row;
          break;
        }
      }
      if (!userRow || cellText(userRow.getCell(columns.role).value).toLowerCase() !== "teacher") {
        throw new HttpError(404, "The teacher account could not be found.");
      }
      const matches = await verifyPassword(password, cellText(userRow.getCell(columns.password).value));
      if (!matches) throw new HttpError(400, "Your password doesn't match.");
      return { verified: true };
    });
  }

  async function clearStudentRoster(session, data) {
    const password = typeof data.password === "string" ? data.password : "";
    const requestedSection = typeof data.section === "string" ? data.section.trim() : "";
    if (password.length < 6 || password.length > 256) {
      throw new HttpError(400, "Enter your current password.");
    }
    if (!requestedSection) throw new HttpError(400, "Select a roster scope before clearing students.");
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
      let userRow = null;
      for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
        const row = userSheet.getRow(rowNumber);
        if (cellText(row.getCell(userColumns.id).value) === session.userId) {
          userRow = row;
          break;
        }
      }
      if (!userRow || cellText(userRow.getCell(userColumns.role).value).toLowerCase() !== "teacher") {
        throw new HttpError(404, "The teacher account could not be found.");
      }
      const matches = await verifyPassword(password, cellText(userRow.getCell(userColumns.password).value));
      if (!matches) throw new HttpError(400, "Your password doesn't match.");

      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      const classRow = findTeacherClassRow(classSheet, classColumns, session);
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      let sectionFilter = requestedSection;
      if (requestedSection !== "__all__" && requestedSection !== "__unassigned__") {
        const matchedSection = getHandledSections(classRow, classColumns).find((section) =>
          section.toLocaleLowerCase() === requestedSection.toLocaleLowerCase());
        if (!matchedSection) throw new HttpError(400, "Choose a section handled by this classroom.");
        sectionFilter = matchedSection;
      }

      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const studentIds = new Set();
      const studentRowsToDelete = [];
      const isOwnedClassStudent = (row) => {
        const ownerId = cellText(row.getCell(studentColumns.teacherUserId).value);
        return cellText(row.getCell(studentColumns.classId).value) === session.classId
          && (!ownerId || ownerId === session.userId);
      };
      const clearSectionMetadata = (sectionsToRemove) => {
        const removedKeys = new Set(sectionsToRemove.map((section) => section.toLocaleLowerCase()));
        const sectionsHandled = getHandledSections(classRow, classColumns)
          .filter((section) => !removedKeys.has(section.toLocaleLowerCase()));
        const sectionGrades = readStoredSectionGrades(classRow.getCell(classColumns.sectionGrades).value);
        removedKeys.forEach((section) => sectionGrades.delete(section));
        const primarySection = cellText(classRow.getCell(classColumns.section).value);
        if (removedKeys.has(primarySection.toLocaleLowerCase())) {
          classRow.getCell(classColumns.section).value = null;
        }
        const sectionSubjects = readStoredSectionSubjects(
          classRow.getCell(classColumns.subjectsHandled).value,
          primarySection,
        );
        Object.keys(sectionSubjects).forEach((section) => {
          if (removedKeys.has(section.toLocaleLowerCase())) delete sectionSubjects[section];
        });
        classRow.getCell(classColumns.sectionsHandled).value = JSON.stringify(sectionsHandled);
        classRow.getCell(classColumns.sectionGrades).value = JSON.stringify(serializeSectionGrades(sectionGrades));
        classRow.getCell(classColumns.subjectsHandled).value = JSON.stringify(sectionSubjects);
        return { sectionsHandled, sectionGrades, sectionSubjects };
      };
      for (let rowNumber = 2; rowNumber <= studentSheet.rowCount; rowNumber += 1) {
        const row = studentSheet.getRow(rowNumber);
        if (
          isOwnedClassStudent(row)
          && matchesStudentSection({ section: cellText(row.getCell(studentColumns.section).value) }, sectionFilter)
        ) {
          const studentId = cellText(row.getCell(studentColumns.id).value);
          if (studentId) studentIds.add(studentId);
          studentRowsToDelete.push(rowNumber);
        }
      }
      if (!studentRowsToDelete.length) {
        const hasClassStudents = studentSheet.getRows(2, Math.max(0, studentSheet.rowCount - 1))
          ?.some(isOwnedClassStudent) || false;
        const existingSections = getHandledSections(classRow, classColumns);
        const removedSection = !hasClassStudents && existingSections.length > 0;
        if (removedSection) {
          clearSectionMetadata(existingSections);
          await saveDatabaseWorkbook(workbook);
        }
        return {
          deleted: 0,
          removedSection,
          sectionsHandled: getHandledSections(classRow, classColumns),
          sectionGrades: getSectionGrades(classRow, classColumns),
          sectionSubjects: readStoredSectionSubjects(
            classRow.getCell(classColumns.subjectsHandled).value,
            cellText(classRow.getCell(classColumns.section).value),
          ),
          primarySection: cellText(classRow.getCell(classColumns.section).value),
        };
      }

      const relatedSheets = [
        ["Term Grades", getGradeSheet, "studentId"],
        ["Term Grade Locks", getGradeLockSheet, "studentId"],
        ["Reading Assessments", getReadingAssessmentSheet, "studentId"],
        ["PHIL-IRI Assessments", getPhilIriAssessmentSheet, "studentId"],
        ["Math Assessments", getMathAssessmentSheet, "studentId"],
        ["Attendance Records", getAttendanceSheet, "studentId"],
        ["Attendance Monthly Notes", getAttendanceNotesSheet, "studentId"],
      ];
      for (const [sheetName, getSheet, studentIdColumn] of relatedSheets) {
        if (!studentIds.size) break;
        if (!workbook.getWorksheet(sheetName)) continue;
        const { sheet: relatedSheet, columns } = getSheet(workbook);
        const rowsToDelete = [];
        for (let rowNumber = 2; rowNumber <= relatedSheet.rowCount; rowNumber += 1) {
          const row = relatedSheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) === session.classId
            && studentIds.has(cellText(row.getCell(columns[studentIdColumn]).value))
          ) {
            rowsToDelete.push(rowNumber);
          }
        }
        rowsToDelete.sort((left, right) => right - left)
          .forEach((rowNumber) => relatedSheet.spliceRows(rowNumber, 1));
      }
      studentRowsToDelete.sort((left, right) => right - left)
        .forEach((rowNumber) => studentSheet.spliceRows(rowNumber, 1));

      const remainingClassRows = studentSheet.getRows(2, Math.max(0, studentSheet.rowCount - 1)) || [];
      const remainingClassStudents = remainingClassRows.filter(isOwnedClassStudent);
      let removedSection = false;
      if (!remainingClassStudents.length) {
        removedSection = getHandledSections(classRow, classColumns).length > 0;
        clearSectionMetadata(getHandledSections(classRow, classColumns));
      } else if (sectionFilter !== "__all__" && sectionFilter !== "__unassigned__") {
        const remainingStudentsInSection = remainingClassStudents.some((row) =>
          matchesStudentSection({ section: cellText(row.getCell(studentColumns.section).value) }, sectionFilter));
        if (!remainingStudentsInSection) {
          clearSectionMetadata([sectionFilter]);
          removedSection = true;
        }
      }

      for (let rowNumber = 2; rowNumber <= classSheet.rowCount; rowNumber += 1) {
        const row = classSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(classColumns.id).value) === session.classId
          && cellText(row.getCell(classColumns.teacherId).value) === session.userId
        ) {
          row.getCell(classColumns.students).value = Math.max(
            0,
            (Number(row.getCell(classColumns.students).value) || 0) - studentRowsToDelete.length,
          );
          break;
        }
      }
      await saveDatabaseWorkbook(workbook);
      return {
        deleted: studentRowsToDelete.length,
        removedSection,
        sectionsHandled: getHandledSections(classRow, classColumns),
        sectionGrades: getSectionGrades(classRow, classColumns),
        sectionSubjects: readStoredSectionSubjects(
          classRow.getCell(classColumns.subjectsHandled).value,
          cellText(classRow.getCell(classColumns.section).value),
        ),
        primarySection: cellText(classRow.getCell(classColumns.section).value),
      };
    });
  }

  async function getParentPortal(session) {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
      let parent = null;
      for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
        const row = userSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(userColumns.id).value) === session.userId
          && cellText(row.getCell(userColumns.role).value).toLowerCase() === "parent"
          && cellText(row.getCell(userColumns.classId).value) === session.classId
          && cellText(row.getCell(userColumns.status).value).toLowerCase() === "active"
        ) {
          parent = row;
          break;
        }
      }
      if (!parent) throw new HttpError(404, "The parent account could not be found.");

      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      let classroom = null;
      for (let rowNumber = 2; rowNumber <= classSheet.rowCount; rowNumber += 1) {
        const row = classSheet.getRow(rowNumber);
        if (cellText(row.getCell(classColumns.id).value) === session.classId) {
          classroom = {
            number: cellText(row.getCell(classColumns.classroom).value),
            teacherName: cellText(row.getCell(classColumns.teacherName).value),
            teacherId: cellText(row.getCell(classColumns.teacherId).value),
            grade: cellText(row.getCell(classColumns.grade).value),
            strand: cellText(row.getCell(classColumns.strand).value),
          };
          break;
        }
      }
      if (!classroom) throw new HttpError(404, "The class linked to this parent account could not be found.");

      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const learners = [];
      const learnersById = new Map();
      for (let rowNumber = 2; rowNumber <= studentSheet.rowCount; rowNumber += 1) {
        const row = studentSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(studentColumns.classId).value) !== session.classId
          || cellText(row.getCell(studentColumns.teacherUserId).value) !== classroom.teacherId
          || cellText(row.getCell(studentColumns.parentUserId).value) !== session.userId
        ) continue;
        const learner = {
          id: cellText(row.getCell(studentColumns.id).value),
          name: cellText(row.getCell(studentColumns.name).value),
          profile: STUDENT_FIELDS.filter(([key]) => key !== "teacherUserId").map(([key, label]) => {
            const value = row.getCell(studentColumns[key]).value;
            return {
              label,
              value: key === "birthdate" && value instanceof Date
                ? value.toISOString().slice(0, 10)
                : cellText(value),
            };
          }),
          grades: Object.fromEntries(GRADE_TERMS.map((term) => [
            term,
            Object.fromEntries(gradeSubjectsForGrade(classroom.grade, classroom.strand).map(([key]) => [key, ""])),
          ])),
          reading: Object.fromEntries(READING_PERIODS.map((period) => [
            period,
            Object.fromEntries(READING_LANGUAGES.map((language) => [
              language,
              { level: "", assessedDate: "", attempts: [] },
            ])),
          ])),
          philIri: Object.fromEntries(READING_PERIODS.map((period) => [
            period,
            Object.fromEntries(PHILIRI_ASSESSMENT_TYPES.map((assessmentType) => [
              assessmentType,
              Object.fromEntries(READING_LANGUAGES.map((language) => [language, null])),
            ])),
          ])),
          attendance: [],
        };
        learners.push(learner);
        learnersById.set(learner.id, learner);
      }

      const gradesSheet = workbook.getWorksheet("Term Grades");
      if (gradesSheet) {
        const { columns } = getGradeSheet(workbook);
        for (let rowNumber = 2; rowNumber <= gradesSheet.rowCount; rowNumber += 1) {
          const row = gradesSheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) !== session.classId
            || cellText(row.getCell(columns.teacherUserId).value) !== classroom.teacherId
          ) continue;
          const learner = learnersById.get(cellText(row.getCell(columns.studentId).value));
          const term = cellText(row.getCell(columns.term).value);
          const subject = cellText(row.getCell(columns.subject).value);
          if (!learner || !Object.hasOwn(learner.grades, term)
            || !Object.hasOwn(learner.grades[term], subject)) continue;
          const value = row.getCell(columns.grade).value;
          learner.grades[term][subject] = value === null || value === undefined || value === ""
            ? ""
            : Number(value);
        }
      }
      if (!/^grade\s*3$/i.test(classroom.grade.trim())) {
        for (const learner of learners) {
          for (const term of GRADE_TERMS) {
            const music = learner.grades[term].musicAndArts;
            const pe = learner.grades[term].physicalEducationAndHealth;
            learner.grades[term].mapeh = typeof music === "number" && typeof pe === "number"
              ? Math.round(((music + pe) / 2) * 100) / 100
              : "";
          }
        }
      }

      const readingSheet = workbook.getWorksheet("Reading Assessments");
      if (readingSheet) {
        const { columns } = getReadingAssessmentSheet(workbook);
        for (let rowNumber = 2; rowNumber <= readingSheet.rowCount; rowNumber += 1) {
          const row = readingSheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) !== session.classId
            || cellText(row.getCell(columns.teacherUserId).value) !== classroom.teacherId
          ) continue;
          const learner = learnersById.get(cellText(row.getCell(columns.studentId).value));
          const period = cellText(row.getCell(columns.period).value);
          const language = cellText(row.getCell(columns.language).value);
          if (!learner || !Object.hasOwn(learner.reading, period)
            || !Object.hasOwn(learner.reading[period], language)) continue;
          const assessed = row.getCell(columns.assessed).value;
          const rawAttemptNo = Number(row.getCell(columns.attempt).value);
          const attemptNo = Number.isSafeInteger(rawAttemptNo) && rawAttemptNo > 0 ? rawAttemptNo : 1;
          const attempt = {
            attemptNo,
            level: cellText(row.getCell(columns.level).value),
            assessedDate: assessed instanceof Date ? assessed.toISOString().slice(0, 10) : cellText(assessed),
          };
          const languageReading = learner.reading[period][language];
          languageReading.attempts.push(attempt);
          if (!languageReading.level || attemptNo >= languageReading.attemptNo) {
            languageReading.level = attempt.level;
            languageReading.assessedDate = attempt.assessedDate;
            languageReading.attemptNo = attemptNo;
          }
        }
      }
      for (const learner of learners) {
        for (const period of READING_PERIODS) {
          for (const language of READING_LANGUAGES) {
            learner.reading[period][language].attempts.sort((left, right) => left.attemptNo - right.attemptNo);
          }
        }
      }

      const philIriSheet = workbook.getWorksheet("PHIL-IRI Assessments");
      if (philIriSheet) {
        const { columns } = getPhilIriAssessmentSheet(workbook);
        for (let rowNumber = 2; rowNumber <= philIriSheet.rowCount; rowNumber += 1) {
          const row = philIriSheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) !== session.classId
            || cellText(row.getCell(columns.teacherUserId).value) !== classroom.teacherId
          ) continue;
          const learner = learnersById.get(cellText(row.getCell(columns.studentId).value));
          const period = cellText(row.getCell(columns.period).value);
          const assessmentType = cellText(row.getCell(columns.assessmentType).value);
          const language = cellText(row.getCell(columns.language).value);
          if (!learner || !Object.hasOwn(learner.philIri, period)
            || !Object.hasOwn(learner.philIri[period], assessmentType)
            || !Object.hasOwn(learner.philIri[period][assessmentType], language)) continue;
          const data = parsePhilIriData(row.getCell(columns.data).value, rowNumber);
          const assessed = row.getCell(columns.assessed).value;
          learner.philIri[period][assessmentType][language] = {
            assessedDate: assessed instanceof Date ? assessed.toISOString().slice(0, 10) : cellText(assessed),
            readingLevel: cellText(row.getCell(columns.level).value),
            gst: data.gst || null,
            individualized: data.individualized || {},
            intervention: data.intervention || {},
            autoScoring: data.autoScoring || null,
          };
        }
      }

      const attendanceSheet = workbook.getWorksheet("Attendance Records");
      if (attendanceSheet) {
        const { columns } = getAttendanceSheet(workbook);
        for (let rowNumber = 2; rowNumber <= attendanceSheet.rowCount; rowNumber += 1) {
          const row = attendanceSheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) !== session.classId
            || cellText(row.getCell(columns.teacherUserId).value) !== classroom.teacherId
          ) continue;
          const learner = learnersById.get(cellText(row.getCell(columns.studentId).value));
          if (!learner) continue;
          const recordedDate = row.getCell(columns.date).value;
          const attendanceRecord = {
            date: recordedDate instanceof Date
              ? recordedDate.toISOString().slice(0, 10)
              : cellText(recordedDate),
            status: normalizeAttendanceStatus(row.getCell(columns.status).value),
            reason: cellText(row.getCell(columns.reason).value),
          };
          learner.attendance.push(attendanceRecord);
        }
      }
      for (const learner of learners) {
        learner.attendance.sort((left, right) => right.date.localeCompare(left.date));
      }

      return {
        parentName: cellText(parent.getCell(userColumns.name).value),
        email: cellText(parent.getCell(userColumns.email).value),
        classroomNumber: classroom.number,
        grade: classroom.grade,
        teacherName: classroom.teacherName,
        learners,
        gradeTerms: GRADE_TERMS,
        strand: classroom.strand,
        gradeSubjects: gradeSummarySubjectsForGrade(classroom.grade, classroom.strand).map(([key, label]) => ({ key, label })),
        generalAverageSubjects: generalAverageSubjectsForGrade(classroom.grade, classroom.strand),
        readingPeriods: READING_PERIODS,
        readingLanguages: READING_LANGUAGES,
      };
    });
  }

  async function unlinkStudentParent(session, studentId) {
    if (!studentId || studentId.length > 40) {
      throw new HttpError(400, "Choose a student from your class roster.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const student = findOwnedStudent(studentSheet, studentColumns, session, studentId);
      student.getCell(studentColumns.teacherUserId).value = session.userId;
      student.getCell(studentColumns.parentUserId).value = null;
      await saveDatabaseWorkbook(workbook);
      return { unlinked: true };
    });
  }

  async function linkStudentParent(session, studentId, data) {
    if (!studentId || studentId.length > 40) {
      throw new HttpError(400, "Choose a student from your class roster.");
    }
    const parentUserId = typeof data.parentUserId === "string" ? data.parentUserId.trim() : "";
    if (parentUserId.length > 40) throw new HttpError(400, "Choose a valid parent account.");
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const student = findOwnedStudent(studentSheet, studentColumns, session, studentId);
      if (parentUserId) {
        const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
        let parentFound = false;
        for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
          const row = userSheet.getRow(rowNumber);
          if (
            cellText(row.getCell(userColumns.id).value) === parentUserId
            && cellText(row.getCell(userColumns.role).value).toLowerCase() === "parent"
            && cellText(row.getCell(userColumns.classId).value) === session.classId
            && cellText(row.getCell(userColumns.status).value).toLowerCase() === "active"
          ) {
            parentFound = true;
            break;
          }
        }
        if (!parentFound) throw new HttpError(400, "Choose an active parent account registered with your class.");
      }
      student.getCell(studentColumns.teacherUserId).value = session.userId;
      student.getCell(studentColumns.parentUserId).value = parentUserId || null;
      await saveDatabaseWorkbook(workbook);
      return { saved: true, parentUserId };
    });
  }

  function writeStudents(workbook, session, students) {
    const { sheet, columns } = getStudentSheet(workbook);
    const added = [];
    for (const student of students) {
      const values = [];
      values[columns.id] = nextStudentId(sheet, columns.id);
      values[columns.name] = [student.lastName, student.firstName, student.middleName]
        .filter(Boolean)
        .join(", ");
      values[columns.classId] = session.classId;
      values[columns.parentUserId] = null;
      values[columns.section] = student.section || null;
      for (const [key] of STUDENT_FIELDS) {
        if (key === "teacherUserId") {
          values[columns[key]] = session.userId;
        } else if (key === "birthdate") {
          values[columns[key]] = student.birthdate;
        } else {
          values[columns[key]] = student[key] || null;
        }
      }
      const row = writeRow(sheet, [columns.id, columns.lrn], values);

      added.push({
        id: cellText(row.getCell(columns.id).value),
        name: cellText(row.getCell(columns.name).value),
        ...student,
        birthdate: student.birthdate.toISOString().slice(0, 10),
        teacherUserId: session.userId,
      });
    }

    if (added.length) {
      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      for (let rowNumber = 2; rowNumber <= classSheet.rowCount; rowNumber += 1) {
        const classRow = classSheet.getRow(rowNumber);
        if (cellText(classRow.getCell(classColumns.id).value) === session.classId) {
          for (let index = 0; index < added.length; index += 1) {
            incrementCell(classRow.getCell(classColumns.students));
          }
          break;
        }
      }
    }
    return added;
  }

  async function addStudent(session, data) {
    const student = validateStudent(data);
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      const classRow = findTeacherClassRow(classSheet, classColumns, session);
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      const availableSections = getHandledSections(classRow, classColumns);
      const defaultSection = cellText(classRow.getCell(classColumns.section).value);
      const section = typeof data.section === "string" ? data.section.trim() : defaultSection;
      if (section && !availableSections.some((candidate) => candidate.toLocaleLowerCase() === section.toLocaleLowerCase())) {
        throw new HttpError(400, "Choose one of the sections handled in Teacher Profile.");
      }
      student.section = section;
      const { sheet, columns } = getStudentSheet(workbook);
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        if (cellText(sheet.getRow(rowNumber).getCell(columns.lrn).value) === student.lrn) {
          throw new HttpError(409, "A student with this LRN is already registered.");
        }
      }
      const [added] = writeStudents(workbook, session, [student]);
      await saveDatabaseWorkbook(workbook);
      return added;
    });
  }

  async function importStudents(session, buffer, sectionValue) {
    const imported = parseSF1Workbook(buffer);
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      const classRow = findTeacherClassRow(classSheet, classColumns, session);
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      const availableSections = getHandledSections(classRow, classColumns);
      const defaultSection = cellText(classRow.getCell(classColumns.section).value);
      const section = typeof sectionValue === "string" && sectionValue.trim() ? sectionValue.trim() : defaultSection;
      if (section && !availableSections.some((candidate) => candidate.toLocaleLowerCase() === section.toLocaleLowerCase())) {
        throw new HttpError(400, "Choose one of the sections handled in Teacher Profile.");
      }
      imported.students.forEach((entry) => { entry.student.section = section; });
      const { sheet, columns } = getStudentSheet(workbook);
      const existingLrns = new Set();
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const existingLrn = cellText(sheet.getRow(rowNumber).getCell(columns.lrn).value);
        if (existingLrn) existingLrns.add(existingLrn);
      }

      const skipped = [...imported.skipped];
      const studentsToAdd = [];
      for (const entry of imported.students) {
        if (existingLrns.has(entry.student.lrn)) {
          skipped.push({ row: entry.row, reason: "LRN is already in the student roster or this SF1 file." });
          continue;
        }
        existingLrns.add(entry.student.lrn);
        studentsToAdd.push(entry.student);
      }

      const students = writeStudents(workbook, session, studentsToAdd);
      if (students.length) await saveDatabaseWorkbook(workbook);
      skipped.sort((left, right) => left.row - right.row);
      return { imported: students.length, skipped };
    });
  }

  async function addSectionFromSF1(session, buffer, fallbackSection, fallbackGrade) {
    const imported = parseSF1Workbook(buffer);
    const section = imported.sectionName || fallbackSection.trim();
    const grade = imported.grade || fallbackGrade.trim();
    if (!section || section.length > 100) {
      throw new HttpError(400, "The SF1 file does not include a section name. Enter a section name before adding it.");
    }
    if (!grade || grade.length > 100) {
      throw new HttpError(400, "The SF1 file does not include a grade level. Enter a grade before adding the section.");
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      const classRow = findTeacherClassRow(classSheet, classColumns, session);
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      const sectionsHandled = getHandledSections(classRow, classColumns);
      if (sectionsHandled.some((existing) => existing.toLocaleLowerCase() === section.toLocaleLowerCase())) {
        throw new HttpError(409, `The section "${section}" already exists.`);
      }
      if (sectionsHandled.length >= 30) {
        throw new HttpError(400, "Sections handled must contain no more than 30 entries.");
      }

      sectionsHandled.push(section);
      const sectionGrades = readStoredSectionGrades(classRow.getCell(classColumns.sectionGrades).value);
      const primarySection = cellText(classRow.getCell(classColumns.section).value);
      const primaryGrade = cellText(classRow.getCell(classColumns.grade).value);
      if (primarySection && primaryGrade && !sectionGrades.has(primarySection.toLocaleLowerCase())) {
        sectionGrades.set(primarySection.toLocaleLowerCase(), { section: primarySection, grade: primaryGrade });
      }
      sectionGrades.set(section.toLocaleLowerCase(), { section, grade });
      classRow.getCell(classColumns.sectionsHandled).value = JSON.stringify(sectionsHandled);
      classRow.getCell(classColumns.sectionGrades).value = JSON.stringify(serializeSectionGrades(sectionGrades));

      imported.students.forEach((entry) => { entry.student.section = section; });
      const { sheet, columns } = getStudentSheet(workbook);
      const existingLrns = new Set();
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const existingLrn = cellText(sheet.getRow(rowNumber).getCell(columns.lrn).value);
        if (existingLrn) existingLrns.add(existingLrn);
      }
      const skipped = [...imported.skipped];
      const studentsToAdd = [];
      for (const entry of imported.students) {
        if (existingLrns.has(entry.student.lrn)) {
          skipped.push({ row: entry.row, reason: "LRN is already in the student roster or this SF1 file." });
          continue;
        }
        existingLrns.add(entry.student.lrn);
        studentsToAdd.push(entry.student);
      }

      const students = writeStudents(workbook, session, studentsToAdd);
      await saveDatabaseWorkbook(workbook);
      skipped.sort((left, right) => left.row - right.row);
      return {
        sectionName: section,
        grade,
        sectionsHandled,
        sectionGrades: serializeSectionGrades(sectionGrades),
        imported: students.length,
        skipped,
      };
    });
  }

  async function getStudentGrades(session, studentId, termValue) {
    const term = validateGradeTerm(termValue);
    if (!studentId || studentId.length > 40) {
      throw new HttpError(400, "Choose a student from your class roster.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const student = findOwnedStudent(studentSheet, studentColumns, session, studentId);
      const strand = getTeacherClassStrand(workbook, session);
      const gradeSubjectDefinitions = gradeSubjectsForGrade(getTeacherClassGrade(workbook, session), strand);
      const { sheet, columns } = getGradeSheet(workbook);
      const grades = Object.fromEntries(gradeSubjectDefinitions.map(([key]) => [key, ""]));
      const eClassSubjects = [];
      let teacherComment = "";
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(columns.studentId).value) !== studentId
          || cellText(row.getCell(columns.classId).value) !== session.classId
          || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
          || cellText(row.getCell(columns.term).value) !== term
        ) continue;
        if (!teacherComment) {
          teacherComment = cellText(row.getCell(columns.teacherComment).value);
        }
        const subject = cellText(row.getCell(columns.subject).value);
        if (Object.hasOwn(grades, subject)) {
          const value = row.getCell(columns.grade).value;
          grades[subject] = value === null || value === undefined ? "" : String(value);
          if (cellText(row.getCell(columns.source).value).toLowerCase() === "e-class") {
            eClassSubjects.push(subject);
          }
        }
      }
      return {
        student: {
          id: cellText(student.getCell(studentColumns.id).value),
          name: cellText(student.getCell(studentColumns.name).value),
        },
        term,
        grades,
        eClassSubjects,
        teacherComment,
      };
    });
  }

  function retireLegacyTermGradeLocks(session, sheet, columns) {
    let changed = false;
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      if (
        cellText(row.getCell(columns.classId).value) !== session.classId
        || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
        || cellText(row.getCell(columns.studentId).value)
      ) continue;

      const term = cellText(row.getCell(columns.term).value);
      const legacyUpdated = row.getCell(columns.updated).value;
      const legacyTimestamp = legacyUpdated instanceof Date
        ? legacyUpdated.getTime()
        : typeof legacyUpdated === "string" ? Date.parse(legacyUpdated) : Number.NaN;
      for (let studentRowNumber = 2; studentRowNumber <= sheet.rowCount; studentRowNumber += 1) {
        const studentRow = sheet.getRow(studentRowNumber);
        const studentId = cellText(studentRow.getCell(columns.studentId).value);
        const individualUpdated = studentRow.getCell(columns.updated).value;
        const individualTimestamp = individualUpdated instanceof Date
          ? individualUpdated.getTime()
          : typeof individualUpdated === "string" ? Date.parse(individualUpdated) : Number.NaN;
        const individualLocked = studentRow.getCell(columns.locked).value;
        if (
          studentId
          && cellText(studentRow.getCell(columns.classId).value) === session.classId
          && cellText(studentRow.getCell(columns.teacherUserId).value) === session.userId
          && cellText(studentRow.getCell(columns.term).value) === term
          && (individualLocked === true || cellText(individualLocked).toLowerCase() === "true")
          && Number.isFinite(legacyTimestamp)
          && Number.isFinite(individualTimestamp)
          && individualTimestamp <= legacyTimestamp
        ) {
          studentRow.getCell(columns.locked).value = false;
          studentRow.getCell(columns.updated).value = new Date();
          changed = true;
        }
      }

      row.getCell(columns.locked).value = false;
      row.getCell(columns.classId).value = "";
      row.getCell(columns.teacherUserId).value = "";
      row.getCell(columns.term).value = "";
      row.getCell(columns.updated).value = new Date();
      changed = true;
    }
    return changed;
  }

  async function getStudentGradeLock(session, studentIdValue, termValue) {
    const term = validateGradeTerm(termValue);
    const studentId = typeof studentIdValue === "string" ? studentIdValue.trim() : "";
    if (!studentId || studentId.length > 40) {
      throw new HttpError(400, "Choose a student from your class roster.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      findOwnedStudent(studentSheet, studentColumns, session, studentId);
      const { sheet, columns } = getGradeLockSheet(workbook);
      const migrated = retireLegacyTermGradeLocks(session, sheet, columns);
      let locked = true;
      let lockRow = null;
      let created = false;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(columns.term).value) === term
          && cellText(row.getCell(columns.studentId).value) === studentId
        ) {
          lockRow = row;
          const value = row.getCell(columns.locked).value;
          locked = value === true || cellText(value).toLowerCase() === "true";
          break;
        }
      }
      if (!lockRow) {
        lockRow = sheet.getRow(sheet.rowCount + 1);
        lockRow.getCell(columns.classId).value = session.classId;
        lockRow.getCell(columns.teacherUserId).value = session.userId;
        lockRow.getCell(columns.term).value = term;
        lockRow.getCell(columns.studentId).value = studentId;
        lockRow.getCell(columns.locked).value = true;
        lockRow.getCell(columns.updated).value = new Date();
        created = true;
      }
      if (migrated || created) await saveDatabaseWorkbook(workbook);
      return { studentId, term, locked };
    });
  }

  async function getClassTermGradeLock(session, termValue) {
    const term = validateGradeTerm(termValue);
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = getOwnedStudents(studentSheet, studentColumns, session);
      const { sheet: lockSheet, columns: lockColumns } = getGradeLockSheet(workbook);
      const migrated = retireLegacyTermGradeLocks(session, lockSheet, lockColumns);
      const locksByStudent = new Map();
      for (let rowNumber = 2; rowNumber <= lockSheet.rowCount; rowNumber += 1) {
        const row = lockSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(lockColumns.classId).value) === session.classId
          && cellText(row.getCell(lockColumns.teacherUserId).value) === session.userId
          && cellText(row.getCell(lockColumns.term).value) === term
        ) {
          const studentId = cellText(row.getCell(lockColumns.studentId).value);
          if (studentId) {
            const value = row.getCell(lockColumns.locked).value;
            locksByStudent.set(studentId, value === true || cellText(value).toLowerCase() === "true");
          }
        }
      }
      if (migrated) await saveDatabaseWorkbook(workbook);
      const locked = !students.length || students.some((student) => (
        !locksByStudent.has(student.id) || locksByStudent.get(student.id) !== false
      ));
      return { term, locked, studentCount: students.length };
    });
  }

  async function setStudentGradeLock(session, data) {
    const term = validateGradeTerm(data && data.term);
    const studentId = typeof (data && data.studentId) === "string" ? data.studentId.trim() : "";
    if (!studentId || studentId.length > 40) {
      throw new HttpError(400, "Choose a student from your class roster.");
    }
    if (!data || typeof data.locked !== "boolean") {
      throw new HttpError(400, "Choose whether to lock or unlock this student's grades.");
    }
    const password = typeof data.password === "string" ? data.password : "";
    if (!data.locked && (password.length < 6 || password.length > 256)) {
      throw new HttpError(400, "Enter your current password to unlock these grades.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      findOwnedStudent(studentSheet, studentColumns, session, studentId);
      if (!data.locked) {
        const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
        let userRow = null;
        for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
          const row = userSheet.getRow(rowNumber);
          if (cellText(row.getCell(userColumns.id).value) === session.userId) {
            userRow = row;
            break;
          }
        }
        if (!userRow || cellText(userRow.getCell(userColumns.role).value).toLowerCase() !== "teacher") {
          throw new HttpError(404, "The teacher account could not be found.");
        }
        const matches = await verifyPassword(password, cellText(userRow.getCell(userColumns.password).value));
        if (!matches) throw new HttpError(400, "Your password doesn't match.");
      }
      const { sheet, columns } = getGradeLockSheet(workbook);
      retireLegacyTermGradeLocks(session, sheet, columns);
      let lockRow = null;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(columns.term).value) === term
          && cellText(row.getCell(columns.studentId).value) === studentId
        ) {
          lockRow = row;
          break;
        }
      }
      if (!lockRow) {
        lockRow = sheet.getRow(sheet.rowCount + 1);
        lockRow.getCell(columns.classId).value = session.classId;
        lockRow.getCell(columns.teacherUserId).value = session.userId;
        lockRow.getCell(columns.term).value = term;
        lockRow.getCell(columns.studentId).value = studentId;
      }
      lockRow.getCell(columns.locked).value = data.locked;
      lockRow.getCell(columns.updated).value = new Date();
      await saveDatabaseWorkbook(workbook);
      return { studentId, term, locked: data.locked };
    });
  }

  async function setClassTermGradeLock(session, data) {
    const term = validateGradeTerm(data && data.term);
    if (!data || typeof data.locked !== "boolean") {
      throw new HttpError(400, "Choose whether to lock or unlock this term's grades.");
    }
    const password = typeof data.password === "string" ? data.password : "";
    if (!data.locked && (password.length < 6 || password.length > 256)) {
      throw new HttpError(400, "Enter your current password to unlock this term's grades.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = getOwnedStudents(studentSheet, studentColumns, session);
      if (!data.locked) {
        const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
        let userRow = null;
        for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
          const row = userSheet.getRow(rowNumber);
          if (cellText(row.getCell(userColumns.id).value) === session.userId) {
            userRow = row;
            break;
          }
        }
        if (!userRow || cellText(userRow.getCell(userColumns.role).value).toLowerCase() !== "teacher") {
          throw new HttpError(404, "The teacher account could not be found.");
        }
        const matches = await verifyPassword(password, cellText(userRow.getCell(userColumns.password).value));
        if (!matches) throw new HttpError(400, "Your password doesn't match.");
      }

      const { sheet: lockSheet, columns: lockColumns } = getGradeLockSheet(workbook);
      retireLegacyTermGradeLocks(session, lockSheet, lockColumns);
      const rowsByStudent = new Map();
      for (let rowNumber = 2; rowNumber <= lockSheet.rowCount; rowNumber += 1) {
        const row = lockSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(lockColumns.classId).value) === session.classId
          && cellText(row.getCell(lockColumns.teacherUserId).value) === session.userId
          && cellText(row.getCell(lockColumns.term).value) === term
        ) {
          const studentId = cellText(row.getCell(lockColumns.studentId).value);
          if (studentId) rowsByStudent.set(studentId, row);
        }
      }
      const updatedAt = new Date();
      for (const student of students) {
        let row = rowsByStudent.get(student.id);
        if (!row) {
          row = lockSheet.getRow(lockSheet.rowCount + 1);
          row.getCell(lockColumns.classId).value = session.classId;
          row.getCell(lockColumns.teacherUserId).value = session.userId;
          row.getCell(lockColumns.term).value = term;
          row.getCell(lockColumns.studentId).value = student.id;
        }
        row.getCell(lockColumns.locked).value = data.locked;
        row.getCell(lockColumns.updated).value = updatedAt;
      }
      await saveDatabaseWorkbook(workbook);
      return { term, locked: data.locked, studentCount: students.length };
    });
  }

  async function getGradeSummary(session) {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const grade = getTeacherClassGrade(workbook, session);
      const strand = getTeacherClassStrand(workbook, session);
      const gradeSubjectDefinitions = gradeSubjectsForGrade(grade, strand);
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = [];
      const studentsById = new Map();

      for (let rowNumber = 2; rowNumber <= studentSheet.rowCount; rowNumber += 1) {
        const row = studentSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(studentColumns.classId).value) !== session.classId
          || cellText(row.getCell(studentColumns.teacherUserId).value) !== session.userId
        ) continue;
        const id = cellText(row.getCell(studentColumns.id).value);
        const student = {
          id,
          name: cellText(row.getCell(studentColumns.name).value),
          lrn: cellText(row.getCell(studentColumns.lrn).value),
          gender: cellText(row.getCell(studentColumns.gender).value),
          grades: Object.fromEntries(GRADE_TERMS.map((term) => [
            term,
            Object.fromEntries(gradeSubjectDefinitions.map(([key]) => [key, ""])),
          ])),
        };
        students.push(student);
        studentsById.set(id, student);
      }

      const gradeSheet = workbook.getWorksheet("Term Grades");
      if (gradeSheet) {
        const columns = getGradeSheet(workbook).columns;
        for (let rowNumber = 2; rowNumber <= gradeSheet.rowCount; rowNumber += 1) {
          const row = gradeSheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) !== session.classId
            || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
          ) continue;
          const student = studentsById.get(cellText(row.getCell(columns.studentId).value));
          const term = cellText(row.getCell(columns.term).value);
          const subject = cellText(row.getCell(columns.subject).value);
          if (!student || !Object.hasOwn(student.grades, term)
            || !Object.hasOwn(student.grades[term], subject)) continue;
          const value = row.getCell(columns.grade).value;
          student.grades[term][subject] = value === null || value === undefined || value === ""
            ? ""
            : Number(value);
        }
      }

      if (!/^grade\s*3$/i.test(grade.trim())) {
        for (const student of students) {
          for (const term of GRADE_TERMS) {
            const music = student.grades[term].musicAndArts;
            const physicalEducation = student.grades[term].physicalEducationAndHealth;
            student.grades[term].mapeh = typeof music === "number" && typeof physicalEducation === "number"
              ? Math.round(((music + physicalEducation) / 2) * 100) / 100
              : "";
          }
        }
      }

      return {
        terms: GRADE_TERMS,
        grade,
        strand,
        subjects: gradeSummarySubjectsForGrade(grade, strand).map(([key, label]) => ({ key, label })),
        generalAverageSubjects: generalAverageSubjectsForGrade(grade, strand),
        students,
      };
    });
  }

  async function exportGradeSummary(session, sectionFilter) {
    const [summary, profile, roster] = await Promise.all([
      getGradeSummary(session),
      getTeacherProfile(session),
      listStudents(session),
    ]);
    if (sectionFilter && sectionFilter !== "__all__") {
      const selectedIds = new Set(roster.students
        .filter((student) => matchesStudentSection(student, sectionFilter))
        .map((student) => student.id));
      summary.students = summary.students.filter((student) => selectedIds.has(student.id));
      profile.section = sectionFilter === "__unassigned__" ? "" : sectionFilter;
      const sectionGrade = Object.entries(roster.sectionGrades).find(([section]) =>
        section.toLocaleLowerCase() === profile.section.toLocaleLowerCase());
      if (sectionGrade) profile.grade = sectionGrade[1];
    }
    if (!summary.students.length) {
      throw new HttpError(400, "Add learners to the selected section before exporting the grading sheet.");
    }
    const males = summary.students.filter((student) => student.gender.toLowerCase() === "male");
    const females = summary.students.filter((student) => student.gender.toLowerCase() === "female");
    const unclassified = summary.students.find((student) =>
      !["male", "female"].includes(student.gender.toLowerCase()));
    if (unclassified) {
      throw new HttpError(400, `Set ${unclassified.name}'s gender to Male or Female before exporting the grading sheet.`);
    }
    if (males.length > 50 || females.length > 50) {
      throw new HttpError(400, "The Grading Sheet template supports up to 50 male and 50 female learners.");
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(GRADE_SHEET_TEMPLATE_PATH);
    let sheet = workbook.getWorksheet("SUMMARY - FINAL GRADES");
    if (!sheet) {
      if (!workbook.getWorksheet("FINAL GRADES")) {
        throw new Error('The "Grading Sheet.xlsx" template is missing its summary sheet.');
      }
      sheet = workbook.addWorksheet("SUMMARY - FINAL GRADES");
      sheet.mergeCells("B1:AM1");
      sheet.getCell("B1").value = "CLASS SUMMARY OF GRADES";
      sheet.getCell("B1").font = { bold: true, size: 16, color: { argb: "FFFFFFFF" } };
      sheet.getCell("B1").alignment = { horizontal: "center", vertical: "middle" };
      sheet.getCell("B1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
      sheet.getRow(1).height = 28;
      for (const [labelCell, valueRange, label] of [
        ["B3", "G3:N3", "Region"],
        ["P3", "R3:X3", "Division"],
        ["Z3", "AA3:AM3", "School year"],
        ["B5", "G5:N5", "School"],
        ["P5", "R5:X5", "School ID"],
        ["Z5", "AD5:AM5", "Grade / Section"],
      ]) {
        sheet.getCell(labelCell).value = label;
        sheet.getCell(labelCell).font = { bold: true };
        sheet.mergeCells(valueRange);
      }
      for (let index = 0; index < 8; index += 1) {
        const start = 6 + index * 4;
        sheet.mergeCells(7, start, 7, start + 3);
        ["Term 1", "Term 2", "Term 3", "Final"].forEach((label, quarter) => {
          sheet.getCell(8, start + quarter).value = label;
        });
      }
      sheet.getCell("B10").value = "MALE LEARNERS";
      sheet.getCell("B61").value = "FEMALE LEARNERS";
      for (const rowNumber of [7, 8]) {
        const row = sheet.getRow(rowNumber);
        row.font = { bold: true, color: { argb: "FFFFFFFF" } };
        row.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
        row.eachCell((cell) => {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4472C4" } };
        });
      }
      for (const [column, width] of [[2, 30], [39, 16]]) {
        sheet.getColumn(column).width = width;
      }
      for (let column = 6; column <= 37; column += 1) sheet.getColumn(column).width = 12;
      sheet.views = [{ state: "frozen", ySplit: 8 }];
      sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    }
    const classInfo = [
      ["G3", profile.region],
      ["R3", profile.division],
      ["AA3", profile.schoolYear],
      ["G5", profile.schoolName],
      ["R5", profile.schoolId],
      ["AD5", [profile.grade, profile.section].filter(Boolean).join(" - ")],
    ];
    classInfo.forEach(([address, value]) => {
      sheet.getCell(address).value = value || "";
    });

    const subjectSlots = summary.subjects.slice(0, 8);
    const subjectColumns = subjectSlots.map(({ key, label }, index) => {
      const start = 6 + index * 4;
      sheet.getCell(7, start).value = label.replace(/\s*\(average\)$/i, "").toUpperCase();
      return { key, quarters: [start, start + 1, start + 2], final: start + 3 };
    });
    for (let index = subjectSlots.length; index < 8; index += 1) {
      const start = 6 + index * 4;
      for (let column = start; column < start + 4; column += 1) sheet.getColumn(column).hidden = true;
    }
    const extraSubjects = summary.subjects.slice(8);
    if (extraSubjects.length) {
      const extraSheet = workbook.addWorksheet("Additional Subjects");
      extraSheet.addRow(["Learner", "Subject", ...GRADE_TERMS, "Average"]);
      for (const student of summary.students) {
        for (const { key, label } of extraSubjects) {
          const grades = GRADE_TERMS.map((term) => student.grades[term][key]);
          extraSheet.addRow([
            student.name,
            label,
            ...grades.map((grade) => typeof grade === "number" ? grade : ""),
            grades.every((grade) => typeof grade === "number")
              ? Math.round(grades.reduce((total, grade) => total + grade, 0) / grades.length)
              : "",
          ]);
        }
      }
      extraSheet.getRow(1).font = { bold: true };
      extraSheet.views = [{ state: "frozen", ySplit: 1 }];
      extraSheet.columns = [
        { width: 30 }, { width: 44 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 },
      ];
    }
    const writeStudents = (students, firstRow) => students.forEach((student, index) => {
      const rowNumber = firstRow + index;
      sheet.getCell(rowNumber, 2).value = student.name;
      subjectColumns.forEach(({ key, quarters, final }) => {
        const grades = GRADE_TERMS.map((term) => student.grades[term][key]);
        quarters.forEach((column, quarterIndex) => {
          sheet.getCell(rowNumber, column).value = typeof grades[quarterIndex] === "number"
            ? grades[quarterIndex]
            : null;
        });
        sheet.getCell(rowNumber, final).value = grades.every((grade) => typeof grade === "number")
          ? Math.round(grades.reduce((total, grade) => total + grade, 0) / grades.length)
          : null;
      });
      const annualSubjectGrades = summary.generalAverageSubjects.map((key) => {
        const grades = GRADE_TERMS.map((term) => student.grades[term][key]);
        return grades.every((grade) => typeof grade === "number")
          ? Math.round(grades.reduce((total, grade) => total + grade, 0) / grades.length)
          : null;
      });
      sheet.getCell(rowNumber, 39).value = annualSubjectGrades.length
        && annualSubjectGrades.every((grade) => typeof grade === "number")
        ? Math.round(annualSubjectGrades.reduce((total, grade) => total + grade, 0) / annualSubjectGrades.length)
        : null;
    });
    writeStudents(males, 11);
    writeStudents(females, 62);
    const filenamePart = (value) => String(value || "School_Year")
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, "_");
    const filename = `Grading_Sheet_${filenamePart(profile.schoolYear)}.xlsx`;
    return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), filename };
  }

  function getEClassSelection(session, workbook, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new HttpError(400, "Provide the selected E-Class record.");
    }
    const term = validateGradeTerm(data.term);
    const subject = typeof data.subject === "string" ? data.subject.trim() : "";
    const requestedGroup = typeof data.mapehGroup === "string" ? data.mapehGroup.trim() : "";
    const sectionFilter = typeof data.section === "string" ? data.section.trim() : "";
    if (!subject || subject.length > 100) throw new HttpError(400, "Choose a valid E-Class subject.");
    if (!["__all__", "__unassigned__"].includes(sectionFilter) && !sectionFilter) {
      throw new HttpError(400, "Choose a valid section for the E-Class record.");
    }
    const mapehGroup = subject === "MAPEH" ? requestedGroup : "";
    if (subject === "MAPEH" && !["Music and Arts", "PE and Health"].includes(mapehGroup)) {
      throw new HttpError(400, "Choose a valid MAPEH group.");
    }
    const grade = getTeacherClassGrade(workbook, session);
    const strand = getTeacherClassStrand(workbook, session);
    if (!eClassSubjectsForGrade(grade, strand).includes(subject)) {
      throw new HttpError(400, "Choose a subject available for this grade level.");
    }
    const gradeSubjectDefinitions = gradeSubjectsForGrade(grade, strand);
    const normalizeSubjectLabel = (label) => String(label).toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
    const gradeSubject = subject === "MAPEH"
      ? mapehGroup === "Music and Arts" ? "musicAndArts" : "physicalEducationAndHealth"
      : gradeSubjectDefinitions.find(([, label]) =>
        normalizeSubjectLabel(label.replace(/\s*\(average\)$/i, "")) === normalizeSubjectLabel(subject))?.[0];
    if (!gradeSubject || !gradeSubjectDefinitions.some(([key]) => key === gradeSubject)) {
      throw new HttpError(400, "Choose a subject available for this grade level.");
    }

    let section = sectionFilter;
    if (!["__all__", "__unassigned__"].includes(sectionFilter)) {
      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      const classRow = findTeacherClassRow(classSheet, classColumns, session);
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      section = getHandledSections(classRow, classColumns).find((handledSection) =>
        handledSection.toLocaleLowerCase() === sectionFilter.toLocaleLowerCase());
      if (!section) throw new HttpError(400, "Choose a section handled by this classroom.");
    }
    const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
    const students = getOwnedStudents(studentSheet, studentColumns, session)
      .filter((student) => matchesStudentSection(student, section));
    const { sheet: methodClassSheet, columns: methodClassColumns } = getClassSheet(workbook);
    const methodClassRow = findTeacherClassRow(methodClassSheet, methodClassColumns, session);
    const gradingMethod = eClassGradingMethod(
      grade,
      methodClassRow ? cellText(methodClassRow.getCell(methodClassColumns.schoolYear).value) : "",
    );
    return { term, subject, mapehGroup, section, students, gradeSubject, gradeSubjectDefinitions, gradingMethod };
  }

  function eClassRecordMatches(row, columns, session, selection) {
    return cellText(row.getCell(columns.classId).value) === session.classId
      && cellText(row.getCell(columns.teacherUserId).value) === session.userId
      && cellText(row.getCell(columns.term).value) === selection.term
      && cellText(row.getCell(columns.subject).value) === selection.subject
      && cellText(row.getCell(columns.mapehGroup).value) === selection.mapehGroup
      && cellText(row.getCell(columns.section).value) === selection.section;
  }

  function readEClassJson(value, label, expectArray = false) {
    if (typeof value !== "string" || !value) return expectArray ? [] : {};
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) !== expectArray) {
        throw new Error(expectArray ? "Expected an array." : "Expected an object.");
      }
      return parsed;
    } catch (error) {
      throw new Error(`The saved E-Class ${label} are invalid: ${error.message}`);
    }
  }

  async function getEClassRecord(session, selectionData) {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const selection = getEClassSelection(session, workbook, selectionData);
      const { sheet, columns } = getEClassRecordSheet(workbook);
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (!eClassRecordMatches(row, columns, session, selection)) continue;
        const locked = row.getCell(columns.locked).value === true
          || cellText(row.getCell(columns.locked).value).toLowerCase() === "true";
        return {
          term: selection.term,
          subject: selection.subject,
          mapehGroup: selection.mapehGroup,
          section: selection.section,
          updated: row.getCell(columns.updated).value instanceof Date
            ? row.getCell(columns.updated).value.toISOString()
            : cellText(row.getCell(columns.updated).value),
          scores: readEClassJson(row.getCell(columns.scores).value, "scores"),
          highestScores: readEClassJson(row.getCell(columns.highestScores).value, "highest possible scores", true),
          locked,
          saved: true,
          gradingMethod: selection.gradingMethod,
        };
      }
      return {
        gradingMethod: selection.gradingMethod,
        term: selection.term,
        subject: selection.subject,
        mapehGroup: selection.mapehGroup,
        section: selection.section,
        updated: "",
        scores: {},
        highestScores: null,
        locked: false,
        saved: false,
      };
    });
  }

  async function saveEClassRecord(session, data) {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const selection = getEClassSelection(session, workbook, data);
      if (!selection.students.length) {
        throw new HttpError(400, "There are no learners in the selected E-Class record to save.");
      }
      const scores = data.students;
      const maxima = data.highestScores;
      if (!Array.isArray(maxima) || maxima.length !== 11
        || maxima.some((value) => typeof value !== "string" || value.length > 50
          || value.trim() !== "" && (!Number.isFinite(Number(value)) || Number(value) <= 0))) {
        throw new HttpError(400, "Enter 11 valid highest-possible-score values or leave them blank.");
      }
      if (!Array.isArray(scores) || scores.length !== selection.students.length
        || scores.some((entry) => !entry || typeof entry.id !== "string"
          || !Array.isArray(entry.scores) || entry.scores.length !== 11
          || entry.scores.some((value) => typeof value !== "string" || value.length > 120)
          || typeof entry.grade !== "string" || entry.grade.length > 20)) {
        throw new HttpError(400, "The E-Class scores are incomplete or invalid.");
      }
      const scoresByStudent = new Map(scores.map((entry) => [entry.id, entry]));
      if (scoresByStudent.size !== scores.length
        || selection.students.some((student) => !scoresByStudent.has(student.id))
        || scores.some((entry) => !selection.students.some((student) => student.id === entry.id))) {
        throw new HttpError(409, "The E-Class roster changed. Refresh the record and try again.");
      }
      for (const entry of scores) {
        entry.scores.forEach((value, index) => {
          if (!value.trim()) return;
          const score = Number(value);
          const maximum = Number(maxima[index]);
          if (!Number.isFinite(score) || score < 0 || !Number.isFinite(maximum) || maximum <= 0 || score > maximum) {
            throw new HttpError(400, `A learner score is invalid or exceeds highest possible score ${index + 1}.`);
          }
        });
      }

      const gradeSheetData = getGradeSheet(workbook);
      const now = new Date();
      const savedGrades = {};
      const inactiveStatusEvents = monthlyAttendanceStatusEvents(workbook, session, new Set(selection.students.map((student) => student.id)));
      const inactiveIds = new Set(selection.students.filter((student) => {
        const latest = (inactiveStatusEvents.get(student.id) || []).slice(-1)[0];
        return latest && latest.status !== "Transferred In";
      }).map((student) => student.id));
      let previousScores = {};
      let previousGrades = {};
      if (inactiveIds.size) {
        const previousSheet = getEClassRecordSheet(workbook);
        for (let rowNumber = 2; rowNumber <= previousSheet.sheet.rowCount; rowNumber += 1) {
          const row = previousSheet.sheet.getRow(rowNumber);
          if (!eClassRecordMatches(row, previousSheet.columns, session, selection)) continue;
          previousScores = readEClassJson(row.getCell(previousSheet.columns.scores).value, "scores") || {};
          try { previousGrades = JSON.parse(cellText(row.getCell(previousSheet.columns.grades).value) || "{}") || {}; } catch { previousGrades = {}; }
          break;
        }
      }
      for (const student of selection.students) {
        const entry = scoresByStudent.get(student.id);
        if (inactiveIds.has(student.id)) {
          entry.scores = Array.isArray(previousScores[student.id]) ? previousScores[student.id] : Array(11).fill("");
          savedGrades[student.id] = previousGrades[student.id] || "";
          continue;
        }
        entry.grade = computeEClassTermGrade(entry.scores, maxima, selection.subject, selection.gradingMethod).termGrade;
        const grade = validateStudentGrades({
          [selection.gradeSubject]: entry.grade,
        }, selection.gradeSubjectDefinitions)[selection.gradeSubject];
        savedGrades[student.id] = grade === null ? "" : String(grade);
        let gradeRow = null;
        for (let rowNumber = 2; rowNumber <= gradeSheetData.sheet.rowCount; rowNumber += 1) {
          const row = gradeSheetData.sheet.getRow(rowNumber);
          if (
            cellText(row.getCell(gradeSheetData.columns.studentId).value) === student.id
            && cellText(row.getCell(gradeSheetData.columns.classId).value) === session.classId
            && cellText(row.getCell(gradeSheetData.columns.teacherUserId).value) === session.userId
            && cellText(row.getCell(gradeSheetData.columns.term).value) === selection.term
            && cellText(row.getCell(gradeSheetData.columns.subject).value) === selection.gradeSubject
          ) {
            gradeRow = row;
            break;
          }
        }
        if (!gradeRow) {
          gradeRow = writeRow(gradeSheetData.sheet, [gradeSheetData.columns.id, gradeSheetData.columns.subject], {
            [gradeSheetData.columns.id]: nextGradeId(gradeSheetData.sheet, gradeSheetData.columns.id),
            [gradeSheetData.columns.studentId]: student.id,
            [gradeSheetData.columns.classId]: session.classId,
            [gradeSheetData.columns.teacherUserId]: session.userId,
            [gradeSheetData.columns.term]: selection.term,
            [gradeSheetData.columns.subject]: selection.gradeSubject,
          });
        }
        gradeRow.getCell(gradeSheetData.columns.grade).value = grade;
        gradeRow.getCell(gradeSheetData.columns.source).value = grade === null ? "" : "E-Class";
        gradeRow.getCell(gradeSheetData.columns.updated).value = now;
      }

      const { sheet, columns } = getEClassRecordSheet(workbook);
      let recordRow = null;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (eClassRecordMatches(row, columns, session, selection)) {
          recordRow = row;
          break;
        }
      }
      if (recordRow && (recordRow.getCell(columns.locked).value === true
        || cellText(recordRow.getCell(columns.locked).value).toLowerCase() === "true")) {
        throw new HttpError(409, "This E-Class record is locked. Unlock it before saving changes.");
      }
      if (!recordRow) recordRow = sheet.getRow(sheet.rowCount + 1);
      const scoresById = Object.fromEntries(scores.map(({ id, scores: values }) => [id, values]));
      recordRow.getCell(columns.classId).value = session.classId;
      recordRow.getCell(columns.teacherUserId).value = session.userId;
      recordRow.getCell(columns.term).value = selection.term;
      recordRow.getCell(columns.subject).value = selection.subject;
      recordRow.getCell(columns.mapehGroup).value = selection.mapehGroup;
      recordRow.getCell(columns.section).value = selection.section;
      recordRow.getCell(columns.scores).value = JSON.stringify(scoresById);
      recordRow.getCell(columns.highestScores).value = JSON.stringify(maxima);
      recordRow.getCell(columns.grades).value = JSON.stringify(savedGrades);
      recordRow.getCell(columns.locked).value = true;
      recordRow.getCell(columns.updated).value = now;
      await saveDatabaseWorkbook(workbook);
      return { saved: true, locked: true, term: selection.term, subject: selection.subject };
    });
  }

  async function unlockEClassRecord(session, data) {
    const password = typeof (data && data.password) === "string" ? data.password : "";
    if (password.length < 6 || password.length > 256) {
      throw new HttpError(400, "Enter your current password to unlock this E-Class record.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const selection = getEClassSelection(session, workbook, data);
      const { sheet, columns } = getEClassRecordSheet(workbook);
      let recordRow = null;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (eClassRecordMatches(row, columns, session, selection)) {
          recordRow = row;
          break;
        }
      }
      if (!recordRow) throw new HttpError(404, "This E-Class record has not been saved yet.");
      const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
      let userRow = null;
      for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
        const row = userSheet.getRow(rowNumber);
        if (cellText(row.getCell(userColumns.id).value) === session.userId) {
          userRow = row;
          break;
        }
      }
      if (!userRow || cellText(userRow.getCell(userColumns.role).value).toLowerCase() !== "teacher") {
        throw new HttpError(404, "The teacher account could not be found.");
      }
      const matches = await verifyPassword(password, cellText(userRow.getCell(userColumns.password).value));
      if (!matches) throw new HttpError(400, "Your password doesn't match.");
      recordRow.getCell(columns.locked).value = false;
      recordRow.getCell(columns.updated).value = new Date();
      await saveDatabaseWorkbook(workbook);
      return { term: selection.term, subject: selection.subject, locked: false };
    });
  }

  async function exportEClassRecord(session, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new HttpError(400, "Provide the selected E-Class records for export.");
    }
    const sectionFilter = typeof data?.section === "string" ? data.section : "";
    const term = typeof data?.term === "string" ? data.term : "";
    const subject = typeof data?.subject === "string" ? data.subject : "";
    const mapehGroup = typeof data?.mapehGroup === "string" ? data.mapehGroup : "";
    if (!GRADE_TERMS.includes(term)) throw new HttpError(400, "Choose a valid E-Class term.");
    if (!["__all__", "__unassigned__"].includes(sectionFilter) && !sectionFilter.trim()) {
      throw new HttpError(400, "Choose a valid section for the E-Class record.");
    }
    if (!Array.isArray(data.students) || !data.students.length
      || data.students.some((student) => !student || typeof student.id !== "string"
        || !Array.isArray(student.values) || student.values.length !== 25
        || student.values.some((value) => value !== null && typeof value !== "string"
          && !(typeof value === "number" && Number.isFinite(value))
          || typeof value === "string" && value.length > 120))) {
      throw new HttpError(400, "The E-Class student records are incomplete or invalid.");
    }
    if (!Array.isArray(data.highestScores) || data.highestScores.length !== 22
      || data.highestScores.some((value) => typeof value === "string"
        ? value.length > 50
        : typeof value !== "number" || !Number.isFinite(value))) {
      throw new HttpError(400, "The E-Class highest-possible scores are incomplete or invalid.");
    }

    const [roster, profile, gradeSummary] = await Promise.all([
      listStudents(session),
      getTeacherProfile(session),
      getGradeSummary(session),
    ]);
    if (!profile.eClassSubjects.includes(subject)) {
      throw new HttpError(400, "Choose a subject available for this grade level.");
    }
    if (subject === "MAPEH" && !["Music and Arts", "PE and Health"].includes(mapehGroup)) {
      throw new HttpError(400, "Choose a valid MAPEH group.");
    }
    let selectedSection = sectionFilter;
    if (!["__all__", "__unassigned__"].includes(sectionFilter)) {
      selectedSection = roster.sectionsHandled.find((section) =>
        section.toLocaleLowerCase() === sectionFilter.toLocaleLowerCase());
      if (!selectedSection) throw new HttpError(400, "Choose a section handled by this classroom.");
    }
    const sectionStudents = roster.students.filter((student) =>
      matchesStudentSection(student, selectedSection));
    if (!sectionStudents.length) {
      throw new HttpError(400, "There are no students in the selected section to include in the E-Class record.");
    }
    const submittedStudents = new Map(data.students.map((student) => [student.id, student]));
    const normalizeSubjectLabel = (label) => String(label).toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
    const gradeSubject = subject === "MAPEH"
      ? mapehGroup === "Music and Arts" ? "musicAndArts" : "physicalEducationAndHealth"
      : gradeSummary.subjects.find(({ label }) =>
        normalizeSubjectLabel(label.replace(/\s*\(average\)$/i, ""))
          === normalizeSubjectLabel(subject))?.key;
    if (!gradeSubject) throw new HttpError(400, "Choose a subject available for this grade level.");
    const gradesByStudent = new Map(gradeSummary.students.map((student) => [student.id, student.grades]));
    if (submittedStudents.size !== data.students.length
      || submittedStudents.size !== sectionStudents.length
      || sectionStudents.some((student) => !submittedStudents.has(student.id))
      || data.students.some(({ id }) => !sectionStudents.some((student) => student.id === id))) {
      throw new HttpError(400, "The E-Class roster changed. Refresh the record and try downloading again.");
    }

    const groups = [
      { label: "MALE", gender: "male" },
      { label: "FEMALE", gender: "female" },
      { label: "OTHER", gender: "other" },
    ].map((group) => ({
      ...group,
      students: sectionStudents.filter((student) => {
        const gender = student.gender.toLocaleLowerCase();
        return group.gender === "other" ? gender !== "male" && gender !== "female" : gender === group.gender;
      }),
    })).filter((group) => group.students.length);
    const maleStudents = groups.find((group) => group.gender === "male")?.students || [];
    const femaleStudents = groups.find((group) => group.gender === "female")?.students || [];
    const otherStudents = groups.find((group) => group.gender === "other")?.students || [];
    if (maleStudents.length > 60
      || femaleStudents.length + otherStudents.length + (otherStudents.length ? 1 : 0) > 60) {
      throw new HttpError(400, "The E-CLASS template supports up to 60 male learners and 60 female or other rows, including a group header when needed.");
    }

    const archive = await JSZip.loadAsync(await fs.readFile(ECLASS_TEMPLATE_PATH));
    const workbookPath = "xl/workbook.xml";
    const relationshipsPath = "xl/_rels/workbook.xml.rels";
    const workbookEntry = archive.file(workbookPath);
    const relationshipsEntry = archive.file(relationshipsPath);
    if (!workbookEntry || !relationshipsEntry) {
      throw new Error("The E-CLASS.xlsx template is missing its workbook metadata.");
    }
    let workbookXml = await workbookEntry.async("string");
    const relationshipsXml = await relationshipsEntry.async("string");
    const worksheetTag = [...workbookXml.matchAll(/<sheet\b[^>]*\/>/g)]
      .map(([tag]) => tag)
      .find((tag) => /\bname="TERM 1"/.test(tag));
    if (!worksheetTag) throw new Error('The E-CLASS.xlsx template is missing its "TERM 1" worksheet.');
    const relationshipId = worksheetTag.match(/\br:id="([^"]+)"/)?.[1];
    const worksheetRelationship = [...relationshipsXml.matchAll(/<Relationship\b[^>]*\/>/g)]
      .map(([tag]) => tag)
      .find((tag) => tag.match(/\bId="([^"]+)"/)?.[1] === relationshipId
        && /\/worksheet$/.test(tag.match(/\bType="([^"]+)"/)?.[1] || ""));
    const worksheetTarget = worksheetRelationship?.match(/\bTarget="([^"]+)"/)?.[1];
    if (!worksheetTarget) throw new Error("The E-CLASS.xlsx template worksheet relationship is invalid.");
    const worksheetPath = worksheetTarget.startsWith("/")
      ? worksheetTarget.slice(1)
      : path.posix.normalize(path.posix.join("xl", worksheetTarget));
    const worksheetEntry = archive.file(worksheetPath);
    if (!worksheetEntry) throw new Error("The E-CLASS.xlsx template worksheet file is missing.");
    let worksheetXml = await worksheetEntry.async("string");
    workbookXml = workbookXml.replaceAll("TERM 1", term.toUpperCase());

    const columnName = (column) => {
      let name = "";
      while (column > 0) {
        column -= 1;
        name = String.fromCharCode(65 + (column % 26)) + name;
        column = Math.floor(column / 26);
      }
      return name;
    };
    const templateCellStyles = new Map();
    for (const match of worksheetXml.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
      const address = match[0].match(/\br="([A-Z]+\d+)"/)?.[1];
      const style = match[0].match(/\bs="([^"]+)"/)?.[1];
      if (address && style) templateCellStyles.set(address, style);
    }
    const cellUpdates = new Map();
    const setCell = (address, value, style) => cellUpdates.set(address, { value, style });
    setCell("B2", `CLASS RECORD - ${term.toUpperCase()}`);
    setCell("F5", profile.region || "");
    setCell("R5", profile.division || "");
    setCell("Z5", profile.schoolId || "");
    setCell("F7", profile.schoolName || "");
    setCell("Z7", profile.schoolYear || "");
    const sectionGrades = Object.entries(roster.sectionGrades);
    const selectedGrades = selectedSection === "__all__"
      ? [...new Set(sectionStudents
        .map((student) => sectionGrades.find(([section]) =>
          section.toLocaleLowerCase() === student.section.toLocaleLowerCase())?.[1])
        .filter(Boolean))]
      : [];
    const selectedGrade = selectedSection === "__all__"
      ? selectedGrades.length > 1 ? "Multiple Grades" : selectedGrades[0] || profile.grade || ""
      : selectedSection === "__unassigned__"
        ? ""
        : sectionGrades.find(([section]) => section.toLocaleLowerCase()
          === selectedSection.toLocaleLowerCase())?.[1]
          || (selectedSection.toLocaleLowerCase() === profile.section.toLocaleLowerCase() ? profile.grade : "");
    setCell("J10", selectedGrade);
    setCell("J11", selectedSection === "__all__"
      ? "All Sections"
      : selectedSection === "__unassigned__" ? "Unassigned" : selectedSection);
    setCell("Q10", profile.name || "");
    setCell("AA10", subject === "MAPEH" ? `MAPEH - ${mapehGroup}` : subject);
    setCell("M141", profile.name || "");
    setCell("M142", profile.position || "");
    setCell("Y141", profile.schoolHead || "");
    setCell("Y142", profile.schoolHeadPosition || "");
    const spreadsheetValue = (value) => {
      const text = String(value ?? "").trim();
      if (!text) return null;
      if (/^-?(?:\d+\.?\d*|\.\d+)%$/.test(text)) return Number(text.slice(0, -1)) / 100;
      if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return Number(text);
      return text;
    };
    data.highestScores.forEach((value, index) => {
      setCell(`${columnName(6 + index)}15`, spreadsheetValue(value));
    });

    const writeStudents = (students, firstRow) => {
      for (let index = 0; index < students.length; index += 1) {
        const student = students[index];
        const rowNumber = firstRow + index;
        for (let column = 2; column <= 30; column += 1) {
          setCell(`${columnName(column)}${rowNumber}`, null);
        }
        const studentName = [student.lastName, student.firstName, student.middleName].filter(Boolean);
        setCell(`B${rowNumber}`, index + 1);
        setCell(`C${rowNumber}`, studentName.length > 1
          ? `${studentName.shift()}, ${studentName.join(" ")}`
          : studentName[0] || student.name);
        const submitted = submittedStudents.get(student.id);
        submitted.values.forEach((value, valueIndex) => {
          let exportedValue = value;
          if ((valueIndex === 23 || valueIndex === 24) && !String(value ?? "").trim()) {
            const savedGrade = gradesByStudent.get(student.id)?.[term]?.[gradeSubject];
            if (typeof savedGrade === "number" && Number.isFinite(savedGrade)) {
              exportedValue = valueIndex === 23
                ? savedGrade
                : savedGrade >= 90 ? "Advancing"
                  : savedGrade >= 80 ? "Benchmarking"
                    : savedGrade >= 75 ? "Connecting"
                      : savedGrade >= 65 ? "Developing" : "Emerging";
            }
          }
          setCell(`${columnName(6 + valueIndex)}${rowNumber}`, spreadsheetValue(exportedValue));
        });
      }
    };
    setCell("B17", "MALE");
    setCell("B78", femaleStudents.length || !otherStudents.length ? "FEMALE" : "OTHER");
    writeStudents(maleStudents, 18);
    writeStudents(femaleStudents, 79);
    if (otherStudents.length) {
      const otherHeaderRow = femaleStudents.length ? 79 + femaleStudents.length : 78;
      if (femaleStudents.length) {
        const headerMerge = worksheetXml.match(/<mergeCells\b[^>]*>[\s\S]*?<\/mergeCells>/)?.[0];
        const previousMerge = `<mergeCell ref="C${otherHeaderRow}:E${otherHeaderRow}"/>`;
        if (!headerMerge || !headerMerge.includes(previousMerge)) {
          throw new Error(`The E-CLASS.xlsx template is missing the learner-header merge for row ${otherHeaderRow}.`);
        }
        worksheetXml = worksheetXml.replace(
          headerMerge,
          headerMerge.replace(previousMerge, `<mergeCell ref="B${otherHeaderRow}:AD${otherHeaderRow}"/>`),
        );
        for (let column = 2; column <= 30; column += 1) {
          const headerAddress = `${columnName(column)}${otherHeaderRow}`;
          const headerStyle = templateCellStyles.get(`${columnName(column)}78`);
          if (!headerStyle) throw new Error(`The E-CLASS.xlsx template is missing the header style for column ${columnName(column)}.`);
          setCell(headerAddress, column === 2 ? "OTHER" : null, headerStyle);
        }
      }
      writeStudents(otherStudents, otherHeaderRow + 1);
    }

    const xmlText = (value) => {
      const text = String(value);
      for (const character of text) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd
          && !(codePoint >= 0x20 && codePoint <= 0xd7ff)
          && !(codePoint >= 0xe000 && codePoint <= 0xfffd)
          && !(codePoint >= 0x10000 && codePoint <= 0x10ffff)) {
          throw new HttpError(400, "A value contains characters that cannot be written to an Excel workbook.");
        }
      }
      return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    };
    const updatedCells = new Set();
    const serializeCellUpdate = (address, update, originalCell = "") => {
      const openingTag = originalCell.match(/^<c\b([^>]*)>/)?.[1];
      let attributes = openingTag === undefined ? ` r="${address}"` : openingTag.replace(/\/\s*$/, "");
      attributes = attributes.replace(/\s+t="[^"]*"/g, "");
      if (update.style !== undefined) {
        attributes = /\bs="[^"]*"/.test(attributes)
          ? attributes.replace(/\bs="[^"]*"/, `s="${update.style}"`)
          : `${attributes} s="${update.style}"`;
      }
      if (update.value === null || update.value === undefined || update.value === "") {
        return `<c${attributes}/>`;
      }
      if (typeof update.value === "number") {
        if (!Number.isFinite(update.value)) {
          throw new HttpError(400, "A score is not a valid number for the Excel workbook.");
        }
        return `<c${attributes}><v>${update.value}</v></c>`;
      }
      return `<c${attributes} t="inlineStr"><is><t xml:space="preserve">${xmlText(update.value)}</t></is></c>`;
    };
    worksheetXml = worksheetXml.replace(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, (cellXml) => {
      const address = cellXml.match(/\br="([A-Z]+\d+)"/)?.[1];
      const update = address ? cellUpdates.get(address) : null;
      if (!update) return cellXml;
      updatedCells.add(address);
      return serializeCellUpdate(address, update, cellXml);
    });
    const missingCells = [...cellUpdates.keys()].filter((address) => !updatedCells.has(address));
    const columnNumber = (name) => [...name].reduce(
      (value, character) => value * 26 + character.charCodeAt(0) - 64,
      0,
    );
    for (const address of missingCells) {
      const [, column, rowText] = address.match(/^([A-Z]+)(\d+)$/);
      const rowNumber = Number(rowText);
      const cellXml = serializeCellUpdate(address, cellUpdates.get(address));
      const rows = [...worksheetXml.matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g)];
      const rowMatch = rows.find((match) =>
        Number(match[0].match(/\br="(\d+)"/)?.[1]) === rowNumber);
      if (rowMatch) {
        const cells = [...rowMatch[0].matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)];
        const nextCell = cells.find((match) => {
          const nextAddress = match[0].match(/\br="([A-Z]+\d+)"/)?.[1];
          return nextAddress && columnNumber(nextAddress.match(/^([A-Z]+)/)[1]) > columnNumber(column);
        });
        const updatedRow = nextCell
          ? rowMatch[0].replace(nextCell[0], `${cellXml}${nextCell[0]}`)
          : rowMatch[0].replace("</row>", `${cellXml}</row>`);
        worksheetXml = worksheetXml.replace(rowMatch[0], updatedRow);
      } else {
        const newRow = `<row r="${rowNumber}">${cellXml}</row>`;
        const nextRow = rows.find((match) => Number(match[0].match(/\br="(\d+)"/)?.[1]) > rowNumber);
        worksheetXml = nextRow
          ? worksheetXml.replace(nextRow[0], `${newRow}${nextRow[0]}`)
          : worksheetXml.replace("</sheetData>", `${newRow}</sheetData>`);
      }
    }
    const dimensionTag = worksheetXml.match(/<dimension\b[^>]*\/>/)?.[0];
    const dimension = dimensionTag?.match(/\bref="([A-Z]+\d+)(?::([A-Z]+\d+))?"/);
    if (dimension) {
      const start = dimension[1];
      const end = dimension[2] || start;
      const originalEndColumn = columnNumber(end.match(/^([A-Z]+)/)[1]);
      const originalEndRow = Number(end.match(/(\d+)$/)[1]);
      const maxColumn = Math.max(originalEndColumn, ...[...cellUpdates.keys()].map((address) =>
        columnNumber(address.match(/^([A-Z]+)/)[1])));
      const maxRow = Math.max(originalEndRow, ...[...cellUpdates.keys()].map((address) =>
        Number(address.match(/(\d+)$/)[1])));
      const expandedDimension = `<dimension ref="${start}:${columnName(maxColumn)}${maxRow}"/>`;
      worksheetXml = worksheetXml.replace(dimensionTag, expandedDimension);
    }
    archive.file(workbookPath, workbookXml);
    archive.file(worksheetPath, worksheetXml);

    const filenamePart = (value) => String(value || "Class")
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, "_");
    const filename = `E-CLASS_${filenamePart(term)}_${filenamePart(subject)}`
      + `${subject === "MAPEH" ? `_${filenamePart(mapehGroup)}` : ""}_`
      + `${filenamePart(selectedSection === "__all__" ? "All_Sections"
        : selectedSection === "__unassigned__" ? "Unassigned" : selectedSection)}.xlsx`;
    return {
      buffer: await archive.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      }),
      filename,
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function sf9PreviewCellText(cell) {
    const value = cell.value;
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toLocaleDateString();
    if (typeof value === "object") {
      if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join("");
      if (typeof value.text === "string") return value.text;
      if ("formula" in value || "sharedFormula" in value) {
        return value.result === undefined ? "" : String(value.result);
      }
      return "";
    }
    return String(value);
  }

  function renderSF9Preview(sheet, workbook, filename) {
    const printArea = sheet.pageSetup.printArea || "A2:AD54";
    const printAreaMatch = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(printArea);
    if (!printAreaMatch) {
      throw new Error(`The SF9 template has an invalid print area: ${printArea}.`);
    }
    const columnNumber = (letters) => [...letters].reduce(
      (total, letter) => (total * 26) + letter.charCodeAt(0) - 64,
      0,
    );
    const firstColumn = columnNumber(printAreaMatch[1]);
    const firstRow = Number(printAreaMatch[2]);
    const lastColumn = columnNumber(printAreaMatch[3]);
    const lastRow = Number(printAreaMatch[4]);
    const columnWidthPixels = (columnNumber) => ((sheet.getColumn(columnNumber).width || 8.43) * 7) + 5;
    const rowHeightPixels = (rowNumber) => ((sheet.getRow(rowNumber).height || 15) * 96) / 72;
    const columnWidths = [];
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      columnWidths.push(columnWidthPixels(column));
    }
    const rowHeights = [];
    for (let row = firstRow; row <= lastRow; row += 1) {
      rowHeights.push(rowHeightPixels(row));
    }
    const naturalWidth = columnWidths.reduce((total, width) => total + width, 0);
    const naturalHeight = rowHeights.reduce((total, height) => total + height, 0);
    const a4WidthPixels = (297 / 25.4) * 96;
    const a4HeightPixels = (210 / 25.4) * 96;
    const printableWidthPixels = ((297 - 12) / 25.4) * 96;
    const printableHeightPixels = ((210 - 12) / 25.4) * 96;
    const previewScale = Math.min(
      a4WidthPixels / naturalWidth,
      a4HeightPixels / naturalHeight,
    ) * 0.97;
    const printScale = Math.min(
      printableWidthPixels / naturalWidth,
      printableHeightPixels / naturalHeight,
    ) * 0.99;
    const cellWidths = new Map();
    const cellHeights = new Map();
    const mergedBorders = new Map();
    const occupied = new Set();
    const cellKey = (row, column) => `${row}:${column}`;
    for (const merge of sheet.model.merges) {
      const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(merge);
      if (!match) continue;
      const startColumn = columnNumber(match[1]);
      const startRow = Number(match[2]);
      const endColumn = columnNumber(match[3]);
      const endRow = Number(match[4]);
      if (startColumn < firstColumn || startRow < firstRow || endColumn > lastColumn || endRow > lastRow) continue;
      const masterKey = cellKey(startRow, startColumn);
      cellWidths.set(masterKey, endColumn - startColumn + 1);
      cellHeights.set(masterKey, endRow - startRow + 1);
      const mergedBorder = {};
      const borderWeight = { hair: 0.5, thin: 1, dotted: 1, dashed: 1, dashDot: 1, dashDotDot: 1, medium: 2, mediumDashed: 2, mediumDashDot: 2, mediumDashDotDot: 2, thick: 3, double: 3 };
      const strongestBorder = (current, candidate) => {
        if (!candidate?.style) return current;
        if (!current?.style || (borderWeight[candidate.style] || 1) > (borderWeight[current.style] || 1)) return candidate;
        return current;
      };
      for (let column = startColumn; column <= endColumn; column += 1) {
        mergedBorder.top = strongestBorder(mergedBorder.top, sheet.getCell(startRow, column).border?.top);
        mergedBorder.bottom = strongestBorder(mergedBorder.bottom, sheet.getCell(endRow, column).border?.bottom);
      }
      for (let row = startRow; row <= endRow; row += 1) {
        mergedBorder.left = strongestBorder(mergedBorder.left, sheet.getCell(row, startColumn).border?.left);
        mergedBorder.right = strongestBorder(mergedBorder.right, sheet.getCell(row, endColumn).border?.right);
      }
      mergedBorders.set(masterKey, mergedBorder);
      for (let row = startRow; row <= endRow; row += 1) {
        for (let column = startColumn; column <= endColumn; column += 1) {
          if (row !== startRow || column !== startColumn) occupied.add(cellKey(row, column));
        }
      }
    }
    const colorValue = (color) => {
      if (!color) return "";
      if (color.argb) return `#${color.argb.slice(-6)}`;
      return "";
    };
    const borderCss = (border) => {
      if (!border?.style) return "";
      const widths = { hair: 1, thin: 1, dotted: 1, dashed: 1, dashDot: 1, dashDotDot: 1, medium: 2, mediumDashed: 2, mediumDashDot: 2, mediumDashDotDot: 2, thick: 3, double: 3 };
      const style = border.style === "double" ? "double" : ["dotted", "dashed", "dashDot", "dashDotDot", "mediumDashed", "mediumDashDot", "mediumDashDotDot"].includes(border.style) ? "dashed" : "solid";
      return `${widths[border.style] || 1}px ${style} ${colorValue(border.color) || "#000"}`;
    };
    const renderCell = (rowNumber, columnNumberValue) => {
      const key = cellKey(rowNumber, columnNumberValue);
      if (occupied.has(key)) return "";
      const cell = sheet.getCell(rowNumber, columnNumberValue);
      const style = [];
      const font = cell.font || {};
      if (font.name) style.push(`font-family:${JSON.stringify(font.name)},serif`);
      if (font.size) style.push(`font-size:${font.size}pt`);
      if (font.bold) style.push("font-weight:700");
      if (font.italic) style.push("font-style:italic");
      if (font.underline) style.push("text-decoration:underline");
      if (font.color) style.push(`color:${colorValue(font.color) || "#000"}`);
      if (cell.alignment?.horizontal) style.push(`text-align:${cell.alignment.horizontal}`);
      if (cell.alignment?.vertical) style.push(`vertical-align:${cell.alignment.vertical}`);
      if (cell.alignment?.wrapText) style.push("white-space:normal;overflow-wrap:anywhere");
      else style.push("white-space:nowrap");
      if (cell.fill?.pattern === "solid") {
        const fill = colorValue(cell.fill.fgColor);
        if (fill) style.push(`background-color:${fill}`);
      }
      const border = mergedBorders.get(key) || cell.border || {};
      for (const side of ["top", "right", "bottom", "left"]) {
        const css = borderCss(border[side]);
        if (css) style.push(`border-${side}:${css}`);
      }
      const colSpan = cellWidths.get(key);
      const rowSpan = cellHeights.get(key);
      const spans = `${colSpan ? ` colspan="${colSpan}"` : ""}${rowSpan ? ` rowspan="${rowSpan}"` : ""}`;
      const termGrade = rowNumber >= 32 && rowNumber <= 41
        && columnNumberValue >= 6 && columnNumberValue <= 8
        ? ` data-term-grade="${columnNumberValue - 5}" data-grade-text="${escapeHtml(sf9PreviewCellText(cell))}"`
        : "";
      const termThreeSummary = (
        (rowNumber >= 32 && rowNumber <= 39 && columnNumberValue >= 9 && columnNumberValue <= 10)
        || (rowNumber === 42 && columnNumberValue >= 9 && columnNumberValue <= 10)
      ) ? ` data-term-three-summary="true"` : "";
      const previewText = sf9PreviewCellText(cell);
      const attendanceCell = [5, 7, 9].includes(rowNumber)
        && columnNumberValue >= 18 && columnNumberValue <= 29
        && /^-?\d+(?:\.\d+)?$/.test(previewText.trim())
        ? ` data-attendance="true" data-attendance-text="${escapeHtml(previewText)}"`
        : "";
      const teacherCommentTerm = rowNumber === 15 ? 1 : rowNumber === 19 ? 2 : rowNumber === 23 ? 3 : 0;
      const teacherCommentsCell = teacherCommentTerm && columnNumberValue === 17
        && previewText.startsWith(`Term ${teacherCommentTerm}\n`)
        ? ` data-teacher-comments="${teacherCommentTerm}"`
        : "";
      const text = escapeHtml(previewText).replace(/\r?\n/g, "<br>");
      return `<td data-row="${rowNumber}" data-column="${columnNumberValue}"${termGrade}${termThreeSummary}${attendanceCell}${teacherCommentsCell}${spans}${style.length ? ` style="${escapeHtml(style.join(";"))}"` : ""}>${text}</td>`;
    };
    const colGroup = columnWidths.map((width, index) =>
      `<col data-column="${index + firstColumn}" style="width:${width}px">`).join("");
    const rows = [];
    for (let rowNumber = firstRow; rowNumber <= lastRow; rowNumber += 1) {
      const cells = [];
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        cells.push(renderCell(rowNumber, column));
      }
      rows.push(`<tr style="height:${rowHeightPixels(rowNumber)}px">${cells.join("")}</tr>`);
    }
    const images = sheet.getImages().map((image) => {
      const imageData = workbook.getImage(image.imageId);
      if (!imageData?.buffer) return "";
      const start = image.range.tl;
      let left = start.nativeColOff / 9525;
      let top = start.nativeRowOff / 9525;
      for (let index = firstColumn - 1; index < start.nativeCol; index += 1) {
        left += columnWidthPixels(index + 1);
      }
      for (let index = firstRow - 1; index < start.nativeRow; index += 1) {
        top += rowHeightPixels(index + 1);
      }
      const extension = imageData.extension.toLowerCase();
      const contentType = extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : extension === "gif" ? "image/gif" : `image/${extension}`;
      let width = image.range.ext?.width;
      let height = image.range.ext?.height;
      if ((!width || !height) && image.range.br) {
        const end = image.range.br;
        width = end.nativeColOff / 9525 - start.nativeColOff / 9525;
        height = end.nativeRowOff / 9525 - start.nativeRowOff / 9525;
        for (let index = start.nativeCol; index < end.nativeCol; index += 1) width += columnWidthPixels(index + 1);
        for (let index = start.nativeRow; index < end.nativeRow; index += 1) height += rowHeightPixels(index + 1);
      }
      if (!width || !height) return "";
      return `<img class="sf9-logo" alt="" src="data:${contentType};base64,${imageData.buffer.toString("base64")}" style="left:${left}px;top:${top}px;width:${width}px;height:${height}px">`;
    }).join("");
    const title = `SF9 Print Preview - ${filename}`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#e7eceb;color:#111;font:14px Arial,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.toolbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:#fff;border-bottom:1px solid #cbd5d4;box-shadow:0 2px 8px #0001}
.toolbar strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.toolbar-actions{display:flex;flex:none;gap:8px}
.toolbar select{max-width:min(38vw,260px);padding:9px 12px;border:1px solid #cbd5d4;border-radius:7px;background:#fff;color:#193735;font:inherit}
.toolbar button{padding:9px 18px;border:0;border-radius:7px;background:#167d79;color:#fff;font:inherit;font-weight:700;cursor:pointer}
.toolbar #closePreview{background:#eef3f3;color:#193735}
.loading-overlay{position:fixed;inset:0;z-index:10;display:grid;place-items:center;padding:24px;overflow:hidden;background:radial-gradient(ellipse at 50% 42%,rgba(16,185,176,.16),transparent 42%),rgba(3,10,23,.82);backdrop-filter:blur(12px)}
.loading-overlay[hidden]{display:none}
.loading-card{position:relative;width:min(100%,420px);padding:38px 34px 32px;overflow:hidden;border:1px solid rgba(105,239,226,.3);border-radius:24px;background:linear-gradient(145deg,rgba(13,28,48,.97),rgba(8,20,37,.97));box-shadow:0 0 0 1px rgba(77,225,216,.08),0 25px 90px #0009,0 0 55px rgba(18,185,177,.14);text-align:center;color:#edfafa}
.loading-card:before{position:absolute;top:0;left:12%;width:76%;height:1px;background:linear-gradient(90deg,transparent,#55eee0,transparent);content:""}
.loading-orbit{position:relative;display:grid;width:104px;height:104px;margin:0 auto 24px;place-items:center;border:1px solid rgba(89,228,222,.14);border-radius:50%;background:radial-gradient(circle,rgba(20,184,175,.13),transparent 68%)}
.loading-orbit:before,.loading-orbit:after{position:absolute;inset:9px;border:1px solid rgba(96,235,226,.42);border-left-color:transparent;border-bottom-color:transparent;border-radius:50%;content:"";animation:sf9-spin 2s linear infinite}
.loading-orbit:after{inset:0;border-color:rgba(91,154,255,.34);border-top-color:transparent;border-right-color:transparent;animation-duration:3.2s;animation-direction:reverse}
.loading-core{width:24px;height:24px;border:1px solid #a8fff2;border-radius:7px;background:linear-gradient(145deg,#c6fff7,#36cfc1);box-shadow:0 0 12px #67fff1,0 0 34px rgba(47,232,218,.8);transform:rotate(45deg);animation:sf9-pulse 1.6s ease-in-out infinite}
.loading-brand{margin:0 0 10px;color:#65e9dc;font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase}
.loading-card h2{margin:0 0 10px;color:#f1ffff;font-size:22px;letter-spacing:.01em}
.loading-card p{margin:0;color:#b5ccdb;font-size:14px;line-height:1.6}
.loading-progress{height:3px;margin:24px 0 0;overflow:hidden;border-radius:3px;background:rgba(143,193,214,.17)}
.loading-progress:after{display:block;width:42%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#20bbb7,#83fff0);box-shadow:0 0 12px #50f8e9;content:"";animation:sf9-progress 1.5s ease-in-out infinite}
.loading-dots:after{content:"";display:inline-block;width:1.5em;text-align:left;animation:sf9-dots 1.2s steps(4,end) infinite}
@keyframes sf9-spin{to{transform:rotate(360deg)}}
@keyframes sf9-pulse{50%{box-shadow:0 0 18px #67fff1,0 0 48px rgba(47,232,218,.95);transform:rotate(225deg) scale(.86)}}
@keyframes sf9-progress{0%{transform:translateX(-110%)}100%{transform:translateX(250%)}}
@keyframes sf9-dots{0%{content:""}25%{content:"."}50%{content:".."}75%,100%{content:"..."}}
@media(prefers-reduced-motion:reduce){.loading-orbit:before,.loading-orbit:after,.loading-core,.loading-progress:after,.loading-dots:after{animation-duration:4s}}
.viewport{overflow:auto;padding:24px}
.paper{position:relative;width:297mm;height:210mm;margin:0 auto;background:#fff;box-shadow:0 3px 16px #0003;overflow:hidden}
.sheet-scale{position:absolute;left:calc(50% - ${(naturalWidth * previewScale) / 2}px);top:calc(50% - ${(naturalHeight * previewScale) / 2}px);width:${naturalWidth}px;height:${naturalHeight}px;transform:scale(${previewScale});transform-origin:top left}
table{width:${naturalWidth}px;height:${naturalHeight}px;table-layout:fixed;border-collapse:collapse;border-spacing:0}
td{padding:1px 2px;line-height:1.05;overflow:visible}
.sf9-logo{position:absolute;object-fit:contain;z-index:1}
body[data-print-selection^="Term "] td{visibility:hidden!important;border-color:transparent!important;background-color:transparent!important}
body[data-print-selection^="Term "] td[data-term-grade]{visibility:hidden!important}
body[data-print-selection="Term 1"] td[data-term-grade="1"],
body[data-print-selection="Term 2"] td[data-term-grade="2"],
body[data-print-selection="Term 3"] td[data-term-grade="3"]{visibility:visible!important}
body[data-print-selection="Term 3"] td[data-term-three-summary="true"]{visibility:visible!important}
body[data-print-selection="Term 1"] td[data-teacher-comments="1"],
body[data-print-selection="Term 2"] td[data-teacher-comments="2"],
body[data-print-selection="Term 3"] td[data-teacher-comments="3"]{visibility:visible!important}
body[data-print-selection^="Term "] .sf9-logo{visibility:hidden}
body[data-print-selection="Attendance"] td{visibility:hidden!important;border-color:transparent!important;background-color:transparent!important}
body[data-print-selection="Attendance"] td[data-attendance]{visibility:visible!important}
body[data-print-selection="Attendance"] .sf9-logo{visibility:hidden}
@media print{
  .loading-overlay{display:none!important}
  .paper.batch-page{break-after:page;page-break-after:always}
  .paper.batch-page:last-child{break-after:auto;page-break-after:auto}
}
@media print{
  @page{size:297mm 210mm;margin:0}
  body{background:#fff}
  .toolbar{display:none}
  .viewport{display:block;width:297mm;height:210mm;overflow:visible;padding:0}
  .paper{width:297mm;height:210mm;margin:0;box-shadow:none;overflow:hidden;break-inside:avoid;page-break-inside:avoid;break-after:avoid}
  .sheet-scale{left:calc(50% - ${(naturalWidth * printScale) / 2}px);top:calc(50% - ${(naturalHeight * printScale) / 2}px);transform:scale(${printScale});transform-origin:top left}
}
</style>
</head>
<body>
<header class="toolbar"><strong>${escapeHtml(title)}</strong><div class="toolbar-actions"><label for="printSelection" hidden>Choose what to print</label><select id="printSelection" aria-label="Choose what to print"><option value="All Without Attendance" selected>All Without Attendance</option><option value="All with Attendance">All with Attendance</option><option value="Term 1">Term 1</option><option value="Term 2">Term 2</option><option value="Term 3">Term 3</option><option value="Attendance">Attendance</option></select><button id="closePreview" type="button">Close</button><button id="printPreview" type="button">Print</button><button id="downloadAllPdf" type="button">Download All Students as PDF</button></div></header>
<div id="printAllLoading" class="loading-overlay" role="status" aria-live="polite" aria-label="Preparing SF9 reports for all students" hidden><div class="loading-card"><div class="loading-orbit" aria-hidden="true"><div class="loading-core"></div></div><div class="loading-brand">Class Adviser Portal</div><h2>Preparing SF9 Reports</h2><p id="printAllLoadingMessage">Getting the class reports ready<span class="loading-dots"></span></p><div class="loading-progress" aria-hidden="true"></div></div></div>
<main class="viewport"><section class="paper" aria-label="SF9 learner progress report preview" data-page-size="A4 landscape" data-print-area="${escapeHtml(printArea)}" data-report-width="${naturalWidth}" data-report-height="${naturalHeight}" data-fit-scale="${previewScale}" data-safe-margin-mm="0"><div class="sheet-scale"><table aria-label="SF9 learner progress report"><colgroup>${colGroup}</colgroup><tbody>${rows.join("")}</tbody></table>${images}</div></section></main>
<script>
var printSelection=document.getElementById("printSelection");
function applyPrintSelection(){
  var selection=printSelection.value;
  var term=selection.startsWith("Term ")?Number(selection.slice(-1)):0;
  document.body.dataset.printSelection=selection;
  document.querySelectorAll("td[data-term-grade]").forEach(function(cell){
    cell.textContent=selection==="All Without Attendance"||selection==="All with Attendance"||(
      selection!=="Attendance"&&Number(cell.dataset.termGrade)===term
    )?cell.dataset.gradeText:"";
  });
  document.querySelectorAll("td[data-attendance]").forEach(function(cell){
    cell.textContent=selection==="All Without Attendance"?"":cell.dataset.attendanceText;
  });
}
printSelection.addEventListener("change",applyPrintSelection);
applyPrintSelection();
document.getElementById("closePreview").addEventListener("click",function(){window.close();window.setTimeout(function(){if(!window.closed)window.location.assign("/")},100)});
document.getElementById("printPreview").addEventListener("click",function(){window.print()});
var downloadAllPdf=document.getElementById("downloadAllPdf");
if(downloadAllPdf)downloadAllPdf.addEventListener("click",async function(){
  if(!window.gradePortal||typeof window.gradePortal.downloadSF9Pdf!=="function"){
    window.alert("Download All Students as PDF is available in the GraceDesk desktop app.");
    return;
  }
  var button=this;
  button.disabled=true;
  button.textContent="Preparing PDF...";
  try{
    var result=await window.gradePortal.downloadSF9Pdf(printSelection.value);
    if(result&&!result.canceled)window.alert("SF9 PDF saved to: "+result.filePath);
  }catch(error){
    window.alert(error.message||"Unable to create the SF9 PDF.");
  }finally{
    button.disabled=false;
    button.textContent="Download All Students as PDF";
  }
});
var printAllPreview=document.getElementById("printAllPreview");
if(printAllPreview)printAllPreview.addEventListener("click",async function(){
  var button=this;
  var selection=printSelection.value;
  var allPreviewWindow=window.open("about:blank","_blank");
  if(!allPreviewWindow){
    window.alert("Allow pop-ups to open the SF9 print previews for all students.");
    return;
  }
  allPreviewWindow.opener=null;
  allPreviewWindow.document.open();
  allPreviewWindow.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preparing SF9 Reports</title><style>*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 50% 42%,rgba(16,185,176,.18),transparent 44%),linear-gradient(135deg,#07111f,#101a30 55%,#07121f);font:15px Arial,sans-serif;color:#edfafa}.card{position:relative;width:min(100%,440px);padding:40px 34px 32px;overflow:hidden;border:1px solid rgba(105,239,226,.3);border-radius:24px;background:linear-gradient(145deg,rgba(13,28,48,.97),rgba(8,20,37,.97));box-shadow:0 0 0 1px rgba(77,225,216,.08),0 25px 90px #0009,0 0 55px rgba(18,185,177,.14);text-align:center}.card:before{position:absolute;top:0;left:12%;width:76%;height:1px;background:linear-gradient(90deg,transparent,#55eee0,transparent);content:""}.orbit{position:relative;display:grid;width:108px;height:108px;margin:0 auto 24px;place-items:center;border:1px solid rgba(89,228,222,.14);border-radius:50%;background:radial-gradient(circle,rgba(20,184,175,.13),transparent 68%)}.orbit:before,.orbit:after{position:absolute;inset:9px;border:1px solid rgba(96,235,226,.42);border-left-color:transparent;border-bottom-color:transparent;border-radius:50%;content:"";animation:spin 2s linear infinite}.orbit:after{inset:0;border-color:rgba(91,154,255,.34);border-top-color:transparent;border-right-color:transparent;animation-duration:3.2s;animation-direction:reverse}.core{width:24px;height:24px;border:1px solid #a8fff2;border-radius:7px;background:linear-gradient(145deg,#c6fff7,#36cfc1);box-shadow:0 0 12px #67fff1,0 0 34px rgba(47,232,218,.8);transform:rotate(45deg);animation:pulse 1.6s ease-in-out infinite}.brand{margin:0 0 10px;color:#65e9dc;font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase}h1{margin:0 0 10px;color:#f1ffff;font-size:22px}p{margin:0;color:#b5ccdb;line-height:1.6}.progress{height:3px;margin:24px 0 0;overflow:hidden;border-radius:3px;background:rgba(143,193,214,.17)}.progress:after{display:block;width:42%;height:100%;border-radius:inherit;background:linear-gradient(90deg,#20bbb7,#83fff0);box-shadow:0 0 12px #50f8e9;content:"";animation:progress 1.5s ease-in-out infinite}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{box-shadow:0 0 18px #67fff1,0 0 48px rgba(47,232,218,.95);transform:rotate(225deg) scale(.86)}}@keyframes progress{0%{transform:translateX(-110%)}100%{transform:translateX(250%)}}@media(prefers-reduced-motion:reduce){.orbit:before,.orbit:after,.core,.progress:after{animation-duration:4s}}</style></head><body><main class="card" role="status" aria-live="polite"><div class="orbit" aria-hidden="true"><div class="core"></div></div><div class="brand">Class Adviser Portal</div><h1>Preparing SF9 Reports</h1><p>Generating '+selection.replace(/[&<>"']/g,function(character){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]})+' for all students. Please wait...</p><div class="progress" aria-hidden="true"></div></main></body></html>');
  allPreviewWindow.document.close();
  button.disabled=true;
  button.textContent="Preparing...";
  document.getElementById("printAllLoading").hidden=false;
  document.getElementById("printAllLoadingMessage").textContent="Preparing all students' SF9 reports for "+selection+".";
  try{
    var response=await fetch("/api/grades/sf9?all=true&format=preview&selection="+encodeURIComponent(selection));
    if(!response.ok){
      var errorResult=await response.json();
      throw new Error(errorResult.error||"Unable to prepare SF9 reports for the class.");
    }
    var contentType=response.headers.get("content-type")||"";
    if(!contentType.toLowerCase().includes("text/html"))throw new Error("The server did not return SF9 print previews.");
    allPreviewWindow.document.open();
    allPreviewWindow.document.write(await response.text());
    allPreviewWindow.document.close();
  }catch(error){
    if(!allPreviewWindow.closed){
      allPreviewWindow.document.open();
      allPreviewWindow.document.write('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SF9 Print Error</title><style>body{margin:0;padding:48px;background:#f8eeee;color:#702c2c;font:16px Arial,sans-serif}.error{max-width:640px;margin:10vh auto;padding:28px;border:1px solid #edcccc;border-radius:14px;background:#fff}h1{font-size:22px}</style></head><body><main class="error"><h1>Unable to prepare SF9 reports</h1><p>'+error.message.replace(/[&<>"']/g,function(character){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]})+'</p><p>You can close this tab and try again.</p></main></body></html>');
      allPreviewWindow.document.close();
    }
    window.alert(error.message);
  }finally{
    document.getElementById("printAllLoading").hidden=true;
    button.disabled=false;
    button.textContent="Print All";
  }
});
</script>
</body>
</html>`;
  }

  function renderSF9PreviewBatch(previews, selection, { autoPrint = true } = {}) {
    if (!previews.length) throw new HttpError(400, "There are no students to print.");
    const firstPreview = previews[0];
    const styles = firstPreview.match(/<style>([\s\S]*?)<\/style>/);
    const toolbar = firstPreview.match(/<header class="toolbar">[\s\S]*?<\/header>/);
    const script = firstPreview.match(/<script>([\s\S]*?)<\/script>/);
    const dimensions = firstPreview.match(
      /data-report-width="([\d.]+)" data-report-height="([\d.]+)" data-fit-scale="([\d.]+)"/,
    );
    if (!styles || !toolbar || !script || !dimensions) {
      throw new Error("The SF9 preview could not be combined for class printing.");
    }
    const naturalWidth = Number(dimensions[1]);
    const naturalHeight = Number(dimensions[2]);
    const printableWidthMm = 297 - 12;
    const printableHeightMm = 210 - 12;
    const printScale = Math.min(
      ((printableWidthMm / 25.4) * 96) / naturalWidth,
      ((printableHeightMm / 25.4) * 96) / naturalHeight,
    ) * 0.99;
    const pages = previews.map((preview, index) => {
      const page = preview.match(/<section class="paper"[\s\S]*?<\/section>/);
      if (!page) throw new Error("An SF9 learner page is missing from the class preview.");
      return page[0].replace(
        '<section class="paper"',
        `<section class="paper${index ? " batch-page" : ""}"`,
      );
    }).join("");
    const batchToolbar = toolbar[0]
      .replace(/<strong>[\s\S]*?<\/strong>/, `<strong>SF9 Print Preview - All Students (${previews.length})</strong>`)
      .replace(/<option value="([^"]+)" selected>/, (match, value) =>
        `<option value="${escapeHtml(value)}"${value === selection ? " selected" : ""}>`)
      .replace(
        `<option value="${escapeHtml(selection)}">`,
        `<option value="${escapeHtml(selection)}" selected>`,
      )
      .replace(/<button id="printAllPreview"[\s\S]*?<\/button>/, "");
    const batchScript = script[1].replace(
      "applyPrintSelection();",
      `printSelection.value=${JSON.stringify(selection)};applyPrintSelection();`,
    );
    const batchStyles = `${styles[1]}\n@media print{@page{size:297mm 210mm;margin:0}html,body.batch-print{width:297mm!important;height:auto!important;min-height:0!important;margin:0!important;padding:0!important;overflow:visible!important}body.batch-print .toolbar{display:none!important}body.batch-print .viewport{display:block!important;position:static!important;width:297mm!important;height:auto!important;min-height:0!important;margin:0!important;padding:0!important;overflow:visible!important}body.batch-print .paper{position:relative!important;display:block!important;box-sizing:border-box!important;width:297mm!important;height:210mm!important;min-height:210mm!important;max-height:210mm!important;margin:0!important;padding:0!important;overflow:hidden!important;break-inside:avoid!important;page-break-inside:avoid!important;break-after:page!important;page-break-after:always!important}body.batch-print .paper:last-child{break-after:auto!important;page-break-after:auto!important}body.batch-print .sheet-scale{left:calc(50% - ${(naturalWidth * printScale) / 2}px)!important;top:calc(50% - ${(naturalHeight * printScale) / 2}px)!important;transform:scale(${printScale})!important;transform-origin:top left!important}}`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><title>SF9 Print Preview - All Students</title><style>${batchStyles}</style></head><body class="batch-print">${batchToolbar}<main class="viewport">${pages}</main><script>${batchScript}\n${autoPrint ? 'window.addEventListener("load",function(){window.print()},{once:true});' : ""}</script></body></html>`;
  }

  async function serializeSF9Workbook(workbook) {
    const archive = await JSZip.loadAsync(Buffer.from(await workbook.xlsx.writeBuffer()));
    const worksheetPath = "xl/worksheets/sheet1.xml";
    const worksheetFile = archive.file(worksheetPath);
    if (!worksheetFile) {
      throw new Error("The generated SF9 workbook is missing its worksheet.");
    }

    const worksheetXml = await worksheetFile.async("string");
    const sheetPropertiesMatch = worksheetXml.match(/(<sheetPr\b[^>]*>)([\s\S]*?)(<\/sheetPr>)/);
    if (!sheetPropertiesMatch) {
      throw new Error("The generated SF9 worksheet is missing its sheet properties.");
    }
    const pageSetupProperties = sheetPropertiesMatch[2].match(/<pageSetUpPr\b[^>]*\/>/)?.[0];
    const outlineProperties = sheetPropertiesMatch[2].match(/<outlinePr\b[^>]*\/>/)?.[0];
    if (!pageSetupProperties || !outlineProperties) {
      throw new Error("The generated SF9 worksheet has incomplete sheet properties.");
    }
    const orderedProperties = sheetPropertiesMatch[2]
      .replace(pageSetupProperties, "")
      .replace(outlineProperties, `${outlineProperties}${pageSetupProperties}`);
    const correctedWorksheetXml = worksheetXml.replace(
      sheetPropertiesMatch[0],
      `${sheetPropertiesMatch[1]}${orderedProperties}${sheetPropertiesMatch[3]}`,
    );
    archive.file(worksheetPath, correctedWorksheetXml);
    return Buffer.from(await archive.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    }));
  }

  async function exportStudentSF9(session, studentIdValue, options = {}) {
    const studentId = typeof studentIdValue === "string" ? studentIdValue.trim() : "";
    if (!studentId || studentId.length > 40) {
      throw new HttpError(400, "Choose a student from your class roster.");
    }

    const teacherProfile = await getTeacherProfile(session);
    const studentData = await serializeWorkbook(async () => {
        const workbook = await readDatabaseWorkbook();
        const { sheet, columns } = getStudentSheet(workbook);
        const row = findOwnedStudent(sheet, columns, session, studentId);
        const grades = Object.fromEntries(GRADE_TERMS.map((term) => [
          term,
          Object.fromEntries(ALL_SUBJECT_DEFINITIONS.map(([key]) => [key, ""])),
        ]));
        const teacherComments = Object.fromEntries(GRADE_TERMS.map((term) => [term, ""]));
        const gradeSheet = workbook.getWorksheet("Term Grades");
        if (gradeSheet) {
          const gradeColumns = getGradeSheet(workbook).columns;
          for (let rowNumber = 2; rowNumber <= gradeSheet.rowCount; rowNumber += 1) {
            const gradeRow = gradeSheet.getRow(rowNumber);
            if (
              cellText(gradeRow.getCell(gradeColumns.classId).value) !== session.classId
              || cellText(gradeRow.getCell(gradeColumns.teacherUserId).value) !== session.userId
              || cellText(gradeRow.getCell(gradeColumns.studentId).value) !== studentId
            ) continue;
            const term = cellText(gradeRow.getCell(gradeColumns.term).value);
            if (!Object.hasOwn(grades, term)) continue;
            const comment = excelSafeText(cellText(gradeRow.getCell(gradeColumns.teacherComment).value)).trim();
            if (!teacherComments[term] && comment) teacherComments[term] = comment;
            const subject = cellText(gradeRow.getCell(gradeColumns.subject).value);
            if (!Object.hasOwn(grades[term], subject)) continue;
            const value = gradeRow.getCell(gradeColumns.grade).value;
            grades[term][subject] = value === null || value === undefined || value === ""
              ? ""
              : Number(value);
          }
        }
        for (const term of GRADE_TERMS) {
          const music = grades[term].musicAndArts;
          const physicalEducation = grades[term].physicalEducationAndHealth;
          grades[term].mapeh = typeof music === "number" && typeof physicalEducation === "number"
            ? Math.round(((music + physicalEducation) / 2) * 100) / 100
            : "";
        }
        const attendanceMonths = new Map();
        const schoolYearMatch = /^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/.exec(teacherProfile.schoolYear);
        if (schoolYearMatch) {
          const startYear = Number(schoolYearMatch[1]);
          const endYear = Number(schoolYearMatch[2].length === 2
            ? `${schoolYearMatch[1].slice(0, 2)}${schoolYearMatch[2]}`
            : schoolYearMatch[2]);
          if (endYear === startYear + 1) {
            for (const monthNumber of [6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4]) {
              const year = monthNumber >= 6 ? startYear : endYear;
              const month = `${year}-${String(monthNumber).padStart(2, "0")}`;
              attendanceMonths.set(month, { classDays: 0, present: 0, absent: 0 });
            }
          }
        }
        if (attendanceMonths.size) {
          const noClassDates = new Set();
          const calendarSheet = workbook.getWorksheet("Attendance Calendar");
          if (calendarSheet) {
            const calendarColumns = getAttendanceCalendarSheet(workbook).columns;
            for (let rowNumber = 2; rowNumber <= calendarSheet.rowCount; rowNumber += 1) {
              const calendarRow = calendarSheet.getRow(rowNumber);
              if (
                cellText(calendarRow.getCell(calendarColumns.classId).value) !== session.classId
                || cellText(calendarRow.getCell(calendarColumns.teacherUserId).value) !== session.userId
                || cellText(calendarRow.getCell(calendarColumns.dayType).value) !== "Holiday/No Class"
              ) continue;
              noClassDates.add(attendanceDateText(calendarRow.getCell(calendarColumns.date).value));
            }
          }
            for (const [monthKey, month] of attendanceMonths) {
              month.classDays = attendanceSchoolDays(monthKey)
                .filter((date) => !noClassDates.has(date)).length;
            }
            const statusEvents = monthlyAttendanceStatusEvents(workbook, session, [studentId]);
            const studentStatusEvents = statusEvents.get(studentId) || [];
            for (const [monthKey, month] of attendanceMonths) {
              const eligibleDates = attendanceSchoolDays(monthKey).filter((date) => !noClassDates.has(date));
            const lockedDays = eligibleDates.filter((date) =>
              isAttendanceDateLocked(studentStatusEvents, date)).length;
            month.present = eligibleDates.length - lockedDays;
          }
          const attendanceSheet = workbook.getWorksheet("Attendance Records");
          if (attendanceSheet) {
            const attendanceColumns = getAttendanceSheet(workbook).columns;
            for (let rowNumber = 2; rowNumber <= attendanceSheet.rowCount; rowNumber += 1) {
              const attendanceRow = attendanceSheet.getRow(rowNumber);
              if (
                cellText(attendanceRow.getCell(attendanceColumns.classId).value) !== session.classId
                || cellText(attendanceRow.getCell(attendanceColumns.teacherUserId).value) !== session.userId
              ) continue;
              const date = attendanceDateText(attendanceRow.getCell(attendanceColumns.date).value);
              const month = attendanceMonths.get(date.slice(0, 7));
              if (!month) continue;
              const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
              if (weekday === 0 || weekday === 6 || noClassDates.has(date)) continue;
              if (cellText(attendanceRow.getCell(attendanceColumns.studentId).value) !== studentId
                || isAttendanceDateLocked(studentStatusEvents, date)) continue;
              const status = normalizeAttendanceStatus(attendanceRow.getCell(attendanceColumns.status).value);
              if (status === "Absent") {
                month.present -= 1;
                month.absent += 1;
              }
            }
          }
        }
        const birthdateValue = row.getCell(columns.birthdate).value;
        const birthdate = birthdateValue instanceof Date
          ? birthdateValue
          : new Date(cellText(birthdateValue));
        let age = "";
        if (!Number.isNaN(birthdate.getTime())) {
          const now = new Date();
          age = now.getFullYear() - birthdate.getFullYear();
          if (
            now.getMonth() < birthdate.getMonth()
            || (now.getMonth() === birthdate.getMonth() && now.getDate() < birthdate.getDate())
          ) age -= 1;
        }
        return {
          name: cellText(row.getCell(columns.name).value),
          lrn: cellText(row.getCell(columns.lrn).value),
          gender: cellText(row.getCell(columns.gender).value),
          age,
          attendanceMonths: Object.fromEntries(attendanceMonths),
          grades,
          teacherComments,
        };
    });
    const schoolLogo = teacherProfile.hasSchoolLogo
      ? await findTeacherSchoolLogo(session.userId)
      : null;

    if (!teacherProfile.grade) {
      throw new HttpError(400, "Enter the Grade in Teacher Profile before downloading SF9.");
    }

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(SF9_TEMPLATE_PATH);
    } catch (error) {
      throw new Error(`The SF9 template could not be read: ${error.message}`);
    }
    const sheet = workbook.getWorksheet("SF9 - GRADE 4-10");
    if (!sheet || !sheet.getCell("C17").isMerged || !sheet.getCell("B32").value) {
      throw new Error("The SF9 template is missing required learner report fields.");
    }
    sheet.pageSetup = {
      ...sheet.pageSetup,
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 1,
      scale: undefined,
      horizontalDpi: 300,
      verticalDpi: 300,
      printArea: sheet.pageSetup.printArea || "A2:AD54",
      margins: {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        header: 0,
        footer: 0,
      },
    };

    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (
          (!cell.isMerged || cell.master === cell)
          && cell.value
          && typeof cell.value === "object"
          && ("formula" in cell.value || "sharedFormula" in cell.value)
        ) {
          cell.value = null;
        }
      });
    });

    sheet.getCell("B12").value = teacherProfile.schoolName || "";
    sheet.getCell("B7").value = teacherProfile.region || "";
    sheet.getCell("B8").value = teacherProfile.division || "";
    sheet.getCell("B9").value = teacherProfile.district || "";
    sheet.getCell("B15").value = teacherProfile.schoolYear;
    sheet.getCell("C17").value = studentData.name;
    sheet.getCell("I17").value = studentData.age;
    sheet.getCell("K17").value = studentData.gender;
    sheet.getCell("C18").value = studentData.lrn;
    sheet.getCell("I18").value = teacherProfile.grade;
    sheet.getCell("K18").value = teacherProfile.section || "";
    sheet.getCell("B27").value = teacherProfile.schoolHead || "";
    sheet.getCell("H27").value = teacherProfile.name;
    sheet.getCell("Q41").value = teacherProfile.schoolHead || "";
    sheet.getCell("X40").value = teacherProfile.name;

    const schoolYearMonths = [6, 7, 8, 9, 10, 11, 12, 1, 2, 3, 4];
    const attendanceColumns = ["R", "S", "T", "U", "V", "W", "X", "Y", "Z", "AA", "AB"];
    const attendanceTotals = { classDays: 0, present: 0, absent: 0 };
    const schoolYearMatch = /^(\d{4})\s*[-/]\s*(\d{2}|\d{4})$/.exec(teacherProfile.schoolYear);
    schoolYearMonths.forEach((monthNumber, index) => {
      if (!schoolYearMatch) return;
      const column = attendanceColumns[index];
      const expectedMonth = new Date(Date.UTC(2000, monthNumber - 1, 1))
        .toLocaleString("en-US", { month: "short", timeZone: "UTC" });
      const templateMonth = cellText(sheet.getCell(`${column}4`).value);
      if (templateMonth !== expectedMonth) {
        throw new Error(`The SF9 template month in column ${column} should be ${expectedMonth}.`);
      }
      const startYear = Number(schoolYearMatch[1]);
      const year = monthNumber >= 6 ? startYear : startYear + 1;
      const month = studentData.attendanceMonths[`${year}-${String(monthNumber).padStart(2, "0")}`];
      if (!month) return;
      sheet.getCell(`${column}5`).value = month.classDays || 0;
      sheet.getCell(`${column}7`).value = month.present || 0;
      sheet.getCell(`${column}9`).value = month.absent || 0;
      attendanceTotals.classDays += month.classDays || 0;
      attendanceTotals.present += month.present || 0;
      attendanceTotals.absent += month.absent || 0;
    });
    if (Object.keys(studentData.attendanceMonths).length) {
      sheet.getCell("AC5").value = attendanceTotals.classDays;
      sheet.getCell("AC7").value = attendanceTotals.present;
      sheet.getCell("AC9").value = attendanceTotals.absent;
    }

    const commentBoxes = [
      { term: "Term 1", cell: "Q15", firstRow: 15, lastRow: 18 },
      { term: "Term 2", cell: "Q19", firstRow: 19, lastRow: 22 },
      { term: "Term 3", cell: "Q23", firstRow: 23, lastRow: 26 },
    ];
    const commentBoxWidthPixels = Array.from({ length: 13 }, (_, index) =>
      ((sheet.getColumn(index + 17).width || 8.43) * 7) + 5)
      .reduce((total, width) => total + width, 0);
    const commentCharactersPerLine = Math.max(30, Math.floor(commentBoxWidthPixels / 6));
    for (const { term, cell, firstRow, lastRow } of commentBoxes) {
      const comment = studentData.teacherComments[term];
      if (!comment) continue;
      const commentCell = sheet.getCell(cell);
      commentCell.value = `Term ${term.slice(-1)}\n${comment}`;
      commentCell.alignment = {
        ...commentCell.alignment,
        horizontal: "left",
        vertical: "top",
        wrapText: true,
      };
      commentCell.font = { ...commentCell.font, size: 10 };
      const lineCount = comment.split(/\r?\n/).reduce(
        (total, line) => total + Math.max(1, Math.ceil(line.length / commentCharactersPerLine)),
        0,
      ) + 1;
      const currentHeight = Array.from(
        { length: lastRow - firstRow + 1 },
        (_, index) => sheet.getRow(firstRow + index).height || 15,
      ).reduce((total, height) => total + height, 0);
      const requiredHeight = (lineCount * 12) + 4;
      if (requiredHeight > currentHeight) {
        sheet.getRow(firstRow).height =
          Math.min(409.5, (sheet.getRow(firstRow).height || 15) + requiredHeight - currentHeight);
      }
    }

    if (schoolLogo) {
      const leftLogo = sheet.getImages().find((image) =>
        image.range.tl.nativeCol <= 1 && image.range.tl.nativeRow === 3);
      if (leftLogo?.range.ext) {
        leftLogo.range.ext.width = SF9_LOGO_PIXELS;
        leftLogo.range.ext.height = SF9_LOGO_PIXELS;
      }
      const existingLogo = sheet.getImages().find((image) =>
        image.range.tl.nativeCol === 9 && image.range.tl.nativeRow === 3);
      if (existingLogo) {
        // ExcelJS has no public image-removal method; replace the template's school-logo anchor.
        const imageIndex = sheet._media.indexOf(existingLogo);
        if (imageIndex >= 0) sheet._media.splice(imageIndex, 1);
      }
      const circularLogo = await createCircularTransparentLogo(schoolLogo.buffer, 512);
      sheet.addImage(workbook.addImage({
        buffer: circularLogo,
        extension: "png",
      }), {
        tl: { col: 9, row: 3 },
        ext: { width: SF9_LOGO_PIXELS, height: SF9_LOGO_PIXELS },
      });
    }

    const reportSubjects = sf9ReportSubjectsForGrade(teacherProfile.grade, teacherProfile.strand);
    const subjectRows = reportSubjects.slice(0, 10).map((subject, index) => [subject, 32 + index]);
    const termColumns = ["F", "G", "H"];
    for (let index = 0; index < 10; index += 1) {
      const subject = subjectRows[index]?.[0];
      const rowNumber = 32 + index;
      const label = subject?.[1]?.replace(/\s*\(average\)$/i, "") || "";
      sheet.getCell(rowNumber, 1).value = null;
      sheet.getCell(rowNumber, 2).value = label;
      if (!subject) {
        for (const column of [...termColumns, "I", "J"]) sheet.getCell(`${column}${rowNumber}`).value = null;
        continue;
      }
      GRADE_TERMS.forEach((term, termIndex) => {
        const grade = studentData.grades[term][subject[0]];
        sheet.getCell(`${termColumns[termIndex]}${rowNumber}`).value =
          typeof grade === "number" ? grade : null;
      });
      const termGrades = termColumns.map((column) => sheet.getCell(`${column}${rowNumber}`).value);
      if (termGrades.every((grade) => typeof grade === "number" && Number.isFinite(grade))) {
        const finalGrade = Math.round(termGrades.reduce((total, grade) => total + grade, 0) / termGrades.length);
        sheet.getCell(`I${rowNumber}`).value = finalGrade;
        sheet.getCell(`J${rowNumber}`).value = finalGrade >= 75 ? "Passed" : "Failed";
      } else {
        sheet.getCell(`I${rowNumber}`).value = null;
        sheet.getCell(`J${rowNumber}`).value = null;
      }
    }

    const extraSubjects = reportSubjects.slice(10);
    if (extraSubjects.length) {
      const extraSheet = workbook.addWorksheet("Additional Subjects");
      extraSheet.addRow(["Subject", ...GRADE_TERMS, "Average"]);
      for (const [key, label] of extraSubjects) {
        const grades = GRADE_TERMS.map((term) => studentData.grades[term][key]);
        extraSheet.addRow([
          label,
          ...grades.map((grade) => typeof grade === "number" ? grade : ""),
          grades.every((grade) => typeof grade === "number")
            ? Math.round(grades.reduce((total, grade) => total + grade, 0) / grades.length)
            : "",
        ]);
      }
      extraSheet.getRow(1).font = { bold: true };
      extraSheet.views = [{ state: "frozen", ySplit: 1 }];
      extraSheet.columns = [{ width: 52 }, { width: 14 }, { width: 14 }, { width: 14 }, { width: 14 }];
    }

    const annualSubjectGrades = generalAverageSubjectsForGrade(teacherProfile.grade, teacherProfile.strand)
      .map((key) => {
        const grades = GRADE_TERMS.map((term) => studentData.grades[term][key]);
        return grades.every((grade) => typeof grade === "number" && Number.isFinite(grade))
          ? Math.round(grades.reduce((total, grade) => total + grade, 0) / grades.length)
          : null;
      });
    if (annualSubjectGrades.length && annualSubjectGrades.every((grade) => typeof grade === "number")) {
      const generalAverage = Math.round(annualSubjectGrades.reduce((total, grade) => total + grade, 0) / annualSubjectGrades.length);
      sheet.getCell("I42").value = generalAverage;
      sheet.getCell("J42").value = generalAverage >= 75 ? "Passed" : "Failed";
    } else {
      sheet.getCell("I42").value = null;
      sheet.getCell("J42").value = null;
    }

    const filenamePart = (value) => value.trim()
      .replace(/[^A-Za-z0-9-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const filename = `SF9_${filenamePart(studentData.name)}_${filenamePart(teacherProfile.schoolYear)}.xlsx`;
    return {
      buffer: options.preview ? null : await serializeSF9Workbook(workbook),
      filename,
      previewHtml: options.preview ? renderSF9Preview(sheet, workbook, filename) : null,
    };
  }

  function assertStudentNotInactive(workbook, session, studentId) {
    const latest = (monthlyAttendanceStatusEvents(workbook, session, new Set([studentId])).get(studentId) || []).slice(-1)[0];
    if (latest && latest.status !== "Transferred In") {
      throw new HttpError(
        409,
        `This learner is tagged ${latest.status} and the grades are locked. Remove the tag from the Attendance page to edit them.`,
      );
    }
  }

  async function saveStudentGrades(session, data) {
    const term = validateGradeTerm(data.term);
    const studentId = typeof data.studentId === "string" ? data.studentId.trim() : "";
    if (!studentId || studentId.length > 40) {
      throw new HttpError(400, "Choose a student from your class roster.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const strand = getTeacherClassStrand(workbook, session);
      const gradeSubjectDefinitions = gradeSubjectsForGrade(getTeacherClassGrade(workbook, session), strand);
      const grades = validateStudentGrades(data.grades, gradeSubjectDefinitions);
      let teacherComment = null;
      if (data.teacherComment !== undefined) {
        if (typeof data.teacherComment !== "string" || data.teacherComment.length > 1000) {
          throw new HttpError(400, "Teacher's comment must be 1,000 characters or fewer.");
        }
        teacherComment = excelSafeText(data.teacherComment).trim();
      }
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      findOwnedStudent(studentSheet, studentColumns, session, studentId);
      assertStudentNotInactive(workbook, session, studentId);
      const { sheet: lockSheet, columns: lockColumns } = getGradeLockSheet(workbook);
      retireLegacyTermGradeLocks(session, lockSheet, lockColumns);
      let studentLockRow = null;
      for (let rowNumber = 2; rowNumber <= lockSheet.rowCount; rowNumber += 1) {
        const row = lockSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(lockColumns.classId).value) === session.classId
          && cellText(row.getCell(lockColumns.teacherUserId).value) === session.userId
          && cellText(row.getCell(lockColumns.term).value) === term
          && cellText(row.getCell(lockColumns.studentId).value) === studentId
        ) {
          studentLockRow = row;
          break;
        }
      }
      const isLocked = !studentLockRow
        || studentLockRow.getCell(lockColumns.locked).value === true
        || cellText(studentLockRow.getCell(lockColumns.locked).value).toLowerCase() === "true";
      if (isLocked) {
        throw new HttpError(
          409,
          `${term} grades for this student are locked. Enter your password to unlock before saving changes.`,
        );
      }
      const { sheet, columns } = getGradeSheet(workbook);
      const rowsBySubject = new Map();
      let existingTeacherComment = "";
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(columns.studentId).value) === studentId
          && cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(columns.term).value) === term
        ) {
          rowsBySubject.set(cellText(row.getCell(columns.subject).value), row);
          if (!existingTeacherComment) {
            existingTeacherComment = cellText(row.getCell(columns.teacherComment).value);
          }
        }
      }

      for (const [subject] of gradeSubjectDefinitions) {
        let row = rowsBySubject.get(subject);
        if (!row) {
          row = writeRow(sheet, [columns.id, columns.subject], {
            [columns.id]: nextGradeId(sheet, columns.id),
            [columns.studentId]: studentId,
            [columns.classId]: session.classId,
            [columns.teacherUserId]: session.userId,
            [columns.term]: term,
            [columns.subject]: subject,
            [columns.grade]: grades[subject],
            ...(teacherComment === null ? {} : { [columns.teacherComment]: teacherComment }),
            [columns.updated]: new Date(),
          });
          rowsBySubject.set(subject, row);
        } else {
          if (cellText(row.getCell(columns.source).value).toLowerCase() !== "e-class") {
            row.getCell(columns.grade).value = grades[subject];
            row.getCell(columns.updated).value = new Date();
          }
          if (teacherComment !== null) row.getCell(columns.teacherComment).value = teacherComment;
        }
        grades[subject] = row.getCell(columns.grade).value === null || row.getCell(columns.grade).value === undefined
          ? null
          : Number(row.getCell(columns.grade).value);
      }
      await saveDatabaseWorkbook(workbook);
      return {
        saved: true,
        studentId,
        term,
        grades,
        teacherComment: teacherComment === null ? existingTeacherComment : teacherComment,
        locked: false,
      };
    });
  }

  async function saveStudentSubjectGrade(session, data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new HttpError(400, "Enter the calculated subject grade or an empty value to clear it.");
    }
    const term = validateGradeTerm(data.term);
    const studentId = typeof data.studentId === "string" ? data.studentId.trim() : "";
    if (!studentId || studentId.length > 40) {
      throw new HttpError(400, "Choose a student from your class roster.");
    }
    const subject = typeof data.subject === "string" ? data.subject : "";
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const strand = getTeacherClassStrand(workbook, session);
      const gradeSubjectDefinitions = gradeSubjectsForGrade(getTeacherClassGrade(workbook, session), strand);
      if (!gradeSubjectDefinitions.some(([key]) => key === subject)) {
        throw new HttpError(400, "Choose a valid subject for the calculated grade.");
      }
      const grade = validateStudentGrades({ [subject]: data.grade }, gradeSubjectDefinitions)[subject];
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      findOwnedStudent(studentSheet, studentColumns, session, studentId);
      assertStudentNotInactive(workbook, session, studentId);
      const { sheet, columns } = getGradeSheet(workbook);
      let gradeRow = null;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(columns.studentId).value) === studentId
          && cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(columns.term).value) === term
          && cellText(row.getCell(columns.subject).value) === subject
        ) {
          gradeRow = row;
          break;
        }
      }
      if (!gradeRow) {
        gradeRow = writeRow(sheet, [columns.id, columns.subject], {
          [columns.id]: nextGradeId(sheet, columns.id),
          [columns.studentId]: studentId,
          [columns.classId]: session.classId,
          [columns.teacherUserId]: session.userId,
          [columns.term]: term,
          [columns.subject]: subject,
          [columns.grade]: grade,
          [columns.source]: grade===null?"":"E-Class",
          [columns.updated]: new Date(),
        });
      } else {
        gradeRow.getCell(columns.grade).value = grade;
        gradeRow.getCell(columns.source).value = grade===null?"":"E-Class";
        gradeRow.getCell(columns.updated).value = new Date();
      }
      await saveDatabaseWorkbook(workbook);
      return { saved: true, studentId, term, subject, grade };
    });
  }

  async function getReadingAssessmentSummary(session, period, attemptNo) {
    if (!READING_PERIODS.includes(period)) {
      throw new HttpError(400, "Choose BOSY, MOSY, or EOSY for the assessment period.");
    }
    if (!Number.isSafeInteger(attemptNo) || attemptNo < 1) {
      throw new HttpError(400, "Choose a valid positive assessment attempt number.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = getOwnedStudents(studentSheet, studentColumns, session).map((student) => ({
        id: student.id,
        name: student.name,
        attemptNo,
        levels: Object.fromEntries(READING_LANGUAGES.map((language) => [language, ""])),
        assessedDates: Object.fromEntries(READING_LANGUAGES.map((language) => [language, ""])),
      }));
      const studentsById = new Map(students.map((student) => [student.id, student]));

      const readingSheet = workbook.getWorksheet("Reading Assessments");
      if (readingSheet) {
        const { columns } = getReadingAssessmentSheet(workbook);
        for (let rowNumber = 2; rowNumber <= readingSheet.rowCount; rowNumber += 1) {
          const row = readingSheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) !== session.classId
            || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
            || cellText(row.getCell(columns.period).value) !== period
          ) continue;
          const rawAttemptNo = Number(row.getCell(columns.attempt).value);
          const rowAttemptNo = Number.isSafeInteger(rawAttemptNo) && rawAttemptNo > 0 ? rawAttemptNo : 1;
          if (rowAttemptNo !== attemptNo) continue;
          const student = studentsById.get(cellText(row.getCell(columns.studentId).value));
          const language = cellText(row.getCell(columns.language).value);
          if (!student || !READING_LANGUAGES.includes(language)) continue;
          student.levels[language] = cellText(row.getCell(columns.level).value);
          const assessedDate = row.getCell(columns.assessed).value;
          student.assessedDates[language] = assessedDate instanceof Date
            ? assessedDate.toISOString().slice(0, 10)
            : cellText(assessedDate);
        }
      }

      return { period, attemptNo, languages: READING_LANGUAGES, levels: READING_LEVELS, students };
    });
  }

  async function saveReadingAssessment(session, data) {
    const period = typeof data.period === "string" ? data.period : "";
    if (!READING_PERIODS.includes(period)) {
      throw new HttpError(400, "Choose BOSY, MOSY, or EOSY for the assessment period.");
    }
    const attemptNo = data.attemptNo === undefined ? 1 : data.attemptNo;
    if (!Number.isSafeInteger(attemptNo) || attemptNo < 1) {
      throw new HttpError(400, "Choose a valid positive assessment attempt number.");
    }
    const studentId = typeof data.studentId === "string" ? data.studentId.trim() : "";
    if (!studentId || studentId.length > 40) {
      throw new HttpError(400, "Choose a student from your class roster.");
    }
    if (!data.levels || typeof data.levels !== "object" || Array.isArray(data.levels)) {
      throw new HttpError(400, "Enter a reading level for English and Filipino.");
    }
    const levels = {};
    for (const language of READING_LANGUAGES) {
      const value = data.levels[language];
      if (typeof value !== "string" || (value !== "" && !READING_LEVELS.includes(value))) {
        throw new HttpError(400, `Choose a valid ${language} reading level.`);
      }
      levels[language] = value;
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      findOwnedStudent(studentSheet, studentColumns, session, studentId);
      const { sheet, columns } = getReadingAssessmentSheet(workbook);
      const rowsByLanguage = new Map();
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(columns.studentId).value) === studentId
          && cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(columns.period).value) === period
          && (Number(row.getCell(columns.attempt).value) || 1) === attemptNo
        ) {
          rowsByLanguage.set(cellText(row.getCell(columns.language).value), row);
        }
      }

      const rowsToDelete = [];
      const assessmentDate = new Date();
      const assessedDates = {};
      for (const language of READING_LANGUAGES) {
        const existing = rowsByLanguage.get(language);
        if (!levels[language]) {
          if (existing) rowsToDelete.push(existing.number);
          assessedDates[language] = "";
          continue;
        }
        if (existing) {
          existing.getCell(columns.level).value = levels[language];
          existing.getCell(columns.assessed).value = assessmentDate;
          existing.getCell(columns.updated).value = assessmentDate;
        } else {
          writeRow(sheet, [columns.id], {
            [columns.id]: nextReadingAssessmentId(sheet, columns.id),
            [columns.studentId]: studentId,
            [columns.classId]: session.classId,
            [columns.teacherUserId]: session.userId,
            [columns.period]: period,
            [columns.language]: language,
            [columns.level]: levels[language],
            [columns.assessed]: assessmentDate,
            [columns.attempt]: attemptNo,
            [columns.updated]: assessmentDate,
          });
        }
        if (existing) existing.getCell(columns.attempt).value = attemptNo;
        assessedDates[language] = assessmentDate.toISOString().slice(0, 10);
      }
      rowsToDelete.sort((left, right) => right - left).forEach((rowNumber) => sheet.spliceRows(rowNumber, 1));
      await saveDatabaseWorkbook(workbook);
      return { saved: true, attemptNo, assessedDates };
    });
  }

  function getPhilIriClassProfile(workbook, session) {
    const { sheet, columns } = getClassSheet(workbook);
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      if (cellText(row.getCell(columns.id).value) === session.classId
        && cellText(row.getCell(columns.teacherId).value) === session.userId) {
        return {
          classId: session.classId,
          teacherUserId: session.userId,
          grade: cellText(row.getCell(columns.grade).value).replace(/^\s*(?:Grade\s*)?(\d+)\s*$/i, "Grade $1"),
          section: cellText(row.getCell(columns.section).value),
          schoolName: cellText(row.getCell(columns.schoolName).value),
          schoolId: cellText(row.getCell(columns.schoolId).value),
          schoolHead: cellText(row.getCell(columns.schoolHead).value),
          schoolYear: cellText(row.getCell(columns.schoolYear).value),
        };
      }
    }
    throw new HttpError(404, "The teacher's classroom could not be found.");
  }

  function getPhilIriCutoffs(workbook, session) {
    const profile = getPhilIriClassProfile(workbook, session);
    const { sheet, columns } = getPhilIriCutoffSheet(workbook);
    return {
      profile,
      cutoffs: Object.fromEntries(PHILIRI_GRADES.map((grade) => [
        grade,
        Object.fromEntries(READING_LANGUAGES.map((language) => [language, ""])),
      ])),
      rows: Array.from({ length: Math.max(0, sheet.rowCount - 1) }, (_, index) => sheet.getRow(index + 2))
        .filter((row) => cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId),
    };
  }

  function getPhilIriCutoffValue(workbook, session, grade, language) {
    const { sheet, columns } = getPhilIriCutoffSheet(workbook);
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      if (cellText(row.getCell(columns.classId).value) === session.classId
        && cellText(row.getCell(columns.teacherUserId).value) === session.userId
        && cellText(row.getCell(columns.grade).value) === grade
        && cellText(row.getCell(columns.language).value) === language) {
        const score = row.getCell(columns.passingScore).value;
        return score === "" || score === null || score === undefined ? null : Number(score);
      }
    }
    return null;
  }

  async function getPhilIriSettings(session) {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { profile, cutoffs, rows } = getPhilIriCutoffs(workbook, session);
      const columns = getPhilIriCutoffSheet(workbook).columns;
      rows.forEach((row) => {
        const grade = cellText(row.getCell(columns.grade).value);
        const language = cellText(row.getCell(columns.language).value);
        if (Object.hasOwn(cutoffs, grade) && READING_LANGUAGES.includes(language)) {
          const score = row.getCell(columns.passingScore).value;
          cutoffs[grade][language] = score === "" || score === null ? "" : Number(score);
        }
      });
      return {
        profile,
        scoringGuide: getPhilIriAutoScoringGuide(profile.grade),
        grades: PHILIRI_GRADES,
        languages: READING_LANGUAGES,
        interventions: PHILIRI_INTERVENTIONS,
        cutoffs,
      };
    });
  }

  async function savePhilIriSettings(session, data) {
    if (!data || typeof data.cutoffs !== "object" || Array.isArray(data.cutoffs)) {
      throw new HttpError(400, "Enter the GST passing score settings for Grades 4–6.");
    }
    const values = [];
    for (const grade of PHILIRI_GRADES) {
      const gradeCutoffs = data.cutoffs[grade];
      if (!gradeCutoffs || typeof gradeCutoffs !== "object" || Array.isArray(gradeCutoffs)) {
        throw new HttpError(400, `Enter English and Filipino GST cutoffs for ${grade}.`);
      }
      for (const language of READING_LANGUAGES) {
        const score = gradeCutoffs[language];
        if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 10000) {
          throw new HttpError(400, `Enter a whole-number ${language} GST passing score for ${grade}.`);
        }
        if (!Number.isInteger(score)) throw new HttpError(400, `Enter a whole-number ${language} GST passing score for ${grade}.`);
        values.push({ grade, language, score });
      }
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getPhilIriCutoffSheet(workbook);
      const existingRows = new Map();
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId) {
          existingRows.set(
            `${cellText(row.getCell(columns.grade).value)}\u0000${cellText(row.getCell(columns.language).value)}`,
            row,
          );
        }
      }
      const updated = new Date();
      for (const value of values) {
        const key = `${value.grade}\u0000${value.language}`;
        const existing = existingRows.get(key);
        if (existing) {
          existing.getCell(columns.passingScore).value = value.score;
          existing.getCell(columns.updated).value = updated;
        } else {
          writeRow(sheet, [columns.classId, columns.grade, columns.language], {
            [columns.classId]: session.classId,
            [columns.teacherUserId]: session.userId,
            [columns.grade]: value.grade,
            [columns.language]: value.language,
            [columns.passingScore]: value.score,
            [columns.updated]: updated,
          });
        }
      }
      await saveDatabaseWorkbook(workbook);
      return { saved: true };
    });
  }

  function validatePhilIriDate(value, fieldName) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
      || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
      throw new HttpError(400, `Enter a valid ${fieldName}.`);
    }
    return value;
  }

  function validatePhilIriNumber(value, fieldName, { minimum = 0, maximum = 100000 } = {}) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
      throw new HttpError(400, `Enter a valid ${fieldName}.`);
    }
    return value;
  }

  function classifyPhilIriReading(mode, accuracy, comprehension) {
    if (mode === "Silent Reading") {
      if (comprehension >= 80) return "Independent";
      if (comprehension <= 58) return "Frustration";
      return "Instructional";
    }
    if (accuracy >= 97 && comprehension >= 80) return "Independent";
    if (accuracy <= 89 || comprehension <= 58) return "Frustration";
    return "Instructional";
  }

  function recommendedPhilIriIntervention(level) {
    if (level === "Frustration") return "One-on-One Reading";
    if (level === "Instructional") return "Guided Reading";
    if (level === "Independent") return "Home Reading Program";
    return "";
  }

  function parsePhilIriData(value, rowNumber) {
    const text = cellText(value);
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid data shape");
      return parsed;
    } catch (error) {
      throw new Error(`PHIL-IRI assessment row ${rowNumber} contains invalid assessment data.`, { cause: error });
    }
  }

  async function getPhilIriAssessmentSummary(session, period, assessmentType, schoolWide = false) {
    if (!READING_PERIODS.includes(period)) {
      throw new HttpError(400, "Choose BOSY, MOSY, or EOSY for the assessment period.");
    }
    if (!PHILIRI_ASSESSMENT_TYPES.includes(assessmentType)) {
      throw new HttpError(400, "Choose Pretest or Posttest.");
    }
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const profile = getPhilIriClassProfile(workbook, session);
      let allowedClasses = new Map([[session.classId, {
        classId: session.classId,
        teacherUserId: session.userId,
        grade: profile.grade,
        section: profile.section,
      }]]);
      if (schoolWide) {
        if (!profile.schoolId) throw new HttpError(400, "Enter the School ID in Teacher Profile before opening school reports.");
        const { sheet: classes, columns } = getClassSheet(workbook);
        allowedClasses = new Map();
        for (let rowNumber = 2; rowNumber <= classes.rowCount; rowNumber += 1) {
          const row = classes.getRow(rowNumber);
          if (cellText(row.getCell(columns.schoolId).value) !== profile.schoolId) continue;
          const classId = cellText(row.getCell(columns.id).value);
          const teacherUserId = cellText(row.getCell(columns.teacherId).value);
          if (!classId || !teacherUserId) continue;
          allowedClasses.set(classId, {
            classId,
            teacherUserId,
            grade: cellText(row.getCell(columns.grade).value),
            section: cellText(row.getCell(columns.section).value),
          });
        }
      }
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = [];
      for (let rowNumber = 2; rowNumber <= studentSheet.rowCount; rowNumber += 1) {
        const row = studentSheet.getRow(rowNumber);
        const classId = cellText(row.getCell(studentColumns.classId).value);
        const classroom = allowedClasses.get(classId);
        const id = cellText(row.getCell(studentColumns.id).value);
        const name = cellText(row.getCell(studentColumns.name).value);
        if (!classroom || cellText(row.getCell(studentColumns.teacherUserId).value) !== classroom.teacherUserId
          || !id || !name) continue;
        students.push({
          id,
          name,
          lrn: cellText(row.getCell(studentColumns.lrn).value),
          classId,
          grade: classroom.grade,
          section: classroom.section,
          languages: Object.fromEntries(READING_LANGUAGES.map((language) => [language, {}])),
        });
      }
      const studentsById = new Map(students.map((student) => [student.id, student]));
      const { sheet: assessmentSheet, columns: assessmentColumns } = getPhilIriAssessmentSheet(workbook);
      for (let rowNumber = 2; rowNumber <= assessmentSheet.rowCount; rowNumber += 1) {
        const row = assessmentSheet.getRow(rowNumber);
        const classId = cellText(row.getCell(assessmentColumns.classId).value);
        const classroom = allowedClasses.get(classId);
        const assessmentTypeValue = cellText(row.getCell(assessmentColumns.assessmentType).value);
        if (!classroom
          || cellText(row.getCell(assessmentColumns.teacherUserId).value) !== classroom.teacherUserId
          || cellText(row.getCell(assessmentColumns.period).value) !== period
          || assessmentTypeValue !== assessmentType) continue;
        const student = studentsById.get(cellText(row.getCell(assessmentColumns.studentId).value));
        const language = cellText(row.getCell(assessmentColumns.language).value);
        if (!student || !READING_LANGUAGES.includes(language)) continue;
        const assessedValue = row.getCell(assessmentColumns.assessed).value;
        const data = parsePhilIriData(row.getCell(assessmentColumns.data).value, rowNumber);
        student.languages[language] = {
          assessmentId: cellText(row.getCell(assessmentColumns.id).value),
          period,
          assessmentType,
          language,
          readingLevel: cellText(row.getCell(assessmentColumns.level).value),
          assessedDate: assessedValue instanceof Date ? assessedValue.toISOString().slice(0, 10) : cellText(assessedValue),
          data,
        };
      }
      const results = students.map((student) => {
        const result = { ...student };
        delete result.languages;
        result.reading = student.languages;
        return result;
      });
      return {
        period,
        assessmentType,
        languages: READING_LANGUAGES,
        levels: PHILIRI_LEVELS,
        modes: PHILIRI_MODES,
        interventions: PHILIRI_INTERVENTIONS,
        profile,
        schoolWide,
        students: results,
      };
    });
  }

  async function savePhilIriAssessment(session, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "Enter assessment details.");
    const studentId = typeof input.studentId === "string" ? input.studentId.trim() : "";
    if (!studentId || studentId.length > 40) throw new HttpError(400, "Choose a learner from your class roster.");
    const period = typeof input.period === "string" ? input.period : "";
    if (!READING_PERIODS.includes(period)) throw new HttpError(400, "Choose BOSY, MOSY, or EOSY.");
    const assessmentType = typeof input.assessmentType === "string" ? input.assessmentType : "";
    if (!PHILIRI_ASSESSMENT_TYPES.includes(assessmentType)) throw new HttpError(400, "Choose Pretest or Posttest.");
    const language = typeof input.language === "string" ? input.language : "";
    if (!READING_LANGUAGES.includes(language)) throw new HttpError(400, "Choose English or Filipino.");
    const stage = input.stage;
    if (stage !== "GST" && stage !== "Individualized") throw new HttpError(400, "Choose Group Screening Test or Individualized Assessment.");
    const assessedDate = validatePhilIriDate(input.assessedDate, "assessment date");
    const assessor = typeof input.assessor === "string" ? input.assessor.trim() : "";
    if (!assessor || assessor.length > 120) throw new HttpError(400, "Enter the assessor or teacher's name.");
    const difficultyObserved = typeof input.difficultyObserved === "string" ? input.difficultyObserved.trim() : "";
    const progressNotes = typeof input.progressNotes === "string" ? input.progressNotes.trim() : "";
    const teacherRemarks = typeof input.teacherRemarks === "string" ? input.teacherRemarks.trim() : "";
    const recommendedIntervention = typeof input.recommendedIntervention === "string"
      ? input.recommendedIntervention
      : "";
    if (difficultyObserved.length > 1000 || progressNotes.length > 2000 || teacherRemarks.length > 2000) {
      throw new HttpError(400, "Keep assessment notes within the allowed length.");
    }
    if (recommendedIntervention && !PHILIRI_INTERVENTIONS.includes(recommendedIntervention)) {
      throw new HttpError(400, "Choose a valid intervention type.");
    }
    const interventionStartDate = input.interventionStartDate
      ? validatePhilIriDate(input.interventionStartDate, "intervention start date")
      : "";
    const interventionEndDate = input.interventionEndDate
      ? validatePhilIriDate(input.interventionEndDate, "intervention end date")
      : "";
    if (interventionStartDate && interventionEndDate && interventionEndDate < interventionStartDate) {
      throw new HttpError(400, "The intervention end date cannot be before its start date.");
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const studentRow = findOwnedStudent(studentSheet, studentColumns, session, studentId);
      const student = {
        id: cellText(studentRow.getCell(studentColumns.id).value),
        name: cellText(studentRow.getCell(studentColumns.name).value),
      };
      const profile = getPhilIriClassProfile(workbook, session);
      if (!PHILIRI_GRADES.includes(profile.grade)) {
        throw new HttpError(400, "Set the class grade to Grade 4, Grade 5, or Grade 6 in Teacher Profile before recording PHIL-IRI assessments.");
      }
      const cutoff = getPhilIriCutoffValue(workbook, session, profile.grade, language);
      if (cutoff === null) {
        throw new HttpError(400, `Configure the ${profile.grade} ${language} GST passing score in PHIL-IRI Settings first.`);
      }
      const { sheet, columns } = getPhilIriAssessmentSheet(workbook);
      let assessmentRow = null;
      let assessmentData = {};
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (cellText(row.getCell(columns.studentId).value) === studentId
          && cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(columns.period).value) === period
          && cellText(row.getCell(columns.assessmentType).value) === assessmentType
          && cellText(row.getCell(columns.language).value) === language) {
          assessmentRow = row;
          assessmentData = parsePhilIriData(row.getCell(columns.data).value, rowNumber);
          break;
        }
      }
      if (stage === "GST") {
        const score = validatePhilIriNumber(input.gstScore, "GST score");
        const totalItems = validatePhilIriNumber(input.gstTotalItems, "GST total items", { minimum: 1 });
        if (!Number.isInteger(score) || !Number.isInteger(totalItems) || score > totalItems) {
          throw new HttpError(400, "Enter whole-number GST scores, with score no greater than total items.");
        }
        assessmentData.gst = {
          score,
          totalItems,
          percentageScore: Math.round((score / totalItems) * 10000) / 100,
          passingScore: cutoff,
          passed: score >= cutoff,
        };
      } else {
        const mode = typeof input.readingMode === "string" ? input.readingMode : "";
        if (!PHILIRI_MODES.includes(mode)) throw new HttpError(400, "Choose Oral Reading or Silent Reading.");
        if (!assessmentData.gst) throw new HttpError(400, "Record the Group Screening Test before Individualized Assessment.");
        if (assessmentData.gst.passed) throw new HttpError(400, "This learner passed the GST and does not require Individualized Assessment.");
        const totalWords = validatePhilIriNumber(input.totalWords, "total words", { minimum: 1 });
        const miscues = validatePhilIriNumber(input.miscues, "miscue/error count");
        const timeSeconds = validatePhilIriNumber(input.timeSeconds, "reading time in seconds", { minimum: 1 });
        const correctAnswers = validatePhilIriNumber(input.correctAnswers, "correct comprehension answers");
        const totalQuestions = validatePhilIriNumber(input.totalQuestions, "total comprehension questions", { minimum: 1 });
        if (![totalWords, miscues, timeSeconds, correctAnswers, totalQuestions].every(Number.isInteger)
          || miscues > totalWords || correctAnswers > totalQuestions) {
          throw new HttpError(400, "Enter whole-number reading results within the passage and question totals.");
        }
        const accuracyPercentage = Math.round(((totalWords - miscues) / totalWords) * 10000) / 100;
        const comprehensionPercentage = Math.round((correctAnswers / totalQuestions) * 10000) / 100;
        const readingLevel = classifyPhilIriReading(mode, accuracyPercentage, comprehensionPercentage);
        const recommended = recommendedPhilIriIntervention(readingLevel);
        const startDate = input.interventionStartDate
          ? validatePhilIriDate(input.interventionStartDate, "intervention start date")
          : "";
        const endDate = input.interventionEndDate
          ? validatePhilIriDate(input.interventionEndDate, "intervention end date")
          : "";
        assessmentData.individualized = assessmentData.individualized || {};
        assessmentData.individualized[mode] = {
          mode,
          passage: typeof input.passage === "string" ? input.passage.trim().slice(0, 500) : "",
          totalWords,
          miscues,
          timeSeconds,
          wordsPerMinute: Math.round((totalWords / (timeSeconds / 60)) * 100) / 100,
          accuracyPercentage,
          correctAnswers,
          totalQuestions,
          comprehensionPercentage,
          readingLevel,
          difficultyObserved,
          recommendedIntervention: recommendedIntervention || recommended,
          interventionStartDate: startDate,
          interventionEndDate: endDate,
          progressNotes,
          teacherRemarks,
        };
        assessmentData.intervention = {
          difficultyObserved,
          recommendedIntervention: recommendedIntervention || recommended,
          interventionStartDate: startDate,
          interventionEndDate: endDate,
          progressNotes,
          teacherRemarks,
        };
      }
      const latestIndividual = assessmentData.individualized
        ? assessmentData.individualized["Oral Reading"] || assessmentData.individualized["Silent Reading"]
        : null;
      const readingLevel = latestIndividual ? latestIndividual.readingLevel : "";
      const now = new Date();
      const savedData = {
        ...assessmentData,
        assessmentType,
        assessedDate,
        assessor,
        grade: profile.grade,
        section: profile.section,
      };
      const dataJson = JSON.stringify(savedData);
      if (assessmentRow) {
        assessmentRow.getCell(columns.level).value = readingLevel;
        assessmentRow.getCell(columns.assessed).value = assessedDate;
        assessmentRow.getCell(columns.data).value = dataJson;
        assessmentRow.getCell(columns.updated).value = now;
      } else {
        writeRow(sheet, [columns.id], {
          [columns.id]: nextReadingAssessmentId(sheet, columns.id),
          [columns.studentId]: student.id,
          [columns.classId]: session.classId,
          [columns.teacherUserId]: session.userId,
          [columns.period]: period,
          [columns.assessmentType]: assessmentType,
          [columns.language]: language,
          [columns.level]: readingLevel,
          [columns.assessed]: assessedDate,
          [columns.data]: dataJson,
          [columns.updated]: now,
        });
      }
      await saveDatabaseWorkbook(workbook);
      return {
        saved: true,
        studentId,
        studentName: student.name,
        period,
        assessmentType,
        language,
        readingLevel,
        data: savedData,
      };
    });
  }

  async function getPhilIriAutoScoring(session, studentId, period, assessmentType, language) {
    if (!studentId || studentId.length > 40) throw new HttpError(400, "Choose a learner from your class roster.");
    if (!READING_PERIODS.includes(period)) throw new HttpError(400, "Choose BOSY, MOSY, or EOSY.");
    if (!PHILIRI_ASSESSMENT_TYPES.includes(assessmentType)) throw new HttpError(400, "Choose Pretest or Posttest.");
    if (!READING_LANGUAGES.includes(language)) throw new HttpError(400, "Choose English or Filipino.");
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      findOwnedStudent(studentSheet, studentColumns, session, studentId);
      const { sheet, columns } = getPhilIriAssessmentSheet(workbook);
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (cellText(row.getCell(columns.studentId).value) !== studentId
          || cellText(row.getCell(columns.classId).value) !== session.classId
          || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
          || cellText(row.getCell(columns.period).value) !== period
          || cellText(row.getCell(columns.assessmentType).value) !== assessmentType
          || cellText(row.getCell(columns.language).value) !== language) continue;
        const data = parsePhilIriData(row.getCell(columns.data).value, rowNumber);
        const profile = getPhilIriClassProfile(workbook, session);
        return {
          period,
          assessmentType,
          language,
          scoringGuide: getPhilIriAutoScoringGuide(profile.grade),
          autoScoring: data.autoScoring || null,
        };
      }
      const profile = getPhilIriClassProfile(workbook, session);
      return {
        period,
        assessmentType,
        language,
        scoringGuide: getPhilIriAutoScoringGuide(profile.grade),
        autoScoring: null,
      };
    });
  }

  async function savePhilIriAutoScoring(session, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new HttpError(400, "Enter PHIL-IRI auto-scoring details.");
    }
    const studentId = typeof input.studentId === "string" ? input.studentId.trim() : "";
    if (!studentId || studentId.length > 40) throw new HttpError(400, "Choose a learner from your class roster.");
    const period = typeof input.period === "string" ? input.period : "";
    if (!READING_PERIODS.includes(period)) throw new HttpError(400, "Choose BOSY, MOSY, or EOSY.");
    const assessmentType = typeof input.assessmentType === "string" ? input.assessmentType : "";
    if (!PHILIRI_ASSESSMENT_TYPES.includes(assessmentType)) throw new HttpError(400, "Choose Pretest or Posttest.");
    const language = typeof input.language === "string" ? input.language : "";
    if (!READING_LANGUAGES.includes(language)) throw new HttpError(400, "Choose English or Filipino.");
    const assessmentMode = typeof input.assessmentMode === "string" && input.assessmentMode
      ? input.assessmentMode
      : "Oral Reading";
    if (!PHILIRI_AUTO_SCORING_MODES.includes(assessmentMode)) {
      throw new HttpError(400, "Choose Oral Reading, Silent Reading, or Listening Comprehension.");
    }
    const scoreFields = [
      "gstScore",
      "totalWords",
      "miscues",
      "timeSeconds",
      "comprehensionCorrect",
      "comprehensionTotal",
    ];
    const scores = {};
    for (const field of scoreFields) {
      const value = input[field];
      if (value === "" || value === null || value === undefined) {
        scores[field] = null;
        continue;
      }
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0 || number > 100000) {
        throw new HttpError(400, "Enter whole-number PHIL-IRI scores within the allowed range.");
      }
      scores[field] = number;
    }
    if (scores.gstScore === null) throw new HttpError(400, "Enter the learner's GST raw score before saving.");
    if (scores.totalWords === 0 || scores.timeSeconds === 0 || scores.comprehensionTotal === 0) {
      throw new HttpError(400, "Words, reading time, and comprehension totals must be greater than zero.");
    }
    if (scores.miscues !== null && scores.totalWords !== null && scores.miscues > scores.totalWords) {
      throw new HttpError(400, "Miscues cannot exceed total words.");
    }
    if (scores.comprehensionCorrect !== null && scores.comprehensionTotal !== null
      && scores.comprehensionCorrect > scores.comprehensionTotal) {
      throw new HttpError(400, "Comprehension correct cannot exceed the total questions.");
    }
    const modeFields = assessmentMode === "Oral Reading"
      ? ["totalWords", "miscues", "timeSeconds", "comprehensionCorrect", "comprehensionTotal"]
      : assessmentMode === "Silent Reading"
        ? ["totalWords", "timeSeconds", "comprehensionCorrect", "comprehensionTotal"]
        : ["comprehensionCorrect", "comprehensionTotal"];
    const hasIndividualScores = modeFields.some((field) => scores[field] !== null);
    if (hasIndividualScores) {
      const missingField = modeFields.some((field) => scores[field] === null);
      if (missingField) {
        throw new HttpError(400, `Complete all ${assessmentMode.toLowerCase()} scores before saving.`);
      }
    }
    const assessedDate = validatePhilIriDate(input.assessedDate, "assessment date");
    const assessor = typeof session.name === "string" ? session.name.trim() : "";
    if (!assessor || assessor.length > 120) {
      throw new HttpError(400, "Your teacher profile must include a name before saving scores.");
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const studentRow = findOwnedStudent(studentSheet, studentColumns, session, studentId);
      const { sheet, columns } = getPhilIriAssessmentSheet(workbook);
      let assessmentRow = null;
      let assessmentData = {};
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (cellText(row.getCell(columns.studentId).value) === studentId
          && cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(columns.period).value) === period
          && cellText(row.getCell(columns.assessmentType).value) === assessmentType
          && cellText(row.getCell(columns.language).value) === language) {
          assessmentRow = row;
          assessmentData = parsePhilIriData(row.getCell(columns.data).value, rowNumber);
          break;
        }
      }
      const profile = getPhilIriClassProfile(workbook, session);
      const scoringGuide = getPhilIriAutoScoringGuide(profile.grade);
      if (!scoringGuide.supported) {
        throw new HttpError(400, scoringGuide.source);
      }
      if (scores.gstScore > scoringGuide.totalItems) {
        throw new HttpError(400, `The ${profile.grade} GST score cannot exceed ${scoringGuide.totalItems} items.`);
      }
      const gstPassed = scores.gstScore >= scoringGuide.passingScore;
      if (hasIndividualScores && gstPassed) {
        throw new HttpError(400, "The learner passed the GST and does not require individualized assessment.");
      }
      const previousAutoScoring = assessmentData.autoScoring || {};
      const modeResults = !gstPassed && previousAutoScoring.modeResults
        && typeof previousAutoScoring.modeResults === "object"
        ? { ...previousAutoScoring.modeResults }
        : {};
      if (!gstPassed && !previousAutoScoring.modeResults && previousAutoScoring.readingLevel) {
        const previousMode = PHILIRI_AUTO_SCORING_MODES.includes(previousAutoScoring.assessmentMode)
          ? previousAutoScoring.assessmentMode
          : "Oral Reading";
        modeResults[previousMode] = { ...previousAutoScoring };
      }
      if (hasIndividualScores) {
        const accuracy = assessmentMode === "Oral Reading"
          ? (scores.totalWords - scores.miscues) / scores.totalWords
          : null;
        const comprehension = scores.comprehensionCorrect / scores.comprehensionTotal;
        const readingLevel = assessmentMode === "Oral Reading"
          ? accuracy >= 0.97 && comprehension >= 0.8
            ? "Independent"
            : accuracy <= 0.89 || comprehension <= 0.58 ? "Frustration" : "Instructional"
          : comprehension >= 0.8 ? "Independent"
            : comprehension <= 0.58 ? "Frustration" : "Instructional";
        modeResults[assessmentMode] = {
          assessmentMode,
          ...Object.fromEntries(modeFields.map((field) => [field, scores[field]])),
          oralReading: accuracy,
          wordsPerMinute: assessmentMode === "Listening Comprehension"
            ? null
            : Math.round((scores.totalWords / (scores.timeSeconds / 60)) * 100) / 100,
          comprehension,
          readingLevel,
          startingPassage: getPhilIriStartingPassage(scores.gstScore, scoringGuide, language),
          intervention: readingLevel === "Independent" ? "Enrichment"
            : readingLevel === "Instructional" ? "Guided Reading" : "Intensive Remediation",
        };
      }
      const activeModeResult = modeResults[assessmentMode] || {};
      const autoScoring = {
        gstScore: scores.gstScore,
        gstTotalItems: scoringGuide.totalItems,
        gstPassingScore: scoringGuide.passingScore,
        gstStatus: gstPassed ? "PASS GST" : "INDIVIDUAL ASSESSMENT",
        passed: gstPassed,
        assessmentMode,
        ...activeModeResult,
        modeResults,
        assessedDate,
        assessor,
      };
      const savedData = {
        ...assessmentData,
        autoScoring,
        assessmentType,
        assessedDate,
        assessor,
        grade: profile.grade,
        section: profile.section,
      };
      const now = new Date();
      if (assessmentRow) {
        assessmentRow.getCell(columns.level).value = autoScoring.readingLevel
          || cellText(assessmentRow.getCell(columns.level).value);
        assessmentRow.getCell(columns.assessed).value = assessedDate;
        assessmentRow.getCell(columns.data).value = JSON.stringify(savedData);
        assessmentRow.getCell(columns.updated).value = now;
      } else {
        writeRow(sheet, [columns.id], {
          [columns.id]: nextReadingAssessmentId(sheet, columns.id),
          [columns.studentId]: cellText(studentRow.getCell(studentColumns.id).value),
          [columns.classId]: session.classId,
          [columns.teacherUserId]: session.userId,
          [columns.period]: period,
          [columns.assessmentType]: assessmentType,
          [columns.language]: language,
          [columns.level]: autoScoring.readingLevel || "",
          [columns.assessed]: assessedDate,
          [columns.data]: JSON.stringify(savedData),
          [columns.updated]: now,
        });
      }
      await saveDatabaseWorkbook(workbook);
      return {
        saved: true,
        studentId,
        period,
        assessmentType,
        language,
        scoringGuide,
        autoScoring,
      };
    });
  }

  async function exportPhilIriReport(session, period, assessmentType, scope, studentId = "", sectionFilter) {
    const schoolWide = scope === "school";
    if (scope !== "class" && !schoolWide) throw new HttpError(400, "Choose a class or school report.");
    const report = await getPhilIriAssessmentSummary(session, period, assessmentType, schoolWide);
    let students = studentId
      ? report.students.filter((student) => student.id === studentId && student.classId === session.classId)
      : report.students;
    if (!schoolWide && sectionFilter && sectionFilter !== "__all__") {
      const roster = await listStudents(session);
      const selectedIds = new Set(roster.students
        .filter((student) => matchesStudentSection(student, sectionFilter))
        .map((student) => student.id));
      students = students.filter((student) => selectedIds.has(student.id));
      report.profile.section = sectionFilter === "__unassigned__" ? "" : sectionFilter;
      const sectionGrade = Object.entries(roster.sectionGrades).find(([section]) =>
        section.toLocaleLowerCase() === report.profile.section.toLocaleLowerCase());
      if (sectionGrade) report.profile.grade = sectionGrade[1];
    }
    if (studentId && !students.length) throw new HttpError(404, "That learner is not in the selected report.");
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Class Adviser's Portal";
    workbook.subject = "PHIL-IRI reading assessment report";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(schoolWide ? "Division Submission" : "Class Profile");
    sheet.addRows([
      ["PHIL-IRI Reading Assessment Report"],
      ["School", report.profile.schoolName],
      ["School ID", report.profile.schoolId],
      ["School Year", report.profile.schoolYear],
      ["School Head", report.profile.schoolHead],
      ["Assessment Period", period],
      ["Assessment Type", assessmentType],
      ["Grade", schoolWide ? "All Grades 4–6" : report.profile.grade],
      ["Section", schoolWide ? "All sections" : report.profile.section],
      [],
      [
        "Grade", "Section", "Learner", "LRN", "Language", "Assessment Date", "Assessor",
        "GST Score", "GST Total Items", "GST Percentage", "GST Status", "Oral Passage",
        "Oral WPM", "Oral Accuracy %", "Oral Comprehension %", "Oral Reading Level",
        "Silent Passage", "Silent WPM", "Silent Accuracy %", "Silent Comprehension %",
        "Silent Reading Level", "Reading Difficulty", "Recommended Intervention",
        "Intervention Start Date", "Intervention End Date", "Progress Notes", "Teacher Remarks",
      ],
    ]);
    for (const student of students) {
      for (const language of READING_LANGUAGES) {
        const result = student.reading[language] || {};
        const data = result.data || {};
        const gst = data.gst || {};
        const oral = data.individualized && data.individualized["Oral Reading"] || {};
        const silent = data.individualized && data.individualized["Silent Reading"] || {};
        const intervention = data.intervention || {};
        sheet.addRow([
          student.grade, student.section, student.name, student.lrn, language,
          data.assessedDate || result.assessedDate, data.assessor || "",
          gst.score ?? "", gst.totalItems ?? "", gst.percentageScore ?? "",
          gst.passed === undefined ? "" : gst.passed ? "Passed" : "Failed — Individualized Assessment",
          oral.passage || "", oral.wordsPerMinute ?? "", oral.accuracyPercentage ?? "",
          oral.comprehensionPercentage ?? "", oral.readingLevel || "",
          silent.passage || "", silent.wordsPerMinute ?? "", silent.accuracyPercentage ?? "",
          silent.comprehensionPercentage ?? "", silent.readingLevel || "",
          intervention.difficultyObserved || "",
          intervention.recommendedIntervention || "",
          intervention.interventionStartDate || "", intervention.interventionEndDate || "",
          intervention.progressNotes || "", intervention.teacherRemarks || "",
        ]);
      }
    }
    sheet.columns = [
      { width: 14 }, { width: 18 }, { width: 28 }, { width: 16 }, { width: 14 },
      { width: 16 }, { width: 24 }, { width: 14 }, { width: 17 }, { width: 16 },
      { width: 34 }, { width: 30 }, { width: 14 }, { width: 16 }, { width: 21 },
      { width: 20 }, { width: 30 }, { width: 14 }, { width: 16 }, { width: 21 },
      { width: 20 }, { width: 32 }, { width: 28 }, { width: 18 }, { width: 18 },
      { width: 40 }, { width: 40 },
    ];
    sheet.getRow(11).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 11 }];
    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: `${schoolWide ? "PHIL-IRI_School_Consolidated" : studentId ? "PHIL-IRI_Learner_Report" : "PHIL-IRI_Class_Profile"}_${period}_${assessmentType}.xlsx`,
    };
  }

  // Phil-IRI Form 1A (TPPK, Filipino GST) and Form 1B (STCRR, English GST), built from the
  // learner results saved in the portal. The workbook is plain and unprotected.
  async function exportPhilIriForm(session, form, period, assessmentType, sectionFilter) {
    if (!["1A", "1B"].includes(form)) throw new HttpError(400, "Choose Phil-IRI Form 1A or Form 1B.");
    const language = form === "1A" ? "Filipino" : "English";
    const filipino = form === "1A";
    const report = await getPhilIriAssessmentSummary(session, period, assessmentType, false);
    const roster = await listStudents(session);
    const rosterById = new Map(roster.students.map((student) => [student.id, student]));
    const profile = { ...report.profile };
    let students = report.students.filter((student) => rosterById.has(student.id));
    if (sectionFilter && sectionFilter !== "__all__") {
      students = students.filter((student) => matchesStudentSection(rosterById.get(student.id), sectionFilter));
      profile.section = sectionFilter === "__unassigned__" ? "" : sectionFilter;
      const sectionGrade = Object.entries(roster.sectionGrades || {}).find(([section]) =>
        section.toLocaleLowerCase() === profile.section.toLocaleLowerCase());
      if (sectionGrade) profile.grade = sectionGrade[1];
    }
    const guide = getPhilIriAutoScoringGuide(profile.grade);
    const gradeNumber = Number(String(profile.grade).match(/\d+/)?.[0]) || "";

    const rows = students.map((student) => {
      const data = student.reading[language]?.data || {};
      const auto = data.autoScoring || {};
      const gst = data.gst || {};
      const score = Number.isFinite(Number(auto.gstScore ?? gst.score)) && (auto.gstScore ?? gst.score) !== null
        && (auto.gstScore ?? gst.score) !== "" && (auto.gstScore ?? gst.score) !== undefined
        ? Number(auto.gstScore ?? gst.score)
        : null;
      const cutoff = Number(auto.gstPassingScore) || (guide.supported ? guide.passingScore : null);
      const gender = String(rosterById.get(student.id).gender || "").toLowerCase();
      return {
        name: student.name,
        gender,
        score,
        cutoff,
        startingPassage: score === null || cutoff === null || score >= cutoff ? ""
          : auto.startingPassage || getPhilIriStartingPassage(score, guide, language),
      };
    });
    const cutoffs = rows.map((row) => row.cutoff).filter((value) => value !== null);
    const cutoff = cutoffs.length ? cutoffs[0] : guide.supported ? guide.passingScore : null;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Class Adviser's Portal";
    workbook.created = new Date();
    const sheet = workbook.addWorksheet(filipino ? "Form 1A - TPPK" : "Form 1B - STCRR");
    const text = filipino
      ? {
        title: "Talaan ng Pangkatang Pagtatasa ng Klase (TPPK)", grade: "Baitang", section: "Seksyon",
        teacher: "Guro", school: "Paaralan", date: "Petsa", level: "Antas ng Pangkatang Pagtatasa",
        name: "Pangalan", male: "Lalake", female: "Babae", taken: "Nakuha ang Pagtatasa",
        score: "Kabuuang Marka", below: "Markang <", atLeast: "Markang ≥", start: "Panimulang Antas ng Pasahe",
        total: "Kabuuan", taker: "Bilang ng Kumuha", pass: "Bilang ng Pumasa", fail: "Bilang ng Hindi Pumasa",
      }
      : {
        title: "Screening Test Class Reading Record (STCRR)", grade: "Grade", section: "Section",
        teacher: "Teacher", school: "School", date: "Date", level: "Screening Test Level",
        name: "Name", male: "Male", female: "Female", taken: "Test Taken",
        score: "Overall Score", below: "Score <", atLeast: "Score ≥", start: "Starting Point of Graded Passage",
        total: "Total", taker: "Learners who took the test", pass: "Learners who met the cutoff", fail: "Learners below the cutoff",
      };
    sheet.columns = [
      { width: 7 }, { width: 44 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 40 },
    ];
    const fontName = "Calibri";
    const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
    const border = { style: "thin", color: { argb: "FFC7CCE6" } };
    const boxed = (cell) => { cell.border = { top: border, left: border, bottom: border, right: border }; };
    sheet.mergeCells("A1:G1");
    sheet.getCell("A1").value = `Phil-IRI Form ${form}`;
    sheet.getCell("A1").font = { name: fontName, bold: true, size: 11, color: { argb: "FF6B7280" } };
    sheet.getCell("A1").alignment = { horizontal: "right" };
    sheet.mergeCells("A2:G2");
    sheet.getCell("A2").value = text.title;
    sheet.getCell("A2").font = { name: fontName, bold: true, size: 18, color: { argb: "FF312E81" } };
    sheet.getCell("A2").alignment = { horizontal: "center", vertical: "middle" };
    sheet.getRow(2).height = 32;
    const dates = students
      .map((student) => student.reading[language]?.assessedDate)
      .filter(Boolean)
      .sort();
    const dateText = dates.length
      ? dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`
      : "";
    const info = [
      [text.grade, profile.grade, text.section, profile.section],
      [text.school, profile.schoolName, text.teacher, session.name || ""],
      [text.level, gradeNumber, `${text.date} (${period} ${assessmentType})`, dateText],
    ];
    info.forEach((values, index) => {
      const rowNumber = 4 + index;
      sheet.getCell(`A${rowNumber}`).value = values[0];
      sheet.mergeCells(`A${rowNumber}:B${rowNumber}`);
      sheet.getCell(`C${rowNumber}`).value = values[1];
      sheet.mergeCells(`C${rowNumber}:D${rowNumber}`);
      sheet.getCell(`E${rowNumber}`).value = values[2];
      sheet.getCell(`F${rowNumber}`).value = values[3];
      sheet.mergeCells(`F${rowNumber}:G${rowNumber}`);
      sheet.getRow(rowNumber).height = 22;
      ["A", "B", "C", "D", "E", "F", "G"].forEach((column) => {
        const cell = sheet.getCell(`${column}${rowNumber}`);
        const isLabel = column === "A" || column === "B" || column === "E";
        cell.font = { name: fontName, size: 11, bold: isLabel, color: { argb: isLabel ? "FF312E81" : "FF111827" } };
        cell.fill = solid(isLabel ? "FFE0E7FF" : "FFF5F7FF");
        cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
        boxed(cell);
      });
    });
    const headerRow = 8;
    const headers = ["No.", `${text.name}`, text.taken, text.score,
      cutoff === null ? text.below : `${text.below} ${cutoff}`,
      cutoff === null ? text.atLeast : `${text.atLeast} ${cutoff}`, text.start];
    headers.forEach((value, index) => {
      const cell = sheet.getRow(headerRow).getCell(index + 1);
      cell.value = value;
      cell.font = { name: fontName, bold: true, size: 11, color: { argb: "FFFFFFFF" } };
      cell.fill = solid("FF4338CA");
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      boxed(cell);
    });
    sheet.getRow(headerRow).height = 40;

    let rowNumber = headerRow + 1;
    const addGroup = (label, accent, members) => {
      sheet.mergeCells(`A${rowNumber}:G${rowNumber}`);
      const labelCell = sheet.getCell(`A${rowNumber}`);
      labelCell.value = label;
      labelCell.font = { name: fontName, bold: true, size: 11, color: { argb: "FF1F2937" } };
      labelCell.fill = solid(accent);
      labelCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      sheet.getRow(rowNumber).height = 22;
      rowNumber += 1;
      members.forEach((member, index) => {
        const taken = member.score !== null;
        const passed = taken && member.cutoff !== null && member.score >= member.cutoff;
        const values = [
          index + 1, member.name, taken ? "✓" : "", taken ? member.score : "",
          taken && !passed ? "✓" : "", passed ? "✓" : "", member.startingPassage,
        ];
        sheet.getRow(rowNumber).height = 21;
        values.forEach((value, column) => {
          const cell = sheet.getRow(rowNumber).getCell(column + 1);
          cell.value = value;
          boxed(cell);
          cell.font = { name: fontName, size: 11, color: { argb: "FF111827" } };
          if (index % 2 === 1) cell.fill = solid("FFF8F9FF");
          if (column === 4 && value) {
            cell.fill = solid("FFFEE2E2");
            cell.font = { name: fontName, size: 11, bold: true, color: { argb: "FFB91C1C" } };
          }
          if (column === 5 && value) {
            cell.fill = solid("FFDCFCE7");
            cell.font = { name: fontName, size: 11, bold: true, color: { argb: "FF166534" } };
          }
          cell.alignment = column === 1 || column === 6
            ? { vertical: "middle", horizontal: "left", indent: 1 }
            : { vertical: "middle", horizontal: "center" };
        });
        rowNumber += 1;
      });
      if (!members.length) {
        sheet.mergeCells(`A${rowNumber}:G${rowNumber}`);
        sheet.getCell(`A${rowNumber}`).value = "No learners";
        sheet.getCell(`A${rowNumber}`).font = { italic: true, color: { argb: "FF777777" } };
        rowNumber += 1;
      }
    };
    addGroup(text.male.toUpperCase(), "FFBFDBFE", rows.filter((row) => row.gender === "male"));
    addGroup(text.female.toUpperCase(), "FFFBCFE8", rows.filter((row) => row.gender === "female"));
    const others = rows.filter((row) => row.gender !== "male" && row.gender !== "female");
    if (others.length) addGroup("OTHER", "FFEFEFEF", others);

    rowNumber += 1;
    const takers = rows.filter((row) => row.score !== null);
    const passers = takers.filter((row) => row.cutoff !== null && row.score >= row.cutoff);
    [
      [text.taker, takers.length],
      [text.pass, passers.length],
      [text.fail, takers.length - passers.length],
    ].forEach(([label, value]) => {
      sheet.mergeCells(`A${rowNumber}:C${rowNumber}`);
      sheet.getCell(`A${rowNumber}`).value = label;
      sheet.getCell(`A${rowNumber}`).font = { name: fontName, bold: true, size: 11, color: { argb: "FF312E81" } };
      sheet.getCell(`A${rowNumber}`).alignment = { vertical: "middle", horizontal: "left", indent: 1 };
      sheet.getCell(`D${rowNumber}`).value = value;
      sheet.getCell(`D${rowNumber}`).font = { name: fontName, bold: true, size: 11 };
      sheet.getCell(`D${rowNumber}`).alignment = { horizontal: "center", vertical: "middle" };
      ["A", "B", "C", "D"].forEach((column) => {
        const cell = sheet.getCell(`${column}${rowNumber}`);
        cell.fill = solid("FFE0E7FF");
        boxed(cell);
      });
      sheet.getRow(rowNumber).height = 22;
      rowNumber += 1;
    });
    sheet.views = [{ state: "frozen", ySplit: headerRow }];
    sheet.pageSetup = {
      paperSize: 14,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 },
      printTitlesRow: `${headerRow}:${headerRow}`,
    };
    const part = (value) => String(value || "").trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: `PhilIRI_Form_${form}_${part(profile.grade)}_${part(profile.section)}_${period}_${assessmentType}.xlsx`.replace(/_+\./, "."),
    };
  }

  function validateMathAssessmentPeriod(value) {
    if (!MATH_ASSESSMENT_PERIODS.includes(value)) {
      throw new HttpError(400, "Choose BOSY, MOSY, or EOSY for the math assessment period.");
    }
    return value;
  }

  function mathAssessmentScore(rawScore, totalItems) {
    if (rawScore === "" || totalItems === "") {
      return {
        percentageScore: "",
        masteryLevel: "Data Not Yet Available",
        interpretation: "Data Not Yet Available",
      };
    }
    const percentageScore = Math.round((rawScore / totalItems) * 10000) / 100;
    const band = MATH_MASTERY_BANDS.find((entry) => percentageScore >= entry.minimum);
    return {
      percentageScore,
      masteryLevel: band.level,
      interpretation: band.interpretation,
    };
  }

  function mathTemplateAssessmentScore(itemScores, gradeLevel, assessedDate) {
    const grade = MATH_ASSESSMENT_GRADES.find((entry) => entry.gradeLevel === gradeLevel);
    if (!grade || !assessedDate) {
      return {
        rawScore: "",
        totalItems: grade ? grade.maximumScore : "",
        percentageScore: "",
        masteryLevel: "Data Not Yet Available",
        interpretation: "Data Not Yet Available",
        gradeLevelScores: [],
        domainScores: [],
        cognitiveDomainScores: [],
      };
    }
    const gradeIndex = MATH_ASSESSMENT_GRADES.indexOf(grade);
    const eligibleItems = MATH_ASSESSMENT_ITEMS.filter((item) =>
      MATH_ASSESSMENT_GRADES.findIndex((entry) => entry.gradeLevel === item.gradeLevel) <= gradeIndex,
    );
    const scoreFor = (key) => Number(itemScores[key] || 0);
    const rawScore = eligibleItems.reduce((total, item) => total + scoreFor(item.key), 0);
    const percentageScore = Math.round((rawScore / grade.maximumScore) * 10000) / 100;
    const masteryIndex = grade.levelCutoffs.findIndex((cutoff) => rawScore >= cutoff);
    const masteryBand = MATH_ASSESSMENT_LEVELS[masteryIndex < 0 ? 4 : masteryIndex];
    const scoreDomains = (category) => MATH_ASSESSMENT_DOMAINS
      .filter((domain) => domain.category === category)
      .map((domain) => {
        const itemKeys = mathAssessmentDomainItems(domain, gradeLevel);
        const maximum = itemKeys.reduce((total, key) =>
          total + MATH_ASSESSMENT_ITEMS.find((item) => item.key === key).maximum, 0);
        const score = itemKeys.reduce((total, key) => total + scoreFor(key), 0);
        return {
          key: domain.key,
          label: domain.label,
          score,
          maximum,
          percentageScore: Math.round((score / maximum) * 10000) / 100,
          meetsBenchmark: score / maximum >= 0.75,
        };
      });
    const gradeLevelScores = MATH_ASSESSMENT_GRADES.map((componentGrade) => {
      const items = MATH_ASSESSMENT_ITEMS.filter((item) => item.gradeLevel === componentGrade.gradeLevel);
      return {
        gradeLevel: componentGrade.gradeLevel,
        score: items.reduce((total, item) => total + scoreFor(item.key), 0),
        maximum: items.reduce((total, item) => total + item.maximum, 0),
      };
    });
    return {
      rawScore,
      totalItems: grade.maximumScore,
      percentageScore,
      masteryLevel: masteryBand.level,
      interpretation: masteryBand.interpretation,
      gradeLevelScores,
      domainScores: scoreDomains("Content Domain"),
      cognitiveDomainScores: scoreDomains("Cognitive Domain"),
    };
  }

  function mathAssessmentTemplate() {
    return {
      grades: MATH_ASSESSMENT_GRADES.map((grade) => ({
        gradeLevel: grade.gradeLevel,
        maximumScore: grade.maximumScore,
        masteryBands: MATH_ASSESSMENT_LEVELS.map((band, index) => ({
          level: band.level,
          minimumRawScore: index < grade.levelCutoffs.length ? grade.levelCutoffs[index] : 0,
          interpretation: band.interpretation,
        })),
      })),
      items: MATH_ASSESSMENT_ITEMS,
      domains: MATH_ASSESSMENT_DOMAINS.map((domain) => ({
        key: domain.key,
        label: domain.label,
        category: domain.category,
        itemKeys: Object.fromEntries(MATH_ASSESSMENT_GRADES.map((grade) => [
          grade.gradeLevel,
          mathAssessmentDomainItems(domain, grade.gradeLevel),
        ])),
      })),
      benchmarkPercentage: 75,
    };
  }

  async function getMathAssessmentSummary(session) {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = getOwnedStudents(studentSheet, studentColumns, session).map((student) => ({
        id: student.id,
        name: student.name,
        lrn: student.lrn,
        gender: student.gender,
        birthdate: student.birthdate,
        assessments: Object.fromEntries(MATH_ASSESSMENT_PERIODS.map((period) => [period, {
          gradeLevel: "",
          rawScore: "",
          totalItems: "",
          assessedDate: "",
          itemScores: {},
          scoringMethod: "",
          strengths: "",
          areasForImprovement: "",
          recommendedIntervention: "",
          remarks: "",
          percentageScore: "",
          masteryLevel: "Data Not Yet Available",
          interpretation: "Data Not Yet Available",
          gradeLevelScores: [],
          domainScores: [],
          cognitiveDomainScores: [],
        }])),
      }));
      const studentsById = new Map(students.map((student) => [student.id, student]));
      const sheet = workbook.getWorksheet("Math Assessments");
      if (sheet) {
        const { columns } = getMathAssessmentSheet(workbook);
        for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
          const row = sheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) !== session.classId
            || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
          ) continue;
          const student = studentsById.get(cellText(row.getCell(columns.studentId).value));
          const period = cellText(row.getCell(columns.period).value);
          if (!student || !MATH_ASSESSMENT_PERIODS.includes(period)) continue;
          const rawValue = row.getCell(columns.rawScore).value;
          const totalValue = row.getCell(columns.totalItems).value;
          const rawScore = rawValue === null || rawValue === undefined || rawValue === "" ? "" : Number(rawValue);
          const totalItems = totalValue === null || totalValue === undefined || totalValue === "" ? "" : Number(totalValue);
          const assessed = row.getCell(columns.assessed).value;
          const assessedDate = assessed instanceof Date
            ? assessed.toISOString().slice(0, 10)
            : cellText(assessed);
          const gradeLevel = cellText(row.getCell(columns.gradeLevel).value);
          const itemResponsesValue = cellText(row.getCell(columns.itemResponses).value);
          const itemScores = itemResponsesValue ? JSON.parse(itemResponsesValue) : {};
          if (!itemScores || typeof itemScores !== "object" || Array.isArray(itemScores)) {
            throw new Error(`RMA item responses in workbook row ${rowNumber} are invalid.`);
          }
          const isTemplateAssessment = Boolean(itemResponsesValue);
          const score = isTemplateAssessment
            ? mathTemplateAssessmentScore(itemScores, gradeLevel, assessedDate)
            : mathAssessmentScore(rawScore, totalItems);
          const narrative = isTemplateAssessment
            ? mathTemplateAssessmentNarrative(score)
            : {
              strengths: cellText(row.getCell(columns.strengths).value),
              areasForImprovement: cellText(row.getCell(columns.areas).value),
              recommendedIntervention: cellText(row.getCell(columns.intervention).value),
              remarks: cellText(row.getCell(columns.remarks).value),
            };
          student.assessments[period] = {
            gradeLevel,
            rawScore,
            totalItems,
            assessedDate,
            itemScores,
            scoringMethod: isTemplateAssessment ? "template" : rawScore !== "" || totalItems !== "" ? "legacy" : "",
            ...narrative,
            ...score,
          };
        }
      }
      return {
        periods: MATH_ASSESSMENT_PERIODS,
        template: mathAssessmentTemplate(),
        masteryBands: MATH_MASTERY_BANDS.map(({ level, minimum, interpretation }) => ({
          level,
          minimum,
          interpretation,
        })),
        students,
      };
    });
  }

  async function saveMathAssessment(session, data) {
    const period = validateMathAssessmentPeriod(data.period);
    const studentId = typeof data.studentId === "string" ? data.studentId.trim() : "";
    if (!studentId || studentId.length > 40) {
      throw new HttpError(400, "Choose a student from your class roster.");
    }
    const templateAssessment = data.itemScores !== undefined;
    let gradeLevel = "";
    let itemScores = {};
    let assessmentDate = null;
    let templateScore = null;
    if (templateAssessment) {
      gradeLevel = typeof data.gradeLevel === "string" ? data.gradeLevel.trim() : "";
      if (!MATH_ASSESSMENT_GRADES.some((grade) => grade.gradeLevel === gradeLevel)) {
        throw new HttpError(400, "Choose Grade 4, Grade 5, or Grade 6 for this RMA assessment.");
      }
      const dateValue = data.assessedDate === "" || data.assessedDate === undefined ? "" : data.assessedDate;
      if (typeof dateValue !== "string" || (dateValue && !/^\d{4}-\d{2}-\d{2}$/.test(dateValue))) {
        throw new HttpError(400, "Enter a valid RMA assessment date.");
      }
      if (dateValue) {
        assessmentDate = new Date(`${dateValue}T00:00:00.000Z`);
        if (Number.isNaN(assessmentDate.getTime()) || assessmentDate.toISOString().slice(0, 10) !== dateValue) {
          throw new HttpError(400, "Enter a valid RMA assessment date.");
        }
      }
      if (!data.itemScores || typeof data.itemScores !== "object" || Array.isArray(data.itemScores)) {
        throw new HttpError(400, "Enter valid item-level RMA scores.");
      }
      const gradeIndex = MATH_ASSESSMENT_GRADES.findIndex((grade) => grade.gradeLevel === gradeLevel);
      const eligibleItems = MATH_ASSESSMENT_ITEMS.filter((item) =>
        MATH_ASSESSMENT_GRADES.findIndex((grade) => grade.gradeLevel === item.gradeLevel) <= gradeIndex,
      );
      const eligibleItemKeys = new Set(eligibleItems.map((item) => item.key));
      for (const [key, value] of Object.entries(data.itemScores)) {
        if (!eligibleItemKeys.has(key)) {
          if (value === "" || value === null || value === undefined) continue;
          throw new HttpError(400, `${key} is not part of the ${gradeLevel} assessment.`);
        }
        if (value !== "" && (!Number.isSafeInteger(value) || value < 0
          || value > eligibleItems.find((item) => item.key === key).maximum)) {
          throw new HttpError(400, `Enter a whole-number score within the maximum for item ${key}.`);
        }
        if (value !== "") itemScores[key] = value;
      }
      if (!assessmentDate && Object.keys(itemScores).length) {
        throw new HttpError(400, "Enter the assessment date before saving item scores.");
      }
      templateScore = mathTemplateAssessmentScore(itemScores, gradeLevel, dateValue);
    }
    const rawScoreValue = data.rawScore === "" || data.rawScore === undefined ? "" : data.rawScore;
    const totalItemsValue = data.totalItems === "" || data.totalItems === undefined ? "" : data.totalItems;
    if (!templateAssessment && (rawScoreValue === "") !== (totalItemsValue === "")) {
      throw new HttpError(400, "Enter both the raw score and total number of items, or leave both blank.");
    }
    if (!templateAssessment && rawScoreValue !== "" && (
      !Number.isSafeInteger(rawScoreValue)
      || !Number.isSafeInteger(totalItemsValue)
      || rawScoreValue < 0
      || totalItemsValue < 1
      || rawScoreValue > totalItemsValue
    )) {
      throw new HttpError(400, "Enter a whole-number raw score from zero through the total number of items.");
    }
    const fields = {};
    for (const [key, label] of [
      ["strengths", "Identified strengths"],
      ["areasForImprovement", "Areas for improvement"],
      ["recommendedIntervention", "Recommended intervention"],
      ["remarks", "Remarks"],
    ]) {
      const value = data[key] === undefined ? "" : data[key];
      if (typeof value !== "string" || value.length > 1000) {
        throw new HttpError(400, `${label} must be text of 1,000 characters or fewer.`);
      }
      fields[key] = value.trim();
    }
    const narrative = templateAssessment
      ? mathTemplateAssessmentNarrative(templateScore)
      : fields;

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      findOwnedStudent(studentSheet, studentColumns, session, studentId);
      const { sheet, columns } = getMathAssessmentSheet(workbook);
      const existingRows = [];
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(columns.studentId).value) === studentId
          && cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(columns.period).value) === period
        ) existingRows.push(row);
      }
      const hasAssessment = templateAssessment
        ? Boolean(assessmentDate || Object.keys(itemScores).length || Object.values(fields).some(Boolean))
        : rawScoreValue !== "" || Object.values(fields).some(Boolean);
      if (!hasAssessment) {
        existingRows.sort((left, right) => right.number - left.number)
          .forEach((row) => sheet.spliceRows(row.number, 1));
        await saveDatabaseWorkbook(workbook);
        return { saved: true, removed: existingRows.length > 0, period, assessedDate: "" };
      }
      const existingLegacyScore = existingRows.some((row) =>
        !cellText(row.getCell(columns.itemResponses).value)
        && row.getCell(columns.rawScore).value !== ""
        && row.getCell(columns.rawScore).value !== null
        && row.getCell(columns.rawScore).value !== undefined,
      );
      if (templateAssessment && existingLegacyScore && !Object.keys(itemScores).length) {
        throw new HttpError(400, "Enter at least one item score (zero is valid) before replacing this previously saved overall score.");
      }

      const savedAt = new Date();
      const existing = existingRows.shift();
      const values = {
        [columns.rawScore]: templateAssessment ? templateScore.rawScore : rawScoreValue,
        [columns.totalItems]: templateAssessment ? templateScore.totalItems : totalItemsValue,
        [columns.assessed]: templateAssessment ? assessmentDate : savedAt,
        [columns.strengths]: narrative.strengths,
        [columns.areas]: narrative.areasForImprovement,
        [columns.intervention]: narrative.recommendedIntervention,
        [columns.updated]: savedAt,
        [columns.gradeLevel]: templateAssessment ? gradeLevel : "",
        [columns.itemResponses]: templateAssessment ? JSON.stringify(itemScores) : "",
        [columns.remarks]: narrative.remarks,
      };
      if (existing) {
        Object.entries(values).forEach(([column, value]) => {
          existing.getCell(Number(column)).value = value;
        });
      } else {
        writeRow(sheet, [columns.id], {
          [columns.id]: nextMathAssessmentId(sheet, columns.id),
          [columns.studentId]: studentId,
          [columns.classId]: session.classId,
          [columns.teacherUserId]: session.userId,
          [columns.period]: period,
          ...values,
        });
      }
      existingRows.sort((left, right) => right.number - left.number)
        .forEach((row) => sheet.spliceRows(row.number, 1));
      await saveDatabaseWorkbook(workbook);
      return {
        saved: true,
        removed: false,
        period,
        assessedDate: templateAssessment
          ? assessmentDate ? assessmentDate.toISOString().slice(0, 10) : ""
          : savedAt.toISOString().slice(0, 10),
        ...(templateAssessment ? templateScore : mathAssessmentScore(rawScoreValue, totalItemsValue)),
        ...(templateAssessment ? narrative : {}),
      };
    });
  }

  async function exportMathAssessment(session, period, format, sectionFilter) {
    validateMathAssessmentPeriod(period);
    if (!["xlsx", "csv"].includes(format)) {
      throw new HttpError(400, "Choose XLSX or CSV for the RMA export.");
    }
    const data = await getMathAssessmentSummary(session);
    const profile = await getTeacherProfile(session);
    if (sectionFilter && sectionFilter !== "__all__") {
      const roster = await listStudents(session);
      const selectedIds = new Set(roster.students
        .filter((student) => matchesStudentSection(student, sectionFilter))
        .map((student) => student.id));
      data.students = data.students.filter((student) => selectedIds.has(student.id));
      profile.section = sectionFilter === "__unassigned__" ? "" : sectionFilter;
      const sectionGrade = Object.entries(roster.sectionGrades).find(([section]) =>
        section.toLocaleLowerCase() === profile.section.toLocaleLowerCase());
      if (sectionGrade) profile.grade = sectionGrade[1];
    }
    const assessmentItemColumns = data.template.items.map((item) => `Item ${item.label}`);
    const scoreSheetHeaders = [
      "S/N", "LRN", "Name of Learner", "Sex", "Birthdate", "Date of Assessment", "Age",
      ...assessmentItemColumns,
      "Grade 4 Score", "Grade 5 Score", "Grade 6 Score",
      "TOTAL SCORE", "Total Points / Scores", "% of Correct Answer", "Levelling of Learners",
      ...data.template.domains.flatMap((domain) => [domain.label, `${domain.label} ≥75%`]),
      "Remarks", "Identified Strengths", "Areas for Improvement", "Recommended Intervention",
    ];
    const assessedStudents = data.students.filter((student) => student.assessments[period].assessedDate);
    const scoreSheetRows = assessedStudents.map((student, index) => {
      const assessment = student.assessments[period];
      const templateScore = assessment.scoringMethod === "template";
      const gradeIndex = data.template.grades.findIndex((grade) => grade.gradeLevel === assessment.gradeLevel);
      const gradeScores = new Map((assessment.gradeLevelScores || []).map((component) => [
        component.gradeLevel,
        component.score,
      ]));
      const domains = new Map([
        ...(assessment.domainScores || []),
        ...(assessment.cognitiveDomainScores || []),
      ].map((domain) => [domain.key, domain]));
      const birthdate = student.birthdate || "";
      const age = birthdate
        ? Math.round((Date.parse(`${assessment.assessedDate}T00:00:00.000Z`)
          - Date.parse(`${birthdate}T00:00:00.000Z`)) / 86400000 / 365)
        : "";
      return [
        index + 1,
        student.lrn,
        student.name,
        student.gender,
        birthdate,
        assessment.assessedDate,
        age,
        ...data.template.items.map((item) => templateScore && assessment.itemScores[item.key] !== undefined
          ? assessment.itemScores[item.key]
          : templateScore && data.template.grades.findIndex((grade) => grade.gradeLevel === item.gradeLevel) <= gradeIndex
            ? 0
            : ""),
        ...["Grade 4", "Grade 5", "Grade 6"].map((gradeLevel) => gradeScores.get(gradeLevel) ?? ""),
        assessment.rawScore,
        assessment.totalItems,
        assessment.percentageScore,
        assessment.masteryLevel,
        ...data.template.domains.flatMap((domain) => {
          const result = domains.get(domain.key);
          return [
            result ? `${result.score}/${result.maximum}` : "",
            result ? result.meetsBenchmark ? "Yes" : "No" : "",
          ];
        }),
        assessment.remarks,
        assessment.strengths,
        assessment.areasForImprovement,
        assessment.recommendedIntervention,
      ];
    });
    if (format === "csv") {
      const escapeCSV = (value) => `"${String(value === "" || value === null || value === undefined ? "" : value).replace(/"/g, '""')}"`;
      const csv = [scoreSheetHeaders, ...scoreSheetRows].map((row) => row.map(escapeCSV).join(",")).join("\r\n");
      return {
        buffer: Buffer.from(`\uFEFF${csv}`, "utf8"),
        contentType: "text/csv; charset=utf-8",
        filename: `RMA_${period}_results.csv`,
      };
    }

    const templateAssessedStudents = assessedStudents.filter((student) =>
      student.assessments[period].scoringMethod === "template");
    if (templateAssessedStudents.length && (
      !data.template.grades.some((grade) => grade.gradeLevel === profile.grade)
      || templateAssessedStudents.some((student) => student.assessments[period].gradeLevel !== profile.grade)
    )) {
      throw new HttpError(400,
        "The RMA template has one Grade field. Match the Teacher Profile grade with all assessed learners before exporting.");
    }
    if (data.students.length > 99) {
      throw new HttpError(400, "The RMA template supports up to 99 learners per class.");
    }
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(__dirname, "RMA TEMP.xlsx"));
    const scoreSheet = workbook.getWorksheet("RMAKS2 Scoresheet");
    if (!scoreSheet) {
      throw new Error("The RMA template is missing a required worksheet.");
    }
    scoreSheet.getCell("C4").value = period === "BOSY" ? "BoSY" : period === "EOSY" ? "EoSY" : "MoSY";
    scoreSheet.getCell("C6").value = profile.schoolId || "";
    scoreSheet.getCell("F6").value = profile.schoolName || "";
    scoreSheet.getCell("M6").value = profile.name;
    scoreSheet.getCell("C7").value = profile.grade || "";
    scoreSheet.getCell("F7").value = profile.section || "";
    scoreSheet.getCell("X6").value = data.students.filter((student) => student.gender === "Male").length;
    scoreSheet.getCell("AE6").value = data.students.filter((student) => student.gender === "Female").length;
    scoreSheet.getCell("AJ6").value = data.students.length;
    const dateValue = (value) => {
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
      const date = new Date(`${value}T00:00:00.000Z`);
      return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? "" : date;
    };

    data.students.forEach((student, index) => {
      const rowNumber = index + 10;
      const row = scoreSheet.getRow(rowNumber);
      const assessment = student.assessments[period];
      const isTemplateScored = assessment.scoringMethod === "template" && Boolean(assessment.assessedDate);
      const gradeIndex = data.template.grades.findIndex((grade) => grade.gradeLevel === assessment.gradeLevel);
      row.getCell(1).value = index + 1;
      row.getCell(2).value = student.lrn || "";
      row.getCell(3).value = student.name;
      row.getCell(4).value = student.gender || "";
      row.getCell(5).value = dateValue(student.birthdate);
      row.getCell(6).value = isTemplateScored ? dateValue(assessment.assessedDate) : "";
      data.template.items.forEach((item, itemIndex) => {
        const itemGradeIndex = data.template.grades.findIndex((grade) => grade.gradeLevel === item.gradeLevel);
        row.getCell(8 + itemIndex).value = isTemplateScored && itemGradeIndex <= gradeIndex
          ? Number(assessment.itemScores[item.key] || 0)
          : "";
      });
    });
    workbook.calcProperties.fullCalcOnLoad = true;
    workbook.calcProperties.forceFullCalc = true;
    workbook.calcProperties.calcMode = "auto";
    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "RMA TEMP.xlsx",
    };
  }

  function validateAttendanceDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new HttpError(400, "Choose a valid attendance date.");
    }
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new HttpError(400, "Choose a valid attendance date.");
    }
    return value;
  }

  function validateAttendanceMonth(value) {
    if (typeof value !== "string" || !/^(?:19|[2-9]\d)\d{2}-(0[1-9]|1[0-2])$/.test(value)) {
      throw new HttpError(400, "Choose a valid attendance month.");
    }
    return value;
  }

  function attendanceDates(month) {
    const [year, monthNumber] = month.split("-").map(Number);
    const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return Array.from({ length: dayCount }, (_, index) =>
      `${month}-${String(index + 1).padStart(2, "0")}`);
  }

  function attendanceSchoolDays(month) {
    return attendanceDates(month).filter((date) => {
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      return weekday !== 0 && weekday !== 6;
    });
  }

  function attendanceDateText(value) {
    return value instanceof Date ? value.toISOString().slice(0, 10) : cellText(value);
  }

  function sf2WorksheetName(month) {
    const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const [year, monthNumber] = month.split("-").map(Number);
    return `${monthNames[monthNumber - 1]} ${year}`;
  }

  function sf2DisplayedMonth(month) {
    const monthNames = [
      "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
      "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
    ];
    const monthNumber = Number(month.slice(5, 7));
    return monthNames[monthNumber - 1];
  }

  function normalizeSF2LearnerName(value) {
    return cellText(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  async function parseSF2Upload(buffer, month) {
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer);
    } catch {
      throw new HttpError(400, "The selected file is not a readable SF2 .xlsx workbook.");
    }
    const sheetName = sf2WorksheetName(month);
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      throw new HttpError(400, `The uploaded SF2 workbook must contain a "${sheetName}" worksheet for the selected month.`);
    }
    if (
      !normalizeHeader(cellText(sheet.getCell(9, 2).value)).startsWith("learnersname")
      || !normalizeHeader(cellText(sheet.getCell(9, SF2_FIRST_DAY_COLUMN).value)).startsWith("1strowfordate")
      || !normalizeHeader(cellText(sheet.getCell(9, 32).value)).includes("totalforthemonth")
      || !normalizeHeader(cellText(sheet.getCell(9, 33).value)).includes("totalforthemonth")
      || !normalizeHeader(cellText(sheet.getCell(9, SF2_REMARKS_COLUMN).value)).startsWith("remarks")
      || !normalizeHeader(cellText(sheet.getCell(63, 2).value)).includes("male")
      || !normalizeHeader(cellText(sheet.getCell(63, 2).value)).includes("total")
      || !normalizeHeader(cellText(sheet.getCell(114, 2).value)).includes("female")
      || !normalizeHeader(cellText(sheet.getCell(114, 2).value)).includes("total")
    ) {
      throw new HttpError(400, "The selected worksheet does not match the SF2 template layout.");
    }

    const schoolDays = attendanceSchoolDays(month);
    const datesByColumn = new Map();
    for (let column = SF2_FIRST_DAY_COLUMN; column <= SF2_LAST_DAY_COLUMN; column += 1) {
      const rawDay = sheet.getCell(10, column).value;
      const schoolDayIndex = column - SF2_FIRST_DAY_COLUMN;
      if (schoolDayIndex >= schoolDays.length) {
        if (rawDay !== null && rawDay !== undefined && cellText(rawDay).trim() !== "") {
          throw new HttpError(400, `The date heading in column ${column} does not match ${sheetName}.`);
        }
        continue;
      }
      const expectedDate = schoolDays[schoolDayIndex];
      const expectedDay = Number(expectedDate.slice(-2));
      const weekday = new Date(`${expectedDate}T00:00:00.000Z`).getUTCDay();
      if (
        Number(rawDay) !== expectedDay
        || cellText(sheet.getCell(11, column).value).trim().toUpperCase() !== SF2_WEEKDAY_NAMES[(weekday + 6) % 7]
      ) {
        throw new HttpError(400, `The date or weekday heading in column ${column} does not match ${sheetName}.`);
      }
      datesByColumn.set(column, expectedDate);
    }

    const records = [];
    const namesSeen = new Set();
    for (const rowNumber of SF2_STUDENT_ROWS) {
      const row = sheet.getRow(rowNumber);
      const name = cellText(row.getCell(2).value).trim();
      if (!name) {
        if (cellText(row.getCell(SF2_REMARKS_COLUMN).value).trim()) {
          throw new HttpError(400, `Remarks in row ${rowNumber} have no learner name.`);
        }
        for (let column = SF2_FIRST_DAY_COLUMN; column <= SF2_LAST_DAY_COLUMN; column += 1) {
          if (cellText(row.getCell(column).value).trim()) {
            throw new HttpError(400, `Attendance marks in row ${rowNumber} have no learner name.`);
          }
        }
        continue;
      }
      const normalizedName = normalizeSF2LearnerName(name);
      if (!normalizedName || namesSeen.has(normalizedName)) {
        throw new HttpError(400, `The learner name in row ${rowNumber} is blank or duplicated.`);
      }
      namesSeen.add(normalizedName);
      const attendance = [];
      for (let column = SF2_FIRST_DAY_COLUMN; column <= SF2_LAST_DAY_COLUMN; column += 1) {
        const rawMark = cellText(row.getCell(column).value).trim().toLowerCase();
        if (!datesByColumn.has(column)) {
          if (rawMark) {
            throw new HttpError(400, `Attendance marks in row ${rowNumber}, column ${column} have no date heading.`);
          }
          continue;
        }
        const status = SF2_STATUS_BY_MARK.get(rawMark);
        if (status === undefined) {
          throw new HttpError(
            400,
            `Unsupported SF2 mark "${rawMark}" in row ${rowNumber}, column ${column}. Use blank, -, CC, T, E, NC, or N/A for a locked learner.`,
          );
        }
        attendance.push({
          date: datesByColumn.get(column),
          status,
        });
      }
      const rawRemarks = cellText(row.getCell(SF2_REMARKS_COLUMN).value).trim();
      if (rawRemarks.length > 15000) {
        throw new HttpError(400, `Remarks in row ${rowNumber} exceed the 15,000-character limit.`);
      }
      const statusDateMatches = [...rawRemarks.matchAll(/\n\[Grade Portal status date: (\d{4}-\d{2}-\d{2})\]/g)];
      if (statusDateMatches.length > 1) {
        throw new HttpError(400, `The learner status date in row ${rowNumber} is duplicated.`);
      }
      const statusDate = statusDateMatches[0]?.[1] || "";
      const remarksWithoutStatusDate = rawRemarks.replace(/\n\[Grade Portal status date: \d{4}-\d{2}-\d{2}\]/g, "");
      const markerIndex = remarksWithoutStatusDate.lastIndexOf(SF2_ABSENCE_REASONS_MARKER);
      const absenceReasons = new Map();
      if (markerIndex >= 0) {
        const reasonLines = remarksWithoutStatusDate
          .slice(markerIndex + SF2_ABSENCE_REASONS_MARKER.length)
          .split(/\r?\n/).filter(Boolean);
        for (const line of reasonLines) {
          const match = /^(\d{4}-\d{2}-\d{2}): (.+)$/.exec(line);
          if (!match || match[2].length > 500 || absenceReasons.has(match[1])) {
            throw new HttpError(400, `Absence reasons in row ${rowNumber} are invalid or duplicated.`);
          }
          absenceReasons.set(match[1], match[2].trim());
        }
      }
      const remarks = (markerIndex < 0
        ? remarksWithoutStatusDate
        : remarksWithoutStatusDate.slice(0, markerIndex)).trim();
      const fallbackAbsenceReason = normalizeMonthlyAttendanceRemark(remarks) ? "" : remarks;
      for (const entry of attendance) {
        if (entry.status !== "Absent" && entry.status !== "Excused") continue;
        entry.reason = absenceReasons.get(entry.date) || fallbackAbsenceReason;
      }
      if ([...absenceReasons.keys()].some((date) =>
        !attendance.some((entry) => entry.date === date && (entry.status === "Absent" || entry.status === "Excused")))) {
        throw new HttpError(400, `Reasons in row ${rowNumber} do not match an Absent or Excused mark.`);
      }
      records.push({
        name,
        normalizedName,
        gender: rowNumber <= SF2_LAST_MALE_STUDENT_ROW ? "Male" : "Female",
        attendance,
        remarks,
        statusDate,
        rowNumber,
      });
    }
    if (!records.length) {
      throw new HttpError(400, "No learner names were found in the selected SF2 worksheet.");
    }
    return records;
  }

  function normalizeAttendanceStatus(value) {
    const status = cellText(value);
    if (status === "-") return "Present";
    if (status === "Late") return "Tardy";
    return status === "Half-day" ? "Absent" : status;
  }

  function normalizeMonthlyAttendanceRemark(value) {
    const remark = cellText(value).trim().toLowerCase().replace(/\s+/g, " ");
    if (remark === "nls" || remark === "nls - no longer in school") return "NLS";
    if (remark === "transferred out" || remark === "transfered out") return "Transferred Out";
    if (remark === "transferred in" || remark === "transfered in") return "Transferred In";
    return "";
  }

  function isMonthlyAttendanceRemark(value) {
    return Boolean(normalizeMonthlyAttendanceRemark(value));
  }

  function attendanceMonthEnd(month) {
    const [year, monthNumber] = month.split("-").map(Number);
    return `${month}-${String(new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()).padStart(2, "0")}`;
  }

  function monthlyAttendanceStatusEvents(workbook, session, studentIds) {
    const eventsByStudent = new Map([...studentIds].map((studentId) => [studentId, []]));
    const notes = workbook.getWorksheet("Attendance Monthly Notes");
    if (!notes) return eventsByStudent;
    const { columns } = getAttendanceNotesSheet(workbook);
    for (let rowNumber = 2; rowNumber <= notes.rowCount; rowNumber += 1) {
      const row = notes.getRow(rowNumber);
      const studentId = cellText(row.getCell(columns.studentId).value);
      if (
        !eventsByStudent.has(studentId)
        || cellText(row.getCell(columns.classId).value) !== session.classId
        || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
      ) continue;
      const status = normalizeMonthlyAttendanceRemark(row.getCell(columns.remarks).value);
      const eventMonth = cellText(row.getCell(columns.month).value);
      if (!status || !/^\d{4}-(0[1-9]|1[0-2])$/.test(eventMonth)) continue;
      const storedDate = attendanceDateText(row.getCell(columns.statusDate).value);
      const statusDate = storedDate || attendanceMonthEnd(eventMonth);
      const parsedDate = new Date(`${statusDate}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(statusDate)
        || Number.isNaN(parsedDate.getTime())
        || parsedDate.toISOString().slice(0, 10) !== statusDate) continue;
      eventsByStudent.get(studentId).push({ status, date: statusDate });
    }
    for (const events of eventsByStudent.values()) {
      events.sort((left, right) => left.date.localeCompare(right.date));
    }
    return eventsByStudent;
  }

  function attendanceStatusEffectiveDate(event) {
    if (event.status === "Transferred In") return event.date;
    const [year, month] = event.date.slice(0, 7).split("-").map(Number);
    const nextMonth = new Date(Date.UTC(year, month, 1));
    return nextMonth.toISOString().slice(0, 10);
  }

  function isAttendanceDateLocked(events, date) {
    let active = true;
    if (events[0]?.status === "Transferred In" && events[0].date > date) active = false;
    for (const event of events) {
      if (attendanceStatusEffectiveDate(event) > date) break;
      active = event.status === "Transferred In";
    }
    return !active;
  }

  function latestMonthlyStatus(events, month) {
    const monthEnd = attendanceMonthEnd(month);
    return events.filter((event) => event.date <= monthEnd).slice(-1)[0] || null;
  }

  async function getAttendanceMonth(session, monthValue) {
    const month = validateAttendanceMonth(monthValue);
    const dates = attendanceSchoolDays(month);
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = getOwnedStudents(studentSheet, studentColumns, session).map((student) => ({
        id: student.id,
        name: student.name,
        gender: student.gender,
        attendance: Array(dates.length).fill(""),
        reasons: Array(dates.length).fill(""),
        remarks: "",
        statusDate: "",
        statusInherited: false,
        attendanceLocked: false,
        lockedDates: [],
        statusBaselineLockedDates: [],
      }));
      const noClassDates = new Set();
      const noClassReasons = {};
      const calendar = getAttendanceCalendarSheet(workbook);
      for (let rowNumber = 2; rowNumber <= calendar.sheet.rowCount; rowNumber += 1) {
        const row = calendar.sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(calendar.columns.classId).value) === session.classId
          && cellText(row.getCell(calendar.columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(calendar.columns.dayType).value) === "Holiday/No Class"
        ) {
          const date = attendanceDateText(row.getCell(calendar.columns.date).value);
          if (dates.includes(date)) {
            noClassDates.add(date);
            noClassReasons[date] = cellText(row.getCell(calendar.columns.reason).value);
          }
        }
      }
      const studentsById = new Map(students.map((student) => [student.id, student]));
      const sheet = workbook.getWorksheet("Attendance Records");
      if (sheet) {
        const { columns } = getAttendanceSheet(workbook);
        for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
          const row = sheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) !== session.classId
            || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
          ) continue;
          const student = studentsById.get(cellText(row.getCell(columns.studentId).value));
          const date = attendanceDateText(row.getCell(columns.date).value);
          if (!student || !date.startsWith(`${month}-`)) continue;
          const dayIndex = dates.indexOf(date);
          if (dayIndex >= 0) {
            student.attendance[dayIndex] = normalizeAttendanceStatus(row.getCell(columns.status).value);
            student.reasons[dayIndex] = cellText(row.getCell(columns.reason).value);
          }
        }
      }
      const notesSheet = workbook.getWorksheet("Attendance Monthly Notes");
      if (notesSheet) {
        const { columns } = getAttendanceNotesSheet(workbook);
        const statusEvents = monthlyAttendanceStatusEvents(workbook, session, studentsById.keys());
        for (let rowNumber = 2; rowNumber <= notesSheet.rowCount; rowNumber += 1) {
          const row = notesSheet.getRow(rowNumber);
          if (
            studentsById.has(cellText(row.getCell(columns.studentId).value))
            && cellText(row.getCell(columns.classId).value) === session.classId
            && cellText(row.getCell(columns.teacherUserId).value) === session.userId
            && cellText(row.getCell(columns.month).value) === month
          ) {
            const student = studentsById.get(cellText(row.getCell(columns.studentId).value));
            const remark = cellText(row.getCell(columns.remarks).value);
            if (!normalizeMonthlyAttendanceRemark(remark)) student.remarks = remark;
          }
        }
        for (const student of students) {
          const event = latestMonthlyStatus(statusEvents.get(student.id) || [], month);
          if (event && (event.status !== "Transferred In" || event.date.startsWith(`${month}-`))) {
            student.remarks = event.status;
            student.statusDate = event.date;
            student.statusInherited = !event.date.startsWith(`${month}-`);
          }
          const events = statusEvents.get(student.id) || [];
          student.lockedDates = dates.filter((date) => isAttendanceDateLocked(events, date));
          student.attendanceLocked = student.lockedDates.length === dates.length;
          const baselineEvents = events.filter((statusEvent) => !statusEvent.date.startsWith(`${month}-`));
          student.statusBaselineLockedDates = dates.filter((date) => isAttendanceDateLocked(baselineEvents, date));
          dates.forEach((date, index) => {
            if (student.lockedDates.includes(date)) {
              student.attendance[index] = "";
              student.reasons[index] = "";
            }
          });
        }
      }
      return { month, dates, statuses: ATTENDANCE_STATUSES, noClassDates: [...noClassDates], noClassReasons, students };
    });
  }

  async function getAttendanceSummary(session) {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = getOwnedStudents(studentSheet, studentColumns, session).map((student) => ({
        id: student.id,
        name: student.name,
        gender: student.gender,
        present: 0,
        absent: 0,
        months: {},
      }));
      const studentsById = new Map(students.map((student) => [student.id, student]));
      const statusEvents = monthlyAttendanceStatusEvents(workbook, session, studentsById.keys());
      const noClassDates = new Set();
      const calendar = getAttendanceCalendarSheet(workbook);
      for (let rowNumber = 2; rowNumber <= calendar.sheet.rowCount; rowNumber += 1) {
        const row = calendar.sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(calendar.columns.classId).value) === session.classId
          && cellText(row.getCell(calendar.columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(calendar.columns.dayType).value) === "Holiday/No Class"
        ) {
          noClassDates.add(attendanceDateText(row.getCell(calendar.columns.date).value));
        }
      }
      const recordsByLearnerDate = new Map();
      const sheet = workbook.getWorksheet("Attendance Records");
      if (sheet) {
        const { columns } = getAttendanceSheet(workbook);
        for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
          const row = sheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) !== session.classId
            || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
          ) continue;
          const studentId = cellText(row.getCell(columns.studentId).value);
          const date = attendanceDateText(row.getCell(columns.date).value);
          if (!studentsById.has(studentId) || !date) continue;
          recordsByLearnerDate.set(`${studentId}\u0000${date}`, {
            studentId,
            date,
            status: normalizeAttendanceStatus(row.getCell(columns.status).value),
          });
        }
      }
      let firstDate = "";
      let lastDate = "";
      const months = new Set();
      for (const record of recordsByLearnerDate.values()) {
        const month = record.date.slice(0, 7);
        months.add(month);
        const student = studentsById.get(record.studentId);
        const monthSummary = student.months[month] || { present: 0, absent: 0 };
        if (noClassDates.has(record.date)
          || isAttendanceDateLocked(statusEvents.get(record.studentId) || [], record.date)) {
          student.months[month] = monthSummary;
          continue;
        }
        if (record.status === "Present" || record.status === "Tardy") {
          student.present += 1;
          monthSummary.present += 1;
        } else if (record.status === "Absent") {
          student.absent += 1;
          monthSummary.absent += 1;
        }
        student.months[month] = monthSummary;
        if (record.status === "Present" || record.status === "Tardy" || record.status === "Absent") {
          if (!firstDate || record.date < firstDate) firstDate = record.date;
          if (!lastDate || record.date > lastDate) lastDate = record.date;
        }
      }
      const recordedMonths = [...months].sort();
      for (const student of students) {
        for (const month of recordedMonths) {
          if (!student.months[month]) student.months[month] = { present: 0, absent: 0 };
        }
      }
      return { students, months: recordedMonths, firstDate, lastDate };
    });
  }

  async function saveAttendanceMonth(session, data) {
    const month = validateAttendanceMonth(data.month);
    const dates = attendanceSchoolDays(month);
    if (data.noClassDates !== undefined && !Array.isArray(data.noClassDates)) {
      throw new HttpError(400, "Choose valid dates to mark as Holiday/No Class.");
    }
    const requestedNoClassDates = data.noClassDates === undefined
      ? null
      : new Set(data.noClassDates);
    if (
      requestedNoClassDates
      && (requestedNoClassDates.size !== data.noClassDates.length
        || [...requestedNoClassDates].some((date) => typeof date !== "string" || !dates.includes(date)))
    ) {
      throw new HttpError(400, "Choose valid dates to mark as Holiday/No Class.");
    }
    let requestedNoClassReasons = null;
    if (data.noClassReasons !== undefined) {
      const reasons = data.noClassReasons;
      if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) {
        throw new HttpError(400, "Enter a valid reason for each Holiday/No Class date.");
      }
      requestedNoClassReasons = new Map();
      for (const [date, reason] of Object.entries(reasons)) {
        if (!dates.includes(date) || typeof reason !== "string") {
          throw new HttpError(400, "Enter a valid reason for each Holiday/No Class date.");
        }
        const trimmed = reason.replace(/\s+/g, " ").trim();
        if (trimmed.length > MAX_NO_CLASS_REASON_LENGTH) {
          throw new HttpError(400, `Holiday/No Class reasons must be ${MAX_NO_CLASS_REASON_LENGTH} characters or fewer.`);
        }
        requestedNoClassReasons.set(date, trimmed);
      }
    }
    if (!Array.isArray(data.records)) {
      throw new HttpError(400, "Submit one attendance row for every student in your class.");
    }
    const recordsByStudentId = new Map();
    for (const record of data.records) {
      const studentId = record && typeof record.studentId === "string" ? record.studentId.trim() : "";
      if (!studentId || studentId.length > 40 || recordsByStudentId.has(studentId)
        || !Array.isArray(record.attendance) || record.attendance.length !== dates.length
        || (record.reasons !== undefined
          && (!Array.isArray(record.reasons) || record.reasons.length !== dates.length))
        || (record.remarks !== undefined && typeof record.remarks !== "string")
        || (record.statusDate !== undefined && typeof record.statusDate !== "string")
        || (record.remarks || "").length > 500) {
        throw new HttpError(400, "Each student must have exactly one complete attendance row for the selected month.");
      }
      const remarks = (record.remarks || "").trim();
      const statusDate = (record.statusDate || "").trim();
      const monthlyStatus = normalizeMonthlyAttendanceRemark(remarks);
      if (statusDate) {
        validateAttendanceDate(statusDate);
        if (statusDate > attendanceMonthEnd(month)) {
          throw new HttpError(400, "A monthly learner status date cannot be after the selected month.");
        }
      }
      if (monthlyStatus && !statusDate) {
        throw new HttpError(400, "Choose the date the learner status took effect.");
      }
      const statuses = record.attendance.map((status) => {
        const normalized = status === "Late"
          ? "Tardy"
          : status === "Half-day" ? "Absent" : status;
        if (typeof normalized !== "string" || (normalized !== "" && !ATTENDANCE_STATUSES.includes(normalized))) {
          throw new HttpError(400, "Choose Present, Absent, Tardy, or Excused for each attendance day.");
        }
        return normalized;
      });
      const reasons = dates.map((date, index) => {
        const reason = record.reasons === undefined ? "" : record.reasons[index];
        if (typeof reason !== "string" || reason.length > 500) {
          throw new HttpError(400, "Each absence reason must be text no longer than 500 characters.");
        }
        const normalized = reason.trim();
        return statuses[index] === "Absent" || statuses[index] === "Excused" ? normalized : "";
      });
      recordsByStudentId.set(studentId, {
        attendance: statuses,
        reasons,
        remarks,
        statusDate,
      });
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = getOwnedStudents(studentSheet, studentColumns, session);
      if (recordsByStudentId.size !== students.length
        || students.some((student) => !recordsByStudentId.has(student.id))) {
        throw new HttpError(400, "Submit an attendance row for every student in your class.");
      }
      const notes = getAttendanceNotesSheet(workbook);
      const statusEvents = monthlyAttendanceStatusEvents(workbook, session, students.map((student) => student.id));
      for (const student of students) {
        const record = recordsByStudentId.get(student.id);
        const status = normalizeMonthlyAttendanceRemark(record.remarks);
        const previousStatus = latestMonthlyStatus(statusEvents.get(student.id) || [], month);
        if (status && record.statusDate.slice(0, 7) !== month
          && (record.statusDate !== previousStatus?.date || status !== previousStatus?.status)) {
          throw new HttpError(400, "Choose a status date in the selected month, or keep the existing status and its date.");
        }
        const events = (statusEvents.get(student.id) || []).filter((event) => !event.date.startsWith(`${month}-`));
        if (status && record.statusDate.startsWith(`${month}-`)) {
          events.push({ status, date: record.statusDate });
          events.sort((left, right) => left.date.localeCompare(right.date));
        }
        for (let index = 0; index < dates.length; index += 1) {
          if (isAttendanceDateLocked(events, dates[index])
            && record.attendance[index]) {
            throw new HttpError(400, `${student.name}'s attendance is locked from ${dates[index]} because the learner is marked NLS or Transferred Out.`);
          }
        }
      }
      const calendar = getAttendanceCalendarSheet(workbook);
      const existingNoClassDates = new Set();
      for (let rowNumber = 2; rowNumber <= calendar.sheet.rowCount; rowNumber += 1) {
        const row = calendar.sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(calendar.columns.classId).value) === session.classId
          && cellText(row.getCell(calendar.columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(calendar.columns.dayType).value) === "Holiday/No Class"
        ) {
          const date = attendanceDateText(row.getCell(calendar.columns.date).value);
          if (dates.includes(date)) existingNoClassDates.add(date);
        }
      }
      const noClassDates = requestedNoClassDates || existingNoClassDates;
      for (const date of noClassDates) {
        const dayIndex = dates.indexOf(date);
        if ([...recordsByStudentId.values()].some((record) =>
          record.attendance[dayIndex])) {
          throw new HttpError(400, `${date} is marked Holiday/No Class. Clear its attendance before saving.`);
        }
      }
      const calendarRowsByDate = new Map();
      for (let rowNumber = 2; rowNumber <= calendar.sheet.rowCount; rowNumber += 1) {
        const row = calendar.sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(calendar.columns.classId).value) === session.classId
          && cellText(row.getCell(calendar.columns.teacherUserId).value) === session.userId
        ) {
          const date = attendanceDateText(row.getCell(calendar.columns.date).value);
          if (dates.includes(date)) calendarRowsByDate.set(date, row);
        }
      }
      const calendarRowsToDelete = [];
      for (const [date, row] of calendarRowsByDate) {
        if (noClassDates.has(date)) {
          row.getCell(calendar.columns.dayType).value = "Holiday/No Class";
          if (requestedNoClassReasons) {
            row.getCell(calendar.columns.reason).value = requestedNoClassReasons.get(date) || "";
          }
          row.getCell(calendar.columns.updated).value = new Date();
        } else {
          calendarRowsToDelete.push(row.number);
        }
      }
      for (const date of noClassDates) {
        if (calendarRowsByDate.has(date)) continue;
        writeRow(calendar.sheet, [calendar.columns.id], {
          [calendar.columns.id]: `AC${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
          [calendar.columns.classId]: session.classId,
          [calendar.columns.teacherUserId]: session.userId,
          [calendar.columns.date]: date,
          [calendar.columns.dayType]: "Holiday/No Class",
          [calendar.columns.reason]: requestedNoClassReasons?.get(date) || "",
          [calendar.columns.updated]: new Date(),
          [calendar.columns.key]: `${session.classId}${session.userId}${date}`,
        });
      }
      calendarRowsToDelete.sort((left, right) => right - left)
        .forEach((rowNumber) => calendar.sheet.spliceRows(rowNumber, 1));
      const { sheet, columns } = getAttendanceSheet(workbook);
      const rowsByKey = new Map();
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(columns.classId).value) !== session.classId
          || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
        ) continue;
        const date = attendanceDateText(row.getCell(columns.date).value);
        if (date.startsWith(`${month}-`)) {
          rowsByKey.set(`${cellText(row.getCell(columns.studentId).value)}|${date}`, row);
        }
      }
      const rowsToDelete = [];
      for (const [studentId, record] of recordsByStudentId) {
        record.attendance.forEach((status, index) => {
          const key = `${studentId}|${dates[index]}`;
          const existing = rowsByKey.get(key);
          if (!status || noClassDates.has(dates[index])) {
            if (existing) rowsToDelete.push(existing.number);
          } else if (existing) {
            existing.getCell(columns.status).value = status;
            existing.getCell(columns.reason).value = record.reasons[index];
            existing.getCell(columns.updated).value = new Date();
            existing.getCell(columns.key).value = `${studentId}${dates[index]}`;
          } else {
            writeRow(sheet, [columns.id], {
              [columns.id]: `A${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
              [columns.studentId]: studentId,
              [columns.classId]: session.classId,
              [columns.teacherUserId]: session.userId,
              [columns.date]: dates[index],
              [columns.status]: status,
              [columns.reason]: record.reasons[index],
              [columns.updated]: new Date(),
              [columns.key]: `${studentId}${dates[index]}`,
            });
          }
        });
      }
      rowsToDelete.sort((left, right) => right - left)
        .forEach((rowNumber) => sheet.spliceRows(rowNumber, 1));
      const rowsByStudentId = new Map();
      for (let rowNumber = 2; rowNumber <= notes.sheet.rowCount; rowNumber += 1) {
        const row = notes.sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(notes.columns.classId).value) === session.classId
          && cellText(row.getCell(notes.columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(notes.columns.month).value) === month
        ) {
          rowsByStudentId.set(cellText(row.getCell(notes.columns.studentId).value), row);
        }
      }
      const noteRowsToDelete = [];
      for (const [studentId, record] of recordsByStudentId) {
        const existing = rowsByStudentId.get(studentId);
        const status = normalizeMonthlyAttendanceRemark(record.remarks);
        const persistRemark = status && !record.statusDate.startsWith(`${month}-`)
          ? ""
          : record.remarks;
        if (!persistRemark) {
          if (existing) noteRowsToDelete.push(existing.number);
        } else if (existing) {
          existing.getCell(notes.columns.remarks).value = persistRemark;
          existing.getCell(notes.columns.statusDate).value = status ? record.statusDate : null;
          existing.getCell(notes.columns.updated).value = new Date();
          existing.getCell(notes.columns.key).value = `${studentId}${month}`;
        } else {
          writeRow(notes.sheet, [notes.columns.id], {
            [notes.columns.id]: `AN${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
            [notes.columns.studentId]: studentId,
            [notes.columns.classId]: session.classId,
            [notes.columns.teacherUserId]: session.userId,
            [notes.columns.month]: month,
            [notes.columns.remarks]: persistRemark,
            [notes.columns.statusDate]: status ? record.statusDate : null,
            [notes.columns.updated]: new Date(),
            [notes.columns.key]: `${studentId}${month}`,
          });
        }
      }
      noteRowsToDelete.sort((left, right) => right - left)
        .forEach((rowNumber) => notes.sheet.spliceRows(rowNumber, 1));
      await saveDatabaseWorkbook(workbook);
      return { saved: true, month };
    });
  }

  async function clearAttendanceMonth(session, monthValue) {
    const month = validateAttendanceMonth(monthValue);
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getAttendanceSheet(workbook);
      const rowsToDelete = [];
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId
          && attendanceDateText(row.getCell(columns.date).value).startsWith(`${month}-`)
        ) {
          rowsToDelete.push(row.number);
        }
      }
      rowsToDelete.sort((left, right) => right - left)
        .forEach((rowNumber) => sheet.spliceRows(rowNumber, 1));
      const calendar = getAttendanceCalendarSheet(workbook);
      const noClassRowsToDelete = [];
      for (let rowNumber = 2; rowNumber <= calendar.sheet.rowCount; rowNumber += 1) {
        const row = calendar.sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(calendar.columns.classId).value) === session.classId
          && cellText(row.getCell(calendar.columns.teacherUserId).value) === session.userId
          && attendanceDateText(row.getCell(calendar.columns.date).value).startsWith(`${month}-`)
        ) {
          noClassRowsToDelete.push(row.number);
        }
      }
      noClassRowsToDelete.sort((left, right) => right - left)
        .forEach((rowNumber) => calendar.sheet.spliceRows(rowNumber, 1));
      await saveDatabaseWorkbook(workbook);
      return {
        cleared: true,
        month,
        deleted: rowsToDelete.length,
        noClassDatesCleared: noClassRowsToDelete.length,
      };
    });
  }

  async function importAttendanceSF2(session, monthValue, buffer) {
    const month = validateAttendanceMonth(monthValue);
    const importedRecords = await parseSF2Upload(buffer, month);
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = getOwnedStudents(studentSheet, studentColumns, session);
      const maleCount = students.filter((student) => student.gender === "Male").length;
      const femaleCount = students.filter((student) => student.gender === "Female").length;
      if (
        maleCount + femaleCount !== students.length
        || maleCount > SF2_MAX_STUDENTS_PER_GENDER
        || femaleCount > SF2_MAX_STUDENTS_PER_GENDER
      ) {
        throw new HttpError(400, "This class roster exceeds the SF2 template's 50-learner limit per gender section.");
      }

      const studentsByName = new Map();
      for (const student of students) {
        const key = normalizeSF2LearnerName(student.name);
        if (!studentsByName.has(key)) studentsByName.set(key, []);
        studentsByName.get(key).push(student);
      }
      const matchedRecords = [];
      const unmatchedRows = [];
      const importedNoClassDates = new Set();
      for (const record of importedRecords) {
        const matches = studentsByName.get(record.normalizedName) || [];
        if (matches.length !== 1 || matches[0].gender !== record.gender) {
          unmatchedRows.push(record.rowNumber);
          continue;
        }
        for (const entry of record.attendance) {
          if (entry.status === "No Class") importedNoClassDates.add(entry.date);
        }
        matchedRecords.push({
          ...record,
          remarks: normalizeMonthlyAttendanceRemark(record.remarks) || record.remarks,
          statusDate: record.statusDate
            || (isMonthlyAttendanceRemark(record.remarks) ? attendanceMonthEnd(month) : ""),
          student: matches[0],
        });
      }
      if (unmatchedRows.length) {
        throw new HttpError(
          400,
          `No unique learner matching the SF2 name and gender section was found in your class roster for row${unmatchedRows.join(", ")}. No attendance was changed.`,
        );
      }
      const statusEvents = monthlyAttendanceStatusEvents(workbook, session, students.map((student) => student.id));
      for (const record of matchedRecords) {
        const status = normalizeMonthlyAttendanceRemark(record.remarks);
        if (status && record.statusDate) {
          validateAttendanceDate(record.statusDate);
          if (record.statusDate > attendanceMonthEnd(month)) {
            throw new HttpError(400, `The learner status date in row ${record.rowNumber} is after the selected month.`);
          }
        }
        const previousStatus = latestMonthlyStatus(statusEvents.get(record.student.id) || [], month);
        if (status && record.statusDate.slice(0, 7) !== month
          && (record.statusDate !== previousStatus?.date || status !== previousStatus?.status)) {
          throw new HttpError(400, `The learner status date in row ${record.rowNumber} does not match the saved status history.`);
        }
        const events = (statusEvents.get(record.student.id) || [])
          .filter((event) => !event.date.startsWith(`${month}-`));
        if (status && record.statusDate.startsWith(`${month}-`)) {
          events.push({ status, date: record.statusDate });
          events.sort((left, right) => left.date.localeCompare(right.date));
        }
        for (const entry of record.attendance) {
          const locked = isAttendanceDateLocked(events, entry.date);
          if ((locked && entry.status !== "Locked" && entry.status !== "No Class")
            || (!locked && entry.status === "Locked")) {
            throw new HttpError(
              400,
              `${record.student.name}'s SF2 attendance does not match the NLS/Transferred Out lock for ${entry.date}.`,
            );
          }
        }
      }
      for (const date of importedNoClassDates) {
        if (matchedRecords.some((record) =>
          record.attendance.find((entry) => entry.date === date)?.status !== "No Class")) {
          throw new HttpError(400, `${date} must be marked NC for every learner in the SF2 worksheet.`);
        }
      }

      const importedStudentIds = new Set(matchedRecords.map(({ student }) => student.id));
      const calendar = getAttendanceCalendarSheet(workbook);
      const noClassDates = new Set();
      for (let rowNumber = 2; rowNumber <= calendar.sheet.rowCount; rowNumber += 1) {
        const row = calendar.sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(calendar.columns.classId).value) === session.classId
          && cellText(row.getCell(calendar.columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(calendar.columns.dayType).value) === "Holiday/No Class"
        ) {
          const date = attendanceDateText(row.getCell(calendar.columns.date).value);
          if (date.startsWith(`${month}-`)) noClassDates.add(date);
        }
      }
      for (const date of importedNoClassDates) noClassDates.add(date);
      const calendarRowsByDate = new Map();
      for (let rowNumber = 2; rowNumber <= calendar.sheet.rowCount; rowNumber += 1) {
        const row = calendar.sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(calendar.columns.classId).value) === session.classId
          && cellText(row.getCell(calendar.columns.teacherUserId).value) === session.userId
        ) {
          const date = attendanceDateText(row.getCell(calendar.columns.date).value);
          if (date.startsWith(`${month}-`)) calendarRowsByDate.set(date, row);
        }
      }
      for (const date of importedNoClassDates) {
        const existing = calendarRowsByDate.get(date);
        if (existing) {
          existing.getCell(calendar.columns.dayType).value = "Holiday/No Class";
          existing.getCell(calendar.columns.updated).value = new Date();
          continue;
        }
        const row = writeRow(calendar.sheet, [calendar.columns.id], {
          [calendar.columns.id]: `AC${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
          [calendar.columns.classId]: session.classId,
          [calendar.columns.teacherUserId]: session.userId,
          [calendar.columns.date]: date,
          [calendar.columns.dayType]: "Holiday/No Class",
          [calendar.columns.updated]: new Date(),
          [calendar.columns.key]: `${session.classId}${session.userId}${date}`,
        });
        calendarRowsByDate.set(date, row);
      }
      const { sheet: attendanceSheet, columns: attendanceColumns } = getAttendanceSheet(workbook);
      const attendanceRowsToDelete = [];
      for (let rowNumber = 2; rowNumber <= attendanceSheet.rowCount; rowNumber += 1) {
        const row = attendanceSheet.getRow(rowNumber);
        const studentId = cellText(row.getCell(attendanceColumns.studentId).value);
        const date = attendanceDateText(row.getCell(attendanceColumns.date).value);
        if (
          importedStudentIds.has(studentId)
          && cellText(row.getCell(attendanceColumns.classId).value) === session.classId
          && cellText(row.getCell(attendanceColumns.teacherUserId).value) === session.userId
          && date.startsWith(`${month}-`)
        ) {
          attendanceRowsToDelete.push(rowNumber);
        }
      }
      attendanceRowsToDelete.sort((left, right) => right - left)
        .forEach((rowNumber) => attendanceSheet.spliceRows(rowNumber, 1));

      let importedDays = 0;
      for (const record of matchedRecords) {
        for (const entry of record.attendance) {
          if (noClassDates.has(entry.date) || entry.status === "Locked" || entry.status === "No Class") continue;
          writeRow(attendanceSheet, [attendanceColumns.id], {
            [attendanceColumns.id]: `A${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
            [attendanceColumns.studentId]: record.student.id,
            [attendanceColumns.classId]: session.classId,
            [attendanceColumns.teacherUserId]: session.userId,
            [attendanceColumns.date]: entry.date,
            [attendanceColumns.status]: entry.status,
            [attendanceColumns.reason]: entry.reason || "",
            [attendanceColumns.updated]: new Date(),
            [attendanceColumns.key]: `${record.student.id}${entry.date}`,
          });
          importedDays += 1;
        }
      }

      const notes = getAttendanceNotesSheet(workbook);
      const noteRowsToDelete = [];
      const existingNotesByStudent = new Map();
      for (let rowNumber = 2; rowNumber <= notes.sheet.rowCount; rowNumber += 1) {
        const row = notes.sheet.getRow(rowNumber);
        const studentId = cellText(row.getCell(notes.columns.studentId).value);
        if (
          importedStudentIds.has(studentId)
          && cellText(row.getCell(notes.columns.classId).value) === session.classId
          && cellText(row.getCell(notes.columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(notes.columns.month).value) === month
        ) {
          existingNotesByStudent.set(studentId, {
            remarks: cellText(row.getCell(notes.columns.remarks).value),
            statusDate: attendanceDateText(row.getCell(notes.columns.statusDate).value),
          });
          noteRowsToDelete.push(rowNumber);
        }
      }
      noteRowsToDelete.sort((left, right) => right - left)
        .forEach((rowNumber) => notes.sheet.spliceRows(rowNumber, 1));
      for (const record of matchedRecords) {
        const existingNote = existingNotesByStudent.get(record.student.id);
        const remarks = record.remarks || existingNote?.remarks || "";
        const statusDate = record.statusDate || existingNote?.statusDate || "";
        if (!remarks) continue;
        if (normalizeMonthlyAttendanceRemark(remarks) && !statusDate.startsWith(`${month}-`)) continue;
        writeRow(notes.sheet, [notes.columns.id], {
          [notes.columns.id]: `AN${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
          [notes.columns.studentId]: record.student.id,
          [notes.columns.classId]: session.classId,
          [notes.columns.teacherUserId]: session.userId,
          [notes.columns.month]: month,
          [notes.columns.remarks]: remarks,
          [notes.columns.statusDate]: statusDate || null,
          [notes.columns.updated]: new Date(),
          [notes.columns.key]: `${record.student.id}${month}`,
        });
      }
      await saveDatabaseWorkbook(workbook);
      return { imported: matchedRecords.length, importedDays, month };
    });
  }

  async function exportAttendanceSF2(session, monthValue, sectionFilter) {
    const month = validateAttendanceMonth(monthValue);
    const attendance = await getAttendanceMonth(session, month);
    const teacherProfile = await getTeacherProfile(session);
    if (sectionFilter && sectionFilter !== "__all__") {
      const roster = await listStudents(session);
      const selectedIds = new Set(roster.students
        .filter((student) => matchesStudentSection(student, sectionFilter))
        .map((student) => student.id));
      attendance.students = attendance.students.filter((student) => selectedIds.has(student.id));
      teacherProfile.section = sectionFilter === "__unassigned__" ? "" : sectionFilter;
      const sectionGrade = Object.entries(roster.sectionGrades).find(([section]) =>
        section.toLocaleLowerCase() === teacherProfile.section.toLocaleLowerCase());
      if (sectionGrade) teacherProfile.grade = sectionGrade[1];
    }
    if (!attendance.students.length) {
      throw new HttpError(400, "Add learners to the selected section before downloading the SF2.");
    }
    if (!teacherProfile.grade || !teacherProfile.schoolYear) {
      throw new HttpError(400, "Enter the Grade and School Year in Teacher Profile before downloading SF2.");
    }
    const maleStudents = attendance.students.filter((student) => student.gender === "Male");
    const femaleStudents = attendance.students.filter((student) => student.gender === "Female");
    if (
      maleStudents.length + femaleStudents.length !== attendance.students.length
      || maleStudents.length > SF2_MAX_STUDENTS_PER_GENDER
      || femaleStudents.length > SF2_MAX_STUDENTS_PER_GENDER
    ) {
      throw new HttpError(400, "This class roster exceeds the SF2 template's 50-learner limit per gender section.");
    }

    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.readFile(SF2_TEMPLATE_PATH);
    } catch (error) {
      throw new Error(`The SF2 template could not be read: ${error.message}`);
    }
    const sheet = workbook.getWorksheet("OCT 2026") || workbook.worksheets[0];
    if (
      !sheet
      || !normalizeHeader(cellText(sheet.getCell(9, 2).value)).startsWith("learnersname")
      || !normalizeHeader(cellText(sheet.getCell(9, SF2_FIRST_DAY_COLUMN).value)).startsWith("1strowfordate")
      || !normalizeHeader(cellText(sheet.getCell(9, 32).value)).includes("totalforthemonth")
      || !normalizeHeader(cellText(sheet.getCell(9, 33).value)).includes("totalforthemonth")
      || !normalizeHeader(cellText(sheet.getCell(9, SF2_REMARKS_COLUMN).value)).startsWith("remarks")
      || !normalizeHeader(cellText(sheet.getCell(63, 2).value)).includes("male")
      || !normalizeHeader(cellText(sheet.getCell(63, 2).value)).includes("total")
      || !normalizeHeader(cellText(sheet.getCell(114, 2).value)).includes("female")
      || !normalizeHeader(cellText(sheet.getCell(114, 2).value)).includes("total")
    ) {
      throw new Error("The project SF2 template does not match the expected worksheet layout.");
    }
    for (const otherSheet of workbook.worksheets.slice()) {
      if (otherSheet.id !== sheet.id) workbook.removeWorksheet(otherSheet.id);
    }
    sheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        const fill = cell.fill;
        const color = fill && fill.fgColor && (fill.fgColor.argb || fill.fgColor.rgb);
        if (fill && fill.type === "pattern" && fill.pattern === "solid"
          && ["FFF2F2F2", "FFE6E6E6"].includes(String(color || "").toUpperCase())) {
          cell.fill = { type: "pattern", pattern: "none" };
        }
      });
    });
    sheet.name = sf2WorksheetName(month);
    const displayedMonth = sf2DisplayedMonth(month);
    sheet.getCell("N6").value = teacherProfile.schoolYear || null;
    sheet.getCell("G6").value = teacherProfile.schoolId || null;
    sheet.getCell("G7").value = teacherProfile.schoolName || null;
    sheet.getCell("AA7").value = teacherProfile.grade || null;
    sheet.getCell("AF7").value = teacherProfile.section || null;
    sheet.getCell("AA6").value = displayedMonth;
    sheet.getCell("AG117").value = displayedMonth;
    sheet.getCell("AG118").value = displayedMonth;
    const writeSignatory = (cellReference, name) => {
      const cell = sheet.getCell(cellReference);
      cell.value = typeof name === "string" && name.trim() ? name.trim() : null;
      cell.alignment = {
        ...cell.alignment,
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };
    };
    writeSignatory("AE140", teacherProfile.name);
    writeSignatory("AE145", teacherProfile.schoolHead);
    const weekdayDates = attendanceSchoolDays(month);
    const classDayCount = weekdayDates.filter((date) =>
      !attendance.noClassDates.includes(date)).length;
    sheet.getCell("AQ9").value = classDayCount;
    sheet.getCell("AJ117").value = { formula: "AQ9", result: classDayCount };
    sheet.getCell("AJ118").value = { formula: "AQ9", result: classDayCount };
    for (let column = SF2_FIRST_DAY_COLUMN; column <= SF2_LAST_DAY_COLUMN; column += 1) {
      sheet.getCell(10, column).value = null;
      sheet.getCell(11, column).value = null;
    }
    const dateColumns = new Map();
    weekdayDates.forEach((date, index) => {
      const column = SF2_FIRST_DAY_COLUMN + index;
      const day = Number(date.slice(-2));
      const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
      sheet.getCell(10, column).value = day;
      sheet.getCell(11, column).value = SF2_WEEKDAY_NAMES[(weekday + 6) % 7];
      dateColumns.set(date, column);
    });
    for (const rowNumber of SF2_STUDENT_ROWS) {
      const row = sheet.getRow(rowNumber);
      row.hidden = true;
      row.getCell(1).value = null;
      for (let column = 2; column <= 6; column += 1) row.getCell(column).value = null;
      for (let column = SF2_FIRST_DAY_COLUMN; column <= SF2_LAST_DAY_COLUMN; column += 1) {
        row.getCell(column).value = null;
      }
      row.getCell(SF2_REMARKS_COLUMN).value = null;
      row.getCell(SF2_REMARKS_COLUMN + 1).value = null;
    }
    const outputRows = [
      ...maleStudents.map((student, index) => ({
        student,
        rowNumber: SF2_FIRST_MALE_STUDENT_ROW + index,
        sequence: index + 1,
      })),
      ...femaleStudents.map((student, index) => ({
        student,
        rowNumber: SF2_FIRST_FEMALE_STUDENT_ROW + index,
        sequence: index + 1,
      })),
    ];
    const weekdayIndices = new Map(weekdayDates.map((date, index) => [date, index]));
    for (const { student, rowNumber, sequence } of outputRows) {
      const row = sheet.getRow(rowNumber);
      row.hidden = false;
      row.getCell(1).value = sequence;
      sheet.mergeCells(`B${rowNumber}:F${rowNumber}`);
      row.getCell(2).value = student.name;
      row.getCell(2).alignment = {
        ...row.getCell(2).alignment,
        horizontal: "left",
        vertical: "middle",
        wrapText: true,
      };
      const estimatedLines = Math.ceil(student.name.length / 65);
      row.height = Math.max(row.height || 15, Math.min(45, estimatedLines * 15));
      for (const date of weekdayDates) {
        const dayIndex = weekdayIndices.get(date);
        const cell = row.getCell(dateColumns.get(date));
        if (attendance.noClassDates.includes(date)) {
          cell.value = "NC";
          continue;
        }
        if (student.lockedDates.includes(date)) {
          cell.value = "N/A";
          continue;
        }
        const status = normalizeAttendanceStatus(student.attendance[dayIndex]);
        if (!status) continue;
        const mark = SF2_MARK_BY_STATUS.get(status);
        if (mark === undefined) {
          throw new HttpError(400, `The attendance status "${status}" cannot be represented in SF2.`);
        }
        cell.value = mark || null;
      }
      const monthlyRemark = normalizeMonthlyAttendanceRemark(student.remarks);
      let remarks = monthlyRemark || "";
      if (monthlyRemark && student.statusDate) {
        remarks += `${SF2_STATUS_DATE_MARKER}${student.statusDate}]`;
      }
      const absenceReasonLines = weekdayDates.flatMap((date) => {
        const dayIndex = weekdayIndices.get(date);
        const status = normalizeAttendanceStatus(student.attendance[dayIndex]);
        if (status !== "Absent" && status !== "Excused") return [];
        const reason = cellText(student.reasons[dayIndex]).trim();
        if (!reason) return [];
        return [`${date}: ${reason}`];
      });
      if (absenceReasonLines.length) {
        remarks += `${remarks ? "\n" : ""}${SF2_ABSENCE_REASONS_MARKER}${absenceReasonLines.join("\n")}`;
      }
      row.getCell(SF2_REMARKS_COLUMN).value = remarks || null;
    }

    const studentRowsByNumber = new Map(outputRows.map(({ student, rowNumber }) => [rowNumber, student]));
    const maleCount = maleStudents.length;
    const femaleCount = femaleStudents.length;
    const formulaValue = (cell, formula, result) => {
      cell.value = { formula, result };
    };
    const registeredLearnerCount = (students) => students.reduce((count, student) => {
      const monthlyRemark = normalizeMonthlyAttendanceRemark(student.remarks);
      return count + (monthlyRemark === "NLS" || monthlyRemark === "Transferred Out" ? -1
        : monthlyRemark === "Transferred In" ? 1 : 0);
    }, students.length);
    const registeredCountFormula = (firstRow, lastRow) => {
      const names = `$B$${firstRow}:$B$${lastRow}`;
      const remarks = `$AH$${firstRow}:$AH$${lastRow}`;
      return `COUNTA(${names})-COUNTIF(${remarks},"NLS*")-COUNTIF(${remarks},"Transferred Out*")+COUNTIF(${remarks},"Transferred In*")`;
    };
    const maleRange = `$B$${SF2_FIRST_MALE_STUDENT_ROW}:$B$${SF2_LAST_MALE_STUDENT_ROW}`;
    const femaleRange = `$B$${SF2_FIRST_FEMALE_STUDENT_ROW}:$B$${SF2_LAST_FEMALE_STUDENT_ROW}`;

    for (const [firstRow, lastRow, students] of [
      [SF2_FIRST_MALE_STUDENT_ROW, SF2_LAST_MALE_STUDENT_ROW, maleStudents],
      [SF2_FIRST_FEMALE_STUDENT_ROW, SF2_LAST_FEMALE_STUDENT_ROW, femaleStudents],
    ]) {
      for (let rowNumber = firstRow; rowNumber <= lastRow; rowNumber += 1) {
        const student = studentRowsByNumber.get(rowNumber);
        let absences = 0;
        let countedDays = 0;
        if (student) {
          for (const date of weekdayDates) {
            if (attendance.noClassDates.includes(date)) continue;
            if (student.lockedDates.includes(date)) continue;
            countedDays += 1;
            const dayIndex = weekdayIndices.get(date);
            const status = normalizeAttendanceStatus(student.attendance[dayIndex]);
            if (status === "Absent") absences += 1;
          }
        }
        formulaValue(
          sheet.getCell(`AF${rowNumber}`),
          `IF(B${rowNumber}="","",COUNTIF(G${rowNumber}:AE${rowNumber},"CC")+COUNTIF(G${rowNumber}:AE${rowNumber},"x")+COUNTIF(G${rowNumber}:AE${rowNumber},"h"))`,
          student ? absences : "",
        );
        formulaValue(
          sheet.getCell(`AG${rowNumber}`),
          `IF(B${rowNumber}="","",$AJ$117-COUNTIF(G${rowNumber}:AE${rowNumber},"N/A")-AF${rowNumber})`,
          student ? countedDays - absences : "",
        );
      }
      const totalRow = firstRow === SF2_FIRST_MALE_STUDENT_ROW ? 63 : 114;
      const registeredStudents = students.filter((student) => {
        const status = normalizeMonthlyAttendanceRemark(student.remarks);
        return status !== "NLS" && status !== "Transferred Out";
      });
      const registeredAbsentTotal = registeredStudents.reduce((total, student) => {
        return total + weekdayDates.reduce((studentTotal, date) => {
          if (attendance.noClassDates.includes(date) || student.lockedDates.includes(date)) return studentTotal;
          const status = normalizeAttendanceStatus(student.attendance[weekdayIndices.get(date)]);
          return studentTotal + (status === "Absent" ? 1 : 0);
        }, 0);
      }, 0);
      formulaValue(
        sheet.getCell(`AF${totalRow}`),
        `SUM(AF${firstRow}:AF${lastRow})-SUMIF(AH${firstRow}:AH${lastRow},"NLS*",AF${firstRow}:AF${lastRow})-SUMIF(AH${firstRow}:AH${lastRow},"Transferred Out*",AF${firstRow}:AF${lastRow})`,
        registeredAbsentTotal,
      );
      formulaValue(
        sheet.getCell(`AG${totalRow}`),
        `SUM(AG${firstRow}:AG${lastRow})-SUMIF(AH${firstRow}:AH${lastRow},"NLS*",AG${firstRow}:AG${lastRow})-SUMIF(AH${firstRow}:AH${lastRow},"Transferred Out*",AG${firstRow}:AG${lastRow})`,
        registeredStudents.reduce((total, student) => {
          const studentAbsences = weekdayDates.reduce((count, date) => {
            if (attendance.noClassDates.includes(date) || student.lockedDates.includes(date)) return count;
            const status = normalizeAttendanceStatus(student.attendance[weekdayIndices.get(date)]);
            return count + (status === "Absent" ? 1 : 0);
          }, 0);
          const studentClassDays = weekdayDates.filter((date) =>
            !attendance.noClassDates.includes(date) && !student.lockedDates.includes(date)).length;
          return total + studentClassDays - studentAbsences;
        }, 0),
      );
      for (let column = SF2_FIRST_DAY_COLUMN; column <= SF2_LAST_DAY_COLUMN; column += 1) {
        const letter = sheet.getColumn(column).letter;
        const date = weekdayDates[column - SF2_FIRST_DAY_COLUMN];
        const presentTotal = date && !attendance.noClassDates.includes(date)
          ? registeredStudents.reduce((count, student) => {
            if (student.lockedDates.includes(date)) return count;
            const status = normalizeAttendanceStatus(student.attendance[weekdayIndices.get(date)]);
            return count + (status === "Absent" ? 0 : 1);
          }, 0)
          : 0;
        const dailyFormula = date && !attendance.noClassDates.includes(date)
          ? `IF(${letter}10="","",COUNTA($B$${firstRow}:$B$${lastRow})-COUNTIF(${letter}${firstRow}:${letter}${lastRow},"CC")-COUNTIF(${letter}${firstRow}:${letter}${lastRow},"x")-COUNTIF(${letter}${firstRow}:${letter}${lastRow},"h")-COUNTIF(${letter}${firstRow}:${letter}${lastRow},"N/A")-COUNTIF(AH${firstRow}:AH${lastRow},"NLS*")-COUNTIF(AH${firstRow}:AH${lastRow},"Transferred Out*"))`
          : `IF(${letter}10="","",0)`;
        formulaValue(sheet.getCell(`${letter}${totalRow}`), dailyFormula, date ? presentTotal : "");
      }
    }
    const combinedAbsent = (sheet.getCell("AF63").value.result || 0) + (sheet.getCell("AF114").value.result || 0);
    const combinedPresent = (sheet.getCell("AG63").value.result || 0) + (sheet.getCell("AG114").value.result || 0);
    formulaValue(sheet.getCell("AF115"), "AF63+AF114", combinedAbsent);
    formulaValue(sheet.getCell("AG115"), "AG63+AG114", combinedPresent);
    for (let column = SF2_FIRST_DAY_COLUMN; column <= SF2_LAST_DAY_COLUMN; column += 1) {
      const letter = sheet.getColumn(column).letter;
      const date = weekdayDates[column - SF2_FIRST_DAY_COLUMN];
      const combinedDaily = date && !attendance.noClassDates.includes(date)
        ? (sheet.getCell(`${letter}63`).value.result || 0) + (sheet.getCell(`${letter}114`).value.result || 0)
        : 0;
      formulaValue(sheet.getCell(`${letter}115`), `${letter}63+${letter}114`,
        date ? combinedDaily : "");
    }

    const summaryCounts = [
      ["AK", SF2_FIRST_MALE_STUDENT_ROW, SF2_LAST_MALE_STUDENT_ROW, maleStudents],
      ["AL", SF2_FIRST_FEMALE_STUDENT_ROW, SF2_LAST_FEMALE_STUDENT_ROW, femaleStudents],
    ];
    const registeredByColumn = new Map();
    for (const [column, firstRow, lastRow, students] of summaryCounts) {
      const count = students.length;
      const registeredCount = registeredLearnerCount(students);
      registeredByColumn.set(column, registeredCount);
      for (const rowNumber of [119, 120]) sheet.getCell(`${column}${rowNumber}`).value = count;
      formulaValue(
        sheet.getCell(`${column}123`),
        registeredCountFormula(firstRow, lastRow),
        registeredCount,
      );
    }
    sheet.getCell("AM119").value = { formula: "AK119+AL119", result: maleCount + femaleCount };
    sheet.getCell("AM120").value = { formula: "AK119+AL119", result: maleCount + femaleCount };
    const totalRegisteredCount = registeredByColumn.get("AK") + registeredByColumn.get("AL");
    formulaValue(sheet.getCell("AM123"), "AK123+AL123", totalRegisteredCount);
    for (const rowNumber of [125, 126]) {
      for (const [column, enrolled, enrollment] of [
        ["AK", registeredByColumn.get("AK"), maleCount],
        ["AL", registeredByColumn.get("AL"), femaleCount],
        ["AM", totalRegisteredCount, maleCount + femaleCount],
      ]) {
        formulaValue(
          sheet.getCell(`${column}${rowNumber}`),
          `IFERROR(${column}123/${column}119,0)`,
          enrollment ? enrolled / enrollment : 0,
        );
      }
    }
    for (const [column, students, presentTotal] of [
      ["AK", maleStudents, sheet.getCell("AG63").value.result],
      ["AL", femaleStudents, sheet.getCell("AG114").value.result],
      ["AM", attendance.students, combinedPresent],
    ]) {
      const averageDailyAttendance = classDayCount ? presentTotal / classDayCount : 0;
      formulaValue(
        sheet.getCell(`${column}127`),
        `IFERROR(AG${column === "AK" ? 63 : column === "AL" ? 114 : 115}/AJ117,0)`,
        averageDailyAttendance,
      );
      for (const rowNumber of [128, 129]) {
        formulaValue(
          sheet.getCell(`${column}${rowNumber}`),
          `IFERROR(${column}127/${column}123,0)`,
          registeredByColumn.get(column)
            ? averageDailyAttendance / registeredByColumn.get(column)
            : 0,
        );
      }
    }
    for (const [rowNumber, label] of [[132, "NLS"], [134, "Transferred Out"], [136, "Transferred In"]]) {
      const countLabel = (student) => normalizeMonthlyAttendanceRemark(student.remarks) === label ? 1 : 0;
      const maleTotal = maleStudents.reduce((total, student) => total + countLabel(student), 0);
      const femaleTotal = femaleStudents.reduce((total, student) => total + countLabel(student), 0);
      for (const row of [rowNumber, rowNumber + 1]) {
        formulaValue(
          sheet.getCell(`AK${row}`),
          `COUNTIF(AH${SF2_FIRST_MALE_STUDENT_ROW}:AH${SF2_LAST_MALE_STUDENT_ROW},"${label}*")`,
          maleTotal,
        );
        formulaValue(
          sheet.getCell(`AL${row}`),
          `COUNTIF(AH${SF2_FIRST_FEMALE_STUDENT_ROW}:AH${SF2_LAST_FEMALE_STUDENT_ROW},"${label}*")`,
          femaleTotal,
        );
        formulaValue(sheet.getCell(`AM${row}`), `AK${row}+AL${row}`, maleTotal + femaleTotal);
      }
    }
    workbook.calcProperties = { fullCalcOnLoad: true };

    const filenamePart = (value) => value.trim()
      .replace(/[^A-Za-z0-9-]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const monthName = new Date(`${month}-01T00:00:00.000Z`).toLocaleString("en-US", {
      month: "long",
      timeZone: "UTC",
    });
    return {
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
      filename: `SF2_${monthName}_${filenamePart(teacherProfile.grade)}_${filenamePart(teacherProfile.schoolYear)}.xlsx`,
    };
  }

  async function getAttendance(session, attendanceDate) {
    const date = validateAttendanceDate(attendanceDate);
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = getOwnedStudents(studentSheet, studentColumns, session).map((student) => ({
        id: student.id,
        name: student.name,
        status: "",
        reason: "",
      }));
      const studentsById = new Map(students.map((student) => [student.id, student]));
      const statusEvents = monthlyAttendanceStatusEvents(workbook, session, studentsById.keys());
      const attendanceSheet = workbook.getWorksheet("Attendance Records");
      if (attendanceSheet) {
        const { columns } = getAttendanceSheet(workbook);
        for (let rowNumber = 2; rowNumber <= attendanceSheet.rowCount; rowNumber += 1) {
          const row = attendanceSheet.getRow(rowNumber);
          if (
            cellText(row.getCell(columns.classId).value) !== session.classId
            || cellText(row.getCell(columns.teacherUserId).value) !== session.userId
            || cellText(row.getCell(columns.date).value) !== date
          ) continue;
          const student = studentsById.get(cellText(row.getCell(columns.studentId).value));
          if (student && !isAttendanceDateLocked(statusEvents.get(student.id) || [], date)) {
            student.status = normalizeAttendanceStatus(row.getCell(columns.status).value);
            student.reason = cellText(row.getCell(columns.reason).value);
          }
        }
      }
      return { date, statuses: ATTENDANCE_STATUSES, students };
    });
  }

  async function saveAttendance(session, data) {
    const date = validateAttendanceDate(data.date);
    if (!Array.isArray(data.records)) {
      throw new HttpError(400, "Submit an attendance status for every student.");
    }
    const recordsByStudentId = new Map();
    for (const record of data.records) {
      const studentId = record && typeof record.studentId === "string" ? record.studentId.trim() : "";
      const status = record && typeof record.status === "string"
        ? normalizeAttendanceStatus(record.status)
        : "";
      const reason = record && typeof record.reason === "string" ? record.reason.trim() : "";
      if (!studentId || studentId.length > 40 || recordsByStudentId.has(studentId)) {
        throw new HttpError(400, "Each student must appear exactly once in the attendance list.");
      }
      if (!ATTENDANCE_STATUSES.includes(status)) {
        throw new HttpError(400, "Choose Present, Absent, Tardy, or Excused for each student.");
      }
      if (record?.reason !== undefined && (typeof record.reason !== "string" || record.reason.length > 500)) {
        throw new HttpError(400, "Each absence reason must be text no longer than 500 characters.");
      }
      recordsByStudentId.set(studentId, {
        status,
        reason: status === "Absent" || status === "Excused" ? reason : "",
      });
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
      const students = getOwnedStudents(studentSheet, studentColumns, session);
      if (recordsByStudentId.size !== students.length
        || students.some((student) => !recordsByStudentId.has(student.id))) {
        throw new HttpError(400, "Submit an attendance status for every student in your class.");
      }
      const statusEvents = monthlyAttendanceStatusEvents(workbook, session, students.map((student) => student.id));
      const lockedStudent = students.find((student) =>
        isAttendanceDateLocked(statusEvents.get(student.id) || [], date));
      if (lockedStudent) {
        throw new HttpError(400, `${lockedStudent.name}'s attendance is locked for ${date} because the learner is marked NLS or Transferred Out.`);
      }
      const calendar = getAttendanceCalendarSheet(workbook);
      for (let rowNumber = 2; rowNumber <= calendar.sheet.rowCount; rowNumber += 1) {
        const row = calendar.sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(calendar.columns.classId).value) === session.classId
          && cellText(row.getCell(calendar.columns.teacherUserId).value) === session.userId
          && attendanceDateText(row.getCell(calendar.columns.date).value) === date
          && cellText(row.getCell(calendar.columns.dayType).value) === "Holiday/No Class"
        ) {
          throw new HttpError(400, `${date} is marked Holiday/No Class. Attendance is locked.`);
        }
      }
      const { sheet, columns } = getAttendanceSheet(workbook);
      const rowsByStudentId = new Map();
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (
          cellText(row.getCell(columns.classId).value) === session.classId
          && cellText(row.getCell(columns.teacherUserId).value) === session.userId
          && cellText(row.getCell(columns.date).value) === date
        ) {
          rowsByStudentId.set(cellText(row.getCell(columns.studentId).value), row);
        }
      }
      for (const [studentId, record] of recordsByStudentId) {
        const existing = rowsByStudentId.get(studentId);
        if (existing) {
          existing.getCell(columns.status).value = record.status;
          existing.getCell(columns.reason).value = record.reason;
          existing.getCell(columns.updated).value = new Date();
          existing.getCell(columns.key).value = `${studentId}${date}`;
        } else {
          writeRow(sheet, [columns.id], {
            [columns.id]: `A${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
            [columns.studentId]: studentId,
            [columns.classId]: session.classId,
            [columns.teacherUserId]: session.userId,
            [columns.date]: date,
            [columns.status]: record.status,
            [columns.reason]: record.reason,
            [columns.updated]: new Date(),
            [columns.key]: `${studentId}${date}`,
          });
        }
      }
      await saveDatabaseWorkbook(workbook);
      return { saved: true, date };
    });
  }

  async function getTeacherProfile(session) {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
      let userRow = null;
      for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
        const row = userSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(userColumns.id).value) === session.userId
          && cellText(row.getCell(userColumns.role).value).toLowerCase() === "teacher"
        ) {
          userRow = row;
          break;
        }
      }
      if (!userRow) throw new HttpError(404, "The teacher profile could not be found.");

      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      let classRow = null;
      for (let rowNumber = 2; rowNumber <= classSheet.rowCount; rowNumber += 1) {
        const row = classSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(classColumns.id).value) === session.classId
          && cellText(row.getCell(classColumns.teacherId).value) === session.userId
        ) {
          classRow = row;
          break;
        }
      }
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      const advisorySection = cellText(classRow.getCell(classColumns.section).value);
      const grade = cellText(classRow.getCell(classColumns.grade).value);
      const strand = cellText(classRow.getCell(classColumns.strand).value);
      const availableSubjects = teacherSubjectsForGrade(grade, strand);
      const gradeSubjects = gradeSubjectsForGrade(grade, strand);
      const sectionSubjects = readStoredSectionSubjects(
        classRow.getCell(classColumns.subjectsHandled).value,
        advisorySection,
      );
      const [hasPhoto, hasSchoolLogo] = await Promise.all([
        teacherPhotoExists(session.userId),
        teacherSchoolLogoExists(session.userId),
      ]);
      return {
        name: cellText(userRow.getCell(userColumns.name).value),
        email: cellText(userRow.getCell(userColumns.email).value),
        classroomNumber: cellText(classRow.getCell(classColumns.classroom).value),
        grade,
        strand,
        section: cellText(classRow.getCell(classColumns.section).value),
        sectionsHandled: getHandledSections(classRow, classColumns),
        sectionGrades: getSectionGrades(classRow, classColumns),
        subjectsHandled: getSubjectsForSection(sectionSubjects, advisorySection)
          .filter((subject) => availableSubjects.includes(subject)),
        availableSubjects,
        gradeSubjects: gradeSubjects.map(([key, label]) => ({ key, label })),
        generalAverageSubjects: generalAverageSubjectsForGrade(grade, strand),
        eClassSubjects: eClassSubjectsForGrade(grade, strand),
        schoolYear: cellText(classRow.getCell(classColumns.schoolYear).value),
        schoolName: cellText(classRow.getCell(classColumns.schoolName).value),
        schoolId: cellText(classRow.getCell(classColumns.schoolId).value),
        region: cellText(classRow.getCell(classColumns.region).value),
        division: cellText(classRow.getCell(classColumns.division).value),
        district: cellText(classRow.getCell(classColumns.district).value),
        position: cellText(classRow.getCell(classColumns.position).value),
        schoolHead: cellText(classRow.getCell(classColumns.schoolHead).value),
        schoolHeadPosition: cellText(classRow.getCell(classColumns.schoolHeadPosition).value),
        hasPhoto,
        hasSchoolLogo,
      };
    });
  }

  async function addTeacherSection(session, data) {
    const section = typeof data.sectionName === "string" ? data.sectionName.trim() : "";
    const grade = typeof data.grade === "string" ? data.grade.trim() : "";
    if (!section || section.length > 100) {
      throw new HttpError(400, "Enter a section name between 1 and 100 characters.");
    }
    if (!grade || grade.length > 100) {
      throw new HttpError(400, "Enter a grade between 1 and 100 characters.");
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      const classRow = findTeacherClassRow(classSheet, classColumns, session);
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      const advisorySection = cellText(classRow.getCell(classColumns.section).value);
      const sectionSubjects = readStoredSectionSubjects(
        classRow.getCell(classColumns.subjectsHandled).value,
        advisorySection,
      );

      const sectionsHandled = getHandledSections(classRow, classColumns);
      if (sectionsHandled.some((existing) => existing.toLocaleLowerCase() === section.toLocaleLowerCase())) {
        throw new HttpError(409, `The section "${section}" already exists.`);
      }
      if (sectionsHandled.length >= 30) {
        throw new HttpError(400, "Sections handled must contain no more than 30 entries.");
      }

      sectionsHandled.push(section);
      const sectionGrades = readStoredSectionGrades(classRow.getCell(classColumns.sectionGrades).value);
      const primarySection = cellText(classRow.getCell(classColumns.section).value);
      const classGrade = cellText(classRow.getCell(classColumns.grade).value);
      if (primarySection && classGrade && !sectionGrades.has(primarySection.toLocaleLowerCase())) {
        sectionGrades.set(primarySection.toLocaleLowerCase(), { section: primarySection, grade: classGrade });
      }
      sectionGrades.set(section.toLocaleLowerCase(), { section, grade });
      classRow.getCell(classColumns.sectionsHandled).value = JSON.stringify(sectionsHandled);
      classRow.getCell(classColumns.sectionGrades).value = JSON.stringify(serializeSectionGrades(sectionGrades));
      await saveDatabaseWorkbook(workbook);
      return { sectionsHandled, sectionGrades: serializeSectionGrades(sectionGrades) };
    });
  }

  async function updateTeacherProfile(session, data) {
    const name = typeof data.name === "string" ? data.name.trim() : "";
    const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
    const classroomNumber = typeof data.classroomNumber === "string" ? data.classroomNumber.trim() : "";
    const profileFields = [
      ["grade", "Grade", 100],
      ["section", "Section", 100],
      ["schoolYear", "School Year", 50],
      ["schoolName", "Name of School", 200],
      ["schoolId", "School ID", 20],
      ["region", "Region", 100],
      ["division", "Division", 100],
      ["district", "District", 100],
      ["position", "Position", 120],
      ["schoolHead", "School Head", 120],
      ["schoolHeadPosition", "School Head Position", 120],
    ];
    const suppliedProfileFields = new Map();
    for (const [key, label, maxLength] of profileFields) {
      if (data[key] === undefined) continue;
      if (typeof data[key] !== "string" || data[key].trim().length > maxLength) {
        throw new HttpError(400, `Enter ${label} using no more than ${maxLength} characters.`);
      }
      suppliedProfileFields.set(key, data[key].trim());
    }
    const suppliedLists = new Map();
    for (const [key, label] of [["sectionsHandled", "Sections handled"], ["subjectsHandled", "Subjects handled"]]) {
      if (data[key] === undefined) continue;
      if (!Array.isArray(data[key]) || data[key].some((entry) => typeof entry !== "string")) {
        throw new HttpError(400, `Enter ${label} as a list of text values.`);
      }
      const values = uniqueTextList(data[key]);
      if (values.length > 30 || values.some((entry) => entry.length > 100)) {
        throw new HttpError(400, `${label} must contain no more than 30 entries of 100 characters each.`);
      }
      suppliedLists.set(key, values);
    }
    if (!name || name.length > 120) {
      throw new HttpError(400, "Enter a name between 1 and 120 characters.");
    }
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
      throw new HttpError(400, "Enter a valid email address.");
    }
    if (!classroomNumber || classroomNumber.length > 100) {
      throw new HttpError(400, "Enter a classroom number between 1 and 100 characters.");
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet: userSheet, columns: userColumns } = getUserSheet(workbook);
      let userRow = null;
      for (let rowNumber = 2; rowNumber <= userSheet.rowCount; rowNumber += 1) {
        const row = userSheet.getRow(rowNumber);
        if (cellText(row.getCell(userColumns.id).value) === session.userId) {
          userRow = row;
          continue;
        }
        if (cellText(row.getCell(userColumns.email).value).toLowerCase() === email) {
          throw new HttpError(409, "That email already belongs to another account.");
        }
      }
      if (!userRow || cellText(userRow.getCell(userColumns.role).value).toLowerCase() !== "teacher") {
        throw new HttpError(404, "The teacher profile could not be found.");
      }

      const { sheet: classSheet, columns: classColumns } = getClassSheet(workbook);
      let classRow = null;
      for (let rowNumber = 2; rowNumber <= classSheet.rowCount; rowNumber += 1) {
        const row = classSheet.getRow(rowNumber);
        if (
          cellText(row.getCell(classColumns.id).value) === session.classId
          && cellText(row.getCell(classColumns.teacherId).value) === session.userId
        ) {
          classRow = row;
          continue;
        }
        if (cellText(row.getCell(classColumns.classroom).value).toLowerCase() === classroomNumber.toLowerCase()) {
          throw new HttpError(409, "That classroom number is already registered.");
        }
      }
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      const availableSubjects = teacherSubjectsForGrade(
        cellText(classRow.getCell(classColumns.grade).value),
        cellText(classRow.getCell(classColumns.strand).value),
      );
      if (suppliedLists.has("subjectsHandled")
        && suppliedLists.get("subjectsHandled").some((subject) => !availableSubjects.includes(subject))) {
        throw new HttpError(400, "Choose subjects available for this grade level.");
      }

      const primarySection = suppliedProfileFields.has("section")
        ? suppliedProfileFields.get("section")
        : cellText(classRow.getCell(classColumns.section).value);
      const sectionsHandled = uniqueTextList([
        ...(suppliedLists.get("sectionsHandled") || getHandledSections(classRow, classColumns)),
        primarySection,
      ]);
      if (sectionsHandled.length > 30) {
        throw new HttpError(400, "Sections handled must contain no more than 30 entries.");
      }
      if (suppliedLists.has("sectionsHandled")) {
        const { sheet: studentSheet, columns: studentColumns } = getStudentSheet(workbook);
        for (let rowNumber = 2; rowNumber <= studentSheet.rowCount; rowNumber += 1) {
          const studentRow = studentSheet.getRow(rowNumber);
          const studentSection = cellText(studentRow.getCell(studentColumns.section).value);
          if (cellText(studentRow.getCell(studentColumns.classId).value) === session.classId
            && (!cellText(studentRow.getCell(studentColumns.teacherUserId).value)
              || cellText(studentRow.getCell(studentColumns.teacherUserId).value) === session.userId)
            && studentSection
            && !sectionsHandled.some((section) => section.toLocaleLowerCase() === studentSection.toLocaleLowerCase())) {
            throw new HttpError(400, `Move students out of section "${studentSection}" before removing it from Sections handled.`);
          }
        }
      }
      const sectionGrades = readStoredSectionGrades(classRow.getCell(classColumns.sectionGrades).value);
      const sectionSubjects = readStoredSectionSubjects(
        classRow.getCell(classColumns.subjectsHandled).value,
        cellText(classRow.getCell(classColumns.section).value),
      );
      if (suppliedLists.has("sectionsHandled")) {
        const validSections = new Map(sectionsHandled.map((section) => [section.toLocaleLowerCase(), section]));
        for (const [key, entry] of sectionGrades) {
          const canonicalSection = validSections.get(key);
          if (!canonicalSection) {
            sectionGrades.delete(key);
          } else if (canonicalSection !== entry.section) {
            sectionGrades.set(key, { ...entry, section: canonicalSection });
          }
        }
        for (const [key, subjects] of Object.entries(sectionSubjects)) {
          const canonicalSection = validSections.get(key.toLocaleLowerCase());
          if (!canonicalSection) {
            delete sectionSubjects[key];
          } else if (canonicalSection !== key) {
            delete sectionSubjects[key];
            sectionSubjects[canonicalSection] = subjects;
          }
        }
      }
      if (suppliedLists.has("subjectsHandled")) {
        const sectionKey = Object.keys(sectionSubjects).find((key) =>
          key.toLocaleLowerCase() === primarySection.toLocaleLowerCase());
        sectionSubjects[sectionKey || primarySection] = suppliedLists.get("subjectsHandled");
      }
      const sectionGrade = suppliedProfileFields.has("grade")
        ? suppliedProfileFields.get("grade")
        : cellText(classRow.getCell(classColumns.grade).value);
      if (primarySection && sectionGrade && !sectionGrades.has(primarySection.toLocaleLowerCase())) {
        sectionGrades.set(primarySection.toLocaleLowerCase(), { section: primarySection, grade: sectionGrade });
      }
      userRow.getCell(userColumns.name).value = name;
      userRow.getCell(userColumns.email).value = email;
      classRow.getCell(classColumns.classroom).value = classroomNumber;
      classRow.getCell(classColumns.teacherName).value = name;
      for (const [key, value] of suppliedProfileFields) {
        classRow.getCell(classColumns[key]).value = value || null;
      }
      classRow.getCell(classColumns.sectionsHandled).value = JSON.stringify(sectionsHandled);
      classRow.getCell(classColumns.sectionGrades).value = JSON.stringify(serializeSectionGrades(sectionGrades));
      classRow.getCell(classColumns.subjectsHandled).value = JSON.stringify(sectionSubjects);
      await saveDatabaseWorkbook(workbook);
      const activeSession = sessions.get(session.sessionId);
      if (activeSession) activeSession.name = name;
      const grade = cellText(classRow.getCell(classColumns.grade).value);
      const strand = cellText(classRow.getCell(classColumns.strand).value);
      return {
        name,
        email,
        classroomNumber,
        grade,
        strand,
        section: cellText(classRow.getCell(classColumns.section).value),
        sectionsHandled,
        sectionGrades: serializeSectionGrades(sectionGrades),
        sectionSubjects,
        subjectsHandled: getSubjectsForSection(sectionSubjects, primarySection)
          .filter((subject) => teacherSubjectsForGrade(grade, strand).includes(subject)),
        availableSubjects: teacherSubjectsForGrade(grade, strand),
        gradeSubjects: gradeSubjectsForGrade(grade, strand).map(([key, label]) => ({ key, label })),
        generalAverageSubjects: generalAverageSubjectsForGrade(grade, strand),
        eClassSubjects: eClassSubjectsForGrade(grade, strand),
        schoolYear: cellText(classRow.getCell(classColumns.schoolYear).value),
        schoolName: cellText(classRow.getCell(classColumns.schoolName).value),
        schoolId: cellText(classRow.getCell(classColumns.schoolId).value),
        region: cellText(classRow.getCell(classColumns.region).value),
        division: cellText(classRow.getCell(classColumns.division).value),
        district: cellText(classRow.getCell(classColumns.district).value),
        position: cellText(classRow.getCell(classColumns.position).value),
        schoolHead: cellText(classRow.getCell(classColumns.schoolHead).value),
        schoolHeadPosition: cellText(classRow.getCell(classColumns.schoolHeadPosition).value),
      };
    });
  }

  async function updateTeacherProfileSubjects(session, data) {
    if (!data || typeof data !== "object" || typeof data.section !== "string"
      || !Array.isArray(data.subjectsHandled)
      || data.subjectsHandled.some((subject) => typeof subject !== "string")) {
      throw new HttpError(400, "Choose a section and select subjects from the available list.");
    }
    const section = data.section.trim();
    const subjectsHandled = uniqueTextList(data.subjectsHandled);
    if (subjectsHandled.length > 30 || subjectsHandled.some((subject) => subject.length > 100)) {
      throw new HttpError(400, "Subjects handled must contain no more than 30 entries of 100 characters each.");
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getClassSheet(workbook);
      const classRow = findTeacherClassRow(sheet, columns, session);
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      const strand = cellText(classRow.getCell(columns.strand).value);
      const availableSubjects = teacherSubjectsForGrade(
        cellText(classRow.getCell(columns.grade).value),
        strand,
      );
      if (subjectsHandled.some((subject) => !availableSubjects.includes(subject))) {
        throw new HttpError(400, "Choose subjects available for this grade level.");
      }

      const sectionsHandled = getHandledSections(classRow, columns);
      const matchedSection = sectionsHandled.find((handledSection) =>
        handledSection.toLocaleLowerCase() === section.toLocaleLowerCase());
      if (!matchedSection) throw new HttpError(400, "Choose a section handled by this classroom.");

      const advisorySection = cellText(classRow.getCell(columns.section).value);
      const sectionSubjects = readStoredSectionSubjects(
        classRow.getCell(columns.subjectsHandled).value,
        advisorySection,
      );
      const existingKey = Object.keys(sectionSubjects).find((storedSection) =>
        storedSection.toLocaleLowerCase() === matchedSection.toLocaleLowerCase());
      sectionSubjects[existingKey || matchedSection] = subjectsHandled;
      classRow.getCell(columns.subjectsHandled).value = JSON.stringify(sectionSubjects);
      await saveDatabaseWorkbook(workbook);
      return { section: matchedSection, subjectsHandled, sectionSubjects };
    });
  }

  async function getTeacherProfileSubjects(session) {
    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getClassSheet(workbook);
      const classRow = findTeacherClassRow(sheet, columns, session);
      if (!classRow) throw new HttpError(404, "The teacher's classroom could not be found.");
      const advisorySection = cellText(classRow.getCell(columns.section).value);
      const grade = cellText(classRow.getCell(columns.grade).value);
      const strand = cellText(classRow.getCell(columns.strand).value);
      const availableSubjects = teacherSubjectsForGrade(grade, strand);
      const sectionSubjects = readStoredSectionSubjects(
        classRow.getCell(columns.subjectsHandled).value,
        advisorySection,
      );
      return {
        grade,
        strand,
        advisorySection,
        sectionsHandled: getHandledSections(classRow, columns),
        sectionSubjects: Object.fromEntries(Object.entries(sectionSubjects).map(([section, subjects]) => [
          section,
          subjects.filter((subject) => availableSubjects.includes(subject)),
        ])),
        availableSubjects,
        gradeSubjects: gradeSubjectsForGrade(grade, strand).map(([key, label]) => ({ key, label })),
        generalAverageSubjects: generalAverageSubjectsForGrade(grade, strand),
        eClassSubjects: eClassSubjectsForGrade(grade, strand),
      };
    });
  }

  async function updateTeacherPassword(session, data) {
    const currentPassword = typeof data.currentPassword === "string" ? data.currentPassword : "";
    const newPassword = typeof data.newPassword === "string" ? data.newPassword : "";
    if (currentPassword.length < 6 || currentPassword.length > 256) {
      throw new HttpError(400, "Enter your current password.");
    }
    if (newPassword.length < 6 || newPassword.length > 256) {
      throw new HttpError(400, "Use a new password between 6 and 256 characters.");
    }

    return serializeWorkbook(async () => {
      const workbook = await readDatabaseWorkbook();
      const { sheet, columns } = getUserSheet(workbook);
      let userRow = null;
      for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const row = sheet.getRow(rowNumber);
        if (cellText(row.getCell(columns.id).value) === session.userId) {
          userRow = row;
          break;
        }
      }
      if (!userRow || cellText(userRow.getCell(columns.role).value).toLowerCase() !== "teacher") {
        throw new HttpError(404, "The teacher profile could not be found.");
      }
      const isAdmin = cellText(userRow.getCell(columns.adminAccess).value).toLowerCase() === "true";
      if (isAdmin && newPassword.length < 12) {
        throw new HttpError(400, "Administrator passwords must be at least 12 characters.");
      }
      const matches = await verifyPassword(currentPassword, cellText(userRow.getCell(columns.password).value));
      if (!matches) throw new HttpError(400, "Your current password doesn't match.");
      userRow.getCell(columns.password).value = await (isAdmin
        ? hashAdminPassword(newPassword)
        : hashPassword(newPassword));
      userRow.getCell(columns.mustChangePassword).value = "false";
      setPasswordDocumentation(workbook, columns.password);
      await saveDatabaseWorkbook(workbook);
      return { saved: true };
    });
  }

  function teacherPhotoPath(userId, extension) {
    if (!/^T\d{3,}$/i.test(userId)) throw new HttpError(404, "The profile picture was not found.");
    return path.join(profilePhotoDirectory, `${userId}.${extension}`);
  }

  async function teacherPhotoExists(userId) {
    if (postgresPool && !dualStorage) {
      if (!/^T\d{3,}$/i.test(userId)) throw new HttpError(404, "The profile picture was not found.");
      await initializeDatabase();
      const result = await postgresPool.query(
        "SELECT 1 FROM portal_profile_photos WHERE user_id = $1",
        [userId],
      );
      return result.rows.length > 0;
    }
    for (const extension of ["jpg", "png", "webp"]) {
      try {
        const photo = await fs.stat(teacherPhotoPath(userId, extension));
        if (photo.isFile()) return true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  async function findTeacherPhoto(userId) {
    if (postgresPool && !dualStorage) {
      if (!/^T\d{3,}$/i.test(userId)) throw new HttpError(404, "The profile picture was not found.");
      await initializeDatabase();
      const result = await postgresPool.query(
        "SELECT photo_data FROM portal_profile_photos WHERE user_id = $1",
        [userId],
      );
      if (!result.rows.length) throw new HttpError(404, "No profile picture has been uploaded.");
      const buffer = result.rows[0].photo_data;
      return { buffer, ...getProfilePhotoFormat(buffer) };
    }
    for (const extension of ["jpg", "png", "webp"]) {
      const filePath = teacherPhotoPath(userId, extension);
      try {
        const buffer = await fs.readFile(filePath);
        return { filePath, buffer, ...getProfilePhotoFormat(buffer) };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new HttpError(404, "No profile picture has been uploaded.");
  }

  async function saveTeacherPhoto(session, request) {
    const photo = await readProfilePhoto(request);
    if (postgresPool && !dualStorage) {
      if (!/^T\d{3,}$/i.test(session.userId)) throw new HttpError(404, "The profile picture was not found.");
      await initializeDatabase();
      await postgresPool.query(
        `INSERT INTO portal_profile_photos (user_id, extension, photo_data, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id)
         DO UPDATE SET extension = EXCLUDED.extension,
                       photo_data = EXCLUDED.photo_data,
                       updated_at = now()`,
        [session.userId, photo.extension, photo.buffer],
      );
      return;
    }
    const filePath = teacherPhotoPath(session.userId, photo.extension);
    await fs.mkdir(profilePhotoDirectory, { recursive: true });
    await fs.writeFile(filePath, photo.buffer);
    for (const extension of ["jpg", "png", "webp"]) {
      if (extension === photo.extension) continue;
      try {
        await fs.unlink(teacherPhotoPath(session.userId, extension));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  async function removeTeacherPhoto(session) {
    if (postgresPool && !dualStorage) {
      if (!/^T\d{3,}$/i.test(session.userId)) throw new HttpError(404, "The profile picture was not found.");
      await initializeDatabase();
      await postgresPool.query(
        "DELETE FROM portal_profile_photos WHERE user_id = $1",
        [session.userId],
      );
      return;
    }
    for (const extension of ["jpg", "png", "webp"]) {
      try {
        await fs.unlink(teacherPhotoPath(session.userId, extension));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  function teacherSchoolLogoPath(userId, extension) {
    if (!/^T\d{3,}$/i.test(userId)) throw new HttpError(404, "The school logo was not found.");
    return path.join(schoolLogoDirectory, `${userId}.${extension}`);
  }

  async function teacherSchoolLogoExists(userId) {
    if (postgresPool && !dualStorage) {
      if (!/^T\d{3,}$/i.test(userId)) throw new HttpError(404, "The school logo was not found.");
      await initializeDatabase();
      const result = await postgresPool.query(
        "SELECT 1 FROM portal_school_logos WHERE user_id = $1",
        [userId],
      );
      return result.rows.length > 0;
    }
    for (const extension of ["jpg", "png", "webp"]) {
      try {
        const logo = await fs.stat(teacherSchoolLogoPath(userId, extension));
        if (logo.isFile()) return true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return false;
  }

  async function findTeacherSchoolLogo(userId) {
    if (postgresPool && !dualStorage) {
      if (!/^T\d{3,}$/i.test(userId)) throw new HttpError(404, "The school logo was not found.");
      await initializeDatabase();
      const result = await postgresPool.query(
        "SELECT logo_data FROM portal_school_logos WHERE user_id = $1",
        [userId],
      );
      if (!result.rows.length) throw new HttpError(404, "No school logo has been uploaded.");
      const buffer = result.rows[0].logo_data;
      return { buffer, ...getProfilePhotoFormat(buffer, "school logo") };
    }
    for (const extension of ["jpg", "png", "webp"]) {
      const filePath = teacherSchoolLogoPath(userId, extension);
      try {
        const buffer = await fs.readFile(filePath);
        return { buffer, ...getProfilePhotoFormat(buffer, "school logo") };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    throw new HttpError(404, "No school logo has been uploaded.");
  }

  async function saveTeacherSchoolLogo(session, request) {
    const logo = await readProfilePhoto(request, "school logo");
    if (postgresPool && !dualStorage) {
      if (!/^T\d{3,}$/i.test(session.userId)) throw new HttpError(404, "The school logo was not found.");
      await initializeDatabase();
      await postgresPool.query(
        `INSERT INTO portal_school_logos (user_id, extension, logo_data, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (user_id)
         DO UPDATE SET extension = EXCLUDED.extension,
                       logo_data = EXCLUDED.logo_data,
                       updated_at = now()`,
        [session.userId, logo.extension, logo.buffer],
      );
      return;
    }
    const filePath = teacherSchoolLogoPath(session.userId, logo.extension);
    await fs.mkdir(schoolLogoDirectory, { recursive: true });
    await fs.writeFile(filePath, logo.buffer);
    for (const extension of ["jpg", "png", "webp"]) {
      if (extension === logo.extension) continue;
      try {
        await fs.unlink(teacherSchoolLogoPath(session.userId, extension));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  async function removeTeacherSchoolLogo(session) {
    if (postgresPool && !dualStorage) {
      if (!/^T\d{3,}$/i.test(session.userId)) throw new HttpError(404, "The school logo was not found.");
      await initializeDatabase();
      await postgresPool.query(
        "DELETE FROM portal_school_logos WHERE user_id = $1",
        [session.userId],
      );
      return;
    }
    for (const extension of ["jpg", "png", "webp"]) {
      try {
        await fs.unlink(teacherSchoolLogoPath(session.userId, extension));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  const requestHandler = async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (options.apiOnly && !url.pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "Page not found." });
        return;
      }
      if (url.pathname.startsWith("/api/")) await ensureBootstrapAdmin();
      const currentSession = url.pathname.startsWith("/api/") ? getSession(request) : null;
      const allowedDuringPasswordChange = (request.method === "GET" && url.pathname === "/api/auth/session")
        || (request.method === "POST" && url.pathname === "/api/auth/logout")
        || (request.method === "PUT" && url.pathname === "/api/auth/change-password")
        || (request.method === "GET" && url.pathname === "/api/health")
        || (request.method === "GET" && url.pathname === "/api/preferences/appearance")
        || (request.method === "PUT" && url.pathname === "/api/preferences/appearance");
      if (currentSession?.mustChangePassword && !allowedDuringPasswordChange) {
        sendJson(response, 403, { error: "Change your temporary password before using the portal." });
        return;
      }
      const portalEntry = PORTAL_ENTRY_PATHS.get(url.pathname);
      if (request.method === "GET" && portalEntry) {
        const html = (await fs.readFile(INDEX_PATH, "utf8")).replace(
          'data-portal-entry="main"',
          `data-portal-entry="${portalEntry}"`,
        ).replace(
          /(<span class="sidebar-footer-version">GraceDesk · Version )[^<]*(<\/span>)/,
          `$1${APP_VERSION}$2`,
        );
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(html);
        return;
      }

      if (request.method === "GET" && url.pathname === "/icon.png") {
        const icon = await fs.readFile(path.join(__dirname, "icon.png"));
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": icon.length,
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(icon);
        return;
      }

      const sf10ImageAssets = {
        "/sf10-deped-seal.png": { filename: "sf10-deped-seal.png", contentType: "image/png" },
        "/sf10-deped-logo.gif": { filename: "sf10-deped-logo.gif", contentType: "image/gif" },
      };
      const sf10ImageAsset = sf10ImageAssets[url.pathname];
      if (request.method === "GET" && sf10ImageAsset) {
        const image = await fs.readFile(path.join(__dirname, sf10ImageAsset.filename));
        response.writeHead(200, {
          "Content-Type": sf10ImageAsset.contentType,
          "Content-Length": image.length,
          "Cache-Control": "public, max-age=86400",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(image);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        try {
          if (dualStorage) {
            await initializeDatabase();
            const localState = database.prepare(
              "SELECT 1 FROM portal_state WHERE id = 1",
            ).get();
            if (!localState) throw new Error("The SQLite portal database has no saved state.");
          } else {
            await serializeWorkbook(checkWorkbook);
          }
          sendJson(response, 200, {
            status: "ok",
            storage,
            ...(dualStorage ? { sync: readSyncStatus().state } : {}),
          });
        } catch (error) {
          const referenceId = crypto.randomUUID();
          await logPortalError(referenceId, error);
          sendJson(response, 503, {
            error: `The portal database is unavailable. Check the local server log and provide reference ${referenceId} to support.`,
            referenceId,
          });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/preferences/appearance") {
        sendJson(response, 200, { theme: await getAppearanceTheme() });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/preferences/appearance") {
        const { theme } = await readJson(request);
        if (!APPEARANCE_THEMES.has(theme)) {
          throw new HttpError(400, "Choose a supported appearance theme.");
        }
        await saveAppearanceTheme(theme);
        sendJson(response, 200, { theme });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/register") {
        const result = await register(await readJson(request));
        openSession(response, request, result.user);
        const { id, classId, ...user } = result.user;
        sendJson(response, 201, { user });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const data = await readJson(request);
        const ipAddress = getClientAddress(request);
        const reservation = authRateLimiter.reserveAttempt(ipAddress, data.email);
        if (reservation.retryAfterSeconds > 0) {
          response.setHeader("Retry-After", String(reservation.retryAfterSeconds));
          throw new HttpError(429, "Too many sign-in attempts. Wait before trying again.");
        }
        let result;
        try {
          result = await login(data);
        } catch (error) {
          if (error instanceof HttpError && error.status === 401) {
            throw error;
          }
          reservation.cancel();
          throw error;
        }
        reservation.cancel();
        authRateLimiter.clearAccount(data.email);
        openSession(response, request, result.user);
        const { id, classId, ...user } = result.user;
        sendJson(response, 200, { user });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/auth/session") {
        const session = getSession(request);
        if (!session) {
          sendJson(response, 401, { error: "Your session has expired. Sign in again." });
          return;
        }
        sendJson(response, 200, {
          user: {
            userId: session.adminUserId,
            name: session.name,
            role: session.role,
            classCode: session.classCode,
            isAdmin: session.isAdmin,
            mustChangePassword: session.mustChangePassword,
            activeClassId: session.classId,
          },
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const session = getSession(request);
        if (session) sessions.delete(session.sessionId);
        response.setHeader(
          "Set-Cookie",
          `${getSessionCookieName(request)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        );
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/auth/change-password") {
        const session = getSession(request);
        if (!session) throw new HttpError(401, "Your session has expired. Sign in again.");
        sendJson(response, 200, await changeOwnPassword(session, await readJson(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/parent/portal") {
        sendJson(response, 200, await getParentPortal(requireParentSession(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/classes") {
        requireAdminSession(request);
        sendJson(response, 200, await listAdminClasses());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sync") {
        requireTeacherSession(request);
        const status = await synchronizeNow();
        if (status.state === "conflict") {
          sendJson(response, 409, {
            error: "Local and online data changed independently. An administrator must review both copies.",
            state: status.state,
          });
          return;
        }
        sendJson(response, 200, status);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/sync/status") {
        requireAdminSession(request);
        sendJson(response, 200, readSyncStatus());
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/admin/sync/resolve") {
        requireAdminSession(request);
        const { resolution } = await readJson(request);
        if (resolution !== "local" && resolution !== "online") {
          throw new HttpError(400, "Choose a valid synchronization resolution.");
        }
        const result = await resolveDualSyncConflict(resolution);
        if (result.state === "conflict") {
          sendJson(response, 409, {
            error: "The online data changed again. Review the latest conflict before resolving it.",
            state: result.state,
          });
          return;
        }
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/admin/accounts") {
        requireAdminSession(request);
        sendJson(response, 200, await listAdminAccounts());
        return;
      }

      const adminAccountMatch = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)$/);
      const adminPasswordResetMatch = url.pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/password$/);
      if (request.method === "PUT" && adminPasswordResetMatch) {
        const session = requireAdminSession(request);
        sendJson(response, 200, await resetAdminAccountPassword(
          session,
          decodeURIComponent(adminPasswordResetMatch[1]),
        ));
        return;
      }
      if (request.method === "PUT" && adminAccountMatch) {
        const session = requireAdminSession(request);
        const data = await readJson(request);
        sendJson(response, 200, await setAdminAccountStatus(
          session,
          decodeURIComponent(adminAccountMatch[1]),
          data.status,
        ));
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/admin/active-class") {
        const session = requireAdminSession(request);
        const result = await setAdminActiveClass(session, (await readJson(request)).classId);
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/teacher/profile") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getTeacherProfile(session));
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/teacher/profile") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await updateTeacherProfile(session, await readJson(request)));
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/teacher/profile/subjects") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await updateTeacherProfileSubjects(session, await readJson(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/teacher/profile/subjects") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getTeacherProfileSubjects(session));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/teacher/sections") {
        const session = requireTeacherSession(request);
        sendJson(response, 201, await addTeacherSection(session, await readJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/teacher/sections/import") {
        const session = requireTeacherSession(request);
        const upload = await readSF1Upload(request);
        sendJson(response, 201, await addSectionFromSF1(
          session,
          upload,
          url.searchParams.get("sectionName") || "",
          url.searchParams.get("grade") || "",
        ));
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/teacher/profile/password") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await updateTeacherPassword(session, await readJson(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/teacher/profile/photo") {
        const session = requireTeacherSession(request);
        const photo = await findTeacherPhoto(session.userId);
        response.writeHead(200, {
          "Content-Type": photo.contentType,
          "Content-Length": photo.buffer.length,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(photo.buffer);
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/teacher/profile/photo") {
        const session = requireTeacherSession(request);
        await saveTeacherPhoto(session, request);
        sendJson(response, 200, { saved: true });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/teacher/profile/photo") {
        const session = requireTeacherSession(request);
        await removeTeacherPhoto(session);
        sendJson(response, 200, { removed: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/teacher/profile/school-logo") {
        const session = requireTeacherSession(request);
        const logo = await findTeacherSchoolLogo(session.userId);
        response.writeHead(200, {
          "Content-Type": logo.contentType,
          "Content-Length": logo.buffer.length,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(logo.buffer);
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/teacher/profile/school-logo") {
        const session = requireTeacherSession(request);
        await saveTeacherSchoolLogo(session, request);
        sendJson(response, 200, { saved: true });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/teacher/profile/school-logo") {
        const session = requireTeacherSession(request);
        await removeTeacherSchoolLogo(session);
        sendJson(response, 200, { removed: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/students") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await listStudents(session));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/inventory") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await listInventory(session));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/inventory") {
        const session = requireTeacherSession(request);
        sendJson(response, 201, await saveInventoryItem(session, await readJson(request)));
        return;
      }

      const inventoryMatch = url.pathname.match(/^\/api\/inventory\/([^/]+)$/);
      if (request.method === "PUT" && inventoryMatch) {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await saveInventoryItem(
          session,
          { ...(await readJson(request)), id: decodeURIComponent(inventoryMatch[1]) },
        ));
        return;
      }

      if (request.method === "DELETE" && inventoryMatch) {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await deleteInventoryItem(
          session,
          decodeURIComponent(inventoryMatch[1]),
        ));
        return;
      }

      const nutritionalStatusStudentMatch = url.pathname.match(/^\/api\/students\/([^/]+)\/nutritional-status$/);
      if (request.method === "PUT" && nutritionalStatusStudentMatch) {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await saveNutritionalStatusMeasurements(
          session,
          decodeURIComponent(nutritionalStatusStudentMatch[1]),
          await readJson(request),
        ));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/students/nutritional-status/sf8") {
        const session = requireTeacherSession(request);
        const { buffer, filename, filePath, incompleteMeasurementCount } =
          await exportNutritionalStatusSF8(
            session,
            url.searchParams.get("assessmentDate") || "",
            url.searchParams.get("section") || "__all__",
          );
        response.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Generated-File-Path": filePath,
          "X-Incomplete-Measurement-Count": String(incompleteMeasurementCount),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(buffer);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/students") {
        const session = requireTeacherSession(request);
        const student = await addStudent(session, await readJson(request));
        sendJson(response, 201, { student });
        return;
      }

      const studentParentMatch = url.pathname.match(/^\/api\/students\/([^/]+)\/parent$/);
      if (studentParentMatch && (request.method === "PUT" || request.method === "DELETE")) {
        const session = requireTeacherSession(request);
        const studentId = decodeURIComponent(studentParentMatch[1]);
        const result = request.method === "DELETE"
          ? await unlinkStudentParent(session, studentId)
          : await linkStudentParent(session, studentId, await readJson(request));
        sendJson(response, 200, result);
        return;
      }

      const studentDeleteMatch = url.pathname.match(/^\/api\/students\/([^/]+)$/);
      if (studentDeleteMatch && studentDeleteMatch[1] !== "clear" && request.method === "DELETE") {
        const session = requireTeacherSession(request);
        const data = await readJson(request);
        if (data.confirmed !== true) throw new HttpError(400, "Confirm that you want to delete this student.");
        sendJson(response, 200, await deleteStudent(session, decodeURIComponent(studentDeleteMatch[1]), data));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/students/clear/verify") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await verifyRosterClearPassword(session, await readJson(request)));
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/students/clear") {
        const session = requireTeacherSession(request);
        const data = await readJson(request);
        if (data.confirmed !== true) throw new HttpError(400, "Confirm that you want to clear the student roster.");
        sendJson(response, 200, await clearStudentRoster(session, data));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/students/import") {
        const session = requireTeacherSession(request);
        const upload = await readSF1Upload(request);
        const result = await importStudents(session, upload, url.searchParams.get("section") || "");
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/grades") {
        const session = requireTeacherSession(request);
        const result = await getStudentGrades(
          session,
          url.searchParams.get("studentId") || "",
          url.searchParams.get("term") || "",
        );
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/grades/lock") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getStudentGradeLock(
          session,
          url.searchParams.get("studentId") || "",
          url.searchParams.get("term") || "",
        ));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/grades/term-lock") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getClassTermGradeLock(
          session,
          url.searchParams.get("term") || "",
        ));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/grades/lock") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await setStudentGradeLock(session, await readJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/grades/term-lock") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await setClassTermGradeLock(session, await readJson(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/grades/summary") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getGradeSummary(session));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/e-class/record") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getEClassRecord(session, {
          term: url.searchParams.get("term") || "",
          subject: url.searchParams.get("subject") || "",
          mapehGroup: url.searchParams.get("mapehGroup") || "",
          section: url.searchParams.get("section") || "",
        }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/e-class/import") {
        requireTeacherSession(request);
        const buffer = await readSF1Upload(request);
        sendJson(response, 200, parseEClassWorkbook(buffer, {
          term: url.searchParams.get("term") || "",
          subject: url.searchParams.get("subject") || "",
          mapehGroup: url.searchParams.get("mapehGroup") || "",
        }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/assessment/mps/export") {
        requireTeacherSession(request);
        const data = await readJson(request, 1048576);
        const buffer = await createMpsTemplateWordDocument(data);
        const filenamePart = (value) => String(value || "").trim()
          .replace(/[^A-Za-z0-9-]+/g, "_")
          .replace(/^_+|_+$/g, "") || "Class";
        const filename = `MPS_${filenamePart(data.subject)}_${filenamePart(data.section)}_${new Date()
          .toISOString().slice(0, 10)}.docx`;
        response.writeHead(200, {
          "Content-Type": MPS_DOCUMENT_CONTENT_TYPE,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(buffer);
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/e-class/record") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await saveEClassRecord(session, await readJson(request, 1048576)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/e-class/record/unlock") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await unlockEClassRecord(session, await readJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/e-class/export") {
        const session = requireTeacherSession(request);
        const { buffer, filename } = await exportEClassRecord(session, await readJson(request));
        response.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(buffer);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/grades/summary/export") {
        const session = requireTeacherSession(request);
        const { buffer, filename } = await exportGradeSummary(
          session,
          url.searchParams.get("section") || "__all__",
        );
        response.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(buffer);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/grades/sf9") {
        const session = requireTeacherSession(request);
        const preview = url.searchParams.get("format") === "preview";
        let buffer;
        let filename;
        let previewHtml;
        if (url.searchParams.get("all") === "true") {
          if (!preview) throw new HttpError(400, "Class SF9 printing requires preview format.");
          const selection = url.searchParams.get("selection") || "All Without Attendance";
          if (!["All Without Attendance", "All with Attendance", "Term 1", "Term 2", "Term 3", "Attendance"].includes(selection)) {
            throw new HttpError(400, "Choose a valid SF9 print selection.");
          }
          const { students } = await listStudents(session);
          if (!students.length) throw new HttpError(400, "There are no students in this class to print.");
          const previews = [];
          for (const [index, student] of students.entries()) {
            const result = await exportStudentSF9(session, student.id, { preview: true });
            if (!result.previewHtml) {
              throw new Error(`SF9 preview generation failed for student ${index + 1} of ${students.length}.`);
            }
            previews.push(result.previewHtml);
          }
          if (previews.length !== students.length) {
            throw new Error(`Only ${previews.length} of ${students.length} SF9 previews were generated.`);
          }
          previewHtml = renderSF9PreviewBatch(previews, selection, {
            autoPrint: url.searchParams.get("pdf") !== "true",
          });
        } else {
          ({ buffer, filename, previewHtml } = await exportStudentSF9(
            session,
            url.searchParams.get("studentId") || "",
            { preview },
          ));
        }
        if (preview) {
          response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; connect-src 'self'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          });
          response.end(previewHtml);
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(buffer);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/grades") {
        const session = requireTeacherSession(request);
        const result = await saveStudentGrades(session, await readJson(request));
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/grades/subject") {
        const session = requireTeacherSession(request);
        const result = await saveStudentSubjectGrade(session, await readJson(request));
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/reading-assessments") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getReadingAssessmentSummary(
          session,
          url.searchParams.get("period") || "BOSY",
          url.searchParams.has("attemptNo") ? Number(url.searchParams.get("attemptNo")) : 1,
        ));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/reading-assessments") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await saveReadingAssessment(session, await readJson(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/phil-iri/settings") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getPhilIriSettings(session));
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/phil-iri/settings") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await savePhilIriSettings(session, await readJson(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/phil-iri/assessments") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getPhilIriAssessmentSummary(
          session,
          url.searchParams.get("period") || "BOSY",
          url.searchParams.get("assessmentType") || "Pretest",
          url.searchParams.get("scope") === "school",
        ));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/phil-iri/assessments") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await savePhilIriAssessment(session, await readJson(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/phil-iri/auto-scoring") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getPhilIriAutoScoring(
          session,
          url.searchParams.get("studentId") || "",
          url.searchParams.get("period") || "",
          url.searchParams.get("assessmentType") || "",
          url.searchParams.get("language") || "",
        ));
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/phil-iri/auto-scoring") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await savePhilIriAutoScoring(session, await readJson(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/phil-iri/export") {
        const session = requireTeacherSession(request);
        const { buffer, contentType, filename } = await exportPhilIriReport(
          session,
          url.searchParams.get("period") || "BOSY",
          url.searchParams.get("assessmentType") || "Pretest",
          url.searchParams.get("scope") || "class",
          url.searchParams.get("studentId") || "",
          url.searchParams.get("section") || "__all__",
        );
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(buffer);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/phil-iri/forms") {
        const session = requireTeacherSession(request);
        const { buffer, contentType, filename } = await exportPhilIriForm(
          session,
          url.searchParams.get("form") || "",
          url.searchParams.get("period") || "BOSY",
          url.searchParams.get("assessmentType") || "Pretest",
          url.searchParams.get("section") || "__all__",
        );
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(buffer);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/math-assessments") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getMathAssessmentSummary(session));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/math-assessments") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await saveMathAssessment(session, await readJson(request)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/math-assessments/export") {
        const session = requireTeacherSession(request);
        const { buffer, contentType, filename } = await exportMathAssessment(
          session,
          url.searchParams.get("period") || "BOSY",
          url.searchParams.get("format") || "xlsx",
          url.searchParams.get("section") || "__all__",
        );
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(buffer);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/attendance") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getAttendance(session, url.searchParams.get("date") || ""));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/attendance") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await saveAttendance(session, await readJson(request)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/assessment/tos/import") {
        requireAdminSession(request);
        const data = await readJson(request, 20 * 1024 * 1024);
        if (typeof data.fileName !== "string" || typeof data.contentBase64 !== "string") {
          throw new HttpError(400, "Provide a TOS filename and file content.");
        }
        const buffer = Buffer.from(data.contentBase64, "base64");
        if (!buffer.length) throw new HttpError(400, "The selected TOS file is empty.");
        const competencies = await extractTosCompetencies(buffer, data.fileName);
        sendJson(response, 200, { fileName: data.fileName, competencies });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/attendance/month/import") {
        const session = requireTeacherSession(request);
        const month = validateAttendanceMonth(url.searchParams.get("month") || "");
        const buffer = await readSF2Upload(request);
        sendJson(response, 200, await importAttendanceSF2(session, month, buffer));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/attendance/month/export") {
        const session = requireTeacherSession(request);
        const { buffer, filename } = await exportAttendanceSF2(
          session,
          url.searchParams.get("month") || "",
          url.searchParams.get("section") || "__all__",
        );
        response.writeHead(200, {
          "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(buffer);
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/attendance/month") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getAttendanceMonth(session, url.searchParams.get("month") || ""));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/attendance/summary") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await getAttendanceSummary(session));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/attendance/month") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await saveAttendanceMonth(session, await readJson(request, 2 * 1024 * 1024)));
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/attendance/month") {
        const session = requireTeacherSession(request);
        sendJson(response, 200, await clearAttendanceMonth(session, url.searchParams.get("month") || ""));
        return;
      }

      sendJson(response, 404, { error: "Page not found." });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      const referenceId = crypto.randomUUID();
      await logPortalError(referenceId, error);
      sendJson(response, 500, {
        error: `The portal request could not be completed. Check the local server log and provide reference ${referenceId} to support.`,
        referenceId,
      });
    }
  };
  const server = tlsKeyPath
    ? https.createServer({
      key: fileSystem.readFileSync(tlsKeyPath),
      cert: fileSystem.readFileSync(tlsCertPath),
    }, requestHandler)
    : http.createServer(requestHandler);
  const syncRetryInterval = dualStorage
    ? setInterval(scheduleDualSync, options.syncRetryIntervalMs || 15000)
    : null;
  syncRetryInterval?.unref?.();
  server.on("close", () => {
    serverClosing = true;
    if (syncTimer) clearTimeout(syncTimer);
    if (syncRetryInterval) clearInterval(syncRetryInterval);
    const closeResources = () => {
      database?.close();
      if (postgresPool) {
        postgresPool.end().catch((error) => {
          console.error("Could not close the Supabase database connection pool:", error);
        });
      }
    };
    if (syncTask) syncTask.then(closeResources, closeResources);
    else closeResources();
  });
  return server;
}

if (require.main === module) {
  const configuredPort = process.env.PORT ? Number(process.env.PORT) : 3003;
  const host = process.env.HOST || "127.0.0.1";
  const maxPort = process.env.PORT ? configuredPort : configuredPort + 20;

  const isLoopbackHost = ["127.0.0.1", "localhost", "::1"].includes(host);
  const tlsKeyPath = process.env.PORTAL_TLS_KEY;
  const tlsCertPath = process.env.PORTAL_TLS_CERT;
  const behindTlsProxy = process.env.PORTAL_TRUST_PROXY === "true";
  if (!isLoopbackHost && (!tlsKeyPath || !tlsCertPath) && !behindTlsProxy) {
    console.error("Refusing insecure public binding. Set PORTAL_TLS_KEY and PORTAL_TLS_CERT, bind to localhost, or set PORTAL_TRUST_PROXY=true behind a TLS-terminating proxy.");
    process.exitCode = 1;
  }

  function listen(port) {
    if (process.exitCode) return;
    const apiOnly = process.argv.includes("--api");
    const server = createServer({
      tlsKeyPath,
      tlsCertPath,
      apiOnly,
      bootstrapAdminEmail: process.env.ADMIN_EMAIL || "",
      bootstrapAdminPassword: process.env.ADMIN_PASSWORD || "",
    });
    server.once("error", (error) => {
      if (!process.env.PORT && error.code === "EADDRINUSE" && port < maxPort) {
        console.warn(`Port ${port} is already in use; trying ${port + 1}.`);
        listen(port + 1);
        return;
      }
      console.error(`Could not start the portal on ${host}:${port}:`, error.message);
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      if (process.env.PORTAL_STORAGE_MODE === "dual" && process.env.SUPABASE_DB_URL) {
        console.log("Using dual SQLite and Supabase PostgreSQL storage.");
      } else if (process.env.SUPABASE_DB_URL) {
        console.log("Using Supabase PostgreSQL backend.");
      } else {
        console.log(`Using SQLite backend: ${path.resolve(DATABASE_PATH)}`);
      }
      console.log(`${apiOnly ? "Shared API backend" : "Class Adviser's Portal"} is running at ${tlsKeyPath ? "https" : "http"}://${host}:${port}`);
    });
  }

  listen(configuredPort);
}

module.exports = {
  createServer,
  eClassGradingMethod,
  computeEClassTermGrade,
  readPortalDatabaseWorkbook,
  writePortalDatabaseWorkbook,
};
