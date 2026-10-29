/** A problem with the file itself; the message names lines and counts, never cell values. */
export class CsvError extends Error {}

export const MAX_COLUMNS = 200;
export const MAX_ROWS = 50_000;

export interface ParsedCsv {
  delimiter: string;
  columns: string[];
  rows: string[][];
}

/** The delimiter of the header line: the most frequent of `,`, `;` and tab outside quotes. */
function detectDelimiter(text: string): string {
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && counts.has(ch)) counts.set(ch, counts.get(ch)! + 1);
  }
  const [best, n] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
  return n > 0 ? best : ",";
}

/** RFC 4180 with the usual spreadsheet variations: `;` or tab, CRLF or LF, a BOM, line breaks in quoted cells. */
export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, "");
  if (text.trim() === "") throw new CsvError("пустой файл");
  const delimiter = detectDelimiter(text);
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      records.push(Object.assign(row, { line: recordLine }));
      row = [];
      cell = "";
      line++;
      recordLine = line;
    } else cell += ch;
  }
  if (quoted) throw new CsvError(`строка ${recordLine}: незакрытая кавычка`);
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    records.push(Object.assign(row, { line: recordLine }));
  }
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0] === ""));
  const [header, ...body] = nonEmpty as (string[] & { line: number })[];
  if (!header) throw new CsvError("пустой файл");
  if (header.length > MAX_COLUMNS) throw new CsvError(`больше ${MAX_COLUMNS} колонок`);
  if (body.length > MAX_ROWS) throw new CsvError(`больше ${MAX_ROWS} строк`);
  const columns = header.map((c) => c.trim());
  const rows = body.map((r) => {
    if (r.length > columns.length) throw new CsvError(`строка ${r.line}: ${r.length} значения при ${columns.length} колонках`);
    return [...r, ...Array<string>(columns.length - r.length).fill("")];
  });
  return { delimiter, columns, rows };
}

const escape = (value: string, delimiter: string) => (value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** CSV for spreadsheets: a BOM so Excel reads UTF-8, CRLF between records. */
export const toCsv = (delimiter: string, records: string[][]) => "\uFEFF" + records.map((r) => r.map((v) => escape(v, delimiter)).join(delimiter) + "\r\n").join("");

/** Lines as ls-clicker writes and reads them: comma, LF, no BOM (its parser keeps a BOM in the first name). */
export const toEngineCsv = (records: string[][]) => records.map((r) => r.map((v) => escape(v, ",")).join(",") + "\n").join("");
