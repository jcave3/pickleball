// Tiny CSV helper shared by any page that offers a data export. Quoting
// follows the common CSV convention: wrap in quotes and double up internal
// quotes whenever a value contains a comma, quote, or newline.

function toCsvValue(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function rowsToCsv(headers, rows) {
  const lines = [headers.map(toCsvValue).join(',')];
  rows.forEach((row) => lines.push(row.map(toCsvValue).join(',')));
  return lines.join('\r\n');
}

function downloadCsv(filename, csvString) {
  const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
