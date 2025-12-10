export interface CliOptions {
  command: "compress" | "decompress" | "list" | "benchmark";
  input: string[];
  output?: string;
  algorithm?: string;
  level?: number;
  verbose?: boolean;
  solid?: boolean;
}

export class CliParser {
  static parse(args: string[]): CliOptions {
    const options: CliOptions = {
      command: "compress",
      input: [],
      verbose: false,
      solid: true,
      level: 6,
    };

    if (args.length === 0) {
      throw new Error(
        "No command specified. Use: compress, decompress, list, or benchmark"
      );
    }

    const command = args[0];
    if (!["compress", "decompress", "list", "benchmark"].includes(command!)) {
      throw new Error(
        `Unknown command: ${command}. Use: compress, decompress, list, or benchmark`
      );
    }
    options.command = command as CliOptions["command"];

    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-o" || arg === "--output") {
        if (i + 1 >= args.length) {
          throw new Error(`Option ${arg} requires a value`);
        }
        options.output = args[++i];
      } else if (arg === "-a" || arg === "--algorithm") {
        if (i + 1 >= args.length) {
          throw new Error(`Option ${arg} requires a value`);
        }
        options.algorithm = args[++i];
      } else if (arg === "-l" || arg === "--level") {
        if (i + 1 >= args.length) {
          throw new Error(`Option ${arg} requires a value`);
        }
        options.level = parseInt(args[++i]!, 10);
        if (isNaN(options.level) || options.level < 1 || options.level > 11) {
          throw new Error(
            `Invalid compression level: ${args[i]}. Must be 1-11.`
          );
        }
      } else if (arg === "--fast" || arg === "-1") {
        options.level = 1;
      } else if (arg === "--default" || arg === "-6") {
        options.level = 6;
      } else if (arg === "--best" || arg === "-9") {
        options.level = 9;
      } else if (arg === "--ultra" || arg === "-11") {
        options.level = 11;
      } else if (arg === "-v" || arg === "--verbose") {
        options.verbose = true;
      } else if (arg === "-s" || arg === "--solid") {
        options.solid = true;
      } else if (arg === "--no-solid") {
        options.solid = false;
      } else if (arg === "-h" || arg === "--help") {
        this.printHelp();
        process.exit(0);
      } else if (!arg?.startsWith("-")) {
        options.input.push(arg!);
      }
    }

    if (options.input.length === 0 && options.command !== "benchmark") {
      throw new Error("No input files specified");
    }

    return options;
  }

  static printHelp(): void {
    console.log(`
Advanced Compression System (CMP Format)

Usage:
  compress <files...> [options]
  decompress <archive> [options]
  list <archive>
  benchmark <files...> [options]

Commands:
  compress    Compress files into an archive
  decompress  Extract files from an archive
  list        List files in an archive
  benchmark   Compare compression with other formats

Compression Options:
  -l, --level <1-11>      Compression level (default: 6)
  --fast, -1              Fast compression (level 1)
  --default, -6           Balanced compression (level 6)
  --best, -9              Best compression (level 9)
  --ultra, -11            Maximum compression (level 11, slow!)
  -s, --solid             Use solid compression (default, best ratio)
  --no-solid              Per-file compression (faster random access)
  -a, --algorithm <name>  Force algorithm (brotli, gzip, store)

General Options:
  -o, --output <path>     Output file or directory
  -v, --verbose           Verbose output
  -h, --help              Show this help message

Examples:
  compress folder/ -o archive.cmp              Default compression (level 6, solid)
  compress folder/ --fast -o archive.cmp       Fast compression
  compress folder/ --best -o archive.cmp       Best compression
  compress folder/ --ultra -o archive.cmp      Maximum compression (very slow)
  compress folder/ -l 9 --no-solid -o out.cmp  Level 9, per-file compression
  decompress archive.cmp -o ./extracted        Extract archive
  list archive.cmp                             List archive contents

Compression Levels:
  1-3   Fast (quick compression, larger files)
  4-6   Balanced (good speed and compression)
  7-9   Best (slower but smaller files)
  10-11 Ultra (very slow, maximum compression)
`);
  }
}
