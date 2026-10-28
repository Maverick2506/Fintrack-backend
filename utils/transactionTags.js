// Tags and notes on a transaction (F11). Tags are short labels ("work", "trip-2026"), kept lowercase
// so "Work" and "work" are one tag; a leading "#" is dropped. Notes are free text.

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 30;
const MAX_NOTES_LENGTH = 1000;

/** One tag as stored: trimmed, no leading "#", inner spaces collapsed, lowercase. "" when nothing is left. */
const normalizeTag = (tag) =>
  String(tag ?? "")
    .trim()
    .replace(/^#+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** A tag list as stored: normalized, no blanks or repeats, in the order given. null when empty. */
const normalizeTags = (tags) => {
  if (!Array.isArray(tags)) return null;
  const seen = new Set();
  for (const t of tags) {
    const tag = normalizeTag(t);
    if (tag) seen.add(tag);
  }
  return seen.size > 0 ? [...seen] : null;
};

/** Notes as stored: trimmed, null when blank */
const normalizeNotes = (notes) => {
  if (notes === null || notes === undefined) return null;
  const text = String(notes).trim();
  return text ? text : null;
};

/** A row's tags as an array. SQLite raw queries hand back the JSON column as text. */
const tagsOf = (row) => {
  let tags = row?.tags;
  if (typeof tags === "string") {
    try {
      tags = JSON.parse(tags);
    } catch {
      return [];
    }
  }
  return Array.isArray(tags) ? tags : [];
};

/** Whether a row carries the tag (compared normalized) */
const hasTag = (row, tag) => {
  const wanted = normalizeTag(tag);
  return Boolean(wanted) && tagsOf(row).includes(wanted);
};

module.exports = {
  MAX_TAGS,
  MAX_TAG_LENGTH,
  MAX_NOTES_LENGTH,
  normalizeTag,
  normalizeTags,
  normalizeNotes,
  tagsOf,
  hasTag,
};
