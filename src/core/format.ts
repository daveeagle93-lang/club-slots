/** Whole pence as a display price: 0 is "Free", otherwise "£1,234.50". */
export function formatPounds(pence: number): string {
  if (!Number.isInteger(pence) || pence < 0) {
    throw new RangeError(`pence must be a non-negative integer, got ${pence}`);
  }
  if (pence === 0) return "Free";
  const pounds = Math.floor(pence / 100).toLocaleString("en-GB");
  return `£${pounds}.${String(pence % 100).padStart(2, "0")}`;
}
