#!/usr/bin/env node
import { Command } from 'commander';
import { Coordinator } from './coordinator';
import { CandidateFinding } from './types';

// Importing agents
import { LogicAgent } from './agents/LogicAgent.js';
import { SecurityAgent } from './agents/SecurityAgent.js';
import { GenericAgent } from './agents/GenericAgent.js';

const program = new Command();

program
  .name('gsr')
  .description('Gemini Subagent Reviewer (GSR) - A multi-agent concurrent code reviewer')
  .version('1.0.0');

program
  .command('review')
  .description('Run a distributed code review on your current git diff')
  .action(async () => {
    try {
      const coordinator = new Coordinator();
      
      // Register our default bespoke subagents
      coordinator.registerAgent(new LogicAgent());
      coordinator.registerAgent(new SecurityAgent());

      // Register the remaining 8 purely prompt-driven Generic Subagents
      coordinator.registerAgent(new GenericAgent('Secrets', 'secrets.toml'));
      coordinator.registerAgent(new GenericAgent('Dependencies', 'dependencies.toml'));
      coordinator.registerAgent(new GenericAgent('Performance', 'performance.toml'));
      coordinator.registerAgent(new GenericAgent('Testing', 'testing.toml'));
      coordinator.registerAgent(new GenericAgent('Architecture', 'architecture.toml'));
      coordinator.registerAgent(new GenericAgent('CICD', 'cicd.toml'));
      coordinator.registerAgent(new GenericAgent('TechDebt', 'techdebt.toml'));
      coordinator.registerAgent(new GenericAgent('PromptSecurity', 'promptsecurity.toml'));

      console.log('🚀 Starting Gemini Subagent Reviewer...');
      const findings = await coordinator.runReview();

      printFindings(findings);
    } catch (e) {
      console.error('❌ GSR completely failed to run:', e);
      process.exit(1);
    }
  });

program.parse(process.argv);

function printFindings(findings: CandidateFinding[]) {
  if (findings.length === 0) {
    console.log('\n✅ No issues found by subagents. Code looks clean and ready to merge.');
    return;
  }

  console.log('\n# Change Summary');
  console.log(`Subagents found ${findings.length} potential issues requiring attention.\n`);

  // Group by file
  const grouped: Record<string, CandidateFinding[]> = {};
  for (const f of findings) {
    if (!grouped[f.file]) grouped[f.file] = [];
    grouped[f.file].push(f);
  }

  for (const [file, fileFindings] of Object.entries(grouped)) {
    console.log(`## File: ${file}`);
    
    // Sort by line number
    fileFindings.sort((a, b) => a.line - b.line);

    for (const f of fileFindings) {
      console.log(`### L${f.line}: [${f.severity}] ${f.summary}`);
      console.log(`${f.description}\n`);
      if (f.suggestion) {
        console.log(`Suggested change:\n\`\`\`\n${f.suggestion}\n\`\`\`\n`);
      }
    }
  }
}
