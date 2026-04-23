const SHEET_NAME = 'news';
const HEADER_ROW = 1;
const CALLBACK_RE = /^[A-Za-z_$][A-Za-z0-9_$\.]{0,100}$/;

const HF_MODEL_ID = 'csebuetnlp/mT5_multilingual_XLSum';
const HF_API_URL = 'https://router.huggingface.co/hf-inference/models/' + HF_MODEL_ID;
// Лучше хранить токен в Script Properties: HF_TOKEN
// Project Settings -> Script properties -> HF_TOKEN=hf_xxx

function doGet(e) {
  const callback = String((e && e.parameter && e.parameter.callback) || '').trim();
  const action = String((e && e.parameter && e.parameter.action) || '').trim();

  if (action === 'summarize') {
    const out = summarizeById_(e);
    return respond_(out, callback);
  }

  const data = getNewsData_();
  return respond_(data, callback);
}

function respond_(obj, callback) {
  const json = JSON.stringify(obj);

  if (callback && CALLBACK_RE.test(callback)) {
    return ContentService
      .createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

function summarizeById_(e) {
  const token = PropertiesService.getScriptProperties().getProperty('HF_TOKEN');
  if (!token) return { ok: false, error: 'HF_TOKEN не задан в Script Properties' };

  const id = Number((e && e.parameter && e.parameter.id) || -1);
  const mode = String((e && e.parameter && e.parameter.mode) || 'short').toLowerCase();
  const ratio = mode === 'detailed' ? 0.60 : 0.35;

  const news = getNewsData_();
  if (!Number.isInteger(id) || id < 0 || id >= news.length) {
    return { ok: false, error: 'Invalid id' };
  }

  const src = String(news[id].content || news[id].preview || news[id]['Текст'] || '');
  const plain = stripHtml_(src).replace(/\s+/g, ' ').trim();
  if (!plain) return { ok: false, error: 'Empty text' };

  const words = plain.split(/\s+/).filter(Boolean).length;
  const targetWords = Math.max(28, Math.round(words * ratio));
  const minWords = Math.max(18, Math.round(targetWords * 0.85));
  const maxWords = Math.max(minWords + 8, Math.round(targetWords * 1.15));
  const minTokens = Math.max(30, Math.round(minWords * 1.7));
  const maxTokens = Math.max(minTokens + 12, Math.round(maxWords * 1.7));

  const body = {
    inputs: 'Сделай пересказ только по исходному тексту. Не добавляй фактов, которых нет в тексте.\n\nТекст:\n' + plain,
    parameters: {
      min_length: minTokens,
      max_length: maxTokens,
      do_sample: false,
      temperature: 0.1,
      top_p: 0.85,
      no_repeat_ngram_size: 3
    },
    options: {
      wait_for_model: true,
      use_cache: false
    }
  };

  const resp = UrlFetchApp.fetch(HF_API_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const txt = resp.getContentText();
  if (code < 200 || code >= 300) return { ok: false, error: 'HF ' + code + ': ' + txt };

  let payload;
  try {
    payload = JSON.parse(txt);
  } catch (err) {
    return { ok: false, error: 'Bad HF JSON' };
  }

  let summary = '';
  if (Array.isArray(payload) && payload[0] && payload[0].summary_text) summary = payload[0].summary_text;
  else if (Array.isArray(payload) && payload[0] && payload[0].generated_text) summary = payload[0].generated_text;
  else if (payload && payload.summary_text) summary = payload.summary_text;
  else if (typeof payload === 'string') summary = payload;

  summary = String(summary || '').replace(/\s+/g, ' ').trim();
  if (!summary) return { ok: false, error: 'Empty summary' };

  return { ok: true, summary: trimWords_(summary, maxWords), mode: mode };
}

function getNewsData_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) return [];

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow <= HEADER_ROW || lastCol < 1) return [];

  const headerRaw = sh.getRange(HEADER_ROW, 1, 1, lastCol).getDisplayValues()[0];
  const header = headerRaw.map(mapHeader_);

  const rng = sh.getRange(HEADER_ROW + 1, 1, lastRow - HEADER_ROW, lastCol);
  const display = rng.getDisplayValues();
  const rich = rng.getRichTextValues();
  const styles = rng.getTextStyles();

  const out = [];

  for (let r = 0; r < display.length; r++) {
    if (display[r].join('').trim() === '') continue;

    const item = {};

    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;

      const txt = String(display[r][c] || '');

      if (key === 'title') {
        item.title = txt.trim();
        continue;
      }

      if (key === 'preview' || key === 'content') {
        item[key] = cellToHtml_(txt, rich[r][c], styles[r][c]);
        continue;
      }

      if (key === 'featured') {
        item.featured = /^(1|true|yes|да)$/i.test(txt.trim());
        continue;
      }

      item[key] = txt;
    }

    if (item.title) item['Заголовок'] = item.title;
    if (item.date) item['Дата'] = item.date;
    if (item.content) item['Текст'] = item.content;

    out.push(item);
  }

  return out;
}

function cellToHtml_(displayText, richValue, cellTextStyle) {
  const text = String(displayText || '');
  if (!text) return '';

  const runsHtml = richRunsToHtml_(richValue, text);
  if (runsHtml !== null) return runsHtml;

  const baseStyle = cellTextStyle || (richValue && richValue.getTextStyle && richValue.getTextStyle());
  const css = textStyleToCss_(baseStyle);
  const safe = textToHtmlPreserveLayout_(text);
  return css ? '<span style="' + css + '">' + safe + '</span>' : safe;
}

function richRunsToHtml_(richValue, fullText) {
  try {
    if (!richValue || !richValue.getRuns) return null;
    const runs = richValue.getRuns() || [];
    if (!runs.length) return null;

    if (runs.length === 1) {
      const one = runs[0];
      const css = textStyleToCss_(one.getTextStyle && one.getTextStyle());
      const link = getRunLink_(one);
      if (!css && !link) return null;
    }

    const text = String(fullText || '');
    let html = '';
    let cursor = 0;

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      const start = run.getStartIndex ? run.getStartIndex() : cursor;
      const end = run.getEndIndex
        ? run.getEndIndex()
        : start + String((run.getText && run.getText()) || '').length;

      if (start > cursor) html += textToHtmlPreserveLayout_(text.slice(cursor, start));

      const raw = text.slice(start, end);
      const css = textStyleToCss_(run.getTextStyle && run.getTextStyle());
      const link = getRunLink_(run);

      let chunk = css
        ? '<span style="' + css + '">' + textToHtmlPreserveLayout_(raw) + '</span>'
        : textToHtmlPreserveLayout_(raw);

      if (link) {
        chunk = '<a href="' + escapeHtml_(link) + '" rel="noopener noreferrer" target="_blank">' + chunk + '</a>';
      }

      html += chunk;
      cursor = end;
    }

    if (cursor < text.length) html += textToHtmlPreserveLayout_(text.slice(cursor));
    return html || null;
  } catch (err) {
    return null;
  }
}

function textStyleToCss_(style) {
  if (!style) return '';
  const css = [];

  try { if (style.isBold && style.isBold()) css.push('font-weight:700'); } catch (err) {}
  try { if (style.isItalic && style.isItalic()) css.push('font-style:italic'); } catch (err) {}
  try { if (style.isUnderline && style.isUnderline()) css.push('text-decoration:underline'); } catch (err) {}
  try {
    const size = style.getFontSize && style.getFontSize();
    if (size) css.push('font-size:' + Number(size) + 'px');
  } catch (err) {}

  return css.join(';');
}

function getRunLink_(run) {
  try {
    if (!run || !run.getLinkUrl) return '';
    const url = String(run.getLinkUrl() || '').trim();
    if (!url || /^javascript:/i.test(url)) return '';
    return url;
  } catch (err) {
    return '';
  }
}

function stripHtml_(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function trimWords_(text, maxWords) {
  const arr = String(text || '').split(/\s+/).filter(Boolean);
  if (arr.length <= maxWords) return arr.join(' ');
  return arr.slice(0, maxWords).join(' ') + '…';
}

function textToHtmlPreserveLayout_(s) {
  const text = String(s || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return text
    .split('\n')
    .map(function(line) {
      line = escapeHtml_(line);
      line = line.replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;');
      line = line.replace(/^ +/g, function(spaces) {
        return new Array(spaces.length + 1).join('&nbsp;');
      });
      while (line.indexOf('  ') !== -1) {
        line = line.replace(/  /g, ' &nbsp;');
      }
      return line;
    })
    .join('<br>');
}

function mapHeader_(h) {
  const x = String(h || '').trim().toLowerCase();

  if (x === 'заголовок' || x === 'title') return 'title';
  if (x === 'дата' || x === 'date') return 'date';
  if (x === 'превью' || x === 'preview' || x === 'анонс') return 'preview';
  if (x === 'текст' || x === 'content' || x === 'контент' || x === 'статья') return 'content';
  if (x === 'категория' || x === 'category') return 'category';
  if (x === 'изображение' || x === 'image' || x === 'photo' || x === 'cover') return 'image';
  if (x === 'featured' || x === 'главная' || x === 'важное') return 'featured';

  return '';
}

function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------
// Auto-dispatch to GitHub Actions when "preview" is edited.
// Repo is hardcoded: https://github.com/adecvatskiy/dreamschool
// Requires only one Script Property: GITHUB_PAT
// ---------------------------

const PREVIEW_DISPATCH_EVENT = 'preview_updated';
const PREVIEW_HEADER_NAME = 'preview';

function onEdit(e) {
  if (!e || !e.range) return;

  const sheet = e.range.getSheet();
  if (!sheet || sheet.getName() !== SHEET_NAME) return;
  if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;

  const row = e.range.getRow();
  if (row <= HEADER_ROW) return;

  const col = e.range.getColumn();
  const header = String(sheet.getRange(HEADER_ROW, col).getDisplayValue() || '').trim().toLowerCase();
  if (header !== PREVIEW_HEADER_NAME) return;

  const newValue = String(e.value || '').trim();
  if (!newValue) return;

  // Simple de-duplication by row+value.
  const props = PropertiesService.getScriptProperties();
  const dedupeKey = `preview:${sheet.getSheetId()}:${row}`;
  const prevValue = String(props.getProperty(dedupeKey) || '');
  if (prevValue === newValue) return;
  props.setProperty(dedupeKey, newValue);

  dispatchPreviewUpdated_({
    sheet: sheet.getName(),
    row: row,
    header: header
  });
}

function dispatchPreviewUpdated_(payload) {
  const pat = String(PropertiesService.getScriptProperties().getProperty('GITHUB_PAT') || '').trim();
  if (!pat) {
    throw new Error('Missing Script Property: GITHUB_PAT');
  }

  const response = UrlFetchApp.fetch(
    'https://api.github.com/repos/adecvatskiy/dreamschool/dispatches',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + pat,
        Accept: 'application/vnd.github+json'
      },
      payload: JSON.stringify({
        event_type: PREVIEW_DISPATCH_EVENT,
        client_payload: payload
      }),
      muteHttpExceptions: true
    }
  );

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('GitHub dispatch failed (' + code + '): ' + response.getContentText());
  }
}
