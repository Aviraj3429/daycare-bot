import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import twilio from 'twilio';
import OpenAI from 'openai';
import { franc } from 'franc';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import textToSpeech from '@google-cloud/text-to-speech';

// ================= ENV =================
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  DEFAULT_FROM_NUMBER,
  OWNER_FALLBACK_NUMBER,
  OWNER_EMAIL,
  PUBLIC_BASE_URL,
  OPENAI_API_KEY,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SHEET_ID,
  PORT
} = process.env;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use('/assets', express.static('./public'));

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const ttsClient = new textToSpeech.TextToSpeechClient({
  keyFilename: '/etc/secrets/daycare-bot-service.json'
});

// ================= Daycare Info =================
const daycare = {
  name: "Little Wonders Child Development Center",
  tour_link: "https://littlewondersdaycare.ca/book-tour",
  website: "https://littlewondersdaycare.ca",
  hours: "Monday to Friday, 7:30am - 6:00pm",
  fees: { "Infant": "$1200", "Toddler": "$1100", "Preschool": "$1000" }
};

// ================= Google Sheets =================
const sa = JSON.parse(fs.readFileSync('/etc/secrets/daycare-bot-service.json', 'utf-8'));
const jwt = new google.auth.JWT(
  sa.client_email,
  null,
  sa.private_key.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth: jwt });

// ================= Local JSON Backup =================
function backupLog(entry) {
  const logsFile = './call_logs.json';
  const logs = fs.existsSync(logsFile) ? JSON.parse(fs.readFileSync(logsFile)) : [];
  logs.push(entry);
  fs.writeFileSync(logsFile, JSON.stringify(logs, null, 2));
}

// ================== Mailer ==================
const mailer = nodemailer.createTransport({
  host: SMTP_HOST, port: Number(SMTP_PORT || 465), secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});
async function sendEmail({ subject, text }) {
  try {
    await mailer.sendMail({
      from: `"Daycare AI Receptionist" <${SMTP_USER}>`,
      to: OWNER_EMAIL, subject, text
    });
  } catch (e) { console.error('Email error:', e.message); }
}

// ================== Google TTS ==================
async function generateVoiceFile(text, lang = 'en-US') {
  const [response] = await ttsClient.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: lang,
      name: lang === 'fr-CA' ? 'fr-CA-Neural2-C' : 'en-US-Neural2-F',
      ssmlGender: 'FEMALE'
    },
    audioConfig: { audioEncoding: 'MP3' }
  });
  const filename = `tts_${Date.now()}.mp3`;
  fs.writeFileSync(`./public/${filename}`, response.audioContent, 'binary');
  return `${PUBLIC_BASE_URL}/assets/${filename}`;
}

// ================== AI REPLY ==================
async function generateAIResponse(message, lang = 'English') {
  const info = `
You are a calm, kind, and helpful daycare receptionist for "Little Wonders Child Development Center".
Respond warmly and concisely in ${lang}.
If someone asks for a tour, say “I’ll text you our tour link now.”.
If they ask for fees or hours, use the info below:
Fees: ${JSON.stringify(daycare.fees)}
Hours: ${daycare.hours}
Website: ${daycare.website}
Tour: ${daycare.tour_link}
`;
  const completion = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',
    max_tokens: 150,
    temperature: 0.7,
    messages: [{ role: 'system', content: info }, { role: 'user', content: message }]
  });
  return completion.choices[0].message.content;
}

// ================== Sheet Logging ==================
async function logInteraction(entry) {
  const values = [[
    new Date().toLocaleString(), entry.name, entry.phone, entry.message,
    entry.intent, entry.lang, entry.channel, entry.aiReply
  ]];
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: 'A:H',
      valueInputOption: 'USER_ENTERED', requestBody: { values }
    });
  } catch (err) { console.error('Sheet log error:', err.message); }
  backupLog(entry);
}

// ================== Voice Incoming ==================
app.post('/voice/incoming', async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  vr.play(`${PUBLIC_BASE_URL}/typing.mp3`);
  vr.say({ voice: 'Polly.Joanna' },
    `Hi, thanks for calling ${daycare.name}. You can say "fees", "hours", "tour", or "urgent" at any time to reach the owner.`);
  const gather = vr.gather({
    input: 'speech',
    action: `${PUBLIC_BASE_URL}/voice/handle`,
    method: 'POST',
    timeout: 5,
    speechTimeout: 'auto'
  });
  gather.say({ voice: 'Polly.Joanna' }, 'How can I help you today?');
  res.type('text/xml').send(vr.toString());
});

// ================== Voice Handler ==================
app.post('/voice/handle', async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();
  const speech = req.body.SpeechResult || '';
  const lower = speech.toLowerCase();
  const intent =
    lower.includes('tour') ? 'tour' :
    lower.includes('fee') ? 'fees' :
    lower.includes('hour') ? 'hours' :
    lower.includes('urgent') ? 'urgent' : 'general';
  const lang = (franc(speech) === 'fra') ? 'French' : 'English';
  const langCode = lang === 'French' ? 'fr-CA' : 'en-US';

  if (intent === 'urgent') {
    vr.say('Connecting you to our manager now.');
    vr.dial(OWNER_FALLBACK_NUMBER);
    res.type('text/xml').send(vr.toString());
    await logInteraction({ name: 'Caller', phone: req.body.From, message: speech, intent, lang, channel: 'voice', aiReply: 'Forwarded to owner' });
    return;
  }

  try {
    const reply = await generateAIResponse(speech, lang);
    const audioUrl = await generateVoiceFile(reply, langCode);
    vr.play(audioUrl);
    vr.pause({ length: 1 });
    vr.play(`${PUBLIC_BASE_URL}/typing.mp3`);
    vr.say(lang === 'French' ? 'Puis-je vous aider avec autre chose ?' : 'Can I help with anything else?');

    await logInteraction({ name: 'Caller', phone: req.body.From, message: speech, intent, lang, channel: 'voice', aiReply: reply });

    if (intent === 'tour') {
      await client.messages.create({
        to: req.body.From, from: DEFAULT_FROM_NUMBER,
        body: `Thanks for your interest in ${daycare.name}! Book a tour here: ${daycare.tour_link}`
      });
      await sendEmail({
        subject: 'New Tour Inquiry',
        text: `Caller: ${req.body.From}\nIntent: ${intent}\nMessage: ${speech}`
      });
    }
  } catch (err) {
    console.error('Error:', err.message);
    vr.say('Sorry, something went wrong. Please try again later.');
  }

  res.type('text/xml').send(vr.toString());
});

// ================== WhatsApp ==================
app.post('/whatsapp', async (req, res) => {
  const msg = req.body.Body || '';
  const from = req.body.From;
  const lang = (franc(msg) === 'fra') ? 'French' : 'English';
  const reply = await generateAIResponse(msg, lang);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());

  await logInteraction({ name: 'WhatsApp User', phone: from, message: msg, intent: 'chat', lang, channel: 'whatsapp', aiReply: reply });
});

// ================== Dashboard ==================
app.get('/dashboard', async (_, res) => {
  try {
    const rows = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'A:H' });
    const data = rows.data.values.slice(1).reverse();
    const html = `
      <html><head><title>Daycare AI Dashboard</title>
      <style>
      body {font-family:Arial;margin:40px;background:#fafafa;}
      table {border-collapse:collapse;width:100%;}
      th,td{border:1px solid #ccc;padding:8px;}
      th{background:#f4f4f4;}
      </style></head><body>
      <h1>📞 ${daycare.name} - AI Receptionist Dashboard</h1>
      <table><tr><th>Time</th><th>Name</th><th>Phone</th><th>Message</th><th>Intent</th><th>Lang</th><th>Channel</th><th>AI Reply</th></tr>
      ${data.map(r => `<tr>${r.map(c => `<td>${c||''}</td>`).join('')}</tr>`).join('')}
      </table></body></html>`;
    res.send(html);
  } catch (err) {
    res.status(500).send('Error loading dashboard: ' + err.message);
  }
});

// ================== Health Check ==================
app.get('/', (_, res) => res.send('🚀 Daycare AI Receptionist is live!'));
app.get('/health', (_, res) => res.send('OK'));

// ================== Start Server ==================
app.listen(PORT || 3000, () => console.log(`🚀 Server running on port ${PORT || 3000}`));
