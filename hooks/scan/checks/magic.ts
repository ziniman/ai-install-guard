// Recognising files by their first bytes rather than their names.

export type Magic = 'elf' | 'mach-o' | 'pe' | 'wasm' | 'zip' | 'gzip' | 'bzip2' | 'xz' | '7z' | 'rar' | 'zstd' | 'tar' | 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf'

export const EXECUTABLE: ReadonlySet<Magic> = new Set(['elf', 'mach-o', 'pe', 'wasm'])
export const ARCHIVE: ReadonlySet<Magic> = new Set(['zip', 'gzip', 'bzip2', 'xz', '7z', 'rar', 'zstd', 'tar'])
export const IMAGE_EXTENSIONS: Record<string, Magic> = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' }
export const NATIVE_EXTENSIONS = new Set(['so', 'dylib', 'dll', 'node', 'exe', 'o', 'a', 'pyc', 'pyo', 'class', 'jar', 'wasm'])
export const TEXT_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'zsh', 'rb', 'html', 'css', 'svg', 'xml', 'csv'])
export const ARCHIVE_EXTENSIONS = new Set(['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'tar', 'jar', 'whl', 'docx', 'xlsx', 'pptx', 'skill'])

export function magicOf(bytes: Uint8Array): Magic | undefined {
  const at = (offset: number, ...values: number[]): boolean => values.every((value, i) => bytes[offset + i] === value)
  if (at(0, 0x7f, 0x45, 0x4c, 0x46)) return 'elf'
  if (at(0, 0xfe, 0xed, 0xfa, 0xce) || at(0, 0xfe, 0xed, 0xfa, 0xcf) || at(0, 0xce, 0xfa, 0xed, 0xfe) || at(0, 0xcf, 0xfa, 0xed, 0xfe) || at(0, 0xca, 0xfe, 0xba, 0xbe)) return 'mach-o'
  if (at(0, 0x4d, 0x5a) && isPortableExecutable(bytes)) return 'pe'
  if (at(0, 0x00, 0x61, 0x73, 0x6d)) return 'wasm'
  if (at(0, 0x50, 0x4b, 0x03, 0x04) || at(0, 0x50, 0x4b, 0x05, 0x06)) return 'zip'
  if (at(0, 0x1f, 0x8b)) return 'gzip'
  if (at(0, 0x42, 0x5a, 0x68)) return 'bzip2'
  if (at(0, 0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return 'xz'
  if (at(0, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return '7z'
  if (at(0, 0x52, 0x61, 0x72, 0x21)) return 'rar'
  if (at(0, 0x28, 0xb5, 0x2f, 0xfd)) return 'zstd'
  if (at(257, 0x75, 0x73, 0x74, 0x61, 0x72)) return 'tar'
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'pdf'
  return undefined
}

/** An MZ header whose e_lfanew field points at a `PE\0\0` signature, not just text that starts with "MZ". */
function isPortableExecutable(bytes: Uint8Array): boolean {
  if (bytes.length < 0x40) return false
  const offset = ((bytes[0x3c] as number) | ((bytes[0x3d] as number) << 8) | ((bytes[0x3e] as number) << 16) | ((bytes[0x3f] as number) << 24)) >>> 0
  return offset + 4 <= bytes.length && bytes[offset] === 0x50 && bytes[offset + 1] === 0x45 && bytes[offset + 2] === 0 && bytes[offset + 3] === 0
}

