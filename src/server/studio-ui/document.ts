export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

// Runs before first paint so a saved theme never flashes the wrong colours.
const themeScript = String.raw`(function () {
  try {
    var t = localStorage.getItem('nativ-studio:theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked */ }
})();`;

// Opening of the document up to the style block; the CSS chunks follow it.
export const documentStart = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Nativ Studio</title>
<script>${themeScript}</script>
<style>
`;

export const styleEnd = '</style>\n';
