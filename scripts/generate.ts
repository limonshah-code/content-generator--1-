import 'dotenv/config';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';

// --- Configuration ---
const EXTERNAL_API_BASE = 'https://cloud-text-manager-server.vercel.app';
const EXTERNAL_API_URL = `${EXTERNAL_API_BASE}/api/files`;
const GENERATED_DIR = path.join(process.cwd(), 'generated-content');
const BATCH_SIZE = 10;

// Ensure output directory exists
if (!fs.existsSync(GENERATED_DIR)) {
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
}

// --- Helper Functions ---

const getGemini = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not defined');
  }
  return new GoogleGenAI({ apiKey });
};

const sendEmail = async (subject: string, text: string) => {
  if (!process.env.EMAIL_HOST || !process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.log('Email configuration missing. Skipping email notification.');
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: process.env.EMAIL_TO || process.env.EMAIL_USER,
      subject,
      text,
    });
    console.log('Email sent successfully.');
  } catch (error) {
    console.error('Failed to send email:', error);
  }
};

// --- Main Logic ---

const run = async () => {
  console.log('Starting content generation batch...');
  
  try {
    // 1. Fetch pending files
    console.log('Fetching pending files...');
    const response = await axios.get(EXTERNAL_API_URL);
    const allFiles = response.data;
    const pendingFiles = allFiles.filter((f: any) => f.status === 'Pending').slice(0, BATCH_SIZE);

    if (pendingFiles.length === 0) {
      console.log('No pending files found.');
      return;
    }

    console.log(`Found ${pendingFiles.length} pending files to process.`);
    const results = {
      success: [] as string[],
      failed: [] as string[],
    };

    const ai = getGemini();
    const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';

    for (const file of pendingFiles) {
      console.log(`Processing file: ${file.originalFilename} (${file.id})`);
      
      try {
        // Fetch prompt
        const promptResponse = await axios.get(file.secureUrl);
        const promptText = typeof promptResponse.data === 'string' 
          ? promptResponse.data 
          : JSON.stringify(promptResponse.data);

        // Generate content
        const result = await ai.models.generateContent({
          model,
          contents: promptText,
          config: { responseMimeType: 'text/plain' }
        });
        const generatedContent = result.text || '';

        if (!generatedContent) {
          throw new Error('Empty content generated');
        }

        // Save to local file
        // Sanitize filename to be safe for file system
        const safeFilename = file.originalFilename.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.mdx';
        const filePath = path.join(GENERATED_DIR, safeFilename);
        fs.writeFileSync(filePath, generatedContent);
        console.log(`Saved content to: ${filePath}`);

        // Update external API status
        await axios.put(`${EXTERNAL_API_URL}/${file.id}`, {
          status: 'AlreadyCopy',
          completedTimestamp: Date.now()
        });
        console.log(`Updated status for ${file.id}`);

        results.success.push(file.originalFilename);
        
        // Wait a bit to be nice to APIs
        await new Promise(resolve => setTimeout(resolve, 2000));

      } catch (error: any) {
        console.error(`Failed to process ${file.originalFilename}:`, error.message);
        results.failed.push(`${file.originalFilename}: ${error.message}`);
      }
    }

    // Send summary email
    const subject = `Content Generation Report: ${results.success.length} Success, ${results.failed.length} Failed`;
    const body = `
Content Generation Batch Report
-------------------------------
Total Processed: ${pendingFiles.length}
Success: ${results.success.length}
Failed: ${results.failed.length}

Successful Files:
${results.success.map(f => `- ${f}`).join('\n')}

Failed Files:
${results.failed.map(f => `- ${f}`).join('\n')}

Generated content has been saved to the repository.
    `;
    
    await sendEmail(subject, body);
    console.log('Batch processing complete.');

  } catch (error: any) {
    console.error('Fatal error in generation script:', error);
    await sendEmail('Content Generation Failed', `Fatal error: ${error.message}`);
    process.exit(1);
  }
};

run();
