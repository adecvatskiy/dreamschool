/**
 * Google Apps Script:
 * Trigger GitHub Actions when a "preview" cell is filled/updated.
 *
 * Setup:
 * 1) Put this code into Apps Script bound to your Google Sheet.
 * 2) In Project Settings -> Script Properties, add:
 *    GITHUB_OWNER, GITHUB_REPO, GITHUB_PAT
 * 3) Create installable trigger for onEdit.
 */

const SHEET_NAME = ""; // Optional: set specific sheet name, or keep empty for any sheet.
const PREVIEW_HEADER = "preview";
const DISPATCH_EVENT = "preview_updated";

function onEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  if (SHEET_NAME && sheet.getName() !== SHEET_NAME) return;
  if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;

  const row = e.range.getRow();
  if (row < 2) return; // skip header

  const col = e.range.getColumn();
  const header = String(sheet.getRange(1, col).getDisplayValue() || "").trim().toLowerCase();
  if (header !== PREVIEW_HEADER) return;

  const newValue = String(e.value || "").trim();
  if (!newValue) return; // ignore clearing/empty values

  // Optional anti-duplicate guard for same row/value.
  const props = PropertiesService.getScriptProperties();
  const dedupeKey = `preview:${sheet.getSheetId()}:${row}`;
  const prevValue = String(props.getProperty(dedupeKey) || "");
  if (prevValue === newValue) return;
  props.setProperty(dedupeKey, newValue);

  dispatchGithubWorkflow_({
    sheet: sheet.getName(),
    row: row,
    header: header
  });
}

function dispatchGithubWorkflow_(payload) {
  const props = PropertiesService.getScriptProperties();
  const owner = mustGetProp_(props, "GITHUB_OWNER");
  const repo = mustGetProp_(props, "GITHUB_REPO");
  const pat = mustGetProp_(props, "GITHUB_PAT");

  const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`;
  const body = {
    event_type: DISPATCH_EVENT,
    client_payload: payload
  };

  const response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: "application/vnd.github+json"
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error(`GitHub dispatch failed (${status}): ${response.getContentText()}`);
  }
}

function mustGetProp_(props, name) {
  const value = String(props.getProperty(name) || "").trim();
  if (!value) throw new Error(`Missing Script Property: ${name}`);
  return value;
}
