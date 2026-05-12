import { Command } from 'commander';
import { mkdir, copyFile, access } from 'fs/promises';
import { join, basename } from 'path';
import { homedir } from 'os';
import { LensRegistry, validateLens } from '../../lenses/registry.js';

const CUSTOM_LENS_DIR = join(homedir(), '.agentreview', 'lenses');

export function createLensesCommand(): Command {
  const lensesCmd = new Command('lenses').description('Manage review lenses');

  lensesCmd
    .command('list')
    .description('List all available lenses (built-in and custom)')
    .action(async () => {
      const registry = new LensRegistry();
      await registry.loadCustomLenses(CUSTOM_LENS_DIR);

      const allLenses = registry.getAllLenses();

      console.log('\n📋 Available Lenses\n');
      console.log('Built-in:');

      const builtin = registry.getBuiltinLenses();
      for (const lens of builtin) {
        const severityLabel = lens.severity ? ` [${lens.severity}]` : '';
        console.log(`  • ${lens.id}${severityLabel} — ${lens.description}`);
      }

      const custom = allLenses.filter((l) => !builtin.find((b) => b.id === l.id));
      if (custom.length > 0) {
        console.log('\nCustom:');
        for (const lens of custom) {
          console.log(`  • ${lens.id} — ${lens.description}`);
        }
      } else {
        console.log('\nCustom: (none)');
        console.log(`  Add custom lenses to: ${CUSTOM_LENS_DIR}`);
        console.log(`  Or run: agentreview lenses add ./my-lens.json`);
      }

      console.log('');
    });

  lensesCmd
    .command('add <path>')
    .description('Add a custom lens from a JSON file')
    .action(async (lensPath: string) => {
      try {
        // Validate the lens by loading it through registry
        const registry = new LensRegistry();

        // Load as custom lens to validate schema
        const { readFile } = await import('fs/promises');
        const raw = await readFile(lensPath, 'utf-8');
        const data = JSON.parse(raw);

        // Validate using the shared lens validator (same rules as registry loading)
        validateLens(data, lensPath); // throws on invalid

        // Check for ID conflicts with built-ins
        const builtins = registry.getBuiltinLenses();
        if (builtins.find((b) => b.id === data.id)) {
          console.error(`❌ Lens ID "${data.id}" conflicts with a built-in lens. Choose a different ID.`);
          process.exit(1);
        }

        // Ensure directory exists
        await mkdir(CUSTOM_LENS_DIR, { recursive: true });

        const destPath = join(CUSTOM_LENS_DIR, basename(lensPath.endsWith('.json') ? lensPath : `${lensPath}.json`));

        // Check for existing file
        try {
          await access(destPath);
          console.log(`⚠️  Updating existing lens at: ${destPath}`);
        } catch {
          // File doesn't exist, that's fine
        }

        await copyFile(lensPath, destPath);

        console.log(`✅ Lens "${data.id}" (${data.name}) added successfully.`);
        console.log(`   Saved to: ${destPath}`);
        console.log(`   Run: agentreview <pr-url> --lens ${data.id}`);
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') {
          console.error(`❌ File not found: ${lensPath}`);
        } else if (err instanceof SyntaxError) {
          console.error(`❌ Invalid JSON in lens file: ${err.message}`);
        } else {
          console.error(`❌ ${(err as Error).message}`);
        }
        process.exit(1);
      }
    });

  return lensesCmd;
}
