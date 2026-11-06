// Decodes a CDP Page.captureScreenshot JSON response file into a PNG.
import fs from 'fs';
const [input, output] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(input, 'utf8'));
const data = raw.data ?? raw.result?.data;
fs.writeFileSync(output, Buffer.from(data, 'base64'));
console.log(output);
