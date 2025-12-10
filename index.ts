import { CliParser } from "./src/cli/parser";
import { Commands } from "./src/cli/commands";

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
      await commands.benchmark(options);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}

main();
