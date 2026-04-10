"use strict";

const fs = require("fs");
const path = require("path");

const DENYLIST_PATH = process.env.SC_DENYLIST_PATH || path.join(__dirname, "../../data/denylist.json");

function _canonicalType(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/[_\s-]+/g, "");
  if (raw === "clienthash") return "clienthash";
  if (raw === "guestidhash") return "guestidhash";
  if (raw === "userid") return "userid";
  if (raw === "ip") return "ip";
  return raw;
}

function _ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function _normalizeEntry(entry) {
  const item = Object.assign({}, entry || {});
  item.type = _canonicalType(item.type);
  item.value = String(item.value || "").trim();
  item.reason = String(item.reason || "manual_block").trim();
  item.note = String(item.note || "").trim();
  item.createdAt = String(item.createdAt || new Date().toISOString()).trim();
  item.createdBy = String(item.createdBy || "admin").trim();
  return item;
}

function load() {
  try {
    if (!fs.existsSync(DENYLIST_PATH)) return [];
    const raw = JSON.parse(fs.readFileSync(DENYLIST_PATH, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.map(_normalizeEntry).filter((item) => item.type && item.value);
  } catch (_) {
    return [];
  }
}

function save(entries) {
  _ensureDir(DENYLIST_PATH);
  fs.writeFileSync(DENYLIST_PATH, JSON.stringify((entries || []).map(_normalizeEntry), null, 2) + "\n", "utf8");
}

function list() {
  return load();
}

function add(entry) {
  const item = _normalizeEntry(entry);
  if (!item.type || !item.value) {
    throw new Error("type and value are required");
  }
  const rows = load();
  const existing = rows.find((row) => row.type === item.type && row.value === item.value);
  if (existing) {
    existing.reason = item.reason;
    existing.note = item.note;
    existing.createdBy = item.createdBy;
    existing.createdAt = item.createdAt;
  } else {
    rows.push(item);
  }
  save(rows);
  return item;
}

function remove(type, value) {
  const t = _canonicalType(type);
  const v = String(value || "").trim();
  const rows = load();
  const next = rows.filter((row) => !(row.type === t && row.value === v));
  save(next);
  return { removed: rows.length !== next.length, type: t, value: v };
}

function match(ctx) {
  const context = Object.assign({}, ctx || {});
  const checks = [
    ["clienthash", String(context.clientHash || "").trim()],
    ["ip", String(context.ip || "").trim()],
    ["guestidhash", String(context.guestIdHash || "").trim()],
    ["userid", String(context.userId || "").trim()],
  ];
  const rows = load();
  for (const row of rows) {
    for (const [type, value] of checks) {
      if (row.type === type && value && row.value === value) {
        return row;
      }
    }
  }
  return null;
}

module.exports = {
  path: DENYLIST_PATH,
  list,
  add,
  remove,
  match,
};
