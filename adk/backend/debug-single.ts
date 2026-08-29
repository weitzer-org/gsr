import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
import { trackGeminiCall } from './src/usage';

dotenv.config({ path: './.env' });

async function testSingleCall() {
    console.log("Initializing Gemini SDK...");
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    console.log("Sending single trivial prompt...");
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
    try {
        const response = await trackGeminiCall({ callType: 'debug_single', model }, () => ai.models.generateContent({
            model,
            contents: 'Say hi.'
        }));
        console.log("Success! Response:");
        console.log(response.text);
    } catch (e: any) {
        console.error("SDK Error details:");
        console.error(e);
    }
}

console.log("API Key present:", !!process.env.GEMINI_API_KEY);
testSingleCall().then(() => console.log("Done."));
