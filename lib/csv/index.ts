/**
 * CSV export safety. A spreadsheet reads a cell that starts with `=`, `+`, `-`, `@`, a tab or
 * a carriage return as a formula, so a team, agent or listing name chosen by someone else
 * could run one when an admin opens the export (CSV formula injection). Prefixing `'` makes
 * the spreadsheet show the text as typed.
 *
 * Apply it to text cells only. Money cells are written by lib/money as plain decimals such as
 * `-0.500000` and must stay numeric. Commas, quotes and newlines are left alone: the CSV
 * writer (AG Grid) quotes every cell and doubles any quote inside it.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvSafe(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}
