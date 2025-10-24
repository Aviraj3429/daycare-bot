import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import twilio from 'twilio';
import OpenAI from 'openai';
import { franc } from 'franc';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';

// ================= ENV =================
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  DEFAULT_FROM_NUMBER,          // +14372587478
  OWNER_FALLBACK_NUMBER,        // +14372587478 (your manager line)
  OWNER_EMAIL,                  // project.rabach@gmail.com
  PUBLIC_BASE_URL,              // https://<ngrok or render domain>
  OPENAI_API_KEY,
  SMTP_HOST,                    // smtp.gmail.com
  SMTP_PORT,                    // 465
  SMTP_USER,                    // project.rabach@gmail.com
  SMTP_PASS,                    // Gmail App Password (16 chars)
  PORT
} = process.env;

const app = express();
app.get("/", (req, res) => {
  res.send("🚀 Daycare Bot is live and running!");
});
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.json());

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ================= GOOGLE SHEETS (Service Account) =================
const sa = require('/etc/secrets/daycare-bot-service.json');
const jwt = new google.auth.JWT(
  sa.client_email,
  null,
  sa.private_key.replace(/\\n/g, '\n'), // fix for escaped newlines
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth: jwt });
const SHEET_ID = process.env.SHEET_ID || '1Aqorp_lSxWWd0XCjGylOj5zLfOqHb76yCTFR9U1gcgM';

// Find the first sheet title (for Analytics formulas)
let PRIMARY_SHEET = 'Sheet1';
async function detectPrimarySheet() {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const first = meta.data.sheets?.[0]?.properties?.title;
    if (first) PRIMARY_SHEET = first;
    console.log('📄 Primary sheet detected:', PRIMARY_SHEET);
  } catch (e) {
    console.warn('⚠️ Could not detect primary sheet title, defaulting to Sheet1');
  }
}
detectPrimarySheet();

// ================= Mailer (Gmail SMTP via App Password) =================
const mailer = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 465),
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});
async function sendEmail({ subject, text }) {
  if (!OWNER_EMAIL) return;
  try {
    await mailer.sendMail({
      from: `"Daycare AI Receptionist" <${SMTP_USER}>`,
      to: OWNER_EMAIL,
      subject,
      text
    });
    console.log('✅ Email sent:', subject);
  } catch (e) {
    console.error('⚠️ Email failed:', e?.message || e);
  }
}

// ================= Daycare data =================
const daycares = JSON.parse(fs.readFileSync('./daycares.json', 'utf-8'));
const daycare = daycares[0] || {
  name: 'Our Daycare',
  website: '',
  tour_link: '',
  fees: {}
};

// ================= Google Sheet logging =================
async function logToSheet({ name, phone, message, intent, lang, channel, aiReply }) {
  const timestamp = new Date().toLocaleString();
  const values = [[timestamp, name, phone, message, intent, lang, channel, aiReply]];
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'A:H',                        // appends to the first sheet
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
    console.log('✅ Logged to Google Sheets');
  } catch (err) {
    console.error('❌ Google Sheets error:', err?.message || err);
  }
}

// ================= Ensure Analytics tab =================
async function ensureAnalyticsTab() {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
    const sheetsList = meta.data.sheets || [];
    const hasAnalytics = sheetsList.some(s => s.properties?.title === 'Analytics');
    if (hasAnalytics) {
      console.log('📊 Analytics tab exists');
      return;
    }

    // Add 'Analytics' sheet
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          { addSheet: { properties: { title: 'Analytics', gridProperties: { rowCount: 200, columnCount: 8 } } } }
        ]
      }
    });

    // Write formulas reading from PRIMARY_SHEET
    const summaryValues = [
      ['Metric', 'Value'],
      ['Total interactions', `=COUNTA('${PRIMARY_SHEET}'!A2:A)`],
      ['Voice interactions', `=COUNTIF('${PRIMARY_SHEET}'!G2:G,"voice")`],
      ['WhatsApp interactions', `=COUNTIF('${PRIMARY_SHEET}'!G2:G,"whatsapp")`],
      ['Tours', `=COUNTIF('${PRIMARY_SHEET}'!E2:E,"tour")`],
      ['Fees', `=COUNTIF('${PRIMARY_SHEET}'!E2:E,"fees")`],
      ['Hours', `=COUNTIF('${PRIMARY_SHEET}'!E2:E,"hours")`],
      ['Urgent/Manager', `=COUNTIF('${PRIMARY_SHEET}'!E2:E,"urgent")+COUNTIF('${PRIMARY_SHEET}'!E2:E,"manager")`],
      ['General', `=COUNTIF('${PRIMARY_SHEET}'!E2:E,"general")`],
      ['English', `=COUNTIF('${PRIMARY_SHEET}'!F2:F,"English")`],
      ['French', `=COUNTIF('${PRIMARY_SHEET}'!F2:F,"French")`]
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Analytics!A1:B12',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: summaryValues }
    });

    console.log('✅ Analytics tab created and linked to', PRIMARY_SHEET);
  } catch (e) {
    console.error('⚠️ Analytics setup failed:', e?.message || e);
  }
}
ensureAnalyticsTab();

// ================= AI Reply =================
async function generateAIResponse(userMessage, detectedLang = 'English') {
  const info = `
You are a warm, motherly daycare receptionist. Reply in ${detectedLang}.
Be concise and reassuring. Use daycare facts below when helpful.

Name: ${daycare.name}
Address: ${daycare.address || ''}
Phone: ${daycare.phone || ''}
Email: ${daycare.email || ''}
Website: ${daycare.website || ''}
Hours: ${daycare.hours || ''}
Programs: ${Array.isArray(daycare.programs) ? daycare.programs.join(', ') : (daycare.programs || '')}
Meals: ${daycare.meals || ''}
Fees: ${Object.entries(daycare.fees || {}).map(([k,v])=>`${k}: ${v}`).join(', ')}
About: ${daycare.about || ''}
Safety: ${daycare.safety || ''}

Rules:
- For tours: say “I’ll text you our tour link next.”
- For fees/hours/programs: answer clearly using the facts.
- If unrelated (medical/legal/personal): be kind and suggest speaking to the manager.
- Keep voice responses short (1–2 sentences).
`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    max_tokens: 120,
    temperature: 0.7,
    messages: [
      { role: 'system', content: info },
      { role: 'user', content: userMessage }
    ]
  });
  return completion.choices[0].message.content;
}

// ================= Voice: Greeting & Gather =================
app.post('/voice/incoming', async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  // Fast, friendly open (no dead air)
  vr.say({ voice: 'Polly.Joanna', language: 'en-US' }, `Hi! Thanks for calling ${daycare.name}.`);

  const gather = vr.gather({
    input: 'speech',
    action: `${PUBLIC_BASE_URL}/voice/handle`,
    method: 'POST',
    timeout: 3,              // wait for any speech
    speechTimeout: 'auto',   // stop when caller stops talking
    hints: 'fees, hours, tour, visit, enrollment, urgent, manager'
  });
  gather.say({ voice: 'Polly.Joanna' }, 'How can I help you today? You can ask about fees, hours, openings, or booking a tour.');

  // If silence → voicemail
  vr.pause({ length: 1 });
  vr.say({ voice: 'Polly.Joanna' }, 'Sorry, I didn’t catch that.');
  vr.redirect({ method: 'POST' }, `${PUBLIC_BASE_URL}/voice/voicemail`);

  res.type('text/xml').send(vr.toString());
});

// ================= Voice: Main Handler =================
app.post('/voice/handle', async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || '').trim();
  console.log('🎙️ Caller said:', speech);

  const lower = speech.toLowerCase();
  const intent =
    lower.includes('tour') || lower.includes('visit') ? 'tour' :
    lower.includes('fee') || lower.includes('price') ? 'fees' :
    lower.includes('hour') || lower.includes('time') ? 'hours' :
    lower.includes('urgent') ? 'urgent' :
    (lower.includes('manager') || lower.includes('human') || lower.includes('person') || lower.includes('representative')) ? 'manager' :
    'general';

  const langCode = franc(speech || '');
  const detectedLang = (langCode === 'fra' || lower.includes('bonjour') || lower.includes('salut')) ? 'French' : 'English';
  const sayOpts = detectedLang === 'French'
    ? { voice: 'Polly.Celine', language: 'fr-CA' }
    : { voice: 'Polly.Joanna', language: 'en-US' };

  // Urgent / Manager → forward immediately
  if (intent === 'urgent' || intent === 'manager') {
    vr.say(sayOpts, detectedLang === 'French'
      ? 'Je vous mets en relation avec notre responsable.'
      : 'I’ll connect you to our manager now.');
    const dial = vr.dial({ timeout: 20 });
    dial.number(OWNER_FALLBACK_NUMBER);

    res.type('text/xml').send(vr.toString());

    await logToSheet({
      name: 'Caller', phone: req.body.From, message: speech,
      intent, lang: detectedLang, channel: 'voice', aiReply: 'Forwarded to manager'
    });
    await sendEmail({
      subject: `URGENT: Caller needs a manager (${req.body.From})`,
      text: `Caller: ${req.body.From}\nMessage: ${speech}\nIntent: ${intent}`
    });
    return;
  }

  // Quick filler so there’s no awkward silence
  vr.say(sayOpts, detectedLang === 'French' ? 'Un instant, je vérifie.' : 'One moment while I check that.');

  // Compose reply
  let reply = '';
  try {
    if (intent === 'tour') {
      reply = detectedLang === 'French'
        ? "Formidable ! Je vais vous envoyer le lien pour réserver une visite."
        : "Wonderful! I’ll text you our tour booking link next.";
    } else if (intent === 'fees') {
      const f = daycare.fees || {};
      const feesText = Object.entries(f).map(([k,v])=>`${k}: ${v}`).join(', ');
      reply = detectedLang === 'French'
        ? `Nos frais dépendent du programme. ${feesText || ''}`
        : `Our fees depend on the program. ${feesText || ''}`;
    } else if (intent === 'hours') {
      reply = detectedLang === 'French'
        ? `Nous sommes ouverts ${daycare.hours || "du lundi au vendredi"}.`
        : `We’re open ${daycare.hours || "Monday to Friday"}.`;
    } else {
      reply = await generateAIResponse(speech, detectedLang);
    }
  } catch (e) {
    console.error('AI error:', e?.message || e);
    reply = detectedLang === 'French'
      ? "Désolée, j’ai un souci technique. Pouvez-vous réessayer plus tard ?"
      : "Sorry, I’m having a technical issue. Please try again later.";
  }

  vr.say(sayOpts, reply);

  // Log + summary email
  await logToSheet({
    name: 'Caller', phone: req.body.From, message: speech,
    intent, lang: detectedLang, channel: 'voice', aiReply: reply
  });
  await sendEmail({
    subject: `Call summary (${req.body.From}) – ${intent}`,
    text: `Caller: ${req.body.From}\nLanguage: ${detectedLang}\nIntent: ${intent}\n\nSaid: ${speech}\nAI Reply: ${reply}`
  });

  // SMS follow-up
  try {
    let sms = '';
    if (intent === 'tour' && daycare.tour_link) {
      sms = `Thanks for your interest in a tour at ${daycare.name}! Here’s the link: ${daycare.tour_link}`;
    } else if (intent === 'fees') {
      const f = daycare.fees || {};
      const feesText = Object.entries(f).map(([k,v])=>`${k}: ${v}`).join('; ');
      sms = `Fees for ${daycare.name}: ${feesText || 'Contact us for details.'}`;
    } else {
      sms = `Thanks for calling ${daycare.name}! More info: ${daycare.website || ''}`.trim();
    }
    await client.messages.create({ to: req.body.From, from: DEFAULT_FROM_NUMBER, body: sms });
    console.log('✅ SMS sent');
  } catch (e) {
    console.error('⚠️ SMS failed:', e?.message || e);
  }

  // “Anything else?” → wait 10s then goodbye
  const g2 = vr.gather({
    input: 'speech',
    action: `${PUBLIC_BASE_URL}/voice/final`,
    method: 'POST',
    timeout: 10,
    speechTimeout: 'auto'
  });
  g2.say(sayOpts, detectedLang === 'French' ? 'Puis-je vous aider avec autre chose ?' : 'Can I help with anything else?');

  vr.pause({ length: 1 });
  vr.say(sayOpts, detectedLang === 'French' ? 'Merci d’avoir appelé. Au revoir !' : 'Thanks for calling. Goodbye!');
  vr.hangup();

  res.type('text/xml').send(vr.toString());
});

// ================= Voice: Final follow-up handler =================
app.post('/voice/final', async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const speech = (req.body.SpeechResult || '').trim();
  const langCode = franc(speech || '');
  const detectedLang = (langCode === 'fra') ? 'French' : 'English';
  const sayOpts = detectedLang === 'French'
    ? { voice: 'Polly.Celine', language: 'fr-CA' }
    : { voice: 'Polly.Joanna', language: 'en-US' };

  let reply = 'Okay!';
  try { reply = await generateAIResponse(speech, detectedLang); } catch {}

  vr.say(sayOpts, reply);
  vr.say(sayOpts, detectedLang === 'French' ? 'Merci d’avoir appelé. Au revoir !' : 'Thanks for calling. Goodbye!');
  vr.hangup();

  await logToSheet({
    name: 'Caller', phone: req.body.From, message: speech,
    intent: 'follow-up', lang: detectedLang, channel: 'voice', aiReply: reply
  });
  await sendEmail({
    subject: `Call follow-up (${req.body.From})`,
    text: `Said: ${speech}\nReply: ${reply}`
  });

  res.type('text/xml').send(vr.toString());
});

// ================= Voicemail (fallback) =================
app.post('/voice/voicemail', async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  vr.say({ voice: 'Polly.Joanna' }, 'I didn’t hear you. Please leave your message after the beep.');
  vr.record({
    maxLength: 120,
    playBeep: true,
    transcribe: true,
    transcribeCallback: `${PUBLIC_BASE_URL}/voice/voicemail-transcribed`
  });
  vr.say({ voice: 'Polly.Joanna' }, 'Thank you. Goodbye.');
  vr.hangup();
  res.type('text/xml').send(vr.toString());
});

app.post('/voice/voicemail-transcribed', async (req, res) => {
  const transcript = req.body.TranscriptionText || '(no transcript)';
  const from = req.body.From || 'Unknown';
  await logToSheet({
    name: 'Caller', phone: from, message: transcript,
    intent: 'voicemail', lang: 'English', channel: 'voice', aiReply: '(voicemail)'
  });
  await sendEmail({
    subject: `New voicemail from ${from}`,
    text: transcript
  });
  res.sendStatus(200);
});

// ================= WhatsApp =================
app.post('/whatsapp', async (req, res) => {
  const msg = (req.body.Body || '').trim();
  const from = req.body.From;
  const langCode = franc(msg || '');
  const detectedLang = (langCode === 'fra') ? 'French' : 'English';

  let reply = 'Thanks for your message!';
  try { reply = await generateAIResponse(msg, detectedLang); } catch {}

  await logToSheet({
    name: req.body.ProfileName || 'Unknown',
    phone: from,
    message: msg,
    intent: 'message',
    lang: detectedLang,
    channel: 'whatsapp',
    aiReply: reply
  });

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

// ================= Health =================
app.get('/health', (_, res) => res.send('OK'));

// ================= Start =================
app.listen(PORT || 3000, () => {
  console.log(`🚀 Server running on port ${PORT || 3000}`);
});
