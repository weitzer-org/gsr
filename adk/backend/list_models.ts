import { GoogleGenAI } from '@google/genai';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set!");
    process.exit(1);
  }
  const ai = new GoogleGenAI({ apiKey });
  console.log("ai.models keys:", Object.keys(ai.models));
  
  const modelsObj = ai.models as any;
  const listMethod = modelsObj.list || modelsObj.listModels;
  
  if (typeof listMethod === 'function') {
     try {
       console.log("Calling list method...");
       const response = await listMethod.call(modelsObj);
       console.log("Models:", JSON.stringify(response, null, 2));
     } catch (e) {
       console.error("Failed to call list method:", e);
     }
  } else {
     console.log("No list or listModels method found on ai.models");
  }
}

main();
