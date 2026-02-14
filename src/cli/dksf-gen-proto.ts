#!/usr/bin/env node

import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

const args = process.argv.slice(2);

function printUsage() {
    console.log(`
Usage: dksf-gen-proto <proto-file-or-dir> <output-dir> [options]

Generates TypeScript types from Protocol Buffer definitions using ts-proto.

Arguments:
  <proto-file-or-dir>  Path to a .proto file or directory containing .proto files
  <output-dir>         Directory where generated files will be written

Options:
  --only-types         Only generate type definitions (no encode/decode)
  --use-date           Use Date for google.protobuf.Timestamp (default: string)
  --use-map-type       Use ES6 Map for proto maps (default: plain object)

  -h, --help           Show this help message

Examples:
  dksf-gen-proto ./proto/service.proto ./src/generated
  dksf-gen-proto ./proto ./src/generated/proto
  dksf-gen-proto ./resources/proto/my-service.proto ./src/types
`);
}

if (args.includes('-h') || args.includes('--help') || args.length < 2) {
    printUsage();
    process.exit(args.length < 2 ? 1 : 0);
}

const inputPath = resolve(args[0]);
const outputDir = resolve(args[1]);

// Parse options
const onlyTypes = args.includes('--only-types');
const useDate = args.includes('--use-date');
const useMapType = args.includes('--use-map-type');

// Validate input path exists
if (!existsSync(inputPath)) {
    console.error(`Error: Input path does not exist: ${inputPath}`);
    process.exit(1);
}

// Collect proto files
const protoFiles: string[] = [];
let protoDir: string;
const stat = statSync(inputPath);

if (stat.isFile()) {
    if (!inputPath.endsWith('.proto')) {
        console.error(`Error: Input file must be a .proto file: ${inputPath}`);
        process.exit(1);
    }
    protoFiles.push(inputPath);
    protoDir = dirname(inputPath);
} else if (stat.isDirectory()) {
    const files = readdirSync(inputPath);
    for (const file of files) {
        if (file.endsWith('.proto')) {
            protoFiles.push(join(inputPath, file));
        }
    }
    if (protoFiles.length === 0) {
        console.log('No .proto files found in directory, nothing to generate.');
        process.exit(0);
    }
    protoDir = inputPath;
} else {
    console.error(`Error: Input path is neither a file nor directory: ${inputPath}`);
    process.exit(1);
}

// Create output directory if it doesn't exist
if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
}

// Find ts-proto plugin
function findTsProtoPlugin(): string {
    // Use require.resolve to find ts-proto, which works with workspaces and hoisting
    try {
        const tsProtoPath = require.resolve('ts-proto/package.json');
        const tsProtoDir = dirname(tsProtoPath);
        const pluginPath = join(tsProtoDir, 'protoc-gen-ts_proto');
        if (existsSync(pluginPath)) {
            return pluginPath;
        }
    } catch {
        // Fall through to error
    }

    console.error(`Error: ts-proto not found. Install it with:
  npm install --save-dev ts-proto
  # or
  yarn add -D ts-proto`);
    process.exit(1);
}

const tsProtoPlugin = findTsProtoPlugin();

// Build ts-proto options
const tsProtoOpts: string[] = [];

if (onlyTypes) {
    tsProtoOpts.push('onlyTypes=true');
}

// Use string for timestamps by default (cleaner for JSON APIs)
if (!useDate) {
    tsProtoOpts.push('useDate=false');
}

// Use plain objects for maps by default
if (!useMapType) {
    tsProtoOpts.push('useMapType=false');
}

// Additional sensible defaults
tsProtoOpts.push('esModuleInterop=true');
tsProtoOpts.push('outputServices=false');

const tsProtoOptString = tsProtoOpts.join(',');

console.log(`Generating TypeScript types from ${protoFiles.length} proto file(s)...`);

// Build protoc command
const protocArgs = [
    `--plugin=protoc-gen-ts_proto="${tsProtoPlugin}"`,
    `--ts_proto_out="${outputDir}"`,
    `--ts_proto_opt=${tsProtoOptString}`,
    `-I"${protoDir}"`,
    ...protoFiles.map(f => `"${f}"`)
];

const protocCmd = `npx protoc ${protocArgs.join(' ')}`;

try {
    execSync(protocCmd, {
        stdio: 'inherit',
        cwd: process.cwd()
    });
} catch {
    console.error('Error running protoc with ts-proto');
    process.exit(1);
}

// Get the base name for the output message
const baseName = stat.isFile() ? basename(inputPath, '.proto') : 'proto';

console.log(`
TypeScript types generated successfully!

Output directory: ${outputDir}

Usage with SrpcServer:
  import { ClientMessage, ServerMessage } from '${outputDir.replace(process.cwd(), '.')}/${baseName}';

  const server = new SrpcServer<SrpcMeta, ClientMessage, ServerMessage>({
      // ...
  });

Usage with SrpcClient:
  import { ClientMessage, ServerMessage } from '${outputDir.replace(process.cwd(), '.')}/${baseName}';

  const client = new SrpcClient<ClientMessage, ServerMessage>(
      // ...
  );
`);
