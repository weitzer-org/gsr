import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const bucketName = 'gsr-eval-results-weitzer-org';

async function listAndFetch() {
  try {
    const [files] = await storage.bucket(bucketName).getFiles();
    // Sort by updated time, get last 4
    files.sort((a, b) => new Date(a.metadata.updated || 0).getTime() - new Date(b.metadata.updated || 0).getTime());
    const recent = files.slice(-4);
    
    for (const file of recent) {
      console.log(`\n============== File: ${file.name} ==============`);
      const [contents] = await file.download();
      const data = JSON.parse(contents.toString());
      console.log(`Duration: ${data.durationSeconds}s`);
      console.log(`Settings: cache=${data.metadata?.contextCaching}, vertex=${data.metadata?.vertexAi}, env=${data.metadata?.evaluationEnv}`);
      console.log(`Files Processed: ${data.metrics?.totalFilesProcessed}`);
      console.log(`Total Subagent Tokens: Prompt=${data.metrics?.totalTokens?.subagentPrompt}, Candidates=${data.metrics?.totalTokens?.subagentCandidates}`);
      console.log(`Total Deduplicator Tokens: Prompt=${data.metrics?.totalTokens?.deduplicatorPrompt}, Candidates=${data.metrics?.totalTokens?.deduplicatorCandidates}`);
      console.log(`Total Basic Tokens: Prompt=${data.metrics?.totalTokens?.basicPrompt}, Candidates=${data.metrics?.totalTokens?.basicCandidates}`);
      console.log(`Total Comparison Tokens: Prompt=${data.metrics?.totalTokens?.comparisonPrompt}, Candidates=${data.metrics?.totalTokens?.comparisonCandidates}`);
      
      let totalSub = 0, totalBasic = 0, totalPrsEvaluated = 0, prsWonBySub = 0, prsWonByBasic = 0, ties = 0;
      data.results?.forEach((res: { subagentCount?: number, basicCount?: number, evaluation?: { winner: string } }) => {
        totalPrsEvaluated++;
        totalSub += res.subagentCount || 0;
        totalBasic += res.basicCount || 0;
        if (res.evaluation) {
          if (res.evaluation.winner === 'Control') prsWonByBasic++;
          else if (res.evaluation.winner === 'Subagent') prsWonBySub++;
          else if (res.evaluation.winner === 'Tie') ties++;
        }
      });
      console.log(`Findings Found: Subagents = ${totalSub}, Basic = ${totalBasic}`);
      console.log(`Win Rate: Subagents won ${prsWonBySub}/${totalPrsEvaluated}, Basic won ${prsWonByBasic}/${totalPrsEvaluated}, Ties: ${ties}`);
      
    }
  } catch (err) {
    console.error('ERROR:', err);
  }
}
listAndFetch();
