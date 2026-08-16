export function csvCell(value: unknown) {
  if (value == null) return "";
  let text = typeof value === "string" ? value : String(value);
  // Prevent spreadsheet software from interpreting exported customer strings as formulas.
  if (/^[\t\r\n ]*[=+\-@]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>) {
  return [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n");
}
