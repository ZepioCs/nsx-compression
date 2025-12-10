# NSX - High-Performance Compression Tool

A fast, parallel compression tool built with Bun. NSX uses streaming compression with Brotli to achieve excellent compression ratios while maximizing CPU utilization.

## Features

- **Streaming Pipeline** - Overlaps reading and compression for maximum throughput
- **Parallel Processing** - Uses all available CPU cores for compression/decompression
- **Large File Support** - Automatically chunks files >500MB for memory efficiency
- **Cross-Platform** - Works on Windows, Linux, and macOS

## Installation

### Pre-built Binaries

Download from [Releases](../../releases) for your platform.

### Build from Source

```bash
# Install Bun (https://bun.sh)
curl -fsSL https://bun.sh/install | bash

# Clone and build
git clone <repo>
cd compression
bun install
bun run build
```

## Usage

### Compress Files/Folders

```bash
nsx compress folder/ -o archive.nsx
nsx compress file1.txt file2.txt -o archive.nsx
```

### Decompress Archive

```bash
nsx decompress archive.nsx -o ./extracted
```

### List Archive Contents

```bash
nsx list archive.nsx
```

### Benchmark Compression

```bash
nsx benchmark folder/
```

## Options

```
Compression Options:
  -l, --level <1-11>      Compression level (default: 6)
  --fast, -1              Fast compression (level 1)
  --default, -6           Balanced compression (level 6)
  --best, -9              Best compression (level 9)
  --ultra, -11            Maximum compression (level 11, slow!)
  -a, --algorithm <name>  Force algorithm (brotli, gzip, store)

General Options:
  -o, --output <path>     Output file or directory
  -v, --verbose           Verbose output
  -h, --help              Show help message
```

## Compression Levels

| Level | Speed     | Compression | Use Case              |
| ----- | --------- | ----------- | --------------------- |
| 1-3   | Fast      | Lower       | Quick backups         |
| 4-6   | Balanced  | Good        | General use (default) |
| 7-9   | Slow      | Better      | Archiving             |
| 10-11 | Very Slow | Best        | Maximum compression   |

## Architecture

NSX uses a streaming pipeline architecture:

1. **File Scanner** - Recursively finds files, sorts by type for better compression
2. **Parallel Reader** - Reads files with multiple I/O workers
3. **Block Compressor** - Compresses 32MB blocks in parallel
4. **Stream Writer** - Writes compressed blocks directly to disk

### Large File Handling

Files larger than 500MB are automatically split into 64MB chunks:

- Prevents memory exhaustion
- Enables parallel compression of large files
- Chunks are transparently reassembled during decompression

### Algorithms

- **Brotli** (default) - Best compression ratio, good speed
- **Gzip** - Fast compression, wide compatibility
- **Store** - No compression, fastest

## Performance

Typical performance on modern hardware (24-core CPU, NVMe SSD):

| Data Size | Compress | Decompress |
| --------- | -------- | ---------- |
| 100 MB    | ~1s      | ~0.5s      |
| 1 GB      | ~10s     | ~5s        |
| 10 GB     | ~100s    | ~50s       |

Performance scales with CPU cores and storage speed.

## File Format

NSX archives (`.nsx`) use a custom binary format:

- 24-byte header with magic number and metadata
- Compressed data blocks (32MB uncompressed each)
- Block index for random access
- File index with paths, sizes, and timestamps

## Build Scripts

```bash
bun run build           # Build for current platform
bun run build:windows   # Build Windows executable
bun run build:linux     # Build Linux executable
bun run build:macos     # Build macOS executable
bun run build:all       # Build all platforms
```

## Project Structure

```
src/
  algorithms/    # Compression algorithms (Brotli, Gzip, etc.)
  analyzer/      # File type detection
  benchmark/     # Benchmark utilities
  cli/           # Command-line interface
  container/     # Archive format implementation
  utils/         # Buffer, I/O, and parallel utilities
```

## License

MIT License - see [LICENSE](LICENSE) file for details.

Copyright (c) 2025 ZepioCs
