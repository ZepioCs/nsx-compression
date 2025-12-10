# Advanced Compression System

A high-performance lossless compression system that outperforms traditional formats like ZIP, RAR, and TAR through adaptive algorithm selection and hybrid compression techniques.

## Features

- **Multiple Compression Algorithms**: LZMA2, Brotli, Zstandard, and BWT (Burrows-Wheeler Transform)
- **Adaptive Selection**: Automatically chooses the best algorithm based on file type and content analysis
- **Custom Archive Format**: Efficient container format supporting multiple algorithms per archive
- **Comprehensive Benchmarking**: Compare compression performance with ZIP, 7Z, and TAR formats
- **Lossless Compression**: 100% data integrity guaranteed

## Installation

```bash
bun install
```

Note: Some compression libraries may require native bindings. If you encounter issues:
- For LZMA: You may need to use `node-lzma` or install native dependencies
- For Brotli: The `brotli` package should work, but `@hapi/brotli` is an alternative
- For Zstandard: You may need `node-zstd` or similar package

## Usage

### Compress Files

```bash
bun run index.ts compress file1.txt file2.txt -o archive.cmp
```

Options:
- `-o, --output <path>`: Output archive path (default: adds `.cmp` extension)
- `-a, --algorithm <name>`: Force specific algorithm (lzma2, brotli, zstd, bwt, auto)
- `-l, --level <number>`: Compression level (0-22, depends on algorithm)
- `-v, --verbose`: Show detailed output

### Decompress Archive

```bash
bun run index.ts decompress archive.cmp -o ./extracted
```

### List Archive Contents

```bash
bun run index.ts list archive.cmp
```

### Benchmark Compression

```bash
bun run index.ts benchmark file1.txt file2.txt
```

This will:
- Test all available algorithms
- Compare with ZIP, 7Z, and TAR formats
- Show compression ratios, speeds, and memory usage

## Architecture

The system consists of:

- **Container Format**: Custom binary format with header, file entries, and index
- **Compression Algorithms**: Pluggable algorithm interface supporting multiple methods
- **File Analyzer**: Content type detection, entropy analysis, and pattern recognition
- **Algorithm Selector**: Intelligent selection based on file characteristics
- **Benchmarking Suite**: Comprehensive comparison tools

## Algorithm Selection

The system automatically selects algorithms based on:

- **Text Files**: Brotli or BWT (high compressibility)
- **Executables/Binaries**: LZMA2 (excellent for structured data)
- **Media Files**: Zstandard or LZMA2 (depending on compressibility)
- **Archives**: LZMA2 (handles already-compressed data well)

## Performance Goals

- 10-30% better compression than ZIP
- 5-20% better compression than RAR
- Lossless compression (100% data integrity)
- Reasonable compression/decompression speeds

## Project Structure

```
src/
  container/     # Archive format implementation
  algorithms/   # Compression algorithms
  analyzer/     # File analysis and detection
  benchmark/    # Benchmarking tools
  cli/          # Command-line interface
  utils/        # Utility functions
```

## License

Private project
