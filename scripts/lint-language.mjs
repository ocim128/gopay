#!/usr/bin/env node
// =============================================================================
// English-only language lint gate (Requirement 16)
// -----------------------------------------------------------------------------
// Statically scans source files (string literals, comments, and JSX/Svelte
// text) for Indonesian-language content. The System must keep all user-facing
// output (Panel UI text, REST error messages), log messages, source code
// identifiers, and comments in English only (Req 16.1 - 16.4).
//
// Usage:
//   node scripts/lint-language.mjs            # scan default roots (src, panel/src)
//   node scripts/lint-language.mjs path ...   # scan explicit files/directories
//
// Exit codes:
//   0  -> no Indonesian-language content found (clean)
//   1  -> one or more flagged occurrences (file:line:col reported to stderr)
//
// Maintaining the wordlist:
//   The INDONESIAN_WORDS list below holds common Indonesian stopwords plus
//   payment-domain terms. Keep entries lowercase, >= 3 characters, and clearly
//   Indonesian so they do not collide with legitimate English/technical terms.
//   Words are matched as whole words (\b...\b), case-insensitive, so they will
//   not match substrings inside English identifiers (e.g. "dan" will not match
//   "standard" or "danger"). Add a trailing `// lint-lang-allow` comment to a
//   line to intentionally exclude it from the scan.
// =============================================================================

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Default roots to scan when no explicit paths are provided on the CLI.
const DEFAULT_ROOTS = ['src', 'panel/src'];

// File extensions that may contain human-readable text worth checking.
const SCANNED_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.svelte',
  '.vue',
  '.html',
  '.htm',
]);

// Directories that never contain first-party source text.
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.svelte-kit',
]);

// Opt-out marker: any line containing this token is skipped by the scan.
const ALLOW_MARKER = 'lint-lang-allow';

// -----------------------------------------------------------------------------
// Curated Indonesian wordlist.
// Common stopwords / connectors plus payment-domain vocabulary. Each entry is
// clearly Indonesian and unlikely to appear as a standalone English word.
// -----------------------------------------------------------------------------
const INDONESIAN_WORDS = [
  // Connectors and common stopwords
  'dan', 'yang', 'tidak', 'dengan', 'untuk', 'adalah', 'ini', 'itu', 'atau',
  'pada', 'dari', 'akan', 'sudah', 'belum', 'harus', 'bisa', 'tanpa', 'juga',
  'karena', 'agar', 'supaya', 'sehingga', 'namun', 'tetapi', 'hanya', 'saja',
  'lebih', 'kurang', 'sangat', 'sekali', 'masih', 'telah', 'sedang', 'bukan',
  'jika', 'kalau', 'ketika', 'saat', 'setelah', 'sebelum', 'antara', 'setiap',
  'semua', 'beberapa', 'banyak', 'sedikit', 'dalam', 'oleh', 'kepada',
  'terhadap', 'secara', 'melalui', 'sebuah', 'ialah', 'yaitu', 'yakni',
  'tersebut', 'kita', 'kami', 'saya', 'anda', 'mereka', 'dia',

  // Payment / system domain vocabulary
  'pembayaran', 'bayar', 'dibayar', 'tagihan', 'transaksi', 'saldo', 'nominal',
  'jumlah', 'gagal', 'berhasil', 'sukses', 'kadaluarsa', 'kedaluwarsa',
  'kesalahan', 'galat', 'pesan', 'peringatan', 'pengaturan', 'setelan',
  'riwayat', 'daftar', 'hapus', 'ubah', 'tambah', 'simpan', 'batal', 'batalkan',
  'kirim', 'terkirim', 'terima', 'tunggu', 'selesai', 'pengguna', 'sandi',
  'masuk', 'keluar', 'rekening', 'jaringan', 'wajib', 'kosong', 'salah',
  'tertunda', 'menunggu', 'lunas', 'kembali', 'lanjut', 'tutup', 'buka',
];

// Whole-word, case-insensitive matcher built once from the curated list.
const WORD_PATTERN = new RegExp(`\\b(?:${INDONESIAN_WORDS.join('|')})\\b`, 'gi');

/**
 * Recursively collect scannable files from a starting path (file or directory).
 * @param {string} target absolute path to a file or directory
 * @param {string[]} out accumulator for matched file paths
 */
async function collectFiles(target, out) {
  const stats = await stat(target);
  if (stats.isDirectory()) {
    const base = path.basename(target);
    if (IGNORED_DIRECTORIES.has(base)) return;
    const entries = await readdir(target);
    for (const entry of entries) {
      await collectFiles(path.join(target, entry), out);
    }
    return;
  }
  if (stats.isFile() && SCANNED_EXTENSIONS.has(path.extname(target))) {
    out.push(target);
  }
}

/**
 * Scan a single file and return any flagged occurrences.
 * @param {string} filePath absolute path
 * @returns {Promise<Array<{file: string, line: number, column: number, word: string, snippet: string}>>}
 */
async function scanFile(filePath) {
  const content = await readFile(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const findings = [];

  lines.forEach((line, index) => {
    if (line.includes(ALLOW_MARKER)) return;
    WORD_PATTERN.lastIndex = 0;
    let match;
    while ((match = WORD_PATTERN.exec(line)) !== null) {
      findings.push({
        file: path.relative(PROJECT_ROOT, filePath),
        line: index + 1,
        column: match.index + 1,
        word: match[0],
        snippet: line.trim().slice(0, 160),
      });
    }
  });

  return findings;
}

async function main() {
  const cliArgs = process.argv.slice(2);
  const requestedRoots = cliArgs.length > 0 ? cliArgs : DEFAULT_ROOTS;

  const resolvedRoots = requestedRoots
    .map((root) => path.resolve(PROJECT_ROOT, root))
    .filter((root) => {
      const present = existsSync(root);
      if (!present) {
        console.log(`lint:lang — skipping missing path: ${path.relative(PROJECT_ROOT, root)}`);
      }
      return present;
    });

  if (resolvedRoots.length === 0) {
    console.log('lint:lang — no source paths to scan; nothing to do.');
    process.exit(0);
  }

  const files = [];
  for (const root of resolvedRoots) {
    await collectFiles(root, files);
  }

  const allFindings = [];
  for (const file of files) {
    const findings = await scanFile(file);
    allFindings.push(...findings);
  }

  if (allFindings.length === 0) {
    console.log(`lint:lang — scanned ${files.length} file(s); no Indonesian-language content found.`);
    process.exit(0);
  }

  console.error(`lint:lang — found ${allFindings.length} Indonesian-language occurrence(s):\n`);
  for (const finding of allFindings) {
    console.error(
      `  ${finding.file}:${finding.line}:${finding.column}  ` +
        `flagged word "${finding.word}"\n    ${finding.snippet}`,
    );
  }
  console.error(
    '\nAll user-facing text, log messages, identifiers, and comments must be in English (Requirement 16).',
  );
  console.error(
    `If a flagged word is a legitimate false positive, add a "${ALLOW_MARKER}" comment to that line.`,
  );
  process.exit(1);
}

main().catch((error) => {
  console.error('lint:lang — unexpected error while scanning:', error);
  process.exit(1);
});
