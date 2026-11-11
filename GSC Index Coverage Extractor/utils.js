/**
 * Shared utility functions for the GSC Coverage Extractor extension.
 */

/**
 * Convert a GSC property URL to a filesystem-friendly name.
 * @param {string} property - GSC property URL (e.g., "sc-domain:example.com" or "https://example.com/")
 * @returns {{ file: string, short: string }} file-safe name and short label
 */
function friendlySiteName(property) {
  let name;

  if (property.startsWith('sc-domain:')) {
    // Domain property: prefix with DOM_ to match CLI output
    name = 'DOM_' + property.replace(/^sc-domain:/, '');
  } else {
    name = property
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '');
  }

  name = name.replace(/[^a-zA-Z0-9.-]/g, '_');

  const short = name.length > 22 ? name.substring(0, 22) : name;

  return { file: name, short };
}

/**
 * Get current date in DD-MM-YYYY format.
 * @returns {string} Current date
 */
function currentDate() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/**
 * Convert an array of objects to CSV string.
 * @param {Array<Object>} data - Array of objects with consistent keys
 * @returns {string} CSV formatted string
 */
function jsonToCsv(data) {
  if (!data || data.length === 0) return '';

  const headers = Object.keys(data[0]);
  const csvRows = [headers.join(',')];

  for (const row of data) {
    const values = headers.map(header => {
      const val = row[header] ?? '';
      const escaped = String(val).replace(/"/g, '""');
      return `"${escaped}"`;
    });
    csvRows.push(values.join(','));
  }

  return csvRows.join('\n');
}
