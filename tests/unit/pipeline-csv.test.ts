import { describe, expect, test } from "vitest";
import { CsvError, parseCsv, toCsv } from "@bap/csv";

// Made-up rows only: the real table holds the owner's employees' data and is never seen here.
describe("CSV import", () => {
  test("[REQ-UI-012] commas, quotes, doubled quotes and line breaks inside a cell", () => {
    const csv = 'name,note\r\nalpha,"one, two"\r\nbeta,"say ""hi""\nsecond line"\r\n';
    expect(parseCsv(csv)).toEqual({ delimiter: ",", columns: ["name", "note"], rows: [["alpha", "one, two"], ["beta", 'say "hi"\nsecond line']] });
  });

  test("[REQ-UI-012] semicolons and tabs are recognised from the header; a BOM is dropped; blank lines are skipped", () => {
    expect(parseCsv("﻿a;b\n1;2\n\n3;4\n")).toEqual({ delimiter: ";", columns: ["a", "b"], rows: [["1", "2"], ["3", "4"]] });
    expect(parseCsv("a\tb\n1\t2")).toEqual({ delimiter: "\t", columns: ["a", "b"], rows: [["1", "2"]] });
  });

  test("[REQ-UI-012] a short row is padded; a long row is an error naming the line, never its values", () => {
    expect(parseCsv("a,b,c\n1\n").rows).toEqual([["1", "", ""]]);
    const bad = () => parseCsv("a,b\n1,2\nsecret-value,2,3\n");
    expect(bad).toThrow(CsvError);
    expect(bad).toThrow("строка 3: 3 значения при 2 колонках");
    try {
      bad();
    } catch (e) {
      expect(String(e)).not.toContain("secret-value");
    }
  });

  test("[REQ-UI-012] an empty file, an unclosed quote and too many columns are refused", () => {
    expect(() => parseCsv("")).toThrow("пустой файл");
    expect(() => parseCsv('a,b\n"1,2\n')).toThrow("незакрытая кавычка");
    expect(() => parseCsv(Array.from({ length: 201 }, (_, i) => `c${i}`).join(","))).toThrow("больше 200 колонок");
  });

  test("[REQ-UI-012] writing back escapes what needs it and keeps the delimiter", () => {
    expect(toCsv(";", [["a", "b;c"], ['x"y', "line\nbreak"]])).toBe('﻿a;"b;c"\r\n"x""y";"line\nbreak"\r\n');
    const csv = 'name,note\nalpha,"one, two"\n';
    const parsed = parseCsv(csv);
    expect(parseCsv(toCsv(parsed.delimiter, [parsed.columns, ...parsed.rows]))).toEqual(parsed);
  });
});
