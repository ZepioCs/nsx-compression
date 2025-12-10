import { CliParser } from "./src/cli/parser";
import { Commands } from "./src/cli/commands";
import { BenchmarkRunner } from "./src/benchmark/runner";
import { FormatComparator } from "./src/benchmark/comparator";
import { BenchmarkReporter } from "./src/benchmark/reporter";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    CliParser.printHelp();
    process.exit(0);
  }

  try {
    const options = CliParser.parse(args);
    const commands = new Commands();

    if (options.command === "compress") {
      await commands.compress(options);
    } else if (options.command === "decompress") {
      await commands.decompress(options);
    } else if (options.command === "list") {
      await commands.list(options);
    } else if (options.command === "benchmark") {
      const runner = new BenchmarkRunner();
      const comparator = new FormatComparator();

      for (const filePath of options.input) {
        console.log(`\nBenchmarking: ${filePath}\n`);

        const algorithmResults = await runner.benchmarkAllAlgorithms(filePath);
        const formatComparisons = await comparator.compareAll(filePath);

        console.log(
          BenchmarkReporter.formatResults(algorithmResults, formatComparisons)
        );

        const bestResult = algorithmResults[0];
        if (bestResult) {
          console.log(
            BenchmarkReporter.generateComparisonTable(
              bestResult,
              formatComparisons
            )
          );
        }
      }
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

main();
