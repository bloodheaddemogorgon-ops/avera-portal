"use strict";

const path = require("node:path");
const XLSX = require("@e965/xlsx");

const REFERENCE_DIRECTORY = path.join(__dirname, "data", "who-growth-reference-2007");
const DAYS_PER_MONTH = 365.25 / 12;
const MIN_AGE_MONTHS = 61;
const MAX_AGE_MONTHS = 228;

function loadLmsReference(fileName) {
  const workbook = XLSX.readFile(path.join(REFERENCE_DIRECTORY, fileName));
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error(`The WHO reference workbook "${fileName}" has no worksheet.`);
  const [header, ...rows] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true });
  const columns = new Map(header.map((value, index) => [String(value).trim().toLowerCase(), index]));
  for (const name of ["month", "l", "m", "s"]) {
    if (!columns.has(name)) throw new Error(`The WHO reference workbook "${fileName}" is missing ${name}.`);
  }
  const table = new Map();
  for (const row of rows) {
    const month = Number(row[columns.get("month")]);
    const l = Number(row[columns.get("l")]);
    const m = Number(row[columns.get("m")]);
    const s = Number(row[columns.get("s")]);
    if (!Number.isInteger(month) || !Number.isFinite(l) || !Number.isFinite(m)
      || !Number.isFinite(s) || m <= 0 || s <= 0) {
      throw new Error(`The WHO reference workbook "${fileName}" contains an invalid LMS row.`);
    }
    table.set(month, { l, m, s });
  }
  for (let month = MIN_AGE_MONTHS; month <= MAX_AGE_MONTHS; month += 1) {
    if (!table.has(month)) {
      throw new Error(`The WHO reference workbook "${fileName}" is missing age month ${month}.`);
    }
  }
  return table;
}

const BMI_REFERENCES = {
  Male: loadLmsReference("bmi-boys-z-who-2007-exp.xlsx"),
  Female: loadLmsReference("bmi-girls-z-who-2007-exp.xlsx"),
};
const HEIGHT_REFERENCES = {
  Male: loadLmsReference("hfa-boys-z-who-2007-exp.xlsx"),
  Female: loadLmsReference("hfa-girls-z-who-2007-exp.xlsx"),
};

function parseDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
    ? date
    : null;
}

function calculateAgeMonths(birthdate, measurementDate) {
  const birth = parseDate(birthdate);
  const measured = parseDate(measurementDate);
  if (!birth || !measured || measured < birth) return null;
  return (measured.getTime() - birth.getTime()) / 86_400_000 / DAYS_PER_MONTH;
}

function getInterpolatedLms(table, ageMonths) {
  if (!Number.isFinite(ageMonths) || ageMonths < MIN_AGE_MONTHS || ageMonths > MAX_AGE_MONTHS) {
    return null;
  }
  const lowerMonth = Math.floor(ageMonths);
  const upperMonth = Math.ceil(ageMonths);
  const lower = table.get(lowerMonth);
  const upper = table.get(upperMonth);
  if (!lower || !upper) {
    throw new Error(`The WHO reference is missing age month ${lowerMonth} or ${upperMonth}.`);
  }
  const fraction = ageMonths - lowerMonth;
  return {
    l: lower.l + (upper.l - lower.l) * fraction,
    m: lower.m + (upper.m - lower.m) * fraction,
    s: lower.s + (upper.s - lower.s) * fraction,
  };
}

function calculateLmsZScore(bmi, lms) {
  if (!Number.isFinite(bmi) || bmi <= 0 || !lms) return null;
  const { l, m, s } = lms;
  if (!Number.isFinite(l) || !Number.isFinite(m) || m <= 0 || !Number.isFinite(s) || s <= 0) {
    return null;
  }
  const logRatio = Math.log(bmi / m);
  const baz = Math.abs(l) < 1e-12
    ? logRatio / s
    : Math.expm1(l * logRatio) / (l * s);
  return Number.isFinite(baz) ? baz : null;
}

function classifyBmiForAge(baz) {
  if (!Number.isFinite(baz)) return "Not available";
  if (baz < -3) return "Severely Wasted";
  if (baz < -2) return "Wasted";
  if (baz <= 1) return "Normal";
  if (baz <= 2) return "Overweight";
  return "Obese";
}

function classifyHeightForAge(haz) {
  if (!Number.isFinite(haz)) return "Not available";
  if (haz < -3) return "Severely Stunted";
  if (haz < -2) return "Stunted";
  if (haz <= 3) return "Normal";
  return "Tall";
}

function calculateBmiForAge({ birthdate, gender, measurementDate, weightKg, heightM }) {
  const ageMonths = calculateAgeMonths(birthdate, measurementDate);
  const bmi = Number.isFinite(weightKg) && weightKg > 0
    && Number.isFinite(heightM) && heightM > 0
    ? weightKg / heightM ** 2
    : null;
  const reference = BMI_REFERENCES[gender];
  const lms = reference && ageMonths !== null
    ? getInterpolatedLms(reference, ageMonths)
    : null;
  const baz = calculateLmsZScore(bmi, lms);
  const heightReference = HEIGHT_REFERENCES[gender];
  const heightLms = heightReference && ageMonths !== null
    ? getInterpolatedLms(heightReference, ageMonths)
    : null;
  const haz = calculateLmsZScore(
    Number.isFinite(heightM) && heightM > 0 ? heightM * 100 : null,
    heightLms,
  );
  return {
    ageMonths,
    baz: Number.isFinite(baz) ? Math.round(baz * 100) / 100 : null,
    bmiCategory: classifyBmiForAge(baz),
    haz: Number.isFinite(haz) ? Math.round(haz * 100) / 100 : null,
    heightForAgeStatus: classifyHeightForAge(haz),
  };
}

module.exports = {
  calculateAgeMonths,
  calculateBmiForAge,
  calculateLmsZScore,
  classifyBmiForAge,
  classifyHeightForAge,
  getInterpolatedLms,
};
