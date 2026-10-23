import ExcelJS from 'exceljs';
import path from 'path';

/**
 * Fills the product quantity columns in a downloaded HCM stock template.
 *
 * The Bulk Stock Upload dialog hands out an .xlsx whose 'Stock Data' sheet has
 * one row per selected destination facility and one column per product. Its own
 * ReadMe sheet sets the rules:
 *
 *   - only the product quantity columns are editable
 *   - row 2 is hidden and holds product-variant IDs; it must not be touched
 *   - rows and columns must not be added, deleted or rearranged
 *   - quantities are whole numbers, 0 or greater
 *
 * So this reads the header row to find the columns by name rather than assuming
 * positions, and writes nothing but the quantity cells.
 */

const SHEET_NAME = 'Stock Data';
const HEADER_ROW = 1;
/** Row 2 is the hidden product-variant ID row, so facility rows start at 3. */
const FIRST_DATA_ROW = 3;

/** Header text carries a space - "SPAQ 1", not "SPAQ1". */
const SPAQ1_HEADER = 'SPAQ 1';
const SPAQ2_HEADER = 'SPAQ 2';
const TO_FACILITY_CODE_HEADER = 'To (Facility Code)';

export interface FillResult {
  filledPath: string;
  rowsFilled: number;
  spaq1Column: number;
  spaq2Column: number;
}

function columnIndexByHeader(
  sheet: ExcelJS.Worksheet,
  header: string,
): number {
  const headerRow = sheet.getRow(HEADER_ROW);
  let found = -1;

  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    // Trim on the way in: several strings in this app carry trailing spaces.
    if (String(cell.value ?? '').trim() === header) {
      found = columnNumber;
    }
  });

  if (found === -1) {
    const present = (headerRow.values as unknown[])
      .slice(1)
      .map((v) => String(v ?? '').trim());
    throw new Error(
      `Column ${JSON.stringify(header)} not found in '${SHEET_NAME}'. ` +
        `Headers present: ${JSON.stringify(present)}`,
    );
  }
  return found;
}

/**
 * Writes `spaq1` / `spaq2` into every facility row of `sourcePath` and saves the
 * result next to it. The original download is left untouched so a failed run
 * never corrupts it and the two can be compared.
 */
export async function fillStockTemplate(
  sourcePath: string,
  spaq1: number,
  spaq2: number,
  outPath?: string,
): Promise<FillResult> {
  if (!Number.isInteger(spaq1) || spaq1 < 0) {
    throw new Error(`spaq1 must be a whole number of 0 or greater, got ${spaq1}`);
  }
  if (!Number.isInteger(spaq2) || spaq2 < 0) {
    throw new Error(`spaq2 must be a whole number of 0 or greater, got ${spaq2}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sourcePath);

  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    const names = workbook.worksheets.map((w) => w.name);
    throw new Error(
      `Sheet ${JSON.stringify(SHEET_NAME)} not found. Sheets: ${JSON.stringify(names)}`,
    );
  }

  const spaq1Column = columnIndexByHeader(sheet, SPAQ1_HEADER);
  const spaq2Column = columnIndexByHeader(sheet, SPAQ2_HEADER);
  const facilityColumn = columnIndexByHeader(sheet, TO_FACILITY_CODE_HEADER);

  let rowsFilled = 0;
  for (let rowNumber = FIRST_DATA_ROW; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    // A real facility row always carries a destination facility code. Blank
    // trailing rows are skipped rather than filled with stray quantities.
    const facilityCode = String(row.getCell(facilityColumn).value ?? '').trim();
    if (facilityCode === '') continue;

    row.getCell(spaq1Column).value = spaq1;
    row.getCell(spaq2Column).value = spaq2;
    row.commit();
    rowsFilled++;
  }

  if (rowsFilled === 0) {
    throw new Error(
      'No facility rows found to fill - the downloaded template looks empty.',
    );
  }

  const filledPath =
    outPath ??
    path.join(path.dirname(sourcePath), 'Stock_Template_filled.xlsx');
  await workbook.xlsx.writeFile(filledPath);

  return { filledPath, rowsFilled, spaq1Column, spaq2Column };
}

/** Reads back the quantity cells, so a test can assert what was really written. */
export async function readStockQuantities(
  filePath: string,
): Promise<Array<{ row: number; spaq1: unknown; spaq2: unknown }>> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet ${SHEET_NAME} not found in ${filePath}`);

  const spaq1Column = columnIndexByHeader(sheet, SPAQ1_HEADER);
  const spaq2Column = columnIndexByHeader(sheet, SPAQ2_HEADER);
  const facilityColumn = columnIndexByHeader(sheet, TO_FACILITY_CODE_HEADER);

  const out: Array<{ row: number; spaq1: unknown; spaq2: unknown }> = [];
  for (let rowNumber = FIRST_DATA_ROW; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (String(row.getCell(facilityColumn).value ?? '').trim() === '') continue;
    out.push({
      row: rowNumber,
      spaq1: row.getCell(spaq1Column).value,
      spaq2: row.getCell(spaq2Column).value,
    });
  }
  return out;
}
