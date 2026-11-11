import { InputError } from './errors.js';

/**
 * Parses a small RFC 4180 subset: comma separator, optional double-quoted fields with "" escapes,
 * CRLF or LF line endings, optional UTF-8 BOM. Blank lines are skipped.
 */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let closedQuote = false;
  let line = 1;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
    closedQuote = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0].trim() === '')) {
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        if (ch === '\n') {
          line++;
        }
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (closedQuote || (fieldStarted && field.trim() !== '')) {
        throw new InputError(`CSV line ${line}: unexpected quote inside an unquoted field.`);
      }
      field = '';
      quoted = true;
      fieldStarted = true;
    } else if (ch === ',') {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') {
        i++;
      }
      endRow();
      line++;
    } else if (closedQuote) {
      if (ch !== ' ' && ch !== '\t') {
        throw new InputError(`CSV line ${line}: unexpected text after a closing quote.`);
      }
    } else {
      field += ch;
      fieldStarted = true;
    }
  }
  if (quoted) {
    throw new InputError('CSV: a quoted field is not closed.');
  }
  if (field !== '' || row.length > 0) {
    endRow();
  }
  return rows;
}
